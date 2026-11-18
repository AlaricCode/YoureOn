// Bet history (Home and Profile "History"; API-CONTRACT §2.14 GET /v1/me/bets?status=settled).
// Before this both buttons did nothing. Each settled bet becomes one HistoryScreen row: the
// title, the opponent, and my net (payout - stake) with won / lost / refunded.
// Pure TS: tested in node.
import { MeBetItem } from '@youre-on/shared/api';

import type { HistoryItem } from '../preview/data';

/** How many settled bets the screen asks for (one page; the server caps it at 50). */
export const HISTORY_LIMIT = 30;

const SETTLED = new Set(['PAID', 'VOIDED']);

export function historyItemOf(b: MeBetItem): HistoryItem | null {
  if (!SETTLED.has(b.state)) return null;
  const stake = b.my_stake === null ? null : BigInt(b.my_stake);
  // my_payout is the list field; the snapshot's own payout split is the same number.
  const split =
    b.payout && b.my_party ? (b.my_party === 'A' ? b.payout.to_a : b.payout.to_b) : null;
  const paid = b.my_payout ?? split;
  const payout = paid === null ? null : BigInt(paid);
  // A voided bet refunds the stake; a paid one I lost pays me nothing.
  const net = stake === null ? 0n : (payout ?? (b.state === 'VOIDED' ? stake : 0n)) - stake;
  const outcome: HistoryItem['outcome'] =
    b.state === 'VOIDED' || net === 0n ? 'void' : net > 0n ? 'won' : 'lost';
  return {
    bet_id: b.bet_id,
    title: b.title,
    opponent: b.opponent.display_name,
    net: net.toString(),
    outcome,
    settled_at: b.settled_at ?? '',
  };
}

/**
 * The rows for GET /v1/me/bets?status=settled, newest first as the server sends them. Items that
 * do not parse as a MeBetItem are skipped, so one odd bet never blanks the whole list.
 */
export function historyFrom(items: readonly unknown[]): HistoryItem[] {
  return items.flatMap((raw) => {
    const p = MeBetItem.safeParse(raw);
    const row = p.success ? historyItemOf(p.data) : null;
    return row ? [row] : [];
  });
}
