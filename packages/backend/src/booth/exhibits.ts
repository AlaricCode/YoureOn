/**
 * §10.1 exhibit builder. Exhibits are built from the decisive windows only
 * (never the whole video) and each footage exhibit carries chain proofs that
 * tie its chunks to the final `Bet.evidence_root`:
 *   links = the chunk records from the first used chunk to the witness head,
 *   prev  = c_{from-1} (omitted when from_index = 0, prev = G_w),
 *   head_proof = merkle proof of leaf_w (§7.4) in evidence_root.
 * Every proof is self-checked with engine.verifyExhibitChainProof before it
 * is published.
 */
import {
  BET_FLAG_AI_JUDGED,
  BET_FLAG_ANY_ACTOR_BOUND,
  EXHIBIT_EXTRA_CLIP_MS,
  EXHIBIT_EXTRA_CLIPS,
  EXHIBIT_PAD_MS,
  EXHIBIT_TAIL_MS,
  FRAME_MS,
  HEAD_INDEX_NONE,
  TRACK_FLAG_AUDIO_DISAGREE,
  TRACK_FLAG_CAMERA_MOTION,
  TRACK_FLAG_CROSS_CHECK_OK,
  TRACK_FLAG_PHONE_DISAGREE,
  TRACK_FLAG_WINDOW_UNAVAILABLE,
  evaluate,
  evidenceHeadProof,
  hexToBytes,
  splitPayload,
  verifyExhibitChainProof,
  type BetAccount,
  type ChainLink,
  type Exhibit,
  type ExhibitChainProof,
  type ExhibitKind,
  type TrackBufferAccount,
  type TrackBufferData,
  type WitnessHead,
} from '@verdict/engine';
import type { BetArtifacts, ChunkMeta, PerceptionMeta, WitnessMeta } from '../integration/sources.js';
import type { Transcript } from '../providers/types.js';
import { cutAudio, cutClip, joinAudio, type CutResult, type LoadedChunk, type Span } from './media.js';

export const WITNESS_KIND_CODE = { camera: 0, audio: 1, detections: 2 } as const;

export interface ExhibitBuildInput {
  betId: string;
  bet: BetAccount;
  buffer: TrackBufferAccount | null;
  artifacts: BetArtifacts | null;
  /** registration metadata (offsets, owners); witness order comes from the Bet */
  witnessMeta: WitnessMeta[];
  perception: PerceptionMeta | null;
  chunks(witnessKey: string): ChunkMeta[];
  loadBody(witnessKey: string, index: number): Uint8Array | null;
  /** stores the exhibit bytes, returns sha256 hex */
  store(eid: string, bytes: Uint8Array): string;
  transcribe?: (wav: Uint8Array) => Promise<Transcript>;
  /** dispute reason 3: fresh perception pair → `rerun` exhibit body (null: not available) */
  rerun?: () => Promise<unknown | null>;
  log?: { warn: (o: unknown, msg?: string) => void };
}

/** One registered witness as fixed in `start` (Bet order). */
export interface BetWitness {
  index: number;
  key: string;
  kind: number;
  /** "cam1" / "mic1" / "det1" */
  label: string;
  head: WitnessHead;
}

/** Witnesses in Bet order, labelled per kind (§10.1 "cam1".."cam8" / "mic1".."mic8"). */
export function betWitnesses(bet: BetAccount): BetWitness[] {
  const counters = [0, 0, 0];
  const prefix = ['cam', 'mic', 'det'];
  const out: BetWitness[] = [];
  for (let i = 0; i < bet.n_witnesses; i++) {
    const kind = bet.witness_kinds[i]!;
    const k = kind <= 2 ? kind : 2;
    counters[k]!++;
    out.push({
      index: i,
      key: bet.witnesses[i]!,
      kind,
      label: `${prefix[k]}${counters[k]}`,
      head: { witness_key: bet.witnesses[i]!, index: bet.witness_heads[i]!, hash: hexToBytes(bet.witness_head_hashes[i]!) },
    });
  }
  return out;
}

export interface DecodedBuffer {
  tracks: TrackBufferData | null;
  decisive_frames: number[];
  flags: number | null;
}

/** Decodes the finalized TrackBuffer and evaluates it (verified = Bet.bio) for the decisive frames. */
export function decodeBuffer(bet: BetAccount, buffer: TrackBufferAccount | null): DecodedBuffer {
  if (!buffer || buffer.header.finalized !== 1) return { tracks: null, decisive_frames: [], flags: null };
  try {
    const parts = splitPayload(buffer.payload.subarray(0, buffer.header.written));
    if (!parts.tracks || !parts.tracks_bin) return { tracks: null, decisive_frames: [], flags: null };
    const verified = bet.bio.slice(0, bet.n_bio).map((b) => ({ participant: b.participant, frame: b.frame }));
    const r = evaluate(parts.program_bin, parts.calibration_bin, parts.tracks_bin, verified);
    const frames = [...new Set(r.decisive_frames.flat())].sort((a, b) => a - b);
    return { tracks: parts.tracks, decisive_frames: frames, flags: parts.tracks.flags };
  } catch {
    return { tracks: null, decisive_frames: [], flags: null };
  }
}

/** Merges overlapping spans (sorted). */
export function mergeSpans(spans: Span[]): Span[] {
  const s = [...spans].sort((a, b) => a.t_start_ms - b.t_start_ms);
  const out: Span[] = [];
  for (const x of s) {
    const last = out.at(-1);
    if (last && x.t_start_ms <= last.t_end_ms) last.t_end_ms = Math.max(last.t_end_ms, x.t_end_ms);
    else out.push({ ...x });
  }
  return out;
}

/**
 * Exhibit spans (§10.1): `[d·100 − 2000, d·100 + 2000]` per decisive frame
 * (merged when they overlap), else the last 6 s; AI-judged: the last 6 s plus
 * up to 4 evenly spaced 4 s clips over the rest of the session.
 */
export function exhibitSpans(decisiveFrames: number[], sessionEndMs: number, aiJudged: boolean): Span[] {
  const end = Math.max(0, sessionEndMs);
  const tail: Span = { t_start_ms: Math.max(0, end - EXHIBIT_TAIL_MS), t_end_ms: end };
  if (aiJudged) {
    const extra: Span[] = [];
    const room = tail.t_start_ms;
    if (room >= EXHIBIT_EXTRA_CLIP_MS) {
      const n = Math.min(EXHIBIT_EXTRA_CLIPS, Math.floor(room / EXHIBIT_EXTRA_CLIP_MS));
      const step = n > 0 ? (room - EXHIBIT_EXTRA_CLIP_MS) / Math.max(1, n - 1) : 0;
      for (let i = 0; i < n; i++) {
        const s = Math.round(n === 1 ? (room - EXHIBIT_EXTRA_CLIP_MS) / 2 : i * step);
        extra.push({ t_start_ms: s, t_end_ms: s + EXHIBIT_EXTRA_CLIP_MS });
      }
    }
    return [...extra, tail];
  }
  if (decisiveFrames.length === 0) return [tail];
  return mergeSpans(
    decisiveFrames.map((d) => ({ t_start_ms: Math.max(0, d * FRAME_MS - EXHIBIT_PAD_MS), t_end_ms: d * FRAME_MS + EXHIBIT_PAD_MS })),
  );
}

/** Chain proof for chunks `[from .. head]` of one witness; null if a link is missing or it fails to verify. */
export function chainProofFor(betId: string, bet: BetAccount, w: BetWitness, all: BetWitness[], chunks: ChunkMeta[], fromIndex: number): ExhibitChainProof | null {
  if (w.head.index === HEAD_INDEX_NONE || fromIndex > w.head.index) return null;
  const byIndex = new Map(chunks.map((c) => [c.index, c]));
  const links: ChainLink[] = [];
  for (let i = fromIndex; i <= w.head.index; i++) {
    const c = byIndex.get(i);
    if (!c) return null;
    links.push({ index: i, kind: w.kind, start_ms: c.start_ms, duration_ms: c.duration_ms, body_sha256: c.body_sha256 });
  }
  if (fromIndex > 0) {
    const prev = byIndex.get(fromIndex - 1)?.chunk_hash ?? byIndex.get(fromIndex)?.prev_hash ?? null;
    if (!prev) return null;
    links[0]!.prev = prev;
  }
  const proof: ExhibitChainProof = {
    witness: w.label,
    from_index: fromIndex,
    links,
    head_proof: evidenceHeadProof(
      all.map((x) => x.head),
      w.index,
    ),
  };
  const check = verifyExhibitChainProof(proof, {
    witness_key: w.key,
    evidence_root: bet.evidence_root,
    n_witnesses: all.length,
    genesis: { bet: betId, beacon_slot: bet.beacon_slot, beacon_hash: hexToBytes(bet.beacon_hash) },
  });
  return check.ok ? proof : null;
}

export class ExhibitBuilder {
  private readonly exhibits: Exhibit[] = [];
  private readonly witnesses: BetWitness[];
  private readonly loaded = new Map<string, LoadedChunk[]>();

  constructor(private readonly input: ExhibitBuildInput) {
    this.witnesses = betWitnesses(input.bet);
  }

  private offsetOf(key: string): number {
    return this.input.witnessMeta.find((m) => m.witness_key === key)?.offset_ms ?? 0;
  }

  private chunksOf(w: BetWitness): LoadedChunk[] {
    let l = this.loaded.get(w.key);
    if (!l) {
      const off = this.offsetOf(w.key);
      l = [];
      for (const meta of this.input.chunks(w.key)) {
        if (w.head.index !== HEAD_INDEX_NONE && meta.index > w.head.index) continue; // after the final root
        const body = this.input.loadBody(w.key, meta.index);
        if (body) l.push({ meta, body, session_start_ms: meta.start_ms - off });
      }
      this.loaded.set(w.key, l);
    }
    return l;
  }

  /** Session end: the latest chunk end over all witnesses, else ended_at − started_at. */
  sessionEndMs(): number {
    let end = 0;
    for (const w of this.witnesses) for (const c of this.chunksOf(w)) end = Math.max(end, c.session_start_ms + c.meta.duration_ms);
    if (end > 0) return end;
    const d = Number(this.input.bet.ended_at - this.input.bet.started_at) * 1000;
    return d > 0 ? d : EXHIBIT_TAIL_MS;
  }

  private add(kind: ExhibitKind, witness: BetWitness | null, span: Span, bytes: Uint8Array, proofs: ExhibitChainProof[]): Exhibit {
    const id = `E${this.exhibits.length + 1}`;
    const sha256 = this.input.store(id, bytes);
    const e: Exhibit = {
      id,
      kind,
      witness: witness?.label ?? null,
      t_start_ms: span.t_start_ms,
      t_end_ms: span.t_end_ms,
      uri: `/v1/bets/${this.input.betId}/exhibits/${id}`,
      sha256,
      chain_proofs: proofs,
    };
    this.exhibits.push(e);
    return e;
  }

  private addJson(kind: ExhibitKind, witness: BetWitness | null, span: Span, body: unknown): Exhibit {
    return this.add(kind, witness, span, new TextEncoder().encode(JSON.stringify(body)), []);
  }

  private footage(kind: 'clip' | 'audio', w: BetWitness, span: Span, cut: CutResult | null): void {
    if (!cut) return;
    const proof = chainProofFor(this.input.betId, this.input.bet, w, this.witnesses, this.input.chunks(w.key), cut.used[0]!);
    if (!proof) this.input.log?.warn({ bet: this.input.betId, witness: w.label }, 'exhibit chain proof unavailable');
    this.add(kind, w, span, cut.bytes, proof ? [proof] : []);
  }

  async build(): Promise<Exhibit[]> {
    const { bet, artifacts, perception } = this.input;
    const decoded = decodeBuffer(bet, this.input.buffer);
    const aiJudged = (bet.flags & BET_FLAG_AI_JUDGED) !== 0;
    const spans = exhibitSpans(decoded.decisive_frames, this.sessionEndMs(), aiJudged);
    const cams = this.witnesses.filter((w) => w.kind === WITNESS_KIND_CODE.camera);
    const mics = this.witnesses.filter((w) => w.kind === WITNESS_KIND_CODE.audio);

    for (const span of spans) {
      for (const w of cams) this.footage('clip', w, span, cutClip(this.chunksOf(w), span, this.offsetOf(w.key)));
      for (const w of mics) this.footage('audio', w, span, cutAudio(this.chunksOf(w), span));
      if (decoded.tracks && decoded.tracks.tracks.length > 0) this.addJson('tracks', null, span, tracksExcerpt(decoded.tracks, span));
    }

    const full: Span = { t_start_ms: 0, t_end_ms: this.sessionEndMs() };
    if ((bet.flags & BET_FLAG_ANY_ACTOR_BOUND) !== 0 && decoded.tracks) {
      this.addJson('identity', null, full, identityExcerpt(decoded.tracks));
    }

    if (this.input.transcribe) {
      for (const w of mics) {
        const wav = joinAudio(this.chunksOf(w));
        if (!wav) continue;
        try {
          const t = await this.input.transcribe(wav);
          this.addJson('transcript', w, full, { segments: t.segments, audio_events: t.audio_events, text: t.text });
        } catch (e) {
          this.input.log?.warn({ err: e, bet: this.input.betId }, 'booth transcript failed');
        }
      }
    }
    if (!this.exhibits.some((e) => e.kind === 'transcript') && artifacts?.transcript) {
      this.addJson('transcript', null, full, { segments: [], audio_events: [], text: artifacts.transcript, source: 'dictation' });
    }

    this.addJson('program', null, full, {
      yaml: artifacts?.yaml ?? null,
      readback: artifacts?.readback ?? [],
      program_hash: bet.program_hash,
      preruling: {
        code: bet.preruling,
        reason: bet.prerule_reason,
        winner_mask: bet.winner_mask,
        leg_results: bet.leg_results,
      },
    });

    const flags = decoded.flags ?? 0;
    this.addJson('flags', null, full, {
      cross_check_ok: decoded.flags === null ? (perception?.agreed ?? null) : (flags & TRACK_FLAG_CROSS_CHECK_OK) !== 0,
      entity_agreement_bps: perception?.entity_agreement_bps ?? {},
      gap_mask: bet.gap_mask,
      audio_disagree: (flags & TRACK_FLAG_AUDIO_DISAGREE) !== 0 || perception?.audio_disagree === true,
      phone_disagree: (flags & TRACK_FLAG_PHONE_DISAGREE) !== 0 || perception?.phone_disagree === true,
      camera_motion: (flags & TRACK_FLAG_CAMERA_MOTION) !== 0,
      window_unavailable: (flags & TRACK_FLAG_WINDOW_UNAVAILABLE) !== 0,
      dispute_reason: bet.dispute_reason,
    });

    if (bet.dispute_reason === 3 && this.input.rerun) {
      try {
        const r = await this.input.rerun();
        if (r) this.addJson('rerun', null, full, r);
      } catch (e) {
        this.input.log?.warn({ err: e, bet: this.input.betId }, 'booth perception re-run failed');
      }
    }
    return this.exhibits;
  }
}

/** QFrames of every track within the span (frame-major), JSON-friendly. */
export function tracksExcerpt(t: TrackBufferData, span: Span): unknown {
  const f0 = Math.floor(span.t_start_ms / FRAME_MS);
  const f1 = Math.ceil(span.t_end_ms / FRAME_MS);
  const frames: { frame: number; records: unknown[] }[] = [];
  for (const seg of t.segments) {
    seg.frames.forEach((recs, i) => {
      const f = seg.frame_start + i;
      if (f >= f0 && f <= f1) frames.push({ frame: f, records: recs });
    });
  }
  return { fps: 10, model_hash: t.model_hash, flags: t.flags, tracks: t.tracks, frames };
}

/** Stitched person tracks: id_conf only, never embeddings (§10.1). */
export function identityExcerpt(t: TrackBufferData): unknown {
  const persons = t.tracks.map((x, j) => ({ ...x, j })).filter((x) => x.participant_idx !== null);
  return {
    tracks: persons.map((p) => {
      const samples: { frame: number; id_conf: number }[] = [];
      for (const seg of t.segments) {
        seg.frames.forEach((recs, i) => {
          const r = recs[p.j];
          if (r) samples.push({ frame: seg.frame_start + i, id_conf: r.id_conf });
        });
      }
      return { entity_idx: p.entity_idx, participant_idx: p.participant_idx, id_conf: samples };
    }),
  };
}
