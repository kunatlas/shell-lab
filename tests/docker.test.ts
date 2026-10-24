import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../server/runtime.js';
import { Sessions } from '../server/sessions.js';
import { terminalCommand } from './helpers.js';
import { catalog } from '../server/generator/catalog.js';
import { validateGeneratedExercise, buildGeneratedExercise } from '../server/generator/index.js';

test('Docker sandbox: all lessons, non-root user, readonly system, and isolated reset', {
  skip: process.env.SHELL_LAB_TEST_DOCKER !== '1' ? 'Run npm run sandbox:build && npm run test:docker on a Docker host.' : false,
  timeout: 240_000,
}, async () => {
  const runtime = new Runtime({ mode: 'docker' });
  assert.equal((await runtime.health()).ready, true);
  const sessions = new Sessions(runtime);
  try {
    const session = await sessions.generate('owner', { topics: ['logs'], difficulty: 'basic', source: 'rules' });
    assert.equal((await session.check()).passed, false);
    assert.equal((await terminalCommand(session.terminal, session.info.lesson!.example.replace(/\n/g, '\r'))).exitCode, 0);
    assert.equal((await session.check()).passed, true);
    assert.equal((await terminalCommand(session.terminal, 'test "$(id -u)" = 10001')).exitCode, 0);
    assert.equal((await terminalCommand(session.terminal, 'touch /etc/should-not-work')).exitCode, 1);
    const reset = await sessions.create('owner', session.lessonId);
    assert.equal((await reset.check()).passed, false);
    for (const topic of catalog) {
      await validateGeneratedExercise(runtime, buildGeneratedExercise({ topics: [topic.id], difficulty: 'basic', source: 'rules' }, `docker-${topic.id}`));
    }
  } finally { await sessions.close(); }
});
