/**
 * Runs the full demo against a freshly booted all-mock backend and returns
 * the transcript (used by `npm run demo:e2e` and by test/demoE2e.test.ts).
 */
import { startHarness } from './harness.js';
import { aiJudged, cupTowerDispute, paperBallConsent, worldMarket, wrapUp } from './scenarios.js';
import { enroll, formHuddle, signIn } from './setup.js';
import { Transcript } from './transcript.js';

export interface DemoResult {
  ok: boolean;
  checks: number;
  failures: string[];
  lines: string[];
}

export async function runDemo(opts: { echo?: boolean } = {}): Promise<DemoResult> {
  const h = await startHarness();
  const t = new Transcript(() => h.clock.nowMs(), h.clock.nowMs(), opts.echo ?? true);
  const clients: { close(): void }[] = [];
  try {
    t.section(`Verdict demo — backend ${h.baseUrl} (SOLANA_MODE=mock, all providers mock, spend disabled)`);
    const alice = await signIn(h.baseUrl, 'Alice', 'alice@demo.verdict', t);
    const bob = await signIn(h.baseUrl, 'Bob', 'bob@demo.verdict', t);
    clients.push(alice, bob);
    await enroll(alice, t);
    await enroll(bob, t);
    const crew = await formHuddle(alice, bob, t);
    const ids: string[] = [];
    ids.push(await paperBallConsent(h, crew, t));
    ids.push(await cupTowerDispute(h, crew, t));
    ids.push(await aiJudged(h, crew, t));
    ids.push(await worldMarket(h, crew, t));
    await wrapUp(crew, t, ids);
  } catch (e) {
    t.check('demo ran to completion', false, e instanceof Error ? (e.stack ?? e.message) : String(e));
  } finally {
    for (const c of clients) c.close();
    await h.close();
  }
  t.section(t.failures.length === 0 ? `PASS — ${t.checks} checks` : `FAIL — ${t.failures.length}/${t.checks} checks failed`);
  return { ok: t.failures.length === 0, checks: t.checks, failures: t.failures, lines: t.lines };
}
