// REPLAY clips (ARCHITECTURE §7.1: every pre-recorded fallback is labelled REPLAY on the stage):
// keys 1-6 play replay/beat{n}.mp4 full screen. A replay is what you reach for when the network
// misbehaves, so the page downloads each clip once in the background (sequentially, after the
// page settles) and plays it from memory; a clip that is not downloaded yet streams instead.
// Missing clips are detected (the server 404s; Vite dev falls back to index.html) and skipped.
//
// The clips are big (~30 MB each) and pitch day runs on one phone hotspot, shared with both
// phones' API, WebSocket and voice traffic. So the download holds while a live bet is in progress
// (liveBetInProgress: the focused bet has had activity in the last 3 minutes and is not over); a
// clip in flight is aborted then and fetched again afterwards. The status strip shows the
// progress (cached / loading / paused), so the operator knows when every clip is in memory.
// ?nopreload turns the download off altogether.
import { isOver, type TickerState } from './ticker';

export const REPLAY_BEATS = [1, 2, 3, 4, 5, 6] as const;

/** The pitch's six beats (BRIEF §3), named on the REPLAY badge. */
export const BEAT_TITLES: Record<number, string> = {
  1: 'Challenge by face',
  2: 'Terms by voice',
  3: 'Lock it in',
  4: 'The attempt',
  5: 'Dispute',
  6: 'Bitcoin closer',
};

/** The clip's URL under the page's base (/stage/ on the server, / in Vite dev). */
export function replayUrl(beat: number, base: string = import.meta.env.BASE_URL ?? '/'): string {
  return `${base.endsWith('/') ? base : `${base}/`}replay/beat${beat}.mp4`;
}

export type ClipState = 'unknown' | 'missing' | 'loading' | 'paused' | 'ready' | 'error';

export interface ReplayStatus {
  clips: Record<number, ClipState>;
  /** Object URLs of the downloaded clips. */
  urls: Record<number, string>;
}

export const initialReplays = (): ReplayStatus => ({
  clips: Object.fromEntries(REPLAY_BEATS.map((b) => [b, 'unknown'])) as Record<number, ClipState>,
  urls: {},
});

export const replaySrc = (s: ReplayStatus, beat: number): string => s.urls[beat] ?? replayUrl(beat);

export const readyCount = (s: ReplayStatus): number =>
  REPLAY_BEATS.filter((b) => s.clips[b] === 'ready').length;
export const presentCount = (s: ReplayStatus): number =>
  REPLAY_BEATS.filter((b) => s.clips[b] !== 'missing').length;

/** What the status strip says about the clips. */
export function replayProgress(s: ReplayStatus): {
  ready: number;
  present: number;
  state: 'loading' | 'paused' | 'done' | 'idle';
} {
  const clips = REPLAY_BEATS.map((b) => s.clips[b]);
  return {
    ready: readyCount(s),
    present: presentCount(s),
    state: clips.includes('paused')
      ? 'paused'
      : clips.includes('loading')
        ? 'loading'
        : clips.every((c) => c !== 'unknown')
          ? 'done'
          : 'idle',
  };
}

/** A bet with no event for this long no longer holds the downloads (a stuck rehearsal bet). */
export const LIVE_IDLE_MS = 3 * 60_000;

/** A live beat is on: the focused bet is not over and had activity in the last LIVE_IDLE_MS. */
export function liveBetInProgress(
  s: Pick<TickerState, 'bets' | 'focusBetId'>,
  nowMs: number,
): boolean {
  const b = s.focusBetId ? s.bets[s.focusBetId] : undefined;
  if (!b || isOver(b)) return false;
  return nowMs - b.updated_at < LIVE_IDLE_MS;
}

/** How often a pause is checked, and a held download looks again (ms). */
export const PAUSE_POLL_MS = 1_000;

export interface PreloadDeps {
  fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  createObjectURL: (b: Blob) => string;
  onChange: (beat: number, state: ClipState, url?: string) => void;
  /** Stops between clips (page unmounted). */
  cancelled: () => boolean;
  /** A live beat is on: hold off; a download in flight is aborted and fetched again later. */
  paused?: () => boolean;
  pollMs?: number;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Downloads every clip once, one after another, holding while paused. Never throws. */
export async function preloadReplays(d: PreloadDeps): Promise<void> {
  const poll = d.pollMs ?? PAUSE_POLL_MS;
  const paused = d.paused ?? (() => false);
  for (const beat of REPLAY_BEATS) {
    for (;;) {
      if (d.cancelled()) return;
      if (paused()) {
        d.onChange(beat, 'paused');
        await wait(poll);
        continue;
      }
      d.onChange(beat, 'loading');
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      let watching = true;
      // a pause (or the page going away) mid-download aborts it: the bandwidth goes back at once
      void (async () => {
        while (watching) {
          await wait(poll);
          if (watching && (paused() || d.cancelled())) {
            ac?.abort();
            return;
          }
        }
      })();
      try {
        const res = await d.fetch(replayUrl(beat), ac ? { signal: ac.signal } : undefined);
        const type = res.headers.get('content-type') ?? '';
        if (!res.ok || !type.startsWith('video/')) {
          d.onChange(beat, 'missing');
          break;
        }
        const blob = await res.blob();
        if (d.cancelled()) return;
        d.onChange(beat, 'ready', d.createObjectURL(blob));
        break;
      } catch {
        if (ac?.signal.aborted) continue; // held: this clip again, from the top
        d.onChange(beat, 'error');
        break;
      } finally {
        watching = false;
      }
    }
  }
}
