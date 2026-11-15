#!/usr/bin/env bash
# Builds the ESCROW §9.2 E3 mimic test program (programs/escrow/test-programs/mimic) to
# programs/escrow/test-programs/mimic/target/deploy/mimic.so. Test fixture only: never deployed.
# `npm run test:escrow` runs E3 when the .so exists (and requires it under ESCROW_SO_REQUIRED=1).
set -euo pipefail
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIMIC_DIR="$(cd "$PKG_DIR/../../programs/escrow/test-programs/mimic" && pwd)"
command -v cargo-build-sbf >/dev/null || {
  echo "build-mimic: cargo-build-sbf not on PATH (Agave 4.1.2)" >&2
  exit 1
}
cd "$MIMIC_DIR"
cargo-build-sbf --sbf-out-dir "$MIMIC_DIR/target/deploy" "$@"
ls -l "$MIMIC_DIR/target/deploy/mimic.so"
