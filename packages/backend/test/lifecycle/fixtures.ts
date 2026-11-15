/**
 * Test fixtures for the bet-lifecycle service: users, an on-chain bet created
 * through the mock chain from a worked-example program, the bets mirror
 * record, signing helpers and witness chunk builders.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chainGenesis,
  chunkHash,
  chunkSigMessage,
  programHash,
  quantizeEmbedding,
  sha256,
  type Calibration,
  type Program,
} from '@verdict/engine';
import { betAddress, createBetIx, initProfileIx } from '../../src/chain/ixs.js';
import type { AppContext } from '../../src/context.js';
import { generateKeypair, type KeyPair } from '../../src/crypto/keys.js';
import { BiometricVault } from '../../src/identity/biometrics.js';
import { ixEnv } from '../../src/lifecycle/betInfo.js';
import { lifecycleService } from '../../src/lifecycle/service.js';
import { COLLECTIONS, type UserRecord } from '../../src/persistence/records.js';
import { mockBaseEmbedding } from '../../src/providers/mock/identity.js';
import { fromBase64, fromHex, toBase64, toHex } from '../../src/util/bytes.js';
import type { Env } from '../../src/config/load.js';
import { auth, login, makeApp, type TestApp, type TestUser } from '../appHelpers.js';

const here = dirname(fileURLToPath(import.meta.url));
export const VECTORS = join(here, '..', '..', '..', '..', 'testvectors');

export function vector(name: string): { program: Program; calibration: Calibration | null } {
  const j = JSON.parse(readFileSync(join(VECTORS, `${name}.json`), 'utf8')) as { program: Program; calibration: Calibration | null };
  return { program: j.program, calibration: j.calibration };
}

export interface World extends TestApp {
  alice: TestUser;
  bob: TestUser;
  carol: TestUser;
}

export async function makeWorld(env: Env = {}): Promise<World> {
  const t = await makeApp(env);
  const alice = await login(t.app, 'alice@example.com');
  const bob = await login(t.app, 'bob@example.com');
  const carol = await login(t.app, 'carol@example.com');
  for (const u of [alice, bob, carol]) await t.ctx.chain.faucet(u.wallet.publicKey, 100_000_000n);
  return { ...t, alice, bob, carol };
}

/** Enrolls a user's face with the mock identity base embedding and publishes the commitment onchain. */
export async function enrollFace(t: TestApp, u: TestUser): Promise<void> {
  const users = t.ctx.store.collection<UserRecord>(COLLECTIONS.users);
  const rec = users.require(u.user.id);
  const vault = new BiometricVault(t.ctx.store, t.ctx.config.biometricKey, t.ctx.clock);
  const q = quantizeEmbedding(mockBaseEmbedding(u.user.id, 'face'));
  const bio = vault.seal(rec, 'face', q);
  users.set(rec.id, { ...rec, biometrics: bio, enrolled: { face: true, voice: false } });
  const p = await t.ctx.chain.prepare([
    initProfileIx(ixEnv(t.ctx), u.wallet.publicKey, { face_commit: bio.face_commit!, voice_commit: '00'.repeat(32), display_name: rec.display_name }),
  ]);
  const r = await t.ctx.chain.submit(p, [{ pubkey: u.wallet.publicKey, signature: u.wallet.sign(p.message) }]);
  if (r.status !== 'confirmed') throw new Error(`init_profile failed: ${r.error}`);
}

export interface CreatedBet {
  id: string;
  program: Program;
  calibration: Calibration | null;
}

let nonceCounter = 1n;

/**
 * Creates the bet onchain (creator signs, oracle co-signs) and writes the bets
 * mirror record the lifecycle reads (program, labels, title, creator, huddle).
 */
export async function createBet(
  w: World,
  vectorName: string,
  opts: { creator?: TestUser; other?: TestUser; huddleMembers?: TestUser[] } = {},
): Promise<CreatedBet> {
  const creator = opts.creator ?? w.alice;
  const other = opts.other ?? w.bob;
  const v = vector(vectorName);
  const program: Program = { ...v.program, participants: [creator.wallet.publicKey, other.wallet.publicKey] };
  const stake = BigInt(program.stake_each ?? 0);
  const nonce = nonceCounter++;
  const env = ixEnv(w.ctx);
  const flags = program.kind === 'ai_judged' ? 2 : program.legs.some((l) => l.actor_bound) ? 1 : 0;
  const ix = createBetIx(env, creator.wallet.publicKey, {
    nonce,
    participants: program.participants,
    stakes: program.participants.map(() => stake),
    side_b_mask: program.sides.reduce<number>((m, s, i) => (s === 1 ? m | (1 << i) : m), 0),
    stake_each: stake,
    time_limit_s: program.time_limit_s,
    flags,
    program_hash: programHash(program),
    acceptance_audio_hash: toHex(sha256(new TextEncoder().encode(`accept-${nonce}`))),
    judges: w.ctx.config.keys.judges.map((j) => j.publicKey) as [string, string, string],
  });
  const p = await w.ctx.chain.prepare([ix]);
  const r = await w.ctx.chain.submit(p, [{ pubkey: creator.wallet.publicKey, signature: creator.wallet.sign(p.message) }]);
  if (r.status !== 'confirmed') throw new Error(`create_bet failed: ${r.error}`);
  const id = betAddress(env, creator.wallet.publicKey, nonce);
  const huddleId = `h-${nonce}`;
  const members = opts.huddleMembers ?? [creator, other];
  w.ctx.store.collection(COLLECTIONS.huddles).set(huddleId, {
    id: huddleId,
    code: '123456',
    creator_user_id: creator.user.id,
    created_at_ms: w.clock.nowMs(),
    updated_at_ms: w.clock.nowMs(),
    members: members.map((m, i) => ({ user_id: m.user.id, joined_at_ms: i, confirmed: true, confirmed_at_ms: i, confirmed_cos_bps: null })),
  });
  w.ctx.store.collection(COLLECTIONS.bets).set(id, {
    id,
    program,
    labels: {},
    title: vectorName,
    creator_user_id: creator.user.id,
    huddle_id: huddleId,
  });
  return { id, program, calibration: v.calibration };
}

/** Signs a §12.1 sign payload with the user's wallet and submits it. */
export async function signAndSubmit(w: TestApp, u: TestUser, sign: { tx_id: string; message_b64: string }): Promise<{ status: string; error: unknown }> {
  const sig = u.wallet.sign(fromBase64(sign.message_b64));
  const r = await w.app.inject({
    method: 'POST',
    url: `/v1/tx/${sign.tx_id}/submit`,
    headers: auth(u),
    payload: { signature_b64: toBase64(sig) },
  });
  if (r.statusCode !== 200) throw new Error(`submit failed: ${r.statusCode} ${r.body}`);
  return r.json();
}

export async function api(w: TestApp, u: TestUser, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  return w.app.inject({ method, url, headers: auth(u), ...(payload === undefined ? {} : { payload: payload as object }) });
}

/** PUT calibration (creator) and fund both participants. */
export async function calibrateAndFund(w: World, bet: CreatedBet, funders: TestUser[] = [w.alice, w.bob]): Promise<void> {
  const creator = funders[0]!;
  if (bet.program.kind === 'rules') {
    const c = await api(w, creator, 'PUT', `/v1/bets/${bet.id}/calibration`, bet.calibration);
    if (c.statusCode !== 200) throw new Error(`calibration: ${c.body}`);
  }
  for (const u of funders) {
    const r = await api(w, u, 'POST', `/v1/bets/${bet.id}/fund`);
    if (r.statusCode !== 200) throw new Error(`fund: ${r.statusCode} ${r.body}`);
    const s = await signAndSubmit(w, u, r.json().sign);
    if (s.status !== 'confirmed') throw new Error(`fund submit: ${JSON.stringify(s)}`);
  }
}

export interface Witness {
  key: KeyPair;
  kind: 'camera' | 'audio' | 'detections';
  owner: TestUser;
  prev: Uint8Array | null;
  next: number;
  start: number;
}

export async function addWitness(w: TestApp, bet: CreatedBet, owner: TestUser, kind: Witness['kind']): Promise<Witness> {
  const key = generateKeypair();
  const r = await api(w, owner, 'POST', `/v1/bets/${bet.id}/witnesses`, { witness_key: key.publicKey, kind });
  if (r.statusCode !== 200) throw new Error(`witness: ${r.body}`);
  return { key, kind, owner, prev: null, next: 0, start: 0 };
}

const KIND = { camera: 0, audio: 1, detections: 2 } as const;
const FORMAT = { camera: 'mjpeg', audio: 'wav', detections: 'json' } as const;

/** Builds a valid §7.2 chunk record (and advances the witness's chain). */
export async function chunkRecord(w: TestApp, bet: CreatedBet, wit: Witness, body: Uint8Array, durationMs = 5000, final = false) {
  const acct = (await w.ctx.chain.getBet(bet.id))!;
  const kind = KIND[wit.kind];
  const prev = wit.prev ?? chainGenesis({ bet: bet.id, witness_key: wit.key.publicKey, kind, beacon_slot: acct.beacon_slot, beacon_hash: fromHex(acct.beacon_hash, 32) });
  const bodySha = sha256(body);
  const c = chunkHash({ prev, index: wit.next, kind, start_ms: wit.start, duration_ms: durationMs, body_sha256: bodySha });
  const rec = {
    witness_key: wit.key.publicKey,
    index: wit.next,
    kind,
    body_format: FORMAT[wit.kind],
    ...(wit.kind === 'camera' ? { width_px: 1920, height_px: 1080, orientation: 'landscape' } : {}),
    start_ms: wit.start,
    duration_ms: durationMs,
    body_sha256: toHex(bodySha),
    chunk_hash: toHex(c),
    prev_hash: toHex(prev),
    sig_b64: toBase64(wit.key.sign(chunkSigMessage(c))),
    final,
  };
  return { rec, commit: () => ((wit.prev = c), (wit.next += 1), (wit.start += durationMs)) };
}

/** POSTs the hash record then PUTs the body; asserts both succeed. */
export async function uploadChunk(w: TestApp, bet: CreatedBet, wit: Witness, body: Uint8Array, final = false, durationMs = 5000): Promise<void> {
  const { rec, commit } = await chunkRecord(w, bet, wit, body, durationMs, final);
  const r = await api(w, wit.owner, 'POST', `/v1/bets/${bet.id}/chunks`, rec);
  if (r.statusCode !== 200) throw new Error(`chunk post: ${r.statusCode} ${r.body}`);
  commit();
  const put = await w.app.inject({
    method: 'PUT',
    url: `/v1/bets/${bet.id}/chunks/${wit.key.publicKey}/${rec.index}`,
    headers: { ...auth(wit.owner), 'content-type': 'application/octet-stream' },
    payload: Buffer.from(body),
  });
  if (put.statusCode !== 200) throw new Error(`chunk put: ${put.statusCode} ${put.body}`);
}

/** Lets the chain event queue and every in-flight perception run settle. */
export async function settle(w: TestApp): Promise<void> {
  const chain = w.ctx.chain as unknown as { flushEvents?: () => Promise<void> };
  for (let i = 0; i < 6; i++) {
    await chain.flushEvents?.();
    await w.ctx.events.idle();
    await lifecycleService(w.ctx).perception.idle();
  }
}

/** Runs the bet from calibration to Perceiving→(PreRuled|Disputed): fund, witnesses, start, chunks, end. */
export async function playBet(w: World, bet: CreatedBet, players: TestUser[] = [w.alice, w.bob]): Promise<void> {
  await calibrateAndFund(w, bet, players);
  const cam = await addWitness(w, bet, players[0]!, 'camera');
  const start = await api(w, players[0]!, 'POST', `/v1/bets/${bet.id}/start`);
  if (start.statusCode !== 200) throw new Error(`start: ${start.body}`);
  await uploadChunk(w, bet, cam, new TextEncoder().encode('frame-bytes-0'));
  await uploadChunk(w, bet, cam, new TextEncoder().encode('frame-bytes-1'), true);
  const end = await api(w, players[0]!, 'POST', `/v1/bets/${bet.id}/end`);
  if (end.statusCode !== 200) throw new Error(`end: ${end.body}`);
  await settle(w);
}
