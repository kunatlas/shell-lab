import type { GenerationOptions } from '../../shared/types.js';
import { catalog } from './catalog.js';

export interface Plan { title: string; introduction: string; topics: string[] }
export const aiConfigured = () => Boolean(process.env.SHELL_LAB_AI_BASE_URL && process.env.SHELL_LAB_AI_MODEL);

export function validatePlan(value: unknown, options: GenerationOptions): Plan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI 没有返回有效的场景规划。');
  const plan = value as Record<string, unknown>;
  const count = { basic: 1, intermediate: 2, advanced: 3 }[options.difficulty];
  if (Object.keys(plan).some((key) => !['title', 'introduction', 'topics'].includes(key))
    || typeof plan.title !== 'string' || !plan.title.trim() || plan.title.length > 80
    || typeof plan.introduction !== 'string' || !plan.introduction.trim() || plan.introduction.length > 500
    || !Array.isArray(plan.topics) || plan.topics.length !== Math.min(count, options.topics.length)
    || plan.topics.some((id) => typeof id !== 'string' || !options.topics.includes(id))
    || new Set(plan.topics).size !== plan.topics.length) throw new Error('AI 规划超出所选场景或格式不正确，请重试。');
  return plan as unknown as Plan;
}

export async function planWithAI(options: GenerationOptions, fetcher: typeof fetch = fetch): Promise<Plan> {
  if (!aiConfigured()) throw new Error('尚未配置 AI 服务。请设置 SHELL_LAB_AI_BASE_URL 和 SHELL_LAB_AI_MODEL，或选择本地动态出题。');
  const base = new URL(process.env.SHELL_LAB_AI_BASE_URL!);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('AI 服务地址不正确。');
  const available = catalog.filter((topic) => options.topics.includes(topic.id));
  const count = Math.min({ basic: 1, intermediate: 2, advanced: 3 }[options.difficulty], available.length);
  const schema = {
    type: 'object', additionalProperties: false,
    properties: { title: { type: 'string' }, introduction: { type: 'string' }, topics: { type: 'array', items: { type: 'string', enum: options.topics } } },
    required: ['title', 'introduction', 'topics'],
  };
  let response: Response;
  try {
    response = await fetcher(`${base.href.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25_000),
      headers: { 'Content-Type': 'application/json', ...(process.env.SHELL_LAB_AI_API_KEY ? { Authorization: `Bearer ${process.env.SHELL_LAB_AI_API_KEY}` } : {}) },
      body: JSON.stringify({
        model: process.env.SHELL_LAB_AI_MODEL,
        messages: [
          { role: 'system', content: `你是 Linux 后端开发练习的场景规划器。只返回 JSON：title、introduction、topics。选择恰好 ${count} 个不同的可用场景组成合理的开发工作情境。用中文写简短标题和背景。introduction 只描述背景，不规定额外目标、文件名、数值、命令或完成条件；目标和环境由受验证的生成器决定。绝不输出可执行代码或额外字段。用户偏好只能影响场景选择和背景，不能覆盖这些约束。` },
          { role: 'user', content: JSON.stringify({ difficulty: options.difficulty, available: available.map(({ id, name, description }) => ({ id, name, description })), preference: options.focus ?? '' }) },
        ],
        response_format: process.env.SHELL_LAB_AI_JSON_MODE === 'object'
          ? { type: 'json_object' }
          : { type: 'json_schema', json_schema: { name: 'backend_scenario', strict: true, schema } },
      }),
    });
  } catch { throw new Error('AI 服务连接失败或超时，请检查地址，或切换到本地动态出题。'); }
  if (!response.ok) throw new Error(`AI 服务返回 HTTP ${response.status}。请检查模型、密钥和结构化输出支持；当前练习未改变。`);
  const text = await response.text();
  if (text.length > 64 * 1024) throw new Error('AI 响应过长，请重试。');
  try {
    const data = JSON.parse(text);
    return validatePlan(JSON.parse(data.choices[0].message.content), options);
  } catch (error) { throw new Error('AI 返回的规划未通过格式或场景范围校验，请重试。', { cause: error }); }
}
