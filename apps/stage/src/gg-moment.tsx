// The GG moment and the review banner on the projector (state: gg.ts; styles: gg.css, its own
// sheet so the stage reskin can restyle it through the :root tokens).
//
//   <GgMoment>      full-screen, like the PAID moment (and in its place): "<LOSER>: GG" lands with
//                   a gavel, "Good game.", the pair's record ticks over (the winner's number
//                   rolls), then the payout counts up when it lands (the cheer is the payout's
//                   own sound).
//                   No net dollar amounts in the record: facts only.
//   <ReviewBanner>  in the ruling: "REVIEW REQUESTED · Jake confirms on their phone · 0:06", then
//                   confirmed (the appeal panel follows), kept, or not confirmed.
//   useGgSounds     the gavel for a fresh GG, and the stage.cue cheer dedupe.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PairRecord } from '@youre-on/shared/gg';
import { clock, usd } from './format';
import {
  COUNT_UP_MS,
  cueSoundAllowed,
  freshGgSounds,
  ggFrame,
  ggPaidAt,
  isCheer,
  recordChips,
  reviewSecondsLeft,
  reviewShown,
} from './gg';
import type { Sfx, StageAudio } from './sound';
import type { BetView, PartyKey, TickerState } from './ticker';

const nameOf = (b: BetView, p: PartyKey) => b.names[p] ?? (p === 'A' ? 'Player A' : 'Player B');

const perf = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * The stage clock between its 250 ms ticks: `now` plus the time since it last changed, at most
 * one tick (a frozen ?preview step stays frozen). Re-renders every animation frame while `active`.
 */
function useSmoothNow(now: number, active: boolean): number {
  const [, frame] = useState(0);
  const base = useRef({ now, at: perf() });
  if (base.current.now !== now) base.current = { now, at: perf() };
  useEffect(() => {
    if (!active || typeof requestAnimationFrame !== 'function') return;
    let raf = 0;
    const loop = () => {
      frame((n) => n + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return base.current.now + Math.min(260, Math.max(0, perf() - base.current.at));
}

function RecordRow({
  bet,
  record,
  before,
  ticked,
}: {
  bet: BetView;
  record: PairRecord;
  before: PairRecord;
  ticked: boolean;
}) {
  const g = bet.gg!;
  const names = { A: nameOf(bet, 'A'), B: nameOf(bet, 'B') };
  const n = (p: PartyKey) => {
    const v = p === 'A' ? record.a_wins : record.b_wins;
    const rolled = ticked && p === g.winner;
    return (
      <span className={`gg-num${rolled ? ' rolled' : ''}`} key={`${p}:${v}`}>
        {v}
      </span>
    );
  };
  const chips = ticked ? recordChips(record, names) : [];
  return (
    <div className="gg-record" aria-label="head to head">
      <span className="label">HEAD TO HEAD</span>
      <div className="gg-score">
        <span className={`gg-name${g.winner === 'A' ? ' won' : ''}`}>{names.A}</span>
        {n('A')}
        <span className="gg-dash">–</span>
        {n('B')}
        <span className={`gg-name${g.winner === 'B' ? ' won' : ''}`}>{names.B}</span>
      </div>
      <div className="gg-chips">
        {before.total === 0 && <span className="gg-chip first">First meeting</span>}
        {chips.map((c) => (
          <span key={c.kind} className={`gg-chip ${c.kind}`}>
            {c.text}
          </span>
        ))}
      </div>
    </div>
  );
}

export function GgMoment({ bet, now }: { bet: BetView; now: number }) {
  const g = bet.gg;
  const paidAt = ggPaidAt(bet);
  const t = useSmoothNow(now, paidAt !== null && now < paidAt + COUNT_UP_MS + 300);
  const f = g ? ggFrame(bet, t) : null;
  if (!g || !f) return null;
  const loser = nameOf(bet, g.by);
  return (
    <div
      className={`gg-moment${f.reverted ? ' reverted' : ''}`}
      role="status"
      aria-label="GG"
      data-testid="gg-moment"
    >
      <div className="gg-glow" aria-hidden="true" />
      <div className="gg-stamp">
        <span className="gg-who">{loser}:</span> <span className="gg-word">GG</span>
      </div>
      <p className="gg-line">{f.reverted ? "GG didn't go through" : 'Good game.'}</p>
      {!f.reverted && f.record && g.record && (
        <RecordRow bet={bet} record={f.record} before={g.record.before} ticked={f.ticked} />
      )}
      {!f.reverted && (
        <div className="gg-payouts">
          {([g.winner, g.by] as const).map((p) => {
            const won = p === g.winner;
            return (
              <div key={p} className={`gg-payout${won ? ' won' : ''}${f.paid ? ' paid' : ''}`}>
                <span>{nameOf(bet, p)}</span>
                <span className="amt">{won ? `+${usd(f.shown[p])}` : '$0'}</span>
              </div>
            );
          })}
          <span className="gg-status muted">
            {f.paid ? `Paid · ${bet.payout?.event ?? 'BetConceded'} · devnet` : 'Paying out…'}
          </span>
        </div>
      )}
    </div>
  );
}

const REVIEW_TEXT = {
  confirmed: ['CONFIRMED', 'three-judge panel'],
  lapsed: ['NOT CONFIRMED', 'the ruling stands'],
} as const;

export function ReviewBanner({ bet, now }: { bet: BetView; now: number }) {
  const r = bet.review;
  const st = reviewShown(r, now);
  if (!r || !st) return null;
  const who = nameOf(bet, r.for_party);
  let tag: string;
  let text: string;
  if (st === 'open') {
    tag = 'REVIEW REQUESTED';
    text = `${who} confirms on their phone`;
  } else if (st === 'declined') {
    tag = 'RULING STANDS';
    text = `${who} kept the ruling`;
  } else [tag, text] = REVIEW_TEXT[st as 'confirmed' | 'lapsed'];
  return (
    <div className={`review-banner ${st}`} role="status" aria-label="review">
      <span className="review-head">
        <span className="review-tag">{tag}</span>
        {st === 'open' && (
          <span className="countdown">{clock(reviewSecondsLeft(r, now) * 1000)}</span>
        )}
      </span>
      <span className="review-text">{text}</span>
    </div>
  );
}

/**
 * The gavel for each fresh GG (any bet in the room). Returns the cheer dedupe the page's own
 * sound effects feed (`played`) and its stage.cue handler asks (`cueAllowed`).
 */
export function useGgSounds(
  state: Pick<TickerState, 'bets' | 'history'>,
  now: number,
  audio: { readonly current: StageAudio | null },
) {
  const seen = useRef(new Set<string>());
  const lastCheer = useRef<number | null>(null);
  useEffect(() => {
    let gavel = false;
    for (const id of Object.keys(state.bets))
      if (freshGgSounds(state, id, seen.current, now).length) gavel = true;
    if (gavel) audio.current?.play('gavel');
  }, [state, now, audio]);
  return useMemo(
    () => ({
      played: (s: Sfx) => {
        if (isCheer(s)) lastCheer.current = Date.now();
      },
      cueAllowed: (kind: string) => cueSoundAllowed(kind, lastCheer.current, Date.now()),
    }),
    [],
  );
}
