// Pure parts of the EAS Update wrapper (scripts/eas-update.sh). The export path was run for real
// with --dry-run; publishing needs an Expo login.
import { describe, expect, it } from 'vitest';

import {
  bundleMentions,
  checkUpdatableProfile,
  exportedIos,
  nativeGuard,
  parseUpdateArgs,
  updateCommand,
} from './eas-update';

describe('parseUpdateArgs', () => {
  it('needs a profile and a message', () => {
    expect(parseUpdateArgs(['--profile', 'preview', '-m', 'fix the terms card'])).toEqual({
      profile: 'preview',
      message: 'fix the terms card',
      dryRun: false,
      allowDirty: false,
      allowNativeChanges: false,
      easCli: null,
    });
    expect(() => parseUpdateArgs(['--message', 'x'])).toThrow('--profile is required');
    expect(() => parseUpdateArgs(['--profile', 'preview'])).toThrow('--message is required');
    expect(() => parseUpdateArgs(['--profile', 'preview', '--message', '  '])).toThrow(
      '--message is required',
    );
    expect(() => parseUpdateArgs(['--profile', '--dry-run'])).toThrow('--profile needs a value');
    expect(() => parseUpdateArgs(['--nope'])).toThrow('unknown argument');
  });

  it('takes the escape hatches', () => {
    const a = parseUpdateArgs([
      '--profile',
      'pitch',
      '--message',
      'm',
      '--dry-run',
      '--allow-dirty',
      '--allow-native-changes',
      '--eas-cli',
      '/x',
    ]);
    expect(a).toMatchObject({
      dryRun: true,
      allowDirty: true,
      allowNativeChanges: true,
      easCli: '/x',
    });
  });
});

describe('checkUpdatableProfile', () => {
  const ok = { channel: 'preview', env: { EXPO_PUBLIC_API_URL: 'https://youre-on.fly.dev' } };

  it('accepts a release profile with a channel and an https server', () => {
    expect(checkUpdatableProfile('preview', ok)).toBeNull();
  });

  it('refuses no channel, the dev client, or a laptop URL', () => {
    expect(checkUpdatableProfile('x', { ...ok, channel: undefined })).toContain('no channel');
    expect(checkUpdatableProfile('development', { ...ok, developmentClient: true })).toContain(
      'dev client',
    );
    expect(
      checkUpdatableProfile('x', { ...ok, env: { EXPO_PUBLIC_API_URL: 'http://localhost:8080' } }),
    ).toContain('https');
  });
});

describe('nativeGuard', () => {
  const build = [{ id: 'b1', gitCommitHash: 'abcdef1234' }];
  const same = { fingerprint1: { hash: 'f'.repeat(40) }, fingerprint2: { hash: 'f'.repeat(40) } };

  it('passes when the project fingerprint equals the latest build', () => {
    expect(nativeGuard(build, same)).toEqual({
      ok: true,
      buildId: 'b1',
      detail: 'matches build b1 (commit abcdef1)',
    });
  });

  it('refuses a fingerprint change and says how to see the diff', () => {
    const v = nativeGuard(build, {
      fingerprint1: { hash: 'a'.repeat(40) },
      fingerprint2: { hash: 'b'.repeat(40) },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain('needs a new build');
      expect(v.reason).toContain('fingerprint:compare --build-id b1');
    }
  });

  it('fails safe when there is no build or no comparable fingerprint', () => {
    expect(nativeGuard([], same).ok).toBe(false);
    expect(nativeGuard(null, same).ok).toBe(false);
    expect(nativeGuard(build, null).ok).toBe(false);
    expect(nativeGuard(build, { fingerprint1: { hash: 'x' } }).ok).toBe(false);
  });
});

describe('bundle checks', () => {
  it('finds the inlined URL in a plain or Hermes-style bundle', () => {
    const url = 'https://youre-on.fly.dev';
    expect(bundleMentions(Buffer.from(`var a="${url}";`), url)).toBe(true);
    expect(
      bundleMentions(Buffer.concat([Buffer.from([0xc6, 0x1f]), Buffer.from(url, 'utf16le')]), url),
    ).toBe(true);
    expect(bundleMentions(Buffer.from('var a="http://localhost:8080";'), url)).toBe(false);
  });

  it('reads the iOS bundle and asset extensions from metadata.json', () => {
    const metadata = {
      version: 0,
      bundler: 'metro',
      fileMetadata: {
        ios: {
          bundle: '_expo/static/js/ios/index-1.hbc',
          assets: [{ path: 'assets/abc', ext: 'tflite' }],
        },
      },
    };
    expect(exportedIos(metadata)).toEqual({
      bundle: '_expo/static/js/ios/index-1.hbc',
      assetExts: ['tflite'],
    });
    expect(exportedIos({})).toEqual({ bundle: null, assetExts: [] });
  });
});

describe('updateCommand', () => {
  it('publishes the pre-made bundle to the profile channel, iOS only', () => {
    expect(
      updateCommand({ channel: 'pitch', environment: 'preview', message: 'm', inputDir: 'dist' }),
    ).toEqual([
      'update',
      '--skip-bundler',
      '--input-dir',
      'dist',
      '--channel',
      'pitch',
      '--environment',
      'preview',
      '--platform',
      'ios',
      '--message',
      'm',
      '--non-interactive',
    ]);
  });
});
