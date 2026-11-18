// Expo reads app.json first and passes it here as `config`; this file only lets a teammate sign
// the iOS build with their OWN free Apple Personal Team. A bundle ID belongs to exactly one
// team, so each team needs its own ID:
//
//   IOS_BUNDLE_ID=dev.youreon.app.eva APPLE_TEAM_ID=<10-char team id> npx expo prebuild -p ios
//
// Unset, app.json's values are used (the lead's team, dev.youreon.app). The bundle ID is not
// part of any wire contract: the server, the device policy and the keychain never read it.
module.exports = ({ config }) => {
  const bundleIdentifier = process.env.IOS_BUNDLE_ID || config.ios.bundleIdentifier;
  const appleTeamId = process.env.APPLE_TEAM_ID || config.ios.appleTeamId;
  if (!/^[A-Za-z0-9.-]+$/.test(bundleIdentifier)) {
    throw new Error(`IOS_BUNDLE_ID "${bundleIdentifier}" is not a valid bundle identifier`);
  }
  if (appleTeamId && !/^[A-Z0-9]{10}$/.test(appleTeamId)) {
    throw new Error(`APPLE_TEAM_ID "${appleTeamId}" must be the 10-character Apple team id`);
  }
  return { ...config, ios: { ...config.ios, bundleIdentifier, appleTeamId } };
};
