import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProgramId } from '../src/chain/idl.js';
import { ensureEnvFile, findRepoRoot, parseDotenv } from '../src/config/dotenv.js';
import { ConfigError, loadConfig } from '../src/config/load.js';
import { ENUM_VARS } from '../src/config/schema.js';
import { enforceSpendGuard, spendingModes } from '../src/config/spend.js';
import { keypairFromSecret } from '../src/crypto/keys.js';
import { ApiError, SpendDisabledError } from '../src/errors.js';
import { createProviders } from '../src/providers/registry.js';
import { tempDir, testEnv } from './helpers.js';

describe('config (§13)', () => {
  it('defaults every provider to mock/off', () => {
    const c = loadConfig(testEnv());
    expect(c.solanaMode).toBe('mock');
    expect(c.chainEventsSource).toBe('mock');
    expect(c.compilerProvider).toBe('mock');
    expect(c.advocateProvider).toBe('mock');
    expect(c.judgeProviders).toEqual(['mock', 'mock', 'mock']);
    expect(c.agentProvider).toBe('mock');
    expect(c.sttProvider).toBe('mock');
    expect(c.ttsProvider).toBe('mock');
    expect(c.sfxProvider).toBe('mock');
    expect(c.perceptionProvider).toBe('mock');
    expect(c.mockScenario).toBe('pass');
    expect(c.detectorProvider).toBe('mock');
    expect(c.identityProvider).toBe('mock');
    expect(c.geminiProvider).toBe('mock');
    expect(c.geminiHedge).toBe('mock');
    expect(c.prover).toBe('mock');
    expect(c.sp1Prover).toBe('off');
    expect(c.allowSpend).toBe(false);
    expect(c.programId).toBe(defaultProgramId());
    expect(c.dataDir.endsWith('.data')).toBe(true);
    expect(spendingModes(c)).toEqual([]);
  });

  it('ORACLE_KEY defaults to FEE_PAYER_KEY', () => {
    const env = testEnv();
    const c = loadConfig(env);
    expect(c.keys.oracle.publicKey).toBe(keypairFromSecret(env['FEE_PAYER_KEY']!).publicKey);
  });

  it('rejects bad values with every problem listed', () => {
    try {
      loadConfig(testEnv({ SOLANA_MODE: 'mainnet', MOCK_SCENARIO: 'nope', JUDGE_PROVIDERS: 'mock,mock', ALLOW_SPEND: 'true' }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const p = (e as ConfigError).problems.join('\n');
      expect(p).toMatch(/SOLANA_MODE/);
      expect(p).toMatch(/MOCK_SCENARIO/);
      expect(p).toMatch(/JUDGE_PROVIDERS/);
      expect(p).toMatch(/ALLOW_SPEND/);
    }
  });

  it('requires J0 to be video-capable', () => {
    expect(() => loadConfig(testEnv({ JUDGE_PROVIDERS: 'openai,mock,mock' }))).toThrow(/J0/);
    expect(loadConfig(testEnv({ JUDGE_PROVIDERS: 'gemini,openai,xai' })).judgeProviders).toEqual(['gemini', 'openai', 'xai']);
  });

  it('requires keys unless ephemeral, and validates them', () => {
    expect(() => loadConfig({})).toThrow(/FEE_PAYER_KEY/);
    expect(loadConfig({}, { ephemeralKeys: true }).keys.judges).toHaveLength(3);
    expect(() => loadConfig(testEnv({ FEE_PAYER_KEY: 'abc' }))).toThrow(/FEE_PAYER_KEY/);
    const env = testEnv();
    expect(() => loadConfig({ ...env, JUDGE_KEY_1: env['JUDGE_KEY_0'] })).toThrow(/distinct/);
    expect(() => loadConfig({ ...env, ORACLE_KEY: env['JUDGE_KEY_2'] })).toThrow(/oracle/);
  });

  it('enforces mode combinations', () => {
    expect(() => loadConfig(testEnv({ CHAIN_EVENTS_SOURCE: 'quicknode' }))).toThrow(/QUICKNODE_SECRET|SOLANA_MODE=mock/);
    expect(() => loadConfig(testEnv({ SOLANA_MODE: 'devnet', CHAIN_EVENTS_SOURCE: 'quicknode' }))).toThrow(/QUICKNODE_SECRET/);
    expect(loadConfig(testEnv({ SOLANA_MODE: 'devnet', CHAIN_EVENTS_SOURCE: 'rpc_ws' })).solanaMode).toBe('devnet');
  });
});

describe('spend guard', () => {
  const paid: [string, string][] = [
    ['COMPILER_PROVIDER', 'anthropic'],
    ['ADVOCATE_PROVIDER', 'openai'],
    ['JUDGE_PROVIDERS', 'gemini,xai,mock'],
    ['AGENT_PROVIDER', 'elevenlabs'],
    ['STT_PROVIDER', 'elevenlabs'],
    ['TTS_PROVIDER', 'elevenlabs'],
    ['SFX_PROVIDER', 'elevenlabs'],
    ['PERCEPTION_PROVIDER', 'nosana'],
    ['SP1_PROVER', 'network'],
    ['GEMINI_HEDGE', 'live'],
  ];

  it.each(paid)('%s=%s refuses to start without ALLOW_SPEND=1', (k, v) => {
    const extra: Record<string, string> = { [k]: v };
    if (v === 'nosana') extra['NOSANA_API_KEY'] = 'x';
    const c = loadConfig(testEnv(extra));
    expect(spendingModes(c).length).toBeGreaterThan(0);
    expect(() => enforceSpendGuard(c)).toThrow(SpendDisabledError);
    try {
      createProviders(c);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe('SPEND_DISABLED');
    }
  });

  it('PERCEPTION_PROVIDER=http also costs money', () => {
    const c = loadConfig(testEnv({ PERCEPTION_PROVIDER: 'http', PERCEPTION_URL: 'http://127.0.0.1:1' }));
    expect(() => createProviders(c)).toThrow(SpendDisabledError);
  });

  it('free modes are allowed without ALLOW_SPEND (devnet, Gemini reads, local sidecars, snarkjs)', () => {
    const c = loadConfig(testEnv({ GEMINI_PROVIDER: 'live', IDENTITY_PROVIDER: 'http', DETECTOR_PROVIDER: 'http', SP1_PROVER: 'mock' }));
    expect(spendingModes(c)).toEqual([]);
    const p = createProviders(c);
    expect(p.gemini.name).toBe('live');
    expect(p.identity.name).toBe('http');
    expect(p.detector.name).toBe('http');
  });

  it('ALLOW_SPEND=1 lets paid providers construct (with credentials)', () => {
    const c = loadConfig(testEnv({ ALLOW_SPEND: '1', COMPILER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', GEMINI_HEDGE: 'live' }));
    const p = createProviders(c);
    expect(p.compiler.name).toBe('anthropic');
    expect(p.hedge.name).toBe('live');
  });

  it('every enum row lists its default first and spend values are valid values', () => {
    for (const v of Object.values(ENUM_VARS)) {
      for (const s of v.spend) expect(v.values).toContain(s);
      expect(v.spend).not.toContain(v.values[0]);
    }
  });
});

describe('.env handling', () => {
  it('parses dotenv syntax', () => {
    expect(
      parseDotenv('# c\nA=1\nexport B = two \nC="x y"\nD=\'q\'\nE=v # comment\nbad line\n'),
    ).toEqual({ A: '1', B: 'two', C: 'x y', D: 'q', E: 'v' });
  });

  it('generates keys on first run, git-ignored file with 0600, and is idempotent', () => {
    const [dir, cleanup] = tempDir();
    try {
      const path = join(dir, '.env');
      const r1 = ensureEnvFile(path, {});
      expect(r1.generated).toEqual(['FEE_PAYER_KEY', 'JUDGE_KEY_0', 'JUDGE_KEY_1', 'JUDGE_KEY_2', 'BIOMETRIC_KEY', 'ELEVENLABS_TOOL_SECRET']);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const c = loadConfig(r1.env);
      expect(c.keys.judges.map((j) => j.publicKey)).toHaveLength(3);
      expect(r1.env['ORACLE_KEY']).toBeUndefined();

      const before = readFileSync(path, 'utf8');
      const r2 = ensureEnvFile(path, {});
      expect(r2.generated).toEqual([]);
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect(r2.env['FEE_PAYER_KEY']).toBe(r1.env['FEE_PAYER_KEY']);
    } finally {
      cleanup();
    }
  });

  it('never generates variables present in the process env, which wins', () => {
    const [dir, cleanup] = tempDir();
    try {
      const path = join(dir, '.env');
      writeFileSync(path, 'SOLANA_MODE=mock\nPORT=1234\n');
      const base = testEnv();
      const r = ensureEnvFile(path, { ...base, PORT: '9999' });
      expect(r.generated).toEqual([]);
      expect(r.env['PORT']).toBe('9999');
      expect(r.env['SOLANA_MODE']).toBe('mock');
    } finally {
      cleanup();
    }
  });

  it('the repo root .env is git-ignored and .env.example is committed', () => {
    const root = findRepoRoot();
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(/^\.env$/m);
    const example = parseDotenv(readFileSync(join(root, '.env.example'), 'utf8'));
    expect(example['SOLANA_MODE']).toBe('mock');
    expect(example['ALLOW_SPEND']).toBeUndefined();
    expect(example['FEE_PAYER_KEY']).toBeUndefined();
  });
});
