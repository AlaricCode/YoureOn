/**
 * `POST /bets/:id/practice {frames_b64 ≤ 50 (10 fps)}` (§12.3, §12.10):
 * runs the detector on every frame, builds a session (identity ignored,
 * persons bind to the largest person detection, D-45) and evaluates each
 * condition row with `leafSignals` against the last stored calibration.
 * Nothing is persisted and nothing touches the chain.
 */
import { conditionRows, leafSignals, type ConditionField } from '@verdict/engine';
import type { AppContext } from '../context.js';
import { ApiError } from '../errors.js';
import type { BetInfo } from '../lifecycle/betInfo.js';
import { calibrationComplete, detectorPrompts, sessionFromDetections } from '../lifecycle/scene.js';
import { lifecycleStores } from '../lifecycle/stores.js';
import type { Detection } from '../providers/types.js';
import { badRequest } from '../routes/util.js';
import { fromBase64 } from '../util/bytes.js';

export const PRACTICE_MAX_FRAMES = 50;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export interface PracticeRow {
  leg: number;
  field: ConditionField;
  path: string;
  label: string;
  fired: boolean;
  frame: number | null;
}

export function parsePracticeFrames(body: Record<string, unknown>): Uint8Array[] {
  const raw = body['frames_b64'];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PRACTICE_MAX_FRAMES) {
    throw badRequest(`frames_b64 must be 1..${PRACTICE_MAX_FRAMES} base64 JPEGs`);
  }
  return raw.map((f, i) => {
    if (typeof f !== 'string') throw badRequest(`frames_b64[${i}] must be a string`);
    let b: Uint8Array;
    try {
      b = fromBase64(f);
    } catch {
      throw badRequest(`frames_b64[${i}] must be base64`);
    }
    if (b.length === 0 || b.length > MAX_FRAME_BYTES) throw badRequest(`frames_b64[${i}] must be a JPEG ≤ 2 MiB`);
    return b;
  });
}

export async function runPractice(ctx: AppContext, info: BetInfo, frames: Uint8Array[]): Promise<{ conditions: PracticeRow[] }> {
  const p = info.program;
  if (p.kind !== 'rules') throw new ApiError('WRONG_STATE', `${p.kind} bets have no practice`);
  const calibration = lifecycleStores(ctx).scenes.get(info.id)?.calibration ?? null;
  if (!calibrationComplete(p, calibration)) throw new ApiError('CALIBRATION_INCOMPLETE');
  const entities = detectorPrompts(p);
  const dets: Detection[][] = [];
  for (const jpeg of frames) dets.push(await ctx.providers.detector.detect(jpeg, { bet: info.id, entities, calibration }));
  const session = sessionFromDetections(p, dets);
  const signals = leafSignals(p, calibration, session);
  const byKey = new Map(signals.map((s) => [`${s.leg}|${s.field}|${s.path}`, s.signal]));
  return {
    conditions: conditionRows(p, info.labels).map((row) => {
      const sig = byKey.get(`${row.leg}|${row.field}|${row.path}`) ?? [];
      const first = sig.findIndex(Boolean);
      return { ...row, fired: first >= 0, frame: first >= 0 ? first : null };
    }),
  };
}
