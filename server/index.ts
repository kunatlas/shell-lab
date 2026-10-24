import { createApp } from './app.js';
import { Runtime } from './runtime.js';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1 到 65535 之间的整数。');
const runtime = new Runtime();
const application = createApp(runtime);
application.server.listen(port, '127.0.0.1', async () => {
  console.log(`ShellLab API: http://127.0.0.1:${port}`);
  const health = await runtime.health();
  console.log(`${health.label}: ${health.message}`);
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await application.close();
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
