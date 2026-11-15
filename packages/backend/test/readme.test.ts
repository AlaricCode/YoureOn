/**
 * CONTRACTS §17 "Committed artifacts": the root README must carry the required
 * submission sections, and the facts it quotes (program ID, QuickNode Stream
 * config) must match the committed sources.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultProgramId } from '../src/chain/idl.js';

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const read = (p: string) => readFileSync(root(p), 'utf8');

describe('root README.md (§17)', () => {
  const readme = read('README.md');
  const headings = readme
    .split('\n')
    .filter((l) => l.startsWith('## '))
    .map((l) => l.slice(3).trim().toLowerCase());

  it('has every §17 section', () => {
    for (const h of [
      'setup',
      'architecture',
      'program id',
      'how we use solana',
      'elevenlabs usage',
      'quicknode streams',
      'trusted-setup statement',
      'honest zk framing (d-25)',
      'trusted replay booth',
      'grok',
      'legal / consent note',
    ]) {
      expect(headings, h).toContain(h);
    }
  });

  it('states the program ID from Anchor.toml, the IDL and the QuickNode filter', () => {
    const anchor = read('Anchor.toml');
    const ids = [...anchor.matchAll(/^verdict = "([1-9A-HJ-NP-Za-km-z]+)"$/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(1);
    const id = ids[0]!;
    expect(defaultProgramId()).toBe(id);
    expect(read('infra/quicknode/filter.js')).toContain(`var VERDICT_PROGRAM_ID = '${id}';`);
    expect(readme).toContain(id);
  });

  it('quotes the committed QuickNode Stream config', () => {
    const stream = JSON.parse(read('infra/quicknode/stream.json')) as Record<string, unknown> & { destination_attributes: { url: string; max_retry: number } };
    for (const v of [stream['name'], stream['network'], stream['dataset'], stream['region'], stream.destination_attributes.url]) {
      expect(readme).toContain(`\`${String(v)}\``);
    }
    expect(readme).toContain(`dataset_batch_size: ${String(stream['dataset_batch_size'])}`);
    expect(readme).toContain(`max_retry: ${stream.destination_attributes.max_retry}`);
    for (const h of ['x-qn-nonce', 'x-qn-timestamp', 'x-qn-signature', '300 s']) expect(readme).toContain(h);
  });

  it('carries the ECAPA-vs-Scribe statement and the D-25 trusted binding', () => {
    expect(readme).toContain('Speaker *verification* is our ECAPA model');
    expect(readme).toContain('Scribe supplies only diarized segments and audio events');
    expect(readme).toContain('`binding: "trusted"`');
    expect(readme).toMatch(/zkey[^\n]*not committed|Not committed:\*\* the zkey/);
    expect(readme).toContain('circuits/scripts/setup.sh');
  });
});

describe('packages/backend/README.md', () => {
  it('no longer describes implemented routes as stubs', () => {
    const r = read('packages/backend/README.md');
    expect(r).not.toMatch(/stubs? with TODOs|replace the `stub\(/);
    for (const m of ['identity', 'huddles', 'bets', 'booth', 'replayBooth', 'receipt', 'lifecycle', 'chainEvents', 'world']) {
      expect(r).toContain(`\`${m}\``);
    }
  });
});
