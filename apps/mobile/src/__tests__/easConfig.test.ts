// Guards the paid-account EAS path (docs/IOS-BUILD.md, "Paid account (EAS)"): app.config.js env
// overrides, the eas.json profiles, the root .easignore (what `eas build` uploads), and the
// evaluated iOS config. scripts/eas-preflight.sh re-checks the same things against eas-cli itself.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { profileEnvFromEasJson } from '../../scripts/eas-preflight';
import { FACE_MODEL } from '../face/model';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const ROOT = here('../../../../');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const readJson = (rel: string) => JSON.parse(read(rel)) as Record<string, unknown>;

type ExpoConfig = {
  name: string;
  version: string;
  ios: { bundleIdentifier: string; appleTeamId?: string; infoPlist: Record<string, string> };
  extra?: { eas?: { projectId?: string } };
  runtimeVersion?: unknown;
  updates?: Record<string, unknown>;
};
const { applyEnv } = createRequire(import.meta.url)('../../app.config.js') as {
  applyEnv: (config: ExpoConfig, env: Record<string, string | undefined>) => ExpoConfig;
};
const appJson = (readJson('apps/mobile/app.json') as { expo: ExpoConfig }).expo;
/** Set once the lead has run `eas init` and committed app.json (docs/IOS-BUILD.md step 2). */
const linkedProjectId = appJson.extra?.eas?.projectId;

/** The `updates` block app.config.js must derive for a project linked to `projectId`, or not. */
function expectedUpdates(projectId: string | undefined) {
  return projectId
    ? {
        enabled: true,
        url: `https://u.expo.dev/${projectId}`,
        checkAutomatically: 'ON_LOAD',
        fallbackToCacheTimeout: 0,
      }
    : { enabled: false };
}

describe('app.config.js env overrides', () => {
  it("keeps app.json's values when nothing is set", () => {
    const c = applyEnv(appJson, {});
    expect(c.ios.bundleIdentifier).toBe(appJson.ios.bundleIdentifier);
    expect(c.ios.appleTeamId).toBe(appJson.ios.appleTeamId);
    expect(c.ios.infoPlist).toBe(appJson.ios.infoPlist);
    expect(c.name).toBe("You're On");
  });

  it('takes the bundle ID, team and home-screen name from the env', () => {
    const c = applyEnv(appJson, {
      IOS_BUNDLE_ID: 'dev.youreon.app.eas.dev',
      APPLE_TEAM_ID: 'ABCDE12345',
      IOS_DISPLAY_NAME: "You're On Dev",
    });
    expect(c.ios.bundleIdentifier).toBe('dev.youreon.app.eas.dev');
    expect(c.ios.appleTeamId).toBe('ABCDE12345');
    expect(c.ios.infoPlist.CFBundleDisplayName).toBe("You're On Dev");
    // the usage strings survive the infoPlist merge
    expect(c.ios.infoPlist.NSCameraUsageDescription).toBe(
      appJson.ios.infoPlist.NSCameraUsageDescription,
    );
  });

  it('does not mutate the config it is given', () => {
    const before = JSON.stringify(appJson);
    applyEnv(appJson, { IOS_BUNDLE_ID: 'a.b', IOS_DISPLAY_NAME: 'X' });
    expect(JSON.stringify(appJson)).toBe(before);
  });

  it('rejects malformed values before prebuild can bake them in', () => {
    expect(() => applyEnv(appJson, { IOS_BUNDLE_ID: 'nodots' })).toThrow('IOS_BUNDLE_ID');
    expect(() => applyEnv(appJson, { IOS_BUNDLE_ID: 'dev.you_re.on' })).toThrow('IOS_BUNDLE_ID');
    expect(() => applyEnv(appJson, { APPLE_TEAM_ID: '2lfbz8aaax' })).toThrow('APPLE_TEAM_ID');
    expect(() => applyEnv(appJson, { APPLE_TEAM_ID: 'ABC' })).toThrow('APPLE_TEAM_ID');
    expect(() => applyEnv(appJson, { IOS_DISPLAY_NAME: '' })).toThrow('IOS_DISPLAY_NAME');
    expect(() => applyEnv(appJson, { IOS_DISPLAY_NAME: 'x'.repeat(31) })).toThrow(
      'IOS_DISPLAY_NAME',
    );
  });
});

describe('app.config.js EAS Update', () => {
  it('ships expo-updates for SDK 58 as a runtime dependency (EAS ignores a devDependency)', () => {
    const pkg = readJson('apps/mobile/package.json') as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies['expo-updates']).toMatch(/^~58\./);
    expect(pkg.devDependencies['expo-updates']).toBeUndefined();
  });

  it('keeps expo-updates off until the project is linked (free-team builds, CI)', () => {
    // Synthetic, so the unlinked case stays covered after app.json is linked.
    const unlinked = structuredClone(appJson);
    delete unlinked.extra?.eas;
    const c = applyEnv(unlinked, {});
    expect(c.updates).toEqual({ enabled: false });
    expect(c.runtimeVersion).toEqual({ policy: 'appVersion' });
  });

  it("follows app.json: off before `eas init`, on with app.json's project id after", () => {
    // Either state is valid in the repo; app.json decides which one the builds get.
    if (linkedProjectId !== undefined) {
      // eas init writes the project's UUID; anything else would 404 at u.expo.dev.
      expect(linkedProjectId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
    expect(applyEnv(appJson, {}).updates).toEqual(expectedUpdates(linkedProjectId));
  });

  it('derives the update URL from the project id `eas init` writes', () => {
    const linked = { ...appJson, extra: { eas: { projectId: '0000-abcd' } } };
    const c = applyEnv(linked, {});
    expect(c.updates).toEqual({
      enabled: true,
      url: 'https://u.expo.dev/0000-abcd',
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
    });
    // an update only reaches binaries of the same expo.version
    expect(c.runtimeVersion).toEqual({ policy: 'appVersion' });
  });
});

describe('eas.json', () => {
  const eas = readJson('apps/mobile/eas.json') as {
    cli: Record<string, unknown>;
    build: Record<string, Record<string, unknown>>;
  };
  const env = (profile: string) => profileEnvFromEasJson(eas, profile) ?? {};

  it('uploads the working tree, so the git-ignored face model goes up (no requireCommit)', () => {
    expect(eas.cli.requireCommit).toBeUndefined();
    expect(eas.cli.version).toBe('>= 27.10.0');
    // expo-notifications is installed for local notifications only: no APNs key prompt.
    expect(eas.cli.promptToConfigurePushNotifications).toBe(false);
  });

  it('pins the Xcode 26.6 image the Release build was verified on', () => {
    expect((eas.build.base?.ios as Record<string, unknown>).image).toBe(
      'macos-tahoe-26.5-xcode-26.6',
    );
    expect(eas.build.base?.node).toBe('22.23.4');
  });

  it('builds the phones with a bundle ID no free Personal Team has claimed', () => {
    // dev.youreon.app (app.json) may already belong to the lead's free team; a bundle ID belongs
    // to exactly one team, so the paid team would be refused it.
    expect(env('preview').IOS_BUNDLE_ID).toBe('dev.youreon.app.eas');
    expect(env('preview').IOS_BUNDLE_ID).not.toBe(appJson.ios.bundleIdentifier);
    // TestFlight replaces the ad hoc install (same keychain); the dev client sits beside it.
    expect(env('production').IOS_BUNDLE_ID).toBe(env('preview').IOS_BUNDLE_ID);
    expect(env('development').IOS_BUNDLE_ID).toBe('dev.youreon.app.eas.dev');
    expect(env('development').IOS_DISPLAY_NAME).toBe("You're On Dev");
  });

  it.each(['preview', 'preview-typed', 'pitch'])(
    '%s is an internal release build against the Fly server',
    (profile) => {
      const p = eas.build[profile] ?? {};
      const chain = [p, eas.build[String(p.extends)] ?? {}];
      expect(chain.some((x) => x.distribution === 'internal')).toBe(true);
      expect(chain.some((x) => x.developmentClient)).toBe(false);
      expect(env(profile).EXPO_PUBLIC_API_URL).toBe('https://youre-on.fly.dev');
      expect(env(profile).EXPO_PUBLIC_BUILD).toBe(profile);
    },
  );

  it('gives every profile its own EAS Update channel (EXPO_PUBLIC_* are baked into updates)', () => {
    const channels = Object.entries(eas.build)
      .filter(([name]) => name !== 'base')
      .map(([name, p]) => [name, p.channel]);
    expect(Object.fromEntries(channels)).toEqual({
      development: 'development',
      preview: 'preview',
      'preview-typed': 'preview-typed',
      pitch: 'pitch',
      production: 'production',
    });
  });

  it('sets EXPO_PUBLIC_VOICE explicitly per profile (eas.json env beats EAS env vars)', () => {
    expect(env('preview').EXPO_PUBLIC_VOICE).toBe('on');
    expect(env('pitch').EXPO_PUBLIC_VOICE).toBe('on');
    expect(env('preview-typed').EXPO_PUBLIC_VOICE).toBe('off');
  });

  it('answers export compliance in app.json, so eas build never rewrites app.json', () => {
    // Unanswered, eas build prompts and then writes the EVALUATED ios block (eas.json's
    // IOS_BUNDLE_ID, the dev client's "You're On Dev") into app.json. HTTPS, WSS, WebRTC
    // (DTLS-SRTP), Ed25519 signatures and the keychain are all standard/exempt encryption.
    const infoPlist = appJson.ios.infoPlist as Record<string, unknown>;
    expect(infoPlist.ITSAppUsesNonExemptEncryption).toBe(false);
    // and a local version source would have eas-cli write build numbers into app.json
    expect(eas.cli.appVersionSource).toBe('remote');
  });

  it('never sets APPLE_TEAM_ID (EAS takes it from the credentials)', () => {
    for (const profile of Object.keys(eas.build)) {
      expect(env(profile).APPLE_TEAM_ID, profile).toBeUndefined();
    }
  });
});

// .easignore is read by eas-cli with the `ignore` package, which follows gitignore semantics, so
// git itself is a faithful stand-in for these rule checks.
describe('.easignore (what eas build uploads)', () => {
  const tmp: string[] = [];
  afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

  /** A scratch repo whose only ignore files are `files` (path -> contents). */
  function repo(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'easignore-'));
    tmp.push(dir);
    spawnSync('git', ['init', '-q'], { cwd: dir });
    for (const [rel, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), contents);
    }
    return (paths: string[]) => {
      const r = spawnSync(
        'git',
        ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', '--stdin'],
        { cwd: dir, input: paths.join('\n'), encoding: 'utf8' },
      );
      return new Set(r.stdout.split('\n').filter(Boolean));
    };
  }
  const easIgnored = repo({ '.gitignore': read('.easignore') });

  it('uploads the face model, and only that .tflite', () => {
    const model = `apps/mobile/assets/models/${FACE_MODEL.fileName}`;
    const ignored = easIgnored([model, 'apps/mobile/assets/models/w600k_mbf_float16.tflite']);
    expect(ignored.has(model)).toBe(false);
    expect(ignored.has('apps/mobile/assets/models/w600k_mbf_float16.tflite')).toBe(true);
  });

  it('keeps everything the build and the workspace install need', () => {
    const needed = [
      '.easignore',
      'package.json',
      'package-lock.json',
      '.env.example',
      'patches/react-native-vision-camera-face-detector+2.1.0.patch',
      'scripts/eas-build-hook.sh',
      'scripts/keys.ts',
      'scripts/lib/keys.ts',
      'apps/mobile/app.json',
      'apps/mobile/app.config.js',
      'apps/mobile/eas.json',
      'apps/mobile/assets/models/NOTICE-w600k_mbf.txt',
      'apps/server/package.json',
      'apps/stage/package.json',
      'packages/shared/package.json',
      'packages/db/package.json',
    ];
    expect([...easIgnored(needed)]).toEqual([]);
  });

  it('keeps secrets, keypairs, local native folders and worktrees out', () => {
    const secret = [
      '.env',
      'apps/server/.env',
      'apps/mobile/.env.local',
      'apps/mobile/.env.production.local',
      'fee-payer-keypair.json',
      'programs/escrow/target/deploy/escrow-keypair.json',
      'keys/lead.json',
      '.keys/x.json',
      'apps/mobile/AuthKey_ABC.p8',
      'apps/mobile/dist.p12',
      'apps/mobile/adhoc.mobileprovision',
      'apps/mobile/ios',
      'apps/mobile/ios/Podfile',
      'apps/mobile/android/app/build.gradle',
      'apps/mobile/.expo/settings.json',
      'node_modules/expo/package.json',
      'apps/mobile/node_modules/x/index.js',
      '.claude',
      '.claude/worktrees/wf_1/apps/mobile/App.tsx',
      '.claude-artifacts/x',
      'apps/stage/public/replay/beat1.mp4',
      'build-1.ipa',
      'YoureOn.xcarchive',
      'npm-debug.log',
    ];
    const ignored = easIgnored(secret);
    expect(secret.filter((p) => !ignored.has(p))).toEqual([]);
  });

  // Drift guard: eas-cli reads ONLY .easignore once it exists, so every rule a .gitignore gains
  // must be mirrored there. For each rule, make a path git ignores and check .easignore does too.
  const gitignores = [
    '.gitignore',
    'apps/mobile/.gitignore',
    'apps/stage/.gitignore',
    'programs/escrow/.gitignore',
  ];
  it.each(gitignores)('mirrors every rule of %s', (file) => {
    const base = dirname(file) === '.' ? '' : `${dirname(file)}/`;
    const samples = read(file)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
      .map((rule) => {
        const dirOnly = rule.endsWith('/');
        const body = rule
          .replace(/^\//, '')
          .replace(/\/$/, '')
          .replace(/^\*\*\//, '')
          .replace(/\*\*/g, 'x')
          .replace(/\*/g, 'x');
        return `${base}${body}${dirOnly ? '/f' : ''}`;
      });
    const gitIgnored = repo({ [file]: read(file) })(samples);
    // sanity: git really ignores each sample under the original rule
    expect(samples.filter((s) => !gitIgnored.has(s))).toEqual([]);
    const eas = easIgnored(samples);
    const missed = samples.filter((s) => !eas.has(s));
    expect(missed, `rules of ${file} missing from .easignore`).toEqual([]);
  });

  it('mirrors the local excludes of the lead checkout (.git/info/exclude)', () => {
    expect(easIgnored(['.claude/worktrees/x/a.ts', '.claude-artifacts/y']).size).toBe(2);
  });
});

describe('evaluated iOS config (expo config --type introspect, preview env)', () => {
  const expoCli = join(ROOT, 'node_modules/expo/bin/cli');
  const r = spawnSync(process.execPath, [expoCli, 'config', '--json', '--type', 'introspect'], {
    cwd: join(ROOT, 'apps/mobile'),
    encoding: 'utf8',
    env: {
      ...process.env,
      ...profileEnvFromEasJson(readJson('apps/mobile/eas.json'), 'preview'),
      APPLE_TEAM_ID: 'ABCDE12345',
      EXPO_NO_DOTENV: '1',
      CI: '1',
    },
    timeout: 120_000,
  });
  const exp = JSON.parse(r.stdout || '{}') as {
    ios?: {
      bundleIdentifier: string;
      appleTeamId: string;
      entitlements?: Record<string, unknown>;
      infoPlist: Record<string, unknown>;
    };
  };

  it('evaluates', () => {
    expect(r.status, r.stderr).toBe(0);
  });

  it('has no APNs entitlement, so neither a free team nor EAS needs Push Notifications', () => {
    expect(exp.ios?.entitlements?.['aps-environment']).toBeUndefined();
    expect(exp.ios?.infoPlist.UIBackgroundModes ?? []).not.toContain('remote-notification');
  });

  it('turns EAS Update on exactly when app.json carries the EAS project id', () => {
    expect((exp as { updates?: unknown }).updates).toEqual(expectedUpdates(linkedProjectId));
  });

  it('carries the EAS bundle ID and the team EAS injects', () => {
    expect(exp.ios?.bundleIdentifier).toBe('dev.youreon.app.eas');
    expect(exp.ios?.appleTeamId).toBe('ABCDE12345');
    expect(exp.ios?.infoPlist.CFBundleDisplayName).toBe("You're On");
  });
});
