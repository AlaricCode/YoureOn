/**
 * Engine functions the chain model needs from other engine modules (decoders
 * §5, interpreter §3). They are resolved lazily by name so this module does
 * not depend on their build order; tests and callers may inject their own.
 */
import * as encodeMod from '../encode/index.js';
import * as evalMod from '../eval/index.js';
import type {
  DecodedCalibration,
  DecodedProgram,
  EvalOptions,
  EvalResult,
  MarketBinEntry,
  TrackBufferData,
  VerifiedCheckpoint,
} from '../types.js';

export interface ChainHooks {
  decodeProgram(bin: Uint8Array): DecodedProgram;
  decodeCalibration(bin: Uint8Array, p: DecodedProgram): DecodedCalibration;
  decodeTrackBin(bin: Uint8Array, p: DecodedProgram): TrackBufferData;
  decodeMarketBin(bin: Uint8Array): MarketBinEntry[] | unknown;
  evaluate(
    programBin: Uint8Array,
    calibrationBin: Uint8Array,
    trackBin: Uint8Array,
    verified: VerifiedCheckpoint[],
    opts?: EvalOptions,
  ): EvalResult;
}

function lazy<K extends keyof ChainHooks>(mod: object, name: K, where: string): ChainHooks[K] {
  return ((...args: unknown[]) => {
    const f = (mod as Record<string, unknown>)[name];
    if (typeof f !== 'function') throw new Error(`engine ${where} module does not export ${name}`);
    return (f as (...a: unknown[]) => unknown)(...args);
  }) as ChainHooks[K];
}

/** Default hooks: the engine's own decoders and interpreter. */
export const defaultChainHooks: ChainHooks = {
  decodeProgram: lazy(encodeMod, 'decodeProgram', 'encode'),
  decodeCalibration: lazy(encodeMod, 'decodeCalibration', 'encode'),
  decodeTrackBin: lazy(encodeMod, 'decodeTrackBin', 'encode'),
  decodeMarketBin: lazy(encodeMod, 'decodeMarketBin', 'encode'),
  evaluate: lazy(evalMod, 'evaluate', 'eval'),
};
