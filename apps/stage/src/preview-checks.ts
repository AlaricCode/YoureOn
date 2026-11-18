// `?preview=refcam…`: the ref cam (camera checks, checks.ts) on the preview's bottle flip, from
// the real SAM 3.1 runs on the four bottle-flip clips (packages/shared/test/fixtures/sam3; the
// checks.report payloads below are what the server's reportPayload() makes of them with the
// bottle-flip spec, boxes in the clips' 288x512 frame pixels). The evidence frames are drawn as
// SVG at that size with the bottle where SAM found it, so the boxes sit on it. Every frame goes
// through applyFrame() and parses with the shared schemas, like the main preview.
//
//   ?preview=refcam          bottle_flip_1: the judge says it landed; the ref cam can't confirm
//                            "stands upright" (25° tilt, between the bands): REDO, veto.why
//   ?preview=refcam-ok       bottle_flip_2_success: ✓ ✓ ✓, the judge's win stands
//   ?preview=refcam-fling    bottle_flip_3_fling: the bottle is out of shot at the end: REDO
//   ?preview=refcam-offline  SAM timed out: "offline · the judge decided alone"
//   ?preview=refcam-terms    the terms card with the compiled readback (before the lock)
//
// The main ?preview loop also carries a checks.compiled and two checks.report (preview.ts).
import type { ChecksReportPayload } from '@youre-on/shared/checks/events';
import { previewAt, PREVIEW_STEPS, type PreviewFrame } from './preview';
import { applyFrame, type TickerState } from './ticker';

export { FLIP_READBACK } from './preview';

const HASH = 'ab'.repeat(32);
const SIZE = { w: 288, h: 512 };
const LABELS = [
  'the bottle fully in shot at the end',
  'the bottle comes to rest',
  'the bottle stands upright',
] as const;
const END = [9, 10, 11];

type Box = [number, number, number, number];
const row = (
  i: 0 | 1 | 2,
  value: 'true' | 'false' | 'unknown',
  why: ChecksReportPayload['results'][number]['why'],
  measures: Array<{ k: string; v: number }>,
) =>
  ({
    role: i === 0 ? 'gate' : 'need',
    label: LABELS[i],
    value,
    why,
    frames: END,
    measures,
  }) as ChecksReportPayload['results'][number];
const boxesOf = (score: number, boxes: Record<number, Box>) =>
  Object.fromEntries(
    Object.entries(boxes).map(([k, b]) => [
      k,
      [{ key: 'bottle', prompt: 'bottle', box_xyxy: b, score }],
    ]),
  );

/** The four clips' reports (attempt_no is set per scene). */
export const FIXTURE_REPORTS = {
  bottle_flip_1: {
    attempt_no: 1,
    status: 'ok',
    gate: 'true',
    need: 'unknown',
    veto: {
      kind: 'unconfirmed',
      why: "Couldn't confirm the bottle stands upright. Film from the side.",
    },
    results: [
      row(0, 'true', 'ok', [
        { k: 'score', v: 0.953 },
        { k: 'frames', v: 3 },
      ]),
      row(1, 'true', 'ok', [
        { k: 'shift_rel', v: 0.031 },
        { k: 'size_chg', v: 0.014 },
      ]),
      row(2, 'unknown', 'between_bands', [
        { k: 'tilt_deg', v: 25.19 },
        { k: 'elong', v: 2.26 },
      ]),
    ],
    boxes: boxesOf(0.953, {
      9: [118, 116, 190, 223],
      10: [122, 116, 194, 223],
      11: [125, 114, 196, 220],
    }),
    frame_size: SIZE,
    report_hash: HASH,
  },
  bottle_flip_2_success: {
    attempt_no: 1,
    status: 'ok',
    gate: 'true',
    need: 'true',
    veto: null,
    results: [
      row(0, 'true', 'ok', [
        { k: 'score', v: 0.965 },
        { k: 'frames', v: 3 },
      ]),
      row(1, 'true', 'ok', [
        { k: 'shift_rel', v: 0.005 },
        { k: 'size_chg', v: 0.014 },
      ]),
      row(2, 'true', 'ok', [
        { k: 'tilt_deg', v: 5.15 },
        { k: 'elong', v: 2.64 },
      ]),
    ],
    boxes: boxesOf(0.965, {
      9: [48, 138, 119, 314],
      10: [48, 137, 119, 313],
      11: [49, 137, 119, 313],
    }),
    frame_size: SIZE,
    report_hash: HASH,
  },
  bottle_flip_3_fling: {
    attempt_no: 1,
    status: 'ok',
    gate: 'false',
    need: 'unknown',
    veto: {
      kind: 'not_on_camera',
      why: "Couldn't see the bottle at the end. Keep it in frame and run it back.",
    },
    results: [
      row(0, 'false', 'absent', [
        { k: 'score', v: 0 },
        { k: 'frames', v: 0 },
      ]),
      row(1, 'unknown', 'absent', []),
      row(2, 'unknown', 'absent', []),
    ],
    boxes: {},
    frame_size: SIZE,
    report_hash: HASH,
  },
} satisfies Record<string, ChecksReportPayload>;

/** SAM timed out: no rows, no boxes, no veto. */
export const OFFLINE_REPORT: ChecksReportPayload = {
  attempt_no: 1,
  status: 'unavailable',
  gate: 'unknown',
  need: 'unknown',
  veto: null,
  results: [],
  boxes: {},
  frame_size: null,
  report_hash: HASH,
};

type Clip = 'flip1' | 'success' | 'fling';

/**
 * A 288x512 evidence frame: the bottle drawn inside SAM's box on the end frames (tilted 25° for
 * bottle_flip_1), mid-flight before; the fling's bottle has left the shot by frame 6.
 */
export function refcamFrame(clip: Clip, i: number): string {
  const end =
    clip === 'flip1'
      ? FIXTURE_REPORTS.bottle_flip_1.boxes[String(Math.max(9, i))]
      : clip === 'success'
        ? FIXTURE_REPORTS.bottle_flip_2_success.boxes[String(Math.max(9, i))]
        : undefined;
  let bottle = '';
  if (i >= 9 && end) {
    const [x0, y0, x1, y1] = end[0]!.box_xyxy;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    // a bottle ~38 x 120 px fills the success box upright; flip_1's is the same bottle at 25°
    const tilt = clip === 'flip1' ? 25 : 0;
    const h = clip === 'flip1' ? 108 : 172;
    const w = clip === 'flip1' ? 34 : 54;
    bottle =
      `<g transform="translate(${cx} ${cy}) rotate(${tilt})">` +
      `<rect x="${-w / 2}" y="${-h / 2 + h * 0.18}" width="${w}" height="${h * 0.82}" rx="${w / 4}" fill="#9fd4ff" fill-opacity=".9"/>` +
      `<rect x="${-w / 2}" y="${h * 0.12}" width="${w}" height="${h * 0.3}" rx="${w / 5}" fill="#3b8fd9"/>` +
      `<rect x="${-w / 5}" y="${-h / 2 + 6}" width="${(w * 2) / 5}" height="${h * 0.14}" fill="#9fd4ff"/>` +
      `<rect x="${-w / 4}" y="${-h / 2}" width="${w / 2}" height="8" rx="2" fill="#e5484d"/></g>`;
  } else if (!(clip === 'fling' && i >= 6)) {
    const x = 60 + i * 14;
    const y = 360 - Math.sin((i / 9) * Math.PI) * 240;
    bottle =
      `<g transform="translate(${x} ${y}) rotate(${i * 80})">` +
      `<rect x="-17" y="-50" width="34" height="100" rx="9" fill="#9fd4ff" fill-opacity=".9"/>` +
      `<rect x="-11" y="-60" width="22" height="12" rx="3" fill="#e5484d"/></g>`;
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE.w} ${SIZE.h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2e2e32"/>` +
    `<stop offset="1" stop-color="#141416"/></linearGradient></defs>` +
    `<rect width="${SIZE.w}" height="${SIZE.h}" fill="url(#g)"/>` +
    `<rect y="${clip === 'success' ? 314 : 222}" width="${SIZE.w}" height="${SIZE.h}" fill="#6b4f35"/>` +
    bottle +
    `<text x="10" y="22" font-family="monospace" font-size="16" fill="#fff" fill-opacity=".8">f${i}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

type Scene = 'refcam' | 'refcam-ok' | 'refcam-fling' | 'refcam-offline' | 'refcam-terms';
export const REFCAM_PREVIEW_STEPS: readonly Scene[] = [
  'refcam',
  'refcam-ok',
  'refcam-fling',
  'refcam-offline',
  'refcam-terms',
];
export const isRefcamPreview = (s: string | null | undefined): s is Scene =>
  !!s && (REFCAM_PREVIEW_STEPS as readonly string[]).includes(s);

const iso = (ms: number) => new Date(ms).toISOString();
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const hex = (n: number) => n.toString(16).padStart(64, '0');

const SCENE: Record<
  Exclude<Scene, 'refcam-terms'>,
  {
    clip: Clip;
    report: ChecksReportPayload;
    outcome: 'REDO' | 'B_WINS';
    claim: 'MET';
    confidence: number;
    reason: string;
    judge: string;
  }
> = {
  refcam: {
    clip: 'flip1',
    report: FIXTURE_REPORTS.bottle_flip_1,
    outcome: 'REDO',
    claim: 'MET',
    confidence: 0.88,
    reason: FIXTURE_REPORTS.bottle_flip_1.veto.why,
    judge: "Hold on. The ref cam couldn't confirm it's upright. Run it back, Jake.",
  },
  'refcam-ok': {
    clip: 'success',
    report: FIXTURE_REPORTS.bottle_flip_2_success,
    outcome: 'B_WINS',
    claim: 'MET',
    confidence: 0.94,
    reason: 'One full rotation; it lands upright on its base and stays there.',
    judge: 'Jake wins! The ref cam agrees.',
  },
  'refcam-fling': {
    clip: 'fling',
    report: FIXTURE_REPORTS.bottle_flip_3_fling,
    outcome: 'REDO',
    claim: 'MET',
    confidence: 0.81,
    reason: FIXTURE_REPORTS.bottle_flip_3_fling.veto.why,
    judge: 'The bottle left the shot. Keep it in frame and go again.',
  },
  'refcam-offline': {
    clip: 'success',
    report: OFFLINE_REPORT,
    outcome: 'B_WINS',
    claim: 'MET',
    confidence: 0.94,
    reason: 'One full rotation; it lands upright on its base and stays there.',
    judge: 'Jake wins!',
  },
};

/**
 * The stage at a ref cam scene: the main preview's flip frozen just after the lock (or on its
 * terms, for refcam-terms), then one attempt judged with the fixture's checks.report.
 */
export function previewRefcamAt(startMs: number, step: string): PreviewFrame {
  const scene: Scene = isRefcamPreview(step) ? step : 'refcam';
  if (scene === 'refcam-terms') return previewAt(startMs, startMs, 'terms');
  const base = previewAt(startMs, startMs, 'locked');
  let s: TickerState = base.state;
  const betId = s.focusBetId!;
  const bet = s.bets[betId]!;
  const termsHash = bet.envelope!.terms_hash;
  const def = SCENE[scene];
  // the main loop's attempt 1 / 2 come later; this scene's attempt is number 1
  const n = 1;
  const t0 = base.now;
  let seq = s.lastSeq[betId] ?? 0;
  const add = (dt: number, type: string, payload: unknown) => {
    s = applyFrame(s, {
      kind: 'frame',
      receivedAt: t0 + dt,
      raw: {
        v: 1,
        type,
        bet_id: betId,
        seq: ++seq,
        ts: iso(t0 + dt),
        source: 'server',
        payload,
      },
    });
  };
  const state = (dt: number, st: string, prev: string) =>
    add(dt, 'bet.state', {
      state: st,
      prev,
      onchain_status: 'Locked',
      chain_ack: 'rpc',
      pending_tx: null,
      reason: null,
    });
  const frames = Array.from({ length: 12 }, (_, i) => i);
  add(500, 'attempt.started', {
    attempt_no: n,
    performer: 'B',
    max_ms: 15_000,
    recorder_device_id: uuid(990),
    go_at: iso(t0 + 3_500),
  });
  state(500, 'ATTEMPT', 'LOCKED');
  add(4_000, 'attempt.evidence', {
    evidence: {
      schema_version: 1,
      kind: 'camera',
      bet_id: betId,
      attempt_no: n,
      clip_sha256: hex(1),
      clip_bytes: 2_100_000,
      mime: 'video/mp4',
      duration_ms: 3_230,
      recorded_by: 'A',
      recorded_at: iso(t0 + 3_000),
      frames: frames.map((i) => ({ index: i, t_ms: i * 260, sha256: hex(100 + i) })),
    },
    frame_urls: frames.map((i) => refcamFrame(def.clip, i)),
  });
  state(4_000, 'JUDGING', 'ATTEMPT');
  add(6_000, 'checks.report', { ...def.report, attempt_no: n });
  add(6_000, 'ruling.issued', {
    ruling: {
      schema_version: 1,
      ruling_id: uuid(980),
      bet_id: betId,
      stage: 'attempt',
      attempt_no: n,
      outcome: def.outcome,
      claim_result: def.claim,
      redo_reason: def.outcome === 'REDO' ? 'unclear' : null,
      void_reason: null,
      confidence: def.confidence,
      reason: def.reason,
      cited_frames: [11, 10],
      frame_hashes: frames.map((i) => hex(100 + i)),
      model: 'anthropic/claude-sonnet-5-5',
      evidence_hash: hex(1),
      terms_hash: termsHash,
      created_at: iso(t0 + 6_000),
    },
    ruling_hash: hex(2),
  });
  add(6_200, 'judge.line', { utterance_id: uuid(981), text: def.judge, final: true });
  if (def.outcome !== 'REDO') state(6_400, 'RULED', 'JUDGING');
  return { t: PREVIEW_STEPS.locked + 6_400, now: t0 + 6_400, state: s };
}
