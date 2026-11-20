/* eslint-disable @typescript-eslint/no-require-imports -- Metro loads this file as CommonJS. */
// Expo's default Metro config already handles the npm-workspaces monorepo (watchFolders and
// nodeModulesPaths at the repo root) and package "exports" (needed by @elevenlabs/react-native).
// Additions:
//   - the .tflite asset extension for the face-embedding model, which is bundled with require()
//     and loaded by react-native-fast-tflite from a file:// URL;
//   - .mp4 as an asset (Expo's default list has it; kept explicit for the Dance Off clips);
//   - the Dance Off local media override below (opt-in: DANCE_LOCAL_MEDIA=1).
const fs = require('node:fs');
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

if (!config.resolver.assetExts.includes('tflite')) {
  config.resolver.assetExts.push('tflite');
}
if (!config.resolver.assetExts.includes('mp4')) {
  config.resolver.assetExts.push('mp4');
}

// Dance Off reference media (src/dance/media.ts). The repo carries each clip with an ORIGINAL
// drum track muxed in (assets/dance/<id>.mp4, royalty-free by construction). A local demo build
// can carry the original song instead: put a file with the SAME name in assets/dance/local/
// (gitignored, never committed) and run Metro / the build with DANCE_LOCAL_MEDIA=1; every
// require of assets/dance/<name> then bundles the local file. It is opt-in, and never on in CI
// or on an EAS builder (EAS_BUILD), so a plain `expo export` (scripts/eas-update.ts, which also
// refuses a bundle that carries a local file) or a build never picks the song up by accident.
// Only the media changes: the routine (and its hashed sha256) is the same either way. Metro
// caches resolutions: restart it with --clear after switching.
const DANCE_DIR = path.join(__dirname, 'assets', 'dance');
const DANCE_LOCAL_DIR = path.join(DANCE_DIR, 'local');

/** The local dance media override is on (explicit opt-in, never in CI or on EAS). */
function danceLocalMediaEnabled(env = process.env) {
  return env.DANCE_LOCAL_MEDIA === '1' && !env.EAS_BUILD && !env.CI;
}

/** The local replacement for a bundled dance asset, or the path itself. */
function danceLocalOverride(filePath) {
  if (!danceLocalMediaEnabled()) return filePath;
  if (path.dirname(filePath) !== DANCE_DIR) return filePath;
  const local = path.join(DANCE_LOCAL_DIR, path.basename(filePath));
  return fs.existsSync(local) ? local : filePath;
}

const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const res = upstreamResolveRequest
    ? upstreamResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
  if (res && res.type === 'assetFiles') {
    return { ...res, filePaths: res.filePaths.map(danceLocalOverride) };
  }
  return res;
};

module.exports = config;
