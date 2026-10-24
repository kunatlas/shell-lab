import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import type { RuntimeHealth, RuntimeMode } from '../shared/types.js';
import type { FixtureSpec } from './exercises.js';
import { fixtureProgram, fixtureReadyFile } from './fixtures.js';
import { quote } from './generator/random.js';
import { sshToolEnvironment, sshClientDirectory } from './ssh-tools.js';

export class RuntimeError extends Error {}

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const minimalEnv = (home: string): Record<string, string> => ({
  PATH: `${sshClientDirectory()}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  HOME: home, USER: 'student', LOGNAME: 'student', SHELL: '/bin/bash',
  TERM: 'xterm-256color', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
});

export function command(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(file, args, {
      timeout: 10_000, maxBuffer: 256 * 1024, killSignal: 'SIGKILL', ...options,
    }, (error, stdout) => error ? reject(error) : resolveOutput(stdout));
  });
}

export interface Workspace {
  path: string;
  openTerminal(): pty.IPty;
  run(script: string, timeoutSeconds?: number): Promise<string>;
  destroy(): Promise<void>;
}

export class Runtime {
  readonly mode: RuntimeMode;
  readonly image: string;
  readonly bashrc: string;

  constructor(options: { mode?: RuntimeMode; image?: string; bashrc?: string } = {}) {
    this.mode = options.mode ?? (process.env.SHELL_LAB_RUNTIME === 'local' ? 'local' : 'docker');
    this.image = options.image ?? process.env.SHELL_LAB_IMAGE ?? 'shell-lab-sandbox:1';
    // Compiled output lives under build/server; source lives under server.
    this.bashrc = options.bashrc ?? resolve(projectRoot, projectRoot.endsWith('/build/') ? '../sandbox/bashrc' : 'sandbox/bashrc');
  }

  async health(): Promise<RuntimeHealth> {
    if (this.mode === 'local') {
      const ready = process.platform === 'linux' && await access('/bin/bash').then(() => true, () => false);
      return {
        ready, mode: this.mode, label: '本机 Bash · 未隔离',
        message: ready ? '开发模式：命令以当前系统用户执行，可访问本机文件。' : '本机开发模式需要 Linux 和 /bin/bash。',
      };
    }
    try {
      await command('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 5000 });
      await command('docker', ['image', 'inspect', this.image], { timeout: 5000 });
      return { ready: true, mode: this.mode, label: 'Ubuntu 24.04 · Bash', message: '独立 Linux 练习容器已就绪。' };
    } catch {
      return {
        ready: false, mode: this.mode, label: 'Linux 环境尚未就绪',
        message: `请启动 Docker，并在项目目录运行 npm run sandbox:build，再点击重新连接。`,
      };
    }
  }

  async availableTools(tools: string[]): Promise<Set<string>> {
    const sshEnv = this.mode === 'local' ? sshToolEnvironment() : {};
    const script = tools.map((tool) => {
      const binary = tool === 'sshd' ? sshEnv.SHELL_LAB_SSHD ?? tool : tool === 'sftp-server' ? sshEnv.SHELL_LAB_SFTP_SERVER ?? '/usr/lib/openssh/sftp-server' : tool;
      return `command -v ${quote(binary)} >/dev/null 2>&1 && printf '%s\\n' ${quote(tool)};`;
    }).join('\n') + '\ntrue';
    try {
      const output = this.mode === 'local'
        ? await command('/bin/bash', ['--noprofile', '--norc', '-c', script], { env: minimalEnv(tmpdir()) })
        : await command('docker', ['run', '--rm', '--network', 'none', '--read-only', '--entrypoint', '/bin/bash', this.image, '--noprofile', '--norc', '-c', script]);
      return new Set(output.trim().split('\n'));
    } catch { return new Set(); }
  }

  async create(setup: string, fixtures: FixtureSpec[] = []): Promise<Workspace> {
    return this.mode === 'docker' ? this.createDocker(setup, fixtures) : this.createLocal(setup, fixtures);
  }

  private async createDocker(setup: string, fixtures: FixtureSpec[]): Promise<Workspace> {
    const name = `shell-lab-${randomUUID()}`;
    const path = '/home/student/workspace';
    const destroy = async () => {
      await command('docker', ['rm', '-f', name], { timeout: 10_000 }).catch(() => {});
    };
    try {
      await command('docker', [
        'run', '--detach', '--rm', '--init', '--name', name,
        '--label', 'shell-lab.managed=true', '--network', 'none',
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--memory', '256m', '--memory-swap', '256m', '--cpus', '0.5', '--pids-limit', '64',
        // Docker always prepends noexec. The workspace must stay executable so scripts such as health.sh can run; /tmp stays noexec.
        '--tmpfs', '/home/student:rw,nosuid,nodev,exec,size=64m,uid=10001,gid=10001,mode=0700',
        '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=32m',
        '--workdir', '/tmp', this.image,
      ], { timeout: 30_000 });
      await command('docker', ['exec', name, '/bin/bash', '--noprofile', '--norc', '-c', `set -e; mkdir -p ${path}; cd ${path}; ${setup}`]);
      for (const fixture of fixtures) {
        await command('docker', ['exec', '--detach', '--workdir', `${path}/${fixture.directory}`, name, 'python3', '-u', '-c', fixtureProgram(fixture), fixture.marker]);
        await waitUntil(() => command('docker', ['exec', name, 'test', '-f', `${path}/${fixtureReadyFile(fixture)}`]));
      }
      return {
        path,
        openTerminal: () => pty.spawn('docker', [
          'exec', '-it', '--workdir', path, name,
          '/bin/bash', '--noprofile', '--rcfile', '/etc/shell-lab.bashrc', '-i',
        ], { name: 'xterm-256color', cols: 100, rows: 28, env: process.env }),
        run: (script, timeoutSeconds = 3) => command('docker', [
          'exec', '--workdir', path, name,
          'timeout', '--signal=KILL', String(timeoutSeconds), '/bin/bash', '--noprofile', '--norc', '-c', script,
        ], { timeout: (timeoutSeconds + 2) * 1000 }),
        destroy,
      };
    } catch (error) {
      await destroy();
      throw new RuntimeError('无法创建 Linux 环境。请确认 Docker 正在运行，且已执行 npm run sandbox:build。', { cause: error });
    }
  }

  private async createLocal(setup: string, fixtures: FixtureSpec[]): Promise<Workspace> {
    if (process.platform !== 'linux') throw new RuntimeError('本机模式只支持 Linux。请使用 Docker 模式。');
    const home = await mkdtemp(join(tmpdir(), 'shell-lab-'));
    const path = join(home, 'workspace');
    const env = minimalEnv(home);
    const processes: { child: ChildProcess; graceful: boolean }[] = [];
    const destroy = async () => {
      await Promise.all(processes.map(({ child, graceful }) => new Promise<void>((done) => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) { done(); return; }
        const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
        const finish = () => { clearTimeout(timeout); done(); };
        child.once('exit', finish);
        child.once('error', finish);
        child.kill(graceful ? 'SIGTERM' : 'SIGKILL');
      })));
      await rm(home, { recursive: true, force: true });
    };
    try {
      await mkdir(path);
      const rc = await readFile(this.bashrc, 'utf8');
      // Keep startup independent of the user's own Bash configuration.
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(home, '.bashrc'), rc);
      await command('/bin/bash', ['--noprofile', '--norc', '-c', `set -e\n${setup}`], { cwd: path, env });
      for (const fixture of fixtures) {
        const child = spawn('python3', ['-u', '-c', fixtureProgram(fixture), fixture.marker], {
          cwd: join(path, fixture.directory), env: { ...env, ...(fixture.kind === 'ssh' ? sshToolEnvironment() : {}) }, stdio: 'ignore',
        });
        // Handle a missing executable without an unhandled EventEmitter error.
        child.on('error', () => {});
        processes.push({ child, graceful: fixture.kind === 'ssh' });
        await waitUntil(() => access(join(path, fixtureReadyFile(fixture))));
      }
      return {
        path,
        openTerminal: () => pty.spawn('/bin/bash', ['--noprofile', '--rcfile', join(home, '.bashrc'), '-i'], {
          name: 'xterm-256color', cols: 100, rows: 28, cwd: path, env,
        }),
        run: (script, timeoutSeconds = 3) => command('/usr/bin/timeout', ['--signal=KILL', String(timeoutSeconds), '/bin/bash', '--noprofile', '--norc', '-c', script], {
          cwd: path, env, timeout: (timeoutSeconds + 2) * 1000,
        }),
        destroy,
      };
    } catch (error) {
      await destroy();
      throw error;
    }
  }
}

async function waitUntil(check: () => Promise<unknown>): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await check().then(() => true, () => false)) return;
    await new Promise((done) => setTimeout(done, 30));
  }
  throw new RuntimeError('练习服务启动失败，请确认 python3 和本机回环网络可用。');
}
