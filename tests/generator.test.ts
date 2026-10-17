import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { buildGeneratedExercise, generateExercise, generatorInfo, parseGenerationOptions, validateGeneratedExercise } from '../server/generator/index.js';
import { validatePlan, planWithAI } from '../server/generator/planner.js';
import { topicIds } from '../server/generator/catalog.js';
import { Runtime } from '../server/runtime.js';
import { Sessions } from '../server/sessions.js';
import { terminalCommand } from './helpers.js';
import type { GenerationOptions } from '../shared/types.js';

const options = (topics: string[], difficulty: GenerationOptions['difficulty'] = 'basic'): GenerationOptions => ({ topics, difficulty, source: 'rules' });
const sshTools = await new Runtime({ mode: 'local' }).availableTools(['sshd', 'sftp-server']);

for (const topic of topicIds) {
  test(`dynamic ${topic}: three seeds produce valid tasks, solved by real Bash`, {
    skip: ['ssh', 'ssh-config', 'scp', 'scp-tree', 'remote-deploy'].includes(topic) && sshTools.size < 2 ? 'Run ./setup-ssh.sh to prepare OpenSSH.' : false,
  }, async () => {
    const runtime = new Runtime({ mode: 'local' });
    for (const seed of ['variation-11', 'variation-24', 'variation-37']) {
      const exercise = buildGeneratedExercise(options([topic]), seed);
      await validateGeneratedExercise(runtime, exercise);
      assert.equal(exercise.lesson.generated?.verified, true);
      assert.deepEqual(Object.keys(exercise.checks), exercise.lesson.objectives.map((goal) => goal.id));
    }
  });
}

test('combined scenarios change goals, remain reproducible, and respect the selected scope', async () => {
  const config = options(['logs', 'config', 'archive'], 'advanced');
  const first = buildGeneratedExercise(config, 'reproducible');
  const again = buildGeneratedExercise(config, 'reproducible');
  assert.deepEqual(first, again);
  assert.equal(first.lesson.generated?.topics.length, 3);
  assert.equal(first.lesson.objectives.length, 6);
  assert.notDeepEqual(first.setup, buildGeneratedExercise(config, 'another-seed').setup);
  await validateGeneratedExercise(new Runtime({ mode: 'local' }), first);
  assert.throws(() => parseGenerationOptions({ ...config, topics: ['__proto__'] }), /有效/);
  assert.throws(() => parseGenerationOptions({ ...config, focus: 'x'.repeat(501) }), /500/);
});

test('generated session resets the same question, restores metadata, and preserves the old session on generation failure', async () => {
  const sessions = new Sessions(new Runtime({ mode: 'local' }));
  try {
    const current = await sessions.generate('owner', options(['config']));
    assert.equal(current.info.lesson?.generated?.verified, true);
    assert.equal((await current.check()).passed, false);
    await terminalCommand(current.terminal, current.info.lesson!.example.replace(/\n/g, '\r'));
    assert.equal((await current.check()).passed, true);
    const reset = await sessions.create('owner', current.lessonId);
    assert.deepEqual(reset.info.lesson, current.info.lesson);
    assert.equal((await reset.check()).passed, false);
    await assert.rejects(sessions.create('owner', '', async () => { throw new Error('planning failed'); }), /planning failed/);
    assert.equal(sessions.get('owner'), reset);
  } finally { await sessions.close(); }
});

test('HTTP and worker fixtures are owned by the workspace and removed on destroy', async () => {
  const runtime = new Runtime({ mode: 'local' });
  const exercise = buildGeneratedExercise(options(['http', 'process'], 'intermediate'), 'owned-fixtures');
  const workspace = await runtime.create(exercise.setup, exercise.fixtures);
  let pids: number[] = [];
  try {
    for (const fixture of exercise.fixtures!) {
      const file = fixture.kind === 'http' ? 'server.pid' : 'worker.pid';
      pids.push(Number(await readFile(`${workspace.path}/${fixture.directory}/${file}`, 'utf8')));
    }
    for (const pid of pids) process.kill(pid, 0);
  } finally { await workspace.destroy(); }
  for (const pid of pids) assert.throws(() => process.kill(pid, 0));
  await assert.rejects(access(workspace.path));
});

test('tool availability and rules generator work without AI credentials', async () => {
  const runtime = new Runtime({ mode: 'local' });
  const info = await generatorInfo(runtime);
  assert.equal(info.topics.length, 25);
  assert.ok(info.topics.find((topic) => topic.id === 'logs')?.available);
  const generated = await generateExercise(runtime, options(['logs', 'access'], 'intermediate'));
  assert.equal(generated.lesson.generated?.source, 'rules');
});

test('AI plans cannot inject code or expand the requested scope', async () => {
  const config = options(['logs', 'config'], 'intermediate');
  assert.throws(() => validatePlan({ title: 'test', introduction: 'test', topics: ['logs', 'config'], setup: 'touch /tmp/not-allowed' }, config));
  assert.throws(() => validatePlan({ title: 'test', introduction: 'test', topics: ['logs', 'process'] }, config));
  assert.throws(() => validatePlan({ title: 'test', introduction: 'test', topics: ['logs', 'logs'] }, config));
  const previous = { url: process.env.SHELL_LAB_AI_BASE_URL, model: process.env.SHELL_LAB_AI_MODEL, key: process.env.SHELL_LAB_AI_API_KEY };
  process.env.SHELL_LAB_AI_BASE_URL = 'https://example.invalid/v1';
  process.env.SHELL_LAB_AI_MODEL = 'test-model';
  process.env.SHELL_LAB_AI_API_KEY = 'test-key';
  try {
    const plan = await planWithAI({ ...config, source: 'ai', focus: '日志和配置' }, (async (url, init) => {
      assert.equal(url, 'https://example.invalid/v1/chat/completions');
      const body = JSON.parse(init!.body as string);
      assert.equal(body.model, 'test-model');
      assert.equal(body.response_format.json_schema.strict, true);
      assert.ok(body.messages[1].content.includes('日志和配置'));
      return Response.json({ choices: [{ message: { content: JSON.stringify({ title: '上线后的日志排查', introduction: '排查服务上线后出现的异常。', topics: ['logs', 'config'] }) } }] });
    }) as typeof fetch);
    const generated = buildGeneratedExercise(config, 'ai-plan', plan);
    await validateGeneratedExercise(new Runtime({ mode: 'local' }), generated);
    assert.equal(generated.lesson.generated?.source, 'ai');
    assert.equal(generated.lesson.title, '上线后的日志排查');
    await assert.rejects(planWithAI({ ...config, source: 'ai' }, (async () => Response.json({}, { status: 401 })) as typeof fetch), /HTTP 401/);
  } finally {
    for (const [key, value] of Object.entries({ SHELL_LAB_AI_BASE_URL: previous.url, SHELL_LAB_AI_MODEL: previous.model, SHELL_LAB_AI_API_KEY: previous.key })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
