// Migration 0007 (gemini_markets, market_snapshots, bets.gemini_market_id, the settlement ruling
// index) against Postgres; skips without DATABASE_URL. Checks the CHECKs the Gemini closer
// relies on (DATA-MODEL §5.16, §6.2 bets_gemini_market).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  bets,
  createDb,
  geminiMarkets,
  marketSnapshots,
  rulings,
  users,
  type DbHandle,
} from '../src/index';

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

d('migration 0007: gemini markets', () => {
  let h: DbHandle;
  let a: string;
  let b: string;
  const symbol = () => `GEMI-BTC05M${randomBytes(5).toString('hex')}-UP`;
  const mkMarket = async (over: Partial<typeof geminiMarkets.$inferInsert> = {}) => {
    const sym = over.instrument_symbol ?? symbol();
    const [m] = await h.db
      .insert(geminiMarkets)
      .values({
        event_ticker: sym.slice(5, -3),
        instrument_symbol: sym,
        expires_at: new Date('2026-11-18T02:40:00.000Z'),
        ...over,
      })
      .returning();
    return m!;
  };

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

  it('gemini_markets: one row per instrument; the settlement body is hash-checked', async () => {
    const m = await mkMarket({ strike: '64389.6', series: 'BTC05M', contract_ticker: 'UP' });
    expect(m).toMatchObject({ status: 'active', strike: '64389.60000000' });
    expect(await pgError(mkMarket({ instrument_symbol: m.instrument_symbol }))).toMatch(
      /gemini_markets_symbol_uq/,
    );
    const raw = '{"ticker":"BTC05M2611180240","status":"settled"}';
    // the raw body without its hash, and a hash that is not the body's, are both refused
    expect(
      await pgError(
        h.db.update(geminiMarkets).set({ settlement_raw: raw }).where(eq(geminiMarkets.id, m.id)),
      ),
    ).toMatch(/gemini_markets_settlement_pair/);
    expect(
      await pgError(
        h.db
          .update(geminiMarkets)
          .set({ settlement_raw: raw, settlement_response_sha256: sha('other') })
          .where(eq(geminiMarkets.id, m.id)),
      ),
    ).toMatch(/gemini_markets_settlement_hash/);
    // a resolution side only on a settled contract
    expect(
      await pgError(
        h.db.update(geminiMarkets).set({ resolution_side: 'no' }).where(eq(geminiMarkets.id, m.id)),
      ),
    ).toMatch(/gemini_markets_resolution/);
    const [settled] = await h.db
      .update(geminiMarkets)
      .set({
        status: 'settled',
        resolution_side: 'no',
        settlement_value: '64367.38366666667',
        settlement_raw: raw,
        settlement_response_sha256: sha(raw),
      })
      .where(eq(geminiMarkets.id, m.id))
      .returning();
    expect(settled!.settlement_value).toBe('64367.38366666667');
  });

  it('market_snapshots: the canonical snapshot must hash to snapshot_sha256', async () => {
    const m = await mkMarket();
    const canonical = '{"bestAsk":"0.69","bestBid":"0.56"}';
    const [s] = await h.db
      .insert(marketSnapshots)
      .values({
        market_id: m.id,
        source: 'rest_event',
        best_bid: '0.56',
        best_ask: '0.69',
        snapshot_canonical: canonical,
        snapshot_sha256: sha(canonical),
      })
      .returning();
    expect(typeof s!.id).toBe('bigint');
    expect(
      await pgError(
        h.db.insert(marketSnapshots).values({
          market_id: m.id,
          source: 'rest_event',
          snapshot_canonical: canonical,
          snapshot_sha256: sha('x'),
        }),
      ),
    ).toMatch(/market_snapshots_hash/);
    expect(
      await pgError(
        h.db.insert(marketSnapshots).values({ market_id: m.id, source: 'carrier_pigeon' }),
      ),
    ).toMatch(/market_snapshots_source/);
  });

  it('bets_gemini_market: a gemini bet needs its contract and a position, never a split', async () => {
    const m = await mkMarket();
    const ins = (v: Partial<typeof bets.$inferInsert>) =>
      h.db
        .insert(bets)
        .values({ party_a_id: a, party_b_id: b, mint: MINT, ...v })
        .returning();
    expect(await pgError(ins({ evidence_source: 'gemini' }))).toMatch(/bets_gemini_market/);
    expect(await pgError(ins({ evidence_source: 'gemini', gemini_market_id: m.id }))).toMatch(
      /bets_gemini_market/,
    );
    const [bet] = await ins({
      evidence_source: 'gemini',
      gemini_market_id: m.id,
      a_position: 'yes',
    });
    expect(bet!.gemini_market_id).toBe(m.id);
    expect(
      await pgError(h.db.update(bets).set({ outcome: 'split' }).where(eq(bets.id, bet!.id))),
    ).toMatch(/bets_gemini_market/);
    // camera bets are unaffected
    const [cam] = await ins({ evidence_source: 'camera' });
    expect(cam!.gemini_market_id).toBeNull();
  });

  it('rulings_settlement_uq: one settlement ruling per bet', async () => {
    const m = await mkMarket();
    const [bet] = await h.db
      .insert(bets)
      .values({
        party_a_id: a,
        party_b_id: b,
        mint: MINT,
        evidence_source: 'gemini',
        gemini_market_id: m.id,
        a_position: 'yes',
      })
      .returning();
    const row = () => {
      const record = JSON.stringify({ id: randomUUID() });
      const evidence = JSON.stringify({ kind: 'gemini_settlement', n: randomUUID() });
      return {
        bet_id: bet!.id,
        stage: 'settlement' as const,
        model: 'rule/gemini-settlement@1',
        outcome: 'A_WINS' as const,
        claim_result: 'MET' as const,
        confidence: '1.00',
        reason: 'Gemini settled UP.',
        evidence_kind: 'gemini' as const,
        evidence_hash: sha(evidence),
        evidence_canonical: evidence,
        record_canonical: record,
        ruling_hash: sha(record),
      };
    };
    await h.db.insert(rulings).values(row());
    expect(await pgError(h.db.insert(rulings).values(row()))).toMatch(/rulings_settlement_uq/);
  });
});
