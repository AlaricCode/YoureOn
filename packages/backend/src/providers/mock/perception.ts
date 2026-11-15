/**
 * Mock perception (§13 PERCEPTION_PROVIDER=mock):
 * `engine.simulate(program, calibration, MOCK_SCENARIO, seed)`; host B = host A
 * with ±1 px jitter (except `cross_fail`), as produced by simulate.
 */
import { simulate, type MockScenario } from '@verdict/engine';
import type { PerceptionHostResult, PerceptionProvider, PerceptionRequest } from '../types.js';

export class MockPerception implements PerceptionProvider {
  readonly name = 'mock';

  constructor(private readonly scenario: MockScenario) {}

  async runPair(req: PerceptionRequest): Promise<{ a: PerceptionHostResult; b: PerceptionHostResult }> {
    const sim = simulate(req.program, req.calibration, this.scenario, req.seed);
    const host = (tag: 'a' | 'b', s: typeof sim.a): PerceptionHostResult => ({
      host: { provider: 'mock', job_id: `mock-${req.bet.slice(0, 8)}-${tag}-${req.seed}`, url: null, market: null },
      network: 'mock',
      model_hash: s.model_hash,
      flags: s.flags,
      raw: null,
      session: s,
    });
    return { a: host('a', sim.a), b: host('b', sim.b) };
  }
}
