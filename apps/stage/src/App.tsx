// Stage view (TASKS D1-J5; ARCHITECTURE §8.2): the laptop on the projector, readable from 5 m.
// Connect with STAGE_KEY (POST /v1/stage/session) or a pasted stage token, then one WebSocket
// for the room: the focused bet's card (parties, terms + terms code, Face ID per party, the lock
// tx with its signer count, the ruling + cited frame + appeal countdown, the payout), the chain
// ticker with devnet Explorer links, and the Gemini BTC 5-minute odds widget. A Gemini bet
// (Beat 6) gets the live market panel: who holds Up / Down at what stake, the line, BTC live,
// who is ahead, the countdown to the contract's expiry, then Gemini's settled result.
// Keys 1-6 play the pre-recorded beat clips (public/replay/beat{n}.mp4) full screen, labelled
// REPLAY; Esc closes.
import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from 'react';
import type { GeminiMarketSnapshot } from '@youre-on/shared/gemini';
import { formatUsd } from '@youre-on/shared/money';
import { isReplayTicker } from '@youre-on/shared/judge/market-terms';
import { sha256Hex } from '@youre-on/shared/primitives';
import {
  formatPrice,
  verifySettlement,
  type SettlementEvidence,
} from '@youre-on/shared/settlement';
import {
  applyFrame,
  explorerTx,
  initialTicker,
  type BetView,
  type TickerEvent,
  type TickerState,
} from './ticker';
import {
  fetchBetSnapshot,
  fetchMarket,
  fetchSettlement,
  fetchStageToken,
  StageConnection,
  wsUrlFor,
  type StageConfig,
} from './connection';
import { marketView, type MarketView } from './market';
import { previewState } from './preview';
import { previewMarketState } from './preview-market';

const STORE_KEY = 'yo-stage-config';
export const REPLAY_BEATS = [1, 2, 3, 4, 5, 6] as const;
/** States in which a bet's resolve has landed (its evidence hashes are on chain). */
const RULED_OR_LATER = new Set([
  'RULED',
  'CONCEDED',
  'FINALIZED',
  'APPEALED',
  'APPEAL_RESOLVED',
  'PAID',
  'VOIDED',
]);

function loadConfig(): StageConfig {
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (raw) return { serverUrl: '', roomId: '', ...(JSON.parse(raw) as Partial<StageConfig>) };
  } catch {
    // storage unavailable: start empty
  }
  return { serverUrl: 'http://localhost:8080', roomId: '' };
}

// ---- small formatting helpers ------------------------------------------------------------

export const shortSig = (s: string) => (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const usd = (micro: string) => {
  try {
    return formatUsd(micro);
  } catch {
    return micro;
  }
};
const usdPrice = (s: string | null) =>
  s === null
    ? '—'
    : `$${Number(s).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const METHOD: Record<string, string> = { faceid_hold: 'Face ID', passcode_hold: 'Passcode' };

function ExplorerLink({ sig, label }: { sig: string; label?: string }) {
  return (
    <a className="explorer" href={explorerTx(sig)} target="_blank" rel="noreferrer">
      {label ?? shortSig(sig)} ↗
    </a>
  );
}

// ---- the chain ticker ----------------------------------------------------------------------

const TICKER_TYPES = /^(chain\.|tx\.|terms\.authorized|ruling\.issued|bet\.state)/;

export function Ticker({ state }: { state: TickerState }) {
  const rows = state.events.filter((e) => TICKER_TYPES.test(e.type));
  return (
    <section aria-label="ticker" className="ticker">
      <h2>On-chain</h2>
      {state.errors.length > 0 && (
        <ul className="errors">
          {state.errors.slice(-3).map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {rows.length === 0 ? (
        <p className="muted">No events yet.</p>
      ) : (
        <ol className="events">
          {[...rows]
            .reverse()
            .slice(0, 12)
            .map((e) => (
              <TickerRow key={`${e.bet_id}:${e.seq}`} e={e} />
            ))}
        </ol>
      )}
    </section>
  );
}

function TickerRow({ e }: { e: TickerEvent }) {
  return (
    <li className={e.source === 'chain' ? 'chain' : 'server'}>
      <code>{e.type}</code> <span className="muted">#{e.seq}</span>{' '}
      {e.explorer && (
        <a className="explorer" href={e.explorer} target="_blank" rel="noreferrer">
          Explorer ↗
        </a>
      )}
    </li>
  );
}

// ---- the bet card --------------------------------------------------------------------------

function partyAuth(b: BetView, p: 'A' | 'B') {
  if (b.declined === p) return <span className="bad">declined</span>;
  const a = b.auth[p];
  if (a) return <span className="good">✓ {METHOD[a.method] ?? a.method}</span>;
  if (b.envelope) return <span className="muted">waiting…</span>;
  return <span className="muted">—</span>;
}

function outcomeLine(b: BetView): string {
  const r = b.ruling!;
  if (r.outcome === 'A_WINS') return `${b.names.A ?? 'A'} wins`;
  if (r.outcome === 'B_WINS') return `${b.names.B ?? 'B'} wins`;
  if (r.outcome === 'REDO') return 'Redo';
  return `Void${r.void_reason ? ` · ${r.void_reason.replace('_', ' ')}` : ''} · refund`;
}

/** Beat 6 on the projector: the live market bet, then Gemini's settled result. */
/** The stage's own re-check of a Gemini bet's evidence chain (verifySettlement). */
export interface Verification {
  ok: boolean;
  /** Gemini's raw response body was part of it (it hashed to the record's response_sha256). */
  body: boolean;
  /** The on-chain hashes were part of it (the resolve landed; read from the chain). */
  onchain: boolean;
  failed: string[];
}

/** "Gemini's response → record → on-chain evidence": only the links that were checked. */
export function verifiedChain(v: Pick<Verification, 'body' | 'onchain'>): string {
  return [v.body && "Gemini's response", 'record', v.onchain ? 'on-chain evidence' : 'ruling']
    .filter(Boolean)
    .join(' → ');
}

/** Re-runs the shared verifySettlement over GET /v1/bets/:id/settlement (never trusts its `ok`). */
export function verifyEvidence(bet: BetView, ev: SettlementEvidence): Verification | null {
  const t = bet.envelope?.terms;
  if (!t?.market) return null;
  const v = verifySettlement({
    record: ev.record,
    evidence_hash: ev.evidence_hash,
    ruling: ev.ruling,
    ruling_hash: ev.ruling_hash,
    terms: { yes_party: t.yes_party, market: t.market },
    body_sha256: ev.raw_body === null ? null : sha256Hex(ev.raw_body),
    onchain: ev.onchain,
  });
  return {
    ok: v.ok,
    body: v.checks.body_matches_record === true,
    onchain: v.checks.onchain_evidence === true && v.checks.onchain_ruling === true,
    failed: Object.entries(v.checks)
      .filter(([, good]) => !good)
      .map(([k]) => k.replace(/_/g, ' ')),
  };
}

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
  const left = Date.parse(m.expiry) - now;
  const s = bet.settlement?.record;
  const live = tick && tick.eventTicker === m.eventTicker ? tick.indexPrice : null;
  const line = m.strike.value;
  const ahead = live !== null && line !== null ? (Number(live) >= Number(line) ? up : down) : null;
  const pct = Math.round(Number(m.priceAtLock) * 100);
  return (
    <div className="market" aria-label="market bet">
      <div className="market-head">
        <span className="label">BTC 5-MIN · GEMINI</span>
        {isReplayTicker(m.eventTicker) && (
          <span className="replay-badge inline">REPLAY · recorded Gemini round</span>
        )}
        <span className="muted">
          Up {pct}% · locked at Gemini {m.priceSource === 'mid' ? 'mid' : 'last trade'}
        </span>
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
          <span
            className={`num ${
              s
                ? s.contract.resolutionSide === 'yes'
                  ? 'up'
                  : 'down'
                : live !== null && line !== null
                  ? Number(live) >= Number(line)
                    ? 'up'
                    : 'down'
                  : ''
            }`}
          >
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
      {s ? (
        <>
          <p className="market-result">
            {s.contract.status === 'invalid' ? (
              <span className="bad">Gemini voided the contract · both stakes back</span>
            ) : (
              <span className="good">
                Gemini settled {s.contract.resolutionSide === 'yes' ? 'UP' : 'DOWN'} ·{' '}
                {s.contract.resolutionSide === 'yes' ? up : down} wins
              </span>
            )}
          </p>
          <p className="muted market-evidence">
            evidence <code>{bet.settlement!.evidence_hash.slice(0, 8)}</code> ·{' '}
            <a className="explorer" href={s.source_url} target="_blank" rel="noreferrer">
              Gemini ↗
            </a>
          </p>
          {verification && (
            <p className={`market-evidence ${verification.ok ? 'good' : 'bad'}`}>
              {verification.ok
                ? `✓ verified: ${verifiedChain(verification)}`
                : `✗ evidence mismatch: ${verification.failed.join(', ')}`}
            </p>
          )}
        </>
      ) : left > 0 ? (
        ahead && <p className="muted">{ahead} is ahead</p>
      ) : (
        <p className="countdown">Waiting for Gemini to settle…</p>
      )}
    </div>
  );
}

export function BetCard({
  bet,
  now,
  tick = null,
  verification = null,
}: {
  bet: BetView;
  now: number;
  /** Gemini bets: the latest snapshot of the bet's contract. */
  tick?: GeminiMarketSnapshot | null;
  /** Gemini bets: the stage's re-check of the evidence chain, once ruled. */
  verification?: Verification | null;
}) {
  const t = bet.envelope?.terms ?? null;
  const cited = bet.ruling?.cited_frames[0];
  const citedUrl = cited !== undefined ? bet.frame_urls[cited] : undefined;
  const appealLeft = bet.appeal_deadline !== null ? bet.appeal_deadline * 1000 - now : null;
  return (
    <section className="card" aria-label="bet">
      <div className="parties">
        <span className="name">{bet.names.A ?? '…'}</span>
        <span className="vs">vs</span>
        <span className="name">{bet.names.B ?? '…'}</span>
        {bet.state && <span className="pill">{bet.state.replace(/_/g, ' ')}</span>}
      </div>

      {t ? (
        <div className="terms">
          <p className="claim">“{t.claim}”</p>
          <div className="terms-row">
            <span>
              {t.party_a.display_name} {usd(t.stakes.a)} · {t.party_b.display_name}{' '}
              {usd(t.stakes.b)}
            </span>
            {t.market && (
              <span className="muted">
                Gemini {t.market.side === 'YES' ? 'Up' : 'Down'} @ {t.market.priceAtLock}
              </span>
            )}
            <span className="code" aria-label="terms code">
              {bet.terms_code}
            </span>
          </div>
        </div>
      ) : (
        <p className="muted big">Negotiating terms…</p>
      )}

      {t?.market && <MarketPanel bet={bet} tick={tick} now={now} verification={verification} />}

      <div className="grid2">
        <div>
          <h3>{bet.names.A ?? 'A'}</h3>
          {partyAuth(bet, 'A')}
        </div>
        <div>
          <h3>{bet.names.B ?? 'B'}</h3>
          {partyAuth(bet, 'B')}
        </div>
      </div>

      {bet.lock && (
        <div className="lock">
          <span className="label">LOCK</span>
          <span>{`${bet.lock.kind === 'atomic_lock' ? '1 tx' : bet.lock.kind} · ${bet.lock.signers} signatures`}</span>
          <ExplorerLink sig={bet.lock.signature} />
          <span className={bet.lock.status === 'failed' ? 'bad' : 'good'}>
            {bet.lock.status === 'failed'
              ? `failed${bet.lock.error ? `: ${bet.lock.error}` : ''}`
              : bet.lock.onchain
                ? '✓ on-chain'
                : bet.lock.status === 'confirmed'
                  ? '✓ confirmed'
                  : 'sending…'}
          </span>
        </div>
      )}

      {bet.ruling && (
        <div className="ruling">
          <div className="verdict">{outcomeLine(bet)}</div>
          <p className="reason">{bet.ruling.reason}</p>
          <div className="ruling-meta">
            {citedUrl && (
              <figure>
                <img src={citedUrl} alt={`cited frame ${cited}`} />
                <figcaption>frame {cited}</figcaption>
              </figure>
            )}
            {appealLeft !== null && !bet.payout && (
              <span className={appealLeft > 0 ? 'countdown' : 'muted'}>
                {appealLeft > 0 ? `Appeal window ${clock(appealLeft)}` : 'Appeal window closed'}
              </span>
            )}
            {bet.appealed && !bet.payout && <span className="countdown">Appealed</span>}
          </div>
        </div>
      )}

      {bet.payout && (
        <div className="payout">
          <span className="label">PAID</span>
          <span>
            {bet.names.A ?? 'A'} {usd(bet.payout.to_a)} · {bet.names.B ?? 'B'}{' '}
            {usd(bet.payout.to_b)}
          </span>
          <span className="muted">{bet.payout.event}</span>
          {bet.payout.signature && <ExplorerLink sig={bet.payout.signature} />}
        </div>
      )}
      {bet.last_judge_line && <p className="judge">Judge: {bet.last_judge_line}</p>}
    </section>
  );
}

// ---- the Gemini odds widget ----------------------------------------------------------------

function Sparkline({ points, strike }: { points: number[]; strike: number | null }) {
  if (points.length < 2) return null;
  const all = strike !== null ? [...points, strike] : points;
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo || 1;
  const y = (v: number) => 100 - ((v - lo) / span) * 100;
  const d = points.map((p, i) => `${(i / (points.length - 1)) * 300},${y(p)}`).join(' ');
  return (
    <svg className="spark" viewBox="0 -4 300 108" preserveAspectRatio="none" aria-hidden="true">
      {strike !== null && <line x1="0" x2="300" y1={y(strike)} y2={y(strike)} className="strike" />}
      <polyline points={d} fill="none" />
    </svg>
  );
}

export function OddsWidget({ view }: { view: MarketView | null }) {
  if (!view)
    return (
      <section className="odds" aria-label="odds">
        <h2>BTC 5-min · Gemini</h2>
        <p className="muted">Waiting for the market…</p>
      </section>
    );
  return (
    <section className="odds" aria-label="odds">
      <h2>BTC 5-min · Gemini</h2>
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
          <span className="num">{view.upPct !== null ? `${view.upPct}%` : '—'}</span>
        </div>
      </div>
      <Sparkline points={view.history} strike={view.strike ? Number(view.strike) : null} />
      <div className="split">
        {view.split.ok ? (
          <>
            <span className="good">
              Up {usd(view.split.up)} · Down {usd(view.split.down)}
            </span>
            <span className="muted">
              of {usd(view.split.pot)} pot{view.split.fromTerms ? ' · locked' : ' · fair stakes'}
            </span>
          </>
        ) : (
          <span className="muted">{view.split.reason.replace(/_/g, ' ').toLowerCase()}</span>
        )}
      </div>
    </section>
  );
}

// ---- replay overlay ------------------------------------------------------------------------

export function ReplayOverlay({ beat, onClose }: { beat: number; onClose: () => void }) {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!missing) return;
    const t = setTimeout(onClose, 2500);
    return () => clearTimeout(t);
  }, [missing, onClose]);
  return (
    <div className="replay" role="dialog" aria-label={`replay beat ${beat}`} onClick={onClose}>
      <span className="replay-badge">REPLAY · beat {beat}</span>
      {missing ? (
        <p className="big muted">No clip at replay/beat{beat}.mp4</p>
      ) : (
        <video
          src={`/replay/beat${beat}.mp4`}
          autoPlay
          playsInline
          onEnded={onClose}
          onError={() => setMissing(true)}
        />
      )}
    </div>
  );
}

// ---- the whole stage -----------------------------------------------------------------------

export function StageView({
  state,
  now,
  onDisconnect,
  preview = false,
  verifications = {},
}: {
  state: TickerState;
  now: number;
  onDisconnect?: () => void;
  preview?: boolean;
  /** Gemini bets' evidence re-checks, by bet id. */
  verifications?: Readonly<Record<string, Verification>>;
}) {
  const bet = state.focusBetId ? (state.bets[state.focusBetId] ?? null) : null;
  const mv = useMemo(
    () => (state.market ? marketView(state.market, state.marketHistory, now, bet) : null),
    [state.market, state.marketHistory, now, bet],
  );
  return (
    <div className="stage">
      <header>
        <h1>You&apos;re On</h1>
        {preview && <span className="replay-badge inline">PREVIEW · sample data</span>}
        <span className={`dot ${state.status}`} aria-label={`connection ${state.status}`} />
        <span className="muted">
          {state.status}
          {state.presence
            ? ` · ${state.presence.online}/${state.presence.members} in the room`
            : ''}
          {state.lastCue ? ` · ${state.lastCue.kind}` : ''}
        </span>
        {onDisconnect && (
          <button type="button" className="ghost" onClick={onDisconnect}>
            disconnect
          </button>
        )}
      </header>
      <main className="layout">
        <div className="left">
          {bet ? (
            <BetCard
              bet={bet}
              now={now}
              verification={verifications[bet.bet_id] ?? null}
              tick={
                state.betTicks[bet.bet_id] ??
                (state.market?.eventTicker === bet.envelope?.terms.market?.eventTicker
                  ? state.market
                  : null)
              }
            />
          ) : (
            <section className="card">
              <p className="big muted">Waiting for a challenge…</p>
            </section>
          )}
        </div>
        <aside className="right">
          <OddsWidget view={mv} />
          <Ticker state={state} />
        </aside>
      </main>
    </div>
  );
}

function useNow(offsetMs: number | null, everyMs = 250): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setT(Date.now()), everyMs);
    return () => clearInterval(i);
  }, [everyMs]);
  return t + (offsetMs ?? 0);
}

export function App() {
  const [cfg, setCfg] = useState<StageConfig>(loadConfig);
  const [state, dispatch] = useReducer(applyFrame, initialTicker);
  const [replay, setReplay] = useState<number | null>(null);
  const [live, setLive] = useState<{ token: string; serverUrl: string } | null>(null);
  const conn = useRef<StageConnection | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const seeded = useRef(new Set<string>());
  const now = useNow(state.clockOffsetMs);
  const [preview] = useState(() => {
    try {
      return new URLSearchParams(globalThis.location?.search ?? '').has('preview')
        ? Date.now()
        : null;
    } catch {
      return null;
    }
  });
  // ?preview=market: the Beat 6 sample (a Gemini bet through its clock to Gemini's result).
  const [previewKind] = useState(() => {
    try {
      return new URLSearchParams(globalThis.location?.search ?? '').get('preview');
    } catch {
      return null;
    }
  });
  const previewSlot = preview === null ? 0 : Math.floor(now / 2000);
  const pv = useMemo(
    () =>
      preview === null
        ? null
        : previewKind === 'market'
          ? previewMarketState(preview, previewSlot * 2000)
          : previewState(preview, previewSlot * 2000),
    [preview, previewKind, previewSlot],
  );

  useEffect(() => () => conn.current?.stop(), []);

  // Beat 6: once a Gemini bet is ruled (the resolve landed), fetch its evidence chain and re-check
  // it here (verifyEvidence), so the projector shows Gemini's bytes tied to the on-chain hashes.
  const [verifications, setVerifications] = useState<Record<string, Verification>>({});
  const asked = useRef(new Set<string>());
  const ruledGemini = Object.values(state.bets)
    .filter(
      (b) =>
        b.settlement !== null &&
        b.envelope?.terms.market &&
        b.state !== null &&
        RULED_OR_LATER.has(b.state),
    )
    .map((b) => b.bet_id)
    .join(',');
  useEffect(() => {
    if (!live || !ruledGemini) return;
    for (const id of ruledGemini.split(',')) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      fetchSettlement(live.serverUrl, live.token, id).then(
        (ev) => {
          const bet = stateRef.current.bets[id];
          const v = bet ? verifyEvidence(bet, ev) : null;
          if (v) setVerifications((m) => ({ ...m, [id]: v }));
        },
        (err: unknown) => {
          asked.current.delete(id); // retry on the next change
          dispatch({ kind: 'error', message: `settlement ${id}: ${String(err)}` });
        },
      );
    }
  }, [ruledGemini, live]);

  // Keys 1-6: full-screen replay clips; Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') setReplay(null);
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= 6) setReplay(n);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Every bet seen for the first time: subscribe from seq 0 (replays what happened before the
  // stage connected; duplicates are dropped by (bet_id, seq)) and seed its card from
  // GET /v1/bets/:id.
  const betIds = Object.keys(state.bets).join(',');
  useEffect(() => {
    if (!live) return;
    for (const id of betIds ? betIds.split(',') : []) {
      if (seeded.current.has(id)) continue;
      seeded.current.add(id);
      conn.current?.subscribe(id, 0); // replay from the start: the ticker shows the history
      fetchBetSnapshot(live.serverUrl, live.token, id).then(
        (bet) => dispatch({ kind: 'snapshot', bet, receivedAt: Date.now() }),
        (err: unknown) => dispatch({ kind: 'error', message: String(err) }),
      );
    }
  }, [betIds, live]);

  // A reconnect's hello resumes each bet after the last seq applied, not from 0.
  useEffect(() => {
    for (const [id, seq] of Object.entries(state.lastSeq)) conn.current?.noteSeq(id, seq);
  }, [state.lastSeq]);

  async function connect(e: FormEvent) {
    e.preventDefault();
    conn.current?.stop();
    seeded.current = new Set();
    try {
      globalThis.localStorage?.setItem(
        STORE_KEY,
        JSON.stringify({ serverUrl: cfg.serverUrl, roomId: cfg.roomId, betId: cfg.betId }),
      );
    } catch {
      // ignore
    }
    try {
      dispatch({ kind: 'status', status: 'authorizing' });
      const token = cfg.token || (await fetchStageToken(cfg));
      const betId = cfg.betId?.trim();
      conn.current = new StageConnection({
        wsUrl: wsUrlFor(cfg.serverUrl),
        token,
        roomId: cfg.roomId,
        onAction: dispatch,
        subs: betId ? [{ bet_id: betId, after_seq: 0 }] : [],
      });
      conn.current.start();
      setLive({ token, serverUrl: cfg.serverUrl });
      fetchMarket(cfg.serverUrl, token).then(
        (snapshot) => dispatch({ kind: 'market', snapshot, receivedAt: Date.now() }),
        () => undefined, // the feed may be off; stage.market frames fill it later
      );
      if (betId) {
        seeded.current.add(betId);
        fetchBetSnapshot(cfg.serverUrl, token, betId).then(
          (bet) => dispatch({ kind: 'snapshot', bet, receivedAt: Date.now() }),
          (err: unknown) => dispatch({ kind: 'error', message: String(err) }),
        );
      }
    } catch (err) {
      dispatch({ kind: 'status', status: 'closed' });
      dispatch({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  const field = (k: keyof StageConfig, label: string, type = 'text') => (
    <label>
      <span>{label}</span>
      <input
        type={type}
        value={cfg[k] ?? ''}
        onChange={(ev) => setCfg({ ...cfg, [k]: ev.target.value })}
      />
    </label>
  );

  return (
    <>
      {pv ? (
        <StageView state={pv} now={now} preview />
      ) : live ? (
        <StageView
          state={state}
          now={now}
          verifications={verifications}
          onDisconnect={() => {
            conn.current?.stop();
            conn.current = null;
            setLive(null);
          }}
        />
      ) : (
        <div className="stage connect">
          <h1>You&apos;re On</h1>
          <form onSubmit={connect}>
            {field('serverUrl', 'Server')}
            {field('roomId', 'Room id')}
            {field('stageKey', 'Stage key', 'password')}
            {field('token', 'or stage token', 'password')}
            {field('betId', 'Bet id (optional)')}
            <button type="submit">Connect</button>
          </form>
          <p className="muted">Keys 1–6 play the REPLAY clips · Esc closes</p>
          <Ticker state={state} />
        </div>
      )}
      {replay !== null && <ReplayOverlay beat={replay} onClose={() => setReplay(null)} />}
    </>
  );
}
