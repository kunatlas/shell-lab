export interface Objective { id: string; text: string }
export interface Lesson {
  id: string;
  chapter: string;
  title: string;
  subtitle: string;
  minutes: number;
  concepts: string[];
  description: string;
  objectives: Objective[];
  hint: string;
  example: string;
  takeaway: string;
  generated?: {
    seed: string;
    topics: string[];
    difficulty: Difficulty;
    source: 'rules' | 'ai';
    verified: boolean;
  };
}
export type Difficulty = 'basic' | 'intermediate' | 'advanced';
export type ScenarioGroupId = 'diagnose' | 'files' | 'release' | 'remote';
export interface ScenarioTopic {
  id: string;
  name: string;
  description: string;
  concepts: string[];
  tools: string[];
  group: ScenarioGroupId;
  available: boolean;
  unavailableReason?: string;
}
export interface GenerationOptions {
  topics: string[];
  difficulty: Difficulty;
  source: 'rules' | 'ai';
  focus?: string;
}
export interface GeneratorInfo {
  topics: ScenarioTopic[];
  aiConfigured: boolean;
}
export type RuntimeMode = 'docker' | 'local';
export interface RuntimeHealth {
  ready: boolean;
  mode: RuntimeMode;
  label: string;
  message: string;
}
export interface SessionInfo {
  lessonId: string;
  runtime: RuntimeMode;
  workspace: string;
  active: boolean;
  lesson?: Lesson;
}
export interface CheckResult {
  lessonId: string;
  passed: boolean;
  results: { id: string; passed: boolean }[];
}
export interface Bootstrap {
  health: RuntimeHealth;
  session: SessionInfo | null;
  generator: GeneratorInfo;
}
