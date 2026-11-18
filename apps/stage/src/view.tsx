// The pitch screen's components (ARCHITECTURE §2 apps/stage row, §5.2 "what the UI shows when";
// BRIEF 5i). Built for a projector at 5 m: dark, high contrast, sized in viewport units so a
// 1280x720 projector shows the same layout as a 4K one, and never scrolling.
//
//   top:    brand · phase rail (Challenge -> Terms -> Lock -> Attempt/Market -> Ruling -> Paid)
//   left:   the two players (photo or initials, Face ID per party, online) · the terms card with
//           the terms code · a Gemini bet's market panel (Beat 6) · the moment panel (whatever
//           just happened, big) · live judge caption
//   right:  Gemini BTC 5-minute odds · the on-chain ticker with Explorer links
//   bottom: demo health (fee payer SOL, free nonces, RPC / DB ms, REPLAY clips cached)
// Overlays: the PAID moment, a big Explorer QR (Q), REPLAY clips (1-6), key help (H).
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { GeminiMarketSnapshot } from '@youre-on/shared/gemini';
import { isReplayTicker } from '@youre-on/shared/judge/market-terms';
import { isCachedRulingModel } from '@youre-on/shared/ruling';
import { formatPrice } from '@youre-on/shared/settlement';
import {
  explorerTx,
  finalOutcomeOf,
  framesOf,
  type BetView,
  type PartyKey,
  type TickerEvent,
  type TickerState,
} from './ticker';
import {
  AUTH_METHOD,
  clock,
  eventLabel,
  groupedCode,
  hueOf,
  initials,
  lagLabel,
  shortSig,
  usd,
  usdPrice,
} from './format';
import { marketView, type MarketView } from './market';
import { endedEarly, isDecisiveOrVoid, isMarketBet, phaseOf, phaseSteps } from './phase';
import { qrSvg } from './qr';
import { healthItems, type DemoHealth, type HealthItem } from './health';
import { BEAT_TITLES, replayProgress, type ReplayStatus } from './replays';
import { verifiedChain, type Verification } from './verify';

const nameOf = (b: BetView, p: PartyKey) => b.names[p] ?? (p === 'A' ? 'Player A' : 'Player B');

/**
 * Who signs the lock (POST /v1/stage/session `lock_signer`, else GET /v1/demo/health). With
 * 'server' (the production demo config) the server signs as the demo-a / demo-b keys right after
 * the build and records the method as faceid_hold, so the projector must not claim Face ID: the
 * slots read "demo key" instead. null (unknown) keeps the phones wording.
 */
export type LockSigner = 'phones' | 'server' | null;
export const LockSignerContext = createContext<LockSigner>(null);
const useCustodial = () => useContext(LockSignerContext) === 'server';
export const normalizeSigner = (v: unknown): LockSigner =>
  v === 'server' || v === 'phones' ? v : null;

/** How a party's authorization reads: the method (Face ID / Passcode), or the demo key. */
function authLabel(method: string, custodial: boolean): string {
  return custodial ? 'demo key' : (AUTH_METHOD[method] ?? method);
}

/** The winner of a decisive ruling (or of the appeal), else null. */
export function winnerOf(b: BetView): PartyKey | null {
  const o = b.appeal_result?.final_outcome ?? b.ruling?.outcome;
  return o === 'A_WINS' ? 'A' : o === 'B_WINS' ? 'B' : null;
}

/** The newest transaction worth scanning: payout, then ruling, then lock. */
export function featuredTx(b: BetView): { label: string; signature: string } | null {
  if (b.payout?.signature) return { label: 'Payout transaction', signature: b.payout.signature };
  if (b.txs.resolve) return { label: 'Ruling transaction', signature: b.txs.resolve };
  if (b.lock?.signature) return { label: 'Lock transaction', signature: b.lock.signature };
  return null;
}

export function ExplorerLink({ sig, label }: { sig: string; label?: string }) {
  return (
    <a className="explorer" href={explorerTx(sig)} target="_blank" rel="noreferrer">
      {label ?? shortSig(sig)} ↗
    </a>
  );
}

// ---- QR -------------------------------------------------------------------------------------

export function QrCode({ text, label }: { text: string; label?: string }) {
  const q = useMemo(() => {
    try {
      return qrSvg(text);
    } catch {
      return null;
    }
  }, [text]);
  if (!q) return null;
  return (
    <svg
      className="qr"
      viewBox={`0 0 ${q.side} ${q.side}`}
      role="img"
      aria-label={label ?? `QR code: ${text}`}
      shapeRendering="crispEdges"
    >
      <rect width={q.side} height={q.side} fill="#fff" />
      <path d={q.path} fill="#000" />
    </svg>
  );
}

export function TxQrCard({ tx }: { tx: { label: string; signature: string } }) {
  return (
    <figure className="qr-card">
      <QrCode text={explorerTx(tx.signature)} label={`QR: ${tx.label} on Solana Explorer`} />
      <figcaption>
        <span className="label">SCAN · {tx.label}</span>
        <span className="muted">Solana Explorer · devnet</span>
      </figcaption>
    </figure>
  );
}

// ---- players --------------------------------------------------------------------------------

export function Avatar({
  name,
  url,
  size = 'lg',
}: {
  name: string | null;
  url: string | null;
  size?: 'lg' | 'sm';
}) {
  const [broken, setBroken] = useState(false);
  const style = { '--hue': String(hueOf(name)) } as CSSProperties;
  return (
    <span className={`avatar ${size}`} style={style} aria-hidden="true">
      {url && !broken ? (
        <img src={url} alt="" onError={() => setBroken(true)} referrerPolicy="no-referrer" />
      ) : (
        <span className="initials">{initials(name)}</span>
      )}
    </span>
  );
}

function partyStatus(
  b: BetView,
  p: PartyKey,
  online: boolean | null,
  custodial: boolean,
): ReactNode {
  const won = winnerOf(b);
  if (b.payout) {
    const amount = p === 'A' ? b.payout.to_a : b.payout.to_b;
    return amount !== '0' ? (
      <span className="status win">+{usd(amount)}</span>
    ) : (
      <span className="status muted">$0</span>
    );
  }
  if (won)
    return won === p ? (
      <span className="status win">WINNER</span>
    ) : (
      <span className="status muted">GG</span>
    );
  if (b.declined === p) return <span className="status bad">declined</span>;
  const a = b.auth[p];
  const locked = b.lock && b.lock.status !== 'failed';
  if (a || locked)
    return <span className="status good">✓ {a ? authLabel(a.method, custodial) : 'locked'}</span>;
  if (online === false) return <span className="status bad">offline</span>;
  if (b.envelope && custodial && p === 'B' && b.invite === 'accepted')
    return <span className="status good">✓ accepted</span>;
  if (b.envelope)
    return (
      <span className="status waiting">
        {custodial ? (p === 'A' ? 'confirming terms…' : 'waiting…') : 'waiting for Face ID…'}
      </span>
    );
  if (p === 'B' && b.invite === 'accepted') return <span className="status good">✓ accepted</span>;
  return <span className="status muted">{online ? 'online' : ' '}</span>;
}

export function PartyCard({
  bet,
  party,
  online,
}: {
  bet: BetView;
  party: PartyKey;
  online: boolean | null;
}) {
  const won = winnerOf(bet);
  const custodial = useCustodial();
  const cls = `party party-${party.toLowerCase()}${won === party ? ' winner' : won ? ' loser' : ''}`;
  return (
    <div className={cls}>
      <Avatar name={bet.names[party]} url={bet.avatars[party]} />
      <div className="party-text">
        <span className="name">{nameOf(bet, party)}</span>
        {partyStatus(bet, party, online, custodial)}
      </div>
    </div>
  );
}

// ---- terms ----------------------------------------------------------------------------------

export function TermsCard({ bet }: { bet: BetView }) {
  const env = bet.envelope;
  if (!env)
    return (
      <section className="terms pending" aria-label="terms">
        <span className="label">TERMS</span>
        <p className="claim muted">The judge is setting the terms…</p>
      </section>
    );
  const t = env.terms;
  const same = t.stakes.a === t.stakes.b;
  return (
    <section className="terms" aria-label="terms">
      <div className="terms-main">
        <span className="label">TERMS · {env.presentation.title}</span>
        <p className="claim">“{t.claim}”</p>
        <div className="stakes">
          {same ? (
            <span className="chip">{usd(t.stakes.a)} each</span>
          ) : (
            <>
              <span className="chip">
                {t.party_a.display_name} {usd(t.stakes.a)}
              </span>
              <span className="chip">
                {t.party_b.display_name} {usd(t.stakes.b)}
              </span>
            </>
          )}
          <span className="chip">
            pot {usd((BigInt(t.stakes.a) + BigInt(t.stakes.b)).toString())}
          </span>
          {t.market && (
            <span className="chip market">
              {t.party_a.display_name} {t.market.side === 'YES' ? 'UP' : 'DOWN'} · Gemini{' '}
              {Math.round(Number(t.market.priceAtLock) * 100)}% up at lock
            </span>
          )}
        </div>
      </div>
      {bet.terms_code && (
        <div className="code-box" aria-label="terms code">
          <span className="label">TERMS CODE</span>
          <span className="code">{groupedCode(bet.terms_code)}</span>
        </div>
      )}
    </section>
  );
}

// ---- the phase rail -------------------------------------------------------------------------

export function PhaseRail({ bet }: { bet: BetView | null }) {
  return (
    <ol className="rail" aria-label="phase">
      {phaseSteps(bet).map((s, i) => (
        <li
          key={s.key}
          className={`step ${s.status}`}
          aria-current={s.status === 'current' ? 'step' : undefined}
        >
          <span className="n">
            {s.status === 'done' ? '✓' : s.status === 'failed' ? '✕' : i + 1}
          </span>
          <span className="t">{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

// ---- the moment panel -----------------------------------------------------------------------

/**
 * The three signatures on the one lock transaction (ARCHITECTURE §5.2): A's and B's (on their own
 * phone behind Face ID with LOCK_SIGNER=phones; by the server with the custodial demo keys with
 * LOCK_SIGNER=server), and the server's fee payer, which signs last and pays the fees.
 */
export function SignerSlots({ bet }: { bet: BetView }) {
  const custodial = useCustodial();
  const lock = bet.lock && bet.lock.status !== 'failed' ? bet.lock : null;
  const slot = (p: PartyKey) => {
    const a = bet.auth[p];
    const ok = !!a || !!lock;
    return (
      <li key={p} className={`slot ${ok ? 'ok' : bet.declined === p ? 'no' : 'wait'}`}>
        <Avatar name={bet.names[p]} url={bet.avatars[p]} size="sm" />
        <span className="who">{nameOf(bet, p)}</span>
        <span className="how">
          {bet.declined === p
            ? 'declined'
            : a
              ? `✓ ${authLabel(a.method, custodial)}`
              : lock
                ? '✓ signed'
                : 'waiting…'}
        </span>
      </li>
    );
  };
  return (
    <ol className="slots" aria-label="signatures">
      {slot('A')}
      {slot('B')}
      <li className={`slot ${lock ? 'ok' : 'idle'}`}>
        <span className="avatar sm fee" aria-hidden="true">
          <span className="initials">◎</span>
        </span>
        <span className="who">Fee payer</span>
        <span className="how">{lock ? '✓ signed' : 'signs last'}</span>
      </li>
    </ol>
  );
}

function LockLine({ bet }: { bet: BetView }) {
  const l = bet.lock!;
  const streams = lagLabel(l.sent_at, l.onchain_at);
  const status =
    l.status === 'failed'
      ? `failed${l.error ? `: ${l.error}` : ''}`
      : l.onchain
        ? `✓ on-chain${streams ? ` · Streams ${streams}` : ''}`
        : l.status === 'confirmed'
          ? '✓ confirmed'
          : 'sending…';
  return (
    <div className="receipt">
      <span className="label">LOCK</span>
      <span>
        {l.kind === 'atomic_lock'
          ? `1 transaction · ${l.signers} signatures`
          : `${l.kind} · ${l.signers} signatures`}
      </span>
      {l.signature && <ExplorerLink sig={l.signature} />}
      <span
        className={
          l.status === 'failed' ? 'bad' : l.onchain || l.status === 'confirmed' ? 'good' : 'muted'
        }
      >
        {status}
      </span>
    </div>
  );
}

export function FrameStrip({ urls, cited }: { urls: string[]; cited: number[] }) {
  if (!urls.length) return null;
  return (
    <ol className="frames" aria-label="evidence frames">
      {urls.slice(0, 12).map((u, i) => (
        <li key={i} className={cited.includes(i) ? 'cited' : undefined}>
          {u ? <img src={u} alt={`frame ${i}`} loading="eager" /> : <span className="loading" />}
        </li>
      ))}
    </ol>
  );
}

function AppealBar({ bet, now }: { bet: BetView; now: number }) {
  if (bet.appeal_deadline === null || bet.payout) return null;
  const left = bet.appeal_deadline * 1000 - now;
  const total = bet.resolved_at ? (bet.appeal_deadline - bet.resolved_at) * 1000 : 10_000;
  const frac = Math.max(0, Math.min(1, left / Math.max(1, total)));
  return (
    <div className={`appeal ${left > 0 ? 'open' : 'closed'}`}>
      <span className="countdown">
        {left > 0 ? `Appeal window ${clock(left)}` : 'Appeal window closed'}
      </span>
      <span className="bar" aria-hidden="true">
        <span style={{ width: `${(frac * 100).toFixed(1)}%` }} />
      </span>
    </div>
  );
}

function outcomeLine(b: BetView): string {
  const r = b.ruling!;
  if (r.outcome === 'A_WINS') return `${nameOf(b, 'A')} wins`;
  if (r.outcome === 'B_WINS') return `${nameOf(b, 'B')} wins`;
  if (r.outcome === 'REDO') return 'Redo';
  return `Void${r.void_reason ? ` · ${r.void_reason.replace(/_/g, ' ')}` : ''} · refund`;
}

const PROVIDER: Record<string, string> = { anthropic: 'Claude', openai: 'GPT', google: 'Gemini' };

function AppealPanel({ bet }: { bet: BetView }) {
  const r = bet.appeal_result;
  return (
    <div className="appeal-panel">
      <span className="label">APPEAL · THREE-MODEL PANEL</span>
      <ol className="votes">
        {[0, 1, 2].map((seat) => {
          const v = bet.votes.find((x) => x.seat === seat);
          return (
            <li
              key={seat}
              className={
                v ? `vote ${v.counted_as === 'ABSTAIN' ? 'abstain' : 'cast'}` : 'vote pending'
              }
            >
              <span className="who">
                {v ? (PROVIDER[v.provider] ?? v.provider) : `Seat ${seat + 1}`}
              </span>
              <span className="what">
                {!v
                  ? 'deliberating…'
                  : v.status !== 'ok' || v.outcome === 'REDO'
                    ? 'abstains'
                    : `${nameOf(bet, v.outcome === 'A_WINS' ? 'A' : 'B')} · ${Math.round(v.confidence * 100)}%`}
              </span>
            </li>
          );
        })}
      </ol>
      {r && (
        <p className="appeal-result">
          {r.flipped ? 'Overturned' : 'Ruling stands'} ·{' '}
          {r.final_outcome === 'VOID'
            ? 'refund'
            : `${nameOf(bet, r.final_outcome === 'A_WINS' ? 'A' : 'B')} wins`}{' '}
          <span className="muted">
            ({r.tally.A_WINS}-{r.tally.B_WINS}, {r.tally.ABSTAIN} abstain)
          </span>
        </p>
      )}
    </div>
  );
}

function HearingPanel({ bet, now }: { bet: BetView; now: number }) {
  const h = bet.hearing!;
  return (
    <div className="hearing">
      <span className="label">HEARING · EACH SIDE ARGUES</span>
      {h.open && (
        <p className="big">
          {nameOf(bet, h.open.party)} argues ·{' '}
          <span className="countdown">{clock(Date.parse(h.open.closes_at) - now)}</span>
        </p>
      )}
      {h.turns.map((t) => (
        <p key={t.party} className="turn">
          <b>{nameOf(bet, t.party)}:</b> “{t.transcript || '…'}”
        </p>
      ))}
    </div>
  );
}

function RulingPanel({ bet, now }: { bet: BetView; now: number }) {
  const r = bet.ruling;
  if (!r) return null;
  const cited = r.cited_frames[0];
  const citedUrl = cited !== undefined ? bet.frame_urls[cited] : undefined;
  return (
    <div
      className={`ruling ${r.outcome === 'REDO' ? 'redo' : r.outcome === 'VOID' ? 'void' : 'decisive'}`}
    >
      <span className="label">
        {r.stage === 'settlement'
          ? 'GEMINI SETTLES IT'
          : r.stage === 'hearing'
            ? 'THE JUDGE RULES · AFTER THE HEARING'
            : `THE JUDGE RULES${r.attempt_no ? ` · ATTEMPT ${r.attempt_no}` : ''}`}
        {/* CACHED_RULING: a stored verdict, no model call (ARCHITECTURE §7.2): say so on screen */}
        {isCachedRulingModel(r.model) && (
          <>
            {' '}
            <span className="replay-badge inline" title={r.model}>
              replay ruling
            </span>
          </>
        )}
      </span>
      <div className="verdict">{outcomeLine(bet)}</div>
      <div className="ruling-row">
        <div className="ruling-text">
          <p className="reason">{r.reason}</p>
          {r.outcome !== 'REDO' && <AppealBar bet={bet} now={now} />}
          {bet.appealed && !bet.payout && !bet.appeal_result && bet.votes.length === 0 && (
            <span className="countdown">Appealed · the panel is reviewing</span>
          )}
        </div>
        {citedUrl && (
          <figure className="cited">
            <img src={citedUrl} alt={`cited frame ${cited}`} />
            <figcaption>frame {cited}</figcaption>
          </figure>
        )}
      </div>
    </div>
  );
}

function PlayPanel({ bet, now, market }: { bet: BetView; now: number; market: MarketView | null }) {
  const redoPending =
    bet.ruling?.outcome === 'REDO' && (bet.attempt_no ?? 0) <= (bet.ruling.attempt_no ?? 0);
  if (redoPending) return <RulingPanel bet={bet} now={now} />;
  const pot =
    bet.envelope &&
    usd((BigInt(bet.envelope.terms.stakes.a) + BigInt(bet.envelope.terms.stakes.b)).toString());
  let line: ReactNode;
  if (isMarketBet(bet)) {
    line = (
      <p className="big">
        Waiting on Gemini
        {market ? (
          <>
            {' '}
            · closes in <span className="countdown">{clock(market.msLeft)}</span>
          </>
        ) : null}
      </p>
    );
  } else if (bet.attempt_no !== null && bet.frame_urls.length) {
    line = (
      <p className="big">
        {bet.attempt_no > 1 ? `Attempt ${bet.attempt_no} · ` : ''}The judge is watching{' '}
        {bet.frame_urls.length} frames…
      </p>
    );
  } else if (bet.attempt_no !== null) {
    const who = bet.performer ?? bet.envelope?.terms.performer ?? null;
    line = (
      <p className="big">
        {bet.attempt_no > 1 ? `Redo · attempt ${bet.attempt_no}` : `Attempt ${bet.attempt_no}`}
        {who ? ` · ${nameOf(bet, who)} is up` : ''} <span className="rec">● REC</span>
      </p>
    );
  } else
    line = (
      <p className="big muted">
        Ready when you are, {nameOf(bet, bet.envelope?.terms.performer ?? 'B')}.
      </p>
    );
  const showSigners = bet.attempt_no === null && !isMarketBet(bet);
  return (
    <div className="play">
      <div className="headline">
        <span className="stamp good">LOCKED</span>
        {pot && <span className="pot">{pot} in escrow</span>}
      </div>
      {showSigners && (
        <>
          <p className="sub">Both stakes, one atomic transaction, three signatures:</p>
          <SignerSlots bet={bet} />
        </>
      )}
      {line}
      <FrameStrip urls={bet.frame_urls} cited={[]} />
    </div>
  );
}

function PaidPanel({ bet }: { bet: BetView }) {
  const p = bet.payout!;
  const refund =
    p.event === 'BetRefunded' ||
    p.event === 'BetCancelled' ||
    p.event === 'Refund' ||
    bet.state === 'VOIDED' ||
    finalOutcomeOf(bet) === 'VOID';
  return (
    <div className="paid">
      <div className="headline">
        <span className="stamp win">{refund ? 'REFUNDED' : 'PAID'}</span>
        <span className="pot muted">{p.event} · devnet</span>
      </div>
      <div className="payouts">
        {(['A', 'B'] as const).map((k) => {
          const amt = k === 'A' ? p.to_a : p.to_b;
          return (
            <div key={k} className={`payout-row${amt !== '0' ? ' got' : ''}`}>
              <span>{nameOf(bet, k)}</span>
              <span className="amt">{amt !== '0' ? `+${usd(amt)}` : '$0'}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Beat 2: the rules the judge wrote, and the edge cases it asked about. */
function RulesPanel({ bet }: { bet: BetView }) {
  const t = bet.envelope!.terms;
  return (
    <div className="rules">
      <p className="big">Terms are set. Both confirm on their phones.</p>
      <ul>
        {t.success_criteria.slice(0, 3).map((c, i) => (
          <li key={`s${i}`} className="yes">
            <span aria-hidden="true">✓</span> {c}
          </li>
        ))}
        {t.failure_criteria.slice(0, 2).map((c, i) => (
          <li key={`f${i}`} className="no">
            <span aria-hidden="true">✕</span> {c}
          </li>
        ))}
        {t.edge_cases.slice(0, 2).map((e, i) => (
          <li key={`e${i}`} className="edge">
            <span aria-hidden="true">?</span> {e.question} <b>{e.answer}</b>
          </li>
        ))}
      </ul>
      <p className="muted">
        Same terms code on both phones and up here: everyone agrees to the same bet.
      </p>
    </div>
  );
}

function ChallengePanel({ bet }: { bet: BetView }) {
  const a = nameOf(bet, 'A');
  const b = nameOf(bet, 'B');
  return (
    <div className="intro">
      <p className="big">
        {a} challenged {b}
      </p>
      <p className="muted">
        {bet.invite === 'declined'
          ? `${b} declined.`
          : bet.invite === 'accepted'
            ? 'Challenge accepted. The judge is listening.'
            : `Waiting for ${b} to accept…`}
      </p>
    </div>
  );
}

function LockPhasePanel({ bet }: { bet: BetView }) {
  const custodial = useCustodial();
  const n = (bet.auth.A ? 1 : 0) + (bet.auth.B ? 1 : 0);
  return (
    <div className="intro">
      <SignerSlots bet={bet} />
      <p className={`big${bet.lock?.status === 'failed' ? ' bad' : ''}`}>
        {bet.lock?.status === 'failed'
          ? "The lock didn't go through"
          : bet.lock
            ? 'Locking both stakes in one transaction…'
            : custodial
              ? n === 0
                ? 'Signing with the demo keys…'
                : `${n} of 2 signed`
              : n === 0
                ? 'Hold to confirm + Face ID on both phones'
                : `${n} of 2 authorized`}
      </p>
      <p className="muted">
        {bet.lock?.status === 'failed'
          ? "Couldn't lock it. Nothing moved."
          : custodial
            ? 'Nothing has moved yet: demo keys sign for both players, then a single transaction.'
            : 'Nothing has moved yet: one signature per phone, then a single transaction.'}
      </p>
    </div>
  );
}

export function MomentPanel({
  bet,
  now,
  market,
}: {
  bet: BetView;
  now: number;
  market: MarketView | null;
}) {
  const phase = phaseOf(bet);
  const tx = featuredTx(bet);
  const ended = endedEarly(bet);
  let body: ReactNode;
  if (ended && phase !== 'ruling')
    body = (
      <div className="intro">
        <p className="big bad">{ended === 'cancelled' ? 'Cancelled' : 'Expired'}</p>
        <p className="muted">Nothing was paid out{bet.lock ? '; any stakes were refunded' : ''}.</p>
      </div>
    );
  else if (phase === 'paid' && bet.payout) body = <PaidPanel bet={bet} />;
  else if (phase === 'ruling' || phase === 'paid')
    body = (
      <>
        {bet.hearing &&
        bet.ruling?.stage !== 'hearing' &&
        !isDecisiveOrVoid(bet.ruling?.outcome) ? (
          <HearingPanel bet={bet} now={now} />
        ) : (
          <RulingPanel bet={bet} now={now} />
        )}
        {(bet.appealed || bet.votes.length > 0) && <AppealPanel bet={bet} />}
      </>
    );
  else if (phase === 'play') body = <PlayPanel bet={bet} now={now} market={market} />;
  else if (phase === 'lock') body = <LockPhasePanel bet={bet} />;
  else if (phase === 'terms')
    body = bet.envelope ? (
      <RulesPanel bet={bet} />
    ) : (
      <div className="intro">
        <p className="big">Negotiating terms…</p>
        <p className="muted">
          The AI judge asks the edge-case questions, then reads the terms back.
        </p>
      </div>
    );
  else body = <ChallengePanel bet={bet} />;

  return (
    <section className={`moment phase-${phase}`} aria-label="moment">
      <div className="moment-body">{body}</div>
      {tx && <TxQrCard tx={tx} />}
      {bet.lock && phase !== 'lock' && (
        <footer className="receipts">
          <LockLine bet={bet} />
          {bet.txs.resolve && (
            <div className="receipt">
              <span className="label">RULING</span>
              <ExplorerLink sig={bet.txs.resolve} />
            </div>
          )}
          {bet.payout?.signature && (
            <div className="receipt">
              <span className="label">PAYOUT</span>
              <ExplorerLink sig={bet.payout.signature} />
            </div>
          )}
        </footer>
      )}
      {bet.lock && phase === 'lock' && (
        <footer className="receipts">
          <LockLine bet={bet} />
        </footer>
      )}
    </section>
  );
}

// ---- Beat 6: the market bet -----------------------------------------------------------------

/**
 * Beat 6 on the projector: a Gemini bet's live market (who holds Up / Down at what stake, the
 * line, BTC live, who is ahead, the countdown to the contract's expiry), then Gemini's settled
 * result with the evidence hash and the stage's own re-check of the evidence chain (verify.ts).
 */
export function MarketPanel({
  bet,
  tick,
  now,
  verification = null,
}: {
  bet: BetView;
  /** The latest snapshot of THIS bet's contract (market.tick, or the relay's if it matches). */
  tick: GeminiMarketSnapshot | null;
  now: number;
  verification?: Verification | null;
}) {
  const t = bet.envelope?.terms;
  const m = t?.market;
  if (!t || !m) return null;
  const aUp = m.side === 'YES';
  const up = aUp ? t.party_a.display_name : t.party_b.display_name;
  const down = aUp ? t.party_b.display_name : t.party_a.display_name;
  const upStake = aUp ? t.stakes.a : t.stakes.b;
  const downStake = aUp ? t.stakes.b : t.stakes.a;
  const pot = (BigInt(t.stakes.a) + BigInt(t.stakes.b)).toString();
  const s = bet.settlement?.record;
  // once Gemini has settled it the contract is over, whatever the local clock says
  const left = s ? 0 : Date.parse(m.expiry) - now;
  const live = tick && tick.eventTicker === m.eventTicker ? tick.indexPrice : null;
  const line = m.strike.value;
  const ahead = live !== null && line !== null ? (Number(live) >= Number(line) ? up : down) : null;
  const pct = Math.round(Number(m.priceAtLock) * 100);
  const side = s
    ? s.contract.resolutionSide === 'yes'
      ? 'up'
      : 'down'
    : live !== null && line !== null
      ? Number(live) >= Number(line)
        ? 'up'
        : 'down'
      : '';
  // the card has no room to spare: the live line rides in the header, the result gets one row
  return (
    <section className="market" aria-label="market bet">
      <div className="market-head">
        <span className="label">BTC 5-MIN · GEMINI</span>
        {isReplayTicker(m.eventTicker) && (
          <span className="replay-badge inline">REPLAY · recorded Gemini round</span>
        )}
        <span className="muted">
          Up {pct}% · locked at Gemini {m.priceSource === 'mid' ? 'mid' : 'last trade'}
        </span>
        {s ? null : left > 0 ? (
          ahead && <span className="market-live">{ahead} is ahead</span>
        ) : (
          <span className="market-live countdown">Waiting for Gemini to settle…</span>
        )}
      </div>
      <div className="market-sides">
        <span className={s?.contract.resolutionSide === 'yes' ? 'good' : undefined}>
          ▲ {up} Up {usd(upStake)}
        </span>
        <span className={s?.contract.resolutionSide === 'no' ? 'good' : undefined}>
          ▼ {down} Down {usd(downStake)}
        </span>
        <span className="muted">pot {usd(pot)}</span>
      </div>
      <div className="odds-grid">
        <div>
          <span className="label">LINE</span>
          <span className="num">{line === null ? 'pending' : formatPrice(line)}</span>
        </div>
        <div>
          <span className="label">{s ? 'SETTLED' : 'BTC'}</span>
          <span className={`num ${side}`}>
            {s
              ? s.contract.settlementValue === null
                ? '—'
                : formatPrice(s.contract.settlementValue)
              : live === null
                ? '—'
                : formatPrice(live)}
          </span>
        </div>
        <div>
          <span className="label">{left > 0 ? 'SETTLES IN' : 'EXPIRED'}</span>
          <span className="num">{left > 0 ? clock(left) : m.expiry.slice(11, 16)}</span>
        </div>
      </div>
      {s && (
        <p className="market-status">
          {s.contract.status === 'invalid' ? (
            <span className="market-result bad">Gemini voided the contract · both stakes back</span>
          ) : (
            <span className="market-result good">
              Gemini settled {s.contract.resolutionSide === 'yes' ? 'UP' : 'DOWN'} ·{' '}
              {s.contract.resolutionSide === 'yes' ? up : down} wins
            </span>
          )}
          <span className="muted market-evidence">
            evidence <code>{bet.settlement!.evidence_hash.slice(0, 8)}</code> ·{' '}
            <a className="explorer" href={s.source_url} target="_blank" rel="noreferrer">
              Gemini ↗
            </a>
          </span>
          {verification && (
            <span className={`market-evidence ${verification.ok ? 'good' : 'bad'}`}>
              {verification.ok
                ? `✓ verified: ${verifiedChain(verification)}`
                : `✗ evidence mismatch: ${verification.failed.join(', ')}`}
            </span>
          )}
        </p>
      )}
    </section>
  );
}

/** A Gemini bet's own contract snapshot: its latest market.tick, else the relay's if it matches. */
export function betTickOf(
  state: Pick<TickerState, 'betTicks' | 'market'>,
  bet: BetView,
): GeminiMarketSnapshot | null {
  const own = state.betTicks[bet.bet_id];
  if (own) return own;
  const m = bet.envelope?.terms.market;
  return m && state.market?.eventTicker === m.eventTicker ? state.market : null;
}

/** The whole left column for one bet: players, terms, a Gemini bet's market, the moment, the caption. */
export function BetCard({
  bet,
  now,
  market = null,
  presence = null,
  tick = null,
  verification = null,
}: {
  bet: BetView;
  now: number;
  market?: MarketView | null;
  presence?: Record<string, boolean> | null;
  /** Gemini bets: the latest snapshot of the bet's contract. */
  tick?: GeminiMarketSnapshot | null;
  /** Gemini bets: the stage's re-check of the evidence chain, once ruled. */
  verification?: Verification | null;
}) {
  const online = (p: PartyKey): boolean | null => {
    const id = bet.user_ids[p];
    if (!presence || !id || !(id in presence)) return null;
    return presence[id]!;
  };
  return (
    <section className="card" aria-label="bet">
      <div className="versus">
        <PartyCard bet={bet} party="A" online={online('A')} />
        <span className="vs">VS</span>
        <PartyCard bet={bet} party="B" online={online('B')} />
      </div>
      <TermsCard bet={bet} />
      {bet.envelope?.terms.market && (
        <MarketPanel bet={bet} tick={tick} now={now} verification={verification} />
      )}
      <MomentPanel bet={bet} now={now} market={market} />
      {bet.caption && bet.caption.text.trim() && (
        <p className={`caption${bet.caption.final ? '' : ' partial'}`} aria-live="polite">
          <span className={`label ${bet.caption.speaker === 'judge' ? 'judge' : 'player'}`}>
            {bet.caption.speaker === 'judge' ? 'JUDGE' : nameOf(bet, bet.caption.speaker)}
          </span>{' '}
          {bet.caption.text}
        </p>
      )}
    </section>
  );
}

// ---- overlays -------------------------------------------------------------------------------

export function PaidMoment({ bet }: { bet: BetView }) {
  const p = bet.payout!;
  const w: PartyKey | null =
    p.to_a !== '0' && p.to_b === '0' ? 'A' : p.to_b !== '0' && p.to_a === '0' ? 'B' : null;
  const total = (BigInt(p.to_a) + BigInt(p.to_b)).toString();
  return (
    <div className="paid-moment" role="status" aria-label="paid">
      <div className="burst" aria-hidden="true" />
      <span className="paid-word">PAID</span>
      <span className="paid-line">
        {w ? (
          <>
            {usd(total)} → {nameOf(bet, w)}
          </>
        ) : (
          <>
            {nameOf(bet, 'A')} {usd(p.to_a)} · {nameOf(bet, 'B')} {usd(p.to_b)}
          </>
        )}
      </span>
      <span className="muted">
        {p.event} on Solana devnet{p.signature ? ` · ${shortSig(p.signature)}` : ''}
      </span>
    </div>
  );
}

export function QrOverlay({
  tx,
  onClose,
}: {
  tx: { label: string; signature: string } | null;
  onClose: () => void;
}) {
  return (
    <div className="overlay qr-overlay" role="dialog" aria-label="explorer qr" onClick={onClose}>
      {tx ? (
        <>
          <QrCode text={explorerTx(tx.signature)} label={`QR: ${tx.label}`} />
          <p className="big">{tx.label}</p>
          <p className="muted mono">
            explorer.solana.com/tx/{shortSig(tx.signature)}?cluster=devnet
          </p>
        </>
      ) : (
        <p className="big muted">No transaction yet.</p>
      )}
    </div>
  );
}

export const KEYS: Array<[string, string]> = [
  ['1 – 6', 'Play the REPLAY clip of that beat'],
  ['Esc', 'Close any overlay'],
  ['F', 'Full screen on / off'],
  ['Q', 'Big QR of the latest transaction'],
  ['M', 'Sound on / off (any key unlocks it); off stops the line being said'],
  ['V', 'Judge voice on / off; off stops the line being said'],
  ['H or ?', 'This help'],
];

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay help" role="dialog" aria-label="keys" onClick={onClose}>
      <h2>Keys</h2>
      <dl>
        {KEYS.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function ReplayOverlay({
  beat,
  src,
  onClose,
}: {
  beat: number;
  src: string;
  onClose: () => void;
}) {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!missing) return;
    const t = setTimeout(onClose, 2500);
    return () => clearTimeout(t);
  }, [missing, onClose]);
  return (
    <div className="replay" role="dialog" aria-label={`replay beat ${beat}`} onClick={onClose}>
      <span className="replay-badge">
        REPLAY · Beat {beat}
        {BEAT_TITLES[beat] ? ` · ${BEAT_TITLES[beat]}` : ''}
      </span>
      {missing ? (
        <p className="big muted">No clip at replay/beat{beat}.mp4</p>
      ) : (
        <video src={src} autoPlay playsInline onEnded={onClose} onError={() => setMissing(true)} />
      )}
    </div>
  );
}

// ---- the right column -----------------------------------------------------------------------

const TICKER_TYPES =
  /^(chain\.|tx\.|terms\.authorized|terms\.declined|ruling\.issued|appeal\.result)/;

export function tickerRows(state: TickerState, max = 14): TickerEvent[] {
  return state.events
    .filter((e) => TICKER_TYPES.test(e.type))
    .slice()
    .reverse()
    .slice(0, max);
}

/** chain.* lag after the tx.submitted of the same signature: the Streams proof. */
function streamsLag(state: TickerState, e: TickerEvent): string | null {
  if (e.source !== 'chain') return null;
  const sig = (e.payload as { signature?: string } | null)?.signature;
  if (!sig) return null;
  const sent = state.events.find(
    (x) =>
      x.type === 'tx.submitted' && (x.payload as { signature?: string } | null)?.signature === sig,
  );
  return sent ? lagLabel(sent.ts, e.ts) : null;
}

const hhmmss = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
};

export function Ticker({ state }: { state: TickerState }) {
  const custodial = useCustodial();
  const rows = tickerRows(state);
  // the header names the source truthfully: Streams only once a chain event actually came
  const streamed = state.events.some((e) => e.source === 'chain');
  return (
    <section aria-label="ticker" className="ticker">
      <h2>
        On-chain · devnet{' '}
        <span className="muted">{streamed ? 'via QuickNode Streams' : 'via Solana RPC'}</span>
      </h2>
      {state.errors.length > 0 && (
        <ul className="errors">
          {state.errors.slice(-2).map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {rows.length === 0 ? (
        <p className="muted">No events yet.</p>
      ) : (
        <ol className="events">
          {rows.map((e) => {
            const lag = streamsLag(state, e);
            return (
              <li
                key={`${e.bet_id}:${e.seq}`}
                className={e.source === 'chain' ? 'chain' : 'server'}
              >
                <span className="t">{hhmmss(e.ts)}</span>
                <span className="what">
                  <code>
                    {eventLabel(e.type, e.payload, state.bets[e.bet_id]?.names, custodial)}
                  </code>
                  {lag && <span className="lag"> {lag}</span>}
                </span>
                {e.explorer ? (
                  <a className="explorer" href={e.explorer} target="_blank" rel="noreferrer">
                    ↗
                  </a>
                ) : (
                  <span />
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function Sparkline({ points, strike }: { points: number[]; strike: number | null }) {
  if (points.length < 2) return <div className="spark" />;
  const all = strike !== null ? [...points, strike] : points;
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo || 1;
  const y = (v: number) => 100 - ((v - lo) / span) * 100;
  const d = points
    .map((p, i) => `${((i / (points.length - 1)) * 300).toFixed(1)},${y(p).toFixed(1)}`)
    .join(' ');
  return (
    <svg className="spark" viewBox="0 -4 300 108" preserveAspectRatio="none" aria-hidden="true">
      {strike !== null && <line x1="0" x2="300" y1={y(strike)} y2={y(strike)} className="strike" />}
      <polyline points={d} fill="none" />
    </svg>
  );
}

export function OddsWidget({
  view,
  bet = null,
}: {
  view: MarketView | null;
  bet?: BetView | null;
}) {
  if (!view)
    return (
      <section className="odds" aria-label="odds">
        <h2>BTC 5-min · Gemini</h2>
        <p className="muted">Waiting for the market…</p>
      </section>
    );
  const up = view.upPct;
  const t = bet?.envelope?.terms;
  const sides =
    view.split.ok && view.split.fromTerms && t?.market
      ? {
          up: t.market.side === 'YES' ? t.party_a.display_name : t.party_b.display_name,
          down: t.market.side === 'YES' ? t.party_b.display_name : t.party_a.display_name,
        }
      : null;
  return (
    <section className="odds" aria-label="odds">
      <h2>
        BTC 5-min · Gemini <span className="muted">prediction market</span>
      </h2>
      {isReplayTicker(view.eventTicker) && (
        <span className="replay-badge inline">REPLAY · recorded Gemini round</span>
      )}
      <div className="odds-grid">
        <div>
          <span className="label">LINE</span>
          <span className="num">{view.strike ? usdPrice(view.strike) : 'pending'}</span>
        </div>
        <div>
          <span className="label">BTC</span>
          <span className={`num ${view.direction}`}>{usdPrice(view.price)}</span>
        </div>
        <div>
          <span className="label">CLOSES</span>
          <span className="num">{clock(view.msLeft)}</span>
        </div>
        <div>
          <span className="label">UP</span>
          <span className="num">{up !== null ? `${up}%` : '—'}</span>
        </div>
      </div>
      {up !== null && (
        <div className="updown" aria-hidden="true">
          <span className="u" style={{ width: `${up}%` }} />
          <span className="d" />
        </div>
      )}
      <Sparkline points={view.history} strike={view.strike ? Number(view.strike) : null} />
      <div className="split">
        {view.split.ok ? (
          <>
            <span className="good">
              {sides ? `${sides.up} UP` : 'Up'} {usd(view.split.up)} ·{' '}
              {sides ? `${sides.down} DOWN` : 'Down'} {usd(view.split.down)}
            </span>
            <span className="muted">
              of a {usd(view.split.pot)} pot
              {view.split.fromTerms ? ' · locked' : ' · fair stakes now'}
            </span>
          </>
        ) : (
          <span className="muted">{view.split.reason.replace(/_/g, ' ').toLowerCase()}</span>
        )}
      </div>
    </section>
  );
}

// ---- health strip ---------------------------------------------------------------------------

/**
 * The status strip along the bottom: the room and who is online, then (with a demo key) the
 * demo health, the REPLAY clips cached, the socket, the sound hint and disconnect.
 */
export function HealthStrip({
  health,
  error,
  replays,
  status,
  room = null,
  online = null,
  sound = null,
  voice = null,
  onDisconnect,
}: {
  health: DemoHealth | null;
  error: string | null;
  replays: ReplayStatus | null;
  status: string;
  room?: string | null;
  online?: { online: number; members: number } | null;
  sound?: 'locked' | 'on' | 'off' | null;
  /** Whose voice the judge has here: 'ElevenLabs', 'browser', 'off (V)' (App.tsx voiceLabel). */
  voice?: string | null;
  onDisconnect?: () => void;
}) {
  const items: HealthItem[] = [];
  if (room) items.push({ key: 'room', label: 'Room', value: room, level: 'idle' });
  if (online)
    items.push({
      key: 'online',
      label: 'Online',
      value: `${online.online}/${online.members}`,
      level: online.online === online.members ? 'ok' : 'warn',
    });
  if (health) items.push(...healthItems(health));
  if (error) items.unshift({ key: 'err', label: 'Health', value: error, level: 'bad' });
  if (replays) {
    const { ready, present, state } = replayProgress(replays);
    items.push({
      key: 'replay',
      label: 'REPLAY',
      value: `${ready}/${present} cached${
        state === 'loading' ? ' · loading' : state === 'paused' ? ' · paused (live bet)' : ''
      }`,
      level: present === 0 ? 'warn' : ready === present ? 'ok' : 'idle',
    });
  }
  items.push({ key: 'ws', label: 'WS', value: status, level: status === 'open' ? 'ok' : 'warn' });
  if (sound && sound !== 'on')
    items.push({
      key: 'sound',
      label: 'Sound',
      value: sound === 'off' ? 'off (M)' : 'press any key',
      level: 'idle',
    });
  if (voice)
    items.push({
      key: 'voice',
      label: 'Voice',
      value: voice,
      // warn: ElevenLabs is on but the browser said the last line (a late or failed clip)
      level: !voice.startsWith('ElevenLabs')
        ? 'idle'
        : voice.includes('last line: browser')
          ? 'warn'
          : 'ok',
    });
  return (
    <footer className="health" aria-label="status">
      {items.map((i) => (
        <span key={i.key} className={`hi ${i.level}`}>
          <span className="label">{i.label}</span> {i.value}
        </span>
      ))}
      {onDisconnect && (
        <button type="button" className="ghost" onClick={onDisconnect}>
          disconnect
        </button>
      )}
    </footer>
  );
}

// ---- the whole stage ------------------------------------------------------------------------

export function StageView({
  state,
  now,
  onDisconnect,
  preview = null,
  health = null,
  healthError = null,
  showHealth = false,
  replays = null,
  roomLabel = null,
  sound = null,
  voice = null,
  lockSigner = null,
  verifications = {},
}: {
  state: TickerState;
  now: number;
  onDisconnect?: () => void;
  /** The preview step's name ('' for the loop) when showing sample data. */
  preview?: string | null;
  health?: DemoHealth | null;
  healthError?: string | null;
  showHealth?: boolean;
  replays?: ReplayStatus | null;
  roomLabel?: string | null;
  /** 'locked' until a key press unlocks audio; 'off' when muted (M). */
  sound?: 'locked' | 'on' | 'off' | null;
  /** The health strip's voice item (App.tsx voiceLabel). */
  voice?: string | null;
  /** Who signs the lock: 'server' words the signature slots as custodial demo signing. */
  lockSigner?: LockSigner;
  /** Gemini bets' evidence re-checks, by bet id. */
  verifications?: Readonly<Record<string, Verification>>;
}) {
  const bet = state.focusBetId ? (state.bets[state.focusBetId] ?? null) : null;
  const mv = useMemo(
    () => (state.market ? marketView(state.market, state.marketHistory, now, bet) : null),
    [state.market, state.marketHistory, now, bet],
  );
  const live = state.status === 'open';
  return (
    <LockSignerContext.Provider value={lockSigner}>
      <div className="stage">
        <header className="topbar">
          <h1>
            You&apos;re <span className="on">On</span>
          </h1>
          <PhaseRail bet={bet} />
          <div className="conn">
            {preview !== null ? (
              <span className="badge preview">PREVIEW · sample data</span>
            ) : (
              <span className={`badge ${live ? 'live' : 'down'}`}>
                {live ? 'LIVE' : state.status.toUpperCase()}
              </span>
            )}
          </div>
        </header>
        <main className="layout">
          <div className="left">
            {bet ? (
              <BetCard
                bet={{ ...bet, frame_urls: framesOf(state, bet) }}
                now={now}
                market={mv}
                presence={state.presence?.online_by_user ?? null}
                tick={betTickOf(state, bet)}
                verification={verifications[bet.bet_id] ?? null}
              />
            ) : (
              <section className="card empty">
                <p className="huge">Waiting for a challenge…</p>
                <p className="muted">Point a phone at a friend to start a bet.</p>
              </section>
            )}
          </div>
          <aside className="right">
            <OddsWidget view={mv} bet={bet} />
            <Ticker state={state} />
          </aside>
        </main>
        <HealthStrip
          health={showHealth ? health : null}
          error={showHealth ? healthError : null}
          replays={replays}
          status={state.status}
          room={roomLabel}
          online={state.presence}
          sound={sound}
          voice={voice}
          onDisconnect={onDisconnect}
        />
      </div>
    </LockSignerContext.Provider>
  );
}
