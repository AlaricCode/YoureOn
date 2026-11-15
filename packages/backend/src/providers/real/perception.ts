/**
 * Real perception (§6.0). Both modes cost money and refuse to run unless
 * ALLOW_SPEND=1 (assertSpendAllowed in the constructors).
 *
 *  - http: io.net / any GPU host running services/perception in server mode,
 *    speaking the §6.0 job API at PERCEPTION_URL (POST /jobs ×2, poll
 *    GET /jobs/:id, fetch the detections JSONL). This is the working real path.
 *  - nosana: the same services/perception image (pinned by digest,
 *    NOSANA_PERCEPTION_IMAGE) posted as two Nosana jobs through the Nosana
 *    API with NOSANA_API_KEY (no wallet signing). Each job runs the worker in
 *    one-shot mode: the §6.0 PerceptionJobRequest is passed as env
 *    `VERDICT_JOB` (base64 JSON) and the worker POSTs its result
 *    `{model_hash, flags, frame, detections_jsonl}` to a signed, expiring
 *    backend URL (`VERDICT_RESULT_URL`, routes/lifecycle.ts
 *    /v1/media/perception/...). The two jobs go to two markets
 *    (NOSANA_MARKETS) and must run on two different nodes, else the pair fails
 *    (the cross-check needs independent hosts, §5.5).
 *
 * Both adapters share `runJobPair`: one fresh job_nonce per job, host A = the
 * job that finishes first.
 */
import { randomBytes } from 'node:crypto';
import type { PerceptionJobRequest, PerceptionJobStatus, RawDetection } from '@verdict/engine';
import { assertSpendAllowed } from '../../config/spend.js';
import type { Config } from '../../config/load.js';
import type { PerceptionHostResult, PerceptionProvider, PerceptionRequest } from '../types.js';

export type FetchFn = typeof fetch;

/** Default 30-minute deadline per job (§6.0). */
export const PERCEPTION_JOB_TIMEOUT_MS = 30 * 60_000;

/** §6.0 job body plus the backend's optional extension (CONTRACTS-ERRATA backend-audit-faces). */
export type PerceptionJobBody = PerceptionJobRequest & { need_faces?: boolean };

/** Parses RawDetection JSON Lines (§6.1); blank lines ignored. */
export function parseDetectionsJsonl(text: string): RawDetection[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l) as RawDetection;
      } catch {
        throw new Error(`detections line ${i + 1}: invalid JSON`);
      }
    });
}

/** The §6.0 job body for one job (fresh nonce each call). */
export function jobBody(req: PerceptionRequest): PerceptionJobBody {
  return {
    bet: req.bet,
    job_nonce: randomBytes(16).toString('hex'),
    fps: 10,
    offset_ms: req.offset_ms,
    video_urls: req.video_urls,
    prompts: req.prompts,
    entity_refs: req.calibration?.scene.entity_refs ?? [],
    need_pose: req.need_pose,
    need_reid: req.need_reid,
    need_faces: req.need_faces ?? false,
  };
}

/**
 * Runs two jobs of the same request and returns host A = the first to
 * finish, host B = the other. `submit` gets a body with a fresh job_nonce.
 */
export async function runJobPair<J, S>(
  req: PerceptionRequest,
  ops: {
    submit: (body: PerceptionJobBody, which: 0 | 1) => Promise<J>;
    waitDone: (job: J) => Promise<S>;
    collect: (job: J, status: S) => Promise<PerceptionHostResult>;
    /** optional check over both finished jobs (e.g. distinct hosts) */
    verify?: (a: { job: J; status: S }, b: { job: J; status: S }) => void | Promise<void>;
  },
): Promise<{ a: PerceptionHostResult; b: PerceptionHostResult }> {
  const [j1, j2] = await Promise.all([ops.submit(jobBody(req), 0), ops.submit(jobBody(req), 1)]);
  const p1 = ops.waitDone(j1).then((s) => ({ job: j1, status: s }));
  const p2 = ops.waitDone(j2).then((s) => ({ job: j2, status: s }));
  // Keep a rejection of the slower job from becoming unhandled while we await the first.
  p1.catch(() => undefined);
  p2.catch(() => undefined);
  const first = await Promise.race([p1, p2]);
  const second = await (first.job === j1 ? p2 : p1);
  await ops.verify?.(first, second);
  return { a: await ops.collect(first.job, first.status), b: await ops.collect(second.job, second.status) };
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Optional decoded frame size on a job status (§6.0 extension). */
function frameOf(x: unknown): { width_px: number; height_px: number } | undefined {
  const f = (x as { frame?: { width_px?: unknown; height_px?: unknown } } | null)?.frame;
  if (!f || !Number.isSafeInteger(f.width_px) || !Number.isSafeInteger(f.height_px)) return undefined;
  if ((f.width_px as number) <= 0 || (f.height_px as number) <= 0) return undefined;
  return { width_px: f.width_px as number, height_px: f.height_px as number };
}

// ---- http (§6.0 job API) ---------------------------------------------------------------

export interface HttpPerceptionOptions {
  baseUrl: string;
  fetch?: FetchFn;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export class HttpPerception implements PerceptionProvider {
  readonly name: string = 'http';
  private readonly f: FetchFn;

  constructor(
    cfg: Pick<Config, 'allowSpend'>,
    private readonly opts: HttpPerceptionOptions,
  ) {
    assertSpendAllowed(cfg, 'PERCEPTION_PROVIDER=http');
    if (!opts.baseUrl) throw new Error('PERCEPTION_PROVIDER=http requires PERCEPTION_URL');
    this.f = opts.fetch ?? fetch;
  }

  runPair(req: PerceptionRequest): Promise<{ a: PerceptionHostResult; b: PerceptionHostResult }> {
    return runJobPair<string, PerceptionJobStatus>(req, {
      submit: (body) => this.submit(body),
      waitDone: (id) => this.waitDone(id),
      collect: (_id, s) => this.collect(s),
    });
  }

  private async submit(body: PerceptionJobBody): Promise<string> {
    const r = await this.f(`${this.opts.baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`perception: POST /jobs → HTTP ${r.status}`);
    const j = (await r.json()) as { job_id?: unknown };
    if (typeof j.job_id !== 'string') throw new Error('perception: job_id missing');
    return j.job_id;
  }

  private async waitDone(id: string): Promise<PerceptionJobStatus> {
    const deadline = Date.now() + (this.opts.timeoutMs ?? PERCEPTION_JOB_TIMEOUT_MS);
    for (;;) {
      const r = await this.f(`${this.opts.baseUrl}/jobs/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`perception: GET /jobs/${id} → HTTP ${r.status}`);
      const s = (await r.json()) as PerceptionJobStatus;
      if (s.status === 'done') return s;
      if (s.status === 'failed') throw new Error(`perception job ${id} failed`);
      if (Date.now() > deadline) throw new Error(`perception job ${id} timed out`);
      await sleep(this.opts.pollIntervalMs ?? 5_000);
    }
  }

  private async collect(s: PerceptionJobStatus): Promise<PerceptionHostResult> {
    const r = await this.f(s.detections_url);
    if (!r.ok) throw new Error(`perception: detections → HTTP ${r.status}`);
    const frame = frameOf(s);
    return {
      host: { provider: s.host.provider, job_id: s.host.job_id, url: s.host.url ?? null, market: s.host.market ?? null },
      network: 'mainnet',
      model_hash: s.model_hash,
      flags: s.flags,
      raw: parseDetectionsJsonl(await r.text()),
      session: null,
      ...(frame ? { frame } : {}),
    };
  }
}

// ---- nosana ----------------------------------------------------------------------------

/** What a one-shot worker uploads to its signed result URL. */
export interface PerceptionUpload {
  model_hash: string;
  flags: number;
  frame?: { width_px: number; height_px: number };
  /** RawDetection JSON Lines (§6.1) */
  detections_jsonl: string;
}

/** Backend-side store of one-shot worker results (signed upload URLs, routes/lifecycle.ts). */
export interface PerceptionResultSink {
  /** Signed, expiring URL the worker POSTs its PerceptionUpload to. */
  uploadUrl(bet: string, jobNonce: string): string;
  /** The uploaded result, or null if none arrived (yet). */
  take(bet: string, jobNonce: string): PerceptionUpload | null;
}

export const NOSANA_DEFAULT_API_URL = 'https://dashboard.k8s.prd.nos.ci/api';
export const NOSANA_EXPLORER_JOB_URL = 'https://dashboard.nosana.com/jobs/';
/** services/perception listens here in server mode (exposed for debugging; results go to the sink). */
export const PERCEPTION_PORT = 8092;

export interface NosanaPerceptionOptions {
  /** services/perception image pinned by digest (`…@sha256:…`) */
  image: string;
  /** one market per job; a single entry is used for both (node distinctness still enforced) */
  markets: string[];
  apiUrl?: string;
  fetch?: FetchFn;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** after a job COMPLETED, how long to wait for its upload */
  uploadGraceMs?: number;
}

interface NosanaJob {
  address: string;
  market: string;
  nonce: string;
  bet: string;
}

/** Nosana job record as returned by GET /jobs/:address (fields the adapter reads). */
interface NosanaJobState {
  state: string;
  node?: string | null;
  market?: string | null;
}

/**
 * Nosana job definition (container/run op) for one perception job: GPU,
 * the request in env, the result upload URL, port exposed for debugging.
 */
export function nosanaJobDefinition(image: string, body: PerceptionJobBody, resultUrl: string): Record<string, unknown> {
  return {
    version: '0.1',
    type: 'container',
    meta: { trigger: 'api', system_requirements: { required_vram: 24 } },
    ops: [
      {
        type: 'container/run',
        id: 'verdict-perception',
        args: {
          image,
          gpu: true,
          expose: PERCEPTION_PORT,
          cmd: ['python', '-m', 'perception.oneshot'],
          env: {
            VERDICT_JOB: Buffer.from(JSON.stringify(body)).toString('base64'),
            VERDICT_RESULT_URL: resultUrl,
          },
        },
      },
    ],
  };
}

export class NosanaPerception implements PerceptionProvider {
  readonly name = 'nosana';
  private readonly f: FetchFn;
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private sink: PerceptionResultSink | null = null;

  constructor(
    cfg: Pick<Config, 'allowSpend' | 'apiKeys'>,
    private readonly opts: NosanaPerceptionOptions,
  ) {
    assertSpendAllowed(cfg, 'PERCEPTION_PROVIDER=nosana');
    if (!cfg.apiKeys.nosana) throw new Error('PERCEPTION_PROVIDER=nosana requires NOSANA_API_KEY');
    if (!/@sha256:[0-9a-f]{64}$/.test(opts.image)) throw new Error('PERCEPTION_PROVIDER=nosana requires NOSANA_PERCEPTION_IMAGE pinned by digest (…@sha256:<64 hex>)');
    if (opts.markets.length < 1 || opts.markets.length > 2) throw new Error('PERCEPTION_PROVIDER=nosana requires NOSANA_MARKETS (1 or 2 market addresses)');
    this.apiKey = cfg.apiKeys.nosana;
    this.apiUrl = (opts.apiUrl || NOSANA_DEFAULT_API_URL).replace(/\/+$/, '');
    this.f = opts.fetch ?? fetch;
  }

  /** Wired by createContext (the sink needs the blob store and the media key). */
  attachResultSink(sink: PerceptionResultSink): void {
    this.sink = sink;
  }

  runPair(req: PerceptionRequest): Promise<{ a: PerceptionHostResult; b: PerceptionHostResult }> {
    const sink = this.sink;
    if (!sink) throw new Error('nosana perception: no result sink attached');
    return runJobPair<NosanaJob, NosanaJobState>(req, {
      submit: (body, which) => this.submit(body, which, sink),
      waitDone: (job) => this.waitDone(job),
      verify: (a, b) => {
        const na = a.status.node ?? null;
        const nb = b.status.node ?? null;
        if (!na || !nb || na === nb) throw new Error(`nosana: both perception jobs ran on node ${na ?? '?'}; independent hosts required`);
      },
      collect: (job, st) => this.collect(job, st, sink),
    });
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` };
  }

  private async submit(body: PerceptionJobBody, which: 0 | 1, sink: PerceptionResultSink): Promise<NosanaJob> {
    const market = this.opts.markets[which] ?? this.opts.markets[0]!;
    const def = nosanaJobDefinition(this.opts.image, body, sink.uploadUrl(body.bet, body.job_nonce));
    const r = await this.f(`${this.apiUrl}/jobs/create-with-credits`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ market, jobDefinition: def }),
    });
    if (!r.ok) throw new Error(`nosana: create job → HTTP ${r.status}`);
    const j = (await r.json()) as { job?: unknown; address?: unknown };
    const address = typeof j.job === 'string' ? j.job : typeof j.address === 'string' ? j.address : null;
    if (!address) throw new Error('nosana: job address missing in create response');
    return { address, market, nonce: body.job_nonce, bet: body.bet };
  }

  private async waitDone(job: NosanaJob): Promise<NosanaJobState> {
    const deadline = Date.now() + (this.opts.timeoutMs ?? PERCEPTION_JOB_TIMEOUT_MS);
    for (;;) {
      const r = await this.f(`${this.apiUrl}/jobs/${encodeURIComponent(job.address)}`, { headers: this.headers() });
      if (!r.ok) throw new Error(`nosana: GET job ${job.address} → HTTP ${r.status}`);
      const s = (await r.json()) as NosanaJobState;
      const state = String(s.state ?? '').toUpperCase();
      if (state === 'COMPLETED') return s;
      if (state === 'FAILED' || state === 'STOPPED') throw new Error(`nosana job ${job.address} ${state}`);
      if (Date.now() > deadline) throw new Error(`nosana job ${job.address} timed out`);
      await sleep(this.opts.pollIntervalMs ?? 10_000);
    }
  }

  private async collect(job: NosanaJob, st: NosanaJobState, sink: PerceptionResultSink): Promise<PerceptionHostResult> {
    const until = Date.now() + (this.opts.uploadGraceMs ?? 60_000);
    let up = sink.take(job.bet, job.nonce);
    while (!up && Date.now() < until) {
      await sleep(Math.min(this.opts.pollIntervalMs ?? 1_000, 1_000));
      up = sink.take(job.bet, job.nonce);
    }
    if (!up) throw new Error(`nosana job ${job.address} completed without uploading detections`);
    if (!/^[0-9a-f]{64}$/.test(up.model_hash)) throw new Error(`nosana job ${job.address}: bad model_hash`);
    return {
      host: { provider: 'nosana', job_id: job.address, url: `${NOSANA_EXPLORER_JOB_URL}${job.address}`, market: st.market ?? job.market },
      network: 'mainnet',
      model_hash: up.model_hash,
      flags: up.flags,
      raw: parseDetectionsJsonl(up.detections_jsonl),
      session: null,
      ...(up.frame ? { frame: up.frame } : {}),
    };
  }
}
