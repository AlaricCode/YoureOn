// The ref cam (camera checks) on the projector: the pure half (checks-view.tsx draws it). The
// checks are non-binding (API-CONTRACT §3.4): the server compiles the bet's terms into a
// CheckSpec beside the bet (never in the hashed Terms), runs SAM 3.1 on the attempt's regular
// frames next to the judge, and its veto can only turn a decisive MET into REDO.
//
//   checks.compiled  the terms version's readback ("Ref cam: …"), or judge only. A newer
//                    terms_hash supersedes it; the terms card shows it only while it matches the
//                    envelope on screen (a stale compile never reads back the old terms).
//   checks.report    one attempt's result, sent just before its ruling.issued: each check
//                    ✓ / ✗ / ?, the veto (veto.why is then the ruling's reason, word for word) and
//                    the SAM boxes on the frames the checks cite (frame_size px, xyxy, x1/y1
//                    exclusive). The ruling panel shows it for the ruling's own attempt only.
//
// Older servers send neither event: the slice stays null and nothing is drawn.
import type {
  ChecksBox,
  ChecksCompiledPayload,
  ChecksReportPayload,
  ChecksReportRow,
} from '@youre-on/shared/checks/events';
import type { RealtimeEvent } from '@youre-on/shared/realtime';

export interface ChecksView {
  /** The newest checks.compiled (any terms_hash; see refCamLine). */
  compiled: ChecksCompiledPayload | null;
  /** The newest attempt's checks.report (a later attempt replaces it). */
  report: ChecksReportPayload | null;
}

/** The BetView field this module owns. */
export interface ChecksSlice {
  checks: ChecksView | null;
}

/** Folds checks.compiled / checks.report into the bet's slice (the ticker's foldEvent hook). */
export function foldChecks<T extends ChecksSlice>(v: T, e: RealtimeEvent): T {
  switch (e.type) {
    case 'checks.compiled':
      return { ...v, checks: { compiled: e.payload, report: v.checks?.report ?? null } };
    case 'checks.report': {
      const prev = v.checks?.report ?? null;
      // a replayed older attempt never replaces a newer one
      if (prev && prev.attempt_no > e.payload.attempt_no) return v;
      return { ...v, checks: { compiled: v.checks?.compiled ?? null, report: e.payload } };
    }
    default:
      return v;
  }
}

const OFFLINE_SENTENCE = /\s*If the ref cam is offline, the judge decides alone\.\s*$/;

/**
 * The quiet "Ref cam" line on the terms card: what the camera will check (the readback without
 * its "Ref cam:" lead and its offline footnote), "Judge only" for a judge_only decision, or null
 * when nothing was compiled for the terms on screen.
 */
export function refCamLine(
  checks: ChecksView | null,
  termsHash: string | null | undefined,
): { decision: ChecksCompiledPayload['decision']; text: string } | null {
  const c = checks?.compiled;
  if (!c || !termsHash || c.terms_hash !== termsHash) return null;
  if (c.decision === 'judge_only') return { decision: 'judge_only', text: 'Judge only' };
  const text = c.readback
    .replace(/^\s*Ref cam:\s*/i, '')
    .replace(OFFLINE_SENTENCE, '')
    .trim();
  return { decision: 'checks', text: compactReadback(text) || 'On' };
}

/**
 * "the bottle fully in shot at the end; the bottle comes to rest; the bottle stands upright. Film
 * from the side." -> "the bottle: fully in shot at the end; comes to rest; stands upright. Film
 * from the side." (the shared subject once, as on the ruling line), so the deciding clauses and
 * the filming hint fit the projector's one line. Unchanged when the clauses share no subject.
 */
export function compactReadback(text: string): string {
  const end = text.indexOf('. ');
  const head = end < 0 ? text.replace(/\.$/, '') : text.slice(0, end);
  const tail = end < 0 ? '' : text.slice(end + 1);
  const { subject, labels } = compactLabels(head.split('; '));
  if (subject === null) return text;
  return `${subject}: ${labels.join('; ')}.${tail}`;
}

/** The report for this ruling's attempt (null for another attempt, or none sent). */
export function reportFor(
  checks: ChecksView | null,
  attemptNo: number | null | undefined,
): ChecksReportPayload | null {
  const r = checks?.report;
  return r && attemptNo != null && r.attempt_no === attemptNo ? r : null;
}

export type Mark = '✓' | '✗' | '?' | '–';

/** ✓ true, ✗ false, ? unknown, – abstain (a subject never seen, not counted). */
export function markOf(value: ChecksReportRow['value']): Mark {
  return value === 'true' ? '✓' : value === 'false' ? '✗' : value === 'unknown' ? '?' : '–';
}

/** Why a check came back unknown / false, in a few plain words (null when it simply held). */
const WHY_WORDS: Partial<Record<ChecksReportRow['why'], string>> = {
  absent: 'not seen',
  weak: 'hard to see',
  ambiguous: 'too many look-alikes',
  count_mismatch: 'not all in view',
  clipped: 'cut off at the edge',
  fragmented: 'partly hidden',
  between_bands: 'too close to call',
  single_frame: 'one frame only',
  start_unstable: 'start unclear',
  not_together: 'never seen together',
  unmatched: 'could not track',
  ref_missing: 'reference not seen',
  clip_too_short: 'clip too short',
  never_seen: 'never seen',
  too_few_frames: 'too few frames',
};
export function whyWords(row: Pick<ChecksReportRow, 'value' | 'why'>): string | null {
  if (row.value === 'true' || row.why === 'ok') return null;
  return WHY_WORDS[row.why] ?? null;
}

/**
 * The rows' labels without their shared subject, so a one-line row of marks fits the projector:
 * ["the bottle fully in shot at the end", "the bottle comes to rest", "the bottle stands
 * upright"] -> subject "the bottle", labels ["fully in shot at the end", "comes to rest",
 * "stands upright"]. Only a "the …" subject shared by two or more rows (a spec over two things
 * keeps its full clauses).
 */
export function compactLabels(labels: readonly string[]): {
  subject: string | null;
  labels: string[];
} {
  const words = labels.map((l) => l.trim().split(/\s+/));
  if (words.length < 2 || words.some((w) => w[0]?.toLowerCase() !== 'the'))
    return { subject: null, labels: [...labels] };
  let n = 1;
  while (
    words.every((w) => w.length > n + 1 && w[n] === words[0]![n]) &&
    n < Math.min(...words.map((w) => w.length)) - 1
  )
    n++;
  if (n < 2) return { subject: null, labels: [...labels] };
  return {
    subject: words[0]!.slice(0, n).join(' '),
    labels: words.map((w) => w.slice(n).join(' ')),
  };
}

export const VETO_TITLE: Record<NonNullable<ChecksReportPayload['veto']>['kind'], string> = {
  not_on_camera: 'Not on camera',
  contradicts: 'Camera disagrees',
  unconfirmed: "Camera couldn't confirm",
};

/**
 * The frame to draw the boxes on: the latest boxed frame the stage has an image for, preferring
 * one the deciding row cites (the veto's row, else the last row), then the judge's cited frames.
 * null when there are no boxes, no frame size, or no image for any boxed frame.
 */
export function boxFrame(
  r: ChecksReportPayload,
  urls: readonly string[],
  judgeCited: readonly number[] = [],
): number | null {
  if (r.status !== 'ok' || !r.frame_size) return null;
  const boxed = Object.keys(r.boxes)
    .map(Number)
    .filter((i) => Number.isInteger(i) && (r.boxes[String(i)]?.length ?? 0) > 0 && !!urls[i])
    .sort((a, b) => a - b);
  if (!boxed.length) return null;
  const deciding = r.results.find((x) => x.value !== 'true') ?? r.results[r.results.length - 1];
  for (const pref of [deciding?.frames ?? [], judgeCited]) {
    const hit = boxed.filter((i) => pref.includes(i));
    if (hit.length) return hit[hit.length - 1]!;
  }
  return boxed[boxed.length - 1]!;
}

/**
 * One SAM box as SVG rect attributes in the frame's own pixel space (the overlay's viewBox is
 * `0 0 w h`, so it scales with the image), clamped to the frame. Also as % of the frame, for
 * anything positioned in CSS.
 */
export function boxRect(
  b: Pick<ChecksBox, 'box_xyxy'>,
  size: { w: number; h: number },
): { x: number; y: number; width: number; height: number; pct: Record<string, string> } {
  const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));
  const [x0, y0, x1, y1] = b.box_xyxy;
  const x = clamp(Math.min(x0, x1), size.w);
  const y = clamp(Math.min(y0, y1), size.h);
  const width = clamp(Math.max(x0, x1), size.w) - x;
  const height = clamp(Math.max(y0, y1), size.h) - y;
  const pc = (n: number, d: number) => `${d > 0 ? ((n / d) * 100).toFixed(2) : '0.00'}%`;
  return {
    x,
    y,
    width,
    height,
    pct: {
      left: pc(x, size.w),
      top: pc(y, size.h),
      width: pc(width, size.w),
      height: pc(height, size.h),
    },
  };
}
