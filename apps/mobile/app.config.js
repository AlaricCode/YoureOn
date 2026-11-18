// Expo reads app.json first and passes it here as `config`. This file only derives values, so
// app.json stays the one committed source of truth.
//
// 1. Optional, env-driven iOS overrides:
//
//   IOS_BUNDLE_ID     bundle ID. A bundle ID belongs to exactly one Apple team.
//   APPLE_TEAM_ID     10-character Apple team ID (Xcode DEVELOPMENT_TEAM). EAS Build sets it itself
//                     during prebuild, to the team of the EAS-managed credentials.
//   IOS_DISPLAY_NAME  home-screen name, so two variants on one phone can be told apart.
//
// Free Apple Personal Team, built on your own Mac (docs/IOS-BUILD.md):
//
//   IOS_BUNDLE_ID=dev.youreon.app.eva APPLE_TEAM_ID=<10-char team id> npx expo prebuild -p ios
//
// Paid team, built by EAS (docs/IOS-BUILD.md, "Paid account (EAS)"): eas.json sets IOS_BUNDLE_ID
// (and IOS_DISPLAY_NAME for the dev client) per build profile, and APPLE_TEAM_ID comes from the
// credentials, so nothing here needs editing. Unset, app.json's values are used (the lead's free
// team, dev.youreon.app). The bundle ID is not part of any wire contract: the server, the device
// policy and the keychain never read it.
//
// 2. EAS Update (over-the-air JS, scripts/eas-update.sh). It switches on by itself once the project
// is linked to EAS: `eas init` writes extra.eas.projectId into app.json, and the update URL is
// derived from it. Unlinked builds (free-team builds, CI) keep expo-updates disabled: they run the
// embedded JS and never call the network for updates. runtimeVersion follows expo.version
// ("appVersion"), so an update only reaches binaries of the same version: bump expo.version in
// app.json whenever native code or config changes, and rebuild.

const UPDATES_HOST = 'https://u.expo.dev';

/** Returns `config` with the env overrides applied. Pure, so tests can pass their own env. */
function applyEnv(config, env) {
  const bundleIdentifier = env.IOS_BUNDLE_ID || config.ios.bundleIdentifier;
  const appleTeamId = env.APPLE_TEAM_ID || config.ios.appleTeamId;
  const displayName = env.IOS_DISPLAY_NAME;
  // Apple: alphanumerics, hyphens and periods; reverse-DNS, so at least two labels.
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(bundleIdentifier)) {
    throw new Error(`IOS_BUNDLE_ID "${bundleIdentifier}" is not a valid bundle identifier`);
  }
  if (appleTeamId && !/^[A-Z0-9]{10}$/.test(appleTeamId)) {
    throw new Error(`APPLE_TEAM_ID "${appleTeamId}" must be the 10-character Apple team id`);
  }
  if (displayName !== undefined && !/^\S.{0,29}$/u.test(displayName)) {
    throw new Error(`IOS_DISPLAY_NAME "${displayName}" must be 1-30 characters`);
  }
  const ios = { ...config.ios, bundleIdentifier, appleTeamId };
  if (displayName !== undefined) {
    ios.infoPlist = { ...config.ios.infoPlist, CFBundleDisplayName: displayName };
  }
  return withUpdates({ ...config, ios });
}

/** EAS Update settings, on only when the project is linked (extra.eas.projectId). */
function withUpdates(config) {
  const projectId = config.extra && config.extra.eas && config.extra.eas.projectId;
  const updates = projectId
    ? {
        ...config.updates,
        enabled: true,
        url: `${UPDATES_HOST}/${projectId}`,
        // Check on every cold start without delaying it: a new update downloads in the
        // background and runs from the next cold start (force-quit, reopen).
        checkAutomatically: 'ON_LOAD',
        fallbackToCacheTimeout: 0,
      }
    : { ...config.updates, enabled: false };
  return { ...config, runtimeVersion: { policy: 'appVersion' }, updates };
}

module.exports = ({ config }) => applyEnv(config, process.env);
module.exports.applyEnv = applyEnv;
