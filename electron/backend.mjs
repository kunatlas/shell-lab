// Runs with the system Node executable, so node-pty keeps its existing Node ABI.
import { createApp } from '../build/server/app.js';
import { Runtime } from '../build/server/runtime.js';

const application = createApp(new Runtime());
// A stable origin preserves localStorage across desktop restarts.
const port = Number(process.env.SHELL_LAB_DESKTOP_PORT ?? 3002);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SHELL_LAB_DESKTOP_PORT 必须是 1 到 65535 之间的整数。');
application.server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `端口 ${port} 已被其他程序占用，无法启动 ShellLab 桌面版。`
    : error.message);
  process.exit(1);
});
application.server.listen(port, '127.0.0.1', () => {
  const address = application.server.address();
  process.send?.({ type: 'ready', url: `http://127.0.0.1:${address.port}/` });
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await application.close();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
process.on('disconnect', () => void stop());
