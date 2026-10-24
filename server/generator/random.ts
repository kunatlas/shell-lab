import { createHash, randomBytes } from 'node:crypto';

export class Random {
  private state: number;
  readonly seed: string;
  constructor(seed = randomBytes(8).toString('hex')) {
    this.seed = seed;
    this.state = createHash('sha256').update(seed).digest().readUInt32LE(0) || 1;
  }
  integer(min: number, max: number): number {
    let x = this.state;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.state = x >>> 0;
    return min + this.state % (max - min + 1);
  }
  pick<T>(items: readonly T[]): T { return items[this.integer(0, items.length - 1)]; }
  shuffle<T>(items: readonly T[]): T[] {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.integer(0, i);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}

// All shell text generated from data passes through single-quote escaping.
export const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
export const write = (path: string, content: string) => `printf '%s' ${quote(content)} > ${quote(path)}`;
export const equals = (path: string, content: string) => `cmp -s ${quote(path)} <(printf '%s' ${quote(content)})`;
