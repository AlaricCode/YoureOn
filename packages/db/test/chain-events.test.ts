// Migration 0003 chain_events (DATA-MODEL §5.9) against Postgres; skips without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { betEvents, bets, chainEvents, createDb, users, type DbHandle } from '../src/index';

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (n: number) => Array.from(randomBytes(n), (b) => B58[b % B58.length]).join('');
const ESCROW = 'BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp';

async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return err.cause?.message ?? err.message ?? String(e);
  }
  throw new Error('expected the query to fail');
}

d(`chain_events (migration 0003) on ${URL ? 'DATABASE_URL' : '(skipped)'}`, () => {
  let h: DbHandle;
  beforeAll(() => {
    h = createDb({ url: URL! });
  });
  afterAll(async () => {
    await h?.close();
  });

  const row = (over: Partial<typeof chainEvents.$inferInsert> = {}) => ({
    signature: b58(88),
    outer_ix: 2,
    inner_ix: 0,
    program_id: ESCROW,
    event_name: 'BetResolved',
    payload: { outcome: 'PartyB' },
    ...over,
  });

  it('defaults: source stream, commitment confirmed, slot NULL, received_at now()', async () => {
    const [r] = await h.db.insert(chainEvents).values(row()).returning();
    expect(r).toMatchObject({
      source: 'stream',
      commitment: 'confirmed',
      slot: null,
      applied_at: null,
    });
    expect(r!.received_at).toBeInstanceOf(Date);
    expect(typeof r!.id).toBe('bigint');
  });

  it('UNIQUE (signature, outer_ix, inner_ix) is the dedup key; ON CONFLICT DO NOTHING returns nothing', async () => {
    const r = row();
    await h.db.insert(chainEvents).values(r);
    expect(await pgError(h.db.insert(chainEvents).values(r))).toMatch(/chain_events_dedupe_uq/);
    const again = await h.db
      .insert(chainEvents)
      .values(r)
      .onConflictDoNothing({
        target: [chainEvents.signature, chainEvents.outer_ix, chainEvents.inner_ix],
      })
      .returning({ id: chainEvents.id });
    expect(again).toEqual([]);
    // a different inner_ix of the same tx is a different event
    await h.db.insert(chainEvents).values({ ...r, inner_ix: 1 });
  });

  it('CHECKs: signature / program_id format, commitment, non-negative indices', async () => {
    expect(await pgError(h.db.insert(chainEvents).values(row({ signature: 'nope' })))).toMatch(
      /chain_events_signature_fmt/,
    );
    expect(await pgError(h.db.insert(chainEvents).values(row({ program_id: '0x' })))).toMatch(
      /chain_events_program_id_fmt/,
    );
    expect(
      await pgError(h.db.insert(chainEvents).values(row({ commitment: 'processed' }))),
    ).toMatch(/chain_events_commitment/);
    expect(await pgError(h.db.insert(chainEvents).values(row({ outer_ix: -1 })))).toMatch(
      /chain_events_ix_nonneg/,
    );
  });

  it('bet_id has no FK (orphans allowed); bet_events.chain_event_id now references chain_events', async () => {
    await h.db.insert(chainEvents).values(row({ bet_id: '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f' }));
    const mk = async () =>
      (
        await h.db
          .insert(users)
          .values({
            display_name: 'T',
            wallet_pubkey: b58(44),
            age_attested_18plus: true,
            attested_at: new Date(),
          })
          .returning()
      )[0]!;
    const [a, b] = [await mk(), await mk()];
    const [bet] = await h.db
      .insert(bets)
      .values({ party_a_id: a.id, party_b_id: b.id, mint: ESCROW })
      .returning();
    const envelope = { type: 'chain.BetResolved' };
    expect(
      await pgError(
        h.db.insert(betEvents).values({
          bet_id: bet!.id,
          seq: 1,
          type: 'chain.BetResolved',
          source: 'chain',
          envelope,
          chain_event_id: 999_999_999n,
        }),
      ),
    ).toMatch(/bet_events_chain_event_id_chain_events_id_fk/);
    const [ce] = await h.db.insert(chainEvents).values(row()).returning();
    await h.db.insert(betEvents).values({
      bet_id: bet!.id,
      seq: 1,
      type: 'chain.BetResolved',
      source: 'chain',
      envelope,
      chain_event_id: ce!.id,
    });
  });
});
