#!/usr/bin/env bash
# Replays the EAS Build iOS pipeline on this Mac, unsigned, without an Expo login, so a native
# change can be proven to compile before it costs an EAS build (docs/IOS-BUILD.md, "Paid account
# (EAS)"). It follows @expo/build-tools 27.10.0 (builders/ios.js) step by step for a managed
# project, starting from the exact upload eas-cli would send:
#
#   PREPARE_PROJECT       git clone --no-checkout --depth 1 + eas-cli's own working-tree copy
#                         (vcs/local.js makeShallowCopyAsync, honouring /.easignore)
#   PRE_INSTALL_HOOK      npm run eas-build-pre-install
#   INSTALL_DEPENDENCIES  npm ci --include=dev at the workspace root
#   PREBUILD              expo prebuild --no-install --platform ios, APPLE_TEAM_ID set the way
#                         EAS sets it from the credentials; then npm install --include=dev
#   INSTALL_PODS          pod install
#   POST_INSTALL_HOOK     npm run eas-build-post-install
#   CONFIGURE_EXPO_UPDATES  the profile's channel into Expo.plist (only if --linked)
#   RUN_FASTLANE          stand-in: xcodebuild archive, Release, generic iOS, CODE_SIGNING_ALLOWED=NO
#
# then checks the .app: bundle ID, face model bytes, API URL in the Hermes bundle, entitlements,
# Expo.plist. Not covered: signing/provisioning (EAS-managed credentials) and the exact image.
#
# Usage: scripts/eas-dry-run.sh [--profile preview] [--out DIR] [--linked] [--worker-node]
#   --profile      eas.json build profile whose env is used (default: preview)
#   --out          work directory, wiped first (default: $TMPDIR/youre-on-eas-dry-run)
#   --linked       pretend `eas init` ran (fake extra.eas.projectId), so EAS Update is on
#   --worker-node  run npm with Node 22.23.4 + npm 10.9.9 like the EAS worker (fetched via npm)
# Needs: Xcode (xcodebuild), CocoaPods, node + npm, network for npm/pods. Takes 5-20 minutes.
set -euo pipefail

EAS_CLI_VERSION="27.10.0"
WORKER_NODE="22.23.4"
WORKER_NPM="10.9.9"
FAKE_TEAM="ABCDE12345"
FAKE_PROJECT="00000000-0000-4000-8000-000000000000"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
profile="preview"
out="${TMPDIR:-/tmp}/youre-on-eas-dry-run"
linked=0
worker_node=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) profile="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --linked) linked=1; shift ;;
    --worker-node) worker_node=1; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "eas-dry-run: unknown argument: $1" >&2; exit 64 ;;
  esac
done
[[ "$out" == /* && "$out" != "/" && "$out" != "$root"* ]] \
  || { echo "eas-dry-run: --out must be an absolute path outside the repo" >&2; exit 64; }
for tool in git node npm pod xcodebuild plutil; do
  command -v "$tool" >/dev/null || { echo "eas-dry-run: $tool not found" >&2; exit 1; }
done

phase() { echo; echo "===== [$(date '+%H:%M:%S')] $* ====="; }

eas_cli="${EAS_CLI_DIR:-}"
if [[ -z "$eas_cli" ]]; then
  bin="$(cd "${TMPDIR:-/tmp}" && npm exec --yes --package="eas-cli@$EAS_CLI_VERSION" -- sh -c 'command -v eas')"
  eas_cli="$(cd "$(dirname "$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$bin")")/.." && pwd)"
fi
[[ -f "$eas_cli/build/vcs/local.js" ]] || { echo "eas-dry-run: no eas-cli at $eas_cli" >&2; exit 1; }

profile_json="$(cd "$root/apps/mobile" && node "$eas_cli/bin/run" config --eas-json-only --platform ios \
  --profile "$profile" --json --non-interactive)"

rm -rf "$out"
mkdir -p "$out"
build="$out/build"

phase "PREPARE_PROJECT"
git clone -q --no-checkout --depth 1 "file://$root" "$build" 2>/dev/null || mkdir -p "$build"
node -e 'require(process.argv[1]).makeShallowCopyAsync(process.argv[2], process.argv[3]).catch((e) => { console.error(e); process.exit(1); })' \
  "$eas_cli/build/vcs/local.js" "$root" "$build"
echo "upload: $(du -sh "$build" | cut -f1)"
if [[ "$linked" -eq 1 ]]; then
  node -e 'const f=process.argv[1];const j=JSON.parse(require("fs").readFileSync(f,"utf8"));j.expo.extra={...(j.expo.extra||{}),eas:{projectId:process.argv[2]}};require("fs").writeFileSync(f,JSON.stringify(j,null,2))' \
    "$build/apps/mobile/app.json" "$FAKE_PROJECT"
  echo "linked to fake EAS project $FAKE_PROJECT"
fi

if [[ "$worker_node" -eq 1 ]]; then
  node_bin="$(cd "${TMPDIR:-/tmp}" && npm exec --yes --package="node@$WORKER_NODE" -- sh -c 'dirname "$(command -v node)"')"
  npm_cli="$(cd "${TMPDIR:-/tmp}" && npm exec --yes --package="npm@$WORKER_NPM" -- sh -c 'command -v npm')"
  npm_cli="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$npm_cli")"
  export PATH="$node_bin:$PATH"
  npm() { node "$npm_cli" "$@"; }
  export -f npm
fi
echo "node $(node --version), npm $(npm --version)"

# The worker's env: the profile's env (eas.json wins over EAS env vars) + EAS_BUILD_* + CI.
eval "$(printf '%s' "$profile_json" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const[k,v]of Object.entries(JSON.parse(d).buildProfile.env||{}))console.log(`export ${k}=${JSON.stringify(v)}`)})')"
export CI=1 EXPO_NO_TELEMETRY=1 EAS_BUILD=true EAS_BUILD_PLATFORM=ios EAS_BUILD_PROFILE="$profile" EAS_BUILD_RUNNER=local-dry-run
channel="$(printf '%s' "$profile_json" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).buildProfile.channel||""))')"
env | grep -E '^(IOS_|EXPO_PUBLIC_)' | sort

cd "$build/apps/mobile"
phase "PRE_INSTALL_HOOK"
npm run eas-build-pre-install

phase "INSTALL_DEPENDENCIES"
(cd "$build" && npm ci --include=dev --no-audit --no-fund)

phase "PREBUILD"
APPLE_TEAM_ID="$FAKE_TEAM" EXPO_IMAGE_UTILS_NO_SHARP=1 npx expo prebuild --no-install --platform ios
(cd "$build" && npm install --include=dev --no-audit --no-fund)

phase "INSTALL_PODS"
(cd ios && pod install)

phase "POST_INSTALL_HOOK"
npm run eas-build-post-install

expo_plist="ios/$(basename ios/*.xcworkspace .xcworkspace)/Supporting/Expo.plist"
if [[ "$linked" -eq 1 && -n "$channel" && -f "$expo_plist" ]]; then
  phase "CONFIGURE_EXPO_UPDATES"
  plutil -replace EXUpdatesRequestHeaders -json "{\"expo-channel-name\":\"$channel\"}" "$expo_plist"
  echo "channel $channel"
fi

phase "RUN_FASTLANE (stand-in: unsigned xcodebuild archive)"
scheme="$(basename ios/*.xcworkspace .xcworkspace)"
log="$out/xcodebuild.log"
if ! xcodebuild -workspace "ios/$scheme.xcworkspace" -scheme "$scheme" -configuration Release \
  -destination generic/platform=iOS -archivePath "$out/$scheme.xcarchive" -derivedDataPath "$out/dd" \
  CODE_SIGNING_ALLOWED=NO archive >"$log" 2>&1; then
  grep -E "error:|\*\* ARCHIVE FAILED" "$log" | head -40
  echo "eas-dry-run: FAILED, full log: $log" >&2
  exit 1
fi
grep -E '^\*\* ' "$log"

phase "CHECK the .app"
app="$out/$scheme.xcarchive/Products/Applications/$scheme.app"
fail=0
check() { if eval "$2"; then echo "  ok    $1"; else echo "  FAIL  $1"; fail=1; fi; }
model_sha="$(sed -nE "s/^[[:space:]]*sha256: '([0-9a-f]{64})',?$/\1/p" "$root/apps/mobile/src/face/model.ts")"
model_name="$(sed -nE "s/^[[:space:]]*fileName: '([^']+)',?$/\1/p" "$root/apps/mobile/src/face/model.ts")"
model_in_app="$(find "$app" -name "$model_name" | head -n1)"
check "bundle ID $IOS_BUNDLE_ID" \
  '[[ "$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$app/Info.plist")" == "$IOS_BUNDLE_ID" ]]'
check "face model in the app, sha256 ${model_sha:0:12}…" \
  '[[ -n "$model_in_app" && "$(shasum -a 256 "$model_in_app" | cut -d" " -f1)" == "$model_sha" ]]'
check "API URL $EXPO_PUBLIC_API_URL inlined in main.jsbundle" 'grep -aq "$EXPO_PUBLIC_API_URL" "$app/main.jsbundle"'
check "no aps-environment entitlement" '! grep -q aps-environment ios/*/*.entitlements'
echo "  Info.plist: $(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$app/Info.plist") $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Info.plist") ($(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Info.plist"))"
[[ -f "$app/Expo.plist" ]] && plutil -p "$app/Expo.plist"
echo "  app size: $(du -sh "$app" | cut -f1); archive: $out/$scheme.xcarchive"
[[ "$fail" -eq 0 ]] || { echo "eas-dry-run: the build is not what EAS should produce" >&2; exit 1; }
echo "eas-dry-run: OK (unsigned). EAS adds signing with the EAS-managed ad hoc profile."
