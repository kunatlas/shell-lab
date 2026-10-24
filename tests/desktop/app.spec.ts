import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const address = 'http://127.0.0.1:3016/';

test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'shelllab-desktop-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.SHELL_LAB_DESKTOP_URL = address;
  env.SHELL_LAB_RUNTIME = 'local';
  env.SHELL_LAB_USER_DATA = userDataDir;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['electron/main.cjs'], cwd: process.cwd(), env });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  await rm(userDataDir, { recursive: true, force: true });
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

test('terminal refits when the native window is resized', async () => {
  const dimensions = page.locator('#terminal-dimensions');
  await expect(dimensions).toHaveText(/^\d+ × \d+$/);

  const sizes = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const area = screen.getPrimaryDisplay().workAreaSize;
    const narrow = { width: Math.max(800, Math.min(900, area.width)), height: Math.max(600, Math.min(650, area.height)) };
    const wide = { width: Math.min(1400, area.width), height: Math.min(900, area.height) };
    window.unmaximize();
    window.setSize(narrow.width, narrow.height);
    return { narrow, wide };
  });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(sizes.narrow.width);
  await page.waitForTimeout(250);
  const before = await dimensions.textContent();

  await app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0].setSize(target.width, target.height), sizes.wide);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThan(sizes.narrow.width);
  await expect.poll(async () => dimensions.textContent()).not.toBe(before);
  const wider = await dimensions.textContent();

  await app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0].setSize(target.width, target.height), sizes.narrow);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(sizes.wide.width);
  await expect.poll(async () => dimensions.textContent()).not.toBe(wider);
});

test('runs a real command and copies the reference through the main process', async () => {
  await page.getByRole('button', { name: '打开练习列表' }).click();
  await page.locator('[data-topic="logs"]').click();
  await page.getByRole('button', { name: '生成并开始' }).click();

  const terminal = page.locator('.xterm-rows');
  await expect(terminal).toContainText('~/workspace$', { timeout: 30_000 });
  const objectiveSize = await page.locator('.objective').first().evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  expect(objectiveSize).toBeGreaterThanOrEqual(16);
  const backgroundSize = await page.locator('.lesson-background .lesson-description').evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  expect(backgroundSize).toBeGreaterThanOrEqual(15);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.insertText('echo zz');
  await page.keyboard.press('Enter');
  await expect.poll(
    async () => ((await terminal.innerText()).match(/zz/g)?.length ?? 0),
    { timeout: 10_000 },
  ).toBeGreaterThanOrEqual(2);

  const background = page.locator('.lesson-background');
  await background.evaluate((element) => { (element as HTMLDetailsElement).open = true; });
  await page.locator('#hint').click();
  await expect(page.locator('.hint-title')).toBeInViewport();
  await expect(background).toHaveAttribute('open', '');
  const example = (await page.locator('.hint-content pre code').innerText()).trim();
  expect(example.length).toBeGreaterThan(0);
  await page.locator('#copy-example').click();
  await expect.poll(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())).trim()).toBe(example);
  await expect(page.locator('#toast')).toContainText('已复制');
});

test('rapid wheel scrolling and repeated hint toggles leave the panel responsive', async () => {
  const content = page.locator('.lesson-panel');
  const box = (await content.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 120);
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const bottom = await content.evaluate((element) => element.scrollTop);
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -120);
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeLessThan(bottom);

  for (let i = 0; i < 3; i++) {
    await page.locator('#hint').click();
    await expect(page.locator('#hint')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#lesson-hint')).toBeHidden();
    await page.locator('#hint').click();
    await expect(page.locator('#hint')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.hint-title')).toBeInViewport();
  }
  await expect(page.locator('.lesson-background')).toHaveAttribute('open', '');
});

test('the reference code and sticky hint button scroll the same lesson panel', async () => {
  const panel = page.locator('.lesson-panel');
  const code = page.locator('.hint-content pre');
  await code.evaluate((element) => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
  const point = await code.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const panel = element.closest('.lesson-panel')!.getBoundingClientRect();
    const actions = document.querySelector('.lesson-actions')!.getBoundingClientRect();
    const top = Math.max(rect.top, panel.top);
    const bottom = Math.min(rect.bottom, actions.top);
    return { x: rect.left + 30, y: top + (bottom - top) / 2 };
  });
  await page.mouse.move(point.x, point.y);
  const codeStart = await panel.evaluate((element) => element.scrollTop);
  await page.mouse.wheel(0, -160);
  await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeLessThan(codeStart);
  expect(await code.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  await panel.evaluate((element) => { element.scrollTop = (element.scrollHeight - element.clientHeight) / 2; });
  await page.locator('#hint').hover();
  const buttonStart = await panel.evaluate((element) => element.scrollTop);
  await page.mouse.wheel(0, -160);
  await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeLessThan(buttonStart);
  await expect(page.locator('#hint')).toBeInViewport();
});

test('desktop UI scale changes the page zoom', async () => {
  await page.locator('#settings-nav').click();
  await page.locator('#ui-scale').selectOption('1.25');
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBeCloseTo(1.25, 2);
  await page.locator('#ui-scale').selectOption('1.15');
  await page.keyboard.press('Escape');
  await expect(page.locator('#dialog')).not.toBeVisible();
});

test('close button quits the desktop application', async () => {
  const closed = app.waitForEvent('close');
  await page.getByRole('button', { name: '关闭窗口' }).click();
  await closed;
});
