// Guards the native-stack config for EAS build #1 (TASKS D0-M2 install checklist, FINDINGS §3.1-3.3,
// §3.10, §7). These are cheap to break and expensive to find on a 90-minute cloud build.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { palette } from '../ui/tokens';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const readJson = (rel: string) =>
  JSON.parse(readFileSync(here(rel), 'utf8')) as Record<string, unknown>;

interface PackageJson {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
}
const pkg = readJson('../../package.json') as unknown as PackageJson;
type Plugin = string | [string, Record<string, unknown>];
const app = (readJson('../../app.json') as { expo: Record<string, unknown> }).expo as {
  plugins: Plugin[];
  userInterfaceStyle?: string;
  ios: { infoPlist: Record<string, string>; deploymentTarget: string };
};
const pluginName = (p: Plugin) => (typeof p === 'string' ? p : p[0]);
const pluginOptions = (name: string) => {
  const p = app.plugins.find((x) => pluginName(x) === name);
  return p && typeof p !== 'string' ? p[1] : undefined;
};

// Find an installed package the way Node/Metro would from the app directory: the nearest
// node_modules/<name> going up. (Some packages' "exports" hide ./package.json from require.)
function packageDir(name: string): string {
  let dir = dirname(here('../../package.json'));
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const up = dirname(dir);
    if (up === dir) throw new Error(`${name} is not installed`);
    dir = up;
  }
}
const installedVersion = (name: string) =>
  (JSON.parse(readFileSync(join(packageDir(name), 'package.json'), 'utf8')) as { version: string })
    .version;

describe('exact pins (FINDINGS §3.1, §3.2, §3.10)', () => {
  const exact: Record<string, string> = {
    'react-native-nitro-modules': '0.37.2',
    'react-native-vision-camera': '5.2.4',
    'react-native-nitro-image': '0.15.2',
    'react-native-vision-camera-face-detector': '2.1.0',
    'react-native-fast-tflite': '3.0.1',
    '@elevenlabs/react-native': '1.2.38',
    '@livekit/react-native': '2.12.0',
    '@livekit/react-native-webrtc': '144.1.2',
    'livekit-client': '2.23.0',
    '@livekit/react-native-expo-plugin': '1.1.0',
    '@config-plugins/react-native-webrtc': '15.0.2',
    'react-dom': '19.3.0',
    'react-native-reanimated': '4.7.1',
    'react-native-worklets': '0.13.0',
    // The one typeface (ui/fonts, Geist): asset-only, pinned so a font file never shifts.
    '@expo-google-fonts/geist': '0.4.2',
    // Native (the balance sparkline, the moment glow): Expo SDK 58's bundledNativeModules pin.
    // Adding it needs a full native rebuild (expo prebuild + a new dev-client build).
    'react-native-svg': '15.16.0',
  };
  for (const [name, version] of Object.entries(exact)) {
    it(`${name} is pinned to exactly ${version} and installed at it`, () => {
      expect(pkg.dependencies[name]).toBe(version);
      expect(installedVersion(name)).toBe(version);
    });
  }

  it('gesture-handler stays on ~3.3 (npm latest 3.5 is not the SDK 58 pin)', () => {
    expect(pkg.dependencies['react-native-gesture-handler']).toBe('~3.3.0');
    expect(installedVersion('react-native-gesture-handler')).toMatch(/^3\.3\./);
  });

  it('SDK 58 Expo modules for the judge cam are present (FINDINGS §3.3)', () => {
    for (const name of [
      'expo-camera',
      'expo-video',
      'expo-video-thumbnails',
      'expo-image-manipulator',
      'expo-haptics',
      'expo-notifications',
      'expo-file-system',
      'expo-asset',
      'expo-secure-store',
      'expo-local-authentication',
      'expo-crypto',
      'expo-splash-screen',
      'expo-font',
    ]) {
      expect(pkg.dependencies[name], name).toMatch(/^~58\./);
    }
  });

  it('keeps forbidden packages off the phone (FINDINGS §3.1, §3.2)', () => {
    for (const name of [
      '@solana/web3.js',
      '@coral-xyz/anchor',
      '@anchor-lang/core',
      'onnxruntime-react-native',
      // Replaced by Geist (Obsidian redesign).
      '@expo-google-fonts/big-shoulders-display',
      '@expo-google-fonts/instrument-sans',
    ]) {
      expect(pkg.dependencies[name], name).toBeUndefined();
    }
  });
});

describe('config plugins and usage strings (FINDINGS §7: one string each)', () => {
  const camera = app.ios.infoPlist.NSCameraUsageDescription;
  const mic = app.ios.infoPlist.NSMicrophoneUsageDescription;

  it('lists every native plugin the stack needs', () => {
    const names = app.plugins.map(pluginName);
    for (const name of [
      'expo-build-properties',
      'expo-local-authentication',
      'expo-secure-store',
      'expo-dev-client',
      'expo-camera',
      'expo-video',
      'expo-audio',
      '@livekit/react-native-expo-plugin',
      '@config-plugins/react-native-webrtc',
      'expo-splash-screen',
    ]) {
      expect(names, name).toContain(name);
    }
    // Free Apple Personal Team signing: no aps-environment entitlement (APNs is on the cut line;
    // local notifications need none). Leaving the plugin out is NOT enough: prebuild applies
    // expo-notifications automatically whenever it is installed, and its default adds
    // aps-environment. Listing it with remote notifications off is what removes the entitlement
    // (easConfig.test.ts checks the evaluated config).
    expect(pluginOptions('expo-notifications')).toEqual({ enableRemoteNotifications: false });
    expect(new Set(names).size).toBe(names.length);
  });

  it('opens on the dark splash and dark system UI (no white flash before the first screen)', () => {
    expect(app.userInterfaceStyle).toBe('dark');
    expect(pluginOptions('expo-splash-screen')).toMatchObject({
      image: './assets/splash-icon.png',
      backgroundColor: '#000000',
    });
    // The native splash hands off to ui/brand SplashView on the app background: same colour.
    expect(palette.background).toBe('#000000');
  });

  it('passes the same camera and mic strings to every plugin that writes them', () => {
    expect(camera).toBeTruthy();
    expect(mic).toBeTruthy();
    expect(pluginOptions('expo-camera')).toMatchObject({
      cameraPermission: camera,
      microphonePermission: mic,
    });
    expect(pluginOptions('@config-plugins/react-native-webrtc')).toMatchObject({
      cameraPermission: camera,
      microphonePermission: mic,
    });
    expect(pluginOptions('expo-audio')).toMatchObject({ microphonePermission: mic });
  });

  it('uses one Face ID string for local-auth and secure-store', () => {
    const la = pluginOptions('expo-local-authentication')?.faceIDPermission;
    const ss = pluginOptions('expo-secure-store')?.faceIDPermission;
    expect(la).toBeTruthy();
    expect(ss).toBe(la);
  });

  it('turns off background audio and video modes nobody asked for', () => {
    expect(pluginOptions('expo-audio')).toMatchObject({
      enableBackgroundPlayback: false,
      enableBackgroundRecording: false,
    });
    expect(pluginOptions('expo-video')).toMatchObject({ supportsBackgroundPlayback: false });
  });

  it('keeps the iOS 16.4 deployment target', () => {
    expect(app.ios.deploymentTarget).toBe('16.4');
  });
});

describe('face-detector iOS performanceMode patch (FINDINGS §3.2, §7)', () => {
  const patchPath = here(
    '../../../../patches/react-native-vision-camera-face-detector+2.1.0.patch',
  );

  it('is committed for the pinned version', () => {
    expect(existsSync(patchPath)).toBe(true);
    const patch = readFileSync(patchPath, 'utf8');
    expect(patch).toContain('-    performanceMode: Any?,');
    expect(patch).toContain('+    performanceMode: PerformanceMode?,');
    expect(patch).toContain('+    performanceMode?.stringValue == "accurate"');
  });

  it('is applied to the installed package by the postinstall hook', () => {
    expect(pkg.scripts.postinstall).toBe('cd ../.. && patch-package --error-on-fail');
    expect(pkg.devDependencies['patch-package']).toBe('8.0.1');
    const swift = readFileSync(
      join(
        packageDir('react-native-vision-camera-face-detector'),
        'ios/Extensions/ML+FaceDetectorOptions.swift',
      ),
      'utf8',
    );
    expect(swift).toContain('performanceMode?.stringValue == "accurate"');
    // The upstream line (the patch's comment quotes it, so match only uncommented code).
    expect(swift).not.toMatch(/^\s+String\(describing: performanceMode\) == "accurate"/m);
  });
});

describe('Metro', () => {
  it('bundles .tflite as an asset', async () => {
    const src = readFileSync(here('../../metro.config.js'), 'utf8');
    expect(src).toMatch(/assetExts\.push\('tflite'\)/);
  });

  it('bundles a same-named file from assets/dance/local/ in place of a dance asset', () => {
    type Res = { type: string; filePaths?: string[]; filePath?: string };
    const config = createRequire(import.meta.url)(here('../../metro.config.js')) as {
      resolver: {
        assetExts: string[];
        resolveRequest: (ctx: { resolveRequest: () => Res }, name: string, p: string) => Res;
      };
    };
    expect(config.resolver.assetExts).toEqual(expect.arrayContaining(['tflite', 'mp4']));
    const danceDir = here('../../assets/dance');
    const localDir = join(danceDir, 'local');
    const name = `__override-test-${process.pid}.mp4`;
    const resolveTo = (res: Res) =>
      config.resolver.resolveRequest({ resolveRequest: () => res }, 'x', 'ios');
    const asset = (p: string): Res => ({ type: 'assetFiles', filePaths: [p] });
    const saved = {
      opt: process.env.DANCE_LOCAL_MEDIA,
      ci: process.env.CI,
      eas: process.env.EAS_BUILD,
    };
    const setEnv = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    const committed = [join(danceDir, name)];
    const local = [join(localDir, name)];
    setEnv('CI', undefined);
    setEnv('EAS_BUILD', undefined);
    setEnv('DANCE_LOCAL_MEDIA', '1');
    // No local file: the committed one.
    expect(resolveTo(asset(join(danceDir, name))).filePaths).toEqual(committed);
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, name), '');
    try {
      expect(resolveTo(asset(join(danceDir, name))).filePaths).toEqual(local);
      // Only assets directly under assets/dance/, and never source files.
      const other = here(`../../assets/${name}`);
      expect(resolveTo(asset(other)).filePaths).toEqual([other]);
      const src: Res = { type: 'sourceFile', filePath: join(danceDir, name) };
      expect(resolveTo(src)).toBe(src);
      // Opt-in only: without DANCE_LOCAL_MEDIA=1, or in CI / on an EAS builder, the committed
      // file even though the local one exists (expo export for an OTA update never takes it).
      setEnv('DANCE_LOCAL_MEDIA', undefined);
      expect(resolveTo(asset(join(danceDir, name))).filePaths).toEqual(committed);
      setEnv('DANCE_LOCAL_MEDIA', 'true');
      expect(resolveTo(asset(join(danceDir, name))).filePaths).toEqual(committed);
      setEnv('DANCE_LOCAL_MEDIA', '1');
      setEnv('CI', 'true');
      expect(resolveTo(asset(join(danceDir, name))).filePaths).toEqual(committed);
      setEnv('CI', undefined);
      setEnv('EAS_BUILD', 'true');
      expect(resolveTo(asset(join(danceDir, name))).filePaths).toEqual(committed);
    } finally {
      rmSync(join(localDir, name), { force: true });
      setEnv('DANCE_LOCAL_MEDIA', saved.opt);
      setEnv('CI', saved.ci);
      setEnv('EAS_BUILD', saved.eas);
    }
  });

  it('never commits or uploads the local dance media (the original song)', () => {
    expect(readFileSync(here('../../.gitignore'), 'utf8')).toMatch(/^\/assets\/dance\/local\/$/m);
    expect(readFileSync(here('../../../../.easignore'), 'utf8')).toMatch(
      /^\/apps\/mobile\/assets\/dance\/local$/m,
    );
  });
});

describe('dark appearance (ui/tokens palette is dark)', () => {
  it('asks iOS for the dark system appearance (sheets, keyboard, Face ID prompt)', () => {
    expect((app as unknown as { userInterfaceStyle: string }).userInterfaceStyle).toBe('dark');
  });

  it('shows a light status bar over the app (diagnostics is night too)', () => {
    const demo = readFileSync(here('../app/DemoApp.tsx'), 'utf8');
    expect(demo).toContain('<StatusBar style="light" />');
    expect(demo).not.toMatch(/<StatusBar style="dark"/);
    const root = readFileSync(here('../../App.tsx'), 'utf8');
    expect(root).toContain('<StatusBar style="light" />');
    expect(root).not.toMatch(/<StatusBar style=\{operator/);
  });
});

describe('iOS Simulator autolinking (react-native.config.js)', () => {
  const configPath = here('../../react-native.config.js');
  const load = (simulator: string | undefined) => {
    const saved = process.env.YO_IOS_SIMULATOR;
    if (simulator === undefined) delete process.env.YO_IOS_SIMULATOR;
    else process.env.YO_IOS_SIMULATOR = simulator;
    try {
      const require = createRequire(import.meta.url);
      delete require.cache[require.resolve(configPath)];
      return require(configPath) as { dependencies: Record<string, unknown> };
    } finally {
      if (saved === undefined) delete process.env.YO_IOS_SIMULATOR;
      else process.env.YO_IOS_SIMULATOR = saved;
    }
  };

  it('links everything for a device build', () => {
    expect(load(undefined).dependencies).toEqual({});
    expect(load('0').dependencies).toEqual({});
  });

  it('leaves out only the MLKit face detector for a simulator build', () => {
    expect(load('1').dependencies).toEqual({
      'react-native-vision-camera-face-detector': { platforms: { ios: null, android: null } },
    });
  });
});
