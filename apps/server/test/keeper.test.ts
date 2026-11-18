/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies and WS frames are loosely typed in tests */
// The keeper (src/keeper): the scheduler (pure, fake timers) and the draft-idle sweep over
// Postgres (SCHEMAS §9.3 "Draft idle: 5 min since the last negotiation event → EXPIRED").
// Every DB sweep here is scoped to this file's rooms (`roomIds`), because test files share
// one database and run in parallel.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { auditLog, betEvents, bets } from '@youre-on/db';
import { parseRealtimeEvent } from '@youre-on/shared/realtime';
import { createDb } from '@youre-on/db';
import { createDeps, startServer } from '../src/server';
import { routeModules } from '../src/routes';
import { createLifecycle, installLifecycle, lifecycleOf } from '../src/lock/runtime';
import {
  DRAFT_IDLE_MS,
  draftIdleCue,
  expireIdleDrafts,
  Keeper,
  type DraftIdleOptions,
  type KeeperTask,
} from '../src/keeper';
import { silentLogger, type Logger } from '../src/log';
import {
  connectWs,
  DB_URL,
  describeDb,
  postJson,
  signedHeaders,
  signUp,
  startTestServer,
  testEnv,
  type Ctx,
  type SignedUp,
  type WsClient,
} from './helpers';

// ---- the scheduler ---------------------------------------------------------------------

function recordingLog(): Logger & { lines: Array<[string, Record<string, unknown> | undefined]> } {
  const lines: Array<[string, Record<string, unknown> | undefined]> = [];
  const at = (msg: string, fields?: Record<string, unknown>) => void lines.push([msg, fields]);
  return { lines, debug: at, info: at, warn: at, error: at };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('Keeper (scheduler)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs every task once per pass with one `now`; a throwing task is logged and isolated', async () => {
    let t = 1_000;
    const log = recordingLog();
    const k = new Keeper({ now: () => t, log });
    const seen: Array<[string, number]> = [];
    k.register({ name: 'a', run: (n) => void seen.push(['a', n]) });
    k.register({
      name: 'boom',
      run: () => {
        throw new Error('nope');
      },
    });
    k.register({ name: 'b', run: async (n) => void seen.push(['b', n]) });
    await k.tick();
    t = 2_000;
    await k.tick();
    expect(seen).toEqual([
      ['a', 1_000],
      ['b', 1_000],
      ['a', 2_000],
      ['b', 2_000],
    ]);
    expect(log.lines.filter(([m]) => m === 'keeper.task_failed')).toHaveLength(2);
    expect(log.lines[0]![1]).toMatchObject({ task: 'boom' });
    expect(k.passes).toBe(2);
    expect(k.taskNames).toEqual(['a', 'boom', 'b']);
  });

  it('overlap guard: ticks during a pass coalesce into exactly one re-run', async () => {
    const gate = deferred();
    let runs = 0;
    const k = new Keeper({ now: () => 0, log: silentLogger });
    k.register({
      name: 'slow',
      run: async () => {
        runs++;
        if (runs === 1) await gate.promise;
      },
    });
    const p1 = k.tick();
    const p2 = k.tick();
    const p3 = k.tick();
    expect(p2).toBe(p1);
    expect(p3).toBe(p1);
    expect(runs).toBe(1); // no second concurrent run
    gate.resolve();
    await p1;
    expect(runs).toBe(2); // one coalesced re-run, not two
    expect(k.passes).toBe(2);
    await k.tick();
    expect(runs).toBe(3);
  });

  it('everyMs throttles a task by `now`; unregister removes it', async () => {
    let t = 0;
    const k = new Keeper({ now: () => t, log: silentLogger });
    const runs: number[] = [];
    const off = k.register({ name: 'hourly', everyMs: 60_000, run: (n) => void runs.push(n) });
    await k.tick(); // first pass always runs
    t = 59_999;
    await k.tick();
    t = 60_000;
    await k.tick();
    expect(runs).toEqual([0, 60_000]);
    off();
    t = 500_000;
    await k.tick();
    expect(runs).toEqual([0, 60_000]);
    expect(k.taskNames).toEqual([]);
  });

  it('start(): a setTimeout chain at interval + jitter; stop() ends it and awaits the pass', async () => {
    vi.useFakeTimers();
    const log = recordingLog();
    const k = new Keeper({
      now: () => Date.now(),
      log,
      intervalMs: 1_000,
      jitterMs: 200,
      random: () => 0.5,
    });
    expect(k.nextDelayMs()).toBe(1_100);
    let gate: ReturnType<typeof deferred> | null = null;
    let runs = 0;
    const task: KeeperTask = {
      name: 't',
      run: async () => {
        runs++;
        if (gate) await gate.promise;
      },
    };
    k.register(task);
    k.start();
    k.start(); // idempotent: still one chain
    expect(k.isStarted).toBe(true);
    expect(log.lines.find(([m]) => m === 'keeper.started')?.[1]).toMatchObject({ tasks: ['t'] });

    await vi.advanceTimersByTimeAsync(1_099);
    expect(runs).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(runs).toBe(2);

    // A pass in flight when stop() is called: stop() resolves only after it finishes.
    gate = deferred();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(runs).toBe(3);
    let stopped = false;
    const s = k.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    gate.resolve();
    await s;
    expect(stopped).toBe(true);
    expect(k.isStarted).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs).toBe(3); // nothing rescheduled after stop
    expect(vi.getTimerCount()).toBe(0);
  });

  it('jitter stays within [interval, interval + jitter)', () => {
    let r = 0;
    const k = new Keeper({ now: () => 0, log: silentLogger, random: () => r });
    expect(k.nextDelayMs()).toBe(5_000);
    r = 0.999_999;
    expect(k.nextDelayMs()).toBe(5_999);
    const flat = new Keeper({ now: () => 0, log: silentLogger, jitterMs: 0, intervalMs: 50 });
    expect(flat.nextDelayMs()).toBe(50);
  });
});

describe('draftIdleCue (§4.5)', () => {
  it('is an EXPIRED [EVENT] line', () => {
    expect(draftIdleCue()).toEqual({
      cue: 'EXPIRED',
      text: '[EVENT] EXPIRED reason=draft_idle :: Say the bet timed out before anyone agreed. Nothing moved.',
      speak: true,
    });
  });
});

// ---- the draft-idle sweep over Postgres -------------------------------------------------

describeDb('keeper draft-idle sweep over Postgres', () => {
  let ctx: Ctx;
  /** The server clock; signed requests are stamped with it (§1.3 skew check). */
  let t = Date.now();
  const sockets: WsClient[] = [];

  beforeAll(async () => {
    ctx = await startTestServer({ now: () => t });
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await ctx?.server.close();
  });

  const post = (u: SignedUp, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return postJson(ctx.base, path, raw, signedHeaders(u, 'POST', path, raw, { ts: t }));
  };
  const uid = (u: SignedUp) => u.session.user.user_id;
  /** One sweep, scoped to the calling test's room(s). */
  const sweep = (room: string | string[], o: DraftIdleOptions = {}) =>
    expireIdleDrafts(ctx.deps, { roomIds: typeof room === 'string' ? [room] : room, ...o });

  async function users<N extends string[]>(...names: N): Promise<{ [K in keyof N]: SignedUp }> {
    return (await Promise.all(names.map((n) => signUp(ctx.base, n)))) as {
      [K in keyof N]: SignedUp;
    };
  }
  async function newRoom(owner: SignedUp, ...members: SignedUp[]): Promise<string> {
    const r = await post(owner, '/v1/rooms', { name: 'Keeper room', kind: 'session' });
    expect(r.status).toBe(201);
    for (const m of members) {
      expect((await post(m, '/v1/rooms/join', { code: r.json!.code })).status).toBe(200);
    }
    return r.json!.room_id as string;
  }
  async function challenge(a: SignedUp, b: SignedUp, roomId: string) {
    return post(a, '/v1/bets', {
      room_id: roomId,
      opponent_user_id: uid(b),
      challenge_method: 'list',
    });
  }
  async function challengeOk(a: SignedUp, b: SignedUp, roomId: string): Promise<string> {
    const r = await challenge(a, b, roomId);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json!.bet.bet_id as string;
  }
  async function betRow(id: string) {
    const [row] = await ctx.deps.db.select().from(bets).where(eq(bets.id, id));
    return row!;
  }
  async function events(id: string) {
    return ctx.deps.db
      .select()
      .from(betEvents)
      .where(eq(betEvents.bet_id, id))
      .orderBy(asc(betEvents.seq));
  }

  it('expires a challenge idle for 5 min (not before), emits bet.state + judge.cue, frees pair_busy', async () => {
    const [A, B] = await users('Logan', 'Jake');
    const room = await newRoom(A, B);
    const betId = await challengeOk(A, B, room);
    expect((await challenge(A, B, room)).json!.error.details.reason).toBe('pair_busy');

    const s = await connectWs(ctx.wsUrl);
    sockets.push(s);
    s.send({ op: 'hello', token: A.session.token, subs: [{ bet_id: betId, after_seq: 2 }] });
    await s.next((f) => f.op === 'subscribed');

    t += DRAFT_IDLE_MS - 1_000;
    expect(await sweep(room)).toEqual({ expired: [], skipped: 0 });
    expect((await betRow(betId)).state).toBe('DRAFTING');

    t += 2_000;
    expect(await sweep(room)).toEqual({ expired: [betId], skipped: 0 });
    const row = await betRow(betId);
    expect([row.state, row.end_reason, row.last_seq]).toEqual(['EXPIRED', 'draft_idle', 4]);

    const evs = await events(betId);
    expect(evs.map((e) => [e.seq, e.type])).toEqual([
      [1, 'bet.invited'],
      [2, 'bet.state'],
      [3, 'bet.state'],
      [4, 'judge.cue'],
    ]);
    expect(parseRealtimeEvent(evs[2]!.envelope)).toMatchObject({ ok: true });
    expect(parseRealtimeEvent(evs[3]!.envelope)).toMatchObject({ ok: true });
    expect(evs[2]!.envelope).toMatchObject({
      type: 'bet.state',
      ts: new Date(t).toISOString(),
      payload: { state: 'EXPIRED', prev: 'DRAFTING', reason: 'draft_idle', chain_ack: 'none' },
    });
    expect(evs[3]!.envelope).toMatchObject({
      type: 'judge.cue',
      payload: draftIdleCue(),
    });

    // Fanned out after commit to the bet channel.
    expect(await s.next((f) => f.seq === 3)).toEqual(evs[2]!.envelope);
    expect(await s.next((f) => f.seq === 4)).toEqual(evs[3]!.envelope);

    const audit = await ctx.deps.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.bet_id, betId), eq(auditLog.actor_kind, 'server')));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'bet.state_changed',
      subject_user_id: uid(B),
      details: { from: 'DRAFTING', to: 'EXPIRED', end_reason: 'draft_idle', by: 'keeper' },
    });

    // Idempotent, and the pair may bet again.
    expect(await sweep(room)).toEqual({ expired: [], skipped: 0 });
    expect((await events(betId)).length).toBe(4);
    await challengeOk(A, B, room);
  });

  it('activity resets the idle clock; TERMS_PROPOSED drafts expire too', async () => {
    const [A, B, C] = await users('Logan', 'Jake', 'Priya');
    const room = await newRoom(A, B, C);
    const betAB = await challengeOk(A, B, room);
    const betAC = await challengeOk(A, C, room);
    // betAC: the judge read terms back and nobody confirmed (no lock built yet).
    await ctx.deps.db.update(bets).set({ state: 'TERMS_PROPOSED' }).where(eq(bets.id, betAC));

    t += 3 * 60_000;
    expect((await post(B, `/v1/bets/${betAB}/invite/accept`)).status).toBe(200); // an event at t

    t += 2 * 60_000 + 1_000; // 5:01 after the challenge, 2:01 after the accept
    expect(await sweep(room)).toEqual({ expired: [betAC], skipped: 0 });
    expect((await events(betAC)).at(-2)!.envelope).toMatchObject({
      payload: { state: 'EXPIRED', prev: 'TERMS_PROPOSED', reason: 'draft_idle' },
    });
    expect((await betRow(betAB)).state).toBe('DRAFTING');

    t += 3 * 60_000; // 5:01 after the accept
    expect(await sweep(room)).toEqual({ expired: [betAB], skipped: 0 });
  });

  it('frees the 3-open-bets cap (§1.7)', async () => {
    const [A, B, C, D, E] = await users('Logan', 'Jake', 'Priya', 'Sam', 'Ana');
    const room = await newRoom(A, B, C, D, E);
    const open = [
      await challengeOk(A, B, room),
      await challengeOk(A, C, room),
      await challengeOk(A, D, room),
    ];
    const capped = await challenge(A, E, room);
    expect([capped.status, capped.json!.error.details.reason]).toEqual([429, 'too_many_open_bets']);
    t += DRAFT_IDLE_MS + 1_000;
    const r = await sweep(room);
    expect(r.expired.sort()).toEqual([...open].sort());
    await challengeOk(A, E, room);
  });

  it('leaves non-draft states alone', async () => {
    const [A, B] = await users('Logan', 'Jake');
    const room = await newRoom(A, B);
    const betId = await challengeOk(A, B, room);
    expect((await post(B, `/v1/bets/${betId}/invite/decline`)).status).toBe(200);
    const before = await betRow(betId);
    t += DRAFT_IDLE_MS * 3;
    expect(await sweep(room)).toEqual({ expired: [], skipped: 0 });
    const after = await betRow(betId);
    expect([after.state, after.end_reason, after.version]).toEqual([
      'CANCELLED',
      'declined',
      before.version,
    ]);
  });

  it('is safe under concurrent sweepers and skips a row locked elsewhere (SKIP LOCKED)', async () => {
    const [A, B, C, D, E, F] = await users('Logan', 'Jake', 'Priya', 'Sam', 'Ana', 'Lee');
    const room = await newRoom(A, B, C, D, E, F);
    const ids = [
      await challengeOk(A, B, room),
      await challengeOk(A, C, room),
      await challengeOk(A, D, room),
      await challengeOk(E, F, room),
    ];
    t += DRAFT_IDLE_MS + 1_000;

    // Hold one bet's row lock in another transaction (a request mid-flight).
    const held = ids[3]!;
    const gate = deferred();
    const locked = deferred();
    const holder = ctx.deps.db.transaction(async (tx) => {
      await tx.select().from(bets).where(eq(bets.id, held)).for('update');
      locked.resolve();
      await gate.promise;
    });
    await locked.promise;

    const [r1, r2] = await Promise.all([sweep(room), sweep(room)]);
    const all = [...r1.expired, ...r2.expired];
    expect(new Set(all).size).toBe(all.length); // no bet expired twice
    expect(all.sort()).toEqual(ids.slice(0, 3).sort());
    expect((await betRow(held)).state).toBe('DRAFTING');

    gate.resolve();
    await holder;
    expect(await sweep(room)).toEqual({ expired: [held], skipped: 0 });

    for (const id of ids) {
      const st = (await events(id)).filter(
        (e) => e.type === 'bet.state' && (e.envelope as any).payload.state === 'EXPIRED',
      );
      expect(st).toHaveLength(1);
    }
  });

  it('respects `limit` and an empty room scope', async () => {
    const [A, B, C] = await users('Logan', 'Jake', 'Priya');
    const room = await newRoom(A, B, C);
    await challengeOk(A, B, room);
    await challengeOk(A, C, room);
    t += DRAFT_IDLE_MS + 1_000;
    expect(await sweep([])).toEqual({ expired: [], skipped: 0 });
    expect((await sweep(room, { limit: 1 })).expired).toHaveLength(1);
    expect((await sweep(room, { limit: 1 })).expired).toHaveLength(1);
    expect((await sweep(room)).expired).toHaveLength(0);
  });
});

describeDb('keeper wiring (createDeps / startServer)', () => {
  it('is off under NODE_ENV=test by default; when on, startServer starts it and close() stops it', async () => {
    const off = createDeps({ env: testEnv(), dbHandle: createDb({ url: DB_URL!, max: 1 }) });
    expect(off.deps.keeper).toBeUndefined();
    await off.dbHandle.close();

    const dbHandle = createDb({ url: DB_URL!, max: 2 });
    const { deps } = createDeps({ env: testEnv(), dbHandle, rateLimit: false, keeper: true });
    expect(deps.keeper?.taskNames).toEqual([
      'draft-idle',
      'lock-sweep',
      'finalize-due',
      'resolve-due',
      'stream-gaps', // the best-effort RPC poller runs after every money sweep
    ]);
    expect(deps.keeper?.isStarted).toBe(false);
    const running = await startServer(deps, {
      port: 0,
      hostname: '127.0.0.1',
      modules: routeModules,
      onClose: () => dbHandle.close(),
    });
    expect(deps.keeper?.isStarted).toBe(true);
    await running.close();
    expect(deps.keeper?.isStarted).toBe(false);
  });

  it("the chain sweeps run on the routes' lifecycle (one LockService / PayoutService per server)", async () => {
    const dbHandle = createDb({ url: DB_URL!, max: 2 });
    try {
      const { deps } = createDeps({ env: testEnv(), dbHandle, rateLimit: false, keeper: true });
      // what the routes use: lifecycleOf(deps), the same object createServerKeeper got
      const lc = installLifecycle(deps, createLifecycle(deps, { runtime: async () => null }));
      const sweep = vi.spyOn(lc.lock, 'sweep');
      const finalizeDue = vi.spyOn(lc.payout, 'finalizeDue');
      const runtime = vi.spyOn(lc, 'runtime');
      await deps.keeper!.tick();
      // a copy of deps would have built a second lifecycle: separate `confirming` /
      // `finalizing` guards and timers, so a sweep could race the routes' own confirm
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(finalizeDue).toHaveBeenCalledTimes(1);
      expect(runtime).toHaveBeenCalled(); // stream-gaps asked the same lifecycle for its runtime
      expect(lifecycleOf(deps)).toBe(lc);
    } finally {
      await dbHandle.close();
    }
  });
});
