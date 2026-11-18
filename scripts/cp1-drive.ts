#!/usr/bin/env -S npx tsx
// Checkpoint 1 driver: the Beat 2-3 money path over the real HTTP API, with the custodial demo
// keys as the two players' wallets (decision D-A: the phones import the same demo-a / demo-b
// seeds, so this exercises exactly the keys the phones will use). With --through paid it goes on
// through Beat 4 to the payout.
//
//   npm run cp1-drive -- [--base-url http://127.0.0.1:8080] [--admin-token <DEMO_ADMIN_TOKEN>]
//        [--keys-dir ~/.config/solana/youre-on] [--state-file <path>] [--reset] [--timeout 60]
//        [--name-a Logan] [--name-b Jake] [--through locked|paid] [--gg | --appeal] [--frames 8]
//        [--market up|down] [--amount 2] [--via-tools]
//
// Steps: sign up (or log in) two users whose wallet keys are demo-a / demo-b -> A creates a room,
// B joins -> A challenges B from the list (POST /v1/bets) -> B accepts the invite -> fixture terms
// (POST /v1/demo/bets/:id/terms, the same sink as propose_terms) -> confirm
// (POST /v1/demo/bets/:id/confirm = confirm_terms) -> waits for LOCKED.
// --via-tools: the terms and the confirm go through the ElevenLabs webhook tools instead, exactly
// as the voice judge sends them (POST /el/tools/propose_terms then /el/tools/confirm_terms with
// X-YO-Tool-Secret = ELEVENLABS_TOOL_SECRET from the env, the conversation bound by POST /v1/bets
// voice_conversation_id). It proves the server half of the voice judge (secret, binding, sink,
// lock) right after activation, with no phone and no ElevenLabs call.
// With LOCK_SIGNER=phones on the server, this script plays both phones: GET /lock, sign the
// stored message bytes with demo-a / demo-b, POST /lock/authorizations. With LOCK_SIGNER=server
// the server signs custodially and the script only waits.
//
// --through paid (Beat 4, after LOCKED): a fresh judge-cam device key is registered as a second
// device of A (POST /v1/demo/users/:id/devices: the cam must be a device of the NON-performer,
// API-CONTRACT §2.9; a third user's cam is never chosen), signs in (POST /v1/auth/session) and
// binds itself to the room (PATCH /v1/devices/current role judge_cam). A's phone starts the
// attempt (POST /v1/bets/:id/attempts, recorder judge_cam); the cam uploads --frames (8-12) tiny
// valid JPEGs + CameraEvidence with their SHA-256s (multipart, signed); the script waits for
// ruling.issued (GET /v1/bets/:id latest_ruling; a REDO starts the next attempt), RULED (the
// server's resolve), then PAID: by the server's finalize after the appeal window, or with --gg
// the loser concedes (GET /v1/bets/:id/concede, signs the stored message with its wallet key,
// POST /v1/bets/:id/concede). Each chain tx is printed with its Explorer link on devnet.
// The verdict is the server's: CACHED_RULING=true (no LLM call) rules B_WINS from the frames.
// --appeal (Beat 5, instead of --gg): right after RULED the loser (A for a VOID) appeals inside
// the 10 s window (GET /v1/bets/:id/appeal, signs the stored message with its wallet key, POST
// /v1/bets/:id/appeal), then the script waits for APPEALED, prints the three panel votes and the
// result (GET /v1/bets/:id appeal), and waits for APPEAL_RESOLVED -> PAID / VOIDED (the server's
// resolve_appeal, signed by APPEAL_AUTHORITY_SECRET_KEY). The panel calls the live vendors when
// the server runs LLM_PROVIDER=live (a vendor with no key abstains; all abstain = the ruling stands).
//
// --market up|down (Beat 6, the Gemini closer) replaces the fixture terms: A bets UP or DOWN on
// Gemini's current BTC 5-minute contract with --amount dollars a side (default 2). The script
// waits for a lockable window (GET /v1/markets/btc5m/current: strike known, >= 120 s to expiry),
// proposes (POST /v1/bets/:id/terms/market: the server's binding quote at Gemini's odds), confirms
// (POST /v1/bets/:id/terms/confirm, following a re-quote; if Gemini stopped pricing the round it
// waits for the next one and proposes again), and waits for AWAITING_MARKET. With --through paid
// it waits for Gemini to settle (the server's settlement keeper rules and sends resolve), then GG
// (--gg) or the finalize, as for Beat 4. Needs the server's Gemini relay on (MARKETS_FEED) and
// real_world allowed (ALLOW_P2P_REAL_WORLD, unset = DEMO_MODE).
//
// Rate limits (API-CONTRACT §1.7: /v1/markets/* 60/min per user, 120/min per session): the waits
// are paced by scripts/lib/poll.ts (/current every 2.5 s, or asleep until the next window when
// this one can't be locked any more; the bet every 3 s until expiry, then 1 s), and a 429 is
// waited out for its Retry-After instead of ending the run.
//
// Wallet keys: <keys-dir>/demo-a-keypair.json / demo-b-keypair.json (scripts/keys.ts), or the env
// DEMO_A_SECRET_KEY / DEMO_B_SECRET_KEY (the same values the server's custodial signer uses).
//
// Every write is a signed request (yo-req-v1, API-CONTRACT §1.3). Device keys are fresh ed25519
// keys kept (mode 600) in --state-file (default <keys-dir>/cp1-drive-devices.json, never in the
// repo) so a re-run logs in instead of re-registering the demo wallets.
// Requires the server with DEMO_MODE=true and DEMO_ADMIN_TOKEN set. Never touches the chain itself.
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressDecoder,
  getBase58Decoder,
  getBase58Encoder,
  signBytes,
  type KeyPairSigner,
} from '@solana/kit';

import {
  authChallengeMessage,
  requestSigningString,
  walletBindMessage,
  type Session,
} from '@youre-on/shared/api';
import { MAX_JUDGE_FRAMES, MIN_JUDGE_FRAMES } from '@youre-on/shared/judge/frames';

import { expandPath, keysDirFrom, parseCli, run } from './lib/cli';
import { assertNotCommittable, loadRole } from './lib/keys';
import { MARKET_POLL_MS, marketWaitMs, retryAfterMs, settlementPollMs } from './lib/poll';

/** A 429 is waited out (Retry-After) this many times per request before it counts as an answer. */
const MAX_429_RETRIES = 8;

const USAGE = `usage: npm run cp1-drive -- [--base-url <url>] [--admin-token <token>] [--keys-dir <dir>]
          [--state-file <path>] [--reset] [--timeout 60] [--name-a Logan] [--name-b Jake]
          [--through locked|paid] [--gg | --appeal] [--frames 8] [--market up|down] [--amount 2]
          [--via-tools]
Drives challenge -> terms -> confirm -> LOCKED against a running server (DEMO_MODE=true);
--via-tools sends the terms + confirm as the ElevenLabs webhook tools (needs ELEVENLABS_TOOL_SECRET);
--through paid goes on: judge cam -> attempt -> frames -> ruling.issued -> RULED -> PAID
(finalize after the appeal window, or the loser's GG with --gg; with --appeal the loser appeals
in the window -> the three-model panel -> resolve_appeal -> PAID / VOIDED).
--market up|down (Beat 6): Gemini BTC 5-minute terms at Gemini's odds instead of the fixture;
--through paid then waits for Gemini to settle (up to ~6 min) instead of the judge cam.`;

type Device = { d: string; x: string };
type State = { A?: Device; B?: Device; CAM?: Device; base_url?: string };

/**
 * A 16x16 baseline JPEG (decodes anywhere). Each frame gets its own COM segment after SOI, so
 * the 8-12 frames hash differently and stay valid JPEGs.
 */
const BASE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAASABIAAD/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL' +
    '/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJico' +
    'KSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKz' +
    'tLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAEC' +
    'AwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYk' +
    'NOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJma' +
    'oqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwAGBgYGBgYKBgYK' +
    'DgoKCg4SDg4ODhIXEhISEhIXHBcXFxcXFxwcHBwcHBwcIiIiIiIiJycnJycsLCwsLCwsLCws/9sAQwEHBwcLCgsTCgoT' +
    'Lh8aHy4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4u/90ABAAB/9oADAMBAAIR' +
    'AxEAPwDzyHQv9mtOHQv9mvUYdC/2a04dC/2aXCuefDqa1+I/M//Z',
  'base64',
);
function jpegFrame(i: number, tag: string): Uint8Array {
  const com = Buffer.from(`yo-frame ${tag} ${i}`, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(com.length + 2);
  return new Uint8Array(
    Buffer.concat([
      BASE_JPEG.subarray(0, 2),
      Buffer.from([0xff, 0xfe]),
      len,
      com,
      BASE_JPEG.subarray(2),
    ]),
  );
}

const b58 = getBase58Decoder();
const sha256Hex = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

function newDevice(): Device {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return { d: jwk.d!, x: jwk.x! };
}
const devicePubkey = (dev: Device) =>
  getAddressDecoder().decode(new Uint8Array(Buffer.from(dev.x, 'base64url')));
function deviceSign(dev: Device, msg: string | Uint8Array): Uint8Array {
  const key = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: dev.d, x: dev.x },
    format: 'jwk',
  });
  return new Uint8Array(sign(null, typeof msg === 'string' ? Buffer.from(msg, 'utf8') : msg, key));
}

class Api {
  constructor(
    readonly base: string,
    readonly admin: string | undefined,
  ) {}

  /** One request. A GET answered 429 is retried after its Retry-After (a poll never dies of it). */
  async call(
    method: string,
    path: string,
    init: { body?: unknown; raw?: Uint8Array; headers?: Record<string, string> } = {},
  ) {
    for (let attempt = 0; ; attempt++) {
      const r = await this.callOnce(method, path, init);
      if (r.status !== 429 || method !== 'GET' || attempt >= MAX_429_RETRIES) return r;
      await this.waitOut429(path, r.retryAfter);
    }
  }

  private async waitOut429(path: string, retryAfter: string | null) {
    const ms = retryAfterMs(retryAfter);
    console.log(`  (429 on ${path.split('?')[0]}: waiting ${(ms / 1000).toFixed(1)} s)`);
    await new Promise((r) => setTimeout(r, ms));
  }

  private async callOnce(
    method: string,
    path: string,
    init: { body?: unknown; raw?: Uint8Array; headers?: Record<string, string> },
  ) {
    const raw =
      init.raw ??
      (init.body === undefined ? (method === 'GET' ? undefined : '') : JSON.stringify(init.body));
    const res = await fetch(this.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...init.headers },
      body: raw as Uint8Array<ArrayBuffer> | string | undefined,
    });
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: res.status, json, retryAfter: res.headers.get('retry-after') };
  }

  /** The server's clock as far as we know it (local clock + the CLOCK_SKEW we learned). */
  serverNow(): number {
    return Date.now() + this.skewMs;
  }

  /** Server clock - local clock, learned from a CLOCK_SKEW answer (API-CONTRACT §1.3: ±60 s). */
  private skewMs = 0;

  /** A §1.3 signed write as `who`; retried once with the server's clock after CLOCK_SKEW. */
  async signed(who: Signer, method: string, path: string, body?: unknown) {
    const raw = new TextEncoder().encode(body === undefined ? '' : JSON.stringify(body));
    return this.signedRaw(who, method, path, raw, 'application/json');
  }

  /**
   * A signed write with a raw body (e.g. the frames multipart); same CLOCK_SKEW retry. A 429 is
   * refused before the handler runs (the rate limit is taken first), so it is re-signed (fresh
   * timestamp and Idempotency-Key) and sent again after its Retry-After.
   */
  async signedRaw(who: Signer, method: string, path: string, raw: Uint8Array, contentType: string) {
    for (let attempt = 0; ; attempt++) {
      let r = await this.signedOnce(who, method, path, raw, contentType);
      const serverTime = r.json?.error?.details?.server_time;
      if (r.status === 401 && r.json?.error?.code === 'CLOCK_SKEW' && serverTime) {
        this.skewMs = Date.parse(serverTime) - Date.now();
        console.log(
          `  (clock skew ${Math.round(this.skewMs / 1000)} s vs the server; using its clock)`,
        );
        r = await this.signedOnce(who, method, path, raw, contentType);
      }
      if (r.status !== 429 || attempt >= MAX_429_RETRIES) return r;
      await this.waitOut429(path, r.retryAfter);
    }
  }

  private signedOnce(
    who: Signer,
    method: string,
    path: string,
    raw: Uint8Array,
    contentType: string,
  ) {
    const ts = String(Date.now() + this.skewMs);
    const idem = randomUUID();
    const str = requestSigningString({
      method,
      path_and_query: path,
      timestamp_ms: ts,
      idempotency_key: idem,
      session_id: who.session.session_id,
      body_sha256_hex: sha256Hex(raw),
    });
    return this.call(method, path, {
      raw,
      headers: {
        'Content-Type': contentType,
        Authorization: `Bearer ${who.session.token}`,
        'X-YO-Device': who.session.device_id,
        'X-YO-Timestamp': ts,
        'Idempotency-Key': idem,
        'X-YO-Signature': Buffer.from(deviceSign(who.device, str)).toString('base64url'),
      },
    });
  }

  get(who: Signer, path: string) {
    return this.call('GET', path, { headers: { Authorization: `Bearer ${who.session.token}` } });
  }

  demo(method: string, path: string, body?: unknown) {
    if (!this.admin) throw new Error('--admin-token (or DEMO_ADMIN_TOKEN) is required');
    return this.call(method, path, { body, headers: { 'X-YO-Demo-Key': this.admin } });
  }
}

/** The role's keypair file, or (tests / CI) the same secret as the server's DEMO_A/B_SECRET_KEY env. */
async function walletKey(dir: string, role: 'demo-a' | 'demo-b', secret: string | undefined) {
  if (!secret) return loadRole(dir, role);
  const bytes = secret.trim().startsWith('[')
    ? Uint8Array.from(JSON.parse(secret) as number[])
    : new Uint8Array(getBase58Encoder().encode(secret.trim()));
  return bytes.length === 32
    ? createKeyPairSignerFromPrivateKeyBytes(bytes)
    : createKeyPairSignerFromBytes(bytes);
}

/** Whatever signs §1.3 requests: a device key and its session. */
type Signer = { device: Device; session: Session };

type Player = Signer & {
  party: 'A' | 'B';
  name: string;
  wallet: KeyPairSigner;
};

function must<T>(r: { status: number; json: T }, ok: number[], what: string): T {
  if (!ok.includes(r.status))
    throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

/** POST /v1/auth/session with a registered device key, or why the server refused it. */
async function login(api: Api, dev: Device): Promise<Session | { error: string }> {
  const ch = must(
    await api.call('POST', '/v1/auth/challenge', { body: { device_pubkey: devicePubkey(dev) } }),
    [200],
    'challenge',
  );
  const msg = authChallengeMessage({
    purpose: 'login',
    nonce: ch.nonce,
    device_pubkey: devicePubkey(dev),
    wallet_pubkey: null,
  });
  const r = await api.call('POST', '/v1/auth/session', {
    body: {
      challenge_id: ch.challenge_id,
      device_pubkey: devicePubkey(dev),
      device_sig: b64(deviceSign(dev, msg)),
    },
  });
  return r.status === 200 ? (r.json as Session) : { error: `${r.status} ${r.json?.error?.code}` };
}

async function session(
  api: Api,
  party: 'A' | 'B',
  name: string,
  wallet: KeyPairSigner,
  state: State,
): Promise<{ device: Device; session: Session; fresh: boolean }> {
  const stored = state[party];
  if (stored) {
    const s = await login(api, stored);
    if (!('error' in s)) return { device: stored, session: s, fresh: false };
    console.log(`  ${party}: stored device login failed (${s.error}); signing up again`);
  }
  const device = newDevice();
  const pub = devicePubkey(device);
  const ch = must(
    await api.call('POST', '/v1/auth/challenge', { body: { device_pubkey: pub } }),
    [200],
    'challenge',
  );
  const deviceSig = deviceSign(
    device,
    authChallengeMessage({
      purpose: 'signup',
      nonce: ch.nonce,
      device_pubkey: pub,
      wallet_pubkey: wallet.address,
    }),
  );
  const walletSig = await signBytes(
    wallet.keyPair.privateKey,
    new TextEncoder().encode(
      walletBindMessage({ wallet_pubkey: wallet.address, device_pubkey: pub, nonce: ch.nonce }),
    ),
  );
  const r = await api.call('POST', '/v1/auth/signup', {
    body: {
      challenge_id: ch.challenge_id,
      display_name: name,
      age_attestation: { is_18_plus: true, attested_at: new Date().toISOString() },
      wallet_pubkey: wallet.address,
      device_pubkey: pub,
      device_sig: b64(deviceSig),
      wallet_sig: b64(new Uint8Array(walletSig)),
      app_version: 'cp1-drive',
    },
  });
  if (r.status === 409)
    throw new Error(
      `${party}: wallet ${wallet.address} is already registered on this server and no working device is in the state file. ` +
        'Use the state file from the run that registered it, or a fresh database.',
    );
  return { device, session: must(r, [201], `signup ${party}`) as Session, fresh: true };
}

/**
 * Beat 2 the way the ElevenLabs agent drives it: propose_terms with the judge's whole bet, wait
 * for the sink (TERMS_PROPOSED), then confirm_terms. Business errors come back as HTTP 200
 * {ok:false, fix, say}; a 401 means ELEVENLABS_TOOL_SECRET is not the server's value.
 */
async function termsViaTools(
  api: Api,
  betId: string,
  conversationId: string,
  secret: string,
  bName: string,
  timeoutMs: number,
) {
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await api.call('POST', `/el/tools/${name}`, {
      body: { conversation_id: conversationId, bet_id: betId, ...args },
      headers: { 'X-YO-Tool-Secret': secret },
    });
    if (r.status === 401)
      throw new Error(`${name}: 401: ELEVENLABS_TOOL_SECRET is not the value the server has`);
    const reply = must(r, [200], name);
    console.log(`${name}: ${JSON.stringify(reply)}`);
    if (!reply?.ok)
      throw new Error(`${name} refused: ${reply?.fix ?? reply?.refused} "${reply?.say}"`);
    return reply;
  };
  // What the judge sends once the one edge-case question is answered (API-CONTRACT §4.3).
  const proposed = await tool('propose_terms', {
    type: 'skill',
    claim: `${bName} lands a water bottle flip upright on the table.`,
    performer: 'B',
    yes_party: 'B',
    attempts: { count: 1, rule: 'single' },
    success_criteria: [
      'The bottle rotates at least once in the air.',
      'The bottle comes to rest standing upright on its base.',
    ],
    failure_criteria: ['The bottle ends on its side, upside down, or off the table.'],
    edge_cases: [
      {
        question: 'Does landing on the cap count?',
        answer: 'No. Only upright on its base counts.',
      },
    ],
    amount_usd: '1',
    market_side: 'none',
    deadline_minutes: 0,
  });
  if (proposed.next !== 'readback')
    throw new Error(`propose_terms: expected next "readback", got ${JSON.stringify(proposed)}`);
  // The sink composes + hashes after the reply (§4.2): wait for TERMS_PROPOSED.
  const t0 = Date.now();
  for (;;) {
    const st = must(await api.demo('GET', `/v1/demo/bets/${betId}`), [200], 'bet status');
    if (st.state === 'TERMS_PROPOSED') break;
    if (st.state !== 'DRAFTING') throw new Error(`after propose_terms the bet is ${st.state}`);
    if (Date.now() - t0 > timeoutMs) throw new Error('propose_terms: no TERMS_PROPOSED in time');
    await new Promise((r) => setTimeout(r, 200));
  }
  const confirmed = await tool('confirm_terms', { heard: 'both' });
  console.log(`terms ${confirmed.code} confirmed by the judge: "${confirmed.say}"`);
}

run(async () => {
  const { values } = parseCli(USAGE, {
    'base-url': { type: 'string' },
    'admin-token': { type: 'string' },
    'state-file': { type: 'string' },
    reset: { type: 'boolean' },
    timeout: { type: 'string' },
    'name-a': { type: 'string' },
    'name-b': { type: 'string' },
    through: { type: 'string' },
    gg: { type: 'boolean' },
    appeal: { type: 'boolean' },
    frames: { type: 'string' },
    market: { type: 'string' },
    amount: { type: 'string' },
    'via-tools': { type: 'boolean' },
  });
  const marketSide = values.market?.toUpperCase();
  if (marketSide !== undefined && marketSide !== 'UP' && marketSide !== 'DOWN') {
    console.error(`--market must be up or down\n\n${USAGE}`);
    process.exit(2);
  }
  const viaTools = values['via-tools'] === true;
  const toolSecret = process.env['ELEVENLABS_TOOL_SECRET'];
  if (viaTools && !toolSecret) {
    console.error(`--via-tools needs ELEVENLABS_TOOL_SECRET (the server's value)\n\n${USAGE}`);
    process.exit(2);
  }
  if (viaTools && marketSide) {
    console.error(`--via-tools and --market are separate drives (pick one)\n\n${USAGE}`);
    process.exit(2);
  }
  const amountUsd = values.amount ?? '2';
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(amountUsd)) {
    console.error(`--amount must be dollars like 2 or 2.50\n\n${USAGE}`);
    process.exit(2);
  }
  if (values.gg && values.appeal) {
    console.error(`--gg and --appeal are two ways to answer the ruling (pick one)\n\n${USAGE}`);
    process.exit(2);
  }
  const through = values.through ?? 'locked';
  if (through !== 'locked' && through !== 'paid') {
    console.error(`--through must be locked or paid\n\n${USAGE}`);
    process.exit(2);
  }
  const nFrames = Number(values.frames ?? MIN_JUDGE_FRAMES);
  if (!Number.isInteger(nFrames) || nFrames < MIN_JUDGE_FRAMES || nFrames > MAX_JUDGE_FRAMES) {
    console.error(
      `--frames must be ${MIN_JUDGE_FRAMES}..${MAX_JUDGE_FRAMES} (the server's limits; the phone sends 12 + a landing crop)\n\n${USAGE}`,
    );
    process.exit(2);
  }
  const base = (
    values['base-url'] ??
    process.env['CP1_BASE_URL'] ??
    'http://127.0.0.1:8080'
  ).replace(/\/$/, '');
  const api = new Api(base, values['admin-token'] ?? process.env['DEMO_ADMIN_TOKEN']);
  const keysDir = keysDirFrom(values['keys-dir']);
  const stateFile = expandPath(values['state-file'] ?? join(keysDir, 'cp1-drive-devices.json'));
  assertNotCommittable([stateFile]);
  const timeoutMs = Number(values.timeout ?? 60) * 1000;
  const state: State = existsSync(stateFile)
    ? (JSON.parse(readFileSync(stateFile, 'utf8')) as State)
    : {};
  if (state.base_url && state.base_url !== base) {
    console.log(`(state file was for ${state.base_url}; signing up fresh devices for ${base})`);
    delete state.A;
    delete state.B;
    delete state.CAM;
  }

  const health = must(
    await api.demo('GET', '/v1/demo/health'),
    [200],
    'demo health (DEMO_MODE + admin token?)',
  );
  console.log(
    `server ${base}: chain ${health.chain_configured ? 'on' : 'OFF'}, lock signer ${health.lock_signer}, nonces free ${health.nonce_pool.free}/${health.nonce_pool.size}, fee payer ${health.fee_payer ?? '-'} (${health.fee_payer_sol ?? '?'} SOL)`,
  );
  // Explorer links only for a real cluster (not LiteSVM / a local validator).
  const onDevnet = !!health.rpc && !/litesvm|127\.0\.0\.1|localhost/i.test(String(health.rpc));
  const tx = (what: string, sig: string | null | undefined) =>
    console.log(
      `  ${what} tx ${sig ?? '-'}` +
        (onDevnet && sig ? `\n    https://explorer.solana.com/tx/${sig}?cluster=devnet` : ''),
    );
  if (values.reset) {
    const r = must(await api.demo('POST', '/v1/demo/reset'), [200], 'demo reset');
    console.log(`reset: ${r.deleted_bets} bet(s) deleted, ${r.nonces_synced} nonce(s) synced`);
  }

  const wallets = {
    A: await walletKey(keysDir, 'demo-a', process.env['DEMO_A_SECRET_KEY']),
    B: await walletKey(keysDir, 'demo-b', process.env['DEMO_B_SECRET_KEY']),
  };
  const names = { A: values['name-a'] ?? 'Logan', B: values['name-b'] ?? 'Jake' };
  const players = {} as Record<'A' | 'B', Player>;
  for (const party of ['A', 'B'] as const) {
    const s = await session(api, party, names[party], wallets[party], state);
    players[party] = {
      party,
      name: names[party],
      wallet: wallets[party],
      device: s.device,
      session: s.session,
    };
    state[party] = s.device;
    console.log(
      `${party}: ${s.fresh ? 'signed up' : 'logged in'} ${s.session.user.display_name} wallet ${wallets[party].address}`,
    );
  }
  state.base_url = base;
  writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(stateFile, 0o600);
  const { A, B } = players;

  const room = must(
    await api.signed(A, 'POST', '/v1/rooms', { name: 'CP1 drive', kind: 'session' }),
    [201],
    'create room',
  );
  must(await api.signed(B, 'POST', '/v1/rooms/join', { code: room.code }), [200], 'join room');
  console.log(`room ${room.code} (${room.room_id})`);

  // --via-tools: the conversation the webhook tools name, bound to the bet here (as A's phone
  // does with the minted one; an unknown id is bound as-is until real minting is required).
  const conversationId = viaTools ? `conv_cp1_${randomUUID().replace(/-/g, '')}` : null;
  const created = await api.signed(A, 'POST', '/v1/bets', {
    room_id: room.room_id,
    opponent_user_id: B.session.user.user_id,
    challenge_method: 'list',
    ...(conversationId ? { voice_conversation_id: conversationId } : {}),
  });
  if (created.status === 409 && created.json?.error?.details?.reason === 'pair_busy')
    throw new Error(
      `these two already have a bet in progress (${created.json.error.details.bet_id}); re-run with --reset`,
    );
  const betId: string = must(created, [201], 'challenge').bet.bet_id;
  console.log(`bet ${betId} DRAFTING`);
  must(await api.signed(B, 'POST', `/v1/bets/${betId}/invite/accept`), [200], 'accept invite');

  let expiryMs: number | null = null;
  if (marketSide) {
    // a round Gemini stops pricing between our quote and the confirm: take the next one
    for (let round = 1; expiryMs === null; round++) {
      expiryMs = await marketTerms(api, A, betId, marketSide, amountUsd, timeoutMs);
      if (expiryMs === null && round >= 2) throw new Error('Gemini stopped pricing twice');
    }
  } else if (viaTools) {
    await termsViaTools(api, betId, conversationId!, toolSecret!, names.B, timeoutMs);
  } else {
    const terms = must(
      await api.demo('POST', `/v1/demo/bets/${betId}/terms`, {}),
      [200],
      'fixture terms',
    );
    console.log(`terms ${terms.code} (${terms.terms_hash}) TERMS_PROPOSED: "${terms.say}"`);
    const conf = must(await api.demo('POST', `/v1/demo/bets/${betId}/confirm`), [200], 'confirm');
    console.log(`confirm: ${conf.say}`);
  }

  const t0 = Date.now();
  let signedPhones = false;
  for (;;) {
    const st = must(await api.demo('GET', `/v1/demo/bets/${betId}`), [200], 'bet status');
    // A Gemini bet is locked straight into AWAITING_MARKET (one commit), and may even be ruled
    // by the time we look.
    if (
      st.state === 'LOCKED' ||
      (marketSide && !['AWAITING_AUTHORIZATIONS', 'AWAITING_LOCK'].includes(st.state))
    ) {
      const lock = st.chain_txs.find((t: { kind: string }) => t.kind === 'atomic_lock');
      console.log(
        `\n${st.state} in ${Date.now() - t0} ms after confirm. lock tx ${lock?.signature}`,
      );
      console.log(`  pending_sig ${st.pending_sig} (onchain_pending ${st.onchain_pending})`);
      tx('atomic_lock', lock?.signature);
      break;
    }
    if (['CANCELLED', 'EXPIRED'].includes(st.state))
      throw new Error(
        `bet ended ${st.state} (${st.end_reason}); chain_txs ${JSON.stringify(st.chain_txs)}`,
      );
    if (
      st.state === 'AWAITING_AUTHORIZATIONS' &&
      health.lock_signer === 'phones' &&
      !signedPhones
    ) {
      const lr = await api.get(A, `/v1/bets/${betId}/lock`);
      if (lr.status === 200) {
        const req = lr.json;
        const msg = new Uint8Array(Buffer.from(req.message_b64, 'base64'));
        for (const p of [B, A]) {
          const sig = await signBytes(p.wallet.keyPair.privateKey, msg);
          const r = must(
            await api.signed(p, 'POST', `/v1/bets/${betId}/lock/authorizations`, {
              bet_id: betId,
              lock_request_id: req.lock_request_id,
              party: p.party,
              terms_hash: req.envelope.terms_hash,
              method: 'faceid_hold',
              authorized_at: new Date().toISOString(),
              ms_since_auth_success: 0,
              message_sha256: req.message_sha256,
              party_signature: b58.decode(new Uint8Array(sig)),
            }),
            [202],
            `authorize ${p.party}`,
          );
          console.log(`  ${p.party} authorized: ${JSON.stringify(r)}`);
        }
        signedPhones = true;
      }
    }
    if (Date.now() - t0 > timeoutMs)
      throw new Error(
        `not LOCKED after ${timeoutMs / 1000} s (state ${st.state}); chain_txs ${JSON.stringify(st.chain_txs)}`,
      );
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 400));
  }
  if (through === 'locked') return;

  let ruling: LatestRuling | null = null;
  if (expiryMs !== null) {
    // ---- Beat 6: Gemini settles the contract -> the settlement ruling -> RULED -> PAID ------
    const waitMs = Math.max(0, expiryMs - Date.now()) + 120_000;
    console.log(
      `waiting for Gemini: the contract expires ${new Date(expiryMs).toISOString()} (in ${Math.round((expiryMs - Date.now()) / 1000)} s); settlement lands ~6-9 s later`,
    );
    ruling = await until(
      waitMs + timeoutMs,
      'the Gemini settlement ruling',
      async () => {
        const snap = must(await api.get(A, `/v1/bets/${betId}`), [200], 'bet snapshot');
        const r = snap.latest_ruling as LatestRuling | null;
        return r && r.ruling.stage === 'settlement' ? r : null;
      },
      // slow until the contract expires (minutes), then 1/s while Gemini settles (~6-9 s)
      () => settlementPollMs(expiryMs!, api.serverNow()),
    );
    const r = ruling.ruling;
    console.log(`\nGemini settled: ${r.outcome} (${r.claim_result}, ${r.model}) "${r.reason}"`);
    console.log(`  ruling_hash ${ruling.ruling_hash}, evidence_hash ${r.evidence_hash}`);
  }

  // ---- Beat 4: judge cam -> attempt -> frames -> ruling.issued -> RULED -> PAID ------------
  for (let n = 1; n <= 3 && expiryMs === null; n++) {
    if (n === 1) {
      const cam0 = await judgeCam(api, A, room.room_id, state);
      writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
      console.log(`\njudge cam: device ${cam0.session.device_id} of ${A.name}, bound to the room`);
      camRef.cam = cam0;
    }
    const cam = camRef.cam!;
    const att = must(
      await api.signed(A, 'POST', `/v1/bets/${betId}/attempts`, {
        attempt_no: n,
        recorder: 'judge_cam',
      }),
      [201],
      `attempt ${n}`,
    );
    console.log(
      `attempt ${n}: ${att.performer} performs, GO at ${att.go_at} (max ${att.max_ms} ms)`,
    );
    const up = await uploadFrames(api, cam, betId, n, nFrames);
    console.log(`  ${nFrames} frames (${up.bytes} B) uploaded: 202, clip ${up.clip.slice(0, 16)}…`);
    ruling = await until(
      timeoutMs,
      `ruling.issued for attempt ${n}`,
      async () => {
        const snap = must(await api.get(A, `/v1/bets/${betId}`), [200], 'bet snapshot');
        const r = snap.latest_ruling as LatestRuling | null;
        return r && r.ruling.attempt_no === n ? r : null;
      },
      1_000, // a session GET: 120/min
    );
    const r = ruling.ruling;
    console.log(
      `\nruling.issued: ${r.outcome} (${r.claim_result}, confidence ${r.confidence}, ${r.model}) "${r.reason}"`,
    );
    console.log(`  ruling_hash ${ruling.ruling_hash}`);
    if (r.outcome !== 'REDO') break;
    console.log(`  REDO (${r.redo_reason}): run it back`);
  }
  if (!ruling || ruling.ruling.outcome === 'REDO')
    throw new Error('no decisive ruling in 3 attempts');
  if (values.gg && ruling.ruling.outcome === 'VOID')
    console.log('  VOID: a refund, nobody to GG; waiting for the finalize');

  const ruled = await until(timeoutMs, 'RULED', async () => {
    const st = must(await api.demo('GET', `/v1/demo/bets/${betId}`), [200], 'bet status');
    if (['CANCELLED', 'EXPIRED'].includes(st.state))
      throw new Error(`bet ended ${st.state} (${st.end_reason})`);
    return ['RULED', 'CONCEDED', 'FINALIZED', 'PAID', 'VOIDED'].includes(st.state) ? st : null;
  });
  console.log(`\nRULED (resolve confirmed): appeal window until ${ruled.appeal_deadline}`);
  tx('resolve', lastTx(ruled.chain_txs, 'resolve')?.signature);

  if (values.appeal) {
    const via = await appealRuling(api, players, betId, timeoutMs, tx);
    const snap = must(await api.get(A, `/v1/bets/${betId}`), [200], 'bet snapshot');
    if (snap.payout)
      console.log(`  payout: A ${snap.payout.to_a}, B ${snap.payout.to_b} (micro-USDC)`);
    if (via !== 'resolve_appeal') throw new Error(`the appeal did not decide the bet (${via})`);
    return;
  }

  if (values.gg && ruling.ruling.outcome !== 'VOID') {
    const loser = await ggLoser(api, players, betId);
    if (!loser) throw new Error(`no loser can GG this ruling (${ruling.ruling.outcome})`);
    const req = must(await api.get(loser, `/v1/bets/${betId}/concede`), [200], 'concede request');
    const msg = new Uint8Array(Buffer.from(req.message_b64, 'base64'));
    if (sha256Hex(msg) !== req.message_sha256) throw new Error('concede message_sha256 mismatch');
    const sig = await signBytes(loser.wallet.keyPair.privateKey, msg);
    const r = must(
      await api.signed(loser, 'POST', `/v1/bets/${betId}/concede`, {
        bet_id: betId,
        kind: 'concede',
        party: loser.party,
        message_sha256: req.message_sha256,
        party_signature: b58.decode(new Uint8Array(sig)),
        method: 'faceid_hold',
        signed_at: new Date().toISOString(),
      }),
      [202],
      'concede',
    );
    console.log(
      `GG by ${loser.party} (${loser.name}): "${req.card.prompt_message}" -> ${r.status}`,
    );
  } else {
    console.log('waiting out the appeal window for the server to finalize');
  }

  // The server finalizes at appeal_deadline + 1 s: allow for the window on top of --timeout.
  const appealMs = Math.max(0, Date.parse(ruled.appeal_deadline ?? '') - Date.now() || 0);
  const paid = await until(timeoutMs + (values.gg ? 0 : appealMs), 'PAID', async () => {
    const st = must(await api.demo('GET', `/v1/demo/bets/${betId}`), [200], 'bet status');
    return ['PAID', 'VOIDED'].includes(st.state) ? st : null;
  });
  const via = values.gg && ruling.ruling.outcome !== 'VOID' ? 'concede' : 'finalize';
  console.log(`\n${paid.state} via ${via} (${ruling.ruling.outcome})`);
  tx(via, lastTx(paid.chain_txs, via)?.signature);
  const snap = must(await api.get(A, `/v1/bets/${betId}`), [200], 'bet snapshot');
  if (snap.payout)
    console.log(`  payout: A ${snap.payout.to_a}, B ${snap.payout.to_b} (micro-USDC)`);
});

type LatestRuling = {
  ruling: {
    attempt_no: number;
    stage?: string;
    outcome: string;
    claim_result: string;
    confidence: number;
    reason: string;
    model: string;
    redo_reason: string | null;
    evidence_hash: string;
  };
  ruling_hash: string;
};

/** The judge-cam signer, set on the first Beat 4 attempt. */
const camRef: { cam: Signer | null } = { cam: null };

/** Confirm refusals that mean Gemini stopped pricing this round (wait for the next one). */
const ROUND_OVER = new Set(['TOO_CLOSE_TO_EXPIRY', 'MARKET_NOT_OPEN', 'STRIKE_PENDING']);

/**
 * Beat 6 terms: wait for a lockable BTC 5-minute window, propose at Gemini's odds, confirm
 * (following the server's re-quote). Returns the contract's expiry (ms), or null when Gemini
 * stopped pricing the round before the confirm (the caller tries the next one).
 */
async function marketTerms(
  api: Api,
  a: Player,
  betId: string,
  side: 'UP' | 'DOWN',
  amountUsd: string,
  timeoutMs: number,
): Promise<number | null> {
  // A window lasts 5 min and is lockable from its strike to T-120 s: wait up to one window,
  // paced by lib/poll.ts (60/min on /v1/markets/*): asleep while no window can be locked.
  let last: Parameters<typeof marketWaitMs>[0] | null = null;
  let told = 0;
  const cur = await until(
    Math.max(timeoutMs, 330_000),
    'a lockable Gemini window',
    async () => {
      const r = await api.get(a, '/v1/markets/btc5m/current');
      if (r.status !== 200)
        throw new Error(`markets/current: HTTP ${r.status} ${JSON.stringify(r.json)}`);
      last = r.json;
      return r.json.lockable ? r.json : null;
    },
    () => {
      const ms = last ? marketWaitMs(last, api.serverNow()) : MARKET_POLL_MS;
      if (ms > MARKET_POLL_MS && Date.now() - told > 30_000) {
        told = Date.now();
        console.log(
          `\n  (this round can't be locked any more; the next opens ${last?.next_window_start}: asleep ${Math.round(ms / 1000)} s)`,
        );
      }
      return ms;
    },
  );
  console.log(
    `Gemini ${cur.market.eventTicker}: line ${cur.market.strike.value}, BTC ${cur.market.indexPrice}, bid ${cur.market.bestBid} / ask ${cur.market.bestAsk}, expiry ${cur.market.expiry}, lockable until ${cur.lockable_until}`,
  );
  const p = must(
    await api.signed(a, 'POST', `/v1/bets/${betId}/terms/market`, { side, amount_usd: amountUsd }),
    [200],
    'market terms',
  );
  const q = p.quote;
  console.log(
    `terms ${p.code} (${p.terms_hash}) TERMS_PROPOSED: ${side} at ${q.market.priceAtLock} (${q.market.priceSource}), stakes A ${q.stakes.a} / B ${q.stakes.b}, quoted ${q.market.quotedAt}`,
  );
  console.log(`  binding snapshot #${q.snapshot_id} sha256 ${q.snapshot_sha256}`);
  console.log(`  "${p.say}"`);
  let hash: string = p.terms_hash;
  for (let i = 0; ; i++) {
    const c = await api.signed(a, 'POST', `/v1/bets/${betId}/terms/confirm`, { terms_hash: hash });
    if (c.status === 200) {
      console.log(`confirm: ${c.json.say}`);
      break;
    }
    const err = c.json?.error;
    if (c.status === 409 && err?.details?.reason === 'requoted' && i < 2) {
      hash = err.details.terms_hash;
      console.log(`  re-quoted by the server (quote older than 30 s): new terms ${hash}`);
      console.log(`    ${err.message}`);
      // a re-quote across the rollover is the next contract: its own expiry
      if (err.details.new_round === true) return confirmOn(api, a, betId, hash);
      continue;
    }
    if (
      c.status === 409 &&
      err?.code === 'MARKET_UNAVAILABLE' &&
      ROUND_OVER.has(err.details?.reason)
    ) {
      console.log(`  Gemini stopped pricing this round (${err.details.reason}): the next one`);
      return null;
    }
    must(c, [200], 'confirm');
  }
  return Date.parse(q.market.expiry);
}

/** Confirms the terms with `hash` (a cross-round re-quote) and returns their contract's expiry. */
async function confirmOn(api: Api, a: Player, betId: string, hash: string): Promise<number | null> {
  const c = await api.signed(a, 'POST', `/v1/bets/${betId}/terms/confirm`, { terms_hash: hash });
  if (c.status === 409 && ROUND_OVER.has(c.json?.error?.details?.reason)) return null;
  console.log(`confirm: ${must(c, [200], 'confirm').say}`);
  const snap = must(await api.get(a, `/v1/bets/${betId}`), [200], 'bet snapshot');
  const expiry = snap.envelope?.terms?.market?.expiry;
  if (typeof expiry !== 'string') throw new Error('the re-quoted terms carry no market expiry');
  return Date.parse(expiry);
}
type ChainTxRow = { kind: string; status: string; signature: string | null };
const lastTx = (rows: ChainTxRow[], kind: string) =>
  rows.filter((t) => t.kind === kind && t.status === 'confirmed').at(-1) ??
  rows.filter((t) => t.kind === kind).at(-1);

/**
 * Polls `probe` until it returns non-null, or throws after `ms`. `every`: the pause between
 * probes (ms, or computed after each probe); 400 ms suits the unmetered demo routes only: a
 * bearer route is 120/min per session (see lib/poll.ts).
 */
async function until<T>(
  ms: number,
  what: string,
  probe: () => Promise<T | null>,
  every: number | (() => number) = 400,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await probe();
    if (v !== null) return v;
    const elapsed = Date.now() - t0;
    if (elapsed > ms) throw new Error(`no ${what} after ${Math.round(ms / 1000)} s`);
    process.stdout.write('.');
    const pause = typeof every === 'number' ? every : every();
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(pause, ms - elapsed + 1))));
  }
}

/**
 * The judge-cam iPhone: a second device of A (the non-performer; a third user's cam is never
 * chosen, API-CONTRACT §2.9). Reuses the state file's cam key, else a fresh one, registered as a
 * device of A through the demo op (idempotent), then signed in and bound to `roomId`.
 */
async function judgeCam(api: Api, a: Player, roomId: string, state: State): Promise<Signer> {
  const device = state.CAM ?? newDevice();
  must(
    await api.demo('POST', `/v1/demo/users/${a.session.user.user_id}/devices`, {
      device_pubkey: devicePubkey(device),
    }),
    [200, 201],
    'register the judge-cam device (POST /v1/demo/users/:id/devices)',
  );
  const s = await login(api, device);
  if ('error' in s) throw new Error(`judge cam login: ${s.error}`);
  if (s.user.user_id !== a.session.user.user_id)
    throw new Error('the judge-cam device signed in as someone other than A');
  state.CAM = device;
  const cam: Signer = { device, session: s };
  must(
    await api.signed(cam, 'PATCH', '/v1/devices/current', { role: 'judge_cam', room_id: roomId }),
    [204],
    'bind the judge cam',
  );
  return cam;
}

/** The judge cam's signed multipart upload: CameraEvidence + n JPEGs with their SHA-256s. */
async function uploadFrames(api: Api, cam: Signer, betId: string, n: number, count: number) {
  const tag = randomUUID().slice(0, 8);
  const frames = Array.from({ length: count }, (_, i) => jpegFrame(i, tag));
  const clip = sha256Hex(Buffer.concat(frames)); // stands in for the clip's hash (no clip here)
  const evidence = {
    schema_version: 1,
    kind: 'camera',
    bet_id: betId,
    attempt_no: n,
    clip_sha256: clip,
    clip_bytes: frames.reduce((a, f) => a + f.length, 0),
    mime: 'video/quicktime',
    duration_ms: 4_000,
    recorded_by: 'A', // the judge cam is a device of A
    recorded_at: new Date().toISOString(),
    frames: frames.map((f, i) => ({
      index: i,
      t_ms: 4_000 - (count - i) * 200,
      sha256: sha256Hex(f),
    })),
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
  const req = new Request('http://local/', { method: 'POST', body: form });
  const body = new Uint8Array(await req.arrayBuffer());
  const r = must(
    await api.signedRaw(
      cam,
      'POST',
      `/v1/bets/${betId}/attempts/${n}/frames`,
      body,
      req.headers.get('content-type')!,
    ),
    [202],
    `frames for attempt ${n}`,
  );
  const want = evidence.frames.map((f) => f.sha256);
  if (JSON.stringify(r.frame_hashes) !== JSON.stringify(want))
    throw new Error('the server hashed the frames differently');
  return { clip, bytes: body.length };
}

/**
 * Beat 5: the loser appeals inside the window (A for a VOID: either may), then the panel's votes
 * and result are printed and the payout awaited. Returns how the bet was paid out.
 */
async function appealRuling(
  api: Api,
  players: Record<'A' | 'B', Player>,
  betId: string,
  timeoutMs: number,
  tx: (what: string, sig: string | null | undefined) => void,
): Promise<string> {
  let who: Player | null = null;
  let req: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any -- loose JSON
  for (const p of [players.A, players.B]) {
    const r = await api.get(p, `/v1/bets/${betId}/appeal`);
    if (r.status === 200) {
      who = p;
      req = r.json;
      break;
    }
    if (r.json?.error?.code !== 'NOT_LOSER')
      throw new Error(`appeal request: HTTP ${r.status} ${JSON.stringify(r.json)}`);
  }
  if (!who) throw new Error('nobody can appeal this ruling');
  const msg = new Uint8Array(Buffer.from(req.message_b64, 'base64'));
  if (sha256Hex(msg) !== req.message_sha256) throw new Error('appeal message_sha256 mismatch');
  const sig = await signBytes(who.wallet.keyPair.privateKey, msg);
  const r = must(
    await api.signed(who, 'POST', `/v1/bets/${betId}/appeal`, {
      bet_id: betId,
      kind: 'appeal',
      party: who.party,
      message_sha256: req.message_sha256,
      party_signature: b58.decode(new Uint8Array(sig)),
      method: 'faceid_hold',
      signed_at: new Date().toISOString(),
    }),
    [202],
    'appeal',
  );
  console.log(
    `appeal by ${who.party} (${who.name}): "${req.card.prompt_message}" -> ${r.status} (appeal ${r.appeal_id}, window until ${req.lifetime.valid_until})`,
  );
  tx('appeal', r.signature);

  const appealed = await until(timeoutMs, 'APPEALED', async () => {
    const st = must(await api.demo('GET', `/v1/demo/bets/${betId}`), [200], 'bet status');
    const failed = (st.chain_txs as ChainTxRow[]).find(
      (t) => t.kind === 'appeal' && t.signature === r.signature && t.status === 'failed',
    );
    if (failed) throw new Error(`the appeal tx failed: ${JSON.stringify(failed)}`);
    return ['APPEALED', 'APPEAL_RESOLVED', 'PAID', 'VOIDED'].includes(st.state) ? st : null;
  });
  console.log(`
APPEALED (appeal confirmed, state ${appealed.state}): the panel is voting`);

  // The panel: three vendors, 8 s each at most, then the AppealResult (BetSnapshot.appeal).
  const result = await until(
    timeoutMs,
    'the panel result',
    async () => {
      const snap = must(await api.get(who, `/v1/bets/${betId}`), [200], 'bet snapshot');
      return snap.appeal ?? null;
    },
    1_000, // a session GET: 120/min
  );
  for (const v of result.votes as Array<Record<string, unknown>>)
    console.log(
      `  seat ${v.seat} ${v.model}: ${v.counted_as} (${v.status}, ${v.outcome}, ${v.confidence}, ${v.latency_ms} ms)${v.reason ? ` "${v.reason}"` : ''}`,
    );
  const t = result.tally;
  console.log(
    `panel: ${result.final_outcome} by ${result.decided_by === 'majority' ? 'majority' : 'no majority, upheld'} (${t.A_WINS}-${t.B_WINS}-${t.ABSTAIN}), ${result.flipped ? 'flipped' : 'the ruling stands'}`,
  );

  const paid = await until(timeoutMs, 'PAID', async () => {
    const st = must(await api.demo('GET', `/v1/demo/bets/${betId}`), [200], 'bet status');
    if (['CANCELLED', 'EXPIRED'].includes(st.state))
      throw new Error(`bet ended ${st.state} (${st.end_reason})`);
    return ['PAID', 'VOIDED'].includes(st.state) ? st : null;
  });
  const payoutTx = lastTx(paid.chain_txs, 'resolve_appeal');
  const via = payoutTx?.status === 'confirmed' ? 'resolve_appeal' : 'other';
  console.log(`
${paid.state} via ${via} (${result.final_outcome})`);
  tx('resolve_appeal', payoutTx?.signature);
  return via;
}

/** The party whose GET /concede answers (the loser of a decisive ruling); the winner's is NOT_LOSER. */
async function ggLoser(api: Api, players: Record<'A' | 'B', Player>, betId: string) {
  for (const p of [players.A, players.B]) {
    const r = await api.get(p, `/v1/bets/${betId}/concede`);
    if (r.status === 200) return p;
    if (r.json?.error?.code !== 'NOT_LOSER')
      throw new Error(`concede request: HTTP ${r.status} ${JSON.stringify(r.json)}`);
  }
  return null;
}
