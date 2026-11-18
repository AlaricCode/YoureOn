#!/usr/bin/env -S npx tsx
// Checkpoint 1 driver: the Beat 2-3 money path over the real HTTP API, with the custodial demo
// keys as the two players' wallets (decision D-A: the phones import the same demo-a / demo-b
// seeds, so this exercises exactly the keys the phones will use).
//
//   npm run cp1-drive -- [--base-url http://127.0.0.1:8080] [--admin-token <DEMO_ADMIN_TOKEN>]
//        [--keys-dir ~/.config/solana/youre-on] [--state-file <path>] [--reset] [--timeout 60]
//        [--name-a Logan] [--name-b Jake]
//
// Steps: sign up (or log in) two users whose wallet keys are demo-a / demo-b -> A creates a room,
// B joins -> A challenges B from the list (POST /v1/bets) -> B accepts the invite -> fixture terms
// (POST /v1/demo/bets/:id/terms, the same sink as propose_terms) -> confirm
// (POST /v1/demo/bets/:id/confirm = confirm_terms) -> waits for LOCKED.
// With LOCK_SIGNER=phones on the server, this script plays both phones: GET /lock, sign the
// stored message bytes with demo-a / demo-b, POST /lock/authorizations. With LOCK_SIGNER=server
// the server signs custodially and the script only waits.
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

import { expandPath, keysDirFrom, parseCli, run } from './lib/cli';
import { assertNotCommittable, loadRole } from './lib/keys';

const USAGE = `usage: npm run cp1-drive -- [--base-url <url>] [--admin-token <token>] [--keys-dir <dir>]
          [--state-file <path>] [--reset] [--timeout 60] [--name-a Logan] [--name-b Jake]
Drives challenge -> terms -> confirm -> LOCKED against a running server (DEMO_MODE=true).`;

type Device = { d: string; x: string };
type State = { A?: Device; B?: Device; base_url?: string };

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

  async call(
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const raw =
      init.body === undefined ? (method === 'GET' ? undefined : '') : JSON.stringify(init.body);
    const res = await fetch(this.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...init.headers },
      body: raw,
    });
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: res.status, json };
  }

  /** Server clock - local clock, learned from a CLOCK_SKEW answer (API-CONTRACT §1.3: ±60 s). */
  private skewMs = 0;

  /** A §1.3 signed write as `who`; retried once with the server's clock after CLOCK_SKEW. */
  async signed(who: Player, method: string, path: string, body?: unknown) {
    const r = await this.signedOnce(who, method, path, body);
    const serverTime = r.json?.error?.details?.server_time;
    if (r.status === 401 && r.json?.error?.code === 'CLOCK_SKEW' && serverTime) {
      this.skewMs = Date.parse(serverTime) - Date.now();
      console.log(
        `  (clock skew ${Math.round(this.skewMs / 1000)} s vs the server; using its clock)`,
      );
      return this.signedOnce(who, method, path, body);
    }
    return r;
  }

  private signedOnce(who: Player, method: string, path: string, body?: unknown) {
    const raw = body === undefined ? '' : JSON.stringify(body);
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
      body,
      headers: {
        Authorization: `Bearer ${who.session.token}`,
        'X-YO-Device': who.session.device_id,
        'X-YO-Timestamp': ts,
        'Idempotency-Key': idem,
        'X-YO-Signature': Buffer.from(deviceSign(who.device, str)).toString('base64url'),
      },
    });
  }

  get(who: Player, path: string) {
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

type Player = {
  party: 'A' | 'B';
  name: string;
  wallet: KeyPairSigner;
  device: Device;
  session: Session;
};

function must<T>(r: { status: number; json: T }, ok: number[], what: string): T {
  if (!ok.includes(r.status))
    throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
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
    const ch = must(
      await api.call('POST', '/v1/auth/challenge', {
        body: { device_pubkey: devicePubkey(stored) },
      }),
      [200],
      'challenge',
    );
    const msg = authChallengeMessage({
      purpose: 'login',
      nonce: ch.nonce,
      device_pubkey: devicePubkey(stored),
      wallet_pubkey: null,
    });
    const r = await api.call('POST', '/v1/auth/session', {
      body: {
        challenge_id: ch.challenge_id,
        device_pubkey: devicePubkey(stored),
        device_sig: b64(deviceSign(stored, msg)),
      },
    });
    if (r.status === 200) return { device: stored, session: r.json as Session, fresh: false };
    console.log(
      `  ${party}: stored device login failed (${r.status} ${r.json?.error?.code}); signing up again`,
    );
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

run(async () => {
  const { values } = parseCli(USAGE, {
    'base-url': { type: 'string' },
    'admin-token': { type: 'string' },
    'state-file': { type: 'string' },
    reset: { type: 'boolean' },
    timeout: { type: 'string' },
    'name-a': { type: 'string' },
    'name-b': { type: 'string' },
  });
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
  }

  const health = must(
    await api.demo('GET', '/v1/demo/health'),
    [200],
    'demo health (DEMO_MODE + admin token?)',
  );
  console.log(
    `server ${base}: chain ${health.chain_configured ? 'on' : 'OFF'}, lock signer ${health.lock_signer}, nonces free ${health.nonce_pool.free}/${health.nonce_pool.size}, fee payer ${health.fee_payer ?? '-'} (${health.fee_payer_sol ?? '?'} SOL)`,
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

  const created = await api.signed(A, 'POST', '/v1/bets', {
    room_id: room.room_id,
    opponent_user_id: B.session.user.user_id,
    challenge_method: 'list',
  });
  if (created.status === 409 && created.json?.error?.details?.reason === 'pair_busy')
    throw new Error(
      `these two already have a bet in progress (${created.json.error.details.bet_id}); re-run with --reset`,
    );
  const betId: string = must(created, [201], 'challenge').bet.bet_id;
  console.log(`bet ${betId} DRAFTING`);
  must(await api.signed(B, 'POST', `/v1/bets/${betId}/invite/accept`), [200], 'accept invite');

  const terms = must(
    await api.demo('POST', `/v1/demo/bets/${betId}/terms`, {}),
    [200],
    'fixture terms',
  );
  console.log(`terms ${terms.code} (${terms.terms_hash}) TERMS_PROPOSED: "${terms.say}"`);
  const conf = must(await api.demo('POST', `/v1/demo/bets/${betId}/confirm`), [200], 'confirm');
  console.log(`confirm: ${conf.say}`);

  const t0 = Date.now();
  let signedPhones = false;
  for (;;) {
    const st = must(await api.demo('GET', `/v1/demo/bets/${betId}`), [200], 'bet status');
    if (st.state === 'LOCKED') {
      const lock = st.chain_txs.find((t: { kind: string }) => t.kind === 'atomic_lock');
      console.log(`\nLOCKED in ${Date.now() - t0} ms after confirm. lock tx ${lock?.signature}`);
      console.log(`  pending_sig ${st.pending_sig} (onchain_pending ${st.onchain_pending})`);
      if (health.rpc?.includes('devnet') || health.rpc?.includes('quiknode'))
        console.log(`  https://explorer.solana.com/tx/${lock?.signature}?cluster=devnet`);
      return;
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
});
