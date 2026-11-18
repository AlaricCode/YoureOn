#!/usr/bin/env bash
# Publish a JS-only fix to the installed EAS builds over the air (EAS Update), bundled with the
# build profile's own EXPO_PUBLIC_* env and refused when native code changed since the build
# (docs/IOS-BUILD.md, "Paid account (EAS)"). The logic lives in apps/mobile/scripts/eas-update.ts.
#
# Usage: scripts/eas-update.sh --profile preview|preview-typed|pitch --message "what changed"
#                              [--dry-run] [--allow-dirty] [--allow-native-changes] [--eas-cli DIR]
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -x "$root/node_modules/.bin/tsx" ]]; then
  echo "eas-update: run 'npm ci' at the repo root first ($root)" >&2
  exit 1
fi
exec "$root/node_modules/.bin/tsx" "$root/apps/mobile/scripts/eas-update.ts" "$@"
