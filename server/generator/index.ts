import { randomBytes } from 'node:crypto';
import type { GenerationOptions, GeneratorInfo, Lesson, ScenarioTopic } from '../../shared/types.js';
import type { Exercise } from '../exercises.js';
import type { Runtime } from '../runtime.js';
import { catalog, topicIds } from './catalog.js';
import { builders } from './builders.js';
import { Random, quote } from './random.js';
import { aiConfigured, planWithAI } from './planner.js';

export function parseGenerationOptions(value: unknown): GenerationOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('出题参数格式不正确。');
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.topics) || input.topics.length > catalog.length || input.topics.some((id) => typeof id !== 'string' || !topicIds.includes(id))) throw new Error('请选择有效的开发场景。');
  if (!['basic', 'intermediate', 'advanced'].includes(input.difficulty as string)) throw new Error('请选择有效的难度。');
  if (!['rules', 'ai'].includes(input.source as string)) throw new Error('请选择有效的出题方式。');
  if (input.focus !== undefined && (typeof input.focus !== 'string' || input.focus.length > 500)) throw new Error('练习偏好不能超过 500 字。');
  return {
    topics: [...new Set(input.topics as string[])], difficulty: input.difficulty as GenerationOptions['difficulty'],
    source: input.source as GenerationOptions['source'], focus: input.focus as string | undefined,
  };
}

export async function generatorInfo(runtime: Runtime): Promise<GeneratorInfo> {
  const tools = await runtime.availableTools([...new Set(catalog.flatMap((topic) => topic.tools))]);
  const topics: ScenarioTopic[] = catalog.map((topic) => {
    const missing = topic.tools.filter((tool) => !tools.has(tool));
    return { ...topic, available: !missing.length, ...(missing.length ? { unavailableReason: `环境缺少：${missing.join('、')}` } : {}) };
  });
  return { topics, aiConfigured: aiConfigured() };
}

export function buildGeneratedExercise(options: GenerationOptions, seed = randomBytes(8).toString('hex'), planned?: { title: string; introduction: string; topics: string[] }): Exercise & { lesson: Lesson } {
  const random = new Random(seed);
  const service = random.pick(['orders-api', 'billing-worker', 'user-service', 'inventory-api', 'gateway-api', 'notification-service']);
  const count = { basic: 1, intermediate: 2, advanced: 3 }[options.difficulty];
  const allowed = options.topics.length ? options.topics : topicIds;
  const selected = planned?.topics ?? random.shuffle(allowed).slice(0, count);
  if (!selected.length || selected.length > count || selected.some((id) => !allowed.includes(id)) || new Set(selected).size !== selected.length) throw new Error('场景规划不符合所选范围，请重新生成。');
  const setup: string[] = [];
  const checks: Record<string, string> = {};
  const objectives: Lesson['objectives'] = [];
  const solutions: string[] = [];
  const hints: string[] = [];
  const briefs: string[] = [];
  const titles: string[] = [];
  const fixtures: NonNullable<Exercise['fixtures']> = [];
  for (const [index, topicId] of selected.entries()) {
    const task = builders[topicId](random, service);
    titles.push(task.title);
    const directory = `tasks/${index + 1}-${topicId}`;
    setup.push(`mkdir -p ${quote(directory)}`, `(cd ${quote(directory)}\nset -e\n${task.setup.join('\n') || ':'}\n)`);
    solutions.push(`# ${task.title}\n(cd ${quote(directory)}\nset -e\n${task.solution.join('\n')}\n)`);
    hints.push(`${task.title}：${task.hint}`);
    briefs.push(`【${directory}】${task.brief}`);
    if (task.fixture) fixtures.push({ ...task.fixture, directory });
    for (const [goalIndex, goal] of task.goals.entries()) {
      const id = `${topicId}-${goalIndex + 1}`;
      objectives.push({ id, text: `在 ${directory} 中：${goal.text}` });
      checks[id] = `(cd ${quote(directory)} && {\n${goal.check}\n})`;
    }
  }
  const title = planned?.title ?? `${service} · ${selected.length > 1 ? '开发值班综合演练' : titles[0]}`;
  return {
    setup: setup.join('\n'), checks, fixtures,
    lesson: {
      id: `generated-${seed}`, chapter: '后端开发实战', title,
      subtitle: `${{ basic: '基础专项', intermediate: '组合实战', advanced: '综合挑战' }[options.difficulty]} · ${selected.map((id) => catalog.find((topic) => topic.id === id)!.name).join(' / ')}`,
      minutes: selected.length * (options.difficulty === 'advanced' ? 10 : 7),
      concepts: [...new Set(selected.flatMap((id) => catalog.find((topic) => topic.id === id)!.concepts))],
      description: `${planned?.introduction ?? `你正在维护 ${service}。请完成下面的开发任务；每个任务有独立目录，路径均相对于初始工作区。`}\n\n${briefs.join('\n\n')}`,
      objectives, hint: hints.join('\n\n'), example: solutions.join('\n\n'),
      takeaway: '先观察初始文件，再执行操作。判题检查实际结果，不要求唯一命令；脚本题会运行你的脚本。重置恢复本题，换一题会生成新任务。',
      generated: { seed, topics: selected, difficulty: options.difficulty, source: planned ? 'ai' : 'rules', verified: false },
    },
  };
}

export async function validateGeneratedExercise(runtime: Runtime, exercise: Exercise & { lesson: Lesson }): Promise<void> {
  const scratch = await runtime.create(exercise.setup, exercise.fixtures);
  try {
    const initial = [];
    for (const script of Object.values(exercise.checks)) initial.push(await scratch.run(script).then(() => true, () => false));
    if (initial.every(Boolean)) throw new Error('初始环境已经通过全部目标。');
    await scratch.run(`set -e\n${exercise.lesson.example}`, 15);
    for (const [id, script] of Object.entries(exercise.checks)) {
      try { await scratch.run(script); }
      catch (error) { throw new Error(`目标 ${id} 的参考解未通过验证。`, { cause: error }); }
    }
    exercise.lesson.generated!.verified = true;
  } finally { await scratch.destroy(); }
}

export async function generateExercise(runtime: Runtime, options: GenerationOptions): Promise<Exercise & { lesson: Lesson }> {
  const info = await generatorInfo(runtime);
  const available = info.topics.filter((topic) => topic.available).map((topic) => topic.id);
  const topics = options.topics.length ? options.topics : available;
  if (!topics.length) throw new Error('当前环境没有可用场景，请检查 Linux 环境和所需工具。');
  for (const id of topics) {
    if (!available.includes(id)) throw new Error(info.topics.find((topic) => topic.id === id)?.unavailableReason ?? '场景不可用。');
  }
  const effective = { ...options, topics };
  const plan = options.source === 'ai' ? await planWithAI(effective) : undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const exercise = buildGeneratedExercise(effective, undefined, plan);
    try { await validateGeneratedExercise(runtime, exercise); return exercise; }
    catch (error) {
      if (attempt === 2) throw new Error('新题目的环境校验未通过，请重新生成或检查环境工具。当前练习已保留。', { cause: error });
    }
  }
  throw new Error('无法生成练习。');
}
