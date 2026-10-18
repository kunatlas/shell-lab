import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

const address = 'http://127.0.0.1:3016/';

test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.SHELL_LAB_DESKTOP_URL = address;
  env.SHELL_LAB_RUNTIME = 'local';
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['electron/main.cjs'], cwd: process.cwd(), env });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
});

test('loads the shell with a restricted desktop bridge', async () => {
  await expect(page).toHaveTitle('ShellLab · Shell 练习室');
  expect(await page.evaluate(() => window.shellLabDesktop?.platform)).toBe(process.platform);
  expect(await page.evaluate(() => typeof window.shellLabDesktop?.copyText)).toBe('function');
  await expect(page.locator('#window-controls')).toBeVisible();
});

test('window controls maximize and restore the native window', async () => {
  const button = page.getByRole('button', { name: '最大化或还原窗口' });
  await button.click();
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true);
  await button.click();
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(false);
});

test('runs a real command and copies the reference through the main process', async () => {
  await page.getByRole('button', { name: '打开练习列表' }).click();
  await page.locator('[data-topic="logs"]').click();
  await page.getByRole('button', { name: '生成并开始' }).click();

  const terminal = page.locator('.xterm-rows');
  await expect(terminal).toContainText('~/workspace$', { timeout: 30_000 });
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.insertText('echo desktop-ok');
  await page.keyboard.press('Enter');
  await expect.poll(
    async () => ((await terminal.innerText()).match(/desktop-ok/g)?.length ?? 0),
    { timeout: 10_000 },
  ).toBeGreaterThanOrEqual(2);

  await page.locator('#hint').click();
  const example = (await page.locator('.hint-content pre code').innerText()).trim();
  expect(example.length).toBeGreaterThan(0);
  await page.locator('#copy-example').click();
  await expect.poll(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())).trim()).toBe(example);
  await expect(page.locator('#toast')).toContainText('已复制');
});

test('close button quits the desktop application', async () => {
  const closed = app.waitForEvent('close');
  await page.getByRole('button', { name: '关闭窗口' }).click();
  await closed;
});
