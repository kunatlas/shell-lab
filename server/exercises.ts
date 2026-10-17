import type { Lesson } from '../shared/types.js';

export interface FixtureSpec {
  kind: 'http' | 'worker' | 'ssh';
  directory: string;
  marker: string;
  clientKeyMode?: number;
  alias?: string;
}
export interface Exercise {
  setup: string;
  checks: Record<string, string>;
  lesson?: Lesson;
  fixtures?: FixtureSpec[];
}
