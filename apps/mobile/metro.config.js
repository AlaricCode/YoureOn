/* eslint-disable @typescript-eslint/no-require-imports -- Metro loads this file as CommonJS. */
// Expo's default Metro config already handles the npm-workspaces monorepo (watchFolders and
// nodeModulesPaths at the repo root) and package "exports" (needed by @elevenlabs/react-native).
// Additions:
//   - the .tflite asset extension for the face-embedding model, which is bundled with require()
//     and loaded by react-native-fast-tflite from a file:// URL (FINDINGS §3.2);
//   - .mp4 as an asset (Expo's default list has it; kept explicit for the Dance Off clips);
//   - the Dance Off local media override below.
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
// (gitignored, never committed) and every require of assets/dance/<name> bundles the local
// file. Builds without that folder (CI, EAS, a fresh clone) get the committed drum version.
// Only the media changes: the routine (and its hashed sha256) is the same either way. Metro
// caches resolutions: restart it with --clear after adding or removing a local file.
const DANCE_DIR = path.join(__dirname, 'assets', 'dance');
const DANCE_LOCAL_DIR = path.join(DANCE_DIR, 'local');

/** The local replacement for a bundled dance asset, or the path itself. */
function danceLocalOverride(filePath) {
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
