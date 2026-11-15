/**
 * Mock scene detector (§13 DETECTOR_PROVIDER=mock): returns each
 * `calibration.scene.entity_refs` bbox if a calibration exists, else a
 * deterministic layout seeded by sha256(bet ‖ entity); conf 90.
 */
import { createHash } from 'node:crypto';
import { COORD_MAX } from '@verdict/engine';
import { HashPrng } from '../../util/prng.js';
import type { Detection, DetectorProvider } from '../types.js';

export const MOCK_DETECT_CONF = 90;

export function mockLayoutBox(bet: string, entity: string): [number, number, number, number] {
  const prng = new HashPrng(createHash('sha256').update(bet).update(entity).digest());
  const w = prng.int(800, 3000);
  const h = prng.int(800, 3000);
  const x0 = prng.int(0, COORD_MAX - w);
  const y0 = prng.int(0, COORD_MAX - h);
  return [x0, y0, x0 + w, y0 + h];
}

export class MockDetector implements DetectorProvider {
  readonly name = 'mock';

  async detect(
    _jpeg: Uint8Array,
    ctx: Parameters<DetectorProvider['detect']>[1],
  ): Promise<Detection[]> {
    const refs = new Map((ctx.calibration?.scene.entity_refs ?? []).map((r) => [r.entity, r.bbox]));
    return ctx.entities.map(({ entity }) => {
      const bbox = refs.get(entity);
      return {
        entity,
        bbox: bbox ? ([...bbox] as [number, number, number, number]) : mockLayoutBox(ctx.bet, entity),
        conf: MOCK_DETECT_CONF,
      };
    });
  }
}
