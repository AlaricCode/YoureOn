// Migration 0000/0001 against Postgres (skips without DATABASE_URL), plus the DATA-MODEL §4
// enum-parity test (no DB needed).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  BetState,
  OnchainStatus,
  OnchainOutcome,
  Party,
  RulingOutcome,
  VoidReason,
  RedoReason,
  ClaimResult,
  TxKind,
  LockMode,
  AuthorizationMethod,
  HearingTrigger,
  PanelProvider,
  GeminiMarketStatus,
  Instruction,
} from '@youre-on/shared';
import { ChallengeMethod, RoomKind } from '@youre-on/shared/api';
import {
  auditLog,
  authorizationMethod,
  betState,
  bets,
  chainIx,
  challengeMethod,
  claimResult,
  createDb,
  hearingTrigger,
  lockMode,
  marketStatus,
  onchainOutcome,
  onchainStatus,
  panelProvider,
  party,
  redoReason,
  roomKind,
  rulingOutcome,
  rulingVoidReason,
  txKind,
  users,
  type DbHandle,
} from '../src/index';

/** The Postgres error message behind Drizzle's "Failed query" wrapper. */
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return err.cause?.message ?? err.message ?? String(e);
  }
  throw new Error('expected the query to fail');
}

const toPg = (v: string) => v.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

describe('pg enums equal the shared Zod enums (DATA-MODEL §4, SCHEMAS §0.3)', () => {
  it('offchain enums verbatim, onchain via toPg, in the same order', () => {
    expect(betState.enumValues).toEqual(BetState.options);
    expect(onchainStatus.enumValues).toEqual(['none', ...OnchainStatus.options.map(toPg)]);
    expect(onchainOutcome.enumValues).toEqual(OnchainOutcome.options.map(toPg));
    expect(party.enumValues).toEqual(Party.options);
    expect(rulingOutcome.enumValues).toEqual(RulingOutcome.options);
    expect(rulingVoidReason.enumValues).toEqual(VoidReason.options);
    expect(redoReason.enumValues).toEqual(RedoReason.options);
    expect(claimResult.enumValues).toEqual(ClaimResult.options);
    expect(txKind.enumValues).toEqual(TxKind.options);
    expect(lockMode.enumValues).toEqual(LockMode.options);
    expect(authorizationMethod.enumValues).toEqual(AuthorizationMethod.options);
    expect(hearingTrigger.enumValues).toEqual(HearingTrigger.options);
    expect(panelProvider.enumValues).toEqual(PanelProvider.options);
    expect(marketStatus.enumValues).toEqual(GeminiMarketStatus.options);
    expect(chainIx.enumValues).toEqual(Instruction.options);
    expect(roomKind.enumValues).toEqual(RoomKind.options);
    expect(challengeMethod.enumValues).toEqual(ChallengeMethod.options);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
// A syntactically valid base58 32-byte-ish key for CHECKs (the DB checks format only).
const fakeKey = () => {
  const a = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  return Array.from(randomBytes(44), (b) => a[b % a.length]).join('');
};

d(`migrations applied to ${URL ? 'DATABASE_URL' : '(skipped: DATABASE_URL unset)'}`, () => {
  let h: DbHandle;
  beforeAll(() => {
    h = createDb({ url: URL! });
  });
  afterAll(async () => {
    await h?.close();
  });

  const mkUser = async (attested = true) => {
    const [u] = await h.db
      .insert(users)
      .values({
        display_name: 'T',
        wallet_pubkey: fakeKey(),
        age_attested_18plus: attested,
        attested_at: attested ? new Date() : null,
      })
      .returning();
    return u!;
  };

  it('has the 0001 tables and the database runs in UTC', async () => {
    const rows = await h.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`;
    expect(rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining([
        'api_sessions',
        'audit_log',
        'bet_events',
        'bets',
        'devices',
        'room_members',
        'rooms',
        'users',
      ]),
    );
    const [tz] = await h.sql<{ TimeZone: string }[]>`SHOW timezone`;
    expect(tz!.TimeZone).toBe('UTC');
  });

  it('bets_parties_attested: both parties must be attested 18+', async () => {
    const a = await mkUser();
    const b = await mkUser(false);
    expect(
      await pgError(h.db.insert(bets).values({ party_a_id: a.id, party_b_id: b.id, mint: MINT })),
    ).toMatch(/attested 18\+/);
    const b2 = await mkUser();
    const [bet] = await h.db
      .insert(bets)
      .values({ party_a_id: a.id, party_b_id: b2.id, mint: MINT })
      .returning();
    expect(bet).toMatchObject({
      state: 'DRAFTING',
      onchain_status: 'none',
      version: 0,
      last_seq: 0,
    });
  });

  it('bets_guard: bumps version, rejects onchain_status going backwards', async () => {
    const a = await mkUser();
    const b = await mkUser();
    const [bet] = await h.db
      .insert(bets)
      .values({ party_a_id: a.id, party_b_id: b.id, mint: MINT })
      .returning();
    const [up] = await h.db
      .update(bets)
      .set({ title: 'Bottle flip' })
      .where(eq(bets.id, bet!.id))
      .returning();
    expect(up!.version).toBe(1);
    // CHECK bets_onchain_binding: 'locked' needs terms_hash + stakes.
    expect(
      await pgError(h.db.update(bets).set({ onchain_status: 'open' }).where(eq(bets.id, bet!.id))),
    ).toMatch(/bets_onchain_binding/);
    await h.db
      .update(bets)
      .set({
        onchain_status: 'open',
        terms_hash: 'a'.repeat(64),
        stake_a: 5_000_000n,
        stake_b: 5_000_000n,
        party_a_wallet: a.wallet_pubkey,
      })
      .where(eq(bets.id, bet!.id));
    expect(
      await pgError(h.db.update(bets).set({ onchain_status: 'none' }).where(eq(bets.id, bet!.id))),
    ).toMatch(/onchain_status open -> none rejected/);
  });

  it('CHECKs: distinct parties, stake cap, end_reason pairing, hex/pubkey formats', async () => {
    const a = await mkUser();
    const b = await mkUser();
    const ins = (v: Partial<typeof bets.$inferInsert>) =>
      pgError(h.db.insert(bets).values({ party_a_id: a.id, party_b_id: b.id, mint: MINT, ...v }));
    expect(await ins({ party_b_id: a.id })).toMatch(/attested 18\+/); // trigger fires first (count = 1)
    expect(await ins({ party_b_id: a.id, is_seed: true })).toMatch(/bets_distinct_parties/);
    expect(await ins({ stake_a: 20_000_001n })).toMatch(/bets_stake_a_cap/);
    expect(await ins({ state: 'CANCELLED' })).toMatch(/bets_end_reason/);
    expect(await ins({ mint: 'not base58!' })).toMatch(/bets_mint_fmt/);
    expect(await ins({ terms_hash: 'ABC' })).toMatch(/bets_terms_hash_fmt/);
  });

  it('audit_log is append-only and refuses biometric keys', async () => {
    const [row] = await h.db
      .insert(auditLog)
      .values({ actor_kind: 'system', action: 'test.ok', details: { a: 1 } })
      .returning();
    expect(
      await pgError(h.db.update(auditLog).set({ action: 'x' }).where(eq(auditLog.id, row!.id))),
    ).toMatch(/append-only/);
    expect(await pgError(h.db.delete(auditLog).where(eq(auditLog.id, row!.id)))).toMatch(
      /append-only/,
    );
    expect(
      await pgError(
        h.db.insert(auditLog).values({
          actor_kind: 'system',
          action: 'face.enrolled',
          details: { embedding: [1, 2] },
        }),
      ),
    ).toMatch(/audit_log_no_biometrics/);
  });

  it('enum ordering works for < comparisons (bets_active_idx relies on it)', async () => {
    const [r] = await h.db.execute<{ ok: boolean }>(
      sql`SELECT 'RULED'::bet_state < 'PAID'::bet_state AS ok`,
    );
    expect(r!.ok).toBe(true);
  });

  it('uuid ids are v4 from gen_random_uuid()', async () => {
    const u = await mkUser();
    expect(u.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(randomUUID()).not.toBe(u.id);
  });

  const sig = () => {
    const a = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    return Array.from(randomBytes(88), (b) => a[b % a.length]).join('');
  };
  const bound = (a: { id: string }, b: { id: string }) => ({
    party_a_id: a.id,
    party_b_id: b.id,
    mint: MINT,
    terms_hash: 'b'.repeat(64),
    stake_a: 5_000_000n,
    stake_b: 5_000_000n,
    evidence_source: 'camera' as const,
  });

  it('bets_guard: binding fields are frozen from AWAITING_AUTHORIZATIONS on', async () => {
    const a = await mkUser();
    const b = await mkUser();
    const [bet] = await h.db
      .insert(bets)
      .values({ ...bound(a, b), state: 'AWAITING_AUTHORIZATIONS' })
      .returning();
    const upd = (v: Partial<typeof bets.$inferInsert>) =>
      h.db.update(bets).set(v).where(eq(bets.id, bet!.id));
    for (const v of [
      { stake_a: 6_000_000n },
      { terms_hash: 'c'.repeat(64) },
      { mint: fakeKey() },
      { evidence_source: 'gemini' as const },
    ]) {
      expect(await pgError(upd(v))).toMatch(/binding fields are immutable/);
    }
    await upd({ title: 'still editable' }); // non-binding columns stay writable
  });

  it('bets_guard: authorizations frozen once LOCKED; terminal states final except "chain wins"', async () => {
    const a = await mkUser();
    const b = await mkUser();
    const auth = {
      a_authorized_at: new Date(),
      a_authorization_method: 'faceid_hold' as const,
      b_authorized_at: new Date(),
      b_authorization_method: 'passcode_hold' as const,
    };
    // A bet marked CANCELLED (lock_failed) that the chain shows locked after all (§8.3).
    const [bet] = await h.db
      .insert(bets)
      .values({ ...bound(a, b), ...auth, state: 'CANCELLED', end_reason: 'lock_failed' })
      .returning();
    const upd = (v: Partial<typeof bets.$inferInsert>) =>
      h.db.update(bets).set(v).where(eq(bets.id, bet!.id));
    expect(await pgError(upd({ state: 'DRAFTING', end_reason: null }))).toMatch(
      /terminal state CANCELLED is final/,
    );
    await upd({
      state: 'LOCKED',
      end_reason: null,
      onchain_status: 'locked',
      party_a_wallet: a.wallet_pubkey,
      party_b_wallet: b.wallet_pubkey,
    });
    expect(await pgError(upd({ b_authorization_method: 'faceid_hold' }))).toMatch(
      /authorizations are frozen once locked/,
    );
    // Settlement must satisfy the payout rule (ESCROW §6 mirror): A wins => B gets 0.
    const settle = {
      state: 'PAID' as const,
      onchain_status: 'settled' as const,
      outcome: 'party_a' as const,
      payout_a: 10_000_000n,
      payout_sig: sig(),
    };
    expect(await pgError(upd({ ...settle, payout_b: 1n }))).toMatch(/bets_payout_rule/);
    expect(await pgError(upd({ ...settle, payout_b: 0n, payout_sig: null }))).toMatch(
      /bets_terminal_sig/,
    );
    await upd({ ...settle, payout_b: 0n });
    expect(await pgError(upd({ onchain_status: 'refunded' }))).toMatch(
      /onchain_status settled -> refunded rejected/,
    );
    expect(await pgError(upd({ state: 'VOIDED' }))).toMatch(/terminal state PAID is final/);
  });
});
