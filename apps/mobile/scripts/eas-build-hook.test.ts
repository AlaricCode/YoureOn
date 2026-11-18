// scripts/eas-build-hook.sh (the EAS lifecycle hooks) against throwaway app directories.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const HOOK = fileURLToPath(new URL('../../../scripts/eas-build-hook.sh', import.meta.url));
const MOBILE_PKG = fileURLToPath(new URL('../package.json', import.meta.url));

const MODEL_BYTES = Buffer.from('not really a tflite model\n');
const MODEL_SHA = createHash('sha256').update(MODEL_BYTES).digest('hex');

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function write(path: string, contents: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/** A fake repo: <root>/apps/mobile with a FACE_MODEL module shaped like src/face/model.ts. */
function fixture(opts: { model?: Buffer | null; patched?: boolean; webrtc?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'eas-hook-'));
  dirs.push(root);
  const app = join(root, 'apps/mobile');
  write(
    join(app, 'src/face/model.ts'),
    [
      'export const FACE_MODEL = {',
      "  name: 'w600k_mbf',",
      "  fileName: 'model.tflite',",
      '  /** sha256 of the committed file. */',
      `  sha256: '${MODEL_SHA}',`,
      `  sizeBytes: ${MODEL_BYTES.length},`,
      '} as const;',
      '',
    ].join('\n'),
  );
  const model = opts.model === undefined ? MODEL_BYTES : opts.model;
  if (model) write(join(app, 'assets/models/model.tflite'), model);
  const fd = join(root, 'node_modules/react-native-vision-camera-face-detector');
  write(
    join(fd, 'package.json'),
    '{ "name": "react-native-vision-camera-face-detector", "version": "2.1.0" }\n',
  );
  write(
    join(fd, 'ios/Extensions/ML+FaceDetectorOptions.swift'),
    opts.patched === false
      ? 'String(describing: performanceMode) == "accurate"\n'
      : 'performanceMode?.stringValue == "accurate"\n',
  );
  write(
    join(root, 'node_modules/@livekit/react-native-webrtc/package.json'),
    `{\n  "name": "@livekit/react-native-webrtc",\n  "version": "${opts.webrtc ?? '144.1.2'}"\n}\n`,
  );
  return app;
}

function hook(name: string, app: string, env: Record<string, string> = {}) {
  // The worker's env is EAS_BUILD_* + the profile's EXPO_PUBLIC_*: start from a clean slate.
  const clean: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(clean)) {
    if (k.startsWith('EAS_BUILD') || k.startsWith('EXPO_PUBLIC_')) delete clean[k];
  }
  return spawnSync('bash', [HOOK, name, '--app-dir', app], {
    encoding: 'utf8',
    env: { ...clean, ...env },
  });
}

describe('pre-install hook', () => {
  it('passes when the model matches FACE_MODEL and logs the public build env', () => {
    const r = hook('pre-install', fixture(), {
      EAS_BUILD_PROFILE: 'preview',
      EXPO_PUBLIC_API_URL: 'https://youre-on.fly.dev',
      EXPO_PUBLIC_VOICE: 'on',
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`face model present (model.tflite, ${MODEL_BYTES.length} bytes`);
    expect(r.stdout).toContain('EXPO_PUBLIC_API_URL=https://youre-on.fly.dev EXPO_PUBLIC_VOICE=on');
  });

  it('fails fast, with the fix, when the model did not make it into the upload', () => {
    const r = hook('pre-install', fixture({ model: null }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('assets/models/model.tflite is not in the upload');
    expect(r.stderr).toContain('scripts/face-model.sh');
    expect(r.stderr).toContain('.easignore');
  });

  it('fails on a truncated or different model', () => {
    const short = hook('pre-install', fixture({ model: MODEL_BYTES.subarray(1) }));
    expect(short.status).toBe(1);
    expect(short.stderr).toContain('bytes, expected');
    const other = Buffer.from(MODEL_BYTES);
    other[0] = 0x4e;
    const wrong = hook('pre-install', fixture({ model: other }));
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain(`expected ${MODEL_SHA}`);
  });

  it('refuses a release profile without an https server, but lets the dev client use localhost', () => {
    const app = fixture();
    const preview = hook('pre-install', app, {
      EAS_BUILD_PROFILE: 'preview',
      EXPO_PUBLIC_API_URL: 'http://localhost:8080',
    });
    expect(preview.status).toBe(1);
    expect(preview.stderr).toContain("must be an https:// URL for a 'preview' build");
    const dev = hook('pre-install', app, {
      EAS_BUILD_PROFILE: 'development',
      EXPO_PUBLIC_API_URL: 'http://localhost:8080',
    });
    expect(dev.status).toBe(0);
  });
});

describe('post-install hook', () => {
  it('passes with the patch applied and WebRTC 144.1.2', () => {
    const r = hook('post-install', fixture());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('face-detector Swift patch applied');
    expect(r.stdout).toContain('@livekit/react-native-webrtc 144.1.2');
  });

  it('fails when patch-package did not run', () => {
    const r = hook('post-install', fixture({ patched: false }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('patch is not applied');
  });

  it('fails when the override did not take', () => {
    const r = hook('post-install', fixture({ webrtc: '137.0.2' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('resolved to 137.0.2, expected 144.1.2');
  });
});

describe('usage', () => {
  it('exits 64 on an unknown hook or argument', () => {
    expect(spawnSync('bash', [HOOK, 'nope'], { encoding: 'utf8' }).status).toBe(64);
    expect(spawnSync('bash', [HOOK, 'pre-install', '--x'], { encoding: 'utf8' }).status).toBe(64);
  });

  it('is wired as the EAS lifecycle scripts of apps/mobile', () => {
    const pkg = JSON.parse(readFileSync(MOBILE_PKG, 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['eas-build-pre-install']).toBe(
      'bash ../../scripts/eas-build-hook.sh pre-install',
    );
    expect(pkg.scripts['eas-build-post-install']).toBe(
      'bash ../../scripts/eas-build-hook.sh post-install',
    );
  });

  it('reads the real FACE_MODEL module', () => {
    // The hook parses src/face/model.ts with sed: keep the fields on one line each.
    const src = readFileSync(
      fileURLToPath(new URL('../src/face/model.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toMatch(/^ {2}fileName: '[^']+',$/m);
    expect(src).toMatch(/^ {2}sha256: '[0-9a-f]{64}',$/m);
    expect(src).toMatch(/^ {2}sizeBytes: [0-9_]+,$/m);
  });
});
