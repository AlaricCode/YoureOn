/**
 * §12.5 trigger table → WS `notify` (§12.4, D-29: title ≤ 3 words, to each
 * participant's "user" topic). Funded{all_funded} → "Ready" and PreRuled →
 * "Ruled" are sent by the bet-lifecycle service (lifecycle/service.ts); this
 * module sends the rest, so each title goes out once per event:
 *   BetCreated              → "Bet offered" (every participant but the creator; §11.4 step 2)
 *   Disputed                → "Replay booth"
 *   Settled                 → "You won" / "You lost"
 *   Refunded                → "Bet refunded"
 * Participants come from the event (BetCreated) or the Bet account; wallets
 * map to users through the users collection.
 */
import type { AppContext } from '../context.js';
import { userByWallet } from '../integration/sources.js';
import type { ChainEventJson } from './events.js';

export const NOTIFY_TITLES = {
  offered: 'Bet offered',
  booth: 'Replay booth',
  won: 'You won',
  lost: 'You lost',
  refunded: 'Bet refunded',
} as const;

export class ChainNotifier {
  constructor(private readonly ctx: AppContext) {}

  register(): void {
    for (const name of ['BetCreated', 'Disputed', 'Settled', 'Refunded'] as const) {
      this.ctx.events.on(name, (ev) => this.onEvent(ev));
    }
  }

  private async participants(ev: ChainEventJson): Promise<string[]> {
    if (Array.isArray(ev.data['participants'])) return ev.data['participants'] as string[];
    const bet = typeof ev.data['bet'] === 'string' ? await this.ctx.chain.getBet(ev.data['bet']) : null;
    return bet ? bet.participants.slice(0, bet.n_participants) : [];
  }

  private send(wallets: string[], title: string, bet: string): void {
    for (const w of wallets) {
      const u = userByWallet(this.ctx, w);
      if (u) this.ctx.hub.notify(u.id, title, bet);
    }
  }

  async onEvent(ev: ChainEventJson): Promise<void> {
    const bet = ev.data['bet'];
    if (typeof bet !== 'string') return;
    const ps = await this.participants(ev);
    switch (ev.name) {
      case 'BetCreated':
        this.send(
          ps.filter((w) => w !== ev.data['creator']),
          NOTIFY_TITLES.offered,
          bet,
        );
        return;
      case 'Disputed':
        this.send(ps, NOTIFY_TITLES.booth, bet);
        return;
      case 'Settled': {
        const mask = typeof ev.data['winner_mask'] === 'number' ? ev.data['winner_mask'] : 0;
        this.send(ps.filter((_, i) => ((mask >> i) & 1) === 1), NOTIFY_TITLES.won, bet);
        this.send(ps.filter((_, i) => ((mask >> i) & 1) === 0), NOTIFY_TITLES.lost, bet);
        return;
      }
      case 'Refunded':
        this.send(ps, NOTIFY_TITLES.refunded, bet);
        return;
      default:
        return;
    }
  }
}
