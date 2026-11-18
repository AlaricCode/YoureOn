// scripts/eas-dry-run.sh: only its argument handling runs here. A real run needs Xcode and takes
// minutes (run by hand: scripts/eas-dry-run.sh --linked).
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../scripts/eas-dry-run.sh', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const MARKER = '.youre-on-eas-dry-run';
const run = (...args: string[]) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });

const scratch = mkdtempSync(join(tmpdir(), 'eas-dry-run-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * Runs the script with a PATH that has only bash and dirname, so a run whose --out passes the
 * guard stops at the tool check ("git not found", exit 1) before it can wipe or build anything.
 * Every --out case goes through it: a guard regression fails the test instead of running rm -rf
 * on $HOME.
 */
const toolless = join(scratch, 'bin');
mkdirSync(toolless);
for (const tool of ['bash', 'dirname']) {
  const path = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
  symlinkSync(path, join(toolless, tool));
}
const runGuardOnly = (env: Record<string, string>, ...args: string[]) =>
  spawnSync(join(toolless, 'bash'), [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: toolless, ...env },
  });

/** A scratch directory holding `files` (name -> contents). */
function dir(name: string, files: Record<string, string> = {}) {
  const d = join(scratch, name);
  mkdirSync(d, { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(d, f), body);
  return d;
}

describe('eas-dry-run.sh arguments', () => {
  it('prints its header on --help', () => {
    const r = run('--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Replays the EAS Build iOS pipeline');
    expect(r.stdout).toContain('--worker-node');
    expect(r.stdout).not.toContain('set -euo');
  });

  it('rejects unknown arguments', () => {
    const r = run('--nope');
    expect(r.status).toBe(64);
    expect(r.stderr).toContain('unknown argument: --nope');
  });

  it('refuses a work directory that holds the repo, $HOME or $TMPDIR (it is wiped)', () => {
    const home = homedir();
    const outs = [
      'relative/dir',
      '/',
      '//',
      '/tmp/../',
      '/usr',
      home,
      `${home}/`, // what `--out ~/` expands to
      `${home}//.`,
      dirname(dirname(REPO)), // an ancestor of the repo
      REPO,
      `${REPO}apps/..`,
      `${REPO}apps/mobile/tmp`,
      tmpdir(),
    ];
    for (const out of outs) {
      const r = runGuardOnly({}, '--out', out);
      expect(r.status, out).toBe(64);
      expect(r.stderr, out).toContain('--out must be an absolute path outside the repo');
    }
  });

  it('refuses to wipe a directory an earlier run did not make, or a file', () => {
    const full = dir('full', { 'keep.txt': 'x' });
    const hidden = dir('hidden', { '.keep': 'x' });
    symlinkSync(full, join(scratch, 'link-to-full'));
    for (const out of [full, `${full}/`, hidden, join(scratch, 'link-to-full')]) {
      const r = runGuardOnly({}, '--out', out);
      expect(r.status, out).toBe(64);
      expect(r.stderr, out).toContain(`has no ${MARKER} from an earlier run`);
    }
    expect(existsSync(join(full, 'keep.txt'))).toBe(true);
    expect(existsSync(join(hidden, '.keep'))).toBe(true);
    const r = runGuardOnly({}, '--out', join(full, 'keep.txt'));
    expect(r.status).toBe(64);
    expect(r.stderr).toContain('--out is not a directory');
  });

  it('accepts a new or empty directory, an earlier run, and the default', () => {
    const outs = [
      join(scratch, 'new/sub'),
      dir('empty'),
      dir('marked', { [MARKER]: '', 'build.log': 'old' }),
      `${dir('empty2')}/../empty2/`,
    ];
    for (const out of outs) {
      const r = runGuardOnly({}, '--out', out);
      expect(r.stderr, out).toContain('git not found');
      expect(r.status, out).toBe(1);
    }
    // The default ($TMPDIR/youre-on-eas-dry-run) is the script's own, marked or not (runs from
    // before the marker existed left it unmarked).
    const tmp = dir('tmpdir');
    dir('tmpdir/youre-on-eas-dry-run', { 'old.log': 'x' });
    const r = runGuardOnly({ TMPDIR: `${tmp}/` });
    expect(r.stderr).toContain('git not found');
    expect(existsSync(join(tmp, 'youre-on-eas-dry-run/old.log'))).toBe(true);
  });

  it('marks the work directory right after creating it', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain(`MARKER="${MARKER}"`);
    expect(src).toMatch(/rm -rf "\$out"\nmkdir -p "\$out"\n: >"\$out\/\$MARKER"\n/);
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
