// scripts/qn-stream.ts plumbing (scripts/lib/quicknode.ts), no DB and no network: the create
// body (stream.json + the IDL-generated filter.js + OUR security token), secret handling (token
// file 0600, fingerprints only, redaction), the signed webhook probe against the REAL
// POST /webhooks/quicknode route (so the token QuickNode signs with is provably the one
// apps/server/src/chain/quicknode.ts verifies), and the create / resume flows against an
// in-memory fake of the QuickNode Streams REST API.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '@youre-on/db';
import {
  buildCreateBody,
  createStream,
  describeRequest,
  fingerprint,
  FILTER_PATH,
  newSecurityToken,
  probeWebhook,
  QnApiError,
  qnCall,
  readTokenFile,
  redact,
  req,
  resolveToken,
  resumeStream,
  STREAM_TEMPLATE_PATH,
  streamId,
  streamsOf,
  webhookUrlOf,
  writeTokenFile,
  type FetchLike,
  type StreamIo,
} from '../../../scripts/lib/quicknode';
import { buildApp } from '../src/app';
import type { App, AppDeps } from '../src/context';
import { createChainRoutes } from '../src/chain/routes';
import { createDeps } from '../src/server';
import { testEnv } from './helpers';

const API_KEY = 'qn-console-key-' + randomBytes(8).toString('hex');
const BASE = 'https://youre-on.test';
const FILTER_JS = readFileSync(FILTER_PATH, 'utf8');
const tmp = () => mkdtempSync(join(tmpdir(), 'qn-stream-'));

/** An in-memory QuickNode Streams REST API (the subset qn-stream uses). */
class FakeStreams {
  streams = new Map<string, Record<string, unknown>>();
  calls: { method: string; path: string; body: unknown }[] = [];
  /** Makes create answer with a different security_token (QuickNode replaced ours). */
  replaceToken: string | null = null;
  listShape: 'data' | 'array' = 'data';

  async handle(u: URL, init: RequestInit): Promise<Response> {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    this.calls.push({ method, path: u.pathname, body });
    const json = (status: number, x: unknown) =>
      new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
    if ((init.headers as Record<string, string>)['x-api-key'] !== API_KEY)
      return json(401, { message: 'invalid api key' });
    const m = /^\/streams\/rest\/v1\/streams(?:\/([^/]+))?(?:\/(pause|activate))?$/.exec(
      u.pathname,
    );
    if (!m) return json(404, { message: 'no route' });
    const [, id, action] = m;
    if (!id && method === 'GET') {
      const all = [...this.streams.values()];
      return json(200, this.listShape === 'data' ? { data: all, pageInfo: {} } : all);
    }
    if (!id && method === 'POST') {
      const b = body as Record<string, unknown> & {
        destination_attributes: Record<string, unknown>;
      };
      const s = {
        ...b,
        id: randomUUID(),
        destination_attributes: {
          ...b.destination_attributes,
          security_token: this.replaceToken ?? b.destination_attributes['security_token'],
        },
      };
      this.streams.set(s.id, s);
      return json(201, s);
    }
    const s = id ? this.streams.get(id) : undefined;
    if (!s) return json(404, { message: 'stream not found' });
    if (action) {
      s['status'] = action === 'pause' ? 'paused' : 'active';
      return json(200, s);
    }
    if (method === 'GET') return json(200, s);
    if (method === 'DELETE') {
      this.streams.delete(id!);
      return json(200, {});
    }
    return json(405, {});
  }
}

describe('create body, requests and redaction', () => {
  it('is stream.json + base64(filter.js as committed) + the webhook URL + our token', async () => {
    const token = newSecurityToken();
    const body = await buildCreateBody({ baseUrl: `${BASE}/`, token, status: 'paused' });
    const template = JSON.parse(readFileSync(STREAM_TEMPLATE_PATH, 'utf8'));
    const { notes: _n, filter_function: _f, destination_attributes: da, ...rest } = template;
    expect(body).toMatchObject({ ...rest, status: 'paused' });
    expect(body).not.toHaveProperty('notes');
    expect(body.destination_attributes).toEqual({
      ...da,
      url: `${BASE}/webhooks/quicknode`,
      security_token: token,
    });
    // the regenerated filter equals the committed one (no CONFIG drift), byte for byte
    expect(Buffer.from(body.filter_function, 'base64').toString('utf8')).toBe(FILTER_JS);
    expect(body).toMatchObject({
      network: 'solana-devnet',
      dataset: 'block',
      destination: 'webhook',
    });
  });

  it('refuses non-https bases, short tokens and path-injecting ids', async () => {
    expect(() => webhookUrlOf('http://youre-on.fly.dev')).toThrow(/https/);
    await expect(buildCreateBody({ baseUrl: BASE, token: 'short' })).rejects.toThrow(/32/);
    expect(() => streamId('../../streams?x=1')).toThrow(/not a stream id/);
    expect(req.pause('6f9f0b8e-1111-4000-8000-000000000000')).toEqual({
      method: 'POST',
      url: 'https://api.quicknode.com/streams/rest/v1/streams/6f9f0b8e-1111-4000-8000-000000000000/pause',
    });
    expect(req.activate('6f9f0b8e-1111-4000-8000-000000000000').url).toMatch(/\/activate$/);
    expect(req.list().url).toBe(
      'https://api.quicknode.com/streams/rest/v1/streams?limit=100&offset=0',
    );
    const tf = req.testFilter({
      network: 'solana-devnet',
      dataset: 'block',
      filterJs: 'x',
      block: 7,
    });
    expect(tf.body).toMatchObject({
      block: '7',
      filter_language: 'javascript',
      filter_function: 'eA==',
    });
  });

  it('never prints the API key or the token: --dry-run output and errors are redacted', async () => {
    const token = newSecurityToken();
    const body = await buildCreateBody({ baseUrl: BASE, token });
    const shown = describeRequest(req.create(body));
    expect(shown).not.toContain(token);
    expect(shown).not.toContain(API_KEY);
    expect(shown).toContain(`<redacted sha256:${fingerprint(token)}>`);
    expect(shown).toMatch(/<base64 filter\.js: \d+ chars/);
    expect(describeRequest(req.create(body), { full: true })).toContain(body.filter_function);
    expect(JSON.stringify(redact({ a: [{ security_token: token, apiKey: API_KEY }] }))).not.toMatch(
      new RegExp(`${token}|${API_KEY}`),
    );
    const echo: FetchLike = async () =>
      new Response(
        JSON.stringify({ error: 'bad', destination_attributes: { security_token: token } }),
        {
          status: 400,
        },
      );
    const err = await qnCall(echo, API_KEY, req.create(body)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QnApiError);
    expect((err as Error).message).toMatch(/HTTP 400/);
    expect((err as Error).message).not.toContain(token);
  });

  it('streamsOf accepts an array or { data }', () => {
    expect(streamsOf([{ id: 'a' }])).toEqual([{ id: 'a' }]);
    expect(streamsOf({ data: [{ id: 'b' }] })).toEqual([{ id: 'b' }]);
    expect(streamsOf(null)).toEqual([]);
  });
});

describe('security token file', () => {
  it('writes a 0600 dotenv line (fly secrets import < file) and reads it back', () => {
    const dir = tmp();
    const file = join(dir, 'nested', 'qn-stream.env');
    const token = newSecurityToken();
    expect(token).toMatch(/^qn_[0-9a-f]{64}$/);
    writeTokenFile(file, token);
    expect(readFileSync(file, 'utf8')).toBe(`QN_STREAM_SECURITY_TOKEN=${token}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
    expect(readTokenFile(file)).toBe(token);
    expect(readTokenFile(join(dir, 'missing'))).toBeNull();
  });

  it('resolveToken: env wins, then the file, else a new one is generated into the file', () => {
    const file = join(tmp(), 'qn.env');
    expect(resolveToken({}, file, { generate: false })).toBeNull();
    const gen = resolveToken({}, file)!;
    expect(gen.source).toBe('generated');
    expect(readTokenFile(file)).toBe(gen.token);
    expect(resolveToken({}, file)).toEqual({ token: gen.token, source: 'file' });
    const env = 'e'.repeat(40);
    expect(resolveToken({ QN_STREAM_SECURITY_TOKEN: env }, file)).toEqual({
      token: env,
      source: 'env',
    });
    expect(() => resolveToken({ QN_STREAM_SECURITY_TOKEN: 'short' }, file)).toThrow(/32/);
  });
});

describe('webhook probe + flows against the real webhook route and a fake Streams API', () => {
  let h: DbHandle;
  let deps: AppDeps;
  let app: App;
  let fake: FakeStreams;
  let lines: string[];
  let flyCalls: { app: string; token: string }[];

  const fetchImpl: FetchLike = async (url, init) => {
    const u = new URL(url);
    if (u.host === 'api.quicknode.com') return fake.handle(u, init);
    if (u.host === 'youre-on.test') return app.request(u.pathname, init);
    throw new TypeError('fetch failed: getaddrinfo ENOTFOUND');
  };
  const io = (): StreamIo => ({
    fetch: fetchImpl,
    apiKey: API_KEY,
    env: {},
    log: (l) => lines.push(l),
    // the operator's `fly secrets import`: the server now holds the token
    flyImport: async (a, token) => {
      flyCalls.push({ app: a, token });
      (deps.env as { QN_STREAM_SECURITY_TOKEN?: string }).QN_STREAM_SECURITY_TOKEN = token;
    },
    sleep: async () => {},
  });
  const setServerToken = (t: string | undefined) => {
    (deps.env as { QN_STREAM_SECURITY_TOKEN?: string }).QN_STREAM_SECURITY_TOKEN = t;
  };

  beforeAll(() => {
    const env = testEnv(); // the empty batch the probe sends never touches the database
    h = createDb({ url: env.DATABASE_URL, max: 1 });
    deps = createDeps({ env, dbHandle: h, rateLimit: false }).deps;
    app = buildApp(deps, [createChainRoutes()]);
  });
  afterAll(async () => {
    await h?.close();
  });
  const reset = () => {
    fake = new FakeStreams();
    lines = [];
    flyCalls = [];
    setServerToken(undefined);
  };

  it('probe: verified / token_mismatch (401) / token_unset (404) / clock_skew / unreachable', async () => {
    reset();
    const token = newSecurityToken();
    expect((await probeWebhook(fetchImpl, BASE, token)).meaning).toBe('token_unset');
    setServerToken(token);
    expect(await probeWebhook(fetchImpl, BASE, token)).toMatchObject({
      ok: true,
      meaning: 'verified',
    });
    expect(await probeWebhook(fetchImpl, BASE, newSecurityToken())).toMatchObject({
      ok: false,
      status: 401,
      meaning: 'token_mismatch',
    });
    expect((await probeWebhook(fetchImpl, 'https://nowhere.test', token)).meaning).toBe(
      'unreachable',
    );
    // a probe older than the server's 300 s skew window is rejected like a replay
    expect((await probeWebhook(fetchImpl, BASE, token, Date.now() - 301_000)).meaning).toBe(
      'clock_skew',
    );
  });

  it('create --fly-app: token -> Fly secret -> probe -> create paused -> activate; the Stream signs with what the server verifies', async () => {
    reset();
    const file = join(tmp(), 'qn.env');
    const r = await createStream(io(), {
      baseUrl: BASE,
      tokenFile: file,
      flyApp: 'youre-on',
      filterJs: FILTER_JS,
    });
    const token = readTokenFile(file)!;
    expect(flyCalls).toEqual([{ app: 'youre-on', token }]);
    expect(fake.calls.map((c) => `${c.method} ${c.path.replace(r.id, ':id')}`)).toEqual([
      'GET /streams/rest/v1/streams',
      'POST /streams/rest/v1/streams',
      'POST /streams/rest/v1/streams/:id/activate',
      'GET /streams/rest/v1/streams/:id',
    ]);
    const created = fake.calls[1]!.body as {
      status: string;
      destination_attributes: { security_token: string; url: string };
    };
    expect(created.status).toBe('paused'); // created paused, activated only after the checks
    expect(created.destination_attributes).toMatchObject({
      security_token: token,
      url: `${BASE}/webhooks/quicknode`,
    });
    expect(deps.env.QN_STREAM_SECURITY_TOKEN).toBe(token);
    expect(r.stream['status']).toBe('active');
    expect(r.tokenFingerprint).toBe(fingerprint(token));
    // what QuickNode will now send is accepted by the server
    expect(
      (await probeWebhook(fetchImpl, BASE, created.destination_attributes.security_token)).ok,
    ).toBe(true);
    const out = lines.join('\n');
    expect(out).not.toContain(token);
    expect(out).not.toContain(API_KEY);
    expect(out).toContain('the server verifies this token');
  });

  it('without --fly-app, a server that does not hold the token stops create before anything exists', async () => {
    reset();
    const file = join(tmp(), 'qn.env');
    await expect(
      createStream(io(), { baseUrl: BASE, tokenFile: file, filterJs: FILTER_JS }),
    ).rejects.toThrow(/does not verify this token/);
    expect(fake.calls).toEqual([]);
    expect(lines.join('\n')).toContain(`fly secrets import -a youre-on < ${file}`);
    // --paused may still create it (it delivers nothing until resumed)
    const r = await createStream(io(), {
      baseUrl: BASE,
      tokenFile: file,
      paused: true,
      filterJs: FILTER_JS,
    });
    expect(r.stream['status']).toBe('paused');
    expect(fake.calls.some((c) => c.path.endsWith('/activate'))).toBe(false);
    // resume refuses while the server would reject the deliveries, then works once it holds it
    await expect(resumeStream(io(), r.id, { baseUrl: BASE, tokenFile: file })).rejects.toThrow(
      /not resuming/,
    );
    setServerToken(readTokenFile(file)!);
    const resumed = await resumeStream(io(), r.id, { baseUrl: BASE, tokenFile: file });
    expect(resumed['status']).toBe('active');
  });

  it('a Stream with the same name is refused unless --replace (which deletes it first)', async () => {
    reset();
    const file = join(tmp(), 'qn.env');
    const token = resolveToken({}, file)!.token;
    setServerToken(token);
    fake.listShape = 'array';
    const first = await createStream(io(), { baseUrl: BASE, tokenFile: file, filterJs: FILTER_JS });
    await expect(
      createStream(io(), { baseUrl: BASE, tokenFile: file, filterJs: FILTER_JS }),
    ).rejects.toThrow(/already exists/);
    const second = await createStream(io(), {
      baseUrl: BASE,
      tokenFile: file,
      replace: true,
      filterJs: FILTER_JS,
    });
    expect(fake.streams.has(first.id)).toBe(false);
    expect([...fake.streams.keys()]).toEqual([second.id]);
  });

  it('QuickNode answering with a different token: saved to the file, the Stream stays paused', async () => {
    reset();
    const file = join(tmp(), 'qn.env');
    const ours = resolveToken({}, file)!.token;
    setServerToken(ours);
    const theirs = newSecurityToken();
    fake.replaceToken = theirs;
    await expect(
      createStream(io(), { baseUrl: BASE, tokenFile: file, filterJs: FILTER_JS }),
    ).rejects.toThrow(/different security token/);
    expect(readTokenFile(file)).toBe(theirs);
    expect(fake.calls.some((c) => c.path.endsWith('/activate'))).toBe(false);
    expect([...fake.streams.values()][0]!['status']).toBe('paused');
  });

  it('a wrong API key surfaces as a QnApiError (HTTP 401) before anything is created', async () => {
    reset();
    const file = join(tmp(), 'qn.env');
    setServerToken(resolveToken({}, file)!.token);
    await expect(
      createStream(
        { ...io(), apiKey: 'wrong' },
        { baseUrl: BASE, tokenFile: file, filterJs: FILTER_JS },
      ),
    ).rejects.toThrow(/HTTP 401/);
    expect(fake.streams.size).toBe(0);
  });
});
