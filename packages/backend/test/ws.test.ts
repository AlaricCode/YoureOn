import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { betAddress, createBetIx } from '../src/chain/ixs.js';
import { generateKeypair } from '../src/crypto/keys.js';
import { ApiError } from '../src/errors.js';
import { auth, login, makeApp, type TestApp } from './appHelpers.js';

let t: TestApp | null = null;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await t?.app.close();
  t = null;
});

async function listen(): Promise<string> {
  await t!.app.listen({ port: 0, host: '127.0.0.1' });
  const a = t!.app.server.address();
  if (!a || typeof a === 'string') throw new Error('no address');
  return `ws://127.0.0.1:${a.port}/v1/ws`;
}

/** Opens a socket and buffers every message. */
function open(url: string): Promise<{ ws: WebSocket; msgs: unknown[]; next: (pred?: (m: any) => boolean) => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const msgs: unknown[] = [];
    const waiters: { pred: (m: any) => boolean; res: (m: any) => void }[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      const w = waiters.findIndex((x) => x.pred(m));
      if (w >= 0) waiters.splice(w, 1)[0]!.res(m);
      else msgs.push(m);
    });
    const next = (pred: (m: any) => boolean = () => true) =>
      new Promise<any>((res, rej) => {
        const i = msgs.findIndex((m) => pred(m));
        if (i >= 0) return res(msgs.splice(i, 1)[0]);
        waiters.push({ pred, res });
        setTimeout(() => rej(new Error('timeout waiting for ws message')), 3000).unref();
      });
    ws.once('open', () => resolve({ ws, msgs, next }));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

describe('WebSocket hub (§12.4)', () => {
  it('rejects unauthenticated upgrades with 401', async () => {
    t = await makeApp();
    const url = await listen();
    await expect(open(`${url}?token=bad`)).rejects.toThrow(/401/);
    await expect(open(url)).rejects.toThrow(/401/);
  });

  it('ping/pong, subscribe with snapshots, publish, refused topics, notify', async () => {
    t = await makeApp();
    const url = await listen();
    const u = await login(t.app, 'ws@example.com');
    t.ctx.hub.setSnapshotProvider('huddle', (id, userId) => {
      if (id === 'secret') throw new ApiError('NOT_FOUND');
      return [
        { type: 'huddle', huddle: { id, viewer: userId } },
        { type: 'draft', huddle_id: id, draft: { draft_id: 'd1' } },
      ];
    });
    const c = await open(`${url}?token=${encodeURIComponent(u.token)}`);
    c.ws.send(JSON.stringify({ type: 'ping' }));
    expect(await c.next()).toEqual({ type: 'pong' });

    c.ws.send(JSON.stringify({ type: 'subscribe', topics: ['huddle:secret', 'huddle:h1', 'user', 'bogus topic'] }));
    expect(await c.next((m) => m.type === 'error')).toEqual({ type: 'error', error: { code: 'NOT_FOUND', message: 'Not found' } });
    expect(await c.next((m) => m.type === 'huddle')).toEqual({ type: 'huddle', huddle: { id: 'h1', viewer: u.user.id } });
    expect(await c.next((m) => m.type === 'draft')).toMatchObject({ huddle_id: 'h1' });
    expect(await c.next((m) => m.type === 'error')).toMatchObject({ error: { code: 'NOT_FOUND' } });

    // round-trip barrier so the subscription is registered before publishing
    c.ws.send(JSON.stringify({ type: 'ping' }));
    await c.next((m) => m.type === 'pong');
    expect(t.ctx.hub.publish('huddle:h1', { type: 'huddle', huddle: { v: 2 } })).toBe(1);
    expect(await c.next((m) => m.type === 'huddle')).toEqual({ type: 'huddle', huddle: { v: 2 } });
    expect(t.ctx.hub.notify(u.user.id, 'Ready', null)).toBe(1);
    expect(await c.next((m) => m.type === 'notify')).toEqual({ type: 'notify', title: 'Ready', bet_id: null });

    c.ws.send(JSON.stringify({ type: 'unsubscribe', topics: ['huddle:h1'] }));
    c.ws.send(JSON.stringify({ type: 'ping' }));
    await c.next((m) => m.type === 'pong');
    expect(t.ctx.hub.publish('huddle:h1', { type: 'huddle', huddle: {} })).toBe(0);
  });

  it('dispatches scene.frame / recording to registered handlers', async () => {
    t = await makeApp();
    const url = await listen();
    const u = await login(t.app, 'scene@example.com');
    const got: string[] = [];
    t.ctx.hub.onMessage('recording', (conn, m) => {
      got.push(`${conn.userId}:${m.bet_id}:${m.witness_key}`);
      conn.send({ type: 'pong' });
    });
    const c = await open(`${url}?token=${encodeURIComponent(u.token)}`);
    c.ws.send(JSON.stringify({ type: 'recording', bet_id: 'b', witness_key: 'w' }));
    await c.next((m) => m.type === 'pong');
    expect(got).toEqual([`${u.user.id}:b:w`]);
  });

  it('closes sockets after 60 s of silence', async () => {
    t = await makeApp();
    const url = await listen();
    const u = await login(t.app, 'idle@example.com');
    const c = await open(`${url}?token=${encodeURIComponent(u.token)}`);
    const closed = new Promise<number>((r) => c.ws.once('close', (code) => r(code)));
    t.clock.advance(59_000);
    t.ctx.hub.sweepIdle();
    expect(t.ctx.hub.connectionCount()).toBe(1);
    t.clock.advance(2_000);
    t.ctx.hub.sweepIdle();
    expect(await closed).toBe(4000);
  });

  it('relays mock-chain events as WS `chain` messages on bet:<id> (§12.5 mock source)', async () => {
    t = await makeApp();
    const url = await listen();
    const u = await login(t.app, 'chain@example.com');
    const seen: string[] = [];
    t.ctx.events.on('*', (e) => {
      seen.push(e.name);
    });
    const env = { programId: t.ctx.chain.programId, mint: t.ctx.chain.mint, feePayer: t.ctx.chain.feePayer, oracle: t.ctx.chain.oracle };
    const friend = generateKeypair().publicKey;
    const bet = betAddress(env, u.wallet.publicKey, 1n);
    const c = await open(`${url}?token=${encodeURIComponent(u.token)}`);
    c.ws.send(JSON.stringify({ type: 'subscribe', topics: [`bet:${bet}`] }));
    c.ws.send(JSON.stringify({ type: 'ping' }));
    await c.next((m) => m.type === 'pong');

    const { sign } = await t.ctx.txs.request({
      user: { id: u.user.id, wallet: u.wallet.publicKey },
      kind: 'create_bet',
      ixs: [
        createBetIx(env, u.wallet.publicKey, {
          nonce: 1n,
          participants: [u.wallet.publicKey, friend],
          stakes: [1_000_000n, 1_000_000n],
          side_b_mask: 2,
          stake_each: 1_000_000n,
          time_limit_s: 60,
          flags: 0x02,
          program_hash: '11'.repeat(32),
          acceptance_audio_hash: '22'.repeat(32),
          judges: t.ctx.config.keys.judges.map((j) => j.publicKey) as [string, string, string],
        }),
      ],
      summary: 'Create bet',
    });
    // creator signs; the backend adds fee payer + oracle co-signature (§9.4 #2)
    const r = await t.app.inject({
      method: 'POST',
      url: `/v1/tx/${sign.tx_id}/submit`,
      headers: auth(u),
      payload: { signature_b64: Buffer.from(u.wallet.sign(Buffer.from(sign.message_b64, 'base64'))).toString('base64') },
    });
    expect(r.json().status).toBe('confirmed');
    const m = await c.next((x) => x.type === 'chain');
    expect(m).toMatchObject({ type: 'chain', bet_id: bet, name: 'BetCreated', signature: r.json().signature });
    expect(m.data.nonce).toBe('1');
    expect(m.data.stakes).toEqual(['1000000', '1000000']);
    await t.ctx.events.idle();
    expect(seen).toEqual(['BetCreated']);
  });
});
