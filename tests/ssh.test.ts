import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { Runtime } from '../server/runtime.js';
import { Sessions } from '../server/sessions.js';
import { buildGeneratedExercise, validateGeneratedExercise } from '../server/generator/index.js';
import { terminalCommand } from './helpers.js';

const runtime = new Runtime({ mode: 'local' });
const available = await runtime.availableTools(['sshd', 'sftp-server']);
const skip = available.size < 2 ? 'Run ./setup-ssh.sh to prepare the real OpenSSH server.' : false;

test('OpenSSH returns real key-permission, authentication, host-key and remote-command failures', { skip }, async () => {
  const exercise = buildGeneratedExercise({ topics: ['ssh'], difficulty: 'basic', source: 'rules' }, 'ssh-errors');
  const workspace = await runtime.create(exercise.setup, exercise.fixtures);
  const dir = exercise.fixtures![0].directory;
  const run = (script: string) => workspace.run(`cd '${dir}'\n${script}`);
  try {
    await assert.rejects(run("ssh -F client.conf lab-target 'true'"), /bad permissions|UNPROTECTED PRIVATE KEY/);
    await run('chmod 600 client_key');
    assert.equal(await run("ssh -F client.conf lab-target 'printf SSH_CONNECTED'"), 'SSH_CONNECTED');
    await assert.rejects(run("ssh -F client.conf lab-target 'exit 37'"), (error: any) => error.code === 37);
    await assert.rejects(run("ssh -F client.conf lab-target 'cat file-that-does-not-exist'"), /No such file or directory/);
    await run("ssh-keygen -q -t ed25519 -N '' -f wrong-key");
    await assert.rejects(run('source connection.env; ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$SSH_KNOWN_HOSTS" -i wrong-key -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" true'), /Permission denied/);
    await run('source connection.env; read -r type pub rest < wrong-key.pub; printf \'[127.0.0.1]:%s %s %s\\n\' "$SSH_PORT" "$type" "$pub" > wrong-known-hosts');
    await assert.rejects(run('ssh -F client.conf -o "UserKnownHostsFile=$PWD/wrong-known-hosts" lab-target true'), /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/);
  } finally { await workspace.destroy(); }
});

test('native SCP works through SFTP and the legacy SCP protocol without touching personal SSH configuration', { skip }, async () => {
  const exercise = buildGeneratedExercise({ topics: ['scp'], difficulty: 'basic', source: 'rules' }, 'native-scp');
  const workspace = await runtime.create(exercise.setup, exercise.fixtures);
  const dir = exercise.fixtures![0].directory;
  try {
    await workspace.run(`cd '${dir}'\nscp -F client.conf 'local package.txt' lab-target:incoming/sftp-copy.txt\nscp -F client.conf -O 'local package.txt' lab-target:incoming/legacy-copy.txt\ncmp -s 'local package.txt' remote/incoming/sftp-copy.txt\ncmp -s 'local package.txt' remote/incoming/legacy-copy.txt`);
    const env = await readFile(`${workspace.path}/${dir}/connection.env`, 'utf8');
    assert.ok(env.includes(workspace.path));
    const config = await readFile(`${workspace.path}/${dir}/client.conf`, 'utf8');
    assert.ok(config.includes(`UserKnownHostsFile "${workspace.path}/`));
  } finally { await workspace.destroy(); }
});

test('SSH reset rotates keys, clears transfers and closes the old daemon and listening port', { skip }, async () => {
  const sessions = new Sessions(runtime);
  try {
    const first = await sessions.generate('owner', { topics: ['scp'], difficulty: 'basic', source: 'rules' });
    const dir = first.exercise.fixtures![0].directory;
    const old = first.workspace.path;
    const pid = Number(await readFile(`${old}/${dir}/server.pid`, 'utf8'));
    const known = await readFile(`${old}/${dir}/known_hosts`, 'utf8');
    const port = Number(known.match(/\]:(\d+)/)![1]);
    assert.equal((await terminalCommand(first.terminal, first.info.lesson!.example.replace(/\n/g, '\r'))).exitCode, 0);
    assert.equal((await first.check()).passed, true);
    const reset = await sessions.create('owner', first.lessonId);
    assert.equal((await reset.check()).passed, false);
    assert.deepEqual(reset.info.lesson, first.info.lesson);
    assert.notEqual(await readFile(`${reset.workspace.path}/${dir}/known_hosts`, 'utf8'), known);
    assert.throws(() => process.kill(pid, 0));
    await assert.rejects(access(old));
    await new Promise<void>((done, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); reject(new Error('Old SSH port is still listening')); });
      socket.once('error', () => done());
    });
  } finally { await sessions.close(); }
});

test('a combined SSH/SCP release drill is solvable with independent services', { skip }, async () => {
  const exercise = buildGeneratedExercise({ topics: ['ssh', 'scp', 'remote-deploy'], difficulty: 'advanced', source: 'rules' }, 'full-remote-workflow');
  await validateGeneratedExercise(runtime, exercise);
  assert.equal(exercise.lesson.generated?.verified, true);
  assert.equal(exercise.fixtures?.length, 3);
});
