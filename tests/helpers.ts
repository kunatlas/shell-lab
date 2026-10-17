import type { IPty } from 'node-pty';
import { randomUUID } from 'node:crypto';

export async function terminalCommand(terminal: IPty, script: string, timeout = 6000): Promise<{ output: string; exitCode: number }> {
  const marker = randomUUID();
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { subscription.dispose(); reject(new Error(`Terminal command timed out: ${script}\n${output}`)); }, timeout);
    const subscription = terminal.onData((data) => {
      output += data;
      const match = output.match(new RegExp(`\u001e${marker}:(\\d+)\u001f`));
      if (match) {
        clearTimeout(timer); subscription.dispose();
        resolve({ output: output.slice(0, match.index), exitCode: Number(match[1]) });
      }
    });
    terminal.write(`${script}\rprintf '\\036${marker}:%s\\037\\n' "$?"\r`);
  });
}

// Runtime tests use an empty workspace, independent of the product's scenario catalog.
export function createTestWorkspace(sessions: import('../server/sessions.js').Sessions, owner: string) {
  return sessions.create(owner, 'test-workspace', async () => ({
    setup: ':', checks: { output: 'test -f completed.txt' },
  }));
}
