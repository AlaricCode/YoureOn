/**
 * The four §17 demo scenarios, end to end over HTTP/WS:
 *   1. paper-ball shot (actor-bound) → pre-ruling → both Agree → consent settlement
 *   2. cup tower vs fan → pre-ruling → Dispute (bond) → replay booth → panel settlement
 *   3. AI-judged bet → NEEDS_PANEL → replay booth → panel settlement
 *   4. World Mode market bet → keeper start → event resolves → Agree → settlement
 */
import type { SignPayload } from './client.js';
import { accept, createBet, dictate, fundAll, record, sceneCheck, showRuling, showSettlement, waitState, type BetView } from './betFlow.js';
import { DEMO_WORLD_EVENT_ID, resolveWorldEvent, waitFor, type Harness } from './harness.js';
import type { Crew } from './setup.js';
import { usd, type Transcript } from './transcript.js';

export const PAPER_BALL = "I bet Bob can't get a paper ball in the trash can from behind that line. Three tries. $5";
export const CUP_TOWER = 'I bet the cup tower survives the fan for ten seconds, $2';
export const AI_JUDGED = 'Sam finishes the hot sauce wing without drinking anything, $3';

async function consentBoth(crew: Crew, betId: string, t: Transcript): Promise<void> {
  for (const c of [crew.alice, crew.bob]) {
    const r = await c.post<{ sign: SignPayload }>(`/bets/${betId}/consent`);
    await c.signConfirmed(r.sign, 'consent');
    t.step(c.name, `Agree → "${r.sign.summary}" signed`);
  }
}

/** Runs a rules/ai_judged bet from dictation to the first verdict state. */
async function playRulesBet(h: Harness, crew: Crew, spoken: string, t: Transcript): Promise<BetView> {
  const d = await dictate(crew, spoken, t);
  await accept(crew, d, t);
  const bet = await createBet(crew, d, t);
  await sceneCheck(h, crew, bet, t);
  await fundAll(crew, bet, t);
  const ready = await crew.bob.get<BetView>(`/bets/${bet.id}`);
  t.check('funded bet shows "Ready"', ready.state_label === 'Ready', ready.state_label);
  await record(h, crew, bet, t);
  const v = await waitState(h, crew.alice, bet.id, ['preruled', 'disputed', 'settled'], 'perception + run_rules');
  t.step('backend', `perception (2 hosts, cross-check) → post_tracks → proofs → run_rules → ${v.state_label}${v.preruling ? ` (code ${v.preruling.code}, reason ${v.preruling.reason}, mask ${v.preruling.winner_mask})` : ''}`);
  return v;
}

export async function paperBallConsent(h: Harness, crew: Crew, t: Transcript): Promise<string> {
  t.section('1. Paper-ball shot → consent settlement');
  const v = await playRulesBet(h, crew, PAPER_BALL, t);
  t.eq('paper ball pre-ruled for Bob', [v.state, v.preruling?.winner_mask], ['preruled', 2]);
  const rb = await showRuling(crew.bob, v.id, t);
  t.eq('Bob sees "You win"', rb.outcome_text, 'You win');
  const ra = await showRuling(crew.alice, v.id, t);
  t.eq('Alice sees "You lose" −$5.00', [ra.outcome_text, ra.amount_units], ['You lose', -5_000_000]);
  await consentBoth(crew, v.id, t);
  const s = await showSettlement(h, crew, v.id, t);
  t.eq('settled by consent', s.settlement?.path, 'consent');
  return v.id;
}

export async function cupTowerDispute(h: Harness, crew: Crew, t: Transcript): Promise<string> {
  t.section('2. Cup tower → dispute → replay booth → panel');
  const v = await playRulesBet(h, crew, CUP_TOWER, t);
  t.eq('cup tower pre-ruled for Alice', [v.state, v.preruling?.winner_mask], ['preruled', 1]);
  const r = await showRuling(crew.bob, v.id, t);
  const d = await crew.bob.post<{ sign: SignPayload; bond_units: number }>(`/bets/${v.id}/dispute`, { reason: 1 });
  await crew.bob.signConfirmed(d.sign, 'dispute');
  t.check('bond quoted on the ruling screen', d.bond_units === r.bond_units);
  t.step(crew.bob.name, `Dispute "Wrong outcome" → "${d.sign.summary}" signed`);
  const disputed = await waitState(h, crew.alice, v.id, ['disputed', 'settled', 'refunded'], 'dispute');
  t.step('chain', `Disputed (bond ${usd(disputed.dispute?.bond_units ?? 0)})`);
  await showBooth(h, crew, v.id, t);
  const s = await showSettlement(h, crew, v.id, t);
  t.eq('settled by the panel', s.settlement?.path, 'panel');
  return v.id;
}

export async function aiJudged(h: Harness, crew: Crew, t: Transcript): Promise<string> {
  t.section('3. AI-judged bet → replay booth → panel');
  const v = await playRulesBet(h, crew, AI_JUDGED, t);
  t.eq('ai_judged goes to the booth (reason 11)', v.preruling?.reason ?? (v.dispute?.reason ?? null), 11);
  await showRuling(crew.alice, v.id, t);
  await showBooth(h, crew, v.id, t);
  const s = await showSettlement(h, crew, v.id, t);
  t.eq('settled by the panel', s.settlement?.path, 'panel');
  return v.id;
}

interface BoothRecord {
  status: string;
  exhibits: { id: string; kind: string; witness?: string | null }[];
  briefs: { side: number }[];
  commits: unknown[];
  reveals: unknown[];
  ruling: { outcome: number; votes: number[] } | null;
  tx_signature: string | null;
}

async function showBooth(h: Harness, crew: Crew, betId: string, t: Transcript): Promise<void> {
  const booth = await waitFor(h, 'replay booth', async () => {
    try {
      const b = await crew.alice.get<BoothRecord>(`/bets/${betId}/booth`);
      return b.status === 'submitted' ? b : null;
    } catch {
      return null;
    }
  });
  const ex = await crew.alice.bytes(`/bets/${betId}/exhibits/${booth.exhibits[0]!.id}`);
  t.step(
    'booth',
    `${booth.exhibits.length} exhibits (${booth.exhibits.map((e) => `${e.id}:${e.kind}${e.witness ? `/${e.witness}` : ''}`).join(' ')}); E1 ${ex.bytes.length} B ${ex.type}`,
  );
  t.step('booth', `briefs sides ${booth.briefs.map((b) => b.side).join('+')}, ${booth.commits.length} commits → ${booth.reveals.length} reveals → outcome ${booth.ruling?.outcome} votes [${booth.ruling?.votes.join(',')}] → settle_panel`);
}

export async function worldMarket(h: Harness, crew: Crew, t: Transcript): Promise<string> {
  t.section('4. World Mode market bet');
  const { alice, bob } = crew;
  const list = await alice.get<{ events: { id: string; title: string }[] }>('/world/events?q=rain&limit=5');
  const ev = list.events.find((e) => e.id === DEMO_WORLD_EVENT_ID);
  t.check('World search finds the demo event', !!ev);
  const contract = `${DEMO_WORLD_EVENT_ID}-YES`;
  const q = await alice.post<{ quote_id: string; p_bps: number; proposer_units: number; counterparty_units: number }>('/world/quote', {
    legs: [{ event_id: DEMO_WORLD_EVENT_ID, contract_id: contract, side: 'yes' }],
    total_units: 10_000_000,
  });
  t.step(alice.name, `World "${ev?.title}" Yes @ ${q.p_bps / 100}% → split ${usd(q.proposer_units)} / ${usd(q.counterparty_units)}`);
  const r = await alice.post<{ bet: BetView; sign: SignPayload }>('/world/bets', { quote_id: q.quote_id, counterparty_user_id: bob.userId });
  await alice.signConfirmed(r.sign, 'create_bet');
  const betId = r.bet.id;
  t.step(alice.name, `Propose to Bob → "${r.sign.summary}" signed → bet ${betId.slice(0, 8)}… (${r.bet.kind})`);
  for (const c of [alice, bob]) {
    const f = await c.post<{ sign: SignPayload }>(`/bets/${betId}/fund`);
    await c.signConfirmed(f.sign, 'fund');
    t.step(c.name, `Stake → "${f.sign.summary}" signed`);
  }
  await waitState(h, alice, betId, ['live'], 'market start');
  t.step('keeper', 'market funded → start (oracle) → Live');
  resolveWorldEvent(h, 'yes');
  t.step('gemini', `${DEMO_WORLD_EVENT_ID} resolves YES`);
  const v = await waitState(h, alice, betId, ['preruled', 'disputed', 'settled'], 'market resolution');
  t.step('keeper', `end → market_bin → run_rules → ${v.state_label} (mask ${v.preruling?.winner_mask})`);
  t.eq('market pre-ruled for Alice', v.preruling?.winner_mask, 1);
  await showRuling(alice, betId, t);
  await consentBoth(crew, betId, t);
  const s = await showSettlement(h, crew, betId, t);
  t.eq('market settled by consent', s.settlement?.path, 'consent');
  return betId;
}

export async function wrapUp(crew: Crew, t: Transcript, betIds: string[]): Promise<void> {
  t.section('Home');
  const { alice, bob } = crew;
  const mine = await alice.get<{ bets: BetView[] }>('/bets');
  t.step(alice.name, `Bets: ${mine.bets.map((b) => `${b.title} [${b.state_label}]`).join(' · ')}`);
  t.check('every demo bet is listed', betIds.every((id) => mine.bets.some((b) => b.id === id)));
  const settled = await bob.get<{ bets: BetView[] }>('/bets?state=settled');
  t.step(bob.name, `Settled: ${settled.bets.length}`);
  const lb = await alice.get<{ rows: { display_name: string; net_units: number }[] }>(`/leaderboard?huddle_id=${crew.huddleId}`);
  t.step(alice.name, `Leaderboard: ${lb.rows.map((r) => `${r.display_name} ${usd(r.net_units, true)}`).join(' · ')}`);
  t.check('leaderboard nets to zero (no fees)', lb.rows.reduce((a, r) => a + r.net_units, 0) === 0);
  for (const c of [alice, bob]) {
    const b = await c.get<{ usdc_units: number }>('/balance');
    t.step(c.name, `balance ${usd(b.usdc_units)}`);
  }
}
