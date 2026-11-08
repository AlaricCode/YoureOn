/**
 * Witness registration and the start sequence (§7.1, §7.5, §12.3, §12.4):
 * witnesses register before start; the creator's Start makes the oracle send
 * `start` with the witness list and the newest SlotHashes entry as beacon;
 * on confirmation the server broadcasts WS `start` with the beacon symbols,
 * the synthesized beacon WAV and the ElevenLabs (or mock) start sound.
 */
import {
  BEACON_SAMPLE_RATE,
  BET_STATE,
  beaconSymbols,
  encodeBeaconPayload,
  MAX_WITNESSES,
  PLAY_DELAY_MS,
  synthBeacon,
  type WitnessKind,
} from '@verdict/engine';
import { startIx } from '../chain/ixs.js';
import type { AppContext } from '../context.js';
import { ApiError } from '../errors.js';
import type { UserRecord } from '../persistence/records.js';
import { fromHex, isPubkey } from '../util/bytes.js';
import { decodeWav, encodeWav } from '../util/wav.js';
import { chainBet, ixEnv, requireMember, requireState, type BetInfo } from './betInfo.js';
import type { LiveRecord, WitnessListRecord, WitnessRecord } from './records.js';
import type { LifecycleStores } from './stores.js';

export const KIND_CODE: Record<WitnessKind, 0 | 1 | 2> = { camera: 0, audio: 1, detections: 2 };
const KIND_PREFIX: Record<WitnessKind, string> = { camera: 'cam', audio: 'mic', detections: 'det' };
/** 42 symbols × 50 ms (§7.5). */
export const BEACON_TONES_MS = 2100;
export const BLOB_NS_START = 'start';

export function witnessList(s: LifecycleStores, bet: string): WitnessListRecord {
  return s.witnesses.get(bet) ?? { bet, witnesses: [], frozen: false };
}

/** POST /bets/:id/witnesses (§7.1): idempotent per key; ≤ 8; before start. */
export async function registerWitness(
  ctx: AppContext,
  s: LifecycleStores,
  info: BetInfo,
  user: UserRecord,
  witnessKey: string,
  kind: WitnessKind,
): Promise<{ witness_id: string; label: string }> {
  requireMember(ctx, info, user);
  if (!isPubkey(witnessKey)) throw new ApiError('WRONG_STATE', 'witness_key must be a base58 public key', 400);
  const bet = await chainBet(ctx, info.id);
  if (info.program.kind === 'market') throw new ApiError('WRONG_STATE', 'market bets have no witnesses');
  const list = witnessList(s, info.id);
  const existing = list.witnesses.find((w) => w.witness_key === witnessKey);
  if (existing) {
    if (existing.kind !== kind || existing.user_id !== user.id) throw new ApiError('WRONG_STATE', 'witness key already registered');
    return { witness_id: existing.witness_key, label: existing.label };
  }
  requireState(bet, BET_STATE.Proposed, BET_STATE.Funded);
  if (list.frozen) throw new ApiError('WRONG_STATE', 'witness list fixed at start');
  if (list.witnesses.length >= MAX_WITNESSES) throw new ApiError('WRONG_STATE', 'at most 8 witnesses');
  const n = list.witnesses.filter((w) => w.kind === kind).length + 1;
  const rec: WitnessRecord = {
    witness_key: witnessKey,
    kind,
    kind_code: KIND_CODE[kind],
    user_id: user.id,
    label: `${KIND_PREFIX[kind]}${n}`,
    registered_at_ms: ctx.clock.nowMs(),
    recording_at_ms: null,
    final: false,
    offset_ms: null,
    synced: null,
    offset_source: null,
  };
  s.witnesses.set(info.id, { ...list, witnesses: [...list.witnesses, rec] });
  return { witness_id: rec.witness_key, label: rec.label };
}

/** Duration (ms) of a WAV blob, or a default for other formats. */
function audioMs(bytes: Uint8Array, mime: string, fallback = 1500): number {
  if (mime !== 'audio/wav') return fallback;
  try {
    const w = decodeWav(bytes);
    return Math.round((w.samples.length * 1000) / w.sampleRate);
  } catch {
    return fallback;
  }
}

export const beaconBlobKey = (bet: string): string => `${bet}-beacon.wav`;
export const sfxBlobKey = (bet: string): string => `${bet}-sfx`;

/**
 * POST /bets/:id/start (creator; rules/ai_judged). Sends `start` as the
 * oracle, then broadcasts WS `start`. Idempotent: a bet already Live
 * re-broadcasts the stored start message.
 */
export async function startBet(ctx: AppContext, s: LifecycleStores, info: BetInfo, user: UserRecord): Promise<void> {
  if (info.program.kind === 'market') throw new ApiError('WRONG_STATE', 'market bets start automatically');
  if (user.id !== info.creator_user_id) throw new ApiError('WRONG_STATE', 'only the creator starts the bet');
  const bet = await chainBet(ctx, info.id);
  const already = s.live.get(info.id);
  if (bet.state === BET_STATE.Live && already) {
    publishStart(ctx, info.id, already);
    return;
  }
  requireState(bet, BET_STATE.Funded);
  const list = witnessList(s, info.id);
  if (!list.witnesses.some((w) => w.kind === 'camera')) throw new ApiError('NO_CAMERA');

  const beacon = await ctx.chain.latestSlotHash();
  const res = await ctx.chain.sendAsBackend([
    startIx(ixEnv(ctx), info.id, ctx.chain.oracle, {
      beacon_slot: beacon.slot,
      witnesses: list.witnesses.map((w) => ({ key: w.witness_key, kind: w.kind_code })),
    }),
  ]);
  if (res.status !== 'confirmed') throw new ApiError(res.code, `start: ${res.error}`);
  s.witnesses.set(info.id, { ...list, frozen: true });

  const symbols = beaconSymbols(encodeBeaconPayload(beacon.slot, fromHex(beacon.hash, 32)));
  const wav = encodeWav(synthBeacon(symbols, BEACON_SAMPLE_RATE), BEACON_SAMPLE_RATE);
  ctx.blobs.putBlob(BLOB_NS_START, beaconBlobKey(info.id), wav);
  const sfx = await ctx.providers.sfx.startSound();
  ctx.blobs.putBlob(BLOB_NS_START, sfxBlobKey(info.id), sfx.bytes);

  const now = ctx.clock.nowMs();
  const camera = list.witnesses.find((w) => w.kind === 'camera')!;
  const live: LiveRecord = {
    bet: info.id,
    started_at_ms: now,
    start_signature: res.signature,
    beacon: { slot: beacon.slot.toString(), hash_hex: beacon.hash, symbols },
    play_on_user_id: camera.user_id,
    t0_ms: now + PLAY_DELAY_MS + audioMs(sfx.bytes, sfx.mime) + BEACON_TONES_MS,
    end_requested_at_ms: null,
    end_requested_by: null,
    ended_at_ms: null,
    end_signature: null,
    last_commit_ms: now,
    commits: 0,
  };
  s.live.set(info.id, live);
  publishStart(ctx, info.id, live);
}

export function publishStart(ctx: AppContext, betId: string, live: LiveRecord): void {
  if (!live.beacon) return;
  const base = `${ctx.config.publicUrl}/v1/bets/${betId}`;
  ctx.hub.publish(`bet:${betId}`, {
    type: 'start',
    bet_id: betId,
    beacon: { slot: Number(live.beacon.slot), hash_hex: live.beacon.hash_hex, symbols: live.beacon.symbols },
    wav_url: `${base}/beacon.wav`,
    sfx_url: `${base}/start-sound`,
    play_on_user_id: live.play_on_user_id ?? '',
    play_delay_ms: PLAY_DELAY_MS,
  });
}

/** Market bets (§12.6 step 1): the oracle starts with beacon_slot 0 and no witnesses. */
export async function startMarket(ctx: AppContext, s: LifecycleStores, betId: string): Promise<boolean> {
  const res = await ctx.chain.sendAsBackend([startIx(ixEnv(ctx), betId, ctx.chain.oracle, { beacon_slot: 0n, witnesses: [] })]);
  if (res.status !== 'confirmed') return false;
  const now = ctx.clock.nowMs();
  s.live.set(betId, {
    bet: betId,
    started_at_ms: now,
    start_signature: res.signature,
    beacon: null,
    play_on_user_id: null,
    t0_ms: now,
    end_requested_at_ms: null,
    end_requested_by: null,
    ended_at_ms: null,
    end_signature: null,
    last_commit_ms: now,
    commits: 0,
  });
  return true;
}

/** WS `recording` (§7.5 step 4): marks the witness as recording (wall time of arrival). */
export function markRecording(s: LifecycleStores, betId: string, witnessKey: string, userId: string, nowMs: number): boolean {
  const list = s.witnesses.get(betId);
  if (!list) return false;
  const w = list.witnesses.find((x) => x.witness_key === witnessKey);
  if (!w || w.user_id !== userId) return false;
  if (w.recording_at_ms === null) {
    w.recording_at_ms = nowMs;
    s.witnesses.set(betId, list);
  }
  return true;
}
