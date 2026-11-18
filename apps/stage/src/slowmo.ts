// The slow-mo replay on the projector (SCHEMAS §4.1, API-CONTRACT §2.14 GET /v1/bets/:bet_id/replay):
// the pure half. SlowMoPlayer.tsx draws it; App.tsx opens it (R, or once after a fresh payout).
//
//   when      auto-play: once per (bet, attempt, kind), PAID_MOMENT_MS after a FRESH payout first
//             shows (the PAID burst plays first; the slow-mo is the closer), never during the
//             appeal window (the outcome can still change and the judge is talking), never over
//             an open overlay (1-6 REPLAY clip, QR, help) or the operator panel. R opens and
//             closes it any time a decisive ruling exists.
//   frames    the moment's frames are the evidence JPEGs the page already fetched for the card
//             (TickerState.frameBlobs) when it has them, else fetched once with the stage bearer.
//   labels    stage style: uppercase badges. The word REPLAY is reserved for pre-recorded
//             fallbacks (ARCHITECTURE §7.1): these are live evidence frames.
//   preview   ?preview builds a moment from the sample bet's SVG frames (previewMoment); add
//             &slowmo (or &slowmo=foul for the sample foul layout) to open it at once, and
//             &slowmo_at=<ms> to freeze it at that point (screenshots).
import {
  buildFoulReplay,
  buildWinReplay,
  ReplayResponse,
  replayPath,
  type ReplayFrame,
  type ReplayMoment,
} from '@youre-on/shared/replay';
import { isCachedRulingModel, type Ruling } from '@youre-on/shared/ruling';
import { judgeFrameTimesMs } from '@youre-on/shared/judge/frames';
import { sha256Hex } from '@youre-on/shared/primitives';
import type { CameraEvidence } from '@youre-on/shared/evidence';
import { getJson } from './connection';
import { bottleFrame } from './preview';
import { frameKey, type BetView, type TickerState } from './ticker';

/** = App.tsx PAID_MOMENT_MS / PAID_FRESH_MS (kept here to avoid an import cycle; a test pins them). */
export const PAID_MOMENT_MS = 7_000;
export const PAID_FRESH_MS = 20_000;
/** Auto-play waits at most this long for the stage voice to finish its line. */
export const SLOWMO_VOICE_WAIT_MS = 4_000;
/** Past this after its slot (an overlay stayed open), auto-play gives up: R still works. */
export const SLOWMO_AUTO_WINDOW_MS = 15_000;
/** The player closes this long after the hold ends. */
export const SLOWMO_CLOSE_AFTER_MS = 600;
export const SLOWMO_TOAST_MS = 2_000;
export const NO_SLOWMO = 'No slow-mo yet';

export interface SlowmoOverlay {
  kind: 'slowmo';
  bet_id: string;
}

/** GET /v1/bets/:bet_id/replay with the stage bearer. */
export async function fetchReplay(
  serverUrl: string,
  token: string,
  betId: string,
  doFetch: typeof fetch = fetch,
): Promise<ReplayResponse> {
  return ReplayResponse.parse(await getJson(serverUrl, replayPath(betId), token, doFetch));
}

/**
 * One frame as an object URL. A server path goes with the stage bearer; a signed absolute URL
 * (object storage, later) never gets the bearer.
 */
export async function fetchReplayAsset(
  serverUrl: string,
  token: string,
  frame: Pick<ReplayFrame, 'path' | 'url'>,
  io: { fetch?: typeof fetch; createObjectURL?: (b: Blob) => string } = {},
): Promise<string> {
  const doFetch = io.fetch ?? fetch;
  const res = frame.url
    ? await doFetch(frame.url)
    : await doFetch(new URL(frame.path, serverUrl).toString(), {
        headers: { authorization: `Bearer ${token}` },
      });
  if (!res.ok) throw new Error(`slow-mo frame: HTTP ${res.status}`);
  return (io.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b)))(await res.blob());
}

/**
 * What an <img> shows for a frame: its signed URL, else the JPEG the page already fetched for
 * the card (frameBlobs), else one fetched for the slow-mo (`cache`, by path); null = not yet.
 */
export function resolveFrame(
  m: Pick<ReplayMoment, 'bet_id' | 'attempt_no'>,
  f: ReplayFrame,
  blobs: TickerState['frameBlobs'],
  cache: ReadonlyMap<string, string>,
): string | null {
  if (f.url) return f.url;
  const got = f.idx !== null ? blobs[frameKey(m.bet_id, m.attempt_no)]?.[f.idx] : undefined;
  return got || cache.get(f.path) || null;
}

/**
 * The moment trimmed to the frames the page could load (after the fetch wait), so the player
 * never steps onto a black frame and never puts a hold label over the wrong picture. A win whose
 * held frame is missing is held on the last frame that loaded, as 'last_frame' (no "JUDGE'S
 * FRAME"); a foul whose detector frame is missing is not shown at all (null), and neither is a
 * moment with no frame left. A clip moment is left as it is (the <video> falls back by itself).
 */
export function availableMoment(
  m: ReplayMoment,
  has: (f: ReplayFrame) => boolean,
): ReplayMoment | null {
  const frames = m.frames.filter(has);
  if (frames.length === m.frames.length) return m;
  if (m.clip !== null) return { ...m, frames };
  if (frames.length === 0 || m.kind === 'foul') return null;
  const heldKept = frames.at(-1) === m.frames.at(-1);
  return {
    ...m,
    frames,
    hold_source: heldKept ? m.hold_source : 'last_frame',
    moment_ms: frames.at(-1)!.t_ms,
  };
}

/** The winner of a decisive ruling or of the appeal (= view.tsx winnerOf). */
const winnerOf = (b: BetView): 'A' | 'B' | null => {
  const o = b.appeal_result?.final_outcome ?? b.ruling?.outcome;
  return o === 'A_WINS' ? 'A' : o === 'B_WINS' ? 'B' : null;
};

/** The attempt a bet's ruling is about (a hearing ruling: the latest evidence). */
export const attemptOf = (b: BetView): number =>
  b.ruling?.attempt_no ?? b.evidence?.attempt_no ?? b.attempt_no ?? 0;

/** Keys of `played` (= replayKey of shared/replay): one per (bet, attempt, kind). */
export const playedKey = (betId: string, attempt: number, kind: 'win' | 'foul') =>
  `${betId}:${attempt}:${kind}`;

/**
 * Auto-play now? Only for a decisive bet that has been PAID, when its payout was fresh when the
 * stage first saw it (`paidSeenAt`, a cold start shows nothing), once the PAID moment is over,
 * with no overlay or operator panel open, and once per (bet, attempt). Never while RULED: the
 * appeal window is the judge's, and the outcome can still change.
 */
export function shouldAutoPlay(o: {
  bet: BetView | null;
  /** When this stage first saw the bet's payout (its clock), or null. */
  paidSeenAt: number | null;
  now: number;
  overlayOpen: boolean;
  operatorOpen: boolean;
  played: ReadonlySet<string>;
}): boolean {
  const b = o.bet;
  if (!b || !b.paid_at || !b.payout || o.paidSeenAt === null) return false;
  if (b.state !== 'PAID' || winnerOf(b) === null) return false;
  if (o.paidSeenAt - Date.parse(b.paid_at) > PAID_FRESH_MS) return false;
  const due = o.paidSeenAt + PAID_MOMENT_MS;
  if (o.now < due || o.now > due + SLOWMO_AUTO_WINDOW_MS) return false;
  if (o.overlayOpen || o.operatorOpen) return false;
  const n = attemptOf(b);
  return (
    !o.played.has(playedKey(b.bet_id, n, 'win')) && !o.played.has(playedKey(b.bet_id, n, 'foul'))
  );
}

/** The R key with the overlay as it is: close an open slow-mo, else open one (after a fetch). */
export const slowmoToggle = (overlay: { kind: string } | null): 'close' | 'open' =>
  overlay?.kind === 'slowmo' ? 'close' : 'open';

// ---- labels -----------------------------------------------------------------------------------

export interface SlowmoLabels {
  badge: string;
  /** "{name} wins"; null with overlays burned into a clip. */
  chip: string | null;
  /** On the held frame. */
  hold: string | null;
  /** The judge's reason (data). */
  lower: string | null;
  /** The cached-ruling note (isCachedRulingModel): "replay ruling". */
  cached: boolean;
  footer: string | null;
}

export function slowmoLabels(m: ReplayMoment, names: { A: string; B: string }): SlowmoLabels {
  const badge = m.kind === 'foul' ? 'SLOW-MO · FOUL' : 'SLOW-MO · WINNING MOMENT';
  if (m.clip?.overlays_burned)
    return { badge, chip: null, hold: null, lower: null, cached: false, footer: null };
  const held = m.frames.at(-1);
  const hold =
    m.kind === 'foul'
      ? `FOUL · ${m.foul!.label}`
      : m.hold_source === 'judge_cited' && held?.idx != null
        ? `JUDGE'S FRAME ${held.idx}`
        : 'LAST FRAME';
  return {
    badge,
    chip: `${names[m.winner]} wins`,
    hold,
    lower: m.reason,
    cached: isCachedRulingModel(m.model),
    footer: `Live evidence ${m.clip ? 'clip' : 'frames'} · attempt ${m.attempt_no}`,
  };
}

/** A clip offset as the timecode on the frame: "3.84 s". */
export const timecode = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;

// ---- the preview ------------------------------------------------------------------------------

/** ?slowmo[=foul]&slowmo_at=<ms> (preview only). */
export function parseSlowmoLaunch(search: string): {
  open: 'win' | 'foul' | null;
  at: number | null;
} {
  const q = new URLSearchParams(search);
  const v = q.get('slowmo');
  const at = Number(q.get('slowmo_at'));
  return {
    open: v === null ? null : v === 'foul' ? 'foul' : 'win',
    at: q.has('slowmo_at') && Number.isFinite(at) && at >= 0 ? at : null,
  };
}

/** The sample bet's clip: 4.2 s, 8 frames (D10's older 8-frame shape) + a landing crop. */
const PREVIEW_DURATION_MS = 4_200;
const PREVIEW_FRAMES = 8;

/**
 * A moment for the ?preview sample bet, drawn from its SVG frames (preview.ts bottleFrame), so the
 * player can be checked with no server. `images` maps each frame path to its data URL. The foul
 * variant is sample layout only (detector 'preview/sample'); live, a foul only ever comes from a
 * confirmed detector result on the server.
 */
export function previewMoment(
  bet: BetView,
  kind: 'win' | 'foul' = 'win',
): { moment: ReplayMoment; images: Record<string, string> } | null {
  const r = bet.ruling;
  if (!r || !bet.evidence) return null;
  const n = (bet.evidence.attempt_no === 1 ? 1 : 2) as 1 | 2;
  const times = judgeFrameTimesMs(PREVIEW_DURATION_MS, PREVIEW_FRAMES);
  const frames: CameraEvidence['frames'] = [
    ...times.map((t, i) => ({ index: i, t_ms: t, sha256: sha256Hex(`preview:f${n}.${i}`) })),
    {
      index: PREVIEW_FRAMES,
      t_ms: times.at(-1)!,
      sha256: sha256Hex(`preview:f${n}.crop`),
      landing_crop: true as const,
    },
  ];
  const evidence: CameraEvidence = {
    schema_version: 1,
    kind: 'camera',
    bet_id: bet.bet_id,
    attempt_no: n,
    clip_sha256: sha256Hex(`preview:clip${n}`),
    clip_bytes: 2_400_000,
    mime: 'video/mp4',
    duration_ms: PREVIEW_DURATION_MS,
    recorded_by: 'A',
    recorded_at: '2026-11-20T15:00:00.000Z',
    frames,
  };
  const hashes = frames.map((f) => f.sha256);
  const ruling = {
    outcome: r.outcome,
    model: r.model,
    reason: r.reason,
    cited_frames: r.cited_frames,
    frame_hashes: hashes,
  } as unknown as Ruling;
  const win = buildWinReplay({
    bet_id: bet.bet_id,
    evidence,
    ruling,
    ruling_hash: r.ruling_hash,
    final_outcome: bet.appeal_result?.final_outcome ?? r.outcome,
    attempt_frame_hashes: hashes,
  });
  if (!win) return null;
  const moment =
    kind === 'foul'
      ? buildFoulReplay(
          win,
          {
            moment_ms: times[1]!,
            foul: { label: 'Toe 17 cm over', measure_cm: 17, detector: 'preview/sample' },
            frames: [],
            clip: null,
          },
          evidence,
        )
      : win;
  if (!moment) return null;
  const images: Record<string, string> = {};
  for (const f of moment.frames)
    if (f.idx !== null) images[f.path] = bottleFrame(n, Math.min(f.idx, PREVIEW_FRAMES - 1));
  return { moment, images };
}
