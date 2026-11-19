// Face assignment on the recording phone (DANCE-OFF §3), the pure half: which detected face in a
// still belongs to which person of the pose frame it was taken from, which faces are worth
// sending, and what the server's answer means for A and B. No native modules, tested in node.
//
//   still (captureStill, the frame with `ts`) + that frame's people
//     -> associateFaces: each face box to the nearest person's head (nose / eyes / ears, else the
//        neck), one face per person, within a few face sizes
//     -> facesToSend: the faces on the two framed players only (never a third person's)
//     -> POST …/dance/identify -> resolveIdentity: A and B as person indices, only when BOTH were
//        identified, as two different people who are the two framed players; else null (the
//        left / right rule).
import { JOINT } from '@youre-on/shared/dance/joints';

/** A face box, normalized to the still (x, y, width, height in [0, 1], top-left origin). */
export interface NormBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const FACE_ID = {
  /** Head joints at least this confident place the head (the tracker's TRACK_CONF). */
  HEAD_CONF: 0.3,
  /** A face belongs to a head within this many face sizes of the face centre… */
  ASSOC_MAX_FACES: 1.5,
  /** …and never farther than this (aspect-correct units, x·w/h and y), however big the box. */
  ASSOC_MAX: 0.12,
  /** Faces per identify call (the server's DANCE_IDENTIFY_MAX_FACES). */
  MAX_FACES: 4,
} as const;

const HEAD_JOINTS = [
  JOINT.nose,
  JOINT.leftEye,
  JOINT.rightEye,
  JOINT.leftEar,
  JOINT.rightEar,
] as const;

const c = (k: readonly number[], j: number) => k[j * 3 + 2] ?? 0;

/** The head's centre: the mean of the confident face joints, else the neck; null without either. */
export function headPoint(k: readonly number[]): [number, number] | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const j of HEAD_JOINTS) {
    if (c(k, j) < FACE_ID.HEAD_CONF) continue;
    sx += k[j * 3]!;
    sy += k[j * 3 + 1]!;
    n++;
  }
  if (n > 0) return [sx / n, sy / n];
  if (c(k, JOINT.neck) >= FACE_ID.HEAD_CONF) return [k[JOINT.neck * 3]!, k[JOINT.neck * 3 + 1]!];
  return null;
}

/**
 * For each face, the index of the person whose head it is, or null. Pairs are taken nearest first
 * (greedy), so a person gets at most one face and a face one person; a pair counts only within
 * ASSOC_MAX_FACES face sizes (and ASSOC_MAX) of the face centre. `aspect` = still width / height.
 */
export function associateFaces(
  faces: readonly NormBox[],
  people: readonly (readonly number[])[],
  aspect: number,
): (number | null)[] {
  const heads = people.map(headPoint);
  const pairs: { f: number; p: number; d: number }[] = [];
  faces.forEach((b, f) => {
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const size = Math.max(b.width * aspect, b.height);
    const max = Math.min(FACE_ID.ASSOC_MAX, FACE_ID.ASSOC_MAX_FACES * size);
    heads.forEach((h, p) => {
      if (!h) return;
      const dx = (h[0] - cx) * aspect;
      const dy = h[1] - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= max) pairs.push({ f, p, d });
    });
  });
  pairs.sort((x, y) => x.d - y.d || x.f - y.f || x.p - y.p);
  const out: (number | null)[] = faces.map(() => null);
  const taken = new Set<number>();
  for (const { f, p } of pairs) {
    if (out[f] !== null || taken.has(p)) continue;
    out[f] = p;
    taken.add(p);
  }
  return out;
}

/**
 * The faces to send: those on the two framed players (`players`: their person indices), in face
 * order, at most MAX_FACES. Each entry keeps the face's index in the still and its person.
 */
export function facesToSend(
  owners: readonly (number | null)[],
  players: { a: number; b: number },
): { face: number; person: number }[] {
  const out: { face: number; person: number }[] = [];
  owners.forEach((p, face) => {
    if (p === null || (p !== players.a && p !== players.b)) return;
    if (out.length < FACE_ID.MAX_FACES) out.push({ face, person: p });
  });
  return out;
}

/** The server's answer (DanceIdentifyResponse.assignments): `face_index` indexes the sent list. */
export interface IdentifyAssignment {
  face_index: number;
  party: 'A' | 'B';
}

/**
 * A and B as person indices of the still's frame, when both players were identified, as two
 * different people who are the two framed players; null otherwise (the left / right rule).
 */
export function resolveIdentity(
  assignments: readonly IdentifyAssignment[],
  sent: readonly { person: number }[],
  players: { a: number; b: number },
): { aPerson: number; bPerson: number } | null {
  let aPerson: number | null = null;
  let bPerson: number | null = null;
  for (const x of assignments) {
    const person = sent[x.face_index]?.person;
    if (person === undefined) return null;
    if (x.party === 'A') {
      if (aPerson !== null) return null;
      aPerson = person;
    } else {
      if (bPerson !== null) return null;
      bPerson = person;
    }
  }
  if (aPerson === null || bPerson === null || aPerson === bPerson) return null;
  const framed = new Set([players.a, players.b]);
  if (!framed.has(aPerson) || !framed.has(bPerson)) return null;
  return { aPerson, bPerson };
}

/** A detector face box in still pixels → normalized to the still. */
export function normalizeBox(
  b: { x: number; y: number; width: number; height: number },
  still: { width: number; height: number },
): NormBox {
  return {
    x: b.x / still.width,
    y: b.y / still.height,
    width: b.width / still.width,
    height: b.height / still.height,
  };
}
