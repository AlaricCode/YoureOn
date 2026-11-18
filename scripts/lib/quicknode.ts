// QuickNode Streams REST API plumbing for scripts/qn-stream.ts (API-CONTRACT §5.1): request
// builders, the create body (infra/quicknode/stream.json + the IDL-generated filter.js), the
// webhook security token (generate / store / fingerprint, never printed), redaction of anything
// secret in what we print, and a signed probe of the deployed webhook.
//
// API: https://api.quicknode.com/streams/rest/v1/streams, header `x-api-key` (a console API key
// with Streams enabled). Endpoints (openapi.json, checked 2026-11-18): POST /streams (create),
// GET /streams?limit&offset (list), GET|PATCH|DELETE /streams/{id}, POST /streams/{id}/pause,
// POST /streams/{id}/activate, POST /streams/test_filter. The webhook destination's
// `security_token` (>= 32 chars) is optional on create (QuickNode generates one when omitted) and
// is returned in destination_attributes; we always send our own so the Fly secret can be set
// BEFORE the Stream delivers anything.
//
// The server (apps/server/src/chain/quicknode.ts) verifies every delivery with exactly that token:
//   X-QN-Signature = hex HMAC-SHA256(QN_STREAM_SECURITY_TOKEN, X-QN-Nonce ‖ X-QN-Timestamp ‖ body)
// over the decompressed body, |now − X-QN-Timestamp| ≤ 300 s. 3 failed retries auto-pause the
// Stream, so the token must be on the server first: probeWebhook() proves it is.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { buildFilterConfig, renderFilterSource } from '../../apps/server/src/chain/filter-config';
import { quickNodeSignature } from '../../apps/server/src/chain/quicknode';

export const QN_STREAMS_API = 'https://api.quicknode.com/streams/rest/v1/streams';
export const WEBHOOK_PATH = '/webhooks/quicknode';
export const DEFAULT_BASE_URL = 'https://youre-on.fly.dev';
export const DEFAULT_FLY_APP = 'youre-on';
/** Where the generated token lives (dotenv line, mode 0600): `fly secrets import < this file`. */
export const DEFAULT_TOKEN_FILE = '~/.config/solana/youre-on/qn-stream.env';
export const TOKEN_ENV = 'QN_STREAM_SECURITY_TOKEN';
export const API_KEY_ENV = 'QUICKNODE_API_KEY';
/** QuickNode's minimum security_token length. */
export const MIN_TOKEN_LENGTH = 32;

export const FILTER_PATH = fileURLToPath(
  new URL('../../infra/quicknode/filter.js', import.meta.url),
);
export const STREAM_TEMPLATE_PATH = fileURLToPath(
  new URL('../../infra/quicknode/stream.json', import.meta.url),
);

// ---- the create body ---------------------------------------------------------------------------

export interface WebhookAttributes {
  url: string;
  compression: string;
  max_retry: number;
  retry_interval_sec: number;
  post_timeout_sec: number;
  headers: Record<string, string>;
  security_token?: string;
}

export interface StreamBody {
  name: string;
  network: string;
  dataset: string;
  filter_function: string;
  filter_language: string;
  region: string;
  dataset_batch_size: number;
  elastic_batch_enabled: boolean;
  destination: 'webhook';
  destination_attributes: WebhookAttributes;
  fix_block_reorgs: number;
  keep_distance_from_tip: number;
  status: 'active' | 'paused';
}

/** filter.js with its CONFIG block regenerated from the IDL + ESCROW_ID, prettier-formatted. */
export async function renderFilterJs(src = readFileSync(FILTER_PATH, 'utf8')): Promise<string> {
  const out = renderFilterSource(src, await buildFilterConfig());
  const options = (await prettier.resolveConfig(FILTER_PATH)) ?? {};
  return prettier.format(out, { ...options, filepath: FILTER_PATH });
}

/** `https://host[/]` -> `https://host/webhooks/quicknode`; only https bases are accepted. */
export function webhookUrlOf(base: string): string {
  if (!/^https:\/\/[^/\s]+/.test(base)) throw new Error(`webhook base must be https://…: ${base}`);
  return `${base.replace(/\/+$/, '')}${WEBHOOK_PATH}`;
}

/**
 * stream.json (minus its notes) with filter_function = base64(filter.js), the webhook URL and the
 * security token filled in. `filterJs` defaults to the current, regenerated filter.js.
 */
export async function buildCreateBody(o: {
  baseUrl: string;
  /** null: omit security_token (QuickNode then generates one and returns it). */
  token: string | null;
  status?: 'active' | 'paused';
  name?: string;
  filterJs?: string;
  template?: Record<string, unknown>;
}): Promise<StreamBody> {
  if (o.token !== null) assertToken(o.token);
  const t = (o.template ?? JSON.parse(readFileSync(STREAM_TEMPLATE_PATH, 'utf8'))) as Record<
    string,
    unknown
  > & { destination_attributes: Record<string, unknown> };
  const filterJs = o.filterJs ?? (await renderFilterJs());
  const { notes: _notes, ...rest } = t;
  return {
    ...(rest as unknown as StreamBody),
    ...(o.name ? { name: o.name } : {}),
    filter_function: Buffer.from(filterJs, 'utf8').toString('base64'),
    destination: 'webhook',
    destination_attributes: {
      ...(t.destination_attributes as unknown as WebhookAttributes),
      url: webhookUrlOf(o.baseUrl),
      ...(o.token === null ? {} : { security_token: o.token }),
    },
    status: o.status ?? 'active',
  };
}

// ---- requests ----------------------------------------------------------------------------------

export interface QnRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  body?: unknown;
}

export const req = {
  create: (body: StreamBody): QnRequest => ({ method: 'POST', url: QN_STREAMS_API, body }),
  list: (limit = 100, offset = 0): QnRequest => ({
    method: 'GET',
    url: `${QN_STREAMS_API}?limit=${limit}&offset=${offset}`,
  }),
  get: (id: string): QnRequest => ({ method: 'GET', url: `${QN_STREAMS_API}/${streamId(id)}` }),
  update: (id: string, body: Partial<StreamBody>): QnRequest => ({
    method: 'PATCH',
    url: `${QN_STREAMS_API}/${streamId(id)}`,
    body,
  }),
  pause: (id: string): QnRequest => ({
    method: 'POST',
    url: `${QN_STREAMS_API}/${streamId(id)}/pause`,
  }),
  activate: (id: string): QnRequest => ({
    method: 'POST',
    url: `${QN_STREAMS_API}/${streamId(id)}/activate`,
  }),
  delete: (id: string): QnRequest => ({
    method: 'DELETE',
    url: `${QN_STREAMS_API}/${streamId(id)}`,
  }),
  testFilter: (o: {
    network: string;
    dataset: string;
    filterJs: string;
    block: number;
  }): QnRequest => ({
    method: 'POST',
    url: `${QN_STREAMS_API}/test_filter`,
    body: {
      network: o.network,
      dataset: o.dataset,
      filter_function: Buffer.from(o.filterJs, 'utf8').toString('base64'),
      filter_language: 'javascript',
      block: String(o.block),
    },
  }),
};

/** Stream ids are UUIDs; anything else would be spliced into the URL path. */
export function streamId(id: string): string {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) throw new Error(`not a stream id: ${id}`);
  return id;
}

export class QnApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    what: string,
  ) {
    super(`${what}: HTTP ${status} ${JSON.stringify(redact(body)).slice(0, 400)}`);
    this.name = 'QnApiError';
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Sends `r` with the API key; JSON (or null) on 2xx, QnApiError otherwise. */
export async function qnCall(fetchImpl: FetchLike, apiKey: string, r: QnRequest): Promise<unknown> {
  const res = await fetchImpl(r.url, {
    method: r.method,
    headers: {
      accept: 'application/json',
      'x-api-key': apiKey,
      ...(r.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    json = text.slice(0, 400);
  }
  if (!res.ok) throw new QnApiError(res.status, json, `${r.method} ${new URL(r.url).pathname}`);
  return json;
}

/** The streams of a list response, whether it is an array or `{ data: [...] }`. */
export function streamsOf(list: unknown): Record<string, unknown>[] {
  if (Array.isArray(list)) return list as Record<string, unknown>[];
  const d = (list as { data?: unknown } | null)?.data;
  return Array.isArray(d) ? (d as Record<string, unknown>[]) : [];
}

/** The security token a stream object carries (destination_attributes.security_token), if any. */
export function tokenOf(stream: unknown): string | null {
  const t = (stream as { destination_attributes?: { security_token?: unknown } } | null)
    ?.destination_attributes?.security_token;
  return typeof t === 'string' && t.length > 0 ? t : null;
}

// ---- secrets: generate, store, fingerprint, redact --------------------------------------------

export function assertToken(token: string): void {
  if (token.length < MIN_TOKEN_LENGTH || /\s/.test(token))
    throw new Error(`the security token must be >= ${MIN_TOKEN_LENGTH} non-space characters`);
}

/** 32 random bytes, hex, with QuickNode's `qn_` look (67 chars). */
export const newSecurityToken = (): string => `qn_${randomBytes(32).toString('hex')}`;

/** A non-reversible label for a token, safe to print: sha256(token)[0..12]. */
export const fingerprint = (token: string): string =>
  createHash('sha256').update(token).digest('hex').slice(0, 12);

/** Reads `QN_STREAM_SECURITY_TOKEN=<token>` (or a bare token) from `path`; null if absent. */
export function readTokenFile(path: string): string | null {
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?QN_STREAM_SECURITY_TOKEN\s*=\s*["']?([^"'\s]+)["']?\s*$/.exec(
      line,
    );
    if (m) return m[1]!;
    if (/^[^=#\s]{32,}$/.test(line.trim())) return line.trim();
  }
  return null;
}

/** Writes the token as a dotenv line (`fly secrets import < path`), dir 0700, file 0600. */
export function writeTokenFile(path: string, token: string): void {
  assertToken(token);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${TOKEN_ENV}=${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export type TokenSource = 'env' | 'file' | 'generated' | 'quicknode';

/** env QN_STREAM_SECURITY_TOKEN, else the token file, else a new token written to the file. */
export function resolveToken(
  env: Record<string, string | undefined>,
  path: string,
  o: { generate: boolean } = { generate: true },
): { token: string; source: TokenSource } | null {
  const fromEnv = env[TOKEN_ENV]?.trim();
  if (fromEnv) {
    assertToken(fromEnv);
    return { token: fromEnv, source: 'env' };
  }
  const fromFile = readTokenFile(path);
  if (fromFile) {
    assertToken(fromFile);
    return { token: fromFile, source: 'file' };
  }
  if (!o.generate) return null;
  const token = newSecurityToken();
  writeTokenFile(path, token);
  return { token, source: 'generated' };
}

/** A deep copy safe to print: security tokens fingerprinted, filter_function summarized. */
export function redact(v: unknown, o: { full?: boolean } = {}): unknown {
  if (Array.isArray(v)) return v.map((x) => redact(x, o));
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (/token|secret|api[-_]?key|password/i.test(k) && typeof x === 'string')
      out[k] = `<redacted sha256:${fingerprint(x)}>`;
    else if (k === 'filter_function' && typeof x === 'string' && !o.full)
      out[k] =
        `<base64 filter.js: ${x.length} chars, sha256:${createHash('sha256').update(x).digest('hex').slice(0, 12)}>`;
    else out[k] = redact(x, o);
  }
  return out;
}

/** How a request is shown by --dry-run (the API key is never printed). */
export function describeRequest(r: QnRequest, o: { full?: boolean } = {}): string {
  const lines = [
    `${r.method} ${r.url}`,
    `x-api-key: <$${API_KEY_ENV}>`,
    'accept: application/json',
  ];
  if (r.body !== undefined) {
    lines.push('content-type: application/json', '', JSON.stringify(redact(r.body, o), null, 2));
  }
  return lines.join('\n');
}

// ---- the deployed webhook ----------------------------------------------------------------------

export interface ProbeResult {
  ok: boolean;
  status: number | null;
  /** what the outcome means for the Stream. */
  meaning:
    'verified' | 'token_mismatch' | 'token_unset' | 'clock_skew' | 'unreachable' | 'unexpected';
  detail: string;
}

/**
 * POSTs a delivery signed exactly like QuickNode signs (body `null` = "the filter matched
 * nothing", an empty batch) to <base>/webhooks/quicknode. 200 {ok:true} proves the server holds
 * this token; 401 = it holds another one; 404 = it holds none. Writes nothing on the server.
 */
export async function probeWebhook(
  fetchImpl: FetchLike,
  baseUrl: string,
  token: string,
  nowMs: number = Date.now(),
): Promise<ProbeResult> {
  const body = new TextEncoder().encode('null');
  const nonce = randomBytes(16).toString('hex');
  const ts = String(Math.floor(nowMs / 1000));
  let res: Response;
  try {
    res = await fetchImpl(webhookUrlOf(baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qn-nonce': nonce,
        'x-qn-timestamp': ts,
        'x-qn-signature': quickNodeSignature(token, nonce, ts, body),
      },
      body,
    });
  } catch (e) {
    return {
      ok: false,
      status: null,
      meaning: 'unreachable',
      detail: String((e as Error).message ?? e),
    };
  }
  const text = (await res.text()).slice(0, 300);
  if (res.status === 200 && /"ok"\s*:\s*true/.test(text))
    return { ok: true, status: 200, meaning: 'verified', detail: text };
  if (res.status === 401)
    return {
      ok: false,
      status: 401,
      // the server's reject reason (chain/routes.ts): 'stale' = X-QN-Timestamp outside 300 s
      meaning: /"reason"\s*:\s*"stale"/.test(text) ? 'clock_skew' : 'token_mismatch',
      detail: text,
    };
  if (res.status === 404) return { ok: false, status: 404, meaning: 'token_unset', detail: text };
  return { ok: false, status: res.status, meaning: 'unexpected', detail: text };
}

/** The operator's next step for a failed probe (printed; never contains the token). */
export function probeAdvice(p: ProbeResult, flyApp: string, tokenFile: string): string {
  const set = `fly secrets import -a ${flyApp} < ${tokenFile}`;
  switch (p.meaning) {
    case 'verified':
      return 'the server verifies this token';
    case 'token_mismatch':
      return `the server holds a DIFFERENT ${TOKEN_ENV} (401). Set it: ${set}  (or pass --fly-app ${flyApp})`;
    case 'clock_skew':
      return "the server rejected the timestamp (> 300 s skew): fix this machine's clock and probe again";
    case 'token_unset':
      return `the server has no ${TOKEN_ENV} (404). Set it: ${set}  (or pass --fly-app ${flyApp})`;
    case 'unreachable':
      return `the webhook is unreachable (${p.detail}); is the server deployed?`;
    case 'unexpected':
      return `unexpected answer HTTP ${p.status}: ${p.detail}`;
  }
}

/** A short, secret-free summary line of a stream object. */
export function summarize(s: Record<string, unknown>): string {
  const da = (s['destination_attributes'] ?? {}) as Record<string, unknown>;
  const tok = tokenOf(s);
  return [
    String(s['id'] ?? '?'),
    `"${String(s['name'] ?? '')}"`,
    String(s['status'] ?? '?'),
    `${String(s['network'] ?? '?')}/${String(s['dataset'] ?? '?')}`,
    `-> ${String(da['url'] ?? '?')}`,
    tok ? `token sha256:${fingerprint(tok)}` : 'no token in response',
  ].join('  ');
}

// ---- flows (the CLI is a thin wrapper; tests drive these against a fake Streams API) -----------

export interface StreamIo {
  /** Used for both the QuickNode API and the deployed webhook. */
  fetch: FetchLike;
  apiKey: string;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  /** Sets the Fly secret (scripts/qn-stream.ts: `fly secrets import`, token on stdin). */
  flyImport?: (app: string, token: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Probes until the server verifies `token` or `waitSecs` ran out (every 3 s). */
export async function probeUntil(
  io: Pick<StreamIo, 'fetch' | 'log' | 'sleep' | 'now'>,
  baseUrl: string,
  token: string,
  waitSecs: number,
): Promise<ProbeResult> {
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + waitSecs * 1000;
  for (;;) {
    const p = await probeWebhook(io.fetch, baseUrl, token, now());
    if (p.ok || now() >= deadline) return p;
    io.log(`  webhook: ${p.meaning} (HTTP ${p.status ?? '-'}), retrying…`);
    await sleep(3_000);
  }
}

export const tokenLine = (source: TokenSource, token: string, file: string): string =>
  `security token: sha256:${fingerprint(token)} (${source === 'env' ? `from $${TOKEN_ENV}` : `${source}, in ${file}`})`;

export interface CreateOptions {
  baseUrl: string;
  tokenFile: string;
  flyApp?: string;
  name?: string;
  paused?: boolean;
  replace?: boolean;
  skipProbe?: boolean;
  /** default 0; 120 when flyApp is set (the machines restart after a secret change). */
  probeWaitSecs?: number;
  /**
   * Let QuickNode generate the token (send none), then save the returned one, set the Fly secret
   * (with flyApp) and probe before activating. A fallback in case a client-supplied token is ever
   * refused on create.
   */
  quicknodeToken?: boolean;
  /** For tests: the filter source to upload (default: the regenerated filter.js). */
  filterJs?: string;
}

/**
 * The activation flow: token -> (Fly secret) -> webhook probe -> no duplicate name -> create
 * PAUSED with our token -> the returned token must equal ours -> activate (unless paused).
 * Throws, leaving nothing half-active, whenever a step would make the Stream deliver to a server
 * that rejects it.
 */
export async function createStream(
  io: StreamIo,
  o: CreateOptions,
): Promise<{ id: string; stream: Record<string, unknown>; tokenFingerprint: string }> {
  const call = (r: QnRequest) => qnCall(io.fetch, io.apiKey, r);
  const flyApp = o.flyApp ?? DEFAULT_FLY_APP;
  const setSecret = async (token: string) => {
    if (!o.flyApp) return;
    if (!io.flyImport) throw new Error('--fly-app needs the fly CLI');
    await io.flyImport(o.flyApp, token);
  };
  const verified = async (token: string): Promise<boolean> => {
    if (o.skipProbe) return true;
    const p = await probeUntil(io, o.baseUrl, token, o.probeWaitSecs ?? (o.flyApp ? 120 : 0));
    io.log(`webhook probe: ${probeAdvice(p, flyApp, o.tokenFile)}`);
    return p.ok;
  };

  // 1. our token on the server first (so nothing the Stream sends is ever rejected)
  let ours: string | null = null;
  if (!o.quicknodeToken) {
    const tok = resolveToken(io.env, o.tokenFile)!;
    io.log(tokenLine(tok.source, tok.token, o.tokenFile));
    await setSecret(tok.token);
    if (!(await verified(tok.token)) && !o.paused)
      throw new Error(
        'the server does not verify this token yet: fix that first (or create it --paused, or --skip-probe)',
      );
    ours = tok.token;
  }

  // 2. one Stream per name, created PAUSED
  const body = await buildCreateBody({
    baseUrl: o.baseUrl,
    token: ours,
    status: 'paused',
    name: o.name,
    filterJs: o.filterJs,
  });
  const same = streamsOf(await call(req.list())).filter((s) => s['name'] === body.name);
  if (same.length && !o.replace)
    throw new Error(
      `a Stream named "${body.name}" already exists (${same.map((s) => String(s['id'])).join(', ')}). ` +
        'Resume it (npm run qn-stream -- resume <id>) or pass --replace.',
    );
  const deleteOld = async () => {
    for (const s of same) {
      io.log(`deleting the old Stream ${String(s['id'])} (--replace)`);
      await call(req.delete(String(s['id'])));
    }
    same.length = 0;
  };
  // --replace creates the new Stream FIRST, so a refused create never leaves us with none. Only
  // if QuickNode refuses a second Stream of that name is the old one deleted before retrying.
  let created: Record<string, unknown>;
  try {
    created = (await call(req.create(body))) as Record<string, unknown>;
  } catch (e) {
    const nameTaken =
      e instanceof QnApiError &&
      (e.status === 409 || (e.status < 500 && /exist|duplicate|already|unique/i.test(e.message)));
    if (!same.length || !nameTaken) throw e; // a bad body: the old Stream stays untouched
    io.log(`create refused next to the old Stream (HTTP ${e.status}); replacing it instead`);
    await deleteOld();
    created = (await call(req.create(body))) as Record<string, unknown>;
  }
  const id = typeof created['id'] === 'string' ? created['id'] : '';
  if (!id) throw new Error(`create returned no id: ${JSON.stringify(redact(created))}`);
  io.log(`created ${id} (paused)`);
  await deleteOld();

  // 3. the token the Stream will sign with must be the one the server verifies
  const returned = tokenOf(created);
  let token = ours;
  if (o.quicknodeToken) {
    if (!returned)
      throw new Error(`QuickNode returned no security_token for ${id}; it stays paused`);
    writeTokenFile(o.tokenFile, returned);
    io.log(tokenLine('quicknode', returned, o.tokenFile));
    await setSecret(returned);
    token = returned;
    if (!(await verified(returned)) && !o.paused)
      throw new Error(
        `the server does not verify the Stream's token yet; ${id} stays paused. ` +
          `Set it (fly secrets import -a ${flyApp} < ${o.tokenFile}), then: npm run qn-stream -- resume ${id}`,
      );
  } else if (returned && returned !== ours) {
    // QuickNode replaced our token: keep theirs (the Stream signs with it) and stay paused.
    writeTokenFile(o.tokenFile, returned);
    throw new Error(
      `QuickNode returned a different security token (sha256:${fingerprint(returned)}), saved to ${o.tokenFile}. ` +
        `The Stream stays paused: set the Fly secret (fly secrets import -a ${flyApp} < ${o.tokenFile}), ` +
        `then: npm run qn-stream -- resume ${id}`,
    );
  }

  // 4. deliver
  if (!o.paused) {
    await call(req.activate(id));
    io.log(`activated ${id}`);
  }
  const stream = (await call(req.get(id))) as Record<string, unknown>;
  return { id, stream, tokenFingerprint: fingerprint(token!) };
}

/** Activates `id` after proving the server verifies its token (unless skipProbe). */
export async function resumeStream(
  io: StreamIo,
  id: string,
  o: Pick<CreateOptions, 'baseUrl' | 'tokenFile' | 'flyApp' | 'skipProbe' | 'probeWaitSecs'>,
): Promise<Record<string, unknown>> {
  const call = (r: QnRequest) => qnCall(io.fetch, io.apiKey, r);
  const stream = (await call(req.get(id))) as Record<string, unknown>;
  const token = tokenOf(stream) ?? resolveToken(io.env, o.tokenFile, { generate: false })?.token;
  if (token && o.flyApp) {
    if (!io.flyImport) throw new Error('--fly-app needs the fly CLI');
    await io.flyImport(o.flyApp, token);
  }
  if (!o.skipProbe) {
    if (!token) io.log('webhook probe skipped: no token known (pass --token-file or set the env)');
    else {
      const p = await probeUntil(io, o.baseUrl, token, o.probeWaitSecs ?? (o.flyApp ? 120 : 0));
      io.log(`webhook probe: ${probeAdvice(p, o.flyApp ?? DEFAULT_FLY_APP, o.tokenFile)}`);
      if (!p.ok) throw new Error('not resuming: the server would reject the deliveries');
    }
  }
  await call(req.activate(id));
  return (await call(req.get(id))) as Record<string, unknown>;
}
