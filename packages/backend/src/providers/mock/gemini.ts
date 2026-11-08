/**
 * Mock Gemini prediction markets (§13 GEMINI_PROVIDER=mock): events from
 * `packages/backend/fixtures/gemini/*.json` (each file a WorldEvent or an
 * array of them); live prices are a deterministic random walk seeded by the
 * event id (§11.5). Mock hedge returns `{order_id, status: "mock"}` (§11.6).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROB_CLAMP_MAX_BPS, PROB_CLAMP_MIN_BPS } from '@verdict/engine';
import { HashPrng } from '../../util/prng.js';
import type { Clock } from '../../util/clock.js';
import type { GeminiProvider, HedgeProvider, WorldEvent, WorldPrice } from '../types.js';

export const GEMINI_FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/gemini', import.meta.url));
export const MOCK_PRICE_INTERVAL_MS = 2_000;

export function loadGeminiFixtures(dir: string = GEMINI_FIXTURES_DIR): WorldEvent[] {
  if (!existsSync(dir)) return [];
  const out: WorldEvent[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as WorldEvent | WorldEvent[];
    out.push(...(Array.isArray(j) ? j : [j]));
  }
  return out;
}

/** Deterministic price for step k of the walk for (event, contract). */
export function mockWalkPrice(eventId: string, contractId: string, startBps: number, step: number): number {
  const prng = new HashPrng(createHash('sha256').update(`walk:${eventId}:${contractId}`).digest());
  let p = startBps;
  for (let i = 0; i < step; i++) {
    p += prng.int(-150, 150);
    p = Math.min(PROB_CLAMP_MAX_BPS, Math.max(PROB_CLAMP_MIN_BPS, p));
  }
  return p;
}

export class MockGemini implements GeminiProvider {
  readonly name = 'mock';
  private readonly events: WorldEvent[];

  constructor(
    private readonly clock: Clock,
    fixtures?: WorldEvent[],
    private readonly intervalMs = MOCK_PRICE_INTERVAL_MS,
  ) {
    this.events = fixtures ?? loadGeminiFixtures();
  }

  async listEvents(q: string | null, limit: number): Promise<WorldEvent[]> {
    const needle = q?.trim().toLowerCase() ?? '';
    const hits = this.events.filter(
      (e) => !needle || e.title.toLowerCase().includes(needle) || e.category.toLowerCase().includes(needle),
    );
    return structuredClone(hits.slice(0, Math.max(0, limit)));
  }

  async getEvent(id: string): Promise<WorldEvent | null> {
    const e = this.events.find((x) => x.id === id);
    return e ? structuredClone(e) : null;
  }

  subscribePrices(eventId: string, onPrice: (p: WorldPrice) => void): () => void {
    const ev = this.events.find((x) => x.id === eventId);
    if (!ev) return () => {};
    let step = 0;
    const tick = () => {
      step++;
      for (const c of ev.contracts) {
        onPrice({ event_id: eventId, contract_id: c.id, prob_bps: mockWalkPrice(eventId, c.id, c.prob_bps, step), at_ms: this.clock.nowMs() });
      }
    };
    const t = setInterval(tick, this.intervalMs);
    t.unref();
    return () => clearInterval(t);
  }
}

export class MockHedge implements HedgeProvider {
  readonly name = 'mock';
  async placeOrder(req: Parameters<HedgeProvider['placeOrder']>[0]): Promise<{ order_id: string; status: string }> {
    const id = createHash('sha256').update(JSON.stringify(req)).digest('hex').slice(0, 16);
    return { order_id: `mock-${id}`, status: 'mock' };
  }
}
