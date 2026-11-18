#!/usr/bin/env bash
# EAS Build preflight for the iOS app: checks locally, without an Expo login, that `eas build`
# will get everything it needs on the first try (docs/IOS-BUILD.md, "Paid account (EAS)"):
# the face model, the npm workspace install (lockfile, @livekit/react-native-webrtc override,
# patch-package), eas.json, the app config, and the exact upload eas-cli 27.10.0 would send.
# Read-only; the logic lives in apps/mobile/scripts/eas-preflight.ts.
#
# Usage: scripts/eas-preflight.sh [--offline] [--strict] [--profile NAME] [--eas-cli DIR]
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -x "$root/node_modules/.bin/tsx" ]]; then
  echo "eas-preflight: run 'npm ci' at the repo root first ($root)" >&2
  exit 1
fi
exec "$root/node_modules/.bin/tsx" "$root/apps/mobile/scripts/eas-preflight.ts" "$@"
