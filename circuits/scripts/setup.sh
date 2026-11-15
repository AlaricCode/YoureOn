#!/usr/bin/env bash
# Verdict biometric circuit setup (CONTRACTS.md §8.6, §17).
#
# Compiles circuits/biometric_match.circom, obtains a Powers of Tau file, runs a
# single-party Groth16 phase 2 finalized with a FIXED dev beacon, and exports
#   build/verification_key.json   (committed)
#   build/vk.rs                   (groth16-solana verifying key; copy to programs/verdict/src/zk/vk.rs)
#   build/biometric_match_final.zkey, build/biometric_match_js/biometric_match.wasm (not committed)
#
# Every step is deterministic: re-running yields byte-identical verification keys.
#
# Usage: scripts/setup.sh [--local-ptau | --download-ptau | --ptau <file>] [--power N] [--force]
#   --local-ptau     (default) generate a Powers of Tau offline: `powersoftau new` + `powersoftau beacon`
#                    with the fixed dev beacon + `prepare phase2`. No network access.
#   --download-ptau  download Hermez powersOfTau28_hez_final_<N>.ptau (~18 MB for N=14).
#   --ptau <file>    use an existing phase-2-prepared ptau file.
#   --power N        ptau power (default 14; the circuit has ~4.6K constraints, so >= 13).
#   --force          redo every step even if outputs exist.
#
# NOTE: the committed verification_key.json / vk.rs come from the default (--local-ptau) mode.
# Using another ptau changes the verifying key; re-commit both files if you do so.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

MODE=local
POWER=14
PTAU_FILE=""
FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local-ptau) MODE=local; shift ;;
    --download-ptau) MODE=download; shift ;;
    --ptau) MODE=file; PTAU_FILE="$2"; shift 2 ;;
    --power) POWER="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Fixed dev beacon = sha256("VERDICT/ZK-DEV-BEACON/v1"). Public and known: this is a DEV setup,
# not a secure ceremony (see README "trusted-setup statement").
BEACON_HASH="d227b82ccd8be1a7ccc34070344ff4237a621f1785f2e6587a0595c7252e4ba1"
BEACON_ITER_EXP=10

CIRCUIT=biometric_match
BUILD="$HERE/build"
PTAU_DIR="$BUILD/ptau"
mkdir -p "$BUILD" "$PTAU_DIR"

if [[ ! -d node_modules/snarkjs || ! -d node_modules/circomlib ]]; then
  echo "==> installing circuits/ npm dependencies"
  npm install --no-audit --no-fund
fi
SNARKJS="node $HERE/node_modules/snarkjs/build/cli.cjs"

# Prefer a native circom 2.1.x; fall back to the pinned circom2 (wasm) package.
if command -v circom >/dev/null 2>&1 && circom --version | grep -q 'circom compiler 2\.1\.'; then
  CIRCOM="circom"
else
  CIRCOM="node $HERE/node_modules/circom2/cli.js"
fi

step() { echo; echo "==> $*"; }

# 1. Compile.
if [[ $FORCE == 1 || ! -f "$BUILD/$CIRCUIT.r1cs" || "$CIRCUIT.circom" -nt "$BUILD/$CIRCUIT.r1cs" || lib/biometric_lib.circom -nt "$BUILD/$CIRCUIT.r1cs" ]]; then
  step "compiling $CIRCUIT.circom ($($CIRCOM --version | tail -1))"
  $CIRCOM "$CIRCUIT.circom" --r1cs --wasm --sym -l node_modules -o "$BUILD"
fi

# 2. Powers of Tau.
case "$MODE" in
  local)
    PTAU="$PTAU_DIR/verdict_local_${POWER}.ptau"
    if [[ $FORCE == 1 || ! -f "$PTAU" ]]; then
      step "generating local Powers of Tau (2^$POWER) with the fixed dev beacon"
      $SNARKJS powersoftau new bn128 "$POWER" "$PTAU_DIR/pot_0000.ptau"
      $SNARKJS powersoftau beacon "$PTAU_DIR/pot_0000.ptau" "$PTAU_DIR/pot_beacon.ptau" \
        "$BEACON_HASH" "$BEACON_ITER_EXP" --name="Verdict dev beacon (phase 1)"
      $SNARKJS powersoftau prepare phase2 "$PTAU_DIR/pot_beacon.ptau" "$PTAU"
      rm -f "$PTAU_DIR/pot_0000.ptau" "$PTAU_DIR/pot_beacon.ptau"
    fi
    ;;
  download)
    PTAU="$PTAU_DIR/powersOfTau28_hez_final_${POWER}.ptau"
    if [[ ! -f "$PTAU" ]]; then
      step "downloading powersOfTau28_hez_final_${POWER}.ptau"
      curl -fL --retry 3 -o "$PTAU.part" \
        "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_${POWER}.ptau"
      mv "$PTAU.part" "$PTAU"
    fi
    ;;
  file)
    PTAU="$PTAU_FILE"
    [[ -f "$PTAU" ]] || { echo "ptau not found: $PTAU" >&2; exit 1; }
    ;;
esac

# 3. Groth16 phase 2 (single party, finalized with the fixed dev beacon).
ZKEY="$BUILD/${CIRCUIT}_final.zkey"
STAMP="$BUILD/.zkey-source"
SOURCE_ID="$(basename "$PTAU") $(sha256sum "$BUILD/$CIRCUIT.r1cs" | cut -d' ' -f1)"
if [[ $FORCE == 1 || ! -f "$ZKEY" || ! -f "$STAMP" || "$(cat "$STAMP")" != "$SOURCE_ID" ]]; then
  step "groth16 setup + zkey beacon"
  $SNARKJS groth16 setup "$BUILD/$CIRCUIT.r1cs" "$PTAU" "$BUILD/${CIRCUIT}_0000.zkey"
  $SNARKJS zkey beacon "$BUILD/${CIRCUIT}_0000.zkey" "$ZKEY" \
    "$BEACON_HASH" "$BEACON_ITER_EXP" --name="Verdict dev beacon (phase 2)"
  rm -f "$BUILD/${CIRCUIT}_0000.zkey"
  echo "$SOURCE_ID" > "$STAMP"
fi

# 4. Export verification key + Rust verifying key.
step "exporting verification key"
$SNARKJS zkey export verificationkey "$ZKEY" "$BUILD/verification_key.json"
node scripts/vk-to-rust.ts "$BUILD/verification_key.json" "$BUILD/vk.rs"

echo
echo "done:"
echo "  $BUILD/verification_key.json"
echo "  $BUILD/vk.rs  (copy to programs/verdict/src/zk/vk.rs)"
echo "  $ZKEY"
echo "  $BUILD/${CIRCUIT}_js/${CIRCUIT}.wasm"
