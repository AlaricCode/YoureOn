#!/usr/bin/env bash
# CPU tests of the optional Python sidecars (services/perception, services/embedder).
# Not part of `npm test`: needs Python ≥ 3.11 and pip (free; no keys, no spend).
# Real-model tests are skipped unless the pinned weights are installed (see each README).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="${VENV:-${TMPDIR:-/tmp}/verdict-services-venv}"
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q -r "$ROOT/services/perception/requirements-dev.txt"
fi
export PYTHONDONTWRITEBYTECODE=1
for svc in perception embedder; do
  echo "== services/$svc"
  (cd "$ROOT/services/$svc" && "$VENV/bin/python" -m pytest -q -p no:cacheprovider)
done
