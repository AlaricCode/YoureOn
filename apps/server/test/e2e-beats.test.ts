/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies and WS frames are loosely typed in tests */
// Beats 2 -> 4 end to end ACROSS the slices (lock + payout, judge, stage fan-out, the phones'
// shared device policy), over the real HTTP app + WS hub + Postgres + LiteSVM running the real
// escrow.so. Nothing here calls a slice's service directly: every step is a request a phone, the
// judge cam, the voice agent's demo sink or the operator would send, and the judge pipeline's
// deps.onRuling (src/server.ts) is what sends `resolve`.
//
//   signup A + B (wallets = the runtime's demo-a / demo-b keys) -> room -> list challenge ->
//   accept -> fixture terms (/v1/demo/bets/:id/terms) -> confirm -> LOCKED
//     (LOCK_SIGNER=server: custodial; phones: both run the device policy on the stored bytes,
//      sign them, POST /lock/authorizations)
//   -> A's judge-cam device (a second device of A, §2.9) -> POST attempts -> 8-12 JPEG frames
//   -> MockLlm verdict -> ruling.issued -> deps.onRuling -> resolve on chain -> RULED
//   -> finalize after the appeal window, or the loser's GG (GET/POST /concede) -> PAID
//   plus a REDO (disagreeing bottle check) then a decisive second attempt.
// The WS frames each phone (bet channel) and the stage (room channel) receive are asserted in
// order against bet_events. Finally scripts/cp1-drive.ts --through paid drives the same path.
//
// This suite runs in its OWN database (<DATABASE_URL db>_e2e, created + migrated here): it owns
// nonce_pool, as lifecycle.test.ts does in the shared one, and vitest runs files in parallel.
// Skips without DATABASE_URL or without programs/escrow/target/deploy/escrow.so.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ed from '@noble/ed25519';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  getBase58Decoder,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  attempts,
  betEvents,
  bets,
  createDb,
  devices,
  noncePool,
  roomMembers,
  rulings,
  runMigrations,
} from '@youre-on/db';
import {
  authChallengeMessage,
  requestSigningString,
  SignRequest,
  type Session,
} from '@youre-on/shared/api';
import { AuthorizeRequest } from '@youre-on/shared/authorization';
import { TOKEN_PROGRAM_ID } from '@youre-on/shared/chain/constants';
import {
  checkDevicePolicy,
  type DevicePolicyDerivations,
  type DevicePolicyPins,
} from '@youre-on/shared/device-policy';
import {
  BetStatus,
  ESCROW_PROGRAM_ADDRESS,
  findBetPda,
  findConfigPda,
  findEventAuthorityPda,
  findVaultPda,
  getBetDecoder,
} from '@youre-on/shared/escrow-client';
import { hashJcs } from '@youre-on/shared/jcs';
import { betIdToBytes, sha256Hex } from '@youre-on/shared/primitives';
import { parseRealtimeEvent } from '@youre-on/shared/realtime';
import { CACHED_RULING_MODEL, isCachedRuling, Ruling } from '@youre-on/shared/ruling';
import { renderSignCard } from '@youre-on/shared/sign-card';
import {
  createPoolNonce,
  HAVE_SO,
  newEnv,
  send,
  setNow,
  tokenAmount,
  USDC,
  type Env as SvmEnv,
} from '../../../packages/shared/test/escrow/harness';
import type { ChainRuntime } from '../src/chain/tx';
import { judgeRoutes } from '../src/judge/routes';
import { createLifecycle, installLifecycle, type Lifecycle } from '../src/lock/runtime';
import { MockLlm, type MockReply } from '../src/providers/mock/llm';
import { liteSvmClient } from './litesvm-client';
import {
  b64,
  b64url,
  connectWs,
  DB_URL,
  getChallenge,
  newKey,
  postJson,
  signedHeaders,
  signupBody,
  startTestServer,
  type Ctx,
  type SignedUp,
  type TestKey,
  type WsClient,
} from './helpers';

const run = DB_URL && HAVE_SO ? describe : describe.skip;
const ADMIN = 'demo-admin-token-for-e2e';
const STAGE_KEY = 'stage-key-for-e2e';
const b58 = getBase58Decoder();

/** A database of our own next to DATABASE_URL's, created and migrated on first use. */
async function ownDatabase(url: string, suffix: string): Promise<string> {
  const u = new URL(url);
  const name = `${u.pathname.replace(/^\//, '')}_${suffix}`;
  if (!/^[a-z0-9_]{1,63}$/.test(name)) throw new Error(`unsupported database name ${name}`);
  const admin = createDb({ url, max: 1 });
  try {
    const found = await admin.db.execute(
      sql`SELECT 1 AS ok FROM pg_database WHERE datname = ${name}`,
    );
    if (found.length === 0) {
      try {
        await admin.db.execute(sql.raw(`CREATE DATABASE ${name}`));
      } catch (e) {
        const code =
          (e as { code?: string; cause?: { code?: string } }).code ??
          (e as { cause?: { code?: string } }).cause?.code;
        if (code !== '42P04') throw e; // duplicate_database: a concurrent run made it
      }
    }
  } finally {
    await admin.close();
  }
  u.pathname = `/${name}`;
  await runMigrations(u.toString());
  return u.toString();
}

/** A small JPEG-looking frame (SOI/APP0 ... EOI): the server checks the magic and the hash. */
const jpeg = (i: number) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(48), i & 0xff, 0xff, 0xd9]);

/** Bottle-flip verdicts (the judge's structured output). */
const verdict = (o: {
  result: 'MET' | 'NOT_MET';
  upright: boolean;
  confidence?: number;
}): MockReply => ({
  value: {
    claim_result: o.result,
    confidence: o.confidence ?? 0.93,
    reason:
      o.result === 'MET'
        ? 'Full turn, lands on its base in frame 7 and stays put.'
        : 'It tips onto its side in frame 6.',
    cited_frames: [5, 6, 7],
    contested: false,
    checks: { cap_tape_visible: true, bottle_upright_at_rest: o.upright },
  },
});
const MET = verdict({ result: 'MET', upright: true });
const NOT_MET = verdict({ result: 'NOT_MET', upright: false });
/** The model says MET but its own check says the bottle is not upright: REDO 'unclear'. */
const DISAGREEING = verdict({ result: 'MET', upright: false });

run('e2e Beats 2 -> 4 across slices (HTTP + WS + LiteSVM)', () => {
  let ctx: Ctx;
  let svm: SvmEnv;
  let rt: ChainRuntime;
  let lc: Lifecycle;
  let offset = 0;
  const now = () => Date.now() + offset;
  let keyA: TestKey;
  let keyB: TestKey;
  let signerA: KeyPairSigner;
  let signerB: KeyPairSigner;
  let A: SignedUp;
  let B: SignedUp;
  let C: SignedUp; // a third room member, not in any bet
  let CAM: SignedUp; // A's second device, the judge cam
  let roomId: string;
  let replies: MockReply[] = [];
  let llm: MockLlm;
  const sockets: WsClient[] = [];
  let wsA: WsClient;
  let wsB: WsClient;
  let wsStage: WsClient;
  let wsCam: WsClient;
  let signerMode: 'phones' | 'server' = 'phones';

  const install = (signer: 'phones' | 'server') => {
    signerMode = signer;
    lc = installLifecycle(
      ctx.deps,
      createLifecycle(ctx.deps, {
        runtime: async () => rt,
        signer,
        send: { pollMs: 5, resendMs: 50, timeoutMs: 2_000 },
        timers: false,
      }),
    );
  };

  /** Moves the server clock and the SVM clock together. */
  const advance = (ms: number) => {
    offset += ms;
    setNow(svm.svm, BigInt(Math.floor(now() / 1000)));
  };

  /** Every background job of every slice has settled (judge job -> onRuling -> resolve, sends). */
  const settle = async () => {
    await judgeRoutes.idle();
    await lc.idle();
  };

  beforeAll(async () => {
    const dbUrl = await ownDatabase(DB_URL!, 'e2e');
    ctx = await startTestServer({
      now,
      env: {
        DATABASE_URL: dbUrl,
        DEMO_MODE: 'true',
        DEMO_ADMIN_TOKEN: ADMIN,
        STAGE_KEY,
        CACHED_RULING: 'false',
      },
    });
    llm = new MockLlm(() => replies.shift() ?? { fail: 'error', message: 'no scripted verdict' });
    ctx.deps.providers.llm = llm;
    svm = await newEnv();
    setNow(svm.svm, BigInt(Math.floor(now() / 1000)));
    keyA = newKey();
    keyB = newKey();
    signerA = await createKeyPairSignerFromPrivateKeyBytes(keyA.secret);
    signerB = await createKeyPairSignerFromPrivateKeyBytes(keyB.secret);
    for (const owner of [signerA, signerB]) await fund(owner);
    for (const k of [0, 1, 2]) await createPoolNonce(svm, k);
    rt = {
      client: liteSvmClient(svm.svm),
      keys: {
        feePayer: svm.s,
        judge: svm.judge,
        appeal: svm.appeal,
        treasury: null,
        // The wallets A and B sign up with ARE the custodial demo-a / demo-b keys (decision D-A).
        demoA: signerA,
        demoB: signerB,
      },
      mint: svm.mint,
      programId: ESCROW_PROGRAM_ADDRESS,
      cluster: 'localnet',
    };
    await ctx.deps.db.delete(noncePool); // this database's pool = the SVM's pool
    (ctx.deps.env as { USDC_MINT?: string }).USDC_MINT = svm.mint;
    install('phones');

    A = await signUpWith('Logan', keyA);
    B = await signUpWith('Jake', keyB);
    C = await signUpWith('Carol', newKey());
    const room = await signed(A, 'POST', '/v1/rooms', { name: 'E2E room', kind: 'session' });
    expect(room.status).toBe(201);
    roomId = room.json!.room_id;
    expect((await signed(B, 'POST', '/v1/rooms/join', { code: room.json!.code })).status).toBe(200);
    // C is no demo account: under DEMO_MODE the demo room (A's) refuses it (demo/players.ts), so
    // this third member, whose cam must never record, is put in the room directly.
    const cJoin = await signed(C, 'POST', '/v1/rooms/join', { code: room.json!.code });
    expect(cJoin.json!.error).toMatchObject({
      code: 'NOT_IN_ROOM',
      details: { reason: 'demo_room' },
    });
    await ctx.deps.db
      .insert(roomMembers)
      .values({ room_id: roomId, user_id: C.session.user.user_id, joined_via: 'code' });

    // The judge-cam iPhone: a fresh device key registered as a second device of A (demo op),
    // signed in like any registered device, then bound to the room by itself.
    CAM = await secondDeviceOf(A);
    await bindCam(CAM);

    // Sockets: both phones (user channel; bet channel once a bet exists), the cam, the stage.
    wsA = await phoneWs(A);
    wsB = await phoneWs(B);
    wsCam = await phoneWs(CAM);
    const st = await postJson(ctx.base, '/v1/stage/session', {
      stage_key: STAGE_KEY,
      room_id: roomId,
    });
    expect(st.status).toBe(201);
    wsStage = await connectWs(ctx.wsUrl);
    sockets.push(wsStage);
    wsStage.send({ op: 'hello', token: st.json!.token, subs: [] });
    await wsStage.next((f) => f.op === 'welcome');
    wsStage.send({ op: 'subscribe_room', room_id: roomId });
    await new Promise((r) => setTimeout(r, 100)); // subscribe_room is handled async
  }, 60_000);

  afterAll(async () => {
    for (const s of sockets) s.close();
    await judgeRoutes.idle();
    await lc?.idle();
    lc?.stop();
    await ctx?.server.close();
  });

  // ---- HTTP helpers --------------------------------------------------------------------

  async function signUpWith(name: string, wallet: TestKey): Promise<SignedUp> {
    const device = newKey();
    const ch = await getChallenge(ctx.base, device);
    const r = await postJson(
      ctx.base,
      '/v1/auth/signup',
      signupBody(ch, device, wallet, { display_name: name }),
    );
    if (r.status !== 201) throw new Error(`signup ${r.status} ${JSON.stringify(r.json)}`);
    return { device, wallet, session: r.json as unknown as Session };
  }

  async function secondDeviceOf(u: SignedUp, o: { viaDb?: boolean } = {}): Promise<SignedUp> {
    const device = newKey();
    let deviceId: string;
    if (o.viaDb) {
      // Not a demo account: the demo op refuses it (a leaked admin key must not add a device to
      // a real account), so the device goes straight into the table.
      const refused = await admin(`/v1/demo/users/${u.session.user.user_id}/devices`, {
        device_pubkey: device.pubkey,
      });
      expect(refused.status).toBe(409);
      const [d] = await ctx.deps.db
        .insert(devices)
        .values({ user_id: u.session.user.user_id, platform: 'ios', device_pubkey: device.pubkey })
        .returning({ id: devices.id });
      deviceId = d!.id;
    } else {
      const reg = await admin(`/v1/demo/users/${u.session.user.user_id}/devices`, {
        device_pubkey: device.pubkey,
      });
      expect(reg.status).toBe(201);
      // idempotent for the same user
      expect(
        (
          await admin(`/v1/demo/users/${u.session.user.user_id}/devices`, {
            device_pubkey: device.pubkey,
          })
        ).json,
      ).toEqual(reg.json);
      deviceId = reg.json!.device_id;
    }
    const ch = await getChallenge(ctx.base, device);
    const login = await postJson(ctx.base, '/v1/auth/session', {
      challenge_id: ch.challenge_id,
      device_pubkey: device.pubkey,
      device_sig: b64(
        device.sign(
          authChallengeMessage({
            purpose: 'login',
            nonce: ch.nonce,
            device_pubkey: device.pubkey,
            wallet_pubkey: null,
          }),
        ),
      ),
    });
    expect(login.status).toBe(200);
    const session = login.json as unknown as Session;
    expect(session.user.user_id).toBe(u.session.user.user_id);
    expect(session.device_id).toBe(deviceId);
    return { device, wallet: u.wallet, session };
  }

  const signed = (u: SignedUp, method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return fetch(ctx.base + path, {
      method,
      headers: signedHeaders(u, method, path, raw, { ts: now() }),
      body: raw || undefined,
    }).then(async (res) => {
      const text = await res.text();
      return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
    });
  };
  const get = async (u: SignedUp, path: string) => {
    const res = await fetch(ctx.base + path, {
      headers: { Authorization: `Bearer ${u.session.token}` },
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  const admin = (path: string, body: unknown = {}) =>
    postJson(ctx.base, path, body, { 'X-YO-Demo-Key': ADMIN });
  const betRow = async (id: string) =>
    (await ctx.deps.db.select().from(bets).where(eq(bets.id, id)).limit(1))[0]!;
  const dbEvents = async (id: string) =>
    ctx.deps.db
      .select({ seq: betEvents.seq, type: betEvents.type, envelope: betEvents.envelope })
      .from(betEvents)
      .where(eq(betEvents.bet_id, id))
      .orderBy(asc(betEvents.seq));

  async function bindCam(cam: SignedUp) {
    const r = await signed(cam, 'PATCH', '/v1/devices/current', {
      role: 'judge_cam',
      room_id: roomId,
    });
    expect(r.status).toBe(204);
  }

  async function phoneWs(u: SignedUp): Promise<WsClient> {
    const ws = await connectWs(ctx.wsUrl);
    sockets.push(ws);
    ws.send({ op: 'hello', token: u.session.token, device_id: u.session.device_id, subs: [] });
    await ws.next((f) => f.op === 'welcome');
    return ws;
  }

  /** The judge cam's signed multipart upload (CameraEvidence + n JPEGs), hashes computed here. */
  async function uploadFrames(betId: string, attemptNo: number, n: number) {
    const frames = Array.from({ length: n }, (_, i) => jpeg(i));
    const clip = sha256Hex(Buffer.concat(frames));
    const evidence = {
      schema_version: 1,
      kind: 'camera',
      bet_id: betId,
      attempt_no: attemptNo,
      clip_sha256: clip,
      clip_bytes: 2_081_133,
      mime: 'video/quicktime',
      duration_ms: 4200,
      recorded_by: 'A', // the judge cam is a device of A
      recorded_at: new Date(now()).toISOString(),
      frames: frames.map((f, i) => ({ index: i, t_ms: 1200 + i * 250, sha256: sha256Hex(f) })),
    };
    const form = new FormData();
    form.append('evidence', new Blob([JSON.stringify(evidence)], { type: 'application/json' }));
    frames.forEach((f, i) =>
      form.append(
        'frame',
        new Blob([f as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }),
        `${i}.jpg`,
      ),
    );
    const req = new Request('http://x/', { method: 'POST', body: form });
    const body = new Uint8Array(await req.arrayBuffer());
    const path = `/v1/bets/${betId}/attempts/${attemptNo}/frames`;
    const ts = String(now());
    const idem = randomUUID();
    const sig = CAM.device.sign(
      requestSigningString({
        method: 'POST',
        path_and_query: path,
        timestamp_ms: ts,
        idempotency_key: idem,
        session_id: CAM.session.session_id,
        body_sha256_hex: sha256Hex(body),
      }),
    );
    const res = await fetch(ctx.base + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CAM.session.token}`,
        'X-YO-Device': CAM.session.device_id,
        'X-YO-Timestamp': ts,
        'Idempotency-Key': idem,
        'X-YO-Signature': b64url(sig),
        'Content-Type': req.headers.get('content-type')!,
      },
      body,
    });
    const json = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(202);
    expect(json.frame_hashes).toEqual(frames.map((f) => sha256Hex(f)));
    return { frames, evidence };
  }

  // ---- chain helpers -------------------------------------------------------------------

  async function findAta(owner: Address) {
    const [ata] = await findAssociatedTokenPda({
      owner,
      mint: svm.mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    return ata;
  }
  async function fund(owner: KeyPairSigner) {
    await send(svm.svm, svm.s, [
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: svm.s,
        owner: owner.address,
        mint: svm.mint,
      }),
      getMintToCheckedInstruction({
        mint: svm.mint,
        token: await findAta(owner.address),
        mintAuthority: svm.s,
        amount: 100n * USDC,
        decimals: 6,
      }),
    ]);
  }
  const usdc = async (owner: Address) => tokenAmount(svm.svm, (await findAta(owner)) as never);
  const onchainBet = async (betId: string) => {
    const [pda] = await findBetPda({ betId: betIdToBytes(betId) });
    const acc = svm.svm.getAccount(pda);
    return acc.exists ? getBetDecoder().decode(acc.data) : null;
  };

  /** What a phone compiles in (G1), with this SVM's fee payer and mint in place of devnet's. */
  const pins = (): DevicePolicyPins => ({
    feePayer: svm.s.address,
    programId: ESCROW_PROGRAM_ADDRESS,
    mint: svm.mint,
    tokenProgram: TOKEN_PROGRAM_ID,
    // The Terms name the server's SOLANA_CLUSTER (devnet in the test env) even over LiteSVM.
    cluster: ctx.deps.env.SOLANA_CLUSTER,
  });
  /** The phone's PDA / ATA derivations (Kit here; noble on the phone), precomputed per bet. */
  async function derivations(betId: string): Promise<DevicePolicyDerivations> {
    const idBytes = betIdToBytes(betId);
    const [bet] = await findBetPda({ betId: idBytes });
    const [vault] = await findVaultPda({ betId: idBytes });
    const [config] = await findConfigPda();
    const [eventAuthority] = await findEventAuthorityPda();
    const atas = new Map<string, string>();
    for (const o of [signerA.address, signerB.address]) atas.set(o, await findAta(o));
    return {
      betPdas: (id) => {
        if (id !== betId) throw new Error(`no PDAs for ${id}`);
        return { bet, vault, config };
      },
      eventAuthority: () => eventAuthority,
      associatedTokenAddress: (owner, mint) => {
        const ata = atas.get(owner);
        if (!ata || mint !== svm.mint) throw new Error('no ATA');
        return ata;
      },
    };
  }

  // ---- WS helpers ----------------------------------------------------------------------

  /** Bet envelopes a socket received for `betId`, in arrival order. */
  const received = (ws: WsClient, betId: string) =>
    ws.frames.filter((f) => f.bet_id === betId && typeof f.seq === 'number' && !f.op);

  /** Waits until every phone saw the bet's last seq. */
  async function phonesCaughtUp(betId: string) {
    const last = (await betRow(betId)).last_seq;
    await expect
      .poll(() => Math.min(...[wsA, wsB].map((w) => received(w, betId).at(-1)?.seq ?? 0)))
      .toBe(last);
    return last;
  }

  /** `bet.state:<STATE>`, `judge.cue:<CUE>`, else the event type. */
  const label = (f: { type: string; payload?: any }) =>
    f.type === 'bet.state'
      ? `bet.state:${f.payload.state}`
      : f.type === 'judge.cue'
        ? `judge.cue:${f.payload.cue}`
        : f.type;
  /**
   * The payout "processed" frame (bet.state CONCEDED/FINALIZED again, reason 'processed') races the
   * confirm on LiteSVM, where both land at once: it is left out of the pinned order.
   */
  const pinned = (frames: { type: string; payload?: any }[]) =>
    frames.filter((f) => !(f.type === 'bet.state' && f.payload.reason === 'processed')).map(label);

  /**
   * What each phone (bet channel, subscribed right after the challenge) and the stage (room
   * channel, subscribed before the bet existed) received for `betId`: every bet_events row exactly
   * once, in seq order, each a valid RealtimeEvent, and in the order `expected` pins.
   */
  async function expectFanout(betId: string, expected: string[]) {
    await phonesCaughtUp(betId);
    const db = await dbEvents(betId);
    expect(pinned(db.map((e) => e.envelope as any))).toEqual(expected);
    for (const [who, ws] of [
      ['A', wsA],
      ['B', wsB],
      ['stage', wsStage],
    ] as const) {
      const got = received(ws, betId);
      expect(
        got.map((f) => f.seq),
        `${who} seqs`,
      ).toEqual(db.map((e) => e.seq));
      expect(got.map(label), `${who} order`).toEqual(db.map((e) => label(e.envelope as any)));
      for (const f of got) expect(parseRealtimeEvent(f).ok, `${who}: ${f.type} parses`).toBe(true);
    }
  }

  // ---- the shared Beat 2-3 path ---------------------------------------------------------

  /** Room challenge -> accept -> fixture terms -> confirm -> LOCKED (both phones subscribed). */
  async function lockedBet(o: { terms?: Record<string, unknown> } = {}): Promise<string> {
    const bet = await signed(A, 'POST', '/v1/bets', {
      room_id: roomId,
      opponent_user_id: B.session.user.user_id,
      challenge_method: 'list',
    });
    expect(bet.status).toBe(201);
    const betId = bet.json!.bet.bet_id as string;
    // B hears about it on the user channel (bet.invited); like the app, each phone then
    // subscribes from the last seq it already holds, so nothing arrives twice.
    await wsB.next((f) => f.type === 'bet.invited' && f.bet_id === betId);
    await new Promise((r) => setTimeout(r, 50));
    for (const ws of [wsA, wsB])
      ws.send({
        op: 'subscribe',
        bet_id: betId,
        after_seq: received(ws, betId).at(-1)?.seq ?? 0,
      });
    await wsA.next((f) => f.op === 'subscribed' && f.bet_id === betId);
    await wsB.next((f) => f.op === 'subscribed' && f.bet_id === betId);
    expect((await signed(B, 'POST', `/v1/bets/${betId}/invite/accept`)).status).toBe(200);
    const terms = await admin(`/v1/demo/bets/${betId}/terms`, o.terms ?? {});
    expect(terms.json).toMatchObject({ ok: true, state: 'TERMS_PROPOSED' });
    expect((await admin(`/v1/demo/bets/${betId}/confirm`)).json).toMatchObject({ ok: true });
    await lc.idle();

    if (signerMode === 'phones') {
      expect((await betRow(betId)).state).toBe('AWAITING_AUTHORIZATIONS');
      const raw = (await get(A, `/v1/bets/${betId}/lock`)).json;
      expect((await get(B, `/v1/bets/${betId}/lock`)).json).toEqual(raw);
      // The same payload was pushed as terms.authorize_request (the card mounts from it).
      const pushed = await wsB.next(
        (f) => f.type === 'terms.authorize_request' && f.bet_id === betId,
      );
      expect(pushed.payload.request ?? pushed.payload).toMatchObject({
        lock_request_id: raw!.lock_request_id,
      });
      const req = AuthorizeRequest.parse(raw);
      const msg = new Uint8Array(Buffer.from(req.message_b64, 'base64'));
      const derive = await derivations(betId);
      for (const [party, u, key] of [
        ['B', B, keyB],
        ['A', A, keyA],
      ] as const) {
        // The phone's gate: the shared device policy on the exact bytes it is about to sign.
        const v = checkDevicePolicy(msg, {
          screen: 'terms_card',
          lockMode: 'atomic',
          request: raw,
          devicePubkey: u.wallet.pubkey,
          nowSecs: Math.floor(now() / 1000),
          derive,
          pins: pins(),
        });
        expect(v, `device policy (${party}): ${JSON.stringify(v)}`).toMatchObject({
          ok: true,
          kind: 'atomic_lock',
          party,
          bet_id: betId,
          terms_hash: req.envelope.terms_hash,
          message_sha256: req.message_sha256,
        });
        const r = await signed(u, 'POST', `/v1/bets/${betId}/lock/authorizations`, {
          bet_id: betId,
          lock_request_id: req.lock_request_id,
          party,
          terms_hash: req.envelope.terms_hash,
          method: 'faceid_hold',
          authorized_at: new Date(now()).toISOString(),
          ms_since_auth_success: 90,
          message_sha256: req.message_sha256,
          party_signature: b58.decode(ed.sign(msg, key.secret)),
        });
        expect(r.status).toBe(202);
      }
      await lc.idle();
    }
    const row = await betRow(betId);
    expect(row.state).toBe('LOCKED');
    expect((await onchainBet(betId))!.status).toBe(BetStatus.Locked);
    return betId;
  }

  /** A's phone starts attempt n; the judge cam is A's second device. */
  async function startAttempt(betId: string, n: number) {
    const r = await signed(A, 'POST', `/v1/bets/${betId}/attempts`, {
      attempt_no: n,
      recorder: 'judge_cam',
    });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({
      attempt_no: n,
      performer: 'B',
      recorder_device_id: CAM.session.device_id,
    });
    // The cam learns about it on its user channel (it never subscribed to the bet).
    await wsCam.next(
      (f) => f.type === 'attempt.started' && f.bet_id === betId && f.payload.attempt_no === n,
    );
  }

  /** attempt n -> frames -> the scripted verdict -> ruling.issued (+ onRuling for decisive). */
  async function judged(betId: string, n: number, reply: MockReply, frames: number) {
    await startAttempt(betId, n);
    replies = [reply];
    const calls0 = llm.calls.length;
    const up = await uploadFrames(betId, n, frames);
    await settle();
    expect(llm.calls.length - calls0).toBe(1);
    const issued = await wsA.next(
      (f) => f.type === 'ruling.issued' && f.bet_id === betId && f.payload.ruling.attempt_no === n,
    );
    const ruling = Ruling.parse(issued.payload.ruling);
    expect(issued.payload.ruling_hash).toBe(hashJcs(ruling));
    expect(ruling).toMatchObject({
      attempt_no: n,
      frame_hashes: up.frames.map((f) => sha256Hex(f)),
      evidence_hash: up.evidence.clip_sha256,
      terms_hash: (await betRow(betId)).terms_hash,
    });
    return { ruling, ruling_hash: issued.payload.ruling_hash as string };
  }

  /** The decisive ruling went on chain through deps.onRuling: RULED, Resolved, same hashes. */
  async function expectRuled(betId: string, r: { ruling: Ruling; ruling_hash: string }) {
    const row = await betRow(betId);
    expect(row).toMatchObject({
      state: 'RULED',
      outcome: r.ruling.outcome === 'A_WINS' ? 'party_a' : 'party_b',
      ruling_hash: r.ruling_hash,
      evidence_hash: r.ruling.evidence_hash,
    });
    const onchain = await onchainBet(betId);
    expect(onchain!.status).toBe(BetStatus.Resolved);
    expect(Buffer.from(onchain!.rulingHash).toString('hex')).toBe(r.ruling_hash);
    expect(Buffer.from(onchain!.evidenceHash).toString('hex')).toBe(r.ruling.evidence_hash);
    const [stored] = await ctx.deps.db
      .select()
      .from(rulings)
      .where(eq(rulings.id, r.ruling.ruling_id));
    expect(stored).toMatchObject({ ruling_hash: r.ruling_hash, outcome: r.ruling.outcome });
    return row;
  }

  async function finalizeAfterWindow(betId: string) {
    expect(await lc.payout.finalizeDue(now())).not.toContain(betId); // appeal window open
    advance(12_000);
    expect(await lc.payout.finalizeDue(now())).toContain(betId);
    await lc.idle();
    expect(await betRow(betId)).toMatchObject({ state: 'PAID', payout_via: 'finalize' });
    expect(await onchainBet(betId)).toBeNull(); // close_bet closed it
  }

  async function concede(
    betId: string,
    loser: 'A' | 'B',
    r: { ruling: Ruling; ruling_hash: string },
    o: { custodial?: boolean } = {},
  ) {
    const [u, key, ws] = loser === 'A' ? [A, keyA, wsA] : [B, keyB, wsB];
    const winner = loser === 'A' ? B : A;
    expect((await get(winner, `/v1/bets/${betId}/concede`)).json!.error.code).toBe('NOT_LOSER');
    if (o.custodial) {
      // LOCK_SIGNER=server: the GG tap carries no signature; the server signs as demo-<loser>.
      const post = await signed(u, 'POST', `/v1/bets/${betId}/concede`, {
        bet_id: betId,
        kind: 'concede',
        party: loser,
        method: 'faceid_hold',
        signed_at: new Date(now()).toISOString(),
      });
      expect(post.status).toBe(202);
    } else {
      // The loser's phone got the GG prompt pushed (tx.sign_request) right after RULED.
      const pushed = await ws.next((f) => f.type === 'tx.sign_request' && f.bet_id === betId);
      const g = await get(u, `/v1/bets/${betId}/concede`);
      expect(g.status).toBe(200);
      // Same bytes as the push (only issued_at is re-stamped per read).
      expect({ ...g.json, issued_at: null }).toEqual({
        ...pushed.payload.request,
        issued_at: null,
      });
      const req = SignRequest.parse(g.json);
      const msg = new Uint8Array(Buffer.from(req.message_b64, 'base64'));
      const row = await betRow(betId);
      // The phone's GG gate: the card it renders itself, the ruling it verified over WS.
      const v = checkDevicePolicy(msg, {
        screen: 'gg',
        request: g.json,
        renderedCard: renderSignCard({
          kind: 'concede',
          terms: req.envelope.terms,
          terms_hash: req.envelope.terms_hash,
          me: loser,
          appeal_deadline: Math.floor(row.appeal_deadline!.getTime() / 1000),
        }),
        verifiedRulingHash: r.ruling_hash,
        verifiedRulingOutcome: r.ruling.outcome,
        devicePubkey: u.wallet.pubkey,
        nowSecs: Math.floor(now() / 1000),
        derive: await derivations(betId),
        pins: pins(),
      });
      expect(v, `GG device policy: ${JSON.stringify(v)}`).toMatchObject({
        ok: true,
        kind: 'concede',
        party: loser,
      });
      const post = await signed(u, 'POST', `/v1/bets/${betId}/concede`, {
        bet_id: betId,
        kind: 'concede',
        party: loser,
        message_sha256: req.message_sha256,
        party_signature: b58.decode(ed.sign(msg, key.secret)),
        method: 'faceid_hold',
        signed_at: new Date(now()).toISOString(),
      });
      expect(post.status).toBe(202);
    }
    await lc.idle();
    expect(await betRow(betId)).toMatchObject({ state: 'PAID', payout_via: 'concede' });
    expect(await onchainBet(betId)).toBeNull();
  }

  // ---- the pinned event order (bet_events = each phone's bet channel = the stage) ----------

  /** Beats 2-3: challenge -> accept -> terms -> confirm -> both authorizations -> LOCKED. */
  const TO_LOCKED = (signer: 'phones' | 'server') => [
    'bet.invited',
    'bet.state:DRAFTING',
    'bet.invite_answered',
    'terms.proposed',
    'bet.state:TERMS_PROPOSED',
    'bet.state:AWAITING_AUTHORIZATIONS',
    'terms.proposed', // the frozen (final) envelope
    ...(signer === 'phones' ? ['terms.authorize_request'] : []),
    'terms.authorized',
    'judge.cue:AUTHORIZED',
    'terms.authorized',
    'judge.cue:AUTHORIZED',
    'bet.state:AWAITING_LOCK',
    'tx.submitted',
    'bet.state:LOCKED',
    'tx.confirmed',
    'judge.cue:LOCKED',
  ];
  /** Beat 4 up to the ruling: request_attempt -> judge cam frames -> the vision verdict. */
  const ATTEMPT_TO_RULING = (cue: 'RULING' | 'REDO') => [
    'bet.state:ATTEMPT',
    'attempt.started',
    'judge.cue:ATTEMPT_ARMED',
    'bet.state:JUDGING',
    'attempt.evidence',
    'ruling.issued',
    `judge.cue:${cue}`,
  ];
  /** deps.onRuling -> resolve confirmed -> RULED (+ the loser's GG prompt with phones). */
  const RULED = (signer: 'phones' | 'server') => [
    'bet.state:RULED',
    'tx.confirmed',
    ...(signer === 'phones' ? ['tx.sign_request'] : []),
  ];
  const PAID_BY = (via: 'FINALIZED' | 'CONCEDED') => [
    `bet.state:${via}`,
    'tx.submitted',
    'bet.state:PAID',
    'tx.confirmed',
    'judge.cue:PAID',
  ];

  // ---- the beats -----------------------------------------------------------------------

  it('LOCK_SIGNER=server: custodial lock -> judge cam -> B_WINS -> resolve -> finalize -> PAID', async () => {
    install('server');
    try {
      const a0 = await usdc(signerA.address);
      const b0 = await usdc(signerB.address);
      const betId = await lockedBet();
      expect(await usdc(signerA.address)).toBe(a0 - 1n * USDC);

      // A judge cam of a non-party (a third user in the room) is never the recorder: the cam must
      // be a device of the non-performer (§2.9). That is why the driver registers a device of A.
      const camC = await secondDeviceOf(C, { viaDb: true });
      await signed(CAM, 'PATCH', '/v1/devices/current', { role: 'phone' });
      await bindCam(camC);
      const none = await signed(A, 'POST', `/v1/bets/${betId}/attempts`, {
        attempt_no: 1,
        recorder: 'judge_cam',
      });
      expect(none.json!.error).toMatchObject({
        code: 'INVALID_STATE',
        details: { reason: 'no_judge_cam' },
      });
      await signed(camC, 'PATCH', '/v1/devices/current', { role: 'phone' });
      await bindCam(CAM);

      const r = await judged(betId, 1, MET, 8);
      expect(r.ruling).toMatchObject({ outcome: 'B_WINS', claim_result: 'MET' });
      await expectRuled(betId, r);
      await finalizeAfterWindow(betId);
      expect(await usdc(signerB.address)).toBe(b0 + 1n * USDC);
      expect(await usdc(signerA.address)).toBe(a0 - 1n * USDC);

      await expectFanout(betId, [
        ...TO_LOCKED('server'),
        ...ATTEMPT_TO_RULING('RULING'),
        ...RULED('server'),
        ...PAID_BY('FINALIZED'),
      ]);
    } finally {
      install('phones');
    }
  });

  it('phones: device policy + signatures -> LOCKED -> A_WINS -> the loser GGs (policy) -> PAID', async () => {
    const a0 = await usdc(signerA.address);
    const b0 = await usdc(signerB.address);
    const betId = await lockedBet();
    const r = await judged(betId, 1, NOT_MET, 12);
    expect(r.ruling).toMatchObject({ outcome: 'A_WINS', claim_result: 'NOT_MET' });
    await expectRuled(betId, r);
    await concede(betId, 'B', r);
    expect(await usdc(signerA.address)).toBe(a0 + 1n * USDC);
    expect(await usdc(signerB.address)).toBe(b0 - 1n * USDC);

    await expectFanout(betId, [
      ...TO_LOCKED('phones'),
      ...ATTEMPT_TO_RULING('RULING'),
      ...RULED('phones'),
      ...PAID_BY('CONCEDED'),
    ]);
  });

  it('phones: REDO (the bottle check disagrees) -> attempt 2 -> B_WINS -> finalize -> PAID', async () => {
    const a0 = await usdc(signerA.address);
    const b0 = await usdc(signerB.address);
    const betId = await lockedBet();
    const redo = await judged(betId, 1, DISAGREEING, 10);
    expect(redo.ruling).toMatchObject({ outcome: 'REDO', redo_reason: 'unclear' });
    expect(await betRow(betId)).toMatchObject({ state: 'JUDGING', redo_count: 1 });
    expect((await onchainBet(betId))!.status).toBe(BetStatus.Locked); // REDO never goes on chain
    const cue = await wsB.next(
      (f) => f.type === 'judge.cue' && f.bet_id === betId && f.payload.cue === 'REDO',
    );
    expect(cue.payload.text).toMatch(/^\[EVENT\] REDO attempt=2 max=3/);

    const r = await judged(betId, 2, MET, 12);
    expect(r.ruling).toMatchObject({ outcome: 'B_WINS', attempt_no: 2 });
    await expectRuled(betId, r);
    await finalizeAfterWindow(betId);
    expect(await usdc(signerB.address)).toBe(b0 + 1n * USDC);
    expect(await usdc(signerA.address)).toBe(a0 - 1n * USDC);
    const atts = await ctx.deps.db
      .select({ n: attempts.attempt_no, status: attempts.status })
      .from(attempts)
      .where(eq(attempts.bet_id, betId))
      .orderBy(asc(attempts.attempt_no));
    expect(atts).toEqual([
      { n: 1, status: 'redo' },
      { n: 2, status: 'ruled' },
    ]);

    // REDO keeps the bet in JUDGING (no bet.state, nothing on chain) until attempt 2.
    await expectFanout(betId, [
      ...TO_LOCKED('phones'),
      ...ATTEMPT_TO_RULING('REDO'),
      ...ATTEMPT_TO_RULING('RULING'),
      ...RULED('phones'),
      ...PAID_BY('FINALIZED'),
    ]);
  });

  it('LOCK_SIGNER=server: custodial GG (no signature in the tap) -> PAID', async () => {
    install('server');
    try {
      const a0 = await usdc(signerA.address);
      const b0 = await usdc(signerB.address);
      const betId = await lockedBet();
      const r = await judged(betId, 1, MET, 8);
      await expectRuled(betId, r);
      await concede(betId, 'A', r, { custodial: true });
      expect(await usdc(signerB.address)).toBe(b0 + 1n * USDC);
      expect(await usdc(signerA.address)).toBe(a0 - 1n * USDC);
      await expectFanout(betId, [
        ...TO_LOCKED('server'),
        ...ATTEMPT_TO_RULING('RULING'),
        ...RULED('server'),
        ...PAID_BY('CONCEDED'),
      ]);
    } finally {
      install('phones');
    }
  });

  it('POST /v1/demo/toggles cached_ruling: the next ruling is the stored verdict (marked cached), no restart; off -> the model again', async () => {
    install('server');
    try {
      // The server booted with CACHED_RULING=false; flip it at runtime.
      const on = await admin('/v1/demo/toggles', { cached_ruling: true });
      expect(on.json!.toggles).toMatchObject({
        cached_ruling: true,
        cached_ruling_source: 'runtime',
        cached_ruling_env: false,
      });
      const b0 = await usdc(signerB.address);
      const betId = await lockedBet();
      await startAttempt(betId, 1);
      replies = [NOT_MET]; // the model would say A wins: it must not be asked
      const calls0 = llm.calls.length;
      const up = await uploadFrames(betId, 1, 12);
      await settle();
      expect(llm.calls.length).toBe(calls0);
      // Every surface carries the marker: the phones' and the stage's ruling.issued, the row.
      const issued = await wsA.next((f) => f.type === 'ruling.issued' && f.bet_id === betId);
      const ruling = Ruling.parse(issued.payload.ruling);
      expect(ruling).toMatchObject({
        outcome: 'B_WINS',
        model: CACHED_RULING_MODEL,
        cited_frames: [9, 10, 11],
        frame_hashes: up.frames.map((f) => sha256Hex(f)),
        evidence_hash: up.evidence.clip_sha256,
      });
      expect(isCachedRuling(ruling)).toBe(true);
      const staged = await wsStage.next((f) => f.type === 'ruling.issued' && f.bet_id === betId);
      expect(isCachedRuling(staged.payload.ruling)).toBe(true);
      // ...and it pays out on chain like any ruling.
      await expectRuled(betId, { ruling, ruling_hash: issued.payload.ruling_hash });
      await finalizeAfterWindow(betId);
      expect(await usdc(signerB.address)).toBe(b0 + 1n * USDC);
      replies = [];

      // Off again at runtime: the next bet's ruling is the model's.
      expect(
        (await admin('/v1/demo/toggles', { cached_ruling: false })).json!.toggles,
      ).toMatchObject({ cached_ruling: false });
      const bet2 = await lockedBet();
      const r = await judged(bet2, 1, NOT_MET, 8); // asserts exactly one model call
      expect(r.ruling).toMatchObject({
        outcome: 'A_WINS',
        model: 'anthropic/mock/claude-sonnet-5-5',
      });
      expect(isCachedRuling(r.ruling)).toBe(false);
      await expectRuled(bet2, r);
      await finalizeAfterWindow(bet2);
    } finally {
      replies = [];
      // back to the env default, so the env-driven tests below still flip CACHED_RULING
      await admin('/v1/demo/toggles', { cached_ruling: null });
      install('phones');
    }
  });

  // ---- the live driver, against this local server (never the live one) -------------------

  async function drive(args: string[], wallets: [TestKey, KeyPairSigner][]) {
    const secret = (k: TestKey, s: KeyPairSigner) =>
      JSON.stringify([...k.secret, ...new Uint8Array(getAddressEncoder().encode(s.address))]);
    const stateFile = join(tmpdir(), `cp1-drive-${randomUUID()}.json`);
    // cp1-drive runs with the server's own demo-a / demo-b keys (its users are the demo
    // accounts, e.g. for the judge-cam device op), so this server knows these as its demo keys.
    const env = ctx.deps.env as { DEMO_A_SECRET_KEY?: string; DEMO_B_SECRET_KEY?: string };
    const savedKeys = [env.DEMO_A_SECRET_KEY, env.DEMO_B_SECRET_KEY] as const;
    env.DEMO_A_SECRET_KEY = secret(...wallets[0]!);
    env.DEMO_B_SECRET_KEY = secret(...wallets[1]!);
    // While the driver waits out the appeal window, move both clocks (LiteSVM has no wall clock).
    let ticking = true;
    const ticker = (async () => {
      while (ticking) {
        await new Promise((r) => setTimeout(r, 150));
        const ruled = await ctx.deps.db
          .select({ id: bets.id })
          .from(bets)
          .where(eq(bets.state, 'RULED'));
        if (ruled.length && args.includes('--gg') === false) {
          advance(12_000);
          await lc.payout.finalizeDue(now());
        }
      }
    })();
    try {
      return await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(
          'npx',
          [
            'tsx',
            'scripts/cp1-drive.ts',
            '--base-url',
            ctx.base,
            '--admin-token',
            ADMIN,
            '--state-file',
            stateFile,
            '--timeout',
            '30',
            ...args,
          ],
          {
            cwd: fileURLToPath(new URL('../../../', import.meta.url)),
            env: {
              ...process.env,
              DEMO_A_SECRET_KEY: secret(...wallets[0]!),
              DEMO_B_SECRET_KEY: secret(...wallets[1]!),
            },
          },
        );
        let out = '';
        child.stdout.on('data', (d) => (out += String(d)));
        child.stderr.on('data', (d) => (out += String(d)));
        child.on('close', (code) => {
          if (process.env.E2E_DEBUG) console.log(out);
          resolve({ code, out });
        });
      });
    } finally {
      ticking = false;
      await ticker;
      rmSync(stateFile, { force: true });
      await settle();
      [env.DEMO_A_SECRET_KEY, env.DEMO_B_SECRET_KEY] = savedKeys;
    }
  }

  async function freshWallets(): Promise<[TestKey, KeyPairSigner][]> {
    const keys = [newKey(), newKey()];
    const out: [TestKey, KeyPairSigner][] = [];
    for (const k of keys) {
      const s = await createKeyPairSignerFromPrivateKeyBytes(k.secret);
      await fund(s);
      out.push([k, s]);
    }
    return out;
  }

  it('scripts/cp1-drive.ts --through paid: LOCKED -> judge cam -> frames -> RULED -> PAID (finalize)', async () => {
    replies = [];
    const w = await freshWallets();
    const before = await usdc(w[1]![1].address);
    // CACHED_RULING (as on the live server): B_WINS from the uploaded frames, no LLM call.
    ctx.deps.env.CACHED_RULING = true;
    try {
      const { code, out } = await drive(
        ['--through', 'paid', '--name-a', 'Ava', '--name-b', 'Ben'],
        w,
      );
      expect(out).toContain('LOCKED in');
      expect(out).toContain('ruling.issued');
      expect(out).toContain('RULED');
      expect(out).toMatch(/PAID .*finalize/);
      expect(code, out).toBe(0);
    } finally {
      ctx.deps.env.CACHED_RULING = false;
    }
    expect(await usdc(w[1]![1].address)).toBe(before + 1n * USDC);
  }, 90_000);

  it('scripts/cp1-drive.ts --through paid --gg: the loser concedes -> PAID (concede)', async () => {
    const w = await freshWallets();
    const before = await usdc(w[0]![1].address);
    ctx.deps.env.CACHED_RULING = true;
    try {
      const { code, out } = await drive(['--through', 'paid', '--gg'], w);
      expect(out).toMatch(/GG by A/);
      expect(out).toMatch(/PAID .*concede/);
      expect(code, out).toBe(0);
    } finally {
      ctx.deps.env.CACHED_RULING = false;
    }
    expect(await usdc(w[0]![1].address)).toBe(before - 1n * USDC); // A (the loser) paid B
  }, 90_000);
});
