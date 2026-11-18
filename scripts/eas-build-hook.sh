#!/usr/bin/env bash
# EAS Build lifecycle hooks for apps/mobile (docs/IOS-BUILD.md, "Paid account (EAS)").
# apps/mobile/package.json wires them; the EAS worker runs `npm run eas-build-<hook>` in apps/mobile
# (@expo/build-tools 27.x). Both checks are cheap and fail in the first minutes, instead of after
# a 20-minute Xcode compile:
#
#   pre-install   runs right after the upload is unpacked, before `npm ci` (no node_modules yet):
#                 the face model must be in the upload (.easignore re-includes it; git ignores it),
#                 with the known-good sha256. Also logs the public build env for the build log.
#   post-install  runs after `npm ci`, `expo prebuild` and `pod install`, before Xcode: the
#                 face-detector Swift patch is applied and the WebRTC pin resolved.
#
# Usage: scripts/eas-build-hook.sh pre-install|post-install [--app-dir DIR]
# Exit codes: 0 ok, 1 check failed, 64 bad usage. Needs only bash, sed and shasum/sha256sum, so it
# also runs before dependencies are installed.
set -euo pipefail

hook="${1:-}"
shift || true
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../apps/mobile" && pwd)"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir) app_dir="$(cd "$2" && pwd)"; shift 2 ;;
    *) echo "eas-build-hook: unknown argument: $1" >&2; exit 64 ;;
  esac
done

fail() {
  echo "eas-build-hook($hook): FAIL: $*" >&2
  exit 1
}
ok() { echo "eas-build-hook($hook): ok: $*"; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# FACE_MODEL in src/face/model.ts is the one source of the file name, size and hash.
model_field() {
  sed -nE "s/^[[:space:]]*$1: '([^']+)',?$/\1/p" "$app_dir/src/face/model.ts" | head -n1
}

pre_install() {
  local name sha size path actual_size actual_sha
  name="$(model_field fileName)"
  sha="$(model_field sha256)"
  size="$(sed -nE 's/^[[:space:]]*sizeBytes: ([0-9_]+),?$/\1/p' "$app_dir/src/face/model.ts" | head -n1 | tr -d _)"
  [[ -n "$name" && -n "$sha" && -n "$size" ]] || fail "could not read FACE_MODEL from src/face/model.ts"
  path="$app_dir/assets/models/$name"
  if [[ ! -f "$path" ]]; then
    fail "assets/models/$name is not in the upload. Run scripts/face-model.sh on the machine that" \
      "runs 'eas build', keep the root .easignore (it re-includes the model), and check with" \
      "scripts/eas-preflight.sh."
  fi
  actual_size="$(wc -c <"$path" | tr -d ' ')"
  [[ "$actual_size" == "$size" ]] || fail "assets/models/$name is $actual_size bytes, expected $size"
  actual_sha="$(sha256 "$path")"
  [[ "$actual_sha" == "$sha" ]] || fail "assets/models/$name sha256 is $actual_sha, expected $sha"
  ok "face model present ($name, $size bytes, sha256 ${sha:0:12}…)"

  # Only public values: EXPO_PUBLIC_* are inlined into the app anyway.
  echo "eas-build-hook($hook): profile=${EAS_BUILD_PROFILE:-?} platform=${EAS_BUILD_PLATFORM:-?}" \
    "IOS_BUNDLE_ID=${IOS_BUNDLE_ID:-<app.json>} EXPO_PUBLIC_API_URL=${EXPO_PUBLIC_API_URL:-<unset>}" \
    "EXPO_PUBLIC_VOICE=${EXPO_PUBLIC_VOICE:-<unset>} EXPO_PUBLIC_BUILD=${EXPO_PUBLIC_BUILD:-<unset>}"
  if [[ "${EAS_BUILD_PROFILE:-}" != "development" && -n "${EAS_BUILD_PROFILE:-}" ]]; then
    [[ "${EXPO_PUBLIC_API_URL:-}" == https://* ]] \
      || fail "EXPO_PUBLIC_API_URL must be an https:// URL for a '${EAS_BUILD_PROFILE}' build (eas.json env)"
  fi
}

# Walks up from the app the way Node resolves packages (npm workspaces hoist to the repo root).
package_dir() {
  local dir="$app_dir"
  while :; do
    if [[ -f "$dir/node_modules/$1/package.json" ]]; then
      echo "$dir/node_modules/$1"
      return 0
    fi
    [[ "$dir" == "/" ]] && return 1
    dir="$(dirname "$dir")"
  done
}

package_version() {
  sed -nE 's/^[[:space:]]*"version": "([^"]+)".*/\1/p' "$1/package.json" | head -n1
}

post_install() {
  local fd webrtc swift version
  fd="$(package_dir react-native-vision-camera-face-detector)" \
    || fail "react-native-vision-camera-face-detector is not installed"
  swift="$fd/ios/Extensions/ML+FaceDetectorOptions.swift"
  grep -q 'performanceMode?.stringValue == "accurate"' "$swift" \
    || fail "the face-detector patch is not applied to $swift (postinstall: patch-package)"
  ok "face-detector Swift patch applied"

  webrtc="$(package_dir @livekit/react-native-webrtc)" || fail "@livekit/react-native-webrtc is not installed"
  version="$(package_version "$webrtc")"
  [[ "$version" == "144.1.2" ]] \
    || fail "@livekit/react-native-webrtc resolved to $version, expected 144.1.2 (root package.json overrides)"
  ok "@livekit/react-native-webrtc $version"
}

case "$hook" in
  pre-install) pre_install ;;
  post-install) post_install ;;
  *) echo "usage: scripts/eas-build-hook.sh pre-install|post-install [--app-dir DIR]" >&2; exit 64 ;;
esac
