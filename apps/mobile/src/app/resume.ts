// Back into an open bet after the app restarts (a crash, a swipe-away, a reinstall): before this
// a restarted phone came back to home and the bet was stranded until the server expired it
// (B's invite, A's terms; after the lock, the ruling, GG and payout screens). On sign-in the
// app asks GET /v1/me/bets?status=active, rebuilds each bet (BetHub.restore: the snapshot plus
// its event log from GET /v1/bets/:id/events, so B's invite answer, the lock request and the
// authorizations come back too), follows it on the socket and opens the newest. Pure TS: tested
// in node.
import { BetSnapshot } from '@youre-on/shared/api';
import { isTerminalBetState } from '@youre-on/shared/bet-state';

/** Open bets to look for: a phone has at most a few (the server caps pre-lock bets at 3). */
export const RESUME_LIMIT = 5;

/**
 * The snapshots of the open bets in a GET /v1/me/bets page (each item is a whole BetSnapshot),
 * newest first as the server sends them. Items that do not parse, or are already over, are left
 * out.
 */
export function resumable(items: readonly unknown[]): BetSnapshot[] {
  return items.flatMap((raw) => {
    const p = BetSnapshot.safeParse(raw);
    return p.success && !isTerminalBetState(p.data.state) ? [p.data] : [];
  });
}

export interface LiveRetry {
  /** Run the step now (sign-in). */
  run(): Promise<void>;
  /** The step already ran elsewhere and did not finish: run it on the next live socket. */
  markPending(): void;
  /** The socket is live (the server answers): run the step again if it is pending. */
  onLive(): void;
  /** Signed out / unmounted: never run again. */
  stop(): void;
  readonly pending: boolean;
}

/**
 * A sign-in step that needs the server (the room rejoin, GET /v1/me/bets): when it could not
 * finish (it resolved false or threw: the server was unreachable at a cold start), it runs again
 * the next time the socket is live, until it finishes once. Before this a phone that restarted
 * mid-bet without a connection stayed on home, room-less, with the bet stranded until the next
 * restart, even after the server came back.
 */
export function createLiveRetry(step: () => Promise<boolean>): LiveRetry {
  let pending = false;
  let running = false;
  let liveDuringRun = false;
  let stopped = false;
  async function run(): Promise<void> {
    if (stopped || running) return;
    running = true;
    pending = false;
    liveDuringRun = false;
    let done = false;
    try {
      done = await step();
    } catch {
      done = false;
    } finally {
      running = false;
    }
    if (stopped || done) return;
    pending = true;
    // The socket came back while this run was failing: that 'live' is spent, so go again now.
    if (liveDuringRun) await run();
  }
  return {
    run,
    markPending() {
      if (!stopped) pending = true;
    },
    onLive() {
      if (stopped) return;
      if (running) liveDuringRun = true;
      else if (pending) void run();
    },
    stop() {
      stopped = true;
      pending = false;
    },
    get pending() {
      return pending;
    },
  };
}
