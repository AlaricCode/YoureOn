// Publishes a JS-only fix to the phones over the air (EAS Update), with the same public env the
// installed build was made with (docs/IOS-BUILD.md, "Paid account (EAS)"). Run it through
// scripts/eas-update.sh.
//
// Why a wrapper instead of plain `eas update`:
//   - EXPO_PUBLIC_* values are inlined when the bundle is made. Plain `eas update` bundles with the
//     LOCAL environment (apps/mobile/.env.local may point at a laptop IP or turn voice off), not
//     with eas.json's build profile env. This exports the bundle itself with the profile's env,
//     dotenv off, and checks the API URL made it into the bundle before anything is published.
//   - runtimeVersion follows expo.version ("appVersion"), so EAS would happily deliver JS that
//     needs a native module the installed binary lacks. This compares the project's fingerprint
//     with the latest finished build of the profile (eas fingerprint:compare) and refuses on a
//     difference: rebuild instead.
//   - It refuses a dirty git tree, so every update is a commit.
//   - It refuses a bundle that carries apps/mobile/assets/dance/local/ (the original song a local
//     demo build may use, metro.config.js): the folder is gitignored, so the git check misses it.
//
// Usage: npx tsx apps/mobile/scripts/eas-update.ts --profile preview|preview-typed|pitch
//          --message "what changed" [--dry-run] [--allow-dirty] [--allow-native-changes]
//          [--eas-cli DIR]
//   --dry-run  export + check only, print the eas update command (no login needed)
// Exit codes: 0 published (or dry run ok), 1 refused or failed, 64 bad usage.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_ENV,
  EAS_CLI_VERSION,
  packageDir,
  type Profile,
  resolveEasCli,
} from './eas-preflight';

export interface UpdateArgs {
  profile: string;
  message: string;
  dryRun: boolean;
  allowDirty: boolean;
  allowNativeChanges: boolean;
  easCli: string | null;
}

export function parseUpdateArgs(argv: string[]): UpdateArgs {
  const out: UpdateArgs = {
    profile: '',
    message: '',
    dryRun: false,
    allowDirty: false,
    allowNativeChanges: false,
    easCli: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${String(a)} needs a value`);
      return v;
    };
    if (a === '--profile') out.profile = value();
    else if (a === '--message' || a === '-m') out.message = value();
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--allow-dirty') out.allowDirty = true;
    else if (a === '--allow-native-changes') out.allowNativeChanges = true;
    else if (a === '--eas-cli') out.easCli = value();
    else throw new Error(`unknown argument: ${String(a)}`);
  }
  if (!out.profile) throw new Error('--profile is required (preview, preview-typed or pitch)');
  if (!out.message.trim()) throw new Error('--message is required');
  return out;
}

export interface ResolvedProfile extends Profile {
  channel?: string;
  environment?: string;
}

/** The profile must be one that installs as a release build and listens on a channel. */
export function checkUpdatableProfile(name: string, p: ResolvedProfile): string | null {
  if (!p.channel) return `profile "${name}" has no channel in eas.json`;
  if (p.developmentClient) return `profile "${name}" is a dev client: it loads JS from Metro`;
  if (!p.env?.EXPO_PUBLIC_API_URL?.startsWith('https://')) {
    return `profile "${name}" has no https EXPO_PUBLIC_API_URL`;
  }
  return null;
}

export type GuardVerdict =
  { ok: true; buildId: string; detail: string } | { ok: false; buildId?: string; reason: string };

/**
 * Decides from `eas build:list --json` and `eas fingerprint:compare --build-id <id> --json`
 * whether the project still matches the installed binary. Anything unexpected refuses
 * (fail-safe): --allow-native-changes is the override.
 */
export function nativeGuard(buildList: unknown, compare: unknown): GuardVerdict {
  const build = Array.isArray(buildList)
    ? (buildList[0] as Record<string, unknown> | undefined)
    : undefined;
  if (!build || typeof build.id !== 'string') {
    return { ok: false, reason: 'no finished iOS build of this profile on EAS yet: build first' };
  }
  const c = compare as {
    fingerprint1?: { hash?: unknown };
    fingerprint2?: { hash?: unknown };
  } | null;
  const a = c?.fingerprint1?.hash;
  const b = c?.fingerprint2?.hash;
  if (typeof a !== 'string' || typeof b !== 'string') {
    return {
      ok: false,
      buildId: build.id,
      reason: 'could not compare fingerprints with the build',
    };
  }
  if (a !== b) {
    return {
      ok: false,
      buildId: build.id,
      reason:
        `native code or config changed since build ${build.id} (fingerprint ${a.slice(0, 10)} vs ` +
        `${b.slice(0, 10)}): this needs a new build, not an update. See the diff with: ` +
        `npx eas-cli@${EAS_CLI_VERSION} fingerprint:compare --build-id ${build.id}`,
    };
  }
  const commit = typeof build.gitCommitHash === 'string' ? build.gitCommitHash.slice(0, 7) : '?';
  return { ok: true, buildId: build.id, detail: `matches build ${build.id} (commit ${commit})` };
}

/** True if the (Hermes or plain JS) bundle carries `needle` as a string. */
export function bundleMentions(bundle: Buffer, needle: string): boolean {
  return (
    bundle.includes(Buffer.from(needle, 'utf8')) || bundle.includes(Buffer.from(needle, 'utf16le'))
  );
}

/** iOS bundle paths and asset extensions listed in an `expo export` metadata.json. */
export function exportedIos(metadata: unknown): { bundle: string | null; assetExts: string[] } {
  const ios = (metadata as { fileMetadata?: { ios?: { bundle?: unknown; assets?: unknown } } })
    ?.fileMetadata?.ios;
  const assets = Array.isArray(ios?.assets) ? (ios.assets as { ext?: unknown }[]) : [];
  return {
    bundle: typeof ios?.bundle === 'string' ? ios.bundle : null,
    assetExts: assets.map((x) => String(x.ext)),
  };
}

/** The Dance Off local media folder (metro.config.js): its files never go out in an update. */
const DANCE_LOCAL_SEGMENT = /(^|[\\/])assets[\\/]dance[\\/]local([\\/]|$)/;

/**
 * Files from apps/mobile/assets/dance/local/ (the original song a local demo build may carry,
 * metro.config.js) listed in an `expo export --dump-assetmap` assetmap.json. Any is a refusal:
 * an update reaches every install on the channel.
 */
export function localDanceAssets(assetmap: unknown): string[] {
  if (!assetmap || typeof assetmap !== 'object') return [];
  const out: string[] = [];
  for (const a of Object.values(assetmap as Record<string, unknown>)) {
    const x = a as { files?: unknown; fileSystemLocation?: unknown } | null;
    const paths = [
      ...(Array.isArray(x?.files) ? x.files.map(String) : []),
      ...(typeof x?.fileSystemLocation === 'string' ? [x.fileSystemLocation] : []),
    ];
    for (const p of paths) if (DANCE_LOCAL_SEGMENT.test(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

export function updateCommand(p: {
  channel: string;
  environment: string;
  message: string;
  inputDir: string;
}): string[] {
  return [
    'update',
    '--skip-bundler',
    '--input-dir',
    p.inputDir,
    '--channel',
    p.channel,
    '--environment',
    p.environment,
    '--platform',
    'ios',
    '--message',
    p.message,
    '--non-interactive',
  ];
}

// ---- IO ------------------------------------------------------------------------------------

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  return {
    status: r.error ? null : r.status,
    stdout: String(r.stdout ?? ''),
    stderr: r.error ? r.error.message : String(r.stderr ?? ''),
  };
}
const say = (s: string) => console.log(`eas-update: ${s}`);
const refuse = (s: string) => {
  console.error(`eas-update: REFUSED: ${s}`);
  return 1;
};

export async function main(argv: string[]): Promise<number> {
  let args: UpdateArgs;
  try {
    args = parseUpdateArgs(argv);
  } catch (e) {
    console.error(`eas-update: ${e instanceof Error ? e.message : String(e)}`);
    return 64;
  }
  const mobile = dirname(dirname(fileURLToPath(import.meta.url)));
  const root = dirname(dirname(mobile));
  const easCliDir = resolveEasCli(args.easCli, false);
  if (!easCliDir) return refuse(`could not get eas-cli ${EAS_CLI_VERSION} (npm exec)`);
  const eas = (a: string[], opts: SpawnSyncOptions = {}) =>
    run(process.execPath, [join(easCliDir, 'bin/run'), ...a], {
      cwd: mobile,
      env: { ...process.env, EXPO_NO_TELEMETRY: '1' },
      ...opts,
    });

  // 1. The profile, resolved by eas-cli itself (extends, schema).
  const cfg = eas([
    'config',
    '--eas-json-only',
    '--platform',
    'ios',
    '--profile',
    args.profile,
    '--json',
    '--non-interactive',
  ]);
  let profile: ResolvedProfile;
  try {
    profile = (JSON.parse(cfg.stdout) as { buildProfile: ResolvedProfile }).buildProfile;
  } catch {
    return refuse(`eas.json has no usable profile "${args.profile}": ${cfg.stderr.trim()}`);
  }
  const bad = checkUpdatableProfile(args.profile, profile);
  if (bad) return refuse(bad);
  const env = profile.env ?? {};
  const channel = String(profile.channel);
  const environment = profile.environment ?? 'preview';
  say(
    `profile ${args.profile}: channel ${channel}, ${env.EXPO_PUBLIC_API_URL}, voice ${env.EXPO_PUBLIC_VOICE ?? 'on'}`,
  );

  // 2. Every update is a commit.
  const dirty = run('git', ['status', '--porcelain'], { cwd: root }).stdout.trim();
  if (dirty && !args.allowDirty)
    return refuse('uncommitted changes; commit first (or --allow-dirty)');

  // 3. Native guard (needs login).
  const loggedIn = eas(['whoami']).status === 0;
  if (!loggedIn && !args.dryRun)
    return refuse(`not logged in: npx eas-cli@${EAS_CLI_VERSION} login`);
  if (loggedIn) {
    const list = eas([
      'build:list',
      '--platform',
      'ios',
      '--build-profile',
      args.profile,
      '--status',
      'finished',
      '--limit',
      '1',
      '--json',
      '--non-interactive',
    ]);
    let builds: unknown = null;
    try {
      builds = JSON.parse(list.stdout);
    } catch {
      /* handled by nativeGuard */
    }
    const id = Array.isArray(builds) ? (builds[0] as { id?: string } | undefined)?.id : undefined;
    let compare: unknown = null;
    if (id) {
      // With the profile's env, as `eas build` had when it fingerprinted the build: the
      // fingerprint covers the evaluated app config, and IOS_BUNDLE_ID changes it.
      const c = eas(
        [
          'fingerprint:compare',
          '--build-id',
          id,
          '--environment',
          environment,
          '--json',
          '--non-interactive',
        ],
        { env: { ...process.env, ...env, EXPO_NO_TELEMETRY: '1' } },
      );
      try {
        compare = JSON.parse(c.stdout);
      } catch {
        /* handled by nativeGuard */
      }
    }
    const verdict = nativeGuard(builds, compare);
    if (verdict.ok) say(`native guard: ${verdict.detail}`);
    else if (args.allowNativeChanges) say(`native guard overridden: ${verdict.reason}`);
    else return refuse(`${verdict.reason} (override: --allow-native-changes)`);
  } else {
    say('native guard skipped (dry run, not logged in)');
  }

  // 4. Bundle with the profile's env, dotenv off (what the build had), then check it.
  const dist = join(mobile, 'dist');
  rmSync(dist, { recursive: true, force: true });
  const expo = packageDir(mobile, 'expo');
  if (!expo) return refuse('expo is not installed: npm ci');
  const exportEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    EXPO_NO_DOTENV: '1',
    NODE_ENV: 'production',
  };
  for (const k of CONFIG_ENV) if (!(k in env)) delete exportEnv[k];
  // Never the local Dance Off media (metro.config.js), whatever the shell has.
  delete exportEnv.DANCE_LOCAL_MEDIA;
  for (const k of Object.keys(exportEnv)) {
    if (k.startsWith('EXPO_PUBLIC_') && !(k in env)) delete exportEnv[k];
  }
  say('exporting the iOS bundle…');
  const exp = spawnSync(
    process.execPath,
    [
      join(expo, 'bin/cli'),
      'export',
      '--platform',
      'ios',
      '--output-dir',
      'dist',
      '--dump-assetmap',
      '--dump-sourcemap',
    ],
    { cwd: mobile, env: exportEnv, stdio: 'inherit' },
  );
  if (exp.status !== 0) return refuse('expo export failed');
  const metaPath = join(dist, 'metadata.json');
  if (!existsSync(metaPath)) return refuse('expo export wrote no metadata.json');
  const { bundle, assetExts } = exportedIos(JSON.parse(readFileSync(metaPath, 'utf8')));
  if (!bundle || !existsSync(join(dist, bundle))) return refuse('no iOS bundle in dist/');
  const url = String(env.EXPO_PUBLIC_API_URL);
  if (!bundleMentions(readFileSync(join(dist, bundle)), url)) {
    return refuse(
      `the exported bundle does not contain ${url}; EXPO_PUBLIC_API_URL was not inlined`,
    );
  }
  if (!assetExts.includes('tflite'))
    return refuse('the export has no .tflite asset (face model missing?)');
  const mapPath = join(dist, 'assetmap.json');
  if (!existsSync(mapPath)) return refuse('expo export wrote no assetmap.json');
  const local = localDanceAssets(JSON.parse(readFileSync(mapPath, 'utf8')));
  if (local.length > 0) {
    return refuse(
      `the bundle carries local Dance Off media (never published): ${local.join(', ')}`,
    );
  }
  say(`bundle ok: ${bundle} carries ${url}; ${assetExts.length} assets incl. the face model`);
  say(`files: ${readdirSync(dist).join(', ')}`);

  // 5. Publish.
  const cmd = updateCommand({ channel, environment, message: args.message, inputDir: 'dist' });
  if (args.dryRun) {
    say(
      `dry run: would run (in apps/mobile): npx eas-cli@${EAS_CLI_VERSION} ${cmd.map((c) => (/\s/.test(c) ? JSON.stringify(c) : c)).join(' ')}`,
    );
    return 0;
  }
  const pub = spawnSync(process.execPath, [join(easCliDir, 'bin/run'), ...cmd], {
    cwd: mobile,
    env: { ...exportEnv, EXPO_NO_TELEMETRY: '1' },
    stdio: 'inherit',
  });
  if (pub.status !== 0) return refuse('eas update failed');
  say(
    `published to channel ${channel}. Phones get it on the next cold start: force-quit, open, wait ~10 s, force-quit, open.`,
  );
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e);
      process.exit(1);
    },
  );
}
