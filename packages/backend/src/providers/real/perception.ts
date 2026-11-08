/**
 * Real perception (§6.0). Both modes cost money and refuse to run unless
 * ALLOW_SPEND=1.
 *  - http: io.net / cloud fallback speaking the §6.0 job API at PERCEPTION_URL
 *    (implemented here: POST /jobs ×2, poll GET /jobs/:id, fetch detections).
 *  - nosana: posts the services/perception container as two Nosana jobs.
 *    TODO(perception agent): Nosana job submission; reuse runJobPair.
 */
import { randomBytes } from 'node:crypto';
import type { PerceptionJobRequest, PerceptionJobStatus, RawDetection } from '@verdict/engine';
import { assertSpendAllowed } from '../../config/spend.js';
import type { Config } from '../../config/load.js';
import { NotImplementedError } from '../../errors.js';
import type { PerceptionHostResult, PerceptionProvider, PerceptionRequest } from '../types.js';

export type FetchFn = typeof fetch;

export interface HttpPerceptionOptions {
  baseUrl: string;
  fetch?: FetchFn;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

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

  async runPair(req: PerceptionRequest): Promise<{ a: PerceptionHostResult; b: PerceptionHostResult }> {
    const body = (): PerceptionJobRequest => ({
      bet: req.bet,
      job_nonce: randomBytes(16).toString('hex'),
      fps: 10,
      offset_ms: req.offset_ms,
      video_urls: req.video_urls,
      prompts: req.prompts,
      entity_refs: req.calibration?.scene.entity_refs ?? [],
      need_pose: req.need_pose,
      need_reid: req.need_reid,
    });
    const [j1, j2] = await Promise.all([this.submit(body()), this.submit(body())]);
    // Host A = the job that reports done first.
    const p1 = this.waitDone(j1).then((s) => ({ id: j1, s }));
    const p2 = this.waitDone(j2).then((s) => ({ id: j2, s }));
    const first = await Promise.race([p1, p2]);
    const second = await (first.id === j1 ? p2 : p1);
    return { a: await this.collect(first.s), b: await this.collect(second.s) };
  }

  private async submit(body: PerceptionJobRequest): Promise<string> {
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
    const deadline = Date.now() + (this.opts.timeoutMs ?? 30 * 60_000);
    for (;;) {
      const r = await this.f(`${this.opts.baseUrl}/jobs/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`perception: GET /jobs/${id} → HTTP ${r.status}`);
      const s = (await r.json()) as PerceptionJobStatus;
      if (s.status === 'done') return s;
      if (s.status === 'failed') throw new Error(`perception job ${id} failed`);
      if (Date.now() > deadline) throw new Error(`perception job ${id} timed out`);
      await new Promise((res) => setTimeout(res, this.opts.pollIntervalMs ?? 5_000));
    }
  }

  private async collect(s: PerceptionJobStatus): Promise<PerceptionHostResult> {
    const r = await this.f(s.detections_url);
    if (!r.ok) throw new Error(`perception: detections → HTTP ${r.status}`);
    return {
      host: { provider: s.host.provider, job_id: s.host.job_id, url: s.host.url ?? null, market: s.host.market ?? null },
      network: 'mainnet',
      model_hash: s.model_hash,
      flags: s.flags,
      raw: parseDetectionsJsonl(await r.text()),
      session: null,
    };
  }
}

export class NosanaPerception implements PerceptionProvider {
  readonly name = 'nosana';
  constructor(cfg: Pick<Config, 'allowSpend' | 'apiKeys'>) {
    assertSpendAllowed(cfg, 'PERCEPTION_PROVIDER=nosana');
    if (!cfg.apiKeys.nosana) throw new Error('PERCEPTION_PROVIDER=nosana requires NOSANA_API_KEY');
  }
  async runPair(): Promise<{ a: PerceptionHostResult; b: PerceptionHostResult }> {
    throw new NotImplementedError('PERCEPTION_PROVIDER=nosana');
  }
}
