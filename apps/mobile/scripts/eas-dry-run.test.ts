// scripts/eas-dry-run.sh: only its argument handling runs here. A real run needs Xcode and takes
// minutes (run by hand: scripts/eas-dry-run.sh --linked).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../scripts/eas-dry-run.sh', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const run = (...args: string[]) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });

describe('eas-dry-run.sh arguments', () => {
  it('prints its header on --help', () => {
    const r = run('--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Replays the EAS Build iOS pipeline');
    expect(r.stdout).toContain('--worker-node');
  });

  it('rejects unknown arguments', () => {
    const r = run('--nope');
    expect(r.status).toBe(64);
    expect(r.stderr).toContain('unknown argument: --nope');
  });

  it('refuses a work directory that is relative, the root, or inside the repo (it is wiped)', () => {
    for (const out of ['relative/dir', '/', `${REPO}apps/mobile/tmp`]) {
      const r = run('--out', out);
      expect(r.status, out).toBe(64);
      expect(r.stderr).toContain('--out must be an absolute path outside the repo');
    }
  });

  it('pins the same eas-cli and worker toolchain as the preflight', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const preflight = readFileSync(
      fileURLToPath(new URL('./eas-preflight.ts', import.meta.url)),
      'utf8',
    );
    const pin = (re: RegExp, text: string) => re.exec(text)?.[1];
    expect(pin(/EAS_CLI_VERSION="([^"]+)"/, src)).toBe(
      pin(/EAS_CLI_VERSION = '([^']+)'/, preflight),
    );
    expect(pin(/WORKER_NPM="([^"]+)"/, src)).toBe(pin(/WORKER_NPM_VERSION = '([^']+)'/, preflight));
    const easJson = JSON.parse(
      readFileSync(fileURLToPath(new URL('../eas.json', import.meta.url)), 'utf8'),
    ) as {
      build: { base: { node: string } };
    };
    expect(pin(/WORKER_NODE="([^"]+)"/, src)).toBe(easJson.build.base.node);
  });
});
