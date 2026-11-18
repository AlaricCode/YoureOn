// Bet history (Home and Profile "History"; API-CONTRACT §2.14 GET /v1/me/bets?status=settled).
// Before this both buttons did nothing. Each settled bet becomes one HistoryScreen row: the
// title, the opponent, and my net (payout - stake) with won / lost / refunded. Seed rows (is_seed:
// POST /v1/demo/seed-h2h, no on-chain footprint) are titled "Demo history", never like a real bet.
// Pure TS: tested in node.
import { MeBetItem } from '@youre-on/shared/api';

import type { HistoryItem } from '../preview/data';
import { COPY, t } from '../screens/copy';

/** How many settled bets the screen asks for (one page; the server caps it at 50). */
export const HISTORY_LIMIT = 30;

const SETTLED = new Set(['PAID', 'VOIDED']);

/** The server's title for a bet with no terms (apps/server me/bets: seed rows have none). */
const UNTITLED = 'Challenge';

/**
 * A seed row's title: "Demo history" (+ ": <title>" when the server sent a real one). A server
 * that already sends the row's own "Demo history: …" title is shown as is.
 */
function titleOf(b: MeBetItem): string {
  if (!b.is_seed) return b.title;
  const demo = t(COPY.history.demo);
  const title = b.title.trim();
  if (title.toLowerCase().startsWith(demo.toLowerCase())) return title;
  return title && title !== UNTITLED ? `${demo}: ${title}` : demo;
}

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
    title: titleOf(b),
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

/** micro-USDC (signed, as a string) -> whole cents, rounded toward zero like the balance. */
const centsOf = (micro: string) => Number(BigInt(micro) / 10_000n);

/**
 * The Home sparkline: my balance (cents) after each settled bet, oldest first, ending at today's
 * balance. Walks back from `balanceCents` through `items` (newest first, as historyFrom returns
 * them) by each bet's net. Bets still in escrow are not in `items`, so the curve is the settled
 * balance; that is the line the user's wins and losses moved. Fewer than one item -> [] (the
 * Sparkline hides itself under two points).
 */
export function balanceSeries(balanceCents: number, items: readonly HistoryItem[]): number[] {
  if (items.length === 0) return [];
  const out = [balanceCents];
  let at = balanceCents;
  for (const it of items) {
    at -= centsOf(it.net);
    out.push(at);
  }
  return out.reverse();
}

/** The net (cents) of every loaded settled bet: the "+$12.50" under the balance. */
export function netCents(items: readonly HistoryItem[]): number {
  return items.reduce((sum, it) => sum + centsOf(it.net), 0);
}
