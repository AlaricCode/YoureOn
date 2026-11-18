// Migration 0004 (bet_terms_versions, chain_txs, nonce_pool) against Postgres; skips without
// DATABASE_URL. Checks the CHECKs the LockService relies on (DATA-MODEL §5.7, §5.8, §5.20).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  bets,
  betTermsVersions,
  chainTxs,
  createDb,
  noncePool,
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
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

d('migration 0004: chain lifecycle tables', () => {
  let h: DbHandle;
  let betId: string;
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
      )[0]!;
    const [a, b] = [await mk(), await mk()];
    const [bet] = await h.db
      .insert(bets)
      .values({ party_a_id: a.id, party_b_id: b.id, mint: MINT })
      .returning();
    betId = bet!.id;
  });
  afterAll(async () => {
    if (h)
      await h.sql`DELETE FROM nonce_pool WHERE authority = 'TestAuthority1111111111111111111111111111111'`;
    await h?.close();
  });

  it('bet_terms_versions: the DB re-checks sha256(canonical_json) and generates terms jsonb', async () => {
    const canonical = '{"a":1}';
    expect(
      await pgError(
        h.db.insert(betTermsVersions).values({
          bet_id: betId,
          version: 1,
          canonical_json: canonical,
          terms_hash: sha('{"a":2}'),
        }),
      ),
    ).toMatch(/bet_terms_versions_hash/);
    const [row] = await h.db
      .insert(betTermsVersions)
      .values({ bet_id: betId, version: 1, canonical_json: canonical, terms_hash: sha(canonical) })
      .returning();
    expect(row!.terms).toEqual({ a: 1 });
  });

  it('chain_txs: message sha CHECK, lock shape, never sent half-signed', async () => {
    const msg = randomBytes(200);
    const b64 = msg.toString('base64');
    const base = {
      bet_id: betId,
      kind: 'atomic_lock' as const,
      signer_role: 'both_parties',
      message_b64: b64,
      message_sha256: sha(msg),
      nonce_account: fakeKey(),
      nonce_value: fakeKey(),
      expires_at: new Date(Date.now() + 60_000),
      expected_status: 'locked' as const,
    };
    expect(
      await pgError(h.db.insert(chainTxs).values({ ...base, message_sha256: sha('x') })),
    ).toMatch(/chain_txs_message_sha/);
    expect(await pgError(h.db.insert(chainTxs).values({ ...base, expires_at: null }))).toMatch(
      /chain_txs_lock_shape/,
    );
    const [row] = await h.db.insert(chainTxs).values(base).returning();
    const sig = fakeKey(88);
    expect(
      await pgError(
        h.db
          .update(chainTxs)
          .set({ a_signature: sig, first_signer: 'A', status: 'sent' })
          .where(eq(chainTxs.id, row!.id)),
      ),
    ).toMatch(/chain_txs_lock_fully_signed/);
    expect(
      await pgError(
        h.db.update(chainTxs).set({ a_signature: sig }).where(eq(chainTxs.id, row!.id)),
      ),
    ).toMatch(/chain_txs_first_signer/);
    // One in-flight lock per bet.
    expect(
      await pgError(
        h.db.insert(chainTxs).values({ ...base, nonce_value: fakeKey(), nonce_account: fakeKey() }),
      ),
    ).toMatch(/chain_txs_inflight_uq/);
    await h.db.update(chainTxs).set({ status: 'failed' }).where(eq(chainTxs.id, row!.id));
  });

  it('nonce_pool: leased needs a bet and a tx; free needs a value', async () => {
    const authority = 'TestAuthority1111111111111111111111111111111';
    expect(
      await pgError(
        h.db
          .insert(noncePool)
          .values({ seed_index: 15, nonce_account: fakeKey(), authority, status: 'free' }),
      ),
    ).toMatch(/nonce_pool_free_value/);
    expect(
      await pgError(
        h.db.insert(noncePool).values({
          seed_index: 15,
          nonce_account: fakeKey(),
          authority,
          status: 'leased',
          nonce_value: fakeKey(),
        }),
      ),
    ).toMatch(/nonce_pool_leased/);
    expect(
      await pgError(
        h.db.insert(noncePool).values({
          seed_index: 16,
          nonce_account: fakeKey(),
          authority,
          nonce_value: fakeKey(),
        }),
      ),
    ).toMatch(/nonce_pool_seed_range/);
  });
});
