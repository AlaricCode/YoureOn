// Migration 0008 (appeals, appeal_votes, rulings.appeal_id -> appeals) against Postgres; skips
// without DATABASE_URL. Checks the CHECKs and UNIQUEs the appeal panel relies on (DATA-MODEL
// §5.15, SCHEMAS §7) and that a bet delete (demo reset) cascades through the appeal <-> ruling
// FK pair in one statement.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { appeals, appealVotes, bets, createDb, rulings, users, type DbHandle } from '../src/index';

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
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

d('migration 0008: appeals and appeal_votes', () => {
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

  /** A bet with one decisive camera ruling (what `resolve` committed). */
  async function betWithRuling() {
    const [bet] = await h.db
      .insert(bets)
      .values({ party_a_id: a, party_b_id: b, mint: MINT, evidence_source: 'camera' })
      .returning();
    const record = JSON.stringify({ id: randomUUID() });
    const [r] = await h.db
      .insert(rulings)
      .values({
        bet_id: bet!.id,
        stage: 'settlement',
        model: 'rule/test@1',
        outcome: 'B_WINS',
        claim_result: 'MET',
        confidence: '0.93',
        evidence_kind: 'camera',
        evidence_hash: sha(randomUUID()),
        record_canonical: record,
        ruling_hash: sha(record),
      })
      .returning();
    return { bet: bet!, ruling: r! };
  }

  const vote = (appealId: string, over: Partial<typeof appealVotes.$inferInsert> = {}) => ({
    appeal_id: appealId,
    seat: 0,
    provider: 'anthropic' as const,
    model: 'anthropic/claude-opus-5-5',
    status: 'ok' as const,
    outcome: 'A_WINS' as const,
    counted_as: 'A_WINS' as const,
    confidence: '0.82',
    reason: 'Lands on its cap in frame 6.',
    output_sha256: sha('{}'),
    latency_ms: 2400,
    ...over,
  });

  it('one appeal per bet; the original outcome is Appealable (never REDO)', async () => {
    const { bet, ruling } = await betWithRuling();
    const row = {
      bet_id: bet.id,
      appellant_user_id: a,
      appellant_party: 'A' as const,
      appealed_ruling_id: ruling.id,
      original_outcome: 'B_WINS' as const,
    };
    const [ap] = await h.db.insert(appeals).values(row).returning();
    expect(ap).toMatchObject({ status: 'filing', final_outcome: null, flipped: null });
    expect(await pgError(h.db.insert(appeals).values(row))).toMatch(/appeals_bet_uq/);
    const other = await betWithRuling();
    expect(
      await pgError(
        h.db.insert(appeals).values({
          ...row,
          bet_id: other.bet.id,
          appealed_ruling_id: other.ruling.id,
          original_outcome: 'REDO',
        }),
      ),
    ).toMatch(/appeals_original_outcome/);
  });

  it('decided needs the whole result (final outcome, decided_by, flipped, the result ruling)', async () => {
    const { bet, ruling } = await betWithRuling();
    const [ap] = await h.db
      .insert(appeals)
      .values({
        bet_id: bet.id,
        appellant_user_id: a,
        appellant_party: 'A',
        appealed_ruling_id: ruling.id,
        original_outcome: 'B_WINS',
      })
      .returning();
    const set = (v: Partial<typeof appeals.$inferInsert>) =>
      h.db.update(appeals).set(v).where(eq(appeals.id, ap!.id));
    expect(await pgError(set({ status: 'decided' }))).toMatch(/appeals_decided/);
    const record = JSON.stringify({ appeal: ap!.id });
    const [res] = await h.db
      .insert(rulings)
      .values({
        bet_id: bet.id,
        stage: 'appeal',
        appeal_id: ap!.id,
        model: 'panel/majority-of-3',
        outcome: 'A_WINS',
        evidence_kind: 'camera',
        evidence_hash: ruling.evidence_hash,
        record_canonical: record,
        ruling_hash: sha(record),
      })
      .returning();
    const done = {
      status: 'decided' as const,
      decided_at: new Date(),
      final_outcome: 'A_WINS' as const,
      decided_by: 'majority' as const,
      result_ruling_id: res!.id,
    };
    // flipped must agree with final vs original
    expect(await pgError(set({ ...done, flipped: false }))).toMatch(/appeals_flipped/);
    const [ok] = await h.db
      .update(appeals)
      .set({ ...done, flipped: true })
      .where(eq(appeals.id, ap!.id))
      .returning();
    expect(ok).toMatchObject({ status: 'decided', final_outcome: 'A_WINS', flipped: true });
    // an appeal ruling must name its appeal (rulings_appeal_stage), and only an existing one (FK)
    expect(
      await pgError(
        h.db.insert(rulings).values({
          bet_id: bet.id,
          stage: 'appeal',
          appeal_id: randomUUID(),
          model: 'panel/majority-of-3',
          outcome: 'A_WINS',
          evidence_kind: 'camera',
          evidence_hash: ruling.evidence_hash,
          record_canonical: '{"x":1}',
          ruling_hash: sha('{"x":1}'),
        }),
      ),
    ).toMatch(/rulings_appeal_id_appeals_id_fk/);
  });

  it('votes: one per seat and per provider; a failed seat is REDO / 0 / "" / ABSTAIN', async () => {
    const { bet, ruling } = await betWithRuling();
    const [ap] = await h.db
      .insert(appeals)
      .values({
        bet_id: bet.id,
        appellant_user_id: a,
        appellant_party: 'A',
        appealed_ruling_id: ruling.id,
        original_outcome: 'B_WINS',
      })
      .returning();
    await h.db.insert(appealVotes).values(vote(ap!.id));
    expect(
      await pgError(h.db.insert(appealVotes).values(vote(ap!.id, { provider: 'openai' }))),
    ).toMatch(/appeal_votes_seat_uq/);
    expect(await pgError(h.db.insert(appealVotes).values(vote(ap!.id, { seat: 1 })))).toMatch(
      /appeal_votes_provider_uq/,
    );
    expect(
      await pgError(h.db.insert(appealVotes).values(vote(ap!.id, { seat: 3, provider: 'google' }))),
    ).toMatch(/appeal_votes_seat/);
    expect(
      await pgError(
        h.db
          .insert(appealVotes)
          .values(vote(ap!.id, { seat: 1, provider: 'openai', outcome: 'VOID' })),
      ),
    ).toMatch(/appeal_votes_outcome/);
    // a timeout that still claims a side is refused
    expect(
      await pgError(
        h.db
          .insert(appealVotes)
          .values(vote(ap!.id, { seat: 1, provider: 'openai', status: 'timeout' })),
      ),
    ).toMatch(/appeal_votes_failed/);
    await h.db.insert(appealVotes).values(
      vote(ap!.id, {
        seat: 1,
        provider: 'openai',
        status: 'timeout',
        outcome: 'REDO',
        counted_as: 'ABSTAIN',
        confidence: '0',
        reason: '',
        output_sha256: sha(''),
      }),
    );
    const rows = await h.db.select().from(appealVotes).where(eq(appealVotes.appeal_id, ap!.id));
    expect(rows.map((r) => [r.seat, r.counted_as]).sort()).toEqual([
      [0, 'A_WINS'],
      [1, 'ABSTAIN'],
    ]);
  });

  it('a bet delete (demo reset) cascades through appeals, votes and the appeal ruling', async () => {
    const { bet, ruling } = await betWithRuling();
    const [ap] = await h.db
      .insert(appeals)
      .values({
        bet_id: bet.id,
        appellant_user_id: a,
        appellant_party: 'A',
        appealed_ruling_id: ruling.id,
        original_outcome: 'B_WINS',
      })
      .returning();
    await h.db.insert(appealVotes).values(vote(ap!.id));
    const record = JSON.stringify({ appeal: ap!.id, n: 2 });
    const [res] = await h.db
      .insert(rulings)
      .values({
        bet_id: bet.id,
        stage: 'appeal',
        appeal_id: ap!.id,
        model: 'panel/majority-of-3',
        outcome: 'B_WINS',
        evidence_kind: 'camera',
        evidence_hash: ruling.evidence_hash,
        record_canonical: record,
        ruling_hash: sha(record),
      })
      .returning();
    await h.db
      .update(appeals)
      .set({
        status: 'decided',
        decided_at: new Date(),
        final_outcome: 'B_WINS',
        decided_by: 'upheld_no_majority',
        flipped: false,
        result_ruling_id: res!.id,
      })
      .where(eq(appeals.id, ap!.id));
    await h.db.delete(bets).where(eq(bets.id, bet.id));
    expect(await h.db.select().from(appeals).where(eq(appeals.id, ap!.id))).toEqual([]);
    expect(await h.db.select().from(appealVotes).where(eq(appealVotes.appeal_id, ap!.id))).toEqual(
      [],
    );
    expect(await h.db.select().from(rulings).where(eq(rulings.bet_id, bet.id))).toEqual([]);
  });
});
