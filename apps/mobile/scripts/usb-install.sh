#!/usr/bin/env bash
# Install the Release app on every iPhone plugged into this Mac over USB, signed with the free
# Personal Team (no paid Apple account, no EAS). See docs/IOS-BUILD.md "Free Apple ID on your own Mac".
#
#   apps/mobile/scripts/usb-install.sh            build (registering new phones) + install + launch
#
# Needs: ios/ prebuilt for DEVICE (CI=1 npx expo prebuild -p ios --clean --no-install && cd ios &&
# pod install, with IOS_BUNDLE_ID/APPLE_TEAM_ID exported), each phone unlocked, trusted, with
# Developer Mode on. After the first install, on the phone: Settings > General > VPN & Device
# Management > your Apple ID > Trust. Free-team installs expire after 7 days.
set -euo pipefail

MOBILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEAM="${APPLE_TEAM_ID:-2LFBZ8AAAX}"
BUNDLE="${IOS_BUNDLE_ID:-dev.youreon.app}"
APP="$MOBILE/ios/build-device/Build/Products/Release-iphoneos/YoureOn.app"

json="$(mktemp)"
xcrun devicectl list devices --json-output "$json" >/dev/null
phones=()
while IFS= read -r line; do phones+=("$line"); done < <(python3 - "$json" <<'PY'
import json, sys
for d in json.load(open(sys.argv[1]))["result"]["devices"]:
    hw, cp = d.get("hardwareProperties", {}), d.get("connectionProperties", {})
    if hw.get("platform") == "iOS" and cp.get("tunnelState") != "unavailable":
        print(d["identifier"], hw.get("udid", ""), d.get("deviceProperties", {}).get("name", "?"))
PY
)
rm -f "$json"
[[ ${#phones[@]} -gt 0 ]] || { echo "No iPhone connected (plug in, unlock, Trust)." >&2; exit 1; }

for p in "${phones[@]}"; do
  read -r id udid name <<<"$p"
  echo "== $name ($udid)"
  # Building against each phone registers it in the free team's provisioning profile.
  xcodebuild -workspace "$MOBILE/ios/YoureOn.xcworkspace" -scheme YoureOn -configuration Release \
    -destination "id=$udid" -derivedDataPath "$MOBILE/ios/build-device" \
    -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
    DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic build -quiet
  xcrun devicectl device install app --device "$id" "$APP" >/dev/null
  if xcrun devicectl device process launch --device "$id" "$BUNDLE" >/dev/null 2>&1; then
    echo "   installed + launched"
  else
    echo "   installed. On the phone: Settings > General > VPN & Device Management > Trust, then open You're On"
  fi
done
