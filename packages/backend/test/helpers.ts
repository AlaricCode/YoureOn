import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config, type Env } from '../src/config/load.js';
import { generateKeypair, secretToBase58 } from '../src/crypto/keys.js';

/** Fresh temp dir; returns [path, cleanup]. */
export function tempDir(prefix = 'verdict-backend-'): [string, () => void] {
  const d = mkdtempSync(join(tmpdir(), prefix));
  return [d, () => rmSync(d, { recursive: true, force: true })];
}

/** A complete env with freshly generated keys (never sets ALLOW_SPEND). */
export function testEnv(extra: Env = {}): Env {
  return {
    FEE_PAYER_KEY: secretToBase58(generateKeypair()),
    JUDGE_KEY_0: secretToBase58(generateKeypair()),
    JUDGE_KEY_1: secretToBase58(generateKeypair()),
    JUDGE_KEY_2: secretToBase58(generateKeypair()),
    BIOMETRIC_KEY: '11'.repeat(32),
    ELEVENLABS_TOOL_SECRET: 'tool-secret',
    PORT: '0',
    ...extra,
  };
}

export function testConfig(extra: Env = {}, dataDir?: string): Config {
  return loadConfig(testEnv({ ...(dataDir ? { DATA_DIR: dataDir } : {}), ...extra }));
}

export const hex32 = (byte: number): string => byte.toString(16).padStart(2, '0').repeat(32);
