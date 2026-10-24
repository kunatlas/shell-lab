import { randomUUID } from 'node:crypto';
import type { IPty } from 'node-pty';
import type { WebSocket } from 'ws';
import type { Exercise } from './exercises.js';
import { Runtime, type Workspace } from './runtime.js';
import type { CheckResult, SessionInfo, GenerationOptions } from '../shared/types.js';
import { generateExercise } from './generator/index.js';

export class Session {
  readonly id = randomUUID();
  readonly terminal: IPty;
  lastUsed = Date.now();
  active = true;
  private history = '';
  private socket?: WebSocket;
  private checking = false;
  private disposed = false;

  constructor(readonly lessonId: string, readonly workspace: Workspace, readonly runtime: Runtime, readonly exercise: Exercise) {
    this.terminal = workspace.openTerminal();
    this.terminal.onData((data) => {
      this.history = (this.history + data).slice(-128 * 1024);
      this.send({ type: 'output', data });
    });
    this.terminal.onExit(({ exitCode }) => {
      this.active = false;
      this.send({ type: 'exit', exitCode });
    });
  }

  get info(): SessionInfo {
    return { lessonId: this.lessonId, runtime: this.runtime.mode, workspace: this.workspace.path, active: this.active, ...(this.exercise.lesson ? { lesson: this.exercise.lesson } : {}) };
  }

  attach(socket: WebSocket): void {
    this.socket?.close(4000, 'Connected in another tab');
    this.socket = socket;
    this.lastUsed = Date.now();
    this.send({ type: 'output', data: this.history });
    if (!this.active) this.send({ type: 'exit', exitCode: 0 });
    socket.on('message', (raw) => {
      this.lastUsed = Date.now();
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 16_384 && this.active) {
          this.terminal.write(message.data);
        } else if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
          this.terminal.resize(Math.max(10, Math.min(400, message.cols)), Math.max(4, Math.min(150, message.rows)));
        }
      } catch {
        socket.close(1008, 'Invalid terminal message');
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => { if (this.socket === socket) this.socket = undefined; });
  }

  async check(): Promise<CheckResult> {
    if (this.checking) throw new Error('正在检查，请稍候。');
    this.checking = true;
    this.lastUsed = Date.now();
    try {
      // Run sequentially: a script exercise may create files checked by the next objective.
      const results = [];
      for (const [id, script] of Object.entries(this.exercise.checks)) {
        const passed = await this.workspace.run(script).then(() => true, () => false);
        results.push({ id, passed });
      }
      return { lessonId: this.lessonId, passed: results.every((result) => result.passed), results };
    } finally {
      this.checking = false;
    }
  }

  async destroy(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.socket?.close(1000, 'Environment reset');
    this.active = false;
    try { this.terminal.kill(); } catch { /* Process may have already exited. */ }
    await this.workspace.destroy();
  }

  private send(message: object): void {
    if (!this.socket || this.socket.readyState !== 1) return;
    if (this.socket.bufferedAmount > 1024 * 1024) {
      this.socket.close(1013, 'Terminal output exceeded buffer; reconnect');
      return;
    }
    this.socket.send(JSON.stringify(message));
  }
}

export class Sessions {
  private sessions = new Map<string, Session>();
  private busy = new Set<string>();
  private pending = new Set<Promise<Session>>();
  private closing = false;
  private readonly reaper: ReturnType<typeof setInterval>;

  constructor(readonly runtime: Runtime, private maxSessions = 8) {
    this.reaper = setInterval(() => {
      for (const [owner, session] of this.sessions) {
        if (Date.now() - session.lastUsed > 30 * 60_000 && !this.busy.has(owner)) {
          this.sessions.delete(owner);
          void session.destroy();
        }
      }
    }, 60_000);
    this.reaper.unref();
  }

  get(owner: string): Session | undefined { return this.sessions.get(owner); }

  async generate(owner: string, options: GenerationOptions): Promise<Session> {
    return this.create(owner, '', () => generateExercise(this.runtime, options));
  }

  async create(owner: string, lessonId: string, prepare?: () => Promise<Exercise>): Promise<Session> {
    if (this.closing) throw new Error('服务正在关闭，请稍后重试。');
    const operation = this.createSession(owner, lessonId, prepare);
    this.pending.add(operation);
    try { return await operation; }
    finally { this.pending.delete(operation); }
  }

  private async createSession(owner: string, lessonId: string, prepare?: () => Promise<Exercise>): Promise<Session> {
    const existing = this.sessions.get(owner);
    const known = existing?.lessonId === lessonId ? existing.exercise : undefined;
    if (!prepare && !known) throw new Error('没有找到这个练习。');
    if (this.busy.has(owner)) throw new Error('环境正在准备中，请稍候。');
    if (this.sessions.size + this.busy.size >= this.maxSessions && !this.sessions.has(owner)) {
      throw new Error('练习环境已满，请稍后重试。');
    }
    this.busy.add(owner);
    let workspace: Workspace | undefined;
    try {
      const exercise = prepare ? await prepare() : known!;
      if (this.closing) throw new Error('服务正在关闭，请稍后重试。');
      workspace = await this.runtime.create(exercise.setup, exercise.fixtures);
      if (this.closing) throw new Error('服务正在关闭，请稍后重试。');
      const session = new Session(exercise.lesson?.id ?? lessonId, workspace, this.runtime, exercise);
      const previous = this.sessions.get(owner);
      this.sessions.set(owner, session);
      await previous?.destroy();
      return session;
    } catch (error) {
      await workspace?.destroy();
      throw error;
    } finally {
      this.busy.delete(owner);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.reaper);
    await Promise.allSettled([...this.pending]);
    await Promise.all([...this.sessions.values()].map((session) => session.destroy()));
    this.sessions.clear();
  }
}
