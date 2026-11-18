// Odds on the projector (odds-state.ts is the pure half): while the two players settle the odds
// of a skill bet, the moment panel shows
//
//   JUDGE'S ODDS  [Demo history]                                   Waiting on Jake
//   2 to 1        | Bottle flips 10–2 (83%)
//   Jake 69%      | vs Logan 7–4 · Overall 14–6 · W W L W W
//   Jake $10 ·    | "Jake has landed 10 of his last 12 bottle flips, so I'd make it 2 to 1."
//   Logan $5      |
//   Numbers computed from the record · reason worded by claude-…
//   [Logan asks 3 to 1] → [Judge suggests 2 to 1] → [Agreed · winner takes $15]
//
// so the hall sees the AI reason from the performer's real record (labelled "Demo history" when
// any of it is rehearsal seed data), and every offer, counter and acceptance as it happens. The
// AI only suggests: the strip shows both players still tapping Accept. The terms card gets an
// odds chip ("Jake gives 2 to 1") next to the two stakes and the pot.
import './odds.css';
import { formatUsd } from '@youre-on/shared/money';
import type { OddsSuggestion } from '@youre-on/shared/odds';
import {
  categoryTitle,
  judgeOdds,
  judgeStatusLine,
  lastAgreed,
  oddsChip,
  oddsOnTable,
  oddsSteps,
  potOf,
  recordOf,
  rungLabel,
  sourceNote,
  stakesLine,
  wlOf,
  type JudgeOdds,
} from './odds-state';
import type { BetView, PartyKey } from './ticker';

const nameOf = (b: BetView, p: PartyKey) => b.names[p] ?? (p === 'A' ? 'Player A' : 'Player B');
const usd = (micro: string | null) => {
  if (micro === null) return '';
  try {
    return formatUsd(micro);
  } catch {
    return micro;
  }
};

/** The terms card's odds chip (unequal skill stakes only). */
export function OddsChip({ bet }: { bet: BetView }) {
  const t = bet.envelope?.terms;
  const text = t ? oddsChip(t, bet.names) : null;
  return text ? <span className="chip odds-chip">{text}</span> : null;
}

/** Whether the moment panel shows the odds instead of the rules (terms phase only). */
export const showsOdds = (bet: BetView): boolean =>
  oddsOnTable(bet.odds, bet.envelope?.terms ?? null);

function Form({ recent }: { recent: OddsSuggestion['stats']['recent'] }) {
  if (!recent.length) return null;
  return (
    <span className="form" aria-label={`recent ${recent.join(' ')}`}>
      {recent.map((r, i) => (
        <span key={i} className={r === 'W' ? 'w' : 'l'}>
          {r}
        </span>
      ))}
    </span>
  );
}

/** JUDGE'S ODDS: the suggestion, the chance, and the record it comes from. */
export function JudgeOddsCard({ bet, judge }: { bet: BetView; judge?: JudgeOdds | null }) {
  const j = judge === undefined ? judgeOdds(bet.odds) : judge;
  if (!j) return null;
  const s = j.suggestion;
  const st = s.stats;
  const performer = st.performer.display_name || nameOf(bet, st.performer.party);
  const opponent = nameOf(bet, st.performer.party === 'A' ? 'B' : 'A');
  const cat = st.in_category;
  const rate = cat.tries > 0 ? Math.round((100 * cat.made) / cat.tries) : null;
  const status = judgeStatusLine(j, bet.names);
  return (
    <section className={`judge-odds status-${j.status}`} aria-label="judge's odds">
      <header className="judge-odds-head">
        <span className="label">Judge&apos;s odds</span>
        {st.includes_seed && <span className="demo-history">Demo history</span>}
        <span className={`waiting${j.status === 'agreed' ? ' good' : ' muted'}`}>{status}</span>
      </header>
      <div className="judge-odds-ratio">
        <span className="ratio">{rungLabel(s.ratio)}</span>
        <span className="chance">
          {performer} {s.chance_pct}%
        </span>
        <span className="split">{stakesLine(s.stakes, bet.names)}</span>
      </div>
      <div className="judge-odds-record">
        <span className="cat">
          {cat.tries > 0 ? (
            <>
              {categoryTitle(st)} {recordOf(cat)}
              {rate !== null && <span className="rate">{rate}%</span>}
            </>
          ) : (
            <>
              {categoryTitle(st)} <span className="rate">no record yet</span>
            </>
          )}
        </span>
        <span className="facts">
          <span>
            vs {opponent} {wlOf(st.h2h)}
          </span>
          <span className="muted">Overall {wlOf(st.overall)}</span>
          <Form recent={st.recent} />
          {st.streak && st.streak.n >= 2 && (
            <span className={st.streak.kind === 'W' ? 'good' : 'bad'}>
              {st.streak.kind === 'W' ? `${st.streak.n} straight` : `missed ${st.streak.n}`}
            </span>
          )}
        </span>
        <p className="judge-odds-reason">“{s.reason}”</p>
      </div>
      <footer className="judge-odds-foot">
        {sourceNote(s)} · base rate {s.base_rate_pct}%
        {s.sample_meaningful ? '' : ' · small sample, leans on the base rate'}
      </footer>
    </section>
  );
}

/** The offers and counters in order: "Logan asks 3 to 1 → Judge suggests 2 to 1 → Agreed". */
export function OddsStrip({ bet }: { bet: BetView }) {
  const steps = oddsSteps(bet.odds, bet.names);
  if (!steps.length) return null;
  const ag = lastAgreed(bet.odds);
  const items = steps.map((s) => {
    const agreed = ag?.offer_id === s.offer_id;
    const cls = s.status === 'open' ? 'open' : agreed ? 'agreed' : 'closed';
    return (
      <li key={s.offer_id} className={`odds-step ${cls}`}>
        <span className="what">
          {s.text}
          {s.status === 'withdrawn' ? ' · withdrawn' : ''}
          {agreed ? ' ✓' : ''}
        </span>
        <span className="stk">
          {agreed ? `Agreed · winner takes ${usd(potOf(ag!))}` : s.stakes}
        </span>
      </li>
    );
  });
  return (
    <ol className="odds-strip" aria-label="odds offers">
      {items.flatMap((li, i) =>
        i === 0
          ? [li]
          : [
              <li key={`arrow-${i}`} className="odds-arrow" aria-hidden="true">
                →
              </li>,
              li,
            ],
      )}
    </ol>
  );
}

/** The terms-phase moment while odds are on the table: the headline, the judge's card, the strip. */
export function OddsMoment({ bet }: { bet: BetView }) {
  const j = judgeOdds(bet.odds);
  const open = bet.odds?.state.open ?? null;
  const ag = lastAgreed(bet.odds);
  let headline: string;
  if (ag) headline = 'Odds agreed. Both confirm with Face ID.';
  else if (open?.from === 'judge')
    headline = 'The judge suggests odds. Both tap Accept or Counter.';
  else if (open) {
    const other = nameOf(bet, open.from === 'A' ? 'B' : 'A');
    headline = `${nameOf(bet, open.from as PartyKey)} made an offer. ${other} taps Accept or Counter.`;
  } else headline = 'Setting the odds…';
  return (
    <div className="odds-moment">
      {/* with the judge's card, its header says who still has to tap */}
      {(!j || (ag && ag.offer_id !== j.offer.offer_id)) && (
        <p className={`big${j ? ' compact' : ''}`}>{headline}</p>
      )}
      {j ? (
        <JudgeOddsCard bet={bet} judge={j} />
      ) : (
        <p className="muted">
          Ask the judge “what odds are fair?” and it reads the odds from{' '}
          {nameOf(bet, bet.envelope?.terms.performer ?? 'B')}&apos;s record.
        </p>
      )}
      <OddsStrip bet={bet} />
    </div>
  );
}
