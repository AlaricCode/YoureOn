import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { BET_STATE, CONSENT_WINDOW_S, ZERO_HASH_HEX, marketHash, termsHash } from '@verdict/engine';
import { fundIx } from '../src/chain/ixs.js';
import { loadConfig } from '../src/config/load.js';
import { createContext, type AppContext } from '../src/context.js';
import type { KeyPair } from '../src/crypto/keys.js';
import { generateKeypair } from '../src/crypto/keys.js';
import { COLLECTIONS, type UserRecord } from '../src/persistence/records.js';
import { MockGemini } from '../src/providers/mock/gemini.js';
import type { WorldEvent, WorldPrice } from '../src/providers/types.js';
import { toBase64 } from '../src/util/bytes.js';
import { ManualClock } from '../src/util/clock.js';
import { createQuote, QUOTE_TTL_MS } from '../src/world/quotes.js';
import { PriceRelay } from '../src/world/prices.js';
import { WorldService, refundDue } from '../src/world/service.js';
import { auth, login, makeApp, type TestApp, type TestUser } from './appHelpers.js';
import { flush, ixEnv, ok, userSend } from './bweHelpers.js';
import { testEnv } from './helpers.js';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.app.close();
  t = null;
});

function huddle(ctx: AppContext, ...userIds: string[]): void {
  const now = ctx.clock.nowMs();
  ctx.store.collection(COLLECTIONS.huddles).set(`h-${userIds.join('-')}`, {
    id: `h-${userIds.join('-')}`,
    code: '123456',
    creator_user_id: userIds[0],
    created_at_ms: now,
    updated_at_ms: now,
    members: userIds.map((u) => ({ user_id: u, joined_at_ms: now, confirmed: true, confirmed_at_ms: now, confirmed_cos_bps: null })),
  });
}

const post = (app: TestApp['app'], url: string, u: TestUser, payload: unknown) => app.inject({ method: 'POST', url, headers: auth(u), payload: payload as object });

describe('POST /world/quote (§11.2, §11.3)', () => {
  it('splits single legs and parlays with the engine math', async () => {
    t = await makeApp();
    const u = await login(t.app, 'q@example.com');
    const single = await post(t.app, '/v1/world/quote', u, { legs: [{ event_id: 'GEMI-FED-DEC26', contract_id: 'GEMI-FED-DEC26-YES', side: 'yes' }], total_units: 10_000_000 });
    expect(single.statusCode).toBe(200);
    expect(single.json()).toMatchObject({
      p_bps: 6200,
      proposer_units: 6_200_000,
      counterparty_units: 3_800_000,
      legs: [{ event_id: 'GEMI-FED-DEC26', contract_id: 'GEMI-FED-DEC26-YES', side: 'yes', prob_bps: 6200 }],
      expires_at_ms: t.clock.nowMs() + QUOTE_TTL_MS,
    });
    const no = (await post(t.app, '/v1/world/quote', u, { legs: [{ event_id: 'GEMI-FED-DEC26', contract_id: 'GEMI-FED-DEC26-YES', side: 'no' }], total_units: 10_000_000 })).json();
    expect(no).toMatchObject({ p_bps: 3800, proposer_units: 3_800_000, counterparty_units: 6_200_000 });
    const parlay = (
      await post(t.app, '/v1/world/quote', u, {
        legs: [
          { event_id: 'GEMI-NBA-FINALS-27', contract_id: 'GEMI-NBA27-OKC', side: 'yes' },
          { event_id: 'GEMI-ETH-10K-27', contract_id: 'GEMI-ETH-10K-27-YES', side: 'yes' },
        ],
        total_units: 10_000_000,
      })
    ).json();
    // P = floor(3100·1500/10000) = 465 → proposer floor(10M·465/1e4/1e4)·1e4
    expect(parlay).toMatchObject({ p_bps: 465, proposer_units: 460_000, counterparty_units: 9_540_000 });
  });

  it('refuses bad requests with §12.8 codes', async () => {
    t = await makeApp();
    const u = await login(t.app, 'q@example.com');
    const leg = { event_id: 'GEMI-FED-DEC26', contract_id: 'GEMI-FED-DEC26-YES', side: 'yes' };
    const code = async (body: unknown) => {
      const r = await post(t!.app, '/v1/world/quote', u, body);
      return `${r.statusCode} ${r.json().error?.code}`;
    };
    expect(await code({ legs: [leg], total_units: 15_000 })).toBe('422 BAD_STAKE');
    expect(await code({ legs: [leg], total_units: 0 })).toBe('422 BAD_STAKE');
    expect(await code({ legs: [leg, leg], total_units: 10_000_000 })).toBe('422 DRAFT_INVALID');
    expect(await code({ legs: [{ ...leg, contract_id: 'nope' }], total_units: 10_000_000 })).toBe('404 NOT_FOUND');
    expect(await code({ legs: [{ ...leg, event_id: 'nope' }], total_units: 10_000_000 })).toBe('404 NOT_FOUND');
    expect(await code({ legs: [{ event_id: 'GEMI-CPI-OCT26', contract_id: 'GEMI-CPI-OCT26-YES', side: 'yes' }], total_units: 10_000_000 })).toBe('409 WRONG_STATE');
    expect(await code({ legs: [{ ...leg, side: 'maybe' }], total_units: 10_000_000 })).toBe('400 WRONG_STATE');
    expect(await code({ legs: Array(5).fill(leg), total_units: 10_000_000 })).toBe('400 WRONG_STATE');
    expect((await t.app.inject({ method: 'POST', url: '/v1/world/quote', payload: { legs: [leg], total_units: 1 } })).statusCode).toBe(401);
  });
});

describe('POST /world/bets (§11.4)', () => {
  it('creates a market bet for a confirmed huddle peer; quotes are single-use and expire', async () => {
    t = await makeApp();
    const a = await login(t.app, 'alex@example.com');
    const b = await login(t.app, 'maya@example.com');
    const c = await login(t.app, 'stranger@example.com');
    const quote = async () =>
      (await post(t!.app, '/v1/world/quote', a, { legs: [{ event_id: 'GEMI-FED-DEC26', contract_id: 'GEMI-FED-DEC26-YES', side: 'yes' }], total_units: 10_000_000 })).json()
        .quote_id as string;
    const q1 = await quote();
    const notPeer = await post(t.app, '/v1/world/bets', a, { quote_id: q1, counterparty_user_id: b.user.id });
    expect(notPeer.statusCode).toBe(409);
    huddle(t.ctx, a.user.id, b.user.id);
    expect((await post(t.app, '/v1/world/bets', a, { quote_id: q1, counterparty_user_id: c.user.id })).statusCode).toBe(409);
    expect((await post(t.app, '/v1/world/bets', b, { quote_id: q1, counterparty_user_id: a.user.id })).statusCode).toBe(404);

    const res = await post(t.app, '/v1/world/bets', a, { quote_id: q1, counterparty_user_id: b.user.id });
    expect(res.statusCode).toBe(200);
    const { bet, sign } = res.json();
    expect(bet).toMatchObject({
      kind: 'market',
      ai_judged: false,
      state: 'proposed',
      state_label: 'Waiting',
      title: 'Fed cuts rates at the December 2026',
      my_index: 0,
      my_role: 'participant',
      stake_each_units: null,
      stakes_units: [6_200_000, 3_800_000],
      pot_units: 10_000_000,
      participants: [
        { user_id: a.user.id, side: 0, accepted: true, funded: false },
        { user_id: b.user.id, side: 1, accepted: false, funded: false },
      ],
      witnesses: [],
      conditions: [],
    });
    expect(bet.program).toMatchObject({ kind: 'market', participants: [a.wallet.publicKey, b.wallet.publicKey], stakes: [6_200_000, 3_800_000] });
    expect(bet.readback.join(' ')).toContain('Fed cuts rates at the December 2026 meeting: Yes');
    expect(sign.summary).toBe('Stake $6.20');
    // single use
    expect((await post(t.app, '/v1/world/bets', a, { quote_id: q1, counterparty_user_id: b.user.id })).json().error.code).toBe('QUOTE_EXPIRED');
    // expiry
    const q2 = await quote();
    t.clock.advance(QUOTE_TTL_MS + 1);
    const late = await post(t.app, '/v1/world/bets', a, { quote_id: q2, counterparty_user_id: b.user.id });
    expect(late.statusCode).toBe(410);
    expect(late.json().error).toEqual({ code: 'QUOTE_EXPIRED', message: 'Price changed' });

    // proposer signs create_bet (oracle co-signs in the backend) → on chain, counterparty notified
    const sent: string[] = [];
    const orig = t.ctx.hub.notify.bind(t.ctx.hub);
    t.ctx.hub.notify = (uid, title, id) => {
      sent.push(`${uid === b.user.id ? 'b' : 'a'}:${title}:${id}`);
      return orig(uid, title, id);
    };
    const sig = a.wallet.sign(Buffer.from(sign.message_b64, 'base64'));
    const sub = await post(t.app, `/v1/tx/${sign.tx_id}/submit`, a, { signature_b64: toBase64(sig) });
    expect(sub.json()).toMatchObject({ status: 'confirmed' });
    await flush(t.ctx);
    expect(sent).toContain(`b:Bet offered:${bet.id}`);
    const acct = (await t.ctx.chain.getBet(bet.id))!;
    expect(acct).toMatchObject({ state: BET_STATE.Proposed, flags: 4, stake_each: 0n, side_b_mask: 2, acceptance_audio_hash: ZERO_HASH_HEX });
    expect(acct.judges).toEqual(t.ctx.config.keys.judges.map((k) => k.publicKey));

    // hedge (§11.6, mock)
    const h = await post(t.app, `/v1/world/bets/${bet.id}/hedge`, b, { contract_id: 'GEMI-FED-DEC26-YES', side: 'no', amount_units: 1_000_000 });
    expect(h.json()).toMatchObject({ status: 'mock' });
    expect(h.json().order_id).toMatch(/^mock-/);
    expect((await post(t.app, `/v1/world/bets/${bet.id}/hedge`, c, { contract_id: 'GEMI-FED-DEC26-YES', side: 'no', amount_units: 1 })).statusCode).toBe(409);
    expect((await post(t.app, `/v1/world/bets/${bet.id}/hedge`, b, { contract_id: 'X', side: 'no', amount_units: 1 })).statusCode).toBe(404);
  });

  it('relays prices on world:<event_id> with a snapshot on subscribe (§11.5)', async () => {
    t = await makeApp();
    const u = await login(t.app, 'ws@example.com');
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (t.app.server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws?token=${u.token}`);
    const msgs: { type: string; event_id?: string; contract_id?: string; prob_bps?: number }[] = [];
    await new Promise<void>((r) => ws.on('open', () => r()));
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    ws.send(JSON.stringify({ type: 'subscribe', topics: ['world:GEMI-SUPERBOWL-61'] }));
    for (let i = 0; i < 50 && msgs.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
    expect(msgs.filter((m) => m.type === 'world.price').map((m) => [m.contract_id, m.prob_bps])).toEqual([
      ['GEMI-SB61-KC', 1800],
      ['GEMI-SB61-PHI', 1500],
      ['GEMI-SB61-BUF', 1200],
    ]);
    ws.close();
  });
});

describe('PriceRelay', () => {
  it('publishes provider prices, keeps the latest, expires unpinned relays', async () => {
    t = await makeApp();
    let emit: ((p: WorldPrice) => void) | null = null;
    let unsubscribed = 0;
    t.ctx.providers.gemini = {
      name: 'fake',
      listEvents: async () => [],
      getEvent: async () => null,
      subscribePrices: (_id, on) => {
        emit = on;
        return () => {
          unsubscribed++;
        };
      },
    };
    const published: unknown[] = [];
    const pub = t.ctx.hub.publish.bind(t.ctx.hub);
    t.ctx.hub.publish = (topic, msg) => {
      published.push([topic, msg]);
      return pub(topic, msg);
    };
    const relay = new PriceRelay(t.ctx);
    relay.want('EV');
    relay.want('EV');
    emit!({ event_id: 'EV', contract_id: 'C', prob_bps: 4200, at_ms: 5 });
    expect(published).toEqual([['world:EV', { type: 'world.price', event_id: 'EV', contract_id: 'C', prob_bps: 4200, at_ms: 5 }]]);
    expect(relay.latest('EV')).toHaveLength(1);
    relay.gc(new Set(['EV']));
    t.clock.advance(11 * 60_000);
    relay.gc(new Set(['EV']));
    expect(relay.isActive('EV')).toBe(true);
    relay.gc(new Set()); // unpinned now; expires RELAY_TTL_MS after the last pin
    expect(relay.isActive('EV')).toBe(true);
    t.clock.advance(11 * 60_000);
    relay.gc(new Set());
    expect(relay.isActive('EV')).toBe(false);
    expect(unsubscribed).toBe(1);
  });
});

// ---- resolution oracle without the bet-lifecycle service (standalone WorldService) ----

function addUser(ctx: AppContext, name: string, wallet: KeyPair): UserRecord {
  const u: UserRecord = {
    id: `u-${name}`,
    wallet: wallet.publicKey,
    display_name: name,
    identity: `email:${name}@x`,
    email: null,
    enrolled: { face: false, voice: false },
    created_at_ms: 0,
    updated_at_ms: 0,
  };
  ctx.store.collection<UserRecord>(COLLECTIONS.users).set(u.id, u);
  return u;
}

describe('World resolution oracle (§11.4 flow, keeper)', () => {
  async function setup(result: 'yes' | 'no' | 'void') {
    const clock = new ManualClock(1_760_000_000_000);
    const ev: WorldEvent = {
      id: 'EV-1',
      title: 'Will it rain in Vancouver tomorrow',
      category: 'Weather',
      close_time_ms: clock.nowMs() + 86_400_000,
      status: 'open',
      contracts: [{ id: 'EV-1-YES', label: 'Yes', prob_bps: 7000, bid_bps: 6900, ask_bps: 7100 }],
    };
    const gemini = new MockGemini(clock, [ev]);
    const ctx = createContext(loadConfig(testEnv()), { clock, inMemory: true, providers: { gemini } });
    const world = new WorldService(ctx);
    world.register();
    const alice = generateKeypair();
    const bob = generateKeypair();
    const A = addUser(ctx, 'Alex', alice);
    const B = addUser(ctx, 'Maya', bob);
    huddle(ctx, A.id, B.id);
    await ctx.chain.faucet(alice.publicKey, 50_000_000n);
    await ctx.chain.faucet(bob.publicKey, 50_000_000n);
    const q = await createQuote(ctx, A.id, { legs: [{ event_id: 'EV-1', contract_id: 'EV-1-YES', side: 'yes' }], total_units: 10_000_000 });
    const { bet, sign } = (await world.createBet(A, q.quote_id, B.id)) as { bet: { id: string; program_hash: string }; sign: { tx_id: string; message_b64: string } };
    const sub = await ctx.txs.submit(sign.tx_id, A.id, { signature_b64: toBase64(alice.sign(Buffer.from(sign.message_b64, 'base64'))) });
    expect(sub.status).toBe('confirmed');
    const env = ixEnv(ctx);
    const terms = termsHash(env.oracle, ctx.config.keys.judges.map((k) => k.publicKey), ZERO_HASH_HEX);
    for (const u of [alice, bob]) {
      ok(await userSend(ctx, [fundIx(env, bet.id, u.publicKey, { calibration_hash: ZERO_HASH_HEX, program_hash: bet.program_hash, terms_hash: terms })], [u]));
    }
    await flush(ctx);
    return { ctx, clock, world, ev, bet: bet.id, alice, bob, resolve: () => {
      ev.status = 'resolved';
      ev.resolution = [{ contract_id: 'EV-1-YES', result }];
    } };
  }

  it('start → wait for resolution → end → market_bin → run_rules → silence consent → Settled', async () => {
    const s = await setup('yes');
    const state = async () => (await s.ctx.chain.getBet(s.bet))!.state;
    expect(s.world.oracleDelegated()).toBe(false);
    await s.world.tick();
    expect(await state()).toBe(BET_STATE.Live);
    await s.world.tick();
    expect(await state()).toBe(BET_STATE.Live); // unresolved
    s.resolve();
    await s.world.tick();
    expect(await state()).toBe(BET_STATE.Perceiving);
    await s.world.tick();
    const pre = (await s.ctx.chain.getBet(s.bet))!;
    expect(pre.state).toBe(BET_STATE.PreRuled);
    expect(pre.winner_mask).toBe(0b01);
    expect(pre.leg_results[0]).toBe(1);
    const tb = (await s.ctx.chain.getTrackBuffer(s.bet))!;
    expect(tb.header.finalized).toBe(1);
    expect(Buffer.from(tb.payload).toString('hex')).toContain(marketHash('EV-1', 'EV-1-YES'));
    await s.world.tick(); // inside the consent window: nothing
    expect(await state()).toBe(BET_STATE.PreRuled);
    s.clock.advance((CONSENT_WINDOW_S + 10) * 1000);
    await s.world.tick();
    expect(await state()).toBe(BET_STATE.Settled);
    expect(await s.ctx.chain.getUsdcBalance(s.alice.publicKey)).toBe(50_000_000n - 7_000_000n + 10_000_000n);
    await s.world.tick();
    expect(s.world.bets.get(s.bet)!.done).toBe(true);
    await s.ctx.chain.close();
  });

  it('a void leg ⇒ the interpreter needs the panel (Disputed); refundDue follows §9.4 #15', async () => {
    const s = await setup('void');
    await s.world.tick();
    s.resolve();
    await s.world.tick();
    await s.world.tick();
    const b = (await s.ctx.chain.getBet(s.bet))!;
    expect(b.state).toBe(BET_STATE.Disputed);
    expect(b.leg_results[0]).toBe(2);
    expect(refundDue({ ...b, state: BET_STATE.Funded, funded_at: 100n } as never, 100n + 901n)).toBe(true);
    expect(refundDue({ ...b, state: BET_STATE.Funded, funded_at: 100n } as never, 100n + 900n)).toBe(false);
    await s.ctx.chain.close();
  });
});
