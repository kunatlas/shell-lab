import { test, expect, type Page, type WebSocket } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { SessionInfo } from '../../shared/types.js';

const terminals = new WeakMap<Page, WebSocket>();
test.beforeEach(({ page }) => {
  page.on('websocket', (socket) => {
    if (socket.url().endsWith('/api/terminal')) terminals.set(page, socket);
  });
});

async function command(page: Page, text: string) {
  const marker = randomUUID();
  const socket = terminals.get(page)!;
  const finished = new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { socket.off('framereceived', receive); reject(new Error('Terminal command did not finish')); }, 10_000);
    const receive = ({ payload }: { payload: string | Buffer }) => {
      const message = JSON.parse(payload.toString());
      if (message.type === 'output') output += message.data;
      if (output.includes(`\x1e${marker}\x1f`)) { clearTimeout(timer); socket.off('framereceived', receive); resolve(); }
    };
    socket.on('framereceived', receive);
  });
  text += `\nprintf '\\036${marker}\\037\\n'`;
  const input = page.locator('.xterm-helper-textarea');
  await input.focus();
  if (text.includes('\n')) {
    await input.evaluate((element, content) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', content);
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    }, text);
  } else await page.keyboard.insertText(text);
  await page.keyboard.press('Enter');
  await finished;
}

async function begin(page: Page, topics = ['config'], difficulty = 'basic'): Promise<SessionInfo> {
  await page.getByRole('button', { name: /生成开发实战/ }).click();
  await page.getByLabel('练习难度').selectOption(difficulty);
  for (const topic of topics) await page.locator(`input[name="topic"][value="${topic}"]`).check();
  const response = page.waitForResponse((item) => item.url().endsWith('/api/generate') && item.status() === 200);
  await page.getByRole('button', { name: '生成并开始' }).click();
  const session = await (await response).json() as SessionInfo;
  await expect(page.getByRole('heading', { name: session.lesson!.title })).toBeVisible();
  await expect(page.locator('#connection-label')).toHaveText('本机 Bash · 未隔离');
  await expect(page.locator('#terminal-overlay')).toBeHidden();
  return session;
}

test('homepage offers only dynamic scenarios and waits for the user to choose', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('shell-lab-progress-v1', JSON.stringify(['first-steps', 'conditions'])));
  let generations = 0;
  page.on('request', (request) => { if (request.url().endsWith('/api/generate')) generations++; });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '从一个开发场景开始' })).toBeVisible();
  await expect(page.locator('#connection-label')).toHaveText('尚未开始练习');
  await expect(page.getByText('入门练习', { exact: true })).toHaveCount(0);
  await expect(page.getByText('入门进度', { exact: true })).toHaveCount(0);
  await expect(page.locator('#progress-number')).toHaveText('0 题');
  await expect(page.locator('[data-topic]')).toHaveCount(25);
  await expect(page.getByRole('button', { name: '检查结果' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '给我一点提示' })).toBeDisabled();
  expect(generations).toBe(0);
  expect((await (await page.request.get('/api/bootstrap')).json()).session).toBeNull();
  await page.getByRole('button', { name: '应用日志排查', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('input[name="topic"][value="logs"]')).toBeChecked();
  await expect(page.getByLabel('练习难度')).toHaveValue('basic');
  await page.getByRole('button', { name: '返回练习' }).click();
  await page.screenshot({ path: 'test-results/homepage.png', fullPage: true });
});

test('command reference and scene navigation work on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#connection-label')).toHaveText('尚未开始练习');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '命令速查' }).click();
  await expect(page.getByRole('dialog')).toContainText('pwd / ls -la');
  await page.getByRole('button', { name: '关闭弹窗' }).click();
  await page.getByRole('button', { name: '打开练习列表' }).click();
  await expect(page.getByRole('navigation', { name: '开发场景' })).toBeVisible();
  await page.getByRole('button', { name: '打开练习列表' }).click();
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
});

test('an unavailable Docker runtime gives actionable feedback', async ({ page }) => {
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.session = null;
    data.health = { ready: false, mode: 'docker', label: 'Linux 环境尚未就绪', message: '请启动 Docker，并运行 npm run sandbox:build。' };
    await route.fulfill({ json: data });
  });
  await page.goto('/');
  await expect(page.locator('#terminal-overlay')).toContainText('npm run sandbox:build');
  await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '检查结果' })).toBeDisabled();
});

test('generate a combined scenario, solve, retain Bash state, reset, and generate a different question', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const first = await begin(page, ['logs', 'config'], 'intermediate');
  await expect(page.locator('.generation-label')).toContainText('试做通过');
  await expect(page.locator('.objective')).toHaveCount(4);
  await command(page, first.lesson!.example);
  await page.getByRole('button', { name: '检查结果' }).click();
  await expect(page.locator('.result-message')).toContainText('练习完成');
  await expect(page.locator('#progress-number')).toHaveText('1 题');
  await command(page, 'remembered=retained');
  await page.reload();
  await expect(page.getByRole('heading', { name: first.lesson!.title })).toBeVisible();
  await expect(page.locator('#terminal-overlay')).toBeHidden();
  const configIndex = first.lesson!.generated!.topics.indexOf('config') + 1;
  await command(page, `test "$remembered" = retained || rm tasks/${configIndex}-config/app.env`);
  await page.getByRole('button', { name: '检查结果' }).click();
  await expect(page.locator('.result-message')).toContainText('练习完成');
  await page.getByRole('button', { name: '重置环境', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '重置环境', exact: true }).click();
  await expect(page.locator('#terminal-overlay')).toBeHidden();
  await page.getByRole('button', { name: '检查结果' }).click();
  await expect(page.locator('.result-message')).toContainText('已经完成 0 / 4 个目标');
  await expect(page.locator('#progress-number')).toHaveText('1 题');
  await page.getByRole('button', { name: '换一道题' }).click();
  const anotherResponse = page.waitForResponse((response) => response.url().endsWith('/api/generate') && response.status() === 200);
  await page.getByRole('button', { name: '生成并开始' }).click();
  const another = await (await anotherResponse).json();
  expect(another.lesson.generated.seed).not.toEqual(first.lesson!.generated!.seed);
  await expect(page.getByRole('heading', { name: another.lesson.title })).toBeVisible();
  await expect(page.locator('#terminal-overlay')).toBeHidden();
  await page.screenshot({ path: 'test-results/generated-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('failed generation preserves the current question and Bash session', async ({ page }) => {
  await page.goto('/');
  const current = await begin(page);
  await page.route('**/api/generate', (route) => route.fulfill({ status: 409, json: { error: '出题服务暂时不可用，当前练习已保留。' } }));
  await page.getByRole('button', { name: /生成开发实战/ }).click();
  await page.getByRole('button', { name: '生成并开始' }).click();
  await expect(page.locator('#toast')).toContainText('当前练习已保留');
  await expect(page.locator('#terminal-overlay')).toBeHidden();
  await expect(page.getByRole('heading', { name: current.lesson!.title })).toBeVisible();
  await expect(page.getByRole('button', { name: '检查结果' })).toBeEnabled();
  expect((await (await page.request.get('/api/bootstrap')).json()).session.workspace).toBe(current.workspace);
});

test('scenario selector fits a narrow screen and exposes daily development tasks', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#connection-label')).toHaveText('尚未开始练习');
  await page.getByRole('button', { name: '打开练习列表' }).click();
  await page.getByRole('button', { name: /生成开发实战/ }).click();
  await expect(page.locator('.topic-option')).toHaveCount(25);
  await expect(page.locator('#generator-form')).toContainText('HTTP 健康检查');
  await expect(page.locator('#generator-form')).toContainText('Git 日常开发');
  await expect(page.locator('#generator-form')).toContainText('进程排查与停止');
  await expect(page.locator('#generator-form')).toContainText('SSH 密钥与远程命令');
  await expect(page.locator('#generator-form')).toContainText('SCP 上传与下载');
  await expect(page.locator('#generator-form')).toContainText('端口占用定位');
  await expect(page.locator('#generator-form')).toContainText('超时与失败重试');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a real SSH/SCP remote release can be generated, completed and checked in the browser', async ({ page }) => {
  await page.goto('/');
  const exercise = await begin(page, ['remote-deploy']);
  await expect(page.locator('.objective')).toHaveCount(3);
  await page.getByRole('button', { name: '给我一点提示' }).click();
  await expect(page.locator('.hint-content')).toContainText('scp -F client.conf');
  await command(page, exercise.lesson!.example);
  await page.getByRole('button', { name: '检查结果' }).click();
  await expect(page.locator('.result-message')).toContainText('练习完成');
  await expect(page.locator('#progress-number')).toHaveText('1 题');
  await page.screenshot({ path: 'test-results/ssh-scp-release.png', fullPage: true });
});

test('network and port diagnosis work through the real browser terminal', async ({ page }) => {
  await page.goto('/');
  const exercise = await begin(page, ['network', 'ports'], 'intermediate');
  await expect(page.locator('.objective')).toHaveCount(4);
  await command(page, exercise.lesson!.example);
  await page.getByRole('button', { name: '检查结果' }).click();
  await expect(page.locator('.result-message')).toContainText('练习完成');
  await page.screenshot({ path: 'test-results/network-diagnosis.png', fullPage: true });
});

test('reliability scripts can be authored, executed and checked in the browser', async ({ page }) => {
  await page.goto('/');
  const exercise = await begin(page, ['retry', 'atomic', 'locking'], 'advanced');
  await expect(page.locator('.objective')).toHaveCount(6);
  await command(page, exercise.lesson!.example);
  await page.getByRole('button', { name: '检查结果' }).click();
  await expect(page.locator('.result-message')).toContainText('练习完成');
});
