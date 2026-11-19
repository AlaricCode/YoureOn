// The Dance Off upload (DANCE-OFF §5): POST /v1/bets/:id/attempts/:n/dance, multipart `upload`
// (DanceUpload JSON) + `frame` × the key-frame JPEGs. Pure: the screen reads the snapshot files
// (dance/fs readFileBytes) and hands the bytes in, so this builder is testable in node. Every
// frame's sha256 is recomputed here from the bytes the server will receive (the native hash is
// only a cross-check), and the whole upload is parsed with the shared schema before it leaves.
import {
  DANCE_FRAME_MAX_BYTES,
  DANCE_MAX_KEY_FRAMES,
  DanceUpload,
} from '@youre-on/shared/evidence';
import { poseSha256, type PoseSeries } from '@youre-on/shared/dance/pose';
import { routineSha256, type RoutineData } from '@youre-on/shared/dance/routine';
import type { DanceRoundResult } from '@youre-on/shared/dance/score';
import { sha256Hex } from '@youre-on/shared/primitives';

/** What the bet flow sends (multipart): the JSON part and the JPEG parts, in index order. */
export type DanceUploadBundle = {
  upload: DanceUpload;
  frames: {
    index: number;
    bytes: Uint8Array;
    sha256: string;
    t_ms: number;
    width: number;
    height: number;
  }[];
};

/** A native snapshot (modules/dance-pose DanceSnapshot) with its file read. */
export interface SnapshotBytes {
  t_ms: number;
  width: number;
  height: number;
  bytes: Uint8Array;
  /** The native module's hash, if any (checked against the recomputed one). */
  sha256?: string;
}

export type BuildUploadResult =
  | { ok: true; bundle: DanceUploadBundle; hashMismatch: boolean }
  | { ok: false; reason: 'no_frames' | 'invalid'; detail: string };

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_SIDE = 4096;

/** Snapshots that can be uploaded: non-empty, ≤ 200 KB, sane size; in time order, at most 6. */
export function usableSnapshots(snaps: readonly SnapshotBytes[]): SnapshotBytes[] {
  return snaps
    .filter(
      (s) =>
        s.bytes.length >= 1 &&
        s.bytes.length <= DANCE_FRAME_MAX_BYTES &&
        Number.isInteger(s.width) &&
        Number.isInteger(s.height) &&
        s.width >= 1 &&
        s.height >= 1 &&
        s.width <= MAX_SIDE &&
        s.height <= MAX_SIDE &&
        Number.isFinite(s.t_ms),
    )
    .slice()
    .sort((a, b) => a.t_ms - b.t_ms)
    .slice(0, DANCE_MAX_KEY_FRAMES);
}

export function buildDanceUploadBundle(input: {
  routine: RoutineData;
  series: PoseSeries;
  result: DanceRoundResult;
  clipSha256: string | null;
  snapshots: readonly SnapshotBytes[];
}): BuildUploadResult {
  const snaps = usableSnapshots(input.snapshots);
  if (snaps.length === 0) return { ok: false, reason: 'no_frames', detail: 'no key frame' };
  let hashMismatch = false;
  const frames = snaps.map((s, index) => {
    const sha256 = sha256Hex(s.bytes);
    if (s.sha256 !== undefined && s.sha256 !== sha256) hashMismatch = true;
    return {
      index,
      bytes: s.bytes,
      sha256,
      t_ms: Math.max(0, Math.round(s.t_ms)),
      width: s.width,
      height: s.height,
    };
  });
  const raw = {
    routine_id: input.routine.id,
    routine_sha256: routineSha256(input.routine),
    series: input.series,
    pose_sha256: poseSha256(input.series),
    client_scores: { a: input.result.a.score_x10, b: input.result.b.score_x10 },
    clip_sha256:
      input.clipSha256 !== null && HEX64.test(input.clipSha256) ? input.clipSha256 : null,
    frames: frames.map((f) => ({
      index: f.index,
      t_ms: f.t_ms,
      sha256: f.sha256,
      width: f.width,
      height: f.height,
      bytes: f.bytes.length,
    })),
  };
  const parsed = DanceUpload.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? issue.path.map(String).join('.') : '';
    return { ok: false, reason: 'invalid', detail: `${where}: ${issue?.message ?? 'invalid'}` };
  }
  return { ok: true, bundle: { upload: parsed.data, frames }, hashMismatch };
}

/**
 * Reads each snapshot file with `read` (the expo-file-system adapter in the app). A file that
 * fails to read is left out; the builder then uploads the rest (it needs at least one).
 */
export async function readSnapshots(
  snaps: readonly { t_ms: number; uri: string; width: number; height: number; sha256: string }[],
  read: (uri: string) => Promise<Uint8Array>,
): Promise<SnapshotBytes[]> {
  const out: SnapshotBytes[] = [];
  for (const s of snaps) {
    try {
      const bytes = await read(s.uri);
      out.push({ t_ms: s.t_ms, width: s.width, height: s.height, bytes, sha256: s.sha256 });
    } catch {
      // Missing or unreadable: skip it.
    }
  }
  return out;
}
