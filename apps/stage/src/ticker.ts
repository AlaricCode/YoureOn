// Pure state of the stage view: every frame the server sends on /v1/ws goes through
// applyFrame(). Control frames carry `op`; event frames are bare RealtimeEvent envelopes that are
// parsed with the shared schema and dropped (with a note) when they fail (API-CONTRACT §3.1,
// SCHEMAS §10.1). Events are deduplicated by (bet_id, seq), as the client rule in §3.3 says.
//
// On top of the raw ticker it folds each bet's events into a BetView (the pitch card: parties,
// terms + terms code, per-party authorization, the lock tx and its signer count, the ruling and
// its cited frame, the appeal window, the payout) and keeps the latest Gemini `stage.market`
// snapshot plus a short index-price history for the odds widget. A REST BetSnapshot
// (GET /v1/bets/:id) seeds a view on cold start; later events win over it.
//
// The card is always the fold of the bet's events in seq order, with the latest REST snapshot
// slotted in at its last_seq. Events normally arrive in order and fold incrementally; an older
// one (the seq-0 replay that follows a live event when the stage first sees a bet mid-flight,
// or a snapshot fetched before newer live events) triggers a rebuild from the retained
// per-bet history instead of being folded on top, so the card never regresses.
import { WsServerControlFrame, type BetSnapshot } from '@youre-on/shared/api';
import type { GeminiMarketSnapshot } from '@youre-on/shared/gemini';
import { parseRealtimeEvent, type RealtimeEvent } from '@youre-on/shared/realtime';
import { termsCode, type TermsEnvelope } from '@youre-on/shared/terms';

export const MAX_EVENTS = 200;
export const MAX_MARKET_POINTS = 150;
/** Per-bet events kept for rebuilding the card (market.tick is not kept). */
export const MAX_BET_HISTORY = 1000;

export type ConnStatus = 'idle' | 'authorizing' | 'connecting' | 'open' | 'closed';

export interface TickerEvent {
  bet_id: string;
  seq: number;
  type: string;
  ts: string;
  source: string;
  /** Devnet Explorer link when the payload names a transaction signature. */
  explorer: string | null;
  payload: unknown;
}

export type PartyKey = 'A' | 'B';

export interface LockView {
  kind: string;
  signature: string;
  /** Signatures on the lock tx: atomic = fee payer + A + B (one tx), sequential = 2 each. */
  signers: number;
  status: 'submitted' | 'confirmed' | 'failed';
  /** BetCreated / BetAccepted seen from the chain stream. */
  onchain: boolean;
  slot: number | null;
  error: string | null;
  /** Event ts of tx.submitted and of the first chain event (the Streams lag between them). */
  sent_at: string | null;
  onchain_at: string | null;
}

export interface RulingView {
  outcome: string;
  reason: string;
  confidence: number;
  cited_frames: number[];
  model: string;
  stage: string;
  void_reason: string | null;
  ruling_hash: string;
  /** The attempt it rules on (attempt-stage rulings only). */
  attempt_no: number | null;
  redo_reason: string | null;
}

export interface VoteView {
  seat: number;
  provider: string;
  model: string;
  status: string;
  outcome: string;
  confidence: number;
  reason: string;
  counted_as: string;
}

export interface AppealResultView {
  final_outcome: string;
  flipped: boolean;
  decided_by: string;
  tally: { A_WINS: number; B_WINS: number; ABSTAIN: number };
}

export interface HearingView {
  hearing_id: string;
  /** The turn whose clock is running. */
  open: { party: PartyKey; closes_at: string } | null;
  turns: Array<{ party: PartyKey; transcript: string }>;
}

export interface PayoutView {
  to_a: string;
  to_b: string;
  event: string;
  signature: string | null;
}

export interface BetView {
  bet_id: string;
  state: string | null;
  names: { A: string | null; B: string | null };
  /** Opt-in profile photos (UserRef / TermsPresentation); initials when null. */
  avatars: Record<PartyKey, string | null>;
  /** From the REST snapshot: maps room presence onto the parties. */
  user_ids: Record<PartyKey, string | null>;
  /** B's answer to the challenge (bet.invite_answered). */
  invite: 'accepted' | 'declined' | null;
  envelope: TermsEnvelope | null;
  terms_code: string | null;
  auth: Record<PartyKey, { method: string; at: string } | null>;
  /** terms.authorized count: 0, 1, 2 (2 = lock being sent). */
  auth_count: number;
  declined: PartyKey | null;
  lock: LockView | null;
  attempt_no: number | null;
  performer: PartyKey | null;
  frame_urls: string[];
  ruling: RulingView | null;
  /** BetResolved.ts: when the appeal window opened (unix s). */
  resolved_at: number | null;
  appeal_deadline: number | null;
  appealed: boolean;
  hearing: HearingView | null;
  /** Appeal panel votes by seat (0-2), as they stream in. */
  votes: VoteView[];
  appeal_result: AppealResultView | null;
  payout: PayoutView | null;
  /** Event ts of the money-moved event (the PAID moment fires only for a fresh one). */
  paid_at: string | null;
  closed: boolean;
  last_judge_line: string | null;
  /**
   * The live caption: the newest line anyone said (the judge, or a player via party.line), a
   * partial line until its final version arrives (the hall cannot always hear A's phone).
   */
  caption: {
    speaker: 'judge' | PartyKey;
    text: string;
    final: boolean;
    utterance_id: string;
  } | null;
  last_cue: string | null;
  /** Other tx signatures by kind (resolve, payout, close …) for Explorer links. */
  txs: Record<string, string>;
  updated_at: number;
}

export interface TickerState {
  status: ConnStatus;
  /** server_time - local time, from `welcome` (for countdowns). */
  clockOffsetMs: number | null;
  closeCode: number | null;
  events: TickerEvent[];
  lastSeq: Record<string, number>;
  presence: {
    room_id: string;
    online: number;
    members: number;
    /** user_id -> online, for the per-party "offline" badge. */
    online_by_user?: Record<string, boolean>;
  } | null;
  lastCue: { bet_id: string; kind: string } | null;
  /** Increments with every stage.cue (the page flashes / plays the cue on each). */
  cueCount: number;
  marketTicks: number;
  market: GeminiMarketSnapshot | null;
  marketHistory: Array<{ t: number; price: number }>;
  bets: Record<string, BetView>;
  /** Each bet's card-relevant events, sorted by seq (the source a rebuild folds). */
  history: Record<string, RealtimeEvent[]>;
  /** Latest GET /v1/bets/:id per bet (slotted into a rebuild at its last_seq). */
  snapshots: Record<string, BetSnapshot>;
  /** The bet with the most recent activity: what the big card shows. */
  focusBetId: string | null;
  dropped: number;
  errors: string[];
}

export const initialTicker: TickerState = {
  status: 'idle',
  clockOffsetMs: null,
  closeCode: null,
  events: [],
  lastSeq: {},
  presence: null,
  lastCue: null,
  cueCount: 0,
  marketTicks: 0,
  market: null,
  marketHistory: [],
  bets: {},
  history: {},
  snapshots: {},
  focusBetId: null,
  dropped: 0,
  errors: [],
};

export const explorerTx = (signature: string, cluster: 'devnet' | 'localnet' = 'devnet') =>
  cluster === 'devnet'
    ? `https://explorer.solana.com/tx/${signature}?cluster=devnet`
    : `https://explorer.solana.com/tx/${signature}?cluster=custom`;

/** A `signature` field on the payload or one level down (chain events, tx.submitted). */
export function findSignature(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.signature === 'string') return p.signature;
  for (const v of Object.values(p))
    if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).signature === 'string')
      return (v as Record<string, string>).signature!;
  return null;
}

function toTicker(e: RealtimeEvent): TickerEvent {
  const sig = findSignature(e.payload);
  return {
    bet_id: e.bet_id,
    seq: e.seq,
    type: e.type,
    ts: e.ts,
    source: e.source,
    explorer: sig ? explorerTx(sig) : null,
    payload: e.payload,
  };
}

const noteError = (s: TickerState, msg: string): TickerState => ({
  ...s,
  errors: [...s.errors.slice(-9), msg],
});

export const LOCK_KINDS = new Set(['atomic_lock', 'create_bet', 'accept_bet']);
export const signersFor = (kind: string): number => (kind === 'atomic_lock' ? 3 : 2);

export function emptyBet(bet_id: string, at = 0): BetView {
  return {
    bet_id,
    state: null,
    names: { A: null, B: null },
    avatars: { A: null, B: null },
    user_ids: { A: null, B: null },
    invite: null,
    envelope: null,
    terms_code: null,
    auth: { A: null, B: null },
    auth_count: 0,
    declined: null,
    lock: null,
    attempt_no: null,
    performer: null,
    frame_urls: [],
    ruling: null,
    resolved_at: null,
    appeal_deadline: null,
    appealed: false,
    hearing: null,
    votes: [],
    appeal_result: null,
    payout: null,
    paid_at: null,
    closed: false,
    last_judge_line: null,
    caption: null,
    last_cue: null,
    txs: {},
    updated_at: at,
  };
}

function withEnvelope(b: BetView, env: TermsEnvelope): BetView {
  return {
    ...b,
    envelope: env,
    terms_code: termsCode(env.terms_hash),
    names: {
      A: env.terms.party_a.display_name,
      B: env.terms.party_b.display_name,
    },
    avatars: {
      A: env.presentation.party_a_avatar_url ?? b.avatars.A,
      B: env.presentation.party_b_avatar_url ?? b.avatars.B,
    },
  };
}

function rulingView(r: {
  ruling: {
    outcome: string;
    reason: string;
    confidence: number;
    cited_frames: number[];
    model: string;
    void_reason?: string | null;
  } & Record<string, unknown>;
  ruling_hash: string;
}): RulingView {
  return {
    outcome: r.ruling.outcome,
    reason: r.ruling.reason,
    confidence: r.ruling.confidence,
    cited_frames: r.ruling.cited_frames,
    model: r.ruling.model,
    stage: typeof r.ruling.stage === 'string' ? r.ruling.stage : 'hearing',
    void_reason: r.ruling.void_reason ?? null,
    ruling_hash: r.ruling_hash,
    attempt_no: typeof r.ruling.attempt_no === 'number' ? r.ruling.attempt_no : null,
    redo_reason: typeof r.ruling.redo_reason === 'string' ? r.ruling.redo_reason : null,
  };
}

function hearingOf(v: BetView, hearing_id: string): HearingView {
  return v.hearing?.hearing_id === hearing_id ? v.hearing : { hearing_id, open: null, turns: [] };
}

/** Folds one event into its bet's view. */
export function foldEvent(b: BetView, e: RealtimeEvent, at: number): BetView {
  const v: BetView = { ...b, updated_at: at };
  switch (e.type) {
    case 'bet.invited':
      return { ...v, names: { ...v.names, A: v.names.A ?? e.payload.challenger.display_name } };
    case 'bet.state':
      return { ...v, state: e.payload.state };
    case 'bet.invite_answered':
      return { ...v, invite: e.payload.answer };
    case 'terms.proposed':
      return withEnvelope(v, e.payload.envelope);
    case 'terms.authorize_request':
      return withEnvelope({ ...v, auth: { A: null, B: null }, auth_count: 0 }, e.payload.envelope);
    case 'terms.authorized':
      return {
        ...v,
        auth: {
          ...v.auth,
          [e.payload.party]: { method: e.payload.method, at: e.payload.authorized_at },
        },
        auth_count: Math.max(v.auth_count, e.payload.count),
      };
    case 'terms.declined':
      return { ...v, declined: e.payload.party };
    case 'tx.submitted':
    case 'tx.confirmed':
    case 'tx.failed': {
      const kind = e.payload.kind;
      const sig = e.payload.signature;
      if (!LOCK_KINDS.has(kind)) return sig ? { ...v, txs: { ...v.txs, [kind]: sig } } : v;
      const status =
        e.type === 'tx.submitted'
          ? 'submitted'
          : e.type === 'tx.confirmed'
            ? 'confirmed'
            : 'failed';
      const prev = v.lock && v.lock.signature === sig ? v.lock : null;
      return {
        ...v,
        lock: {
          kind,
          signature: sig ?? v.lock?.signature ?? '',
          signers: signersFor(kind),
          // a late tx.submitted never downgrades a confirmation
          status: prev?.status === 'confirmed' && status === 'submitted' ? 'confirmed' : status,
          onchain: prev?.onchain ?? false,
          slot: e.type === 'tx.confirmed' ? e.payload.slot : (prev?.slot ?? null),
          error: e.type === 'tx.failed' ? e.payload.error : null,
          sent_at: e.type === 'tx.submitted' ? (prev?.sent_at ?? e.ts) : (prev?.sent_at ?? null),
          onchain_at: prev?.onchain_at ?? null,
        },
      };
    }
    case 'chain.BetCreated':
    case 'chain.BetAccepted': {
      const lock: LockView = v.lock
        ? { ...v.lock, onchain: true, status: 'confirmed', onchain_at: v.lock.onchain_at ?? e.ts }
        : {
            kind: 'atomic_lock',
            signature: e.payload.signature,
            signers: 3,
            status: 'confirmed',
            onchain: true,
            slot: e.payload.slot,
            error: null,
            sent_at: null,
            onchain_at: e.ts,
          };
      return { ...v, lock };
    }
    case 'attempt.started':
      return {
        ...v,
        attempt_no: e.payload.attempt_no,
        performer: e.payload.performer,
        frame_urls: [],
      };
    case 'attempt.evidence':
      return { ...v, frame_urls: e.payload.frame_urls };
    case 'ruling.issued':
      return { ...v, ruling: rulingView(e.payload) };
    case 'chain.BetResolved':
      return {
        ...v,
        resolved_at: e.payload.ts,
        appeal_deadline: e.payload.appeal_deadline,
        txs: { ...v.txs, resolve: e.payload.signature },
      };
    case 'chain.BetAppealed':
      return {
        ...v,
        appealed: true,
        appeal_deadline: null,
        txs: { ...v.txs, appeal: e.payload.signature },
      };
    case 'hearing.opened':
      return { ...v, hearing: { hearing_id: e.payload.hearing_id, open: null, turns: [] } };
    case 'hearing.turn_open':
      return {
        ...v,
        hearing: {
          ...hearingOf(v, e.payload.hearing_id),
          open: { party: e.payload.party, closes_at: e.payload.closes_at },
        },
      };
    case 'hearing.turn': {
      const h = hearingOf(v, e.payload.turn.hearing_id);
      const turn = { party: e.payload.turn.party, transcript: e.payload.turn.transcript };
      return {
        ...v,
        hearing: {
          ...h,
          open: h.open?.party === turn.party ? null : h.open,
          turns: [...h.turns.filter((t) => t.party !== turn.party), turn],
        },
      };
    }
    case 'appeal.vote': {
      const x = e.payload.vote;
      const vote: VoteView = {
        seat: x.seat,
        provider: x.provider,
        model: x.model,
        status: x.status,
        outcome: x.outcome,
        confidence: x.confidence,
        reason: x.reason,
        counted_as: x.counted_as,
      };
      const votes = [...v.votes.filter((o) => o.seat !== vote.seat), vote];
      return { ...v, votes: votes.sort((a, b) => a.seat - b.seat) };
    }
    case 'appeal.result': {
      const r = e.payload.result;
      return {
        ...v,
        appeal_result: {
          final_outcome: r.final_outcome,
          flipped: r.flipped,
          decided_by: r.decided_by,
          tally: r.tally,
        },
      };
    }
    // The program emits no BetPaid: money moves in these five, then BetClosed.
    case 'chain.BetFinalized':
    case 'chain.BetConceded':
    case 'chain.AppealResolved':
    case 'chain.BetRefunded':
    case 'chain.BetCancelled':
      return {
        ...v,
        appeal_deadline: null,
        payout: {
          to_a: e.payload.to_a,
          to_b: e.payload.to_b,
          event: e.type.slice('chain.'.length),
          signature: e.payload.signature,
        },
        paid_at: v.paid_at ?? e.ts,
        txs: { ...v.txs, payout: e.payload.signature },
      };
    case 'chain.BetClosed':
      return { ...v, closed: true, txs: { ...v.txs, close: e.payload.signature } };
    case 'judge.line':
      return {
        ...v,
        last_judge_line: e.payload.final ? e.payload.text : v.last_judge_line,
        caption: {
          speaker: 'judge',
          text: e.payload.text,
          final: e.payload.final,
          utterance_id: e.payload.utterance_id,
        },
      };
    case 'party.line':
      return {
        ...v,
        caption: {
          speaker: e.payload.party,
          text: e.payload.text,
          final: e.payload.final,
          utterance_id: e.payload.utterance_id,
        },
      };
    case 'judge.cue':
      return { ...v, last_cue: e.payload.cue };
    default:
      return v;
  }
}

/** Seeds / refreshes a view from GET /v1/bets/:id. Fields the snapshot lacks keep their value. */
export function foldSnapshot(b: BetView, snap: BetSnapshot, at: number): BetView {
  let v: BetView = {
    ...b,
    state: snap.state,
    names: { A: snap.party_a.display_name, B: snap.party_b.display_name },
    avatars: {
      A: snap.party_a.avatar_url ?? b.avatars.A,
      B: snap.party_b.avatar_url ?? b.avatars.B,
    },
    user_ids: { A: snap.party_a.user_id, B: snap.party_b.user_id },
    attempt_no: snap.attempt_no ?? b.attempt_no,
    updated_at: Math.max(b.updated_at, at),
  };
  if (snap.envelope) v = { ...withEnvelope(v, snap.envelope), names: v.names, avatars: v.avatars };
  const auth = (p: PartyKey) => {
    const a = snap.authorizations[p];
    return a ? { method: a.method, at: a.authorized_at } : v.auth[p];
  };
  v.auth = { A: auth('A'), B: auth('B') };
  v.auth_count = Math.max(v.auth_count, (v.auth.A ? 1 : 0) + (v.auth.B ? 1 : 0));
  if (snap.latest_ruling && !v.ruling) v.ruling = rulingView(snap.latest_ruling);
  if (snap.deadlines.appeal_deadline !== null && v.appeal_deadline === null && !snap.payout)
    v.appeal_deadline = snap.deadlines.appeal_deadline;
  const lockSig = snap.signatures.lock;
  if (lockSig && !v.lock)
    v.lock = {
      kind: 'atomic_lock',
      signature: lockSig,
      signers: 3,
      status: 'confirmed',
      onchain: snap.chain_ack === 'stream',
      slot: null,
      error: null,
      sent_at: null,
      onchain_at: null,
    };
  if (snap.payout && !v.payout)
    v.payout = {
      to_a: snap.payout.to_a,
      to_b: snap.payout.to_b,
      event: 'payout',
      signature: snap.signatures.payout ?? null,
    };
  const txs = { ...v.txs };
  for (const [k, s] of Object.entries(snap.signatures)) if (k !== 'lock') txs[k] ??= s;
  v.txs = txs;
  return v;
}

/** Highest seq already reflected in the bet's card (events or the snapshot's last_seq). */
function foldedSeq(s: TickerState, betId: string): number {
  const h = s.history[betId];
  return Math.max(h?.length ? h[h.length - 1]!.seq : 0, s.snapshots[betId]?.last_seq ?? 0);
}

/** The card from scratch: events in seq order, the snapshot slotted in after its last_seq. */
export function rebuildBet(
  betId: string,
  history: readonly RealtimeEvent[],
  snap: BetSnapshot | undefined,
  at: number,
): BetView {
  let v = emptyBet(betId, at);
  let seeded = !snap;
  for (const e of history) {
    if (!seeded && e.seq > snap!.last_seq) {
      v = foldSnapshot(v, snap!, at);
      seeded = true;
    }
    v = foldEvent(v, e, at);
  }
  if (!seeded) v = foldSnapshot(v, snap!, at);
  return v;
}

export type TickerAction =
  | { kind: 'status'; status: ConnStatus; closeCode?: number | null }
  | { kind: 'frame'; raw: unknown; receivedAt: number }
  | { kind: 'snapshot'; bet: BetSnapshot; receivedAt: number }
  | { kind: 'market'; snapshot: GeminiMarketSnapshot | null; receivedAt: number }
  | { kind: 'error'; message: string }
  /** A new connection (another room): forget every bet, event and market point. */
  | { kind: 'reset' };

function withMarket(s: TickerState, snap: GeminiMarketSnapshot | null, at: number): TickerState {
  if (!snap) return { ...s, market: null };
  const price = snap.indexPrice === null ? NaN : Number(snap.indexPrice);
  let hist = s.marketHistory;
  if (s.market && s.market.eventTicker !== snap.eventTicker) hist = []; // rollover: new chart
  if (Number.isFinite(price)) hist = [...hist, { t: at, price }].slice(-MAX_MARKET_POINTS);
  return { ...s, market: snap, marketHistory: hist };
}

export function applyFrame(s: TickerState, a: TickerAction): TickerState {
  if (a.kind === 'reset') return initialTicker;
  if (a.kind === 'status')
    return {
      ...s,
      status: a.status,
      closeCode: a.closeCode ?? (a.status === 'closed' ? s.closeCode : null),
    };
  if (a.kind === 'error') return noteError(s, a.message);
  if (a.kind === 'market') return withMarket(s, a.snapshot, a.receivedAt);
  if (a.kind === 'snapshot') {
    const id = a.bet.bet_id;
    const prev = s.bets[id];
    // A snapshot older than what the card already shows is slotted in by seq, not laid on top.
    const view =
      prev && a.bet.last_seq < foldedSeq(s, id)
        ? {
            ...rebuildBet(id, s.history[id] ?? [], a.bet, a.receivedAt),
            updated_at: Math.max(prev.updated_at, a.receivedAt),
          }
        : foldSnapshot(prev ?? emptyBet(id), a.bet, a.receivedAt);
    return {
      ...s,
      bets: { ...s.bets, [id]: view },
      snapshots: { ...s.snapshots, [id]: a.bet },
      focusBetId: s.focusBetId ?? id,
    };
  }

  const raw = a.raw;
  if (raw && typeof raw === 'object' && 'op' in raw) {
    const f = WsServerControlFrame.safeParse(raw);
    if (!f.success) return { ...s, dropped: s.dropped + 1 };
    const frame = f.data;
    switch (frame.op) {
      case 'welcome':
        return {
          ...s,
          status: 'open',
          clockOffsetMs: Date.parse(frame.server_time) - a.receivedAt,
        };
      case 'error':
        return noteError(s, `${frame.code}: ${frame.message}`);
      case 'room.presence':
        return {
          ...s,
          presence: {
            room_id: frame.room_id,
            members: frame.members.length,
            online: frame.members.filter((m) => m.online).length,
            online_by_user: Object.fromEntries(
              frame.members.map((m) => [m.user.user_id, m.online]),
            ),
          },
        };
      case 'stage.cue':
        return {
          ...s,
          lastCue: { bet_id: frame.bet_id, kind: frame.kind },
          cueCount: s.cueCount + 1,
        };
      case 'stage.market':
        return { ...withMarket(s, frame.snapshot, a.receivedAt), marketTicks: s.marketTicks + 1 };
      case 'subscribed':
        return {
          ...s,
          lastSeq: {
            ...s.lastSeq,
            [frame.bet_id]: Math.max(s.lastSeq[frame.bet_id] ?? 0, frame.last_seq),
          },
        };
      case 'ping':
        return s;
    }
  }

  const parsed = parseRealtimeEvent(raw);
  if (!parsed.ok) return { ...s, dropped: s.dropped + 1 };
  const e = parsed.event;
  const past = s.history[e.bet_id] ?? [];
  if (
    past.some((x) => x.seq === e.seq) ||
    s.events.some((x) => x.bet_id === e.bet_id && x.seq === e.seq)
  )
    return s;
  const events = [...s.events, toTicker(e)]
    .sort((x, y) => (x.ts === y.ts ? x.seq - y.seq : x.ts < y.ts ? -1 : 1))
    .slice(-MAX_EVENTS);
  // market.tick is 1 Hz chatter: it doesn't steal the focus or touch the card.
  if (e.type === 'market.tick')
    return {
      ...s,
      events,
      focusBetId: s.focusBetId ?? e.bet_id,
      lastSeq: { ...s.lastSeq, [e.bet_id]: Math.max(s.lastSeq[e.bet_id] ?? 0, e.seq) },
    };
  const inOrder = e.seq > foldedSeq(s, e.bet_id);
  const hist = (inOrder ? [...past, e] : [...past, e].sort((x, y) => x.seq - y.seq)).slice(
    -MAX_BET_HISTORY,
  );
  const prev = s.bets[e.bet_id];
  const view = inOrder
    ? foldEvent(prev ?? emptyBet(e.bet_id), e, a.receivedAt)
    : {
        ...rebuildBet(e.bet_id, hist, s.snapshots[e.bet_id], a.receivedAt),
        updated_at: Math.max(prev?.updated_at ?? 0, a.receivedAt),
      };
  return {
    ...s,
    events,
    bets: { ...s.bets, [e.bet_id]: view },
    history: { ...s.history, [e.bet_id]: hist },
    focusBetId: e.bet_id,
    lastSeq: { ...s.lastSeq, [e.bet_id]: Math.max(s.lastSeq[e.bet_id] ?? 0, e.seq) },
  };
}

/** Bets seen in events but not yet seeded from REST (the App fetches each once). */
export function unseededBets(s: TickerState, seeded: ReadonlySet<string>): string[] {
  return Object.keys(s.bets).filter((id) => !seeded.has(id));
}
