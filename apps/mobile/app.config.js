// Expo reads app.json first and passes it here as `config`. This file only applies optional,
// env-driven iOS overrides, so app.json stays the one committed source of truth:
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
  return { ...config, ios };
}

module.exports = ({ config }) => applyEnv(config, process.env);
module.exports.applyEnv = applyEnv;
