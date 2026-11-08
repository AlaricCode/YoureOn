/**
 * Perception → sealed TrackBuffer payload (§6, §5.6), pure of chain I/O:
 *   two hosts (PERCEPTION_PROVIDER) → quantize (real hosts) → identity
 *   binding (actor-bound) → crossCheck (+ phones) → seal host A →
 *   proof plan → extractDecisiveWindows (verified = provable checkpoints) →
 *   advisory audio cross-check → track_bin → payload.
 * ai_judged: the minimal track_bin; market: market_bin from Gemini resolutions.
 */
import { createHash } from 'node:crypto';
import {
  AI_JUDGED_TRACK_FLAGS,
  AUDIO_CHECK_EVENTS,
  audioCrossCheck,
  bindPersons,
  buildPayload,
  crossCheck,
  encodeCalibration,
  encodeMarketBin,
  encodeProgram,
  encodeTrackBin,
  evaluate,
  evaluateSession,
  extractDecisiveWindows,
  FPS,
  fuseTimeline,
  leafSignals,
  marketHash,
  MAX_BUFFER_PAYLOAD,
  perceptionRoot,
  quantizePersonTracks,
  quantizeSession,
  sealSession,
  TAIL_FRAMES,
  TRACK_FLAG_CROSS_CHECK_OK,
  TRACK_FLAG_PHONE_DISAGREE,
  TRACK_FLAG_WINDOW_UNAVAILABLE,
  windowUnavailableBuffer,
  ZERO_HASH_HEX,
  type Calibration,
  type Checkpoint,
  type CrossCheckResult,
  type DecisiveEvent,
  type EvalResult,
  type FusedTimeline,
  type MarketBinEntry,
  type Program,
  type SessionTracks,
  type TrackBufferData,
} from '@verdict/engine';
import type { AppContext } from '../context.js';
import type { PerceptionHostResult } from '../providers/types.js';
import type { BetInfo } from './betInfo.js';
import { audioTranscripts, offsetOf, phoneDetections, primaryVideos, recordedSessionMs } from './footage.js';
import {
  candidateTemplates,
  mockFaceObservations,
  planProofs,
  timelineFromSession,
  voiceObservations,
  type ObservationSet,
} from './identity.js';
import type { PerceptionHostInfo, ProofPlan } from './records.js';
import { exprAt } from './scene.js';
import type { LifecycleStores } from './stores.js';

export interface SealedPayload {
  payload: Uint8Array;
  program_len: number;
  calibration_len: number;
  perception_root: string;
  flags: number;
  model_hash: string | null;
  window_unavailable: boolean;
  audio_disagree: boolean;
  phone_disagree: boolean;
  hosts: PerceptionHostInfo[];
  cross: CrossCheckResult | null;
  n_frames: number;
  proofs: ProofPlan[];
  expected: { preruling: number; reason: number; winner_mask: number; leg_results: number[] } | null;
  /** sealed host-A session (exhibits / booth); null for ai_judged/market */
  sealed: SessionTracks | null;
}

const anyActorBound = (p: Program): boolean => p.legs.some((l) => l.actor_bound);

/** Deterministic u32 seed for mock perception (engine.simulate). */
export function perceptionSeed(betId: string): number {
  return createHash('sha256').update(betId).digest().readUInt32LE(0);
}

/** Full-session evaluation as the cross-check runs it (flags bit1 set, all checkpoints verified). */
function fullSessionEval(p: Program, c: Calibration | null, s: SessionTracks): EvalResult {
  const sess = { ...s, flags: (s.flags | TRACK_FLAG_CROSS_CHECK_OK) & ~TRACK_FLAG_WINDOW_UNAVAILABLE };
  const first = evaluateSession(p, c, sess, []);
  return first.checkpoints.length === 0 ? first : evaluateSession(p, c, sess, first.checkpoints);
}

function summarize(r: EvalResult): SealedPayload['expected'] {
  return { preruling: r.preruling, reason: r.reason, winner_mask: r.winner_mask, leg_results: [...r.leg_results] };
}

/** Decisive events of the audio-checked types (§7.6) from the leaf signals at decisive frames. */
export function decisiveEvents(p: Program, c: Calibration | null, s: SessionTracks, full: EvalResult): DecisiveEvent[] {
  const rows = leafSignals(p, c, s);
  const out: DecisiveEvent[] = [];
  p.legs.forEach((leg, li) => {
    for (const d of full.decisive_frames[li] ?? []) {
      for (const row of rows) {
        if (row.leg !== leg.id || !row.signal[d]) continue;
        const root = leg[row.field];
        const node = root ? exprAt(root, row.path) : null;
        if (node && (AUDIO_CHECK_EVENTS as readonly string[]).includes(node.op)) out.push({ type: node.op, frame: d });
      }
    }
  });
  return out;
}

function hostInfo(h: PerceptionHostResult): PerceptionHostInfo {
  return { provider: h.host.provider, job_id: h.host.job_id, url: h.host.url, network: h.network, model_hash: h.model_hash };
}

/** Session for one host: mock hosts are already quantized; real hosts are quantized here (§6.2). */
function hostSession(h: PerceptionHostResult, p: Program, c: Calibration | null, nFrames: number): SessionTracks {
  if (h.session) return h.session;
  if (!h.raw) throw new Error(`perception host ${h.host.job_id} returned neither raw detections nor a session`);
  return quantizeSession(h.raw, {
    width_px: c?.scene.camera.width_px ?? 1920,
    height_px: c?.scene.camera.height_px ?? 1080,
    n_frames: nFrames,
    model_hash: h.model_hash,
    flags: h.flags,
    program: p,
    calibration: c,
  });
}

async function sealRules(ctx: AppContext, s: LifecycleStores, info: BetInfo, c: Calibration | null): Promise<SealedPayload> {
  const p = info.program;
  const { camera, videos } = primaryVideos(ctx, s, info.id);
  const limitFrames = p.time_limit_s * FPS;
  const recorded = camera ? Math.ceil(recordedSessionMs(s, info.id, camera) / 100) : 0;
  const nFrames = Math.max(1, Math.min(limitFrames + TAIL_FRAMES, recorded > 0 ? recorded : limitFrames + TAIL_FRAMES));
  const needPose = JSON.stringify(p.legs).match(/"op":"(standing|rep_count)"/) !== null;
  const pair = await ctx.providers.perception.runPair({
    bet: info.id,
    program: p,
    calibration: c,
    offset_ms: camera ? offsetOf(camera) : 0,
    video_urls: videos,
    prompts: p.entities.filter((e) => e.kind !== 'region').map((e) => ({ entity: e.name, phrase: e.kind === 'object' ? e.phrase : 'person' })),
    need_pose: needPose,
    need_reid: anyActorBound(p),
    seed: perceptionSeed(info.id),
  });
  let a = hostSession(pair.a, p, c, nFrames);
  let b = hostSession(pair.b, p, c, nFrames);

  const transcripts = await audioTranscripts(ctx, s, info.id);
  const templates = anyActorBound(p) ? candidateTemplates(ctx, info) : null;
  let timeline: FusedTimeline | null = null;
  let voice: ObservationSet = { observations: [], observed: new Map() };
  if (templates) {
    const P = p.participants.length;
    const M = Math.max(P, info.candidates.length);
    voice = await voiceObservations(ctx, info, transcripts, templates, a.n_frames);
    const bind = (h: PerceptionHostResult, sess: SessionTracks): { sess: SessionTracks; tl: FusedTimeline } => {
      if (!h.raw) return { sess, tl: timelineFromSession(p, sess, M) };
      const meta = { width_px: c?.scene.camera.width_px ?? 1920, height_px: c?.scene.camera.height_px ?? 1080, n_frames: sess.n_frames, model_hash: h.model_hash, flags: h.flags, program: p, calibration: c };
      const persons = quantizePersonTracks(h.raw, meta);
      const tl = fuseTimeline(persons, voice.observations, [], M, P, sess.n_frames);
      return { sess: bindPersons(sess, persons, tl, p), tl };
    };
    const ba = bind(pair.a, a);
    a = ba.sess;
    timeline = ba.tl;
    b = bind(pair.b, b).sess;
  }

  const phones = phoneDetections(ctx, s, info.id);
  const cross = crossCheck(a, b, p, c, phones);
  const sealed = sealSession(a, cross);
  const full = fullSessionEval(p, c, sealed);

  let proofs: ProofPlan[] = [];
  let provable: Checkpoint[] = [];
  if (templates && timeline && full.checkpoints.length > 0) {
    const faces = pair.a.raw ? { observations: [], observed: new Map() } : await mockFaceObservations(ctx, info, sealed, full.checkpoints, templates);
    const obs: ObservationSet = {
      observations: [...faces.observations, ...voice.observations],
      observed: new Map([...faces.observed, ...voice.observed]),
    };
    ({ plans: proofs, provable } = planProofs(timeline, obs, full.checkpoints, templates));
  }

  const audio = audioCrossCheck(decisiveEvents(p, c, sealed, full), transcripts.map((t) => t.events));
  const extracted = extractDecisiveWindows(p, c, sealed, provable);
  let buffer: TrackBufferData = extracted ?? windowUnavailableBuffer(p, sealed);
  buffer = { ...buffer, flags: buffer.flags | audio.flag };
  const programBin = encodeProgram(p);
  const calibrationBin = encodeCalibration(c, p);
  let trackBin = encodeTrackBin(buffer);
  let windowUnavailable = extracted === null;
  if (programBin.length + calibrationBin.length + trackBin.length > MAX_BUFFER_PAYLOAD) {
    buffer = { ...windowUnavailableBuffer(p, sealed), flags: windowUnavailableBuffer(p, sealed).flags | audio.flag };
    trackBin = encodeTrackBin(buffer);
    windowUnavailable = true;
  }
  const expected = evaluate(programBin, calibrationBin, trackBin, provable);
  return {
    payload: buildPayload(programBin, calibrationBin, trackBin),
    program_len: programBin.length,
    calibration_len: calibrationBin.length,
    perception_root: perceptionRoot(sealed),
    flags: buffer.flags,
    model_hash: sealed.model_hash,
    window_unavailable: windowUnavailable,
    audio_disagree: audio.audio_disagree,
    phone_disagree: (sealed.flags & TRACK_FLAG_PHONE_DISAGREE) !== 0,
    hosts: [hostInfo(pair.a), hostInfo(pair.b)],
    cross,
    n_frames: sealed.n_frames,
    proofs,
    expected: summarize(expected),
    sealed,
  };
}

function sealAiJudged(info: BetInfo): SealedPayload {
  const p = info.program;
  const programBin = encodeProgram(p);
  const calibrationBin = encodeCalibration(null, p);
  const buffer: TrackBufferData = { flags: AI_JUDGED_TRACK_FLAGS, model_hash: ZERO_HASH_HEX, tracks: [], segments: [] };
  const trackBin = encodeTrackBin(buffer);
  return {
    payload: buildPayload(programBin, calibrationBin, trackBin),
    program_len: programBin.length,
    calibration_len: calibrationBin.length,
    perception_root: ZERO_HASH_HEX,
    flags: AI_JUDGED_TRACK_FLAGS,
    model_hash: null,
    window_unavailable: false,
    audio_disagree: false,
    phone_disagree: false,
    hosts: [],
    cross: null,
    n_frames: 0,
    proofs: [],
    expected: summarize(evaluate(programBin, calibrationBin, trackBin, [])),
    sealed: null,
  };
}

/** Market resolutions from the Gemini provider (§11.4, D-16); unresolved legs are omitted (VOID → panel). */
export async function marketEntries(ctx: AppContext, p: Program): Promise<{ entries: MarketBinEntry[]; resolved: boolean }> {
  const entries: MarketBinEntry[] = [];
  let resolved = true;
  for (const leg of p.legs) {
    const m = leg.market;
    if (!m) continue;
    const ev = await ctx.providers.gemini.getEvent(m.event_id);
    const r = ev?.resolution?.find((x) => x.contract_id === m.contract_id);
    if (!ev || ev.status !== 'resolved' || !r) {
      resolved = false;
      continue;
    }
    const hash = marketHash(m.event_id, m.contract_id);
    if (entries.some((e) => e.market_hash === hash)) continue;
    entries.push({ market_hash: hash, result: r.result === 'yes' ? 1 : r.result === 'no' ? 0 : 2 });
  }
  return { entries, resolved };
}

async function sealMarket(ctx: AppContext, info: BetInfo): Promise<SealedPayload> {
  const p = info.program;
  const programBin = encodeProgram(p);
  const calibrationBin = encodeCalibration(null, p);
  const { entries } = await marketEntries(ctx, p);
  const marketBin = encodeMarketBin(entries);
  return {
    payload: buildPayload(programBin, calibrationBin, marketBin),
    program_len: programBin.length,
    calibration_len: calibrationBin.length,
    perception_root: ZERO_HASH_HEX,
    flags: 0,
    model_hash: null,
    window_unavailable: false,
    audio_disagree: false,
    phone_disagree: false,
    hosts: [],
    cross: null,
    n_frames: 0,
    proofs: [],
    expected: summarize(evaluate(programBin, calibrationBin, marketBin, [])),
    sealed: null,
  };
}

export async function sealBet(ctx: AppContext, s: LifecycleStores, info: BetInfo, c: Calibration | null): Promise<SealedPayload> {
  switch (info.program.kind) {
    case 'rules':
      return sealRules(ctx, s, info, c);
    case 'ai_judged':
      return sealAiJudged(info);
    case 'market':
      return sealMarket(ctx, info);
  }
}
