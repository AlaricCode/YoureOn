/**
 * Evidence intake (§7.2–§7.5, §12.3): chunk hash records are POSTed first and
 * verified against the witness hash chain (G_w from the onchain beacon,
 * recomputed c_i, ed25519 sig_i); bodies follow and must match
 * `body_sha256`. Audio bodies are scanned for the beacon to align device time
 * (`offset_w`). Witness heads feed the oracle's rolling `commit_evidence`
 * and the final `end`.
 */
import { createHash } from 'node:crypto';
import {
  BET_STATE,
  CHUNK_LATE_MS,
  chainGenesis,
  chunkHash,
  decodeBeacon,
  beaconOffsetMs,
  HEAD_INDEX_NONE,
  verifyChunkSig,
  type BetAccount,
  type HeadArg,
} from '@verdict/engine';
import type { AppContext } from '../context.js';
import { ApiError } from '../errors.js';
import type { UserRecord } from '../persistence/records.js';
import { badRequest } from '../routes/util.js';
import { bytesEqual, fromBase64, fromHex, isPubkey, toHex } from '../util/bytes.js';
import { decodeWav } from '../util/wav.js';
import { chainBet, type BetInfo } from './betInfo.js';
import type { ChunkMetaRecord, WitnessRecord } from './records.js';
import { chunkId, witnessChunks, type LifecycleStores } from './stores.js';
import { witnessList } from './live.js';

const HEX32 = /^[0-9a-f]{64}$/;
const FORMATS: Record<0 | 1 | 2, ChunkMetaRecord['body_format'][]> = { 0: ['mp4', 'mjpeg'], 1: ['wav'], 2: ['json'] };
const KIND_NAMES = { camera: 0, audio: 1, detections: 2 } as const;
/** Audio chunks scanned for the beacon (it plays within the first seconds, §7.5). */
export const BEACON_SCAN_CHUNKS = 3;

export interface ChunkPost {
  witness_key: string;
  index: number;
  kind: 0 | 1 | 2;
  body_format: ChunkMetaRecord['body_format'];
  width_px: number | null;
  height_px: number | null;
  orientation: 'landscape' | 'portrait' | null;
  start_ms: number;
  duration_ms: number;
  body_sha256: string;
  chunk_hash: string;
  prev_hash: string;
  sig_b64: string;
  final: boolean;
}

const int = (v: unknown, lo: number, hi: number, k: string): number => {
  if (!Number.isSafeInteger(v) || (v as number) < lo || (v as number) > hi) throw badRequest(`${k} must be an integer in [${lo}, ${hi}]`);
  return v as number;
};
const hex32 = (v: unknown, k: string): string => {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  if (!HEX32.test(s)) throw badRequest(`${k} must be 64 hex chars`);
  return s;
};

export function parseChunkPost(body: unknown): ChunkPost {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('body must be a JSON object');
  const o = body as Record<string, unknown>;
  if (!isPubkey(o['witness_key'])) throw badRequest('witness_key must be a base58 public key');
  const kindRaw = o['kind'];
  const kind = typeof kindRaw === 'string' ? KIND_NAMES[kindRaw as keyof typeof KIND_NAMES] : kindRaw;
  if (kind !== 0 && kind !== 1 && kind !== 2) throw badRequest('kind must be camera|audio|detections (0..2)');
  const fmt = o['body_format'];
  if (fmt !== 'mp4' && fmt !== 'mjpeg' && fmt !== 'wav' && fmt !== 'json') throw badRequest('body_format invalid');
  const orientation = o['orientation'];
  if (orientation !== undefined && orientation !== null && orientation !== 'landscape' && orientation !== 'portrait') {
    throw badRequest('orientation invalid');
  }
  if (typeof o['sig_b64'] !== 'string') throw badRequest('sig_b64 must be base64');
  if (o['final'] !== undefined && typeof o['final'] !== 'boolean') throw badRequest('final must be a boolean');
  return {
    witness_key: o['witness_key'],
    index: int(o['index'], 0, 0xfffffffe, 'index'),
    kind,
    body_format: fmt,
    width_px: o['width_px'] === undefined || o['width_px'] === null ? null : int(o['width_px'], 1, 100_000, 'width_px'),
    height_px: o['height_px'] === undefined || o['height_px'] === null ? null : int(o['height_px'], 1, 100_000, 'height_px'),
    orientation: (orientation as ChunkPost['orientation']) ?? null,
    start_ms: int(o['start_ms'], 0, Number.MAX_SAFE_INTEGER, 'start_ms'),
    duration_ms: int(o['duration_ms'], 1, 0xffffffff, 'duration_ms'),
    body_sha256: hex32(o['body_sha256'], 'body_sha256'),
    chunk_hash: hex32(o['chunk_hash'], 'chunk_hash'),
    prev_hash: hex32(o['prev_hash'], 'prev_hash'),
    sig_b64: o['sig_b64'],
    final: o['final'] === true,
  };
}

/** G_w of witness `w` of a started bet (§7.2). */
export function witnessGenesis(bet: BetAccount, betId: string, witnessKey: string, kind: 0 | 1 | 2): Uint8Array {
  return chainGenesis({
    bet: betId,
    witness_key: witnessKey,
    kind,
    beacon_slot: bet.beacon_slot,
    beacon_hash: fromHex(bet.beacon_hash, 32),
  });
}

/** The camera whose metadata must match the calibration: the primary (lowest-index) camera witness (§6.0). */
function primaryCamera(witnesses: WitnessRecord[]): WitnessRecord | null {
  return witnesses.find((w) => w.kind === 'camera') ?? null;
}

/** Wall-clock ms of a witness's device-time 0 (best estimate for the advisory `late` flag). */
export function recordingStartWallMs(w: WitnessRecord, liveStartMs: number | null): number {
  if (w.recording_at_ms !== null) return w.recording_at_ms;
  return liveStartMs ?? 0;
}

/**
 * POST /bets/:id/chunks: verifies and stores one hash record. Idempotent for
 * an identical re-post. Returns the record and whether the witness is now final.
 */
export async function registerChunk(
  ctx: AppContext,
  s: LifecycleStores,
  info: BetInfo,
  user: UserRecord,
  post: ChunkPost,
  calibrationCamera: { width_px: number; height_px: number; orientation: string } | null,
): Promise<ChunkMetaRecord> {
  const list = witnessList(s, info.id);
  const w = list.witnesses.find((x) => x.witness_key === post.witness_key);
  if (!w || !list.frozen) throw new ApiError('NOT_FOUND', 'witness not registered for this bet');
  if (w.user_id !== user.id) throw new ApiError('NOT_FOUND', 'witness belongs to another user');
  if (post.kind !== w.kind_code || !FORMATS[w.kind_code].includes(post.body_format)) throw badRequest('kind/body_format mismatch');

  const id = chunkId(info.id, post.witness_key, post.index);
  const existing = s.chunks.get(id);
  if (existing) {
    if (existing.chunk_hash === post.chunk_hash) return existing;
    throw new ApiError('WRONG_STATE', 'chunk index already recorded with a different hash');
  }

  const bet = await chainBet(ctx, info.id);
  if (bet.state !== BET_STATE.Live) throw new ApiError('WRONG_STATE', 'bet is not live');
  const onchainIdx = bet.witnesses.slice(0, bet.n_witnesses).indexOf(post.witness_key);
  if (onchainIdx < 0) throw new ApiError('NOT_FOUND', 'witness not in the onchain list');

  if (w.kind === 'camera' && calibrationCamera && primaryCamera(list.witnesses)?.witness_key === w.witness_key) {
    const mismatch =
      (post.width_px !== null && post.width_px !== calibrationCamera.width_px) ||
      (post.height_px !== null && post.height_px !== calibrationCamera.height_px) ||
      (post.orientation !== null && post.orientation !== calibrationCamera.orientation);
    if (mismatch) throw new ApiError('CAMERA_MISMATCH');
  }

  const prior = witnessChunks(s, info.id, post.witness_key);
  if (prior.some((c) => c.final)) throw new ApiError('WRONG_STATE', 'witness already sent its final chunk');
  if (post.index !== prior.length) throw badRequest(`chunk index must be ${prior.length} (gap-free from 0)`);
  if (post.index === 0 && post.start_ms !== 0) throw badRequest('chunk 0 must have start_ms = 0');
  const last = prior[prior.length - 1];
  if (last && post.start_ms < last.start_ms + last.duration_ms) throw badRequest('chunk overlaps the previous one');

  const expectedPrev = post.index === 0 ? witnessGenesis(bet, info.id, w.witness_key, w.kind_code) : fromHex(last!.chunk_hash, 32);
  if (!bytesEqual(expectedPrev, fromHex(post.prev_hash, 32))) throw badRequest('prev_hash does not continue the chain');
  const c = chunkHash({
    prev: expectedPrev,
    index: post.index,
    kind: post.kind,
    start_ms: post.start_ms,
    duration_ms: post.duration_ms,
    body_sha256: fromHex(post.body_sha256, 32),
  });
  if (toHex(c) !== post.chunk_hash) throw badRequest('chunk_hash does not match the recomputed c_i');
  let sig: Uint8Array;
  try {
    sig = fromBase64(post.sig_b64);
  } catch {
    throw badRequest('sig_b64 must be base64');
  }
  if (!verifyChunkSig(w.witness_key, c, sig)) throw badRequest('bad chunk signature');

  const now = ctx.clock.nowMs();
  const live = s.live.get(info.id);
  const chunkEndWall = recordingStartWallMs(w, live?.started_at_ms ?? null) + post.start_ms + post.duration_ms;
  const rec: ChunkMetaRecord = {
    id,
    bet: info.id,
    witness_key: post.witness_key,
    index: post.index,
    kind: post.kind,
    body_format: post.body_format,
    width_px: post.width_px,
    height_px: post.height_px,
    orientation: post.orientation,
    start_ms: post.start_ms,
    duration_ms: post.duration_ms,
    body_sha256: post.body_sha256,
    chunk_hash: post.chunk_hash,
    prev_hash: post.prev_hash,
    sig_b64: post.sig_b64,
    final: post.final,
    received_at_ms: now,
    late: now > chunkEndWall + CHUNK_LATE_MS,
    body_at_ms: null,
  };
  if (!s.chunks.insert(id, rec)) return s.chunks.require(id);
  if (post.final) {
    const l2 = witnessList(s, info.id);
    const w2 = l2.witnesses.find((x) => x.witness_key === post.witness_key);
    if (w2) {
      w2.final = true;
      s.witnesses.set(info.id, l2);
    }
  }
  return rec;
}

/** PUT /bets/:id/chunks/:witness/:index: stores a body whose sha256 matches its hash record. */
export function storeChunkBody(
  ctx: AppContext,
  s: LifecycleStores,
  info: BetInfo,
  user: UserRecord,
  witnessKey: string,
  index: number,
  body: Uint8Array,
): ChunkMetaRecord {
  const rec = s.chunks.get(chunkId(info.id, witnessKey, index));
  if (!rec) throw new ApiError('NOT_FOUND', 'post the chunk hash record first');
  const w = witnessList(s, info.id).witnesses.find((x) => x.witness_key === witnessKey);
  if (!w || w.user_id !== user.id) throw new ApiError('NOT_FOUND', 'witness belongs to another user');
  const digest = createHash('sha256').update(body).digest('hex');
  if (digest !== rec.body_sha256) throw badRequest('body sha256 does not match the hash record');
  ctx.blobs.putChunk(info.id, witnessKey, index, body);
  if (rec.body_at_ms === null) {
    rec.body_at_ms = ctx.clock.nowMs();
    s.chunks.set(rec.id, rec);
  }
  return rec;
}

/**
 * Decodes the beacon from the first audio chunks of a witness (§7.5) and
 * records `offset_w`; propagates the offset to the same user's camera /
 * detections witnesses that have no audio of their own. Returns true once synced.
 */
export function trySyncAudioWitness(ctx: AppContext, s: LifecycleStores, info: BetInfo, bet: BetAccount, witnessKey: string): boolean {
  const list = witnessList(s, info.id);
  const w = list.witnesses.find((x) => x.witness_key === witnessKey);
  if (!w || w.kind !== 'audio') return false;
  if (w.synced === true) return true;
  const chunks = witnessChunks(s, info.id, witnessKey).slice(0, BEACON_SCAN_CHUNKS);
  const parts: { start_ms: number; samples: Int16Array; rate: number }[] = [];
  for (const c of chunks) {
    const body = ctx.blobs.getChunk(info.id, witnessKey, c.index);
    if (!body) break;
    try {
      const wav = decodeWav(body);
      parts.push({ start_ms: c.start_ms, samples: wav.samples, rate: wav.sampleRate });
    } catch {
      break;
    }
  }
  if (parts.length === 0) return false;
  const rate = parts[0]!.rate;
  if (parts.some((p) => p.rate !== rate)) return false;
  const total = Math.max(...parts.map((p) => Math.round((p.start_ms * rate) / 1000) + p.samples.length));
  const pcm = new Int16Array(total);
  for (const p of parts) pcm.set(p.samples, Math.round((p.start_ms * rate) / 1000));
  const dec = decodeBeacon(pcm, rate);
  const expectPrefix = fromHex(bet.beacon_hash, 32).slice(0, 8);
  const ok = !!dec && dec.slot === bet.beacon_slot && bytesEqual(dec.hashPrefix, expectPrefix);
  if (ok) {
    const offset = beaconOffsetMs(dec!.t0Sample, rate, 0);
    w.offset_ms = offset;
    w.synced = true;
    w.offset_source = 'beacon';
    for (const other of list.witnesses) {
      if (other.kind !== 'audio' && other.user_id === w.user_id && other.synced !== true) {
        other.offset_ms = offset;
        other.synced = true;
        other.offset_source = w.witness_key;
      }
    }
  } else if (chunks.length >= BEACON_SCAN_CHUNKS && parts.length === chunks.length) {
    w.synced = false;
  }
  s.witnesses.set(info.id, list);
  return ok;
}

/**
 * Current heads in onchain witness order (§7.4): the last verified chunk
 * record of each witness, or (0xFFFFFFFF, G_w) when it has none.
 */
export function currentHeads(s: LifecycleStores, info: BetInfo, bet: BetAccount): HeadArg[] {
  const out: HeadArg[] = [];
  for (let i = 0; i < bet.n_witnesses; i++) {
    const key = bet.witnesses[i]!;
    const chunks = witnessChunks(s, info.id, key);
    const last = chunks[chunks.length - 1];
    if (last) out.push({ index: last.index, hash: last.chunk_hash });
    else out.push({ index: HEAD_INDEX_NONE, hash: toHex(witnessGenesis(bet, info.id, key, bet.witness_kinds[i] as 0 | 1 | 2)) });
  }
  return out;
}

/** True when every registered witness has posted its final chunk record. */
export function allWitnessesFinal(s: LifecycleStores, betId: string): boolean {
  const list = witnessList(s, betId);
  return list.witnesses.length > 0 && list.witnesses.every((w) => w.final);
}
