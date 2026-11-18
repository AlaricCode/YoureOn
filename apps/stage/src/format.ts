// Display helpers for the projector: short signatures, countdown clocks, dollars, initials, the
// grouped terms code, readable labels for event types, and the face-challenge rivalry line.
import type { StageRivalry } from '@youre-on/shared/api';
import { formatUsd } from '@youre-on/shared/money';

export const shortSig = (s: string) => (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);

/** m:ss, rounded up, never negative. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Micro-USDC as dollars ("$5", "$6.10"); the raw string if it is not an amount. */
export function usd(micro: string): string {
  try {
    return formatUsd(micro);
  } catch {
    return micro;
  }
}

/** A decimal price string as "$64,389.60"; an em dash for null. */
export const usdPrice = (s: string | null) =>
  s === null
    ? '—'
    : `$${Number(s).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "0586·0f0a": the 8-char terms code in two groups, as the judge reads it (API-CONTRACT §2.7). */
export const groupedCode = (code: string) =>
  code.length === 8 ? `${code.slice(0, 4)}·${code.slice(4)}` : code;

/** Up to two initials: "Logan Staples" -> "LS", "jake" -> "J". */
export function initials(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = [...words[0]!][0] ?? '?';
  const last = words.length > 1 ? ([...words[words.length - 1]!][0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** A stable hue per name, so each player keeps their colour across bets. */
export function hueOf(name: string | null | undefined): number {
  let h = 0;
  for (const ch of name ?? '') h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 360;
}

export const AUTH_METHOD: Record<string, string> = {
  faceid_hold: 'Face ID',
  passcode_hold: 'Passcode',
};

/** Seconds between two ISO times, "+1.8 s"; null when either is missing or out of order. */
export function lagLabel(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return `+${(ms / 1000).toFixed(1)} s`;
}

const TX_LABEL: Record<string, string> = {
  atomic_lock: 'Lock tx',
  create_bet: 'Create tx',
  accept_bet: 'Accept tx',
  resolve: 'Ruling tx',
  concede: 'Concede tx',
  appeal: 'Appeal tx',
  resolve_appeal: 'Appeal ruling tx',
  finalize: 'Payout tx',
  timeout_refund: 'Refund tx',
  close_bet: 'Close tx',
  cancel_open_bet: 'Cancel tx',
  nonce_advance: 'Nonce advance',
};

/** A ticker row's headline: what happened, in words, for the event type and payload. */
export function eventLabel(
  type: string,
  payload: unknown,
  names: { A: string | null; B: string | null } = { A: null, B: null },
  /** LOCK_SIGNER=server: the server signed with the demo keys (no Face ID happened). */
  custodial = false,
): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  const who = (party: unknown) =>
    party === 'A' || party === 'B' ? (names[party] ?? `Party ${party}`) : String(party);
  if (type.startsWith('chain.')) return type.slice('chain.'.length);
  if (type.startsWith('tx.')) {
    const kind = typeof p.kind === 'string' ? (TX_LABEL[p.kind] ?? p.kind) : 'tx';
    const verb =
      type === 'tx.submitted' ? 'sent' : type === 'tx.confirmed' ? 'confirmed' : 'failed';
    return `${kind} ${verb}`;
  }
  if (type === 'terms.authorized')
    return custodial
      ? `${who(p.party)} signed · demo key`
      : `${who(p.party)} authorized${typeof p.method === 'string' ? ` · ${AUTH_METHOD[p.method] ?? p.method}` : ''}`;
  if (type === 'terms.declined') return `${who(p.party)} declined`;
  if (type === 'terms.proposed') return 'Terms proposed';
  if (type === 'odds.offered') {
    const o = (p.offer ?? {}) as Record<string, unknown>;
    const ratio = typeof o.ratio_label === 'string' ? ` ${o.ratio_label}` : '';
    if (o.from === 'judge') return `Judge suggests${ratio}`;
    return o.parent_id ? `${who(o.from)} counters${ratio}` : `${who(o.from)} offers${ratio}`;
  }
  if (type === 'odds.answered')
    return p.answer === 'countered'
      ? 'Odds countered'
      : `Odds ${String(p.answer ?? 'answered')}${p.answer === 'accepted' ? ` · ${who(p.party)}` : ''}`;
  if (type === 'odds.agreed')
    return `Odds agreed${typeof p.ratio_label === 'string' ? ` · ${p.ratio_label}` : ''}`;
  if (type === 'ruling.issued') {
    const o = String(((p.ruling ?? {}) as Record<string, unknown>).outcome ?? '?');
    return o === 'A_WINS' || o === 'B_WINS'
      ? `Ruling: ${who(o[0])} wins`
      : `Ruling: ${o.toLowerCase()}`;
  }
  if (type === 'bet.state') return `State ${String(p.state ?? '?').replace(/_/g, ' ')}`;
  if (type === 'attempt.started') return `Attempt ${String(p.attempt_no ?? '')}`.trim();
  if (type === 'appeal.vote') return 'Panel vote';
  if (type === 'appeal.result') return 'Appeal decided';
  return type;
}

/**
 * The rivalry line under VS for a face challenge (bet.invited `rivalry`, A's view):
 * "Logan 4–7 Jake · Rivals · Jake won 3 straight", "Logan vs Jake · First meeting". Pushes show
 * as a third number ("4–7–1"). Null for list/link challenges and when the server sent none.
 */
export function rivalryLine(
  r: StageRivalry | null | undefined,
  names: { A: string | null; B: string | null },
): string | null {
  if (!r || r.challenge_method !== 'face') return null;
  const a = names.A ?? 'Player A';
  const b = names.B ?? 'Player B';
  if (r.total === 0) return `${a} vs ${b} · First meeting`;
  const record = [r.a_wins, r.b_wins, ...(r.pushes > 0 ? [r.pushes] : [])].join('–');
  let line = `${a} ${record} ${b}`;
  if (r.rival) line += ' · Rivals';
  if (r.streak && r.streak.length >= 2)
    line += ` · ${r.streak.party === 'A' ? a : b} won ${r.streak.length} straight`;
  return line;
}
