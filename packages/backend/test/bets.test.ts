import { afterEach, describe, expect, it } from 'vitest';
import { acceptSigMessage } from '@verdict/engine';
import { betMirror } from '../src/bets/records.js';
import { toBase64 } from '../src/util/bytes.js';
import { auth, login, type TestApp, type TestUser } from './appHelpers.js';
import { b64, crew, fakeJpeg, fakeWav, get, makeAppWith, post, submitSign } from './identityHelpers.js';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.app.close();
  t = null;
});

const PAPER = "I bet Bob can't get a paper ball in the trash can from behind that line. Three tries. $5";

async function readyDraft(transcript = PAPER) {
  const c = await crew(t!, ['Alice', 'Bob']);
  const [alice, bob] = c.users as [TestUser, TestUser];
  const d = (await post(t!.app, alice, '/v1/bets/compile', { huddle_id: c.huddleId, transcript })).json();
  expect(d.status).toBe('ready');
  return { ...c, alice, bob, d };
}

async function bobAccepts(bob: TestUser, d: { draft_id: string; program_hash: string }) {
  const ch = (await get(t!.app, bob, `/v1/drafts/${d.draft_id}/accept/challenge`)).json();
  const wav = fakeWav();
  const r = await post(t!.app, bob, `/v1/drafts/${d.draft_id}/accept`, {
    challenge_id: ch.challenge_id,
    audio_b64: b64(wav),
    accept_sig_b64: toBase64(bob.wallet.sign(acceptSigMessage(d.program_hash, wav))),
  });
  expect(r.json().accepted).toBe(true);
}

describe('POST /bets (§12.3, identity-huddle-8)', () => {
  it('refuses until the counterparty accepted; only the creator creates; returns a BetView + create_bet sign', async () => {
    t = await makeAppWith();
    const { alice, bob, d, huddleId } = await readyDraft();
    const early = await post(t.app, alice, '/v1/bets', { draft_id: d.draft_id });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('NOT_ACCEPTED');
    await bobAccepts(bob, d);
    expect((await post(t.app, bob, '/v1/bets', { draft_id: d.draft_id })).json().error.code).toBe('WRONG_STATE');
    expect((await post(t.app, alice, '/v1/bets', {})).statusCode).toBe(400);

    const r = await post(t.app, alice, '/v1/bets', { draft_id: d.draft_id });
    expect(r.statusCode, r.body).toBe(200);
    const { bet, sign } = r.json();
    expect(sign.summary).toBe('Create bet $5.00 each');
    expect(bet).toMatchObject({
      title: 'Paper ball shot',
      kind: 'rules',
      ai_judged: false,
      state: 'proposed',
      state_label: 'Waiting',
      creator_user_id: alice.user.id,
      my_index: 0,
      my_role: 'participant',
      stake_each_units: 5_000_000,
      stakes_units: [5_000_000, 5_000_000],
      pot_units: 10_000_000,
      actor_bound: true,
      program_hash: d.program_hash,
      calibration: null,
      preruling: null,
      settlement: null,
      witnesses: [],
    });
    expect(bet.participants).toEqual([
      { user_id: alice.user.id, display_name: 'Alice', wallet: alice.wallet.publicKey, side: 0, accepted: true, funded: false, consent: 'pending' },
      { user_id: bob.user.id, display_name: 'Bob', wallet: bob.wallet.publicKey, side: 1, accepted: true, funded: false, consent: 'pending' },
    ]);
    expect(bet.conditions.length).toBeGreaterThan(0);
    expect(bet.conditions[0]).toMatchObject({ leg: 1, field: 'valid_attempt' });
    expect(bet.yaml).toContain('version: 2');

    // Mirror for the lifecycle/booth/receipt (bet-lifecycle-1): candidates frozen, acceptances with voice scores.
    const rec = betMirror(t.ctx).get(bet.id)!;
    expect(rec).toMatchObject({ draft_id: d.draft_id, huddle_id: huddleId, created: false, candidate_user_ids: [alice.user.id, bob.user.id] });
    expect(rec.acceptances.map((a) => a.user_id)).toEqual([alice.user.id, bob.user.id]);
    expect(rec.acceptances[1]!.voice_cos_bps).toBeGreaterThan(5000);

    // Not listed until create_bet confirms.
    expect((await get(t.app, alice, '/v1/bets')).json().bets).toEqual([]);
    expect((await submitSign(t.app, alice, sign)).status).toBe('confirmed');
    expect(betMirror(t.ctx).get(bet.id)!.created).toBe(true);
    const list = (await get(t.app, bob, '/v1/bets')).json().bets;
    expect(list.map((b: { id: string }) => b.id)).toEqual([bet.id]);
    expect(list[0]).toMatchObject({ my_index: 1, state: 'proposed', deadlines_ms: { fund: expect.any(Number) } });
    expect((await get(t.app, bob, '/v1/bets?state=proposed')).json().bets).toHaveLength(1);
    expect((await get(t.app, bob, '/v1/bets?state=funded')).json().bets).toHaveLength(0);
    expect((await get(t.app, bob, '/v1/bets?state=nope')).statusCode).toBe(400);
  });

  it('a re-request (new nonce) drops the never-signed mirror record', async () => {
    t = await makeAppWith();
    const { alice, bob, d } = await readyDraft();
    await bobAccepts(bob, d);
    const first = (await post(t.app, alice, '/v1/bets', { draft_id: d.draft_id })).json();
    const second = (await post(t.app, alice, '/v1/bets', { draft_id: d.draft_id })).json();
    expect(second.bet.id).not.toBe(first.bet.id);
    expect(betMirror(t.ctx).has(first.bet.id)).toBe(false);
    expect(betMirror(t.ctx).has(second.bet.id)).toBe(true);
  });
});

describe('GET /bets/:id, practice, ruling, leaderboard', () => {
  async function createdBet() {
    const c = await readyDraft();
    await bobAccepts(c.bob, c.d);
    const r = (await post(t!.app, c.alice, '/v1/bets', { draft_id: c.d.draft_id })).json();
    expect((await submitSign(t!.app, c.alice, r.sign)).status).toBe('confirmed');
    return { ...c, betId: r.bet.id as string, bet: r.bet };
  }

  it('hides bets from non-members and unknown ids', async () => {
    t = await makeAppWith();
    const { betId } = await createdBet();
    const stranger = await login(t.app, 'stranger@example.com');
    expect((await get(t.app, stranger, `/v1/bets/${betId}`)).statusCode).toBe(404);
    expect((await get(t.app, stranger, '/v1/bets')).json().bets).toEqual([]);
    expect((await get(t.app, stranger, '/v1/bets/not-a-key')).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/v1/bets/${betId}` })).statusCode).toBe(401);
  });

  it('practice needs a placed calibration, then reports per-condition firing frames', async () => {
    t = await makeAppWith();
    const { alice, betId } = await createdBet();
    const frames = Array.from({ length: 12 }, () => b64(fakeJpeg()));
    const early = await post(t.app, alice, `/v1/bets/${betId}/practice`, { frames_b64: frames });
    expect(early.json().error.code).toBe('CALIBRATION_INCOMPLETE');
    expect((await post(t.app, alice, `/v1/bets/${betId}/practice`, { frames_b64: [] })).statusCode).toBe(400);
    expect((await post(t.app, alice, `/v1/bets/${betId}/practice`, { frames_b64: Array.from({ length: 51 }, () => frames[0]) })).statusCode).toBe(400);
    const cal = await t.app.inject({
      method: 'PUT',
      url: `/v1/bets/${betId}/calibration`,
      headers: auth(alice),
      payload: {
        version: 1,
        scene: { camera: { width_px: 1920, height_px: 1080, orientation: 'landscape' }, entity_refs: [] },
        regions: [{ entity: 'line', shape: 'line', points: [[3000, 6000], [3000, 10000]], behind_sign: 1 }],
      },
    });
    expect(cal.statusCode, cal.body).toBe(200);
    const r = await post(t.app, alice, `/v1/bets/${betId}/practice`, { frames_b64: frames });
    expect(r.statusCode, r.body).toBe(200);
    const rows = r.json().conditions as { leg: number; field: string; label: string; fired: boolean; frame: number | null }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.fired).toBe('boolean');
      expect(row.fired ? Number.isInteger(row.frame) : row.frame === null).toBe(true);
    }
    // the BetView now carries the calibration
    expect((await get(t.app, alice, `/v1/bets/${betId}`)).json().calibration_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ruling and announcer are WRONG_STATE before a verdict', async () => {
    t = await makeAppWith();
    const { bob, betId } = await createdBet();
    expect((await get(t.app, bob, `/v1/bets/${betId}/ruling`)).json().error.code).toBe('WRONG_STATE');
    expect((await get(t.app, bob, `/v1/bets/${betId}/announce.mp3`)).json().error.code).toBe('WRONG_STATE');
  });

  it('leaderboard lists huddle members (net 0 before any settlement) and refuses outsiders', async () => {
    t = await makeAppWith();
    const { alice, bob, huddleId } = await createdBet();
    const lb = (await get(t.app, bob, `/v1/leaderboard?huddle_id=${huddleId}`)).json();
    expect(lb.rows.map((r: { display_name: string; net_units: number }) => [r.display_name, r.net_units]).sort()).toEqual([
      ['Alice', 0],
      ['Bob', 0],
    ]);
    const stranger = await login(t.app, 'stranger@example.com');
    expect((await get(t.app, stranger, `/v1/leaderboard?huddle_id=${huddleId}`)).statusCode).toBe(404);
    expect((await get(t.app, alice, '/v1/leaderboard')).json().rows).toEqual([]);
  });
});
