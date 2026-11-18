#!/usr/bin/env bash
# Beats 1-2 on two iOS simulators against a REAL server (the build's EXPO_PUBLIC_API_URL):
#   both phones sign up -> A makes a room -> B joins with the code (A sees B over its socket) ->
#   A challenges B from the list -> B accepts -> A types the terms -> B sees them and backs out ->
#   A sees "Declined. Nothing moved."
# It never taps "Lock it in", so nothing is locked and no money moves. Each run creates two new
# users on that server. Needs Maestro (https://maestro.mobile.dev) and the app installed on both
# simulators (apps/mobile/scripts/sim-build.sh, then `xcrun simctl install <udid> <app>`).
#
#   apps/mobile/e2e/maestro/two-phones.sh <udid A> <udid B> [output dir]
#   NAME_A="Local A" NAME_B="Local B" apps/mobile/e2e/maestro/two-phones.sh ...
#
# Screenshots and Maestro logs land in the output dir (default: a new temp dir), one folder per
# flow run. To run it with no real server at all (and to exercise the voice-failure fallback):
# start apps/server locally on your own Postgres with mock providers and no keys
# (DATABASE_URL=... PORT=8787 MARKETS_FEED=off npx tsx apps/server/src/main.ts), then build with
# EXPO_PUBLIC_API_URL=http://localhost:8787 EXPO_PUBLIC_VOICE=on scripts/sim-build.sh --skip-native.
set -euo pipefail

A="${1:?usage: two-phones.sh <udid A> <udid B> [output dir]}"
B="${2:?usage: two-phones.sh <udid A> <udid B> [output dir]}"
OUT="${3:-$(mktemp -d -t yo-maestro)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAESTRO="${MAESTRO:-$(command -v maestro || echo "$HOME/.maestro/bin/maestro")}"
NAME_A="${NAME_A:-Sim A}"
NAME_B="${NAME_B:-Sim B}"
export MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true

mkdir -p "$OUT"
run() {
  local device="$1" flow="$2"
  shift 2
  echo "== $flow on $device"
  "$MAESTRO" --device "$device" test --test-output-dir "$OUT" "$@" "$HERE/$flow"
}

run "$A" 01-signup.yaml -e NAME="$NAME_A"
run "$B" 01-signup.yaml -e NAME="$NAME_B"
run "$A" 02-create-room.yaml

# The room code, read off A's screen (the room-code-chip element).
CODE="$("$MAESTRO" --device "$A" hierarchy 2>/dev/null | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const find = (n) => {
      const a = n.attributes || {};
      if (a["resource-id"] === "room-code-chip") return a.accessibilityText || a.text || a.value;
      for (const c of n.children || []) {
        const hit = find(c);
        if (hit) return hit;
      }
      return null;
    };
    process.stdout.write(find(JSON.parse(s.slice(s.indexOf("{")))) || "");
  });')"
[[ "$CODE" =~ ^[A-Z0-9]{4,12}$ ]] || {
  echo "could not read the room code from phone A (got '$CODE')" >&2
  exit 1
}
echo "room code: $CODE"

run "$B" 03-join-room.yaml -e ROOM_CODE="$CODE" -e OPPONENT="$NAME_A"
run "$A" 04-challenge.yaml -e OPPONENT="$NAME_B"
run "$B" 05-accept.yaml -e CHALLENGER="$NAME_A"
run "$A" 06-send-terms.yaml
run "$B" 07-b-sees-terms-and-backs-out.yaml
run "$A" 08-a-sees-decline.yaml
echo "done: screenshots in $OUT"
