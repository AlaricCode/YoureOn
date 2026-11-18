#!/usr/bin/env bash
# Build the Release app (JS bundle embedded, no Metro) for the iOS Simulator, install it and
# launch it. Simulator builds leave out the MLKit face detector (see ../react-native.config.js):
# Google ships no arm64-simulator slice, and the simulator has no camera to feed it.
#
#   apps/mobile/scripts/sim-build.sh                  prebuild + pods + build + install + launch
#   apps/mobile/scripts/sim-build.sh --skip-native    reuse ios/ and Pods (JS-only change)
#   apps/mobile/scripts/sim-build.sh --device "YO iPhone 17 Pro B"   another simulator
#   apps/mobile/scripts/sim-build.sh --no-launch      build + install only
#
# Needs: Xcode 26 with an iOS 26 simulator runtime, CocoaPods, the face model at
# assets/models/w600k_mbf_float32.tflite (scripts/face-model.sh; gitignored) and the API URL in
# apps/mobile/.env.local (EXPO_PUBLIC_API_URL=...; EXPO_PUBLIC_VOICE=off for no voice judge).
#
# Afterwards a DEVICE build needs the device pods back: (cd apps/mobile/ios && pod install).
set -euo pipefail

MOBILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVICE_NAME="YO iPhone 17 Pro"
DEVICE_TYPE="com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"
BUNDLE_ID="${IOS_BUNDLE_ID:-dev.youreon.app}"
SKIP_NATIVE=0
LAUNCH=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-native) SKIP_NATIVE=1 ;;
    --no-launch) LAUNCH=0 ;;
    --device)
      DEVICE_NAME="${2:?--device needs a simulator name}"
      shift
      ;;
    -h | --help)
      sed -n '2,15p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

cd "$MOBILE"
[[ -f assets/models/w600k_mbf_float32.tflite ]] || {
  echo "missing assets/models/w600k_mbf_float32.tflite (run scripts/face-model.sh)" >&2
  exit 1
}
[[ -f .env.local ]] || echo "note: no apps/mobile/.env.local; the app will call http://localhost:8080" >&2

# The newest installed iOS runtime.
RUNTIME="$(xcrun simctl list runtimes -j | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const ios = JSON.parse(s).runtimes.filter((r) => r.platform === "iOS" && r.isAvailable);
    ios.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
    process.stdout.write(ios.at(-1)?.identifier ?? "");
  });')"
[[ -n "$RUNTIME" ]] || {
  echo "no iOS simulator runtime installed (Xcode > Settings > Components)" >&2
  exit 1
}

udid_of() {
  xcrun simctl list devices -j | DEVICE_NAME="$1" node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const all = Object.values(JSON.parse(s).devices).flat();
      const d = all.find((x) => x.name === process.env.DEVICE_NAME && x.isAvailable);
      process.stdout.write(d ? d.udid : "");
    });'
}

UDID="$(udid_of "$DEVICE_NAME")"
if [[ -z "$UDID" ]]; then
  UDID="$(xcrun simctl create "$DEVICE_NAME" "$DEVICE_TYPE" "$RUNTIME")"
  echo "created simulator $DEVICE_NAME ($UDID)"
fi
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null

if [[ "$SKIP_NATIVE" -eq 0 ]]; then
  YO_IOS_SIMULATOR=1 CI=1 npx expo prebuild -p ios --no-install
  (cd ios && YO_IOS_SIMULATOR=1 pod install)
fi

LOG="$MOBILE/ios/build/sim-build.log"
mkdir -p "$(dirname "$LOG")"
echo "building (log: $LOG)"
if ! xcodebuild -workspace ios/YoureOn.xcworkspace -scheme YoureOn -configuration Release \
  -sdk iphonesimulator -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath ios/build/dd ARCHS=arm64 ONLY_ACTIVE_ARCH=YES build >"$LOG" 2>&1; then
  grep -E 'error:|^ld: ' "$LOG" | grep -v warning | head -20 >&2
  echo "build failed; full log: $LOG" >&2
  exit 1
fi

APP="$MOBILE/ios/build/dd/Build/Products/Release-iphonesimulator/YoureOn.app"
xcrun simctl install "$UDID" "$APP"
echo "installed $BUNDLE_ID on $DEVICE_NAME ($UDID)"
if [[ "$LAUNCH" -eq 1 ]]; then
  xcrun simctl launch "$UDID" "$BUNDLE_ID"
fi
