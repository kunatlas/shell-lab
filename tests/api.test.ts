import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp, trustedRequest } from '../server/app.js';
import { Runtime } from '../server/runtime.js';
import type { AddressInfo } from 'node:net';
import type { Bootstrap, CheckResult, SessionInfo } from '../shared/types.js';

test('request validation rejects cross-site origins and DNS rebinding', () => {
  assert.equal(trustedRequest('127.0.0.1:3001', 'http://127.0.0.1:5173'), true);
  assert.equal(trustedRequest('localhost:3001', 'http://localhost:3001'), true);
  assert.equal(trustedRequest('evil.example:3001'), false);
  assert.equal(trustedRequest('127.0.0.1:3001', 'https://evil.example'), false);
  assert.equal(trustedRequest('127.0.0.1:3001', 'null'), false);
});

test('HTTP + WebSocket workflow: bootstrap, authenticate, solve, check, restore, reset', async () => {
  const application = createApp(new Runtime({ mode: 'local' }));
  application.server.listen(0, '127.0.0.1');
  await once(application.server, 'listening');
  const base = `http://127.0.0.1:${(application.server.address() as AddressInfo).port}`;
  let ws: WebSocket | undefined;
  try {
    const response = await fetch(`${base}/api/bootstrap`);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    assert.match(response.headers.get('set-cookie')!, /HttpOnly/);
    const data = await response.json() as Bootstrap;
    assert.equal(Object.hasOwn(data, 'lessons'), false);
    assert.equal(data.health.mode, 'local');
    assert.equal(data.session, null);
    assert.equal(data.generator.topics.length, 25);
    const post = (path: string, body: object, auth = true) => fetch(`${base}/api/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
    });
    assert.equal((await post('session', { lessonId: 'first-steps' }, false)).status, 401);
    assert.equal((await post('session', { lessonId: '__proto__' })).status, 400);
    assert.equal((await fetch(`${base}/api/bootstrap`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await post('session', { lessonId: 'first-steps' })).status, 400);
    const sessionResponse = await post('generate', { topics: ['config'], difficulty: 'basic', source: 'rules' });
    assert.equal(sessionResponse.status, 200);
    const first = await sessionResponse.json() as SessionInfo;
    assert.equal(first.active, true);
    assert.equal(((await (await post('check', {})).json()) as CheckResult).passed, false);

    ws = new WebSocket(`${base.replace('http', 'ws')}/api/terminal`, { headers: { Cookie: cookie, Origin: base } });
    await once(ws, 'open');
    const received = new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket terminal timed out')), 5000);
      let output = '';
      ws!.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'output') output += message.data;
        if (output.includes('\x1eWS_DONE\x1f')) { clearTimeout(timer); done(); }
      });
    });
    ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    ws.send(JSON.stringify({ type: 'input', data: first.lesson!.example.replace(/\n/g, '\r') + "\rprintf '\\036WS_DONE\\037\\n'\r" }));
    await received;
    assert.equal(((await (await post('check', {})).json()) as CheckResult).passed, true);
    const restored = await (await fetch(`${base}/api/bootstrap`, { headers: { Cookie: cookie } })).json() as Bootstrap;
    assert.equal(restored.session?.workspace, first.workspace);
    const other = await (await fetch(`${base}/api/bootstrap`)).json() as Bootstrap;
    assert.equal(other.session, null);
    const reset = await (await post('session', { lessonId: first.lessonId })).json() as SessionInfo;
    assert.notEqual(reset.workspace, first.workspace);
    assert.equal(((await (await post('check', {})).json()) as CheckResult).passed, false);
  } finally { ws?.terminate(); await application.close(); }
});

test('generation API validates options, keeps ownership, restores the question and resets its initial state', async () => {
  const application = createApp(new Runtime({ mode: 'local' }));
  application.server.listen(0, '127.0.0.1');
  await once(application.server, 'listening');
  const base = `http://127.0.0.1:${(application.server.address() as AddressInfo).port}`;
  try {
    const boot = await fetch(`${base}/api/bootstrap`);
    const cookie = boot.headers.get('set-cookie')!.split(';')[0];
    const post = (path: string, body: object, auth = cookie) => fetch(`${base}/api/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: auth }, body: JSON.stringify(body),
    });
    const options = { topics: ['logs', 'config'], difficulty: 'intermediate', source: 'rules' };
    assert.equal((await post('generate', options, '')).status, 401);
    assert.equal((await post('generate', { ...options, topics: ['__proto__'] })).status, 400);
    assert.equal((await post('generate', { ...options, source: 'execute-script' })).status, 400);
    const response = await post('generate', options);
    assert.equal(response.status, 200);
    const session = await response.json() as SessionInfo;
    assert.equal(session.lesson?.generated?.verified, true);
    assert.deepEqual([...session.lesson!.generated!.topics].sort(), ['config', 'logs']);
    assert.equal(session.lesson!.objectives.length, 4);
    assert.equal(Object.hasOwn(session, 'setup'), false);
    assert.equal(Object.hasOwn(session, 'checks'), false);
    assert.equal(((await (await post('check', {})).json()) as CheckResult).passed, false);
    const restored = await (await fetch(`${base}/api/bootstrap`, { headers: { Cookie: cookie } })).json() as Bootstrap;
    assert.deepEqual(restored.session?.lesson, session.lesson);
    const reset = await (await post('session', { lessonId: session.lessonId })).json() as SessionInfo;
    assert.deepEqual(reset.lesson, session.lesson);
    assert.notEqual(reset.workspace, session.workspace);
    const other = await fetch(`${base}/api/bootstrap`);
    const otherCookie = other.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await post('session', { lessonId: session.lessonId }, otherCookie)).status, 400);
    assert.equal((await post('generate', { ...options, topics: ['invalid'] })).status, 400);
    const unchanged = await (await fetch(`${base}/api/bootstrap`, { headers: { Cookie: cookie } })).json() as Bootstrap;
    assert.equal(unchanged.session?.workspace, reset.workspace);
  } finally { await application.close(); }
});
