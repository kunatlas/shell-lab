import express from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { Runtime, RuntimeError } from './runtime.js';
import { Sessions } from './sessions.js';
import { generatorInfo, parseGenerationOptions } from './generator/index.js';

const cookieName = 'shell_lab_owner';
const ownerFromCookie = (header?: string): string | undefined => {
  const value = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
};

// Local-only service: reject DNS rebinding and cross-site HTTP/WebSocket access.
export function trustedRequest(host?: string, origin?: string): boolean {
  try {
    const hostUrl = new URL(`http://${host}`);
    const local = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
    if (!local(hostUrl.hostname)) return false;
    if (!origin) return true;
    const source = new URL(origin);
    return ['http:', 'https:'].includes(source.protocol) && local(source.hostname) && source.hostname === hostUrl.hostname;
  } catch { return false; }
}

export function createApp(runtime = new Runtime()) {
  const app = express();
  const server = createServer(app);
  const sessions = new Sessions(runtime);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    if (!trustedRequest(req.headers.host, req.headers.origin)) {
      res.status(403).json({ error: '只允许从本机页面访问练习环境。' });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '8kb' }));

  app.get('/api/bootstrap', async (req, res) => {
    const owner = ownerFromCookie(req.headers.cookie) ?? randomBytes(32).toString('hex');
    res.cookie(cookieName, owner, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 24 * 60 * 60_000 });
    const [health, generator] = await Promise.all([runtime.health(), generatorInfo(runtime)]);
    res.json({ health, generator, session: sessions.get(owner)?.info ?? null });
  });

  app.post('/api/session', async (req, res) => {
    const owner = ownerFromCookie(req.headers.cookie);
    if (!owner) { res.status(401).json({ error: '请刷新页面后重试。' }); return; }
    if (!req.is('application/json') || typeof req.body?.lessonId !== 'string' || sessions.get(owner)?.lessonId !== req.body.lessonId) {
      res.status(400).json({ error: '请选择有效的练习。' }); return;
    }
    try {
      const session = await sessions.create(owner, req.body.lessonId);
      res.json(session.info);
    } catch (error) {
      res.status(error instanceof RuntimeError ? 503 : 409).json({ error: error instanceof Error ? error.message : '环境创建失败。' });
    }
  });

  app.post('/api/generate', async (req, res) => {
    const owner = ownerFromCookie(req.headers.cookie);
    if (!owner) { res.status(401).json({ error: '请刷新页面后重试。' }); return; }
    if (!req.is('application/json')) { res.status(415).json({ error: '需要 JSON 请求。' }); return; }
    let options;
    try { options = parseGenerationOptions(req.body); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
    try { res.json((await sessions.generate(owner, options)).info); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : '出题失败，当前练习已保留。' }); }
  });

  app.post('/api/check', async (req, res) => {
    if (!req.is('application/json')) { res.status(415).json({ error: '需要 JSON 请求。' }); return; }
    const owner = ownerFromCookie(req.headers.cookie);
    const session = owner && sessions.get(owner);
    if (!session) { res.status(404).json({ error: '练习环境已过期，请重新连接。' }); return; }
    try { res.json(await session.check()); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : '检查失败，请重试。' }); }
  });

  app.use('/api', (_req, res) => { res.status(404).json({ error: '接口不存在。' }); });
  const dist = resolve(process.cwd(), 'dist');
  app.use(express.static(dist));
  app.get('/', (_req, res) => { res.sendFile(resolve(dist, 'index.html')); });
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: error instanceof SyntaxError ? '请求格式不正确。' : '请求失败，请重试。' });
  });

  server.on('upgrade', (req, socket, head) => {
    const owner = ownerFromCookie(req.headers.cookie);
    const session = owner && sessions.get(owner);
    if (req.url !== '/api/terminal' || !trustedRequest(req.headers.host, req.headers.origin) || !session) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      session.attach(ws);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const connection = ws as typeof ws & { alive?: boolean };
      if (connection.alive === false) { ws.terminate(); continue; }
      connection.alive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();
  wss.on('connection', (ws) => {
    (ws as typeof ws & { alive?: boolean }).alive = true;
    ws.on('pong', () => { (ws as typeof ws & { alive?: boolean }).alive = true; });
  });
  return {
    app, server, sessions,
    close: async () => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await sessions.close();
      wss.close();
      await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
    },
  };
}
