// Unit tests for the EAS preflight's pure checks, plus (with EAS_CLI_DIR set) a full run of the
// real preflight against this repo, which replays eas-cli's own upload copy.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FACE_MODEL } from '../src/face/model';
import {
  addedLines,
  ARCHIVE_WARN_BYTES,
  auditArchive,
  checkAppConfig,
  checkEasJsonRaw,
  checkModel,
  checkNode,
  checkPatch,
  checkProfiles,
  checkShellEnv,
  checkWebrtcPin,
  compareVersions,
  lockVersions,
  MODEL_PATH,
  parseArgs,
  parsePatchName,
  profileEnvFromEasJson,
  type Profile,
  type Result,
} from './eas-preflight';

const statuses = (rs: Result[]) => rs.map((r) => r.status);
const failures = (rs: Result[]) => rs.filter((r) => r.status === 'fail').map((r) => r.title);

describe('compareVersions / checkNode', () => {
  it('orders dotted versions numerically', () => {
    expect(compareVersions('22.10.0', '22.4')).toBe(1);
    expect(compareVersions('v22.4.0', '22.4')).toBe(0);
    expect(compareVersions('20.19.4', '22.4')).toBe(-1);
    expect(compareVersions('27.10.0', '27.5.0')).toBe(1);
  });

  it('fails node older than the root engines floor', () => {
    expect(checkNode('v24.11.1').status).toBe('pass');
    expect(checkNode('v22.4.0').status).toBe('pass');
    expect(checkNode('v20.19.4').status).toBe('fail');
  });
});

describe('checkShellEnv', () => {
  it('passes a clean shell', () => {
    expect(statuses(checkShellEnv({}))).toEqual(['pass']);
  });

  it('flags free-team leftovers without failing (eas.json pins the EAS values)', () => {
    const [r] = checkShellEnv({ IOS_BUNDLE_ID: 'dev.youreon.app.eva', APPLE_TEAM_ID: '' });
    expect(r?.status).toBe('info');
    expect(r?.title).toContain('IOS_BUNDLE_ID');
    expect(r?.title).not.toContain('APPLE_TEAM_ID');
  });

  it('notes EAS_NO_VCS', () => {
    expect(statuses(checkShellEnv({ EAS_NO_VCS: '1' }))).toEqual(['pass', 'info']);
  });
});

describe('checkModel', () => {
  const good = {
    exists: true,
    size: FACE_MODEL.sizeBytes,
    sha256: FACE_MODEL.sha256,
    tracked: false,
  };

  it('passes the known-good, untracked model', () => {
    expect(statuses(checkModel(good, FACE_MODEL.sha256))).toEqual(['pass', 'pass']);
  });

  it('fails a missing model with the fix', () => {
    const [r] = checkModel({ exists: false, tracked: false }, null);
    expect(r?.status).toBe('fail');
    expect(r?.detail).toContain('scripts/face-model.sh');
  });

  it('fails a model with the wrong bytes', () => {
    expect(failures(checkModel({ ...good, sha256: 'ab'.repeat(32) }, null))).toHaveLength(1);
    expect(failures(checkModel({ ...good, size: 1 }, null))).toHaveLength(1);
  });

  it('fails a model tracked by git (non-commercial weights, public repo)', () => {
    const rs = checkModel({ ...good, tracked: true }, null);
    expect(failures(rs)).toEqual(['the face model is tracked by git']);
    expect(rs[1]?.detail).toContain(`git rm --cached ${MODEL_PATH}`);
  });

  it('fails when face-model.sh and FACE_MODEL disagree on the hash', () => {
    expect(failures(checkModel(good, '00'.repeat(32)))).toHaveLength(1);
  });
});

describe('WebRTC pin', () => {
  const rootPkg = { overrides: { '@livekit/react-native-webrtc': '144.1.2' } };
  const mobilePkg = { dependencies: { '@livekit/react-native-webrtc': '144.1.2' } };
  const lock = (entries: Record<string, string>) => ({
    packages: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, { version: v }])),
  });
  const installed = { 'node_modules/@livekit/react-native-webrtc': '144.1.2' };

  it('finds every lockfile copy, hoisted or nested', () => {
    const l = lock({
      'node_modules/@livekit/react-native-webrtc': '144.1.2',
      'node_modules/@livekit/react-native/node_modules/@livekit/react-native-webrtc': '137.0.0',
      'node_modules/@livekit/react-native-webrtc-extra': '1.0.0',
    });
    expect(Object.keys(lockVersions(l, '@livekit/react-native-webrtc'))).toHaveLength(2);
  });

  it('passes when override, dependency, lockfile and node_modules all say 144.1.2', () => {
    const l = lock({ 'node_modules/@livekit/react-native-webrtc': '144.1.2' });
    expect(statuses(checkWebrtcPin(rootPkg, mobilePkg, l, installed))).toEqual([
      'pass',
      'pass',
      'pass',
    ]);
  });

  it('fails a nested older copy in the lockfile (the WebRTC/WebRTC.h build failure)', () => {
    const l = lock({
      'node_modules/@livekit/react-native-webrtc': '144.1.2',
      'node_modules/@elevenlabs/react-native/node_modules/@livekit/react-native-webrtc': '137.0.2',
    });
    const rs = checkWebrtcPin(rootPkg, mobilePkg, l, installed);
    expect(failures(rs)).toHaveLength(1);
    expect(failures(rs)[0]).toContain('137.0.2');
  });

  it('fails a missing override or a stale node_modules', () => {
    const l = lock({ 'node_modules/@livekit/react-native-webrtc': '144.1.2' });
    expect(failures(checkWebrtcPin({}, mobilePkg, l, installed))).toHaveLength(1);
    expect(
      failures(
        checkWebrtcPin(rootPkg, mobilePkg, l, {
          'node_modules/@livekit/react-native-webrtc': '137.0.0',
        }),
      ),
    ).toHaveLength(1);
    expect(failures(checkWebrtcPin(rootPkg, mobilePkg, l, {}))).toHaveLength(1);
  });
});

describe('patch-package checks', () => {
  const patch = [
    'diff --git a/node_modules/fd/ios/A.swift b/node_modules/fd/ios/A.swift',
    'index 1..2 100644',
    '--- a/node_modules/fd/ios/A.swift',
    '+++ b/node_modules/fd/ios/A.swift',
    '@@ -1,2 +1,2 @@',
    '-old line',
    '+new line',
    '+',
    ' context',
    'diff --git a/node_modules/fd/ios/B.swift b/node_modules/fd/ios/B.swift',
    '--- a/node_modules/fd/ios/B.swift',
    '+++ b/node_modules/fd/ios/B.swift',
    '+second',
    '',
  ].join('\n');

  it('parses patch-package file names, scoped or not', () => {
    expect(parsePatchName('react-native-vision-camera-face-detector+2.1.0.patch')).toEqual({
      name: 'react-native-vision-camera-face-detector',
      version: '2.1.0',
    });
    expect(parsePatchName('@scope+pkg+1.2.3.patch')).toEqual({
      name: '@scope/pkg',
      version: '1.2.3',
    });
    expect(parsePatchName('README.md')).toBeNull();
  });

  it('collects the non-blank added lines per file', () => {
    expect([...addedLines(patch)]).toEqual([
      ['ios/A.swift', ['new line']],
      ['ios/B.swift', ['second']],
    ]);
  });

  it('collects added lines of scoped packages', () => {
    const scoped = '+++ b/node_modules/@scope/pkg/src/x.ts\n+added\n';
    expect([...addedLines(scoped)]).toEqual([['src/x.ts', ['added']]]);
  });

  const facts = (files: Record<string, string | undefined>, versions = ['1.0.0', '1.0.0']) => ({
    file: 'fd+1.0.0.patch',
    text: patch,
    lockVersion: versions[0],
    installedVersion: versions[1],
    installedFiles: new Map(Object.entries(files)),
  });
  const postinstall = 'cd ../.. && patch-package --error-on-fail';

  it('passes when every added line is in the installed files', () => {
    const rs = checkPatch(
      facts({ 'ios/A.swift': 'x\nnew line\n', 'ios/B.swift': 'second' }),
      postinstall,
    );
    expect(statuses(rs)).toEqual(['pass']);
  });

  it('fails an unapplied patch, a missing file, a version drift, or no postinstall', () => {
    expect(
      failures(
        checkPatch(facts({ 'ios/A.swift': 'old line', 'ios/B.swift': 'second' }), postinstall),
      ),
    ).toHaveLength(1);
    expect(failures(checkPatch(facts({ 'ios/A.swift': 'new line' }), postinstall))[0]).toContain(
      'NOT applied',
    );
    expect(
      failures(
        checkPatch(
          facts({ 'ios/A.swift': 'new line', 'ios/B.swift': 'second' }, ['1.0.1', '1.0.1']),
          postinstall,
        ),
      ),
    ).toHaveLength(1);
    expect(
      failures(
        checkPatch(facts({ 'ios/A.swift': 'new line', 'ios/B.swift': 'second' }), 'echo hi'),
      ),
    ).toHaveLength(1);
  });
});

describe('eas.json checks', () => {
  const cli = { appVersionSource: 'remote', version: '>= 27.10.0' };

  it('fails requireCommit: true (the git-ignored model would not be uploaded)', () => {
    expect(failures(checkEasJsonRaw({ cli: { ...cli, requireCommit: true } }))).toHaveLength(1);
    expect(statuses(checkEasJsonRaw({ cli }))).toEqual(['pass', 'pass', 'pass']);
  });

  it('fails a local version source (autoIncrement would rewrite app.json)', () => {
    expect(failures(checkEasJsonRaw({ cli: { ...cli, appVersionSource: 'local' } }))).toHaveLength(
      1,
    );
  });

  it('warns when cli.version would refuse eas-cli 27.10.0', () => {
    expect(
      statuses(checkEasJsonRaw({ cli: { appVersionSource: 'remote', version: '>= 28.0.0' } })),
    ).toEqual(['pass', 'pass', 'warn']);
  });

  const device: Profile = {
    distribution: 'internal',
    channel: 'preview',
    env: {
      IOS_BUNDLE_ID: 'dev.youreon.app.eas',
      EXPO_PUBLIC_API_URL: 'https://youre-on.fly.dev',
      EXPO_PUBLIC_VOICE: 'on',
    },
  };

  it('accepts release, internal, https profiles for the phones', () => {
    expect(
      statuses(checkProfiles({ preview: device, pitch: { ...device, channel: 'pitch' } })),
    ).toEqual(['pass', 'pass']);
  });

  it('needs one EAS Update channel per phone profile (EXPO_PUBLIC_* are baked into updates)', () => {
    expect(failures(checkProfiles({ preview: { ...device, channel: undefined } }))[0]).toContain(
      'no EAS Update channel',
    );
    const shared = failures(checkProfiles({ preview: device, 'preview-typed': device }));
    expect(shared).toHaveLength(2);
    expect(shared[0]).toContain('shares channel "preview" with preview-typed');
  });

  it('rejects a phone profile that needs Metro, a laptop URL, the store, or an unknown voice flag', () => {
    const bad = (p: Partial<Profile>, env: Record<string, string> = {}) =>
      failures(checkProfiles({ preview: { ...device, ...p, env: { ...device.env, ...env } } }));
    expect(bad({ developmentClient: true })).toHaveLength(1);
    expect(bad({}, { EXPO_PUBLIC_API_URL: 'http://192.168.1.20:8080' })).toHaveLength(1);
    expect(bad({ distribution: 'store' })).toHaveLength(1);
    expect(bad({}, { EXPO_PUBLIC_VOICE: 'false' })).toHaveLength(1);
  });

  it('allows the dev client its localhost URL but still needs a bundle ID', () => {
    const dev: Profile = {
      developmentClient: true,
      distribution: 'internal',
      env: { IOS_BUNDLE_ID: 'a.b' },
    };
    expect(statuses(checkProfiles({ development: dev }))).toEqual(['pass']);
    expect(failures(checkProfiles({ development: { ...dev, env: {} } }))).toHaveLength(1);
  });

  it('reports a profile eas-cli could not resolve', () => {
    expect(failures(checkProfiles({ pitch: new Error('Missing build profile') }))).toHaveLength(1);
  });

  it('merges env along the extends chain and survives cycles', () => {
    const easJson = {
      build: {
        base: { env: { A: '1', B: '1' } },
        preview: { extends: 'base', env: { B: '2' } },
        pitch: { extends: 'preview', env: { C: '3' } },
        loop: { extends: 'loop', env: { D: '4' } },
      },
    };
    expect(profileEnvFromEasJson(easJson, 'pitch')).toEqual({ A: '1', B: '2', C: '3' });
    expect(profileEnvFromEasJson(easJson, 'loop')).toEqual({ D: '4' });
    expect(profileEnvFromEasJson(easJson, 'nope')).toBeNull();
  });
});

describe('checkAppConfig', () => {
  const exp = {
    version: '1.0.0',
    ios: {
      bundleIdentifier: 'dev.youreon.app.eas',
      entitlements: {},
      infoPlist: { ITSAppUsesNonExemptEncryption: false },
    },
    runtimeVersion: { policy: 'appVersion' },
    updates: { enabled: false },
  };
  const linked = {
    ...exp,
    extra: { eas: { projectId: 'p1' } },
    owner: 'o',
    updates: { enabled: true, url: 'https://u.expo.dev/p1' },
  };
  const expected = { IOS_BUNDLE_ID: 'dev.youreon.app.eas' };

  it('passes a matching bundle ID without APNs; updates stay off until the project is linked', () => {
    const rs = checkAppConfig({ profile: 'preview', expected, exp });
    expect(statuses(rs)).toEqual(['pass', 'pass', 'pass', 'info', 'info']);
    expect(rs[3]?.detail).toContain('eas init');
  });

  it('passes a linked project whose update URL is derived from its id', () => {
    const rs = checkAppConfig({ profile: 'preview', expected, exp: linked });
    expect(statuses(rs)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass']);
    expect(rs[4]?.detail).toContain('https://u.expo.dev/p1');
  });

  it('fails a wrong update URL, updates without a project, or another runtime policy', () => {
    const bad = (e: Record<string, unknown>) =>
      failures(checkAppConfig({ profile: 'preview', expected, exp: { ...linked, ...e } }));
    expect(bad({ updates: { enabled: true, url: 'https://u.expo.dev/other' } })).toHaveLength(1);
    expect(bad({ extra: {}, updates: { enabled: true } })).toHaveLength(1);
    expect(bad({ runtimeVersion: { policy: 'fingerprint' } })).toHaveLength(1);
  });

  it('fails a bundle ID that differs from eas.json, warns on aps-environment', () => {
    const rs = checkAppConfig({
      profile: 'preview',
      expected: { IOS_BUNDLE_ID: 'other.id' },
      exp: { ...linked, ios: { ...exp.ios, entitlements: { 'aps-environment': 'development' } } },
    });
    expect(statuses(rs)).toEqual(['fail', 'pass', 'warn', 'pass', 'pass']);
  });

  it('fails a missing export-compliance answer (eas build would rewrite app.json)', () => {
    const rs = checkAppConfig({
      profile: 'preview',
      expected,
      exp: { ...exp, ios: { ...exp.ios, infoPlist: {} } },
    });
    expect(failures(rs)).toEqual([
      'ios.infoPlist.ITSAppUsesNonExemptEncryption is not set in app.json',
    ]);
  });
});

describe('auditArchive', () => {
  const base = {
    entries: ['package.json', 'apps/', 'apps/mobile/', 'apps/mobile/app.json', `${MODEL_PATH}`],
    sizeBytes: 20 * 1024 * 1024,
    required: ['package.json', 'apps/mobile/app.json', MODEL_PATH],
    gitIgnored: ['node_modules/', '.env', MODEL_PATH, 'apps/mobile/ios/'],
    droppedTracked: [],
  };

  it('passes a clean upload that carries the model', () => {
    expect(statuses(auditArchive(base))).toEqual(['pass', 'pass', 'pass', 'pass']);
  });

  it('fails when the model (or any required file) is left out', () => {
    const rs = auditArchive({ ...base, entries: base.entries.filter((e) => e !== MODEL_PATH) });
    expect(failures(rs)[0]).toContain(MODEL_PATH);
  });

  it('fails when anything git ignores would be uploaded, file or directory', () => {
    const rs = auditArchive({
      ...base,
      entries: [...base.entries, '.env', 'apps/mobile/ios/', 'apps/mobile/ios/Podfile'],
    });
    expect(failures(rs)[0]).toContain('.env, apps/mobile/ios/');
  });

  it('ignores empty directories of ignored paths', () => {
    expect(
      failures(auditArchive({ ...base, entries: [...base.entries, 'node_modules/'] })),
    ).toEqual([]);
  });

  it('fails secrets and local tooling even when git does not ignore them', () => {
    const rs = auditArchive({
      ...base,
      entries: [
        ...base.entries,
        'apps/server/.env.production',
        'fee-payer-keypair.json',
        'AuthKey_X.p8',
        '.claude/worktrees/x/a.ts',
      ],
    });
    const f = failures(rs).join(' ');
    for (const s of ['.env.production', 'keypair', '.p8', '.claude']) expect(f).toContain(s);
  });

  it('keeps .env.example', () => {
    expect(failures(auditArchive({ ...base, entries: [...base.entries, '.env.example'] }))).toEqual(
      [],
    );
  });

  it('warns on dropped tracked files and on a large upload', () => {
    const rs = auditArchive({
      ...base,
      droppedTracked: ['docs/x.key'],
      sizeBytes: ARCHIVE_WARN_BYTES + 1,
    });
    expect(statuses(rs)).toEqual(['pass', 'pass', 'pass', 'warn', 'warn']);
  });
});

describe('parseArgs', () => {
  it('parses the flags and rejects unknown ones', () => {
    expect(parseArgs(['--offline', '--strict', '--profile', 'pitch', '--eas-cli', '/x'])).toEqual({
      offline: true,
      strict: true,
      profile: 'pitch',
      easCli: '/x',
    });
    expect(parseArgs([])).toEqual({
      offline: false,
      strict: false,
      profile: 'preview',
      easCli: null,
    });
    expect(() => parseArgs(['--nope'])).toThrow('unknown argument');
  });
});

// The real thing: needs an installed eas-cli (EAS_CLI_DIR) and the face model on disk, so it is
// skipped in CI. Run locally: EAS_CLI_DIR=<dir>/node_modules/eas-cli npm test -w apps/mobile
const easCliDir = process.env.EAS_CLI_DIR;
const modelOnDisk = existsSync(
  fileURLToPath(new URL(`../assets/models/${FACE_MODEL.fileName}`, import.meta.url)),
);
describe.runIf(easCliDir && modelOnDisk)('preflight against this repo (EAS_CLI_DIR set)', () => {
  it('reports no failures', () => {
    const script = fileURLToPath(new URL('../../../scripts/eas-preflight.sh', import.meta.url));
    const r = spawnSync('bash', [script, '--offline', '--eas-cli', String(easCliDir)], {
      encoding: 'utf8',
      timeout: 240_000,
    });
    expect(r.stdout).toContain('PASS  upload has the');
    expect(r.stdout).toContain('eas-cli resolves the iOS workflow as managed');
    expect(r.stdout, r.stdout).toMatch(/, 0 failed,/);
    expect(r.status).toBe(0);
  }, 300_000);
});
