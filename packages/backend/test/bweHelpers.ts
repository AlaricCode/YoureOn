/**
 * Test helpers for the booth / world / events suites: drive real bets
 * through the mock chain (engine chainModel) with real signatures.
 */
import {
  BET_FLAG_AI_JUDGED,
  ZERO_HASH_HEX,
  buildPayload,
  chainGenesis,
  chunkHash,
  encodeProgram,
  encodeTrackBin,
  hexToBytes,
  parseYaml,
  programHash,
  termsHash,
  type BetAccount,
  type Program,
} from '@verdict/engine';
import { createHash } from 'node:crypto';
import type { AppContext } from '../src/context.js';
import { createBetIx, endIx, fundIx, postTracksIx, runRulesIx, startIx, type IxEnv } from '../src/chain/ixs.js';
import { setComputeUnitLimitIx } from '../src/chain/programs.js';
import type { ChainIx, SendResult } from '../src/chain/types.js';
import type { KeyPair } from '../src/crypto/keys.js';
import { generateKeypair } from '../src/crypto/keys.js';
import { COLLECTIONS } from '../src/persistence/records.js';
import { toHex } from '../src/util/bytes.js';
import { silentWav } from '../src/util/wav.js';

export const AI_JUDGED_YAML = `version: 2
kind: ai_judged
question: "Does Sam finish the hot sauce wing without drinking anything?"
outcome: side(B) wins iff yes; else side(A)
stake_each: 3_000_000
time_limit_s: 120
`;

export function ixEnv(ctx: AppContext): IxEnv {
  return { programId: ctx.chain.programId, mint: ctx.chain.mint, feePayer: ctx.chain.feePayer, oracle: ctx.chain.oracle };
}

export async function userSend(ctx: AppContext, ixs: ChainIx[], users: KeyPair[]): Promise<SendResult> {
  const p = await ctx.chain.prepare(ixs);
  return ctx.chain.submit(
    p,
    users.map((u) => ({ pubkey: u.publicKey, signature: u.sign(p.message) })),
  );
}

export function ok(r: SendResult): Extract<SendResult, { status: 'confirmed' }> {
  if (r.status !== 'confirmed') throw new Error(`tx failed: ${r.error}`);
  return r;
}

export function compileAiJudged(creator: string, other: string): Program {
  const r = parseYaml(AI_JUDGED_YAML, {
    creator,
    huddle: [
      { wallet: creator, display_name: 'Alex', enrolled: true },
      { wallet: other, display_name: 'Maya', enrolled: true },
    ],
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.program;
}

export interface WitnessSetup {
  key: KeyPair;
  kind: 0 | 1;
  label: string;
  format: 'mjpeg' | 'wav';
  chunks: number;
  user_id: string;
}

const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());

/** MJPEG body: `u32 len ‖ u32 t ‖ jpeg` at 10 fps (fake JPEG bytes). */
export function fakeMjpeg(startMs: number, durationMs: number): Uint8Array {
  const parts: Buffer[] = [];
  for (let t = startMs; t < startMs + durationMs; t += 100) {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, t & 0xff, (t >> 8) & 0xff, 0xff, 0xd9]);
    const h = Buffer.alloc(8);
    h.writeUInt32LE(jpeg.length, 0);
    h.writeUInt32LE(t, 4);
    parts.push(h, jpeg);
  }
  return new Uint8Array(Buffer.concat(parts));
}

/**
 * ai_judged bet → create, fund, start (witnesses), upload chunk chains,
 * end with heads, post_tracks, run_rules ⇒ Disputed (reason 11).
 */
export async function disputedAiJudgedBet(
  ctx: AppContext,
  alice: KeyPair,
  bob: KeyPair,
  witnesses: Omit<WitnessSetup, 'key'>[] = [],
): Promise<{ bet: string; program: Program; witnessKeys: KeyPair[]; account: BetAccount }> {
  const env = ixEnv(ctx);
  await ctx.chain.faucet(alice.publicKey, 50_000_000n);
  await ctx.chain.faucet(bob.publicKey, 50_000_000n);
  const program = compileAiJudged(alice.publicKey, bob.publicKey);
  const ph = programHash(program);
  const judges = ctx.config.keys.judges.map((k) => k.publicKey) as [string, string, string];
  const create = createBetIx(env, alice.publicKey, {
    nonce: 7n,
    participants: [alice.publicKey, bob.publicKey],
    stakes: [3_000_000n, 3_000_000n],
    side_b_mask: 0b10,
    stake_each: 3_000_000n,
    time_limit_s: 120,
    flags: BET_FLAG_AI_JUDGED,
    program_hash: ph,
    acceptance_audio_hash: ZERO_HASH_HEX,
    judges,
  });
  const bet = create.accounts.bet!;
  ok(await userSend(ctx, [create], [alice]));
  // Artifacts for the booth/receipt: a draft carrying the program (matched by program_hash).
  ctx.store.collection(COLLECTIONS.drafts).set('draft-1', {
    draft_id: 'draft-1',
    program,
    program_hash: ph,
    yaml: AI_JUDGED_YAML,
    readback: ['Question: Does Sam finish the hot sauce wing without drinking anything?'],
    labels: {},
    title: 'Hot sauce wing',
    transcript: 'Sam finishes the wing without a drink',
  });
  const terms = termsHash(env.oracle, judges, ZERO_HASH_HEX);
  for (const u of [alice, bob]) {
    ok(await userSend(ctx, [fundIx(env, bet, u.publicKey, { calibration_hash: ZERO_HASH_HEX, program_hash: ph, terms_hash: terms })], [u]));
  }
  const keys = witnesses.map(() => generateKeypair());
  const latest = await ctx.chain.latestSlotHash();
  ok(
    await ctx.chain.sendAsBackend([
      startIx(env, bet, env.oracle, { beacon_slot: latest.slot, witnesses: witnesses.map((w, i) => ({ key: keys[i]!.publicKey, kind: w.kind })) }),
    ]),
  );
  const started = (await ctx.chain.getBet(bet))!;
  const heads: { index: number; hash: string }[] = [];
  const wlist: Record<string, unknown>[] = [];
  witnesses.forEach((w, wi) => {
    const key = keys[wi]!.publicKey;
    let prev = chainGenesis({ bet, witness_key: key, kind: w.kind, beacon_slot: started.beacon_slot, beacon_hash: hexToBytes(started.beacon_hash) });
    for (let i = 0; i < w.chunks; i++) {
      const start = i * 5000;
      const body = w.format === 'mjpeg' ? fakeMjpeg(start, 5000) : silentWav(5000);
      const bodySha = sha(body);
      const c = chunkHash({ prev, index: i, kind: w.kind, start_ms: start, duration_ms: 5000, body_sha256: bodySha });
      ctx.blobs.putChunk(bet, key, i, body);
      ctx.store.collection(COLLECTIONS.chunks).set(`${bet}:${key}:${i}`, {
        id: `${bet}:${key}:${i}`,
        bet,
        witness_key: key,
        index: i,
        kind: w.kind,
        body_format: w.format,
        start_ms: start,
        duration_ms: 5000,
        body_sha256: toHex(bodySha),
        chunk_hash: toHex(c),
        prev_hash: toHex(prev),
        sig_b64: '',
        final: i === w.chunks - 1,
        received_at_ms: ctx.clock.nowMs(),
        late: false,
        body_at_ms: ctx.clock.nowMs(),
      });
      prev = c;
    }
    heads.push({ index: w.chunks - 1, hash: toHex(prev) });
    wlist.push({ witness_key: key, kind: w.kind === 0 ? 'camera' : 'audio', kind_code: w.kind, user_id: w.user_id, label: w.label, offset_ms: 0, synced: true });
  });
  if (witnesses.length) ctx.store.collection(COLLECTIONS.witnesses).set(bet, { bet, witnesses: wlist, frozen: true });
  ok(await ctx.chain.sendAsBackend([endIx(env, bet, env.oracle, { seq: started.evidence_seq + 1, heads: witnesses.length ? heads : [] })]));
  const programBin = encodeProgram(program);
  const payload = buildPayload(programBin, new Uint8Array(0), encodeTrackBin({ flags: 0b10, model_hash: ZERO_HASH_HEX, tracks: [], segments: [] }));
  ok(
    await ctx.chain.sendAsBackend([
      postTracksIx(env, bet, {
        payload_len: payload.length,
        program_len: programBin.length,
        calibration_len: 0,
        offset: 0,
        data: payload,
        finalize: true,
        perception_root: ZERO_HASH_HEX,
      }),
    ]),
  );
  ok(await ctx.chain.sendAsBackend([setComputeUnitLimitIx(1_400_000), runRulesIx(env, bet)]));
  return { bet, program, witnessKeys: keys, account: (await ctx.chain.getBet(bet))! };
}

/** Delivers every pending mock-chain event and waits for the handler (and its triggers). */
export async function flush(ctx: AppContext): Promise<void> {
  const mock = ctx.chain as unknown as { flushEvents?: () => Promise<void> };
  for (let i = 0; i < 4; i++) {
    await mock.flushEvents?.();
    await ctx.events.idle();
  }
}
