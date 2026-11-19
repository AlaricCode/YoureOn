// The Simulator's sample Dance Off round (the bet round, not just Diagnostics): the iOS Simulator
// has no camera, so the recording phone can't film; with two simulators that left the display
// phone, the go_at sync and the ruling untestable end to end. In its place this feeds the round
// engine (../useDanceRound) synthetic poses through the same onPoses path the native view uses,
// and stands in for the native view's handle (startRound / stopRound with key-frame JPEGs):
//   A  follows the routine closely (80 ms late, a little jitter), on the left;
//   B  lags 650 ms and stops dancing halfway through, on the right;
// so A wins on the shared scorer, and the normal round flow runs unchanged: POST /attempts, the
// count-in from go_at, "recording", local scoring, the upload, the server's re-score and ruling
// (as scripts/cp1-drive.ts dancer() does from a laptop, here through the live pipeline). Key frames are a tiny valid 16 × 16 JPEG
// with a comment naming the frame (the cp1-drive frame).
//
// Never on a real phone: ../../device/simulator gates it on the app's container path (anti-cheat;
// the server re-scores every series anyway). Pure TS: tested in node.
import type { RoutineData } from '@youre-on/shared/dance/routine';
import { sha256Hex } from '@youre-on/shared/primitives';

import type {
  DancePoseHandle,
  DanceSnapshot,
  PoseFrameEvent,
  StopRoundResult,
} from '../../../modules/dance-pose/src/types';
import { base64ToBytes } from '../../net/encoding';
import { referencePoseAt } from './reference';

/** Synthetic pose rate. */
export const SIM_FPS = 20;
export const SIM_FRAME_MS = 1000 / SIM_FPS;
/** Each dancer: the reference figure at this size, this far from the middle (normalized x). */
const SCALE = 0.5;
const SIDE_SHIFT = 0.22;
/** Pose noise (normalized), about what Apple Vision jitters by. */
const JITTER = 0.0025;
/** A's lag behind the reference; B's, and where B stops (a fraction of the routine). */
const A_LAG_MS = 80;
const B_LAG_MS = 650;
const B_STOPS_AT = 0.5;

/** A tiny valid JPEG (16 × 16, baseline), as scripts/cp1-drive.ts BASE_JPEG. */
const BASE_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAASABIAAD/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL' +
  '/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJico' +
  'KSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKz' +
  'tLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAEC' +
  'AwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYk' +
  'NOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJma' +
  'oqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwAGBgYGBgYKBgYK' +
  'DgoKCg4SDg4ODhIXEhISEhIXHBcXFxcXFxwcHBwcHBwcIiIiIiIiJycnJycsLCwsLCwsLCws/9sAQwEHBwcLCgsTCgoT' +
  'Lh8aHy4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4u/90ABAAB/9oADAMBAAIR' +
  'AxEAPwDzyHQv9mtOHQv9mvUYdC/2a04dC/2aXCuefDqa1+I/M//Z';
let baseJpeg: Uint8Array | null = null;

/** One key frame: the base JPEG with a COM segment naming it, so each frame hashes apart. */
export function simJpeg(tag: string): Uint8Array {
  baseJpeg ??= base64ToBytes(BASE_JPEG_B64);
  // ASCII only (the tag is ours): no TextEncoder needed.
  const text = `yo-sim ${tag}`.slice(0, 200);
  const com = Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0x7f);
  const len = com.length + 2;
  const out = new Uint8Array(baseJpeg.length + 4 + com.length);
  out.set(baseJpeg.subarray(0, 2), 0); // SOI
  out.set([0xff, 0xfe, (len >> 8) & 0xff, len & 0xff], 2);
  out.set(com, 6);
  out.set(baseJpeg.subarray(2), 6 + com.length);
  return out;
}

/** A small deterministic jitter source (LCG), as cp1-drive. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

/**
 * One dancer's raw pose ([x, y, c] × 19 in [0, 1]) at round time `t` (null: before the round,
 * standing in the routine's first pose). A follows, B lags and stops halfway. Each is the
 * reference figure at half size, a side of the frame each (as the dance tests place dancers), so
 * the framing check passes; the scorer is scale- and position-invariant.
 */
export function simPose(
  r: Pick<RoutineData, 'frames' | 'duration_ms'>,
  who: 'A' | 'B',
  t: number | null,
  rnd: () => number,
): number[] {
  const at =
    t === null
      ? 0
      : who === 'A'
        ? t - A_LAG_MS
        : Math.min(t, r.duration_ms * B_STOPS_AT) - B_LAG_MS;
  const k = referencePoseAt(r, Math.max(0, at));
  const dx = who === 'A' ? -SIDE_SHIFT : SIDE_SHIFT;
  for (let j = 0; j < 19; j++) {
    if (k[j * 3 + 2]! <= 0) continue;
    const x = 0.5 + (k[j * 3]! - 0.5) * SCALE + dx + rnd() * JITTER;
    const y = 0.5 + (k[j * 3 + 1]! - 0.5) * SCALE + rnd() * JITTER;
    k[j * 3] = Math.max(0, Math.min(1, x));
    k[j * 3 + 1] = Math.max(0, Math.min(1, y));
  }
  return k;
}

export interface SimPoseSource {
  /** Stands in for the native view's ref (startRound / stopRound / captureStill). */
  handle: DancePoseHandle;
  /** The next onPoses payload at `nowMs` (the round engine's clock). */
  frame(nowMs: number): PoseFrameEvent;
  /** Reads a key frame by the uri stopRound returned (in place of the file reader). */
  read(uri: string): Promise<Uint8Array>;
}

const SIM_URI = 'sim://key-frame/';

/**
 * The sample round's pose source. Clocks as the native view's: `ts` is ms since the session's
 * first frame (always), `t` is ms since the round's first frame while a round runs, else `ts`.
 */
export function createSimPoseSource(
  routine: Pick<RoutineData, 'frames' | 'duration_ms' | 'w' | 'h'>,
  now: () => number,
  seed = 11,
): SimPoseSource {
  const rndA = lcg(seed);
  const rndB = lcg(seed * 3 + 7);
  const sessionAt = now();
  let roundAt: number | null = null;
  let snapshotAtMs: number[] = [];
  const shots = new Map<string, Uint8Array>();
  let runs = 0;
  return {
    handle: {
      async startRound(opts) {
        roundAt = now();
        snapshotAtMs = [...opts.snapshotAtMs];
        runs += 1;
        return { ok: true };
      },
      async stopRound(): Promise<StopRoundResult> {
        if (roundAt === null) return { clipUri: null, clipSha256: null, snapshots: [] };
        const played = now() - roundAt;
        roundAt = null;
        const snapshots: DanceSnapshot[] = snapshotAtMs
          .filter((t) => t <= played)
          .map((t, i) => {
            const bytes = simJpeg(`run ${runs} frame ${i} t ${Math.round(t)}`);
            const uri = `${SIM_URI}${runs}/${i}`;
            shots.set(uri, bytes);
            return {
              t_ms: Math.round(t),
              uri,
              width: 16,
              height: 16,
              bytes: bytes.length,
              sha256: sha256Hex(bytes),
            };
          });
        return { clipUri: null, clipSha256: null, snapshots };
      },
      async captureStill() {
        return { ok: false, message: 'simulator' };
      },
    },
    frame(nowMs) {
      const ts = Math.max(0, nowMs - sessionAt);
      const tRound = roundAt === null ? null : Math.max(0, nowMs - roundAt);
      return {
        t: tRound ?? ts,
        ts,
        w: routine.w,
        h: routine.h,
        fps: SIM_FPS,
        people: [
          { k: simPose(routine, 'A', tRound, rndA) },
          { k: simPose(routine, 'B', tRound, rndB) },
        ],
      };
    },
    async read(uri) {
      const b = shots.get(uri);
      if (!b) throw new Error('no such key frame');
      return b;
    },
  };
}
