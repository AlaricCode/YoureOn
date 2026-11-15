/* eslint-disable @typescript-eslint/no-require-imports -- Metro loads this file as CommonJS. */
// Expo's default Metro config already handles the npm-workspaces monorepo (watchFolders and
// nodeModulesPaths at the repo root) and package "exports" (needed by @elevenlabs/react-native).
// The only addition is the .tflite asset extension for the face-embedding model, which is bundled
// with require() and loaded by react-native-fast-tflite from a file:// URL (FINDINGS §3.2).
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

if (!config.resolver.assetExts.includes('tflite')) {
  config.resolver.assetExts.push('tflite');
}

module.exports = config;
