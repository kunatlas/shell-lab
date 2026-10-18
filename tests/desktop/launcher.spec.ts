import { test, expect, chromium, type Browser } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 3017;
const debugPort = 9337;
const address = `http://127.0.0.1:${port}/`;
const backendUrl = `${address}api/bootstrap`;
const debugUrl = `http://127.0.0.1:${debugPort}`;

test('launcher starts the backend and cleans everything up when the window closes', async () => {
  test.setTimeout(90_000);
  const userDataDir = await mkdtemp(join(tmpdir(), 'shelllab-launcher-'));
  const launcher: ChildProcess = spawn(process.execPath, ['scripts/desktop.mjs', `--remote-debugging-port=${debugPort}`], {
    cwd: process.cwd(),
    env: { ...process.env, SHELL_LAB_RUNTIME: 'local', SHELL_LAB_DESKTOP_PORT: String(port), SHELL_LAB_USER_DATA: userDataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exitCode: number | null | undefined;
  launcher.on('exit', (code) => { exitCode = code; });
  let browser: Browser | undefined;

  try {
    await expect.poll(async () => {
      try { return (await fetch(backendUrl)).ok; } catch { return false; }
    }, { timeout: 30_000 }).toBe(true);

    await expect.poll(async () => {
      try { return (await fetch(`${debugUrl}/json/version`)).ok; } catch { return false; }
    }, { timeout: 30_000 }).toBe(true);

    browser = await chromium.connectOverCDP(debugUrl);
    const page = browser.contexts()[0].pages()[0];
    await expect(page).toHaveTitle('ShellLab · Shell 练习室');
    expect(await page.evaluate(() => window.shellLabDesktop?.platform)).toBe(process.platform);

    await page.getByRole('button', { name: '关闭窗口' }).click();
    await expect.poll(() => exitCode, { timeout: 15_000 }).toBe(0);
    await expect.poll(async () => {
      try { return (await fetch(backendUrl)).ok; } catch { return false; }
    }, { timeout: 10_000 }).toBe(false);
  } finally {
    await browser?.close().catch(() => {});
    if (exitCode === undefined) launcher.kill('SIGTERM');
    await Promise.race([once(launcher, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    await rm(userDataDir, { recursive: true, force: true });
  }
});
