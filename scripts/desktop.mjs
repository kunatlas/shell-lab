import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.SHELL_LAB_DESKTOP_PORT ?? 3002);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('SHELL_LAB_DESKTOP_PORT 必须是 1 到 65535 之间的整数。');
  process.exit(1);
}
const address = `http://127.0.0.1:${port}/`;

let desktop;
let backend;
let stopping = false;
let exitStatus = 0;
let startupTimeout;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  exitStatus = code;
  clearTimeout(startupTimeout);
  desktop?.kill('SIGTERM');
  backend?.kill('SIGTERM');
  const forceStop = setTimeout(() => { desktop?.kill('SIGKILL'); backend?.kill('SIGKILL'); }, 5_000);
  forceStop.unref();
  process.exitCode = code;
}

function launchDesktop(url) {
  if (stopping || desktop) return;
  clearTimeout(startupTimeout);
  const env = { ...process.env, SHELL_LAB_DESKTOP_URL: url };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = spawn(electron, [...process.argv.slice(2), fileURLToPath(new URL('../electron/main.cjs', import.meta.url))], { cwd: root, env, stdio: 'inherit' });
  desktop.once('error', (error) => { console.error(error.message); stop(1); });
  desktop.once('exit', (code, signal) => stop(signal ? 1 : code ?? 0));
}

// A second launch must hand off to the running window before the backend tries to bind.
// Probe the static page instead of /api/bootstrap: tool discovery can take seconds in
// Docker mode, while the page is served directly from disk.
async function runningDesktop() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(address, { signal: controller.signal, headers: { accept: 'text/html' } });
    if (!response.ok) return null;
    const html = await response.text();
    return html.includes('<title>ShellLab') && html.includes('id="app"') ? address : null;
  } catch { return null; }
  finally { clearTimeout(timeout); }
}

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

if (await runningDesktop()) {
  // The existing launcher owns the backend, so this process only asks the running
  // Electron instance to focus its window and then exits without touching it.
  console.log('检测到 ShellLab 桌面端已在运行，正在切换到现有窗口。');
  launchDesktop(address);
} else {
  backend = fork(fileURLToPath(new URL('../electron/backend.mjs', import.meta.url)), {
    cwd: root, execArgv: ['--env-file-if-exists=.env'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  startupTimeout = setTimeout(() => {
    console.error('ShellLab 本地服务启动超时。');
    stop(1);
  }, 20_000);
  backend.once('message', (message) => {
    if (message?.type === 'ready') launchDesktop(message.url);
  });
  backend.once('error', (error) => { console.error(error.message); stop(1); });
  backend.once('exit', (code) => {
    if (!stopping) { console.error('ShellLab 本地服务已退出。'); stop(code || 1); }
    process.exitCode = exitStatus;
  });
}
