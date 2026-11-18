// EAS Build preflight for the iOS app (docs/IOS-BUILD.md, "Paid account (EAS)"). Run it through
// scripts/eas-preflight.sh before every `eas build`. It only reads: no login, no build, no writes
// to the repo (the archive replay and the `npm ci --dry-run` run in a temp directory).
//
// What it proves, in order:
//   1. tools and repo state (git clean warning, shell variables that would skew the build);
//   2. the face model is present, byte-identical to FACE_MODEL, and NOT tracked by git (licence);
//   3. dependencies EAS will install: package-lock in sync (npm 10, as on the worker), the
//      @livekit/react-native-webrtc 144.1.2 override resolved everywhere, every patch-package
//      patch applied to the installed package;
//   4. eas.json is valid for eas-cli 27.10.0 (its own schema and `extends` resolution) and every
//      profile that installs on phones is a release build talking to an https server;
//   5. the app config evaluates with a profile's env (bundle ID, no APNs entitlement);
//   6. the upload: eas-cli's own working-tree copy (vcs/local.js makeShallowCopyAsync, the code
//      `eas build` runs) contains the model and every file the build needs, and nothing git
//      ignores (secrets, keypairs, a local ios/ folder, .claude worktrees); and eas-cli's own
//      workflow resolution says "managed", so EAS runs prebuild itself.
//
// Usage: npx tsx apps/mobile/scripts/eas-preflight.ts [--offline] [--strict] [--profile NAME]
//                                                     [--eas-cli DIR]
//   --offline   skip everything that needs the network (fetching eas-cli or npm 10, whoami);
//               the eas.json and upload checks then run only if eas-cli is already cached
//   --strict    exit 1 on warnings too
//   --profile   build profile whose env evaluates the app config (default: preview)
//   --eas-cli   an installed eas-cli package directory (else: EAS_CLI_DIR, else npx's cache)
// Exit codes: 0 no failures, 1 failures (or warnings with --strict), 64 bad usage.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FACE_MODEL } from '../src/face/model';

export const EAS_CLI_VERSION = '27.10.0';
/** npm bundled with eas.json's Node 22.23.4, i.e. the npm that runs `npm ci` on the worker. */
export const WORKER_NPM_VERSION = '10.9.9';
export const WEBRTC = { name: '@livekit/react-native-webrtc', version: '144.1.2' } as const;
export const PROFILES = ['development', 'preview', 'preview-typed', 'pitch', 'production'];
/** Profiles that install on the demo phones: release JS, internal distribution. */
export const DEVICE_PROFILES = ['preview', 'preview-typed', 'pitch'];
/** eas-cli warns above this upload size (build/utils/repository.js). */
export const ARCHIVE_WARN_BYTES = 150 * 1024 * 1024;
export const MODEL_PATH = `apps/mobile/assets/models/${FACE_MODEL.fileName}`;
/** Shell variables app.config.js reads. eas.json pins them per profile; a stray export only
 * skews eas-cli's LOCAL evaluation of the config (bundle ID used for credentials). */
export const CONFIG_ENV = ['IOS_BUNDLE_ID', 'APPLE_TEAM_ID', 'IOS_DISPLAY_NAME'];

export type Status = 'pass' | 'warn' | 'fail' | 'info' | 'skip';
export interface Result {
  status: Status;
  title: string;
  detail?: string;
}
const pass = (title: string, detail?: string): Result => ({ status: 'pass', title, detail });
const warn = (title: string, detail?: string): Result => ({ status: 'warn', title, detail });
const fail = (title: string, detail?: string): Result => ({ status: 'fail', title, detail });
const info = (title: string, detail?: string): Result => ({ status: 'info', title, detail });
const skip = (title: string, detail?: string): Result => ({ status: 'skip', title, detail });

type Json = Record<string, unknown>;
const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json;
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}
function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): Run {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  return {
    status: r.error ? null : r.status,
    stdout: String(r.stdout ?? ''),
    stderr: r.error ? r.error.message : String(r.stderr ?? ''),
  };
}
const lines = (s: string) => s.split('\n').filter((l) => l.length > 0);

// ---- pure checks (unit-tested) -------------------------------------------------------------

/** Compares dotted numeric versions: -1, 0, 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function checkNode(version: string, engines = '>=22.4'): Result {
  const min = engines.replace(/^>=\s*/, '');
  return compareVersions(version, min) >= 0
    ? pass(`node ${version}`, `root engines ${engines}; EAS uses eas.json "node"`)
    : fail(`node ${version} is older than ${min}`, 'install Node 22 (.nvmrc) and run npm ci');
}

export function checkShellEnv(env: Record<string, string | undefined>): Result[] {
  const out: Result[] = [];
  const stray = CONFIG_ENV.filter((k) => env[k] !== undefined && env[k] !== '');
  out.push(
    stray.length === 0
      ? pass('no IOS_BUNDLE_ID / APPLE_TEAM_ID / IOS_DISPLAY_NAME in the shell')
      : info(
          `exported in this shell: ${stray.join(', ')} (free-team leftovers?)`,
          'EAS builds are unaffected (eas.json pins IOS_BUNDLE_ID per profile; EAS sets ' +
            `APPLE_TEAM_ID from the credentials), but local npx expo commands use them: unset ${stray.join(' ')}`,
        ),
  );
  if (env.EAS_NO_VCS) {
    out.push(
      info('EAS_NO_VCS is set', 'same upload rules (.easignore), but builds carry no git commit'),
    );
  }
  return out;
}

export interface ModelFacts {
  exists: boolean;
  size?: number;
  sha256?: string;
  tracked: boolean;
}
export function checkModel(m: ModelFacts, scriptSha: string | null): Result[] {
  const out: Result[] = [];
  const fix = 'run scripts/face-model.sh (or copy the file from a teammate) and re-run';
  if (!m.exists) {
    out.push(fail(`face model missing: ${MODEL_PATH}`, fix));
  } else if (m.size !== FACE_MODEL.sizeBytes || m.sha256 !== FACE_MODEL.sha256) {
    out.push(
      fail(
        `face model differs from FACE_MODEL (${m.size} bytes, sha256 ${m.sha256?.slice(0, 12)}…)`,
        `expected ${FACE_MODEL.sizeBytes} bytes, sha256 ${FACE_MODEL.sha256.slice(0, 12)}…; ${fix}`,
      ),
    );
  } else {
    out.push(
      pass(
        `face model ${FACE_MODEL.fileName}`,
        `${FACE_MODEL.sizeBytes} bytes, sha256 ${FACE_MODEL.sha256.slice(0, 12)}…`,
      ),
    );
  }
  out.push(
    m.tracked
      ? fail(
          'the face model is tracked by git',
          'its weights are non-commercial research-only and the repo is public: ' +
            `git rm --cached ${MODEL_PATH}`,
        )
      : pass('the face model is not in git (licence)', 'it reaches EAS through .easignore'),
  );
  if (scriptSha !== null && scriptSha !== FACE_MODEL.sha256) {
    out.push(fail('scripts/face-model.sh EXPECTED_SHA256 differs from FACE_MODEL.sha256'));
  }
  return out;
}

/** Every lockfile entry of `name`, keyed by its node_modules path. */
export function lockVersions(lock: Json, name: string): Record<string, string> {
  const packages = (lock.packages ?? {}) as Record<string, { version?: string }>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(packages)) {
    if (key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`)) {
      out[key] = value.version ?? '?';
    }
  }
  return out;
}

export function checkWebrtcPin(
  rootPkg: Json,
  mobilePkg: Json,
  lock: Json,
  installed: Record<string, string>,
): Result[] {
  const out: Result[] = [];
  const { name, version } = WEBRTC;
  const override = (rootPkg.overrides as Record<string, unknown> | undefined)?.[name];
  const dep = (mobilePkg.dependencies as Record<string, string> | undefined)?.[name];
  out.push(
    override === version && dep === version
      ? pass(`${name} override ${version}`, 'root package.json overrides + apps/mobile dependency')
      : fail(
          `${name} pin broken (override ${String(override)}, dependency ${String(dep)})`,
          `both must be exactly ${version}: older builds fail on WebRTC/WebRTC.h`,
        ),
  );
  const locked = lockVersions(lock, name);
  const badLock = Object.entries(locked).filter(([, v]) => v !== version);
  out.push(
    Object.keys(locked).length > 0 && badLock.length === 0
      ? pass(`package-lock resolves ${name} only to ${version}`, Object.keys(locked).join(', '))
      : fail(
          `package-lock resolves ${name} to ${badLock.map(([k, v]) => `${v} (${k})`).join(', ') || 'nothing'}`,
          'run npm install at the repo root and commit package-lock.json',
        ),
  );
  const badInstalled = Object.entries(installed).filter(([, v]) => v !== version);
  out.push(
    Object.keys(installed).length > 0 && badInstalled.length === 0
      ? pass(`node_modules has ${name} ${version}`)
      : fail(
          `node_modules has ${name} ${badInstalled.map(([k, v]) => `${v} at ${k}`).join(', ') || 'missing'}`,
          'run npm ci at the repo root',
        ),
  );
  return out;
}

/** `name+1.2.3.patch` / `@scope+name+1.2.3.patch` (patch-package file names). */
export function parsePatchName(file: string): { name: string; version: string } | null {
  const m = /^(.+)\+([^+]+)\.patch$/.exec(file);
  if (!m?.[1] || !m[2]) return null;
  return { name: m[1].replace(/\+/g, '/'), version: m[2] };
}

/** Lines each file of a unified diff adds, keyed by the path inside the package. */
export function addedLines(patch: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of patch.split('\n')) {
    const header = /^\+\+\+ b\/node_modules\/(?:@[^/]+\/)?[^/]+\/(.+)$/.exec(line);
    if (header?.[1]) {
      current = [];
      out.set(header[1], current);
    } else if (line.startsWith('diff --git') || line.startsWith('--- ')) {
      if (line.startsWith('diff --git')) current = null;
    } else if (current && line.startsWith('+') && line.slice(1).trim().length > 0) {
      current.push(line.slice(1));
    }
  }
  return out;
}

export interface PatchFacts {
  file: string;
  text: string;
  lockVersion: string | undefined;
  installedVersion: string | undefined;
  /** path inside the package -> installed file contents (undefined if missing) */
  installedFiles: Map<string, string | undefined>;
}
export function checkPatch(p: PatchFacts, postinstall: string | undefined): Result[] {
  const parsed = parsePatchName(p.file);
  if (!parsed) return [fail(`patches/${p.file}: not a patch-package file name`)];
  const { name, version } = parsed;
  if (p.lockVersion !== version || p.installedVersion !== version) {
    return [
      fail(
        `patches/${p.file} targets ${name}@${version}`,
        `package-lock has ${String(p.lockVersion)}, node_modules has ${String(p.installedVersion)}`,
      ),
    ];
  }
  const missing: string[] = [];
  for (const [file, added] of addedLines(p.text)) {
    const contents = p.installedFiles.get(file);
    if (contents === undefined) missing.push(`${file} (file missing)`);
    else if (!added.every((l) => contents.includes(l))) missing.push(file);
  }
  const out: Result[] = [
    missing.length === 0
      ? pass(`patch applied: ${name}@${version}`)
      : fail(`patch NOT applied: ${name}@${version}`, `${missing.join(', ')}; run npm ci`),
  ];
  if (!postinstall?.includes('patch-package')) {
    out.push(
      fail('apps/mobile postinstall does not run patch-package', 'EAS would skip the patch'),
    );
  }
  return out;
}

export interface Profile {
  distribution?: string;
  developmentClient?: boolean;
  /** EAS Update channel the build listens on. */
  channel?: string;
  env?: Record<string, string>;
  image?: string;
  node?: string;
}
export function checkEasJsonRaw(easJson: Json): Result[] {
  const out: Result[] = [];
  const cli = (easJson.cli ?? {}) as Json;
  if (cli.requireCommit === true) {
    out.push(
      fail(
        'eas.json cli.requireCommit is true',
        'eas-cli would upload only committed files, so the git-ignored face model would be left out',
      ),
    );
  } else {
    out.push(pass('eas.json uploads the working tree (requireCommit unset)'));
  }
  // With a local version source, autoIncrement makes eas-cli write the evaluated config (this
  // shell's IOS_BUNDLE_ID, display name…) back into app.json.
  out.push(
    cli.appVersionSource === 'remote'
      ? pass('eas.json appVersionSource remote (EAS keeps the build number)')
      : fail(
          `eas.json appVersionSource is ${String(cli.appVersionSource)}`,
          'use "remote": a local source makes eas build rewrite app.json',
        ),
  );
  const range = typeof cli.version === 'string' ? cli.version : '';
  const min = /^>=\s*(\d+\.\d+\.\d+)$/.exec(range)?.[1];
  out.push(
    min && compareVersions(EAS_CLI_VERSION, min) >= 0
      ? pass(`eas.json cli.version "${range}" accepts eas-cli ${EAS_CLI_VERSION}`)
      : warn(
          `eas.json cli.version "${range}"`,
          `this preflight was written for ${EAS_CLI_VERSION}`,
        ),
  );
  return out;
}

export function checkProfiles(profiles: Record<string, Profile | Error>): Result[] {
  const out: Result[] = [];
  for (const [name, p] of Object.entries(profiles)) {
    if (p instanceof Error) {
      out.push(fail(`eas.json profile "${name}" does not resolve`, p.message));
      continue;
    }
    const env = p.env ?? {};
    const problems: string[] = [];
    if (!env.IOS_BUNDLE_ID) problems.push('no IOS_BUNDLE_ID in env');
    if (DEVICE_PROFILES.includes(name)) {
      if (p.distribution !== 'internal') problems.push(`distribution ${String(p.distribution)}`);
      if (p.developmentClient) problems.push('developmentClient (needs Metro)');
      if (!env.EXPO_PUBLIC_API_URL?.startsWith('https://')) {
        problems.push(`EXPO_PUBLIC_API_URL ${String(env.EXPO_PUBLIC_API_URL)}`);
      }
      if (env.EXPO_PUBLIC_VOICE !== 'on' && env.EXPO_PUBLIC_VOICE !== 'off') {
        problems.push(`EXPO_PUBLIC_VOICE ${String(env.EXPO_PUBLIC_VOICE)} (want on|off)`);
      }
      // EXPO_PUBLIC_* are baked into each update, so two profiles with different env must not
      // share a channel (an update for one would rewrite the other's env).
      if (!p.channel) problems.push('no EAS Update channel');
      const twin = Object.entries(profiles).find(
        ([other, q]) => other !== name && !(q instanceof Error) && q.channel === p.channel,
      );
      if (p.channel && twin) problems.push(`shares channel "${p.channel}" with ${twin[0]}`);
    }
    const summary = [
      p.distribution,
      p.developmentClient ? 'dev client' : 'release JS',
      env.IOS_BUNDLE_ID,
      env.EXPO_PUBLIC_API_URL,
      env.EXPO_PUBLIC_VOICE && `voice ${env.EXPO_PUBLIC_VOICE}`,
      p.channel && `channel ${p.channel}`,
      p.image,
    ]
      .filter(Boolean)
      .join(', ');
    out.push(
      problems.length === 0
        ? pass(`profile ${name}`, summary)
        : fail(`profile ${name}: ${problems.join('; ')}`, summary),
    );
  }
  return out;
}

/**
 * A profile's env merged along its `extends` chain (parent first), read straight from eas.json.
 * Only the fallback when eas-cli is unavailable; eas-cli's own resolution is preferred.
 */
export function profileEnvFromEasJson(easJson: Json, name: string): Record<string, string> | null {
  const build = (easJson.build ?? {}) as Record<string, Json | undefined>;
  const chain: Json[] = [];
  const seen = new Set<string>();
  for (let n: string | undefined = name; n !== undefined;) {
    const p: Json | undefined = build[n];
    if (!p || seen.has(n)) break;
    seen.add(n);
    chain.unshift(p);
    n = typeof p.extends === 'string' ? p.extends : undefined;
  }
  if (chain.length === 0) return null;
  return Object.assign({}, ...chain.map((p) => (p.env ?? {}) as Record<string, string>)) as Record<
    string,
    string
  >;
}

export interface AppConfigFacts {
  profile: string;
  expected: Record<string, string>;
  exp: Json;
}
export function checkAppConfig(f: AppConfigFacts): Result[] {
  const out: Result[] = [];
  const ios = (f.exp.ios ?? {}) as Json;
  const bundleId = ios.bundleIdentifier as string | undefined;
  const want = f.expected.IOS_BUNDLE_ID;
  out.push(
    want === undefined || bundleId === want
      ? pass(
          `app config (${f.profile}) evaluates`,
          `bundle ID ${String(bundleId)}, v${String(f.exp.version)}`,
        )
      : fail(`app config (${f.profile}) bundle ID ${String(bundleId)}, eas.json says ${want}`),
  );
  // Unset, `eas build` asks about export compliance and then writes the EVALUATED ios block
  // (eas.json's IOS_BUNDLE_ID, the dev client's display name) into app.json.
  const infoPlist = (ios.infoPlist ?? {}) as Json;
  out.push(
    typeof infoPlist.ITSAppUsesNonExemptEncryption === 'boolean'
      ? pass(`ITSAppUsesNonExemptEncryption ${String(infoPlist.ITSAppUsesNonExemptEncryption)}`)
      : fail(
          'ios.infoPlist.ITSAppUsesNonExemptEncryption is not set in app.json',
          'eas build would prompt, then rewrite app.json with the evaluated config',
        ),
  );
  const entitlements = (ios.entitlements ?? {}) as Json;
  out.push(
    entitlements['aps-environment'] === undefined
      ? pass('no APNs entitlement (local notifications only)')
      : warn(
          'aps-environment entitlement present',
          'EAS will add the Push Notifications capability; free teams cannot sign it',
        ),
  );
  const eas = ((f.exp.extra ?? {}) as Json).eas as Json | undefined;
  const projectId = typeof eas?.projectId === 'string' ? eas.projectId : null;
  out.push(
    projectId
      ? pass(`linked to EAS project ${projectId}`, `owner ${String(f.exp.owner ?? '?')}`)
      : info(
          'not linked to an EAS project yet',
          '`eas init` (or the first `eas build`) writes extra.eas.projectId + owner into app.json; commit it',
        ),
  );
  const updates = (f.exp.updates ?? {}) as Json;
  const runtime = (f.exp.runtimeVersion ?? {}) as Json;
  if (runtime.policy !== 'appVersion') {
    out.push(
      fail('runtimeVersion is not {"policy":"appVersion"}', JSON.stringify(f.exp.runtimeVersion)),
    );
  } else if (projectId) {
    const url = `https://u.expo.dev/${projectId}`;
    out.push(
      updates.enabled === true && updates.url === url
        ? pass('EAS Update on', `${url}, runtime = expo.version ${String(f.exp.version)}`)
        : fail(
            'EAS Update misconfigured',
            `updates ${JSON.stringify(updates)}; expected url ${url}`,
          ),
    );
  } else {
    out.push(
      updates.enabled === false
        ? info('EAS Update off until the project is linked', 'builds run the embedded JS only')
        : fail('EAS Update enabled without an EAS project', JSON.stringify(updates)),
    );
  }
  return out;
}

export interface ArchiveFacts {
  /** Every entry of the copy, relative, POSIX separators; directories end with "/". */
  entries: string[];
  sizeBytes: number;
  required: string[];
  /** `git ls-files -o -i --exclude-standard --directory` (directories end with "/"). */
  gitIgnored: string[];
  /** Tracked files .easignore drops (`git ls-files -ci --exclude-from=.easignore`). */
  droppedTracked: string[];
}
const FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /(^|\/)\.env(?!\.example$)[^/]*$/, why: 'env file' },
  { re: /-keypair\.json$/, why: 'Solana keypair' },
  { re: /\.(p8|p12|pem|key|jks|mobileprovision)$/, why: 'signing key or profile' },
  { re: /^apps\/mobile\/(ios|android)(\/|$)/, why: 'local native folder' },
  { re: /(^|\/)\.claude(\/|$)/, why: 'Claude worktrees' },
  { re: /(^|\/)node_modules(\/|$)/, why: 'node_modules' },
];
export function auditArchive(a: ArchiveFacts): Result[] {
  const out: Result[] = [];
  const files = new Set(a.entries.filter((e) => !e.endsWith('/')));
  const missing = a.required.filter((r) => !files.has(r));
  out.push(
    missing.length === 0
      ? pass(`upload has the ${a.required.length} files the build needs`, `incl. ${MODEL_PATH}`)
      : fail(`upload is missing: ${missing.join(', ')}`),
  );
  const leaked = a.gitIgnored
    .filter((p) => p !== MODEL_PATH)
    .filter((p) => (p.endsWith('/') ? [...files].some((f) => f.startsWith(p)) : files.has(p)));
  out.push(
    leaked.length === 0
      ? pass(
          'upload has nothing git ignores (except the model)',
          `${a.gitIgnored.length} ignored paths checked`,
        )
      : fail(
          `upload would include git-ignored paths: ${leaked.join(', ')}`,
          'add them to /.easignore',
        ),
  );
  const forbidden = [...files].flatMap((f) => {
    const hit = FORBIDDEN.find((x) => x.re.test(f));
    return hit ? [`${f} (${hit.why})`] : [];
  });
  out.push(
    forbidden.length === 0
      ? pass('upload has no env files, keys, keypairs, ios/ or worktrees')
      : fail(
          `upload would include: ${forbidden.slice(0, 10).join(', ')}`,
          'add them to /.easignore',
        ),
  );
  if (a.droppedTracked.length > 0) {
    out.push(
      warn(
        `.easignore drops ${a.droppedTracked.length} tracked file(s)`,
        a.droppedTracked.slice(0, 10).join(', '),
      ),
    );
  }
  const mib = (a.sizeBytes / 1024 / 1024).toFixed(1);
  out.push(
    a.sizeBytes > ARCHIVE_WARN_BYTES
      ? warn(`upload is ${mib} MiB (eas-cli warns above 150 MiB)`)
      : pass(`upload is ${mib} MiB, ${files.size} files`),
  );
  return out;
}

// ---- IO ------------------------------------------------------------------------------------

export interface Ctx {
  root: string;
  mobile: string;
  offline: boolean;
  profile: string;
  easCliDir: string | null;
}

function gitTracked(root: string, path: string): boolean {
  return run('git', ['ls-files', '--error-unmatch', path], { cwd: root }).status === 0;
}

function repoChecks(ctx: Ctx): Result[] {
  const out: Result[] = [];
  const top = run('git', ['rev-parse', '--show-toplevel'], { cwd: ctx.mobile });
  if (top.status !== 0) return [fail('not a git repository', 'EAS needs git (or EAS_NO_VCS)')];
  if (realpathSync(top.stdout.trim()) !== realpathSync(ctx.root)) {
    out.push(fail(`git root is ${top.stdout.trim()}`, `expected ${ctx.root}`));
  }
  const head = run('git', ['log', '-1', '--format=%h %s'], { cwd: ctx.root }).stdout.trim();
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.root }).stdout.trim();
  const dirty = lines(run('git', ['status', '--porcelain'], { cwd: ctx.root }).stdout);
  out.push(
    dirty.length === 0
      ? pass(`git tree clean on ${branch} (${head})`)
      : warn(
          `git tree has ${dirty.length} uncommitted change(s) on ${branch}`,
          'eas build uploads them as-is; commit first so the build matches a commit: ' +
            dirty.slice(0, 6).join(' | '),
        ),
  );
  if (existsSync(join(ctx.mobile, 'ios'))) {
    out.push(info('local apps/mobile/ios exists', 'not uploaded (.easignore); EAS runs prebuild'));
  }
  return out;
}

function modelChecks(ctx: Ctx): Result[] {
  const path = join(ctx.root, MODEL_PATH);
  const exists = existsSync(path);
  const data = exists ? readFileSync(path) : null;
  const script = readFileSync(join(ctx.root, 'scripts/face-model.sh'), 'utf8');
  const scriptSha = /EXPECTED_SHA256:-([0-9a-f]{64})/.exec(script)?.[1] ?? null;
  return checkModel(
    {
      exists,
      size: data?.length,
      sha256: data ? sha256(data) : undefined,
      tracked: gitTracked(ctx.root, MODEL_PATH),
    },
    scriptSha,
  );
}

/** The nearest node_modules/<name> going up from `from`, the way Node resolves it. */
export function packageDir(from: string, name: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) {
      return join(dir, 'node_modules', name);
    }
    if (dirname(dir) === dir) return null;
  }
}

/** Installed copies of `name` under every node_modules the app or the root resolves from. */
function installedVersions(ctx: Ctx, name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const base of [ctx.root, ctx.mobile]) {
    const pkg = join(base, 'node_modules', name, 'package.json');
    if (existsSync(pkg)) {
      out[relative(ctx.root, dirname(pkg)) || '.'] = String(readJson(pkg).version);
    }
  }
  return out;
}

function dependencyChecks(ctx: Ctx): Result[] {
  const rootPkg = readJson(join(ctx.root, 'package.json'));
  const mobilePkg = readJson(join(ctx.mobile, 'package.json'));
  const lock = readJson(join(ctx.root, 'package-lock.json'));
  const out = checkWebrtcPin(rootPkg, mobilePkg, lock, installedVersions(ctx, WEBRTC.name));
  const postinstall = (mobilePkg.scripts as Record<string, string> | undefined)?.postinstall;
  const patchDir = join(ctx.root, 'patches');
  for (const file of existsSync(patchDir) ? readdirSync(patchDir) : []) {
    if (!file.endsWith('.patch')) continue;
    const parsed = parsePatchName(file);
    const text = readFileSync(join(patchDir, file), 'utf8');
    const pkgDir = parsed ? join(ctx.root, 'node_modules', parsed.name) : '';
    const installedFiles = new Map<string, string | undefined>();
    for (const f of addedLines(text).keys()) {
      const p = join(pkgDir, f);
      installedFiles.set(f, existsSync(p) ? readFileSync(p, 'utf8') : undefined);
    }
    const lockVersion = parsed
      ? lockVersions(lock, parsed.name)[`node_modules/${parsed.name}`]
      : undefined;
    const installedVersion = parsed
      ? installedVersions(ctx, parsed.name)[`node_modules/${parsed.name}`]
      : undefined;
    out.push(
      ...checkPatch({ file, text, lockVersion, installedVersion, installedFiles }, postinstall),
    );
  }
  out.push(lockfileSyncCheck(ctx, rootPkg));
  return out;
}

/** `npm ci --dry-run` with the worker's npm, on a temp copy of the manifests only. */
function lockfileSyncCheck(ctx: Ctx, rootPkg: Json): Result {
  const dir = mkdtempSync(join(tmpdir(), 'eas-preflight-npm-'));
  try {
    const manifests = ['package.json', 'package-lock.json', '.npmrc'];
    for (const ws of (rootPkg.workspaces as string[] | undefined) ?? []) {
      const base = ws.replace(/\/\*$/, '');
      for (const name of existsSync(join(ctx.root, base))
        ? readdirSync(join(ctx.root, base))
        : []) {
        if (existsSync(join(ctx.root, base, name, 'package.json'))) {
          manifests.push(`${base}/${name}/package.json`);
        }
      }
    }
    for (const m of manifests) {
      if (!existsSync(join(ctx.root, m))) continue;
      mkdirSync(dirname(join(dir, m)), { recursive: true });
      copyFileSync(join(ctx.root, m), join(dir, m));
    }
    const args = ['ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund'];
    const r = ctx.offline
      ? run('npm', args, { cwd: dir })
      : run('npm', ['exec', '--yes', `--package=npm@${WORKER_NPM_VERSION}`, '--', 'npm', ...args], {
          cwd: dir,
        });
    const which = ctx.offline ? 'local npm' : `npm ${WORKER_NPM_VERSION}`;
    if (r.status === 0) return pass(`package-lock.json in sync (npm ci --dry-run, ${which})`);
    const reason =
      lines(r.stderr).find((l) => /sync|Missing|Invalid/.test(l)) ?? lines(r.stderr)[0];
    return fail(
      'npm ci would fail on EAS',
      `${String(reason)}; run npm install and commit the lockfile`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Where eas-cli is installed: --eas-cli, EAS_CLI_DIR, or npx's cache (fetched once). */
export function resolveEasCli(explicit: string | null, offline: boolean): string | null {
  const candidates = [explicit, process.env.EAS_CLI_DIR].filter((x): x is string => !!x);
  for (const c of candidates) if (existsSync(join(c, 'build/vcs/local.js'))) return c;
  if (candidates.length > 0) return null;
  const r = run(
    'npm',
    [
      'exec',
      '--yes',
      ...(offline ? ['--offline'] : []),
      `--package=eas-cli@${EAS_CLI_VERSION}`,
      '--',
      'sh',
      '-c',
      'command -v eas',
    ],
    { cwd: tmpdir() },
  );
  const bin = r.stdout.trim();
  if (r.status !== 0 || !bin) return null;
  // node_modules/.bin/eas -> node_modules/eas-cli/bin/run
  const dir = dirname(dirname(realpathSync(bin)));
  return existsSync(join(dir, 'build/vcs/local.js')) ? dir : null;
}

function easCli(ctx: Ctx, args: string[]): Run {
  return run(process.execPath, [join(ctx.easCliDir ?? '', 'bin/run'), ...args], {
    cwd: ctx.mobile,
    env: { ...process.env, EXPO_NO_TELEMETRY: '1', EAS_NO_VCS: '' },
  });
}

function easJsonChecks(ctx: Ctx): { results: Result[]; profiles: Record<string, Profile | Error> } {
  const results = checkEasJsonRaw(readJson(join(ctx.mobile, 'eas.json')));
  const profiles: Record<string, Profile | Error> = {};
  if (!ctx.easCliDir) {
    results.push(skip('eas.json schema', `eas-cli ${EAS_CLI_VERSION} not available`));
    return { results, profiles };
  }
  const version = String(readJson(join(ctx.easCliDir, 'package.json')).version);
  results.push(
    version === EAS_CLI_VERSION
      ? pass(`eas-cli ${version}`, ctx.easCliDir)
      : warn(`eas-cli ${version}`, `the upload rules were verified with ${EAS_CLI_VERSION}`),
  );
  for (const name of PROFILES) {
    const r = easCli(ctx, [
      'config',
      '--eas-json-only',
      '--platform',
      'ios',
      '--profile',
      name,
      '--json',
      '--non-interactive',
    ]);
    try {
      profiles[name] = (JSON.parse(r.stdout) as { buildProfile: Profile }).buildProfile;
    } catch {
      profiles[name] = new Error(
        lines(r.stderr + r.stdout)
          .slice(0, 3)
          .join(' ') || 'no output',
      );
    }
  }
  results.push(...checkProfiles(profiles));
  return { results, profiles };
}

function appConfigChecks(ctx: Ctx, profiles: Record<string, Profile | Error>): Result[] {
  const p = profiles[ctx.profile];
  let expected: Record<string, string> = {};
  if (p && !(p instanceof Error)) expected = p.env ?? {};
  else if (!ctx.easCliDir) {
    const env = profileEnvFromEasJson(readJson(join(ctx.mobile, 'eas.json')), ctx.profile);
    if (!env) return [fail(`unknown build profile "${ctx.profile}"`)];
    expected = env;
  } else {
    return [fail(`unknown build profile "${ctx.profile}"`)];
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ...expected, EXPO_NO_DOTENV: '1', CI: '1' };
  for (const k of CONFIG_ENV) if (!(k in expected)) delete env[k];
  const expo = packageDir(ctx.mobile, 'expo');
  if (!expo) return [fail('expo is not installed', 'run npm ci at the repo root')];
  // eas-cli evaluates the config the same way: the project's own `expo config`, dotenv off.
  const r = run(
    process.execPath,
    [join(expo, 'bin/cli'), 'config', '--json', '--type', 'introspect'],
    {
      cwd: ctx.mobile,
      env,
    },
  );
  if (r.status !== 0) {
    return [
      fail(`app config (${ctx.profile}) does not evaluate`, lines(r.stderr).slice(-3).join(' ')),
    ];
  }
  return checkAppConfig({ profile: ctx.profile, expected, exp: JSON.parse(r.stdout) as Json });
}

function listTree(dir: string): { entries: string[]; sizeBytes: number } {
  const entries: string[] = [];
  let sizeBytes = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p).split(sep).join('/');
      if (e.isDirectory()) {
        entries.push(`${rel}/`);
        walk(p);
      } else {
        entries.push(rel);
        sizeBytes += lstatSync(p).size;
      }
    }
  };
  walk(dir);
  return { entries, sizeBytes };
}

/** Files `eas build` must upload, besides the model. */
export function requiredFiles(root: string, tracked: string[]): string[] {
  const workspaceManifests = tracked.filter((f) =>
    /^(apps|packages)\/[^/]+\/package\.json$/.test(f),
  );
  const patches = tracked.filter((f) => /^patches\/.+\.patch$/.test(f));
  return [
    '.easignore',
    'package.json',
    'package-lock.json',
    'scripts/eas-build-hook.sh',
    'apps/mobile/app.json',
    'apps/mobile/app.config.js',
    'apps/mobile/eas.json',
    'apps/mobile/metro.config.js',
    'apps/mobile/index.ts',
    'apps/mobile/App.tsx',
    'apps/mobile/src/face/model.ts',
    MODEL_PATH,
    ...workspaceManifests,
    ...patches,
  ].filter((f, i, all) => all.indexOf(f) === i && (f === MODEL_PATH || existsSync(join(root, f))));
}

async function archiveChecks(ctx: Ctx): Promise<Result[]> {
  if (!existsSync(join(ctx.root, '.easignore'))) {
    return [
      fail('/.easignore is missing', 'without it EAS uses .gitignore and drops the face model'),
    ];
  }
  if (!ctx.easCliDir) return [skip('upload replay', `eas-cli ${EAS_CLI_VERSION} not available`)];
  const req = createRequire(join(ctx.easCliDir, 'package.json'));
  const local = req('./build/vcs/local.js') as {
    makeShallowCopyAsync: (src: string, dst: string) => Promise<void>;
  };
  const dest = mkdtempSync(join(tmpdir(), 'eas-preflight-archive-'));
  try {
    await local.makeShallowCopyAsync(ctx.root, join(dest, 'project'));
    const tree = listTree(join(dest, 'project'));
    const tracked = lines(run('git', ['ls-files'], { cwd: ctx.root }).stdout);
    const out = auditArchive({
      ...tree,
      required: requiredFiles(ctx.root, tracked),
      gitIgnored: lines(
        run('git', ['ls-files', '-o', '-i', '--exclude-standard', '--directory'], { cwd: ctx.root })
          .stdout,
      ),
      droppedTracked: lines(
        run('git', ['ls-files', '-ci', '--exclude-from=.easignore'], { cwd: ctx.root }).stdout,
      ),
    });
    // eas-cli's own managed/bare decision (project/workflow.js), as `eas build` makes it.
    const { resolveWorkflowAsync } = req('./build/project/workflow.js') as {
      resolveWorkflowAsync: (dir: string, platform: string, vcs: unknown) => Promise<string>;
    };
    const GitClient = (req('./build/vcs/clients/git.js') as { default: new (o: object) => unknown })
      .default;
    const workflow = await resolveWorkflowAsync(
      ctx.mobile,
      'ios',
      new GitClient({ requireCommit: false, maybeCwdOverride: ctx.mobile }),
    );
    out.push(
      workflow === 'managed'
        ? pass(
            'eas-cli resolves the iOS workflow as managed',
            'EAS runs expo prebuild on the worker',
          )
        : fail(
            `eas-cli resolves the iOS workflow as ${workflow}`,
            'apps/mobile/ios must not be uploaded',
          ),
    );
    return out;
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

function loginCheck(ctx: Ctx): Result {
  if (ctx.offline || !ctx.easCliDir) return skip('Expo login', 'offline');
  const r = easCli(ctx, ['whoami']);
  const who = lines(r.stdout)[0];
  return r.status === 0 && who
    ? info(`logged in to Expo as ${who}`)
    : info('not logged in to Expo', `run: npx eas-cli@${EAS_CLI_VERSION} login`);
}

// ---- CLI -----------------------------------------------------------------------------------

const ICON: Record<Status, string> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  info: 'INFO',
  skip: 'SKIP',
};

export function format(section: string, results: Result[]): string {
  const body = results
    .map((r) => `  ${ICON[r.status]}  ${r.title}${r.detail ? `\n          ${r.detail}` : ''}`)
    .join('\n');
  return `\n${section}\n${body}`;
}

export function parseArgs(argv: string[]): {
  offline: boolean;
  strict: boolean;
  profile: string;
  easCli: string | null;
} {
  const out = { offline: false, strict: false, profile: 'preview', easCli: null as string | null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline') out.offline = true;
    else if (a === '--strict') out.strict = true;
    else if (a === '--profile' && argv[i + 1]) out.profile = String(argv[++i]);
    else if (a === '--eas-cli' && argv[i + 1]) out.easCli = String(argv[++i]);
    else throw new Error(`unknown argument: ${String(a)}`);
  }
  return out;
}

export async function main(argv: string[]): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    return 64;
  }
  const mobile = dirname(dirname(fileURLToPath(import.meta.url)));
  const root = dirname(dirname(mobile));
  console.log(`EAS preflight (iOS, profile ${args.profile}) — ${root}`);
  const easCliDir = resolveEasCli(args.easCli, args.offline);
  const ctx: Ctx = { root, mobile, offline: args.offline, profile: args.profile, easCliDir };
  const all: Result[] = [];
  const section = (name: string, results: Result[]) => {
    all.push(...results);
    console.log(format(name, results));
  };
  section('Tools and repo', [
    checkNode(process.version),
    ...checkShellEnv(process.env),
    ...repoChecks(ctx),
  ]);
  section('Face model', modelChecks(ctx));
  section('Dependencies EAS installs', dependencyChecks(ctx));
  const eas = easJsonChecks(ctx);
  section('eas.json', eas.results);
  section('App config', appConfigChecks(ctx, eas.profiles));
  section('Upload (what `eas build` sends)', await archiveChecks(ctx));
  section('Account', [loginCheck(ctx)]);
  const count = (s: Status) => all.filter((r) => r.status === s).length;
  const failed = count('fail') + (args.strict ? count('warn') : 0);
  console.log(
    `\n${count('pass')} passed, ${count('warn')} warnings, ${count('fail')} failed, ${count('skip')} skipped` +
      (failed === 0 ? ' — ready for `eas build`.' : ' — fix the FAIL lines first.'),
  );
  return failed === 0 ? 0 : 1;
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
