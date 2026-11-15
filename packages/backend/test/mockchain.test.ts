import { describe, expect, it } from 'vitest';
import {
  BET_STATE,
  CONSTANTS,
  PERCEPTION_TIMEOUT_S,
  termsHash,
  ZERO_HASH_HEX,
} from '@verdict/engine';
import { requireIdl } from '../src/chain/idl.js';
import {
  betAddress,
  cancelIx,
  createBetIx,
  endIx,
  fundIx,
  initProfileIx,
  refundIx,
  startIx,
  type IxEnv,
} from '../src/chain/ixs.js';
import { parseMessage } from '../src/chain/message.js';
import { MockChain, mockSlotHash } from '../src/chain/mock/index.js';
import { associatedTokenAddress, createAtaIdempotentIx, transferCheckedIx } from '../src/chain/programs.js';
import type { ChainEventEnvelope } from '../src/chain/types.js';
import { generateKeypair, type KeyPair } from '../src/crypto/keys.js';
import { ManualClock } from '../src/util/clock.js';
import { tempDir, hex32 } from './helpers.js';

const idl = requireIdl();

function setup(persistPath?: string) {
  const clock = new ManualClock(1_750_000_000_000);
  const feePayer = generateKeypair();
  const judges = [generateKeypair(), generateKeypair(), generateKeypair()] as const;
  const chain = new MockChain({
    idl,
    programId: idl.address,
    clock,
    feePayer,
    oracle: feePayer,
    extraSigners: [...judges],
    persistPath: persistPath ?? null,
  });
  const env: IxEnv = { programId: chain.programId, mint: chain.mint, feePayer: chain.feePayer, oracle: chain.oracle };
  return { clock, chain, env, feePayer, judges };
}

async function signAndSubmit(chain: MockChain, ixs: Parameters<MockChain['prepare']>[0], users: KeyPair[]) {
  const p = await chain.prepare(ixs);
  return chain.submit(
    p,
    users.map((u) => ({ pubkey: u.publicKey, signature: u.sign(p.message) })),
  );
}

describe('MockChain', () => {
  it('derives deterministic slot hashes', () => {
    const h = mockSlotHash(42n);
    expect(h).toHaveLength(32);
    expect(Buffer.from(h).toString('hex')).toBe(Buffer.from(mockSlotHash(42n)).toString('hex'));
  });

  it('runs create → fund → start → end → perception-timeout refund with real signatures and events', async () => {
    const { clock, chain, env, judges } = setup();
    const alice = generateKeypair();
    const bob = generateKeypair();
    const events: ChainEventEnvelope[] = [];
    chain.onEvents((e) => {
      events.push(...e);
    });

    await chain.faucet(alice.publicKey, 50_000_000n);
    await chain.faucet(bob.publicKey, 50_000_000n);
    expect(await chain.getUsdcBalance(alice.publicKey)).toBe(50_000_000n);

    // profiles
    const prof = await signAndSubmit(
      chain,
      [initProfileIx(env, alice.publicKey, { face_commit: ZERO_HASH_HEX, voice_commit: ZERO_HASH_HEX, display_name: 'Alice' })],
      [alice],
    );
    expect(prof.status).toBe('confirmed');
    expect((await chain.getProfile(alice.publicKey))?.display_name).toBe('Alice');

    // ai_judged bet (no calibration), stake $5 each
    const nonce = 7n;
    const judgeKeys = judges.map((j) => j.publicKey) as [string, string, string];
    const aah = hex32(0xab);
    const create = createBetIx(env, alice.publicKey, {
      nonce,
      participants: [alice.publicKey, bob.publicKey],
      stakes: [5_000_000n, 5_000_000n],
      side_b_mask: 0b10,
      stake_each: 5_000_000n,
      time_limit_s: 60,
      flags: 0x02,
      program_hash: hex32(0x11),
      acceptance_audio_hash: aah,
      judges: judgeKeys,
    });
    const bet = betAddress(env, alice.publicKey, nonce);

    // Missing the creator's signature ⇒ failed, nothing changes.
    const unsigned = await chain.submit(await chain.prepare([create]), []);
    expect(unsigned.status).toBe('failed');
    expect(await chain.getBet(bet)).toBeNull();

    // A wrong signature ⇒ SignatureVerificationFailed.
    const p = await chain.prepare([create]);
    const bad = await chain.submit(p, [{ pubkey: alice.publicKey, signature: bob.sign(p.message) }]);
    expect(bad).toMatchObject({ status: 'failed', error: 'SignatureVerificationFailed' });

    const created = await signAndSubmit(chain, [create], [alice]);
    expect(created.status).toBe('confirmed');
    expect((await chain.getBet(bet))?.state).toBe(BET_STATE.Proposed);

    const th = termsHash(chain.oracle, judgeKeys, aah);
    const fundArgs = { calibration_hash: ZERO_HASH_HEX, program_hash: hex32(0x11), terms_hash: th };
    const wrongTerms = await signAndSubmit(chain, [fundIx(env, bet, alice.publicKey, { ...fundArgs, terms_hash: hex32(1) })], [alice]);
    expect(wrongTerms).toMatchObject({ status: 'failed', error: 'ConsentMismatch' });

    expect((await signAndSubmit(chain, [fundIx(env, bet, alice.publicKey, fundArgs)], [alice])).status).toBe('confirmed');
    expect((await signAndSubmit(chain, [fundIx(env, bet, bob.publicKey, fundArgs)], [bob])).status).toBe('confirmed');
    expect((await chain.getBet(bet))?.state).toBe(BET_STATE.Funded);
    expect(await chain.getUsdcBalance(alice.publicKey)).toBe(45_000_000n);

    // start by the oracle with the newest slot hash as beacon, no witnesses
    clock.advance(2_000);
    const beacon = await chain.latestSlotHash();
    const started = await chain.sendAsBackend([startIx(env, bet, chain.oracle, { beacon_slot: beacon.slot, witnesses: [] })]);
    expect(started.status).toBe('confirmed');
    const live = await chain.getBet(bet);
    expect(live?.state).toBe(BET_STATE.Live);
    expect(live?.beacon_hash).toBe(beacon.hash);

    const ended = await chain.sendAsBackend([endIx(env, bet, chain.oracle, { seq: 1, heads: [] })]);
    expect(ended.status).toBe('confirmed');
    expect((await chain.getBet(bet))?.state).toBe(BET_STATE.Perceiving);

    // refund only after the perception timeout
    const early = await chain.sendAsBackend([refundIx(env, bet, [alice.publicKey, bob.publicKey])]);
    expect(early.status).toBe('failed');
    clock.advance((PERCEPTION_TIMEOUT_S + 1) * 1000);
    const refunded = await chain.sendAsBackend([refundIx(env, bet, [alice.publicKey, bob.publicKey])]);
    expect(refunded.status).toBe('confirmed');
    const final = await chain.getBet(bet);
    expect(final?.state).toBe(BET_STATE.Refunded);
    expect(await chain.getUsdcBalance(alice.publicKey)).toBe(50_000_000n);
    expect(await chain.getUsdcBalance(bob.publicKey)).toBe(50_000_000n);
    expect(chain.tokenAccountExists(associatedTokenAddress(bet, chain.mint))).toBe(false);

    await chain.flushEvents();
    const names = events.map((e) => e.event.name);
    expect(names).toEqual([
      'ProfileUpdated',
      'BetCreated',
      'Funded',
      'Funded',
      'BetStarted',
      'EvidenceCommitted',
      'BetEnded',
      'Refunded',
    ]);
    expect(CONSTANTS).toBeDefined();
  });

  it('rejects expired blockhashes (TX_EXPIRED) and fails atomically on insufficient funds', async () => {
    const { clock, chain, env, judges } = setup();
    const alice = generateKeypair();
    const bob = generateKeypair();
    await chain.faucet(alice.publicKey, 1_000_000n);

    const p = await chain.prepare([createAtaIdempotentIx(chain.feePayer, bob.publicKey, chain.mint)]);
    clock.advance(200 * 400);
    const late = await chain.submit(p, []);
    expect(late).toMatchObject({ status: 'failed', code: 'TX_EXPIRED' });

    // ATA create + over-spending transfer in one tx: the ATA must not survive.
    const r = await signAndSubmit(
      chain,
      [
        createAtaIdempotentIx(chain.feePayer, bob.publicKey, chain.mint),
        transferCheckedIx(
          associatedTokenAddress(alice.publicKey, chain.mint),
          chain.mint,
          associatedTokenAddress(bob.publicKey, chain.mint),
          alice.publicKey,
          2_000_000n,
        ),
      ],
      [alice],
    );
    expect(r).toMatchObject({ status: 'failed', code: 'INSUFFICIENT_FUNDS' });
    expect(chain.tokenAccountExists(associatedTokenAddress(bob.publicKey, chain.mint))).toBe(false);

    // cancel path (Proposed only) refunds funded stakes
    const judgeKeys = judges.map((j) => j.publicKey) as [string, string, string];
    await chain.faucet(bob.publicKey, 1_000_000n);
    const create = createBetIx(env, alice.publicKey, {
      nonce: 1n,
      participants: [alice.publicKey, bob.publicKey],
      stakes: [100_000n, 100_000n],
      side_b_mask: 2,
      stake_each: 100_000n,
      time_limit_s: 60,
      flags: 0x02,
      program_hash: hex32(3),
      acceptance_audio_hash: hex32(4),
      judges: judgeKeys,
    });
    expect((await signAndSubmit(chain, [create], [alice])).status).toBe('confirmed');
    const bet = betAddress(env, alice.publicKey, 1n);
    const th = termsHash(chain.oracle, judgeKeys, hex32(4));
    await signAndSubmit(chain, [fundIx(env, bet, alice.publicKey, { calibration_hash: ZERO_HASH_HEX, program_hash: hex32(3), terms_hash: th })], [alice]);
    expect(await chain.getUsdcBalance(alice.publicKey)).toBe(900_000n);
    const c = await signAndSubmit(chain, [cancelIx(env, bet, alice.publicKey, [alice.publicKey, bob.publicKey])], [alice]);
    expect(c.status).toBe('confirmed');
    expect(await chain.getUsdcBalance(alice.publicKey)).toBe(1_000_000n);
    expect((await chain.getBet(bet))?.state).toBe(BET_STATE.Refunded);
  });

  it('round-trips messages through the IDL (account names, remaining accounts)', async () => {
    const { chain, env } = setup();
    const a = generateKeypair().publicKey;
    const b = generateKeypair().publicKey;
    const bet = betAddress(env, a, 9n);
    const p = await chain.prepare([refundIx(env, bet, [a, b])]);
    const parsed = parseMessage(p.message, idl, chain.programId);
    const v = parsed.instructions[0]!.verdict!;
    expect(v.decoded.name).toBe('refund');
    expect(v.accounts['bet']).toBe(bet);
    expect(v.accounts['oracle']).toBe(chain.oracle);
    expect(v.remaining).toEqual([associatedTokenAddress(a, chain.mint), associatedTokenAddress(b, chain.mint)]);
    expect(p.signers).toEqual([chain.feePayer]);
  });

  it('persists and restores the ledger', async () => {
    const [dir, cleanup] = tempDir();
    try {
      const path = `${dir}/mockchain.json`;
      const s1 = setup(path);
      const u = generateKeypair();
      await s1.chain.faucet(u.publicKey, 123_000n);
      const s2 = new MockChain({
        idl,
        programId: idl.address,
        clock: s1.clock,
        feePayer: s1.feePayer,
        oracle: s1.feePayer,
        persistPath: path,
      });
      expect(await s2.getUsdcBalance(u.publicKey)).toBe(123_000n);
    } finally {
      cleanup();
    }
  });
});
