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
  type BetAccount,
  type WitnessKind,
} from '@verdict/engine';
import { startIx } from '../chain/ixs.js';
import type { AppContext } from '../context.js';
import type { StartMessage } from '../ws/messages.js';
import { ApiError } from '../errors.js';
import type { UserRecord } from '../persistence/records.js';
import { MockSfx } from '../providers/mock/voice.js';
import type { AudioBlob } from '../providers/types.js';
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

/** Witness slots held back for the creator's camera + audio until they register. */
export const CREATOR_RESERVED_SLOTS = 2;

/**
 * POST /bets/:id/witnesses (§7.1): idempotent per key; ≤ 8; before start.
 *
 * Primary-camera binding (perception runs on the primary camera only, D-23):
 * the creator — the only user who can PUT the calibration — must register the
 * first camera. Until then another member's camera is refused (NO_CAMERA), so
 * the calibrated device is always cam1. Each user holds at most one witness
 * per kind (WRONG_STATE), and while the creator lacks a camera/audio witness
 * one slot each stays reserved for them; a full list is HUDDLE_FULL.
 */
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
  if (list.witnesses.some((w) => w.user_id === user.id && w.kind === kind)) {
    throw new ApiError('WRONG_STATE', `at most one ${kind} witness per user`);
  }
  const creator = info.creator_user_id;
  const isCreator = creator === null || user.id === creator;
  const creatorHas = (k: WitnessKind) => creator !== null && list.witnesses.some((w) => w.user_id === creator && w.kind === k);
  if (kind === 'camera' && !isCreator && !creatorHas('camera')) {
    throw new ApiError('NO_CAMERA', "the creator's calibrated camera registers first");
  }
  const reserved = isCreator ? 0 : (creatorHas('camera') ? 0 : 1) + (creatorHas('audio') ? 0 : 1);
  if (list.witnesses.length >= MAX_WITNESSES - reserved) throw new ApiError('HUDDLE_FULL', `at most ${MAX_WITNESSES} witnesses`);
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
 *
 * Crash/provider safety: the live record (which makes the keeper manage the
 * bet: end, evidence commits, perception) is persisted as soon as `start`
 * confirms, before any blob write or provider call; a failing SFX provider
 * falls back to the bundled mock sound. A bet that is Live onchain without a
 * live record (crash between confirm and persist) is adopted again by this
 * route (and by the keeper, `recoverLive`) from the chain account.
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
  if (bet.state === BET_STATE.Live && bet.beacon_slot > 0n) {
    const live = await recoverLive(ctx, s, info.id, bet);
    publishStart(ctx, info.id, live);
    return;
  }
  requireState(bet, BET_STATE.Funded);
  const list = orderWitnesses(witnessList(s, info.id), info.creator_user_id);
  if (!list) throw new ApiError('NO_CAMERA');

  const beacon = await ctx.chain.latestSlotHash();
  const res = await ctx.chain.sendAsBackend([
    startIx(ixEnv(ctx), info.id, ctx.chain.oracle, {
      beacon_slot: beacon.slot,
      witnesses: list.witnesses.map((w) => ({ key: w.witness_key, kind: w.kind_code })),
    }),
  ]);
  if (res.status !== 'confirmed') throw new ApiError(res.code, `start: ${res.error}`);
  // Persist first: from here on the bet is Live onchain and must stay managed.
  s.witnesses.set(info.id, { ...list, frozen: true });
  const now = ctx.clock.nowMs();
  const symbols = beaconSymbols(encodeBeaconPayload(beacon.slot, fromHex(beacon.hash, 32)));
  let live: LiveRecord = {
    bet: info.id,
    started_at_ms: now,
    start_signature: res.signature,
    beacon: { slot: beacon.slot.toString(), hash_hex: beacon.hash, symbols },
    play_on_user_id: list.witnesses[0]!.user_id,
    t0_ms: now + PLAY_DELAY_MS + DEFAULT_SFX_MS + BEACON_TONES_MS,
    end_requested_at_ms: null,
    end_requested_by: null,
    ended_at_ms: null,
    end_signature: null,
    last_commit_ms: now,
    commits: 0,
  };
  s.live.set(info.id, live);

  const sfxMs = await writeStartMedia(ctx, info.id, symbols);
  live = { ...(s.live.get(info.id) ?? live), t0_ms: now + PLAY_DELAY_MS + sfxMs + BEACON_TONES_MS };
  s.live.set(info.id, live);
  publishStart(ctx, info.id, live);
}

/** Start-sound length assumed before the SFX is known (the mock beep's length class). */
const DEFAULT_SFX_MS = 1500;

/**
 * Writes the beacon WAV and the start sound (SFX provider, else the bundled
 * mock) when missing; returns the start sound's length in ms.
 */
async function writeStartMedia(ctx: AppContext, betId: string, symbols: number[]): Promise<number> {
  if (!ctx.blobs.getBlob(BLOB_NS_START, beaconBlobKey(betId))) {
    const wav = encodeWav(synthBeacon(symbols, BEACON_SAMPLE_RATE), BEACON_SAMPLE_RATE);
    ctx.blobs.putBlob(BLOB_NS_START, beaconBlobKey(betId), wav);
  }
  const have = ctx.blobs.getBlob(BLOB_NS_START, sfxBlobKey(betId));
  if (have) return audioMs(have, 'audio/wav', DEFAULT_SFX_MS);
  let sfx: AudioBlob;
  try {
    sfx = await ctx.providers.sfx.startSound();
  } catch (e) {
    ctx.log.warn({ err: e, bet: betId }, 'start sound provider failed; using the bundled sound');
    sfx = await new MockSfx().startSound();
  }
  ctx.blobs.putBlob(BLOB_NS_START, sfxBlobKey(betId), sfx.bytes);
  return audioMs(sfx.bytes, sfx.mime, DEFAULT_SFX_MS);
}

/**
 * Rebuilds a missing live record of a bet that is Live onchain with a beacon
 * (a crash after `start` confirmed). Everything comes from the chain account
 * — the beacon is the committed `beacon_slot`/`beacon_hash`, never a fresh
 * SlotHashes read — and the stored witness list is frozen in onchain order.
 */
export async function recoverLive(ctx: AppContext, s: LifecycleStores, betId: string, bet: BetAccount): Promise<LiveRecord> {
  const existing = s.live.get(betId);
  if (existing) return existing;
  const list = witnessList(s, betId);
  const onchain = bet.witnesses.slice(0, bet.n_witnesses);
  const byKey = new Map(list.witnesses.map((w) => [w.witness_key, w]));
  const ordered = onchain.map((k) => byKey.get(k)).filter((w): w is WitnessRecord => !!w);
  s.witnesses.set(betId, { ...list, witnesses: [...ordered, ...list.witnesses.filter((w) => !onchain.includes(w.witness_key))], frozen: true });
  const symbols = beaconSymbols(encodeBeaconPayload(bet.beacon_slot, fromHex(bet.beacon_hash, 32)));
  const startedMs = Number(bet.started_at) * 1000;
  const camera = ordered.find((w) => w.kind === 'camera') ?? null;
  const live: LiveRecord = {
    bet: betId,
    started_at_ms: startedMs,
    start_signature: '',
    beacon: { slot: bet.beacon_slot.toString(), hash_hex: bet.beacon_hash, symbols },
    play_on_user_id: camera?.user_id ?? null,
    t0_ms: startedMs,
    end_requested_at_ms: null,
    end_requested_by: null,
    ended_at_ms: null,
    end_signature: null,
    last_commit_ms: null,
    commits: 0,
  };
  s.live.set(betId, live);
  await writeStartMedia(ctx, betId, symbols);
  return live;
}

/**
 * Witness order fixed by `start`: the primary camera first — the creator's
 * camera (the calibrated device, §6.0/D-23; any camera when the bet has no
 * creator user) — then everyone else in registration order. Null when there
 * is no such camera (the caller answers NO_CAMERA).
 */
export function orderWitnesses(list: WitnessListRecord, creatorUserId: string | null): WitnessListRecord | null {
  const primary = list.witnesses.find((w) => w.kind === 'camera' && (creatorUserId === null || w.user_id === creatorUserId));
  if (!primary) return null;
  return { ...list, witnesses: [primary, ...list.witnesses.filter((w) => w !== primary)] };
}

export function publishStart(ctx: AppContext, betId: string, live: LiveRecord): void {
  const msg = startMessage(ctx, betId, live);
  if (msg) ctx.hub.publish(`bet:${betId}`, msg);
}

/**
 * The WS `start` message of a Live bet (null without a beacon, e.g. market
 * bets). Also replayed in the `bet:<id>` snapshot while Live, so a phone
 * that (re)subscribes after the start still begins its witnesses.
 */
export function startMessage(ctx: AppContext, betId: string, live: LiveRecord): StartMessage | null {
  if (!live.beacon) return null;
  const base = `${ctx.config.publicUrl}/v1/bets/${betId}`;
  return {
    type: 'start',
    bet_id: betId,
    beacon: { slot: Number(live.beacon.slot), hash_hex: live.beacon.hash_hex, symbols: live.beacon.symbols },
    wav_url: `${base}/beacon.wav`,
    sfx_url: `${base}/start-sound`,
    play_on_user_id: live.play_on_user_id ?? '',
    play_delay_ms: PLAY_DELAY_MS,
  };
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
