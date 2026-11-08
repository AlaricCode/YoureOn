/**
 * `track_bin` (magic "VTRK", §5.4).
 *
 * `encodeTrackBin` validates everything it can without the program (header
 * ranges, segment layout, record constraints); `decodeTrackBin` validates the
 * full contract against the decoded program and throws
 * `EngineError("MalformedTracks")`.
 */
import {
  COORD_MAX,
  ENTITY_KIND_CODE,
  FPS,
  KIND_CODE,
  MAX_EVAL_FRAMES,
  MAX_SEGMENTS,
  NO_PARTICIPANT,
  POSE_REP_HIGH,
  POSE_REP_LOW,
  POSE_RESERVED_MASK,
  TAIL_FRAMES,
  TRACK_FLAG_RESERVED_MASK,
  TRACK_FLAG_WINDOW_UNAVAILABLE,
  TRACK_MAGIC,
  TRACK_RECORD_BYTES,
  TRACK_VERSION,
} from '../constants.js';
import { bytesToHex, isHex32, hexToBytes } from '../hash/bytes.js';
import type { DecodedProgram, QFrame, TrackBufferData, TrackSegment, TrackTableEntry } from '../types.js';
import { EngineError, check } from './errors.js';
import { ByteReader, ByteWriter } from './io.js';

const MT = 'MalformedTracks' as const;

/** The program fields track decoding depends on. */
export type TrackProgramView = Pick<DecodedProgram, 'kind' | 'entities' | 'tracked_entities' | 'time_limit_s'>;

/** How a record must look for a given track kind. */
type TrackKind = 'person' | 'person_any' | 'object' | 'any';

function u(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
}

/**
 * Check a record against §5.4 constraints. `kind` restricts id_conf/pose
 * (`any` = no track-kind restriction, used by the program-less encoder).
 * Returns an error detail or null.
 */
export function recordError(q: QFrame, kind: TrackKind): string | null {
  if (!u(q.x0, 0xffff) || !u(q.y0, 0xffff) || !u(q.x1, 0xffff) || !u(q.y1, 0xffff)) return 'coordinates must be u16';
  if (!u(q.conf, 0xff) || !u(q.fill, 0xff) || !u(q.id_conf, 0xff) || !u(q.pose, 0xff)) return 'conf/fill/id_conf/pose must be u8';
  if (q.conf > 100) return `conf ${q.conf} > 100`;
  if (q.conf === 0) {
    if (q.x0 || q.y0 || q.x1 || q.y1 || q.fill || q.id_conf || q.pose) return 'absent record (conf 0) with non-zero fields';
    return null;
  }
  if (!(q.x0 <= q.x1 && q.x1 <= COORD_MAX)) return 'x0 <= x1 <= 10000 violated';
  if (!(q.y0 <= q.y1 && q.y1 <= COORD_MAX)) return 'y0 <= y1 <= 10000 violated';
  if (q.fill > 100) return `fill ${q.fill} > 100`;
  if (q.id_conf > 100) return `id_conf ${q.id_conf} > 100`;
  if (q.pose & POSE_RESERVED_MASK) return 'pose bits 3-7 set';
  if (q.pose & POSE_REP_LOW && q.pose & POSE_REP_HIGH) return 'pose rep_low and rep_high both set';
  if (kind !== 'any' && kind !== 'person' && q.id_conf !== 0) return 'id_conf on a non-person track';
  if (kind === 'object' && q.pose !== 0) return 'pose on an object track';
  return null;
}

function writeRecord(w: ByteWriter, q: QFrame | null): void {
  if (q === null) {
    for (let i = 0; i < TRACK_RECORD_BYTES; i++) w.u8(0);
    return;
  }
  w.u16(q.x0).u16(q.y0).u16(q.x1).u16(q.y1).u8(q.conf).u8(q.fill).u8(q.id_conf).u8(q.pose);
}

/** Encode TrackBufferData as track_bin (§5.4). Throws `EngineError("MalformedTracks")` on invalid input. */
export function encodeTrackBin(t: TrackBufferData): Uint8Array {
  const fail = (d: string): never => {
    throw new EngineError(MT, d);
  };
  if (!u(t.flags, 0xff) || t.flags & TRACK_FLAG_RESERVED_MASK) fail('flags bits 5-7 must be 0');
  if (!isHex32(t.model_hash)) fail('model_hash must be 64-char lowercase hex');
  const T = t.tracks.length;
  const S = t.segments.length;
  if (T > 0xff) fail(`T=${T} exceeds 255`);
  if (S > MAX_SEGMENTS) fail(`S=${S} exceeds ${MAX_SEGMENTS}`);
  const w = new ByteWriter(64 + 4 * T + 8 * S);
  w.bytes(TRACK_MAGIC).u8(TRACK_VERSION).u8(FPS).u8(T).u8(S).u8(t.flags).u8(0).u8(0).u8(0);
  w.bytes(hexToBytes(t.model_hash));
  t.tracks.forEach((tr: TrackTableEntry, j) => {
    if (!u(tr.entity_idx, 0xff)) fail(`tracks[${j}].entity_idx must be u8`);
    if (tr.participant_idx !== null && !u(tr.participant_idx, 0xfe)) fail(`tracks[${j}].participant_idx invalid`);
    if (!u(tr.ref_h, 0xffff)) fail(`tracks[${j}].ref_h must be u16`);
    w.u8(tr.entity_idx).u8(tr.participant_idx ?? NO_PARTICIPANT).u16(tr.ref_h);
  });
  let nextMin = 0;
  t.segments.forEach((s: TrackSegment, i) => {
    const n = s.frames.length;
    if (!u(s.frame_start, 0xffffffff)) fail(`segments[${i}].frame_start must be u32`);
    if (n < 1 || n > 0xffff) fail(`segments[${i}] must have 1..65535 frames`);
    if (s.frame_start < nextMin) fail(`segments[${i}] overlaps or is out of order`);
    nextMin = s.frame_start + n;
    w.u32(s.frame_start).u16(n).u16(0);
  });
  t.segments.forEach((s, i) => {
    s.frames.forEach((row, f) => {
      if (row.length !== T) fail(`segments[${i}].frames[${f}] must have ${T} records`);
      row.forEach((q, j) => {
        if (q !== null) {
          const err = recordError(q, 'any');
          if (err) fail(`segments[${i}].frames[${f}][${j}]: ${err}`);
        }
        writeRecord(w, q);
      });
    });
  });
  return w.finish();
}

function trackKind(program: TrackProgramView, entityIdx: number): TrackKind {
  switch (program.entities[entityIdx]!.kind) {
    case ENTITY_KIND_CODE.person:
      return 'person';
    case ENTITY_KIND_CODE.person_any:
      return 'person_any';
    default:
      return 'object';
  }
}

/**
 * Parse a track_bin starting at `start`; the record section must end exactly at
 * the end of `bin`.
 */
export function readTrackBin(bin: Uint8Array, program: TrackProgramView, start = 0): TrackBufferData {
  check(program.kind !== KIND_CODE.market, MT, 'market programs use market_bin');
  const r = new ByteReader(bin, MT, start);
  const magic = r.bytes(4, 'magic');
  check(magic.every((b, i) => b === TRACK_MAGIC[i]), MT, 'bad magic');
  check(r.u8('version') === TRACK_VERSION, MT, 'bad version');
  check(r.u8('fps') === FPS, MT, 'bad fps');
  const T = r.u8('T');
  const S = r.u8('S');
  const flags = r.u8('flags');
  const res0 = r.u8('reserved');
  const res1 = r.u8('reserved');
  const res2 = r.u8('reserved');
  check(res0 === 0 && res1 === 0 && res2 === 0, MT, 'reserved header bytes must be 0');
  check((flags & TRACK_FLAG_RESERVED_MASK) === 0, MT, 'flag bits 5-7 set');
  const model_hash = bytesToHex(r.bytes(32, 'model_hash'));

  const expected = program.tracked_entities;
  check(T === expected.length, MT, `T=${T} but the program references ${expected.length} tracked entities`);
  const tracks: TrackTableEntry[] = [];
  const kinds: TrackKind[] = [];
  for (let j = 0; j < T; j++) {
    const entity_idx = r.u8('track entity_idx');
    const pidx = r.u8('track participant_idx');
    const ref_h = r.u16('track ref_h');
    check(entity_idx === expected[j], MT, `track ${j}: entity ${entity_idx}, expected ${expected[j]}`);
    const ent = program.entities[entity_idx]!;
    const wantP = ent.kind === ENTITY_KIND_CODE.person ? ent.param : NO_PARTICIPANT;
    check(pidx === wantP, MT, `track ${j}: participant_idx ${pidx}, expected ${wantP}`);
    tracks.push({ entity_idx, participant_idx: pidx === NO_PARTICIPANT ? null : pidx, ref_h });
    kinds.push(trackKind(program, entity_idx));
  }

  check(S <= MAX_SEGMENTS, MT, `S=${S} exceeds ${MAX_SEGMENTS}`);
  const windowUnavailable = (flags & TRACK_FLAG_WINDOW_UNAVAILABLE) !== 0;
  // §5.4: "S = 0 unless bit3 is set or the program is ai_judged"; "S ≠ 0 when bit3 is set".
  // ai_judged buffers may carry (T = 0) segments: the rejection list does not forbid
  // them and crates/verdict-rules accepts them (the result is reason 11 either way).
  if (windowUnavailable) check(S === 0, MT, 'S != 0 with window_unavailable set');
  else if (program.kind !== KIND_CODE.ai_judged) check(S > 0, MT, 'S = 0 without window_unavailable');

  const frameEnd = program.time_limit_s * FPS + TAIL_FRAMES;
  const segHeads: { frame_start: number; n: number }[] = [];
  let total = 0;
  let nextMin = 0;
  for (let i = 0; i < S; i++) {
    const frame_start = r.u32('frame_start');
    const n = r.u16('n_frames');
    const reserved = r.u16('segment reserved');
    check(n >= 1, MT, `segment ${i}: n_frames = 0`);
    check(reserved === 0, MT, `segment ${i}: reserved must be 0`);
    check(frame_start >= nextMin, MT, `segment ${i}: not strictly ascending / overlaps`);
    nextMin = frame_start + n;
    check(nextMin <= frameEnd, MT, `segment ${i}: frame >= LIMIT + TAIL_FRAMES`);
    total += n;
    check(total <= MAX_EVAL_FRAMES, MT, `sum n_frames exceeds ${MAX_EVAL_FRAMES}`);
    segHeads.push({ frame_start, n });
  }

  check(r.remaining === TRACK_RECORD_BYTES * T * total, MT, `record section is ${r.remaining} bytes, expected ${TRACK_RECORD_BYTES * T * total}`);
  const segments: TrackSegment[] = [];
  for (const { frame_start, n } of segHeads) {
    const frames: (QFrame | null)[][] = [];
    for (let f = 0; f < n; f++) {
      const row: (QFrame | null)[] = [];
      for (let j = 0; j < T; j++) {
        const q: QFrame = {
          x0: r.u16(),
          y0: r.u16(),
          x1: r.u16(),
          y1: r.u16(),
          conf: r.u8(),
          fill: r.u8(),
          id_conf: r.u8(),
          pose: r.u8(),
        };
        const err = recordError(q, kinds[j]!);
        check(err === null, MT, `frame ${frame_start + f}, track ${j}: ${err}`);
        row.push(q.conf === 0 ? null : q);
      }
      frames.push(row);
    }
    segments.push({ frame_start, frames });
  }
  r.expectEnd('records');
  return { flags, model_hash, tracks, segments };
}

/** Decode and validate track_bin against a decoded program (§5.4). */
export function decodeTrackBin(bin: Uint8Array, program: TrackProgramView): TrackBufferData {
  return readTrackBin(bin, program, 0);
}
