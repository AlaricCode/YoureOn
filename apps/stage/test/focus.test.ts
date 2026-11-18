// Which bet the big card shows. Only news moves the focus: a stray draft the keeper expires
// (keeper/draft-idle.ts, published to the room), a rehearsal bet paying out, a seq-0 replay or a
// reconnect's catch-up never take the projector away from the live bet. ?bet= pins the focus
// until that bet is over.
import { describe, expect, it } from 'vitest';
import { previewAt, PREVIEW_STEPS } from '../src/preview';
import { applyFrame, FOCUS_FRESH_MS, initialTicker, isOver, type TickerState } from '../src/ticker';

const START = Date.parse('2026-11-20T15:00:00.000Z');
const LIVE = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f'; // the preview's bottle flip
const STRAY = '0b8e5d2c-9a41-4f37-b6e2-5c1d0a9f8e73';
const NEXT = '5d1e7a3b-2c4f-4e6a-8b9c-0d1e2f3a4b5c';

const stateFrame = (
  betId: string,
  seq: number,
  state: string,
  prev: string | null,
  ts: number,
) => ({
  v: 1,
  type: 'bet.state',
  bet_id: betId,
  seq,
  ts: new Date(ts).toISOString(),
  source: 'server',
  payload: {
    state,
    prev,
    onchain_status: null,
    chain_ack: 'none',
    pending_tx: null,
    reason: state === 'EXPIRED' ? 'draft_idle' : null,
  },
});
const apply = (s: TickerState, raw: unknown, at: number) =>
  applyFrame(s, { kind: 'frame', raw, receivedAt: at });

/** The live bottle flip mid-attempt, as the projector has it. */
function attempt() {
  const f = previewAt(START, START, 'attempt');
  expect(f.state.focusBetId).toBe(LIVE);
  return { s: { ...f.state, clockOffsetMs: 0 }, now: START + PREVIEW_STEPS.attempt };
}

describe('focus', () => {
  it('a stray draft expiring mid-attempt does not take the screen', () => {
    const { s, now } = attempt();
    const after = apply(s, stateFrame(STRAY, 7, 'EXPIRED', 'DRAFTING', now), now);
    expect(after.focusBetId).toBe(LIVE);
    expect(after.bets[STRAY]!.state).toBe('EXPIRED'); // still folded (and fetched by the App)
    // a cancelled stray as well
    const cancelled = apply(s, stateFrame(STRAY, 3, 'CANCELLED', 'TERMS_PROPOSED', now), now);
    expect(cancelled.focusBetId).toBe(LIVE);
  });

  it('a rehearsal bet paying out (keeper finalize) does not either', () => {
    const { s, now } = attempt();
    const stray = {
      ...s,
      bets: {
        ...s.bets,
        [STRAY]: { ...s.bets[LIVE]!, bet_id: STRAY, state: 'FINALIZED', payout: null },
      },
    };
    const paid = apply(stray, stateFrame(STRAY, 40, 'PAID', 'FINALIZED', now), now);
    expect(isOver(paid.bets[STRAY])).toBe(true);
    expect(paid.focusBetId).toBe(LIVE);
  });

  it('a new live bet takes the screen (Beat 6 after the flip), even from a live one', () => {
    const { s, now } = attempt();
    const next = apply(s, stateFrame(NEXT, 1, 'DRAFTING', null, now), now);
    expect(next.focusBetId).toBe(NEXT);
    // the preview hands over from the paid flip to the BTC bet the same way
    const btc = previewAt(START, START, 'market').state;
    expect(btc.focusBetId).not.toBe(LIVE);
  });

  it('after the live bet is paid, a stray expiring still does not replace the PAID card', () => {
    const f = previewAt(START, START, 'paid');
    const s = { ...f.state, clockOffsetMs: 0 };
    expect(isOver(s.bets[LIVE])).toBe(true);
    const after = apply(s, stateFrame(STRAY, 2, 'EXPIRED', 'DRAFTING', f.now), f.now);
    expect(after.focusBetId).toBe(LIVE);
  });

  it('catch-up never moves it: an out-of-order replay, or an in-order event 30 s old', () => {
    const { s, now } = attempt();
    // another bet seen live first (seq 9) …
    let t = apply(s, stateFrame(NEXT, 9, 'LOCKED', 'AWAITING_LOCK', now), now);
    expect(t.focusBetId).toBe(NEXT);
    // … back to the flip with a fresh event, then NEXT's seq-0 replay arrives
    t = apply(t, stateFrame(LIVE, 50, 'ATTEMPT', 'LOCKED', now + 100), now + 100);
    expect(t.focusBetId).toBe(LIVE);
    t = apply(t, stateFrame(NEXT, 1, 'DRAFTING', null, now - 60_000), now + 200);
    expect(t.focusBetId).toBe(LIVE);
    // an in-order but stale event (a resumed subscription replaying from 0)
    const stale = apply(s, stateFrame(STRAY, 1, 'DRAFTING', null, now - FOCUS_FRESH_MS - 1), now);
    expect(stale.focusBetId).toBe(LIVE);
    const fresh = apply(s, stateFrame(STRAY, 1, 'DRAFTING', null, now - 1000), now);
    expect(fresh.focusBetId).toBe(STRAY);
  });

  it('the stage clock (welcome offset) judges freshness, not the laptop clock', () => {
    const { s, now } = attempt();
    // the laptop runs 2 minutes behind the server: server ts look 2 min in the future
    const skewed = { ...s, clockOffsetMs: 120_000 };
    const after = apply(skewed, stateFrame(NEXT, 1, 'DRAFTING', null, now + 120_000), now);
    expect(after.focusBetId).toBe(NEXT);
  });

  it('with no focus yet, anything takes it (even an old or ending event)', () => {
    const t = apply(initialTicker, stateFrame(STRAY, 4, 'EXPIRED', 'DRAFTING', 0), START);
    expect(t.focusBetId).toBe(STRAY);
  });

  it('?bet= pins the focus until that bet is over; before it loads, too', () => {
    let s = applyFrame(initialTicker, { kind: 'focus', bet_id: LIVE, pin: true });
    expect(s.focusBetId).toBe(LIVE);
    s = apply(s, stateFrame(NEXT, 1, 'DRAFTING', null, START), START);
    expect(s.focusBetId).toBe(LIVE); // not loaded yet: still held
    s = apply(s, stateFrame(LIVE, 1, 'LOCKED', 'AWAITING_LOCK', START), START);
    s = apply(s, stateFrame(NEXT, 2, 'TERMS_PROPOSED', 'DRAFTING', START + 10), START + 10);
    expect(s.focusBetId).toBe(LIVE);
    s = apply(s, stateFrame(LIVE, 2, 'VOIDED', 'RULED', START + 20), START + 20);
    expect(isOver(s.bets[LIVE])).toBe(true);
    s = apply(
      s,
      stateFrame(NEXT, 3, 'AWAITING_AUTHORIZATIONS', 'TERMS_PROPOSED', START + 30),
      START + 30,
    );
    expect(s.focusBetId).toBe(NEXT);
  });

  it('a pinned bet that does not load is let go; a snapshot of the pin takes the focus', () => {
    let s = applyFrame(initialTicker, { kind: 'focus', bet_id: LIVE, pin: true });
    s = applyFrame(s, { kind: 'unfocus', bet_id: LIVE });
    expect(s.pinnedBetId).toBeNull();
    expect(s.focusBetId).toBeNull();
    s = apply(s, stateFrame(NEXT, 1, 'DRAFTING', null, START), START);
    expect(s.focusBetId).toBe(NEXT);
    // unfocus of a bet whose events did arrive keeps showing it
    const shown = applyFrame(s, { kind: 'unfocus', bet_id: NEXT });
    expect(shown.focusBetId).toBe(NEXT);
    // a resumed focus (no pin) is just the starting point
    const resumed = applyFrame(initialTicker, { kind: 'focus', bet_id: LIVE });
    expect(resumed.pinnedBetId).toBeNull();
    expect(apply(resumed, stateFrame(NEXT, 1, 'DRAFTING', null, START), START).focusBetId).toBe(
      NEXT,
    );
  });
});
