import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGeneratedExercise } from '../server/generator/index.js';
import { Runtime } from '../server/runtime.js';
import { quote, write } from '../server/generator/random.js';

const runtime = new Runtime({ mode: 'local' });
const exerciseFor = (topic: string) => buildGeneratedExercise({ topics: [topic], difficulty: 'basic', source: 'rules' }, `operations-${topic}`);

test('network uses a real Host-sensitive server and native curl errors', async () => {
  const exercise = exerciseFor('network');
  const workspace = await runtime.create(exercise.setup, exercise.fixtures);
  const run = (script: string) => workspace.run(`cd tasks/1-network\n${script}`);
  try {
    assert.equal(await run(`route=$(python3 -c 'import json; print(json.load(open("server-data.json"))["route"])'); curl -sS -o /dev/null -w '%{http_code}' "$(cat endpoint.txt)$route"`), '404');
    await assert.rejects(run(`curl -fsS "$(cat endpoint.txt)/not-found"`), (error: any) => error.code === 22);
    await workspace.run(exercise.lesson.example);
    for (const check of Object.values(exercise.checks)) await workspace.run(check);
    await run("printf 'HTTP/1.0 200 OK\\n' > headers.txt");
    await assert.rejects(workspace.run(exercise.checks['network-2']));
  } finally { await workspace.destroy(); }
});

test('disk diagnosis rejects a missing file and modified source data', async () => {
  const exercise = exerciseFor('disk');
  const workspace = await runtime.create(exercise.setup);
  try {
    await workspace.run(exercise.lesson.example);
    for (const check of Object.values(exercise.checks)) await workspace.run(check);
    await workspace.run('cd tasks/1-disk; sed -i 1d large.txt');
    await assert.rejects(workspace.run(exercise.checks['disk-1']));
    await workspace.run(exercise.lesson.example);
    await workspace.run('cd tasks/1-disk; printf damaged > data/cache/build.bin');
    await assert.rejects(workspace.run(exercise.checks['disk-1']));
  } finally { await workspace.destroy(); }
});

test('retry checks reject a wrapper with no timeout or retries', async () => {
  const exercise = exerciseFor('retry');
  const workspace = await runtime.create(exercise.setup);
  try {
    await workspace.run(`cd tasks/1-retry\n${write('retry.sh', '#!/bin/bash\nshift 2\n"$@"\n')}\nchmod +x retry.sh`);
    await assert.rejects(workspace.run(exercise.checks['retry-1']));
    await assert.rejects(workspace.run(exercise.checks['retry-2']));
    await workspace.run(exercise.lesson.example);
    // Each check runs repeatedly against fresh input, as in the user's check button.
    for (let i = 0; i < 2; i++) for (const check of Object.values(exercise.checks)) await workspace.run(check);
  } finally { await workspace.destroy(); }
});

test('publication checks reject direct overwrite and missing failure cleanup', async () => {
  const exercise = exerciseFor('atomic');
  const workspace = await runtime.create(exercise.setup);
  const install = (body: string) => workspace.run(`cd tasks/1-atomic\n${write('publish.sh', `#!/bin/bash\n${body}\n`)}\nchmod +x publish.sh`);
  try {
    await install('./processor.sh "$1" "$2"');
    await assert.rejects(workspace.run(exercise.checks['atomic-2']));
    await install('[ "$#" -eq 2 ] || exit 2\nstage=$(mktemp -- "$2.tmp.XXXXXX")\n./processor.sh "$1" "$stage" || exit $?\nmv -- "$stage" "$2"');
    await assert.rejects(workspace.run(exercise.checks['atomic-2']));
    await workspace.run(exercise.lesson.example);
    for (const check of Object.values(exercise.checks)) await workspace.run(check);
  } finally { await workspace.destroy(); }
});

test('backup checks reject missing locks and blocking lock acquisition', async () => {
  const exercise = exerciseFor('locking');
  const workspace = await runtime.create(exercise.setup);
  const install = (body: string) => workspace.run(`cd tasks/1-locking\n${write('backup.sh', `#!/bin/bash\n${body}\n`)}\nchmod +x backup.sh`);
  try {
    await install('[ "$#" -eq 2 ] || exit 2\ncp -- "$1" "$2"\nsha256sum -- "$2" > "$2.sha256"');
    await workspace.run(exercise.checks['locking-1']);
    await assert.rejects(workspace.run(exercise.checks['locking-2']));
    await install('[ "$#" -eq 2 ] || exit 2\nexec 9>backup.lock\nflock 9\ncp -- "$1" "$2"');
    await assert.rejects(workspace.run(exercise.checks['locking-2']));
    await workspace.run(exercise.lesson.example);
    for (const check of Object.values(exercise.checks)) await workspace.run(check);
    assert.equal(await workspace.run(`cd tasks/1-locking; test -f backup.lock; printf %s ${quote('released')}`), 'released');
  } finally { await workspace.destroy(); }
});
