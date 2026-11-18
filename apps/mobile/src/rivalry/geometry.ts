// Geometry for the live rivalry scan (pure):
//   stillBoxToView   a box in the upright photo -> the camera view (aspect-fill, shared centre)
//   associate        pairs the photo's faces with the live tracks (mutual nearest centre)
//   overlayItems     the snapshot -> what the overlay draws and where
//
// Why aspect-fill: the preview fills a view taller than both the 4:3 photo and the 16:9 video,
// and in portrait both keep the sensor's full height, so photo and preview differ only by a
// scale about the shared centre plus the crop. PENDING-PHONE: confirm the pairing error stays
// under 0.3 x face width on a device.
import type { Box } from '../face/pipeline';
import { bigEnough } from '../face/liveTracker';
import { recordText, streakLabel } from './format';
import type { LiveSnapshot, OverlayItem, Size, Track } from './types';

const fillScale = (still: Size, view: Size) =>
  Math.max(view.width / still.width, view.height / still.height);

/** A box in the still (pixels) -> the view (points), the still aspect-filling the view. */
export function stillBoxToView(b: Box, still: Size, view: Size): Box {
  const s = fillScale(still, view);
  const ox = (view.width - still.width * s) / 2;
  const oy = (view.height - still.height * s) / 2;
  return { x: b.x * s + ox, y: b.y * s + oy, width: b.width * s, height: b.height * s };
}

/** The inverse of stillBoxToView (the preview's fake photo uses it). */
export function viewBoxToStill(b: Box, still: Size, view: Size): Box {
  const s = fillScale(still, view);
  const ox = (view.width - still.width * s) / 2;
  const oy = (view.height - still.height * s) / 2;
  return { x: (b.x - ox) / s, y: (b.y - oy) / s, width: b.width / s, height: b.height / s };
}

const centre = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** A photo face counts as a track's face when their centres are this close (x track width). */
export const PAIR_MAX_DIST = 0.6;

/**
 * Track key -> the photo face that is that track: mutual nearest by centre (the track's nearest
 * photo face has that track as its nearest track), within PAIR_MAX_DIST x the track's width.
 */
export function associate<F extends { readonly bounds: Box }>(
  stillFaces: readonly F[],
  still: Size,
  tracks: readonly Track[],
  view: Size,
): ReadonlyMap<string, F> {
  const out = new Map<string, F>();
  if (stillFaces.length === 0 || tracks.length === 0) return out;
  const faces = stillFaces.map((f) => centre(stillBoxToView(f.bounds, still, view)));
  const tc = tracks.map((t) => centre(t.box));
  const d = (fi: number, ti: number) => {
    const f = faces[fi] as { x: number; y: number };
    const t = tc[ti] as { x: number; y: number };
    return Math.hypot(f.x - t.x, f.y - t.y);
  };
  const nearestTrack = (fi: number) =>
    tracks.reduce((best, _t, ti) => (d(fi, ti) < d(fi, best) ? ti : best), 0);
  tracks.forEach((t, ti) => {
    const fi = stillFaces.reduce((best, _f, i) => (d(i, ti) < d(best, ti) ? i : best), 0);
    if (nearestTrack(fi) !== ti) return;
    if (d(fi, ti) >= PAIR_MAX_DIST * t.box.width) return;
    out.set(t.key, stillFaces[fi] as F);
  });
  return out;
}

// ---------------------------------------------------------------------------------------
// The overlay layout
// ---------------------------------------------------------------------------------------

/** Space between a face box and its card or pill. */
export const CARD_GAP = 8;
/** Cards and pills keep this far from the view's sides. */
export const GUTTER = 16;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Centred on the box, CARD_GAP above it (below when there is no room above), x in the gutter. */
export function placeAbove(
  box: Box,
  size: Size,
  view: Size,
  insets: { top: number; bottom: number } = { top: 0, bottom: 0 },
): { x: number; y: number; placement: 'above' | 'below' } {
  const maxX = Math.max(GUTTER, view.width - GUTTER - size.width);
  const x = Math.min(maxX, Math.max(GUTTER, box.x + box.width / 2 - size.width / 2));
  const above = box.y - CARD_GAP - size.height;
  if (above >= insets.top) return { x, y: above, placement: 'above' };
  const below = box.y + box.height + CARD_GAP;
  const maxY = view.height - insets.bottom - size.height;
  return { x, y: Math.max(insets.top, Math.min(below, maxY)), placement: 'below' };
}

/** The status a track is drawn with. Tracks too small in the view read "Move closer". */
function drawnKind(t: Track, view: Size): 'known' | 'checking' | 'too_far' | 'unknown' {
  const s = t.status;
  switch (s.kind) {
    case 'known':
      return 'known';
    case 'unknown':
      return 'unknown';
    case 'too_far':
      return 'too_far';
    case 'error':
      return s.retryAtMs === null ? 'unknown' : 'checking';
    case 'checking':
      return 'checking';
    case 'pending':
      return bigEnough(t, view) ? 'checking' : 'too_far';
  }
}

/**
 * The snapshot -> overlay items. The focused known face gets the card (`sizes.card`), other
 * known faces a pill (`sizes.pill`, hidden where it would overlap the card). Unknown faces are
 * never named.
 */
export function overlayItems(
  s: LiveSnapshot,
  sizes: { card: Size; pill: Size },
  insets: { top: number; bottom: number } = { top: 0, bottom: 0 },
): OverlayItem[] {
  const items: OverlayItem[] = [];
  let cardRect: Rect | null = null;
  // The focused face first, so its card is placed before the pills check against it.
  const ordered = [...s.tracks].sort(
    (a, b) => Number(b.key === s.focusedKey) - Number(a.key === s.focusedKey),
  );
  for (const t of ordered) {
    const focused = t.key === s.focusedKey;
    const kind = drawnKind(t, s.view);
    if (kind !== 'known' || t.status.kind !== 'known') {
      items.push({ key: t.key, kind: kind === 'known' ? 'checking' : kind, focused, box: t.box });
      continue;
    }
    const { match, refreshing } = t.status;
    const size = focused ? sizes.card : sizes.pill;
    const anchor = placeAbove(t.box, size, s.view, insets);
    const rect = { x: anchor.x, y: anchor.y, width: size.width, height: size.height };
    if (focused) cardRect = rect;
    items.push({
      key: t.key,
      kind: 'known',
      focused,
      box: t.box,
      anchor,
      name: match.user.display_name,
      record: recordText(match.stats),
      net: match.stats.netDisplay,
      streakLabel: streakLabel(match.stats),
      rival: match.stats.rival,
      firstBet: match.stats.total === 0,
      refreshing,
      hidden: !focused && cardRect !== null && overlaps(rect, cardRect),
    });
  }
  return items;
}
