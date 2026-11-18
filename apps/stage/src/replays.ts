// REPLAY clips (ARCHITECTURE §7.1: every pre-recorded fallback is labelled REPLAY on the stage):
// keys 1-6 play replay/beat{n}.mp4 full screen. A replay is what you reach for when the network
// misbehaves, so the page downloads each clip once in the background (sequentially, after the
// page settles) and plays it from memory; a clip that is not downloaded yet streams instead.
// Missing clips are detected (the server 404s; Vite dev falls back to index.html) and skipped.

export const REPLAY_BEATS = [1, 2, 3, 4, 5, 6] as const;

/** The clip's URL under the page's base (/stage/ on the server, / in Vite dev). */
export function replayUrl(beat: number, base: string = import.meta.env.BASE_URL ?? '/'): string {
  return `${base.endsWith('/') ? base : `${base}/`}replay/beat${beat}.mp4`;
}

export type ClipState = 'unknown' | 'missing' | 'loading' | 'ready' | 'error';

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

export interface PreloadDeps {
  fetch: typeof fetch;
  createObjectURL: (b: Blob) => string;
  onChange: (beat: number, state: ClipState, url?: string) => void;
  /** Stops between clips (page unmounted). */
  cancelled: () => boolean;
}

/** Downloads every clip once, one after another. Never throws. */
export async function preloadReplays(d: PreloadDeps): Promise<void> {
  for (const beat of REPLAY_BEATS) {
    if (d.cancelled()) return;
    d.onChange(beat, 'loading');
    try {
      const res = await d.fetch(replayUrl(beat));
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.startsWith('video/')) {
        d.onChange(beat, 'missing');
        continue;
      }
      const blob = await res.blob();
      if (d.cancelled()) return;
      d.onChange(beat, 'ready', d.createObjectURL(blob));
    } catch {
      d.onChange(beat, 'error');
    }
  }
}
