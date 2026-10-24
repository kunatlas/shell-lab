import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { Runtime } from '../server/runtime.js';
import { Sessions } from '../server/sessions.js';
import { terminalCommand, createTestWorkspace } from './helpers.js';

test('real Bash preserves cwd, variables, quoting, pipes, exit codes, and terminal size', async () => {
  const previousSecret = process.env.SHELL_LAB_TEST_SECRET;
  process.env.SHELL_LAB_TEST_SECRET = 'application-only-sentinel';
  const sessions = new Sessions(new Runtime({ mode: 'local' }));
  try {
    const session = await createTestWorkspace(sessions, 'owner');
    const run = (script: string) => terminalCommand(session.terminal, script);
    assert.equal((await run('mkdir -p nested && cd nested')).exitCode, 0);
    assert.equal((await run("name='Linux learner'")).exitCode, 0);
    const state = await run('printf "CWD:%s NAME:%s\\n" "$PWD" "$name"');
    assert.match(state.output, /CWD:.*\/workspace\/nested NAME:Linux learner/);
    assert.equal((await run("printf '%s\\n' one two three | grep two > result.txt")).exitCode, 0);
    assert.match((await run('cat result.txt')).output, /two\r\n/);
    const missing = await run('cat missing.txt');
    assert.equal(missing.exitCode, 1);
    assert.match(missing.output, /No such file or directory/);
    assert.equal((await run('shell_lab_nonexistent_command')).exitCode, 127);
    const syntax = await run('if then');
    assert.equal(syntax.exitCode, 2);
    assert.match(syntax.output, /syntax error near unexpected token/);
    session.terminal.resize(90, 24);
    assert.match((await run('stty size')).output, /24 90\r\n/);
    assert.equal((await run('test -t 0 && test -t 1')).exitCode, 0);
    // Exercises must not inherit application secrets or the host's Bash environment.
    assert.equal((await run('test -z "$SHELL_LAB_TEST_SECRET"')).exitCode, 0);
  } finally {
    await sessions.close();
    if (previousSecret === undefined) delete process.env.SHELL_LAB_TEST_SECRET;
    else process.env.SHELL_LAB_TEST_SECRET = previousSecret;
  }
});

test('Ctrl+C interrupts foreground execution and leaves the same Shell usable', async () => {
  const sessions = new Sessions(new Runtime({ mode: 'local' }));
  try {
    const session = await createTestWorkspace(sessions, 'owner');
    await terminalCommand(session.terminal, "name='still here'");
    session.terminal.write('sleep 30\r');
    await new Promise((done) => setTimeout(done, 150));
    session.terminal.write('\x03');
    const interrupted = await terminalCommand(session.terminal, 'printf "%s\\n" "$name"');
    assert.match(interrupted.output, /still here/);
    assert.equal(interrupted.exitCode, 0);
  } finally { await sessions.close(); }
});

test('reset replaces the workspace and removes previous files and variables', async () => {
  const sessions = new Sessions(new Runtime({ mode: 'local' }));
  try {
    const first = await createTestWorkspace(sessions, 'owner');
    const oldPath = first.workspace.path;
    await terminalCommand(first.terminal, 'touch old-file; remembered=yes');
    const second = await createTestWorkspace(sessions, 'owner');
    assert.notEqual(second.workspace.path, oldPath);
    await assert.rejects(access(oldPath));
    assert.equal((await terminalCommand(second.terminal, 'test ! -e old-file && test -z "$remembered"')).exitCode, 0);
  } finally { await sessions.close(); }
});

test('concurrent creation for the same owner is rejected, and owners have separate files', async () => {
  const sessions = new Sessions(new Runtime({ mode: 'local' }), 2);
  try {
    const pending = createTestWorkspace(sessions, 'a');
    await assert.rejects(createTestWorkspace(sessions, 'a'), /正在准备/);
    const first = await pending;
    const second = await createTestWorkspace(sessions, 'b');
    await terminalCommand(first.terminal, 'touch only-in-a');
    assert.equal((await terminalCommand(second.terminal, 'test ! -e only-in-a')).exitCode, 0);
    await assert.rejects(createTestWorkspace(sessions, 'c'), /已满/);
    await assert.rejects(sessions.create('a', '__proto__'), /没有找到/);
  } finally { await sessions.close(); }
});

test('grading times out a hanging script without blocking later checks', async () => {
  const sessions = new Sessions(new Runtime({ mode: 'local' }));
  try {
    const session = await sessions.create('owner', 'timeout-test', async () => ({
      setup: ':', checks: { script: 'while true; do :; done', output: 'test -f completed.txt' },
    }));
    await terminalCommand(session.terminal, 'touch completed.txt');
    const result = await session.check();
    assert.deepEqual(result.results, [{ id: 'script', passed: false }, { id: 'output', passed: true }]);
  } finally { await sessions.close(); }
});
