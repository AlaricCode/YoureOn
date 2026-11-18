// Autolinking overrides (read by expo-modules-autolinking during `expo prebuild` / `pod install`).
//
// iOS Simulator builds (YO_IOS_SIMULATOR=1): Google MLKit, which react-native-vision-camera-face-
// detector pulls in, ships its frameworks with arm64 DEVICE and x86_64 slices only, and the iOS 26
// simulator runtime on Apple silicon is arm64-only, so the app cannot link for it. The simulator
// has no camera to feed the detector anyway, so a simulator build leaves the detector out; the
// only JS that imports it (face enrollment in the design preview, the VisionCamera diagnostics
// panel) loads lazily behind an error boundary. Device builds are unchanged.
//
//   YO_IOS_SIMULATOR=1 CI=1 npx expo prebuild -p ios --clean --no-install
//   (cd ios && YO_IOS_SIMULATOR=1 pod install)
//
// apps/mobile/scripts/sim-build.sh does both, then builds and installs the Release app.
const simulator = process.env.YO_IOS_SIMULATOR === '1';

module.exports = {
  dependencies: simulator
    ? { 'react-native-vision-camera-face-detector': { platforms: { ios: null, android: null } } }
    : {},
};
