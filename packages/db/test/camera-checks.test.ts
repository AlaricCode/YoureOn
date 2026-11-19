// Migration 0009 (bet_checks, attempt_checks: camera checks, non-binding) against Postgres; skips
// without DATABASE_URL. The CHECKs the server relies on, the per-bet upsert, the (bet,
// attempt_no) key, and the cascade on a bet delete (demo reset).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { attemptChecks, betChecks, bets, createDb, users, type DbHandle } from '../src/index';

async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return err.cause?.message ?? err.message ?? String(e);
  }
  throw new Error('expected the query to fail');
}

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fakeKey = (n = 44) => Array.from(randomBytes(n), (b) => B58[b % B58.length]).join('');
const HASH = 'ab'.repeat(32);
const SPEC = { predicates: 'p1', entities: [], assertions: [] };

d('migration 0009: bet_checks and attempt_checks', () => {
  let h: DbHandle;
  let a: string;
  let b: string;

  beforeAll(async () => {
    h = createDb({ url: URL! });
    const mk = async () =>
      (
        await h.db
          .insert(users)
          .values({
            display_name: 'T',
            wallet_pubkey: fakeKey(),
            age_attested_18plus: true,
            attested_at: new Date(),
          })
          .returning()
      )[0]!.id;
    a = await mk();
    b = await mk();
  });
  afterAll(async () => {
    await h?.close();
  });

  const newBet = async () =>
    (
      await h.db
        .insert(bets)
        .values({ party_a_id: a, party_b_id: b, mint: MINT, evidence_source: 'camera' })
        .returning()
    )[0]!.id;
  const row = (betId: string, over: Partial<typeof betChecks.$inferInsert> = {}) => ({
    bet_id: betId,
    terms_hash: HASH,
    decision: 'checks',
    spec: SPEC,
    readback: 'Ref cam: x.',
    prompt_version: 'v1',
    status: 'ok',
    ...over,
  });

  it('bet_checks: decision <-> spec, status, hash format, readback length; upsert per bet', async () => {
    const betId = await newBet();
    expect(await pgError(h.db.insert(betChecks).values(row(betId, { spec: null })))).toMatch(
      /bet_checks_spec/,
    );
    expect(
      await pgError(h.db.insert(betChecks).values(row(betId, { decision: 'judge_only' }))),
    ).toMatch(/bet_checks_spec/);
    expect(await pgError(h.db.insert(betChecks).values(row(betId, { decision: 'maybe' })))).toMatch(
      /bet_checks_decision/,
    );
    expect(await pgError(h.db.insert(betChecks).values(row(betId, { status: 'x' })))).toMatch(
      /bet_checks_status/,
    );
    expect(await pgError(h.db.insert(betChecks).values(row(betId, { terms_hash: 'x' })))).toMatch(
      /bet_checks_terms_hash_fmt/,
    );
    expect(
      await pgError(h.db.insert(betChecks).values(row(betId, { readback: 'x'.repeat(401) }))),
    ).toMatch(/bet_checks_readback_len/);
    await h.db.insert(betChecks).values(row(betId));
    const next = row(betId, { terms_hash: 'cd'.repeat(32), decision: 'judge_only', spec: null });
    await h.db
      .insert(betChecks)
      .values(next)
      .onConflictDoUpdate({ target: betChecks.bet_id, set: next });
    const got = await h.db.select().from(betChecks).where(eq(betChecks.bet_id, betId));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      terms_hash: 'cd'.repeat(32),
      decision: 'judge_only',
      spec: null,
    });
  });

  it('attempt_checks: one per (bet, attempt_no); status and hash checked; cascades with the bet', async () => {
    const betId = await newBet();
    const ac = (n: number, over: Partial<typeof attemptChecks.$inferInsert> = {}) => ({
      bet_id: betId,
      attempt_no: n,
      status: 'ok',
      report: { schema_version: 1 },
      report_hash: HASH,
      sam_ms: 3500,
      ...over,
    });
    await h.db.insert(attemptChecks).values(ac(1));
    expect(await pgError(h.db.insert(attemptChecks).values(ac(1)))).toMatch(/duplicate key/);
    expect(await pgError(h.db.insert(attemptChecks).values(ac(2, { status: 'late' })))).toMatch(
      /attempt_checks_status/,
    );
    expect(await pgError(h.db.insert(attemptChecks).values(ac(2, { report_hash: 'z' })))).toMatch(
      /attempt_checks_report_hash_fmt/,
    );
    expect(await pgError(h.db.insert(attemptChecks).values(ac(0)))).toMatch(
      /attempt_checks_attempt_no/,
    );
    await h.db.insert(attemptChecks).values(ac(2, { status: 'unavailable', sam_ms: null }));
    await h.db.insert(betChecks).values(row(betId));
    await h.db.delete(bets).where(eq(bets.id, betId));
    expect(await h.db.select().from(attemptChecks).where(eq(attemptChecks.bet_id, betId))).toEqual(
      [],
    );
    expect(await h.db.select().from(betChecks).where(eq(betChecks.bet_id, betId))).toEqual([]);
  });
});
