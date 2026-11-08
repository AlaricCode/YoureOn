import { describe, expect, it } from 'vitest';
import { runDemo } from '../scripts/demo/run.js';

describe('npm run demo:e2e (§17)', () => {
  it('runs every scenario against the all-mock backend over HTTP/WS and passes all checks', async () => {
    const r = await runDemo({ echo: false });
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks).toBeGreaterThan(30);
    const text = r.lines.join('\n');
    for (const s of ['Paper-ball shot', 'dispute → replay booth', 'AI-judged', 'World Mode']) expect(text).toContain(s);
    expect(text).toMatch(/via consent/);
    expect(text).toMatch(/via panel/);
  }, 120_000);
});
