#!/usr/bin/env bash
# Screenshots of the stage's ?preview moments (sample data, labelled PREVIEW), for rehearsal
# checks and slides. Needs Google Chrome or Chromium; no other tools.
#
#   bash apps/stage/scripts/screenshots.sh [base-url] [out-dir] [WxH]
#     base-url  default https://youre-on.fly.dev/stage/  (or http://localhost:8080/stage/,
#               or http://localhost:5174/ for `npm run dev -w apps/stage`)
#     out-dir   default ./stage-screenshots
#     WxH       default 1920x1080 (try 1280x720 for a small projector)
set -euo pipefail

BASE="${1:-https://youre-on.fly.dev/stage/}"
OUT="${2:-./stage-screenshots}"
SIZE="${3:-1920x1080}"
STEPS=(challenge terms lock locked attempt redo judging ruling paid market settled)

CHROME=""
for c in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "$(command -v google-chrome 2>/dev/null || true)" \
  "$(command -v chromium 2>/dev/null || true)" \
  "$(command -v chromium-browser 2>/dev/null || true)"; do
  if [ -n "$c" ] && [ -x "$c" ]; then
    CHROME="$c"
    break
  fi
done
if [ -z "$CHROME" ]; then
  echo "no Chrome / Chromium found" >&2
  exit 1
fi

mkdir -p "$OUT"
PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT
for step in "${STEPS[@]}"; do
  file="$OUT/stage-$step-$SIZE.png"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$PROFILE" \
    --window-size="${SIZE/x/,}" --virtual-time-budget=3000 --screenshot="$file" \
    "${BASE}?preview=${step}&nopreload" >/dev/null 2>&1
  echo "$file"
done
