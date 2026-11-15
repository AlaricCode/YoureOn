#!/usr/bin/env bash
# Re-make the on-device face-embedding model (TASKS D0-M2, FINDINGS §3.2) from the official
# InsightFace release, so the committed .tflite has a reproducible, in-window provenance
# (TASKS §3.2 rules 7 and 9: never copy the spike's file).
#
#   1. download InsightFace `buffalo_s` from the official model zoo (GitHub release v0.7),
#   2. extract `w600k_mbf.onnx`,
#   3. convert it with onnx2tf==2.6.9 at batch size 1 (default flatbuffer_direct backend, no
#      TensorFlow needed) and keep the fp32 file (the fp16 file has fp16 I/O tensors that
#      react-native-fast-tflite cannot feed from JS),
#   4. print the sha256 and compare it with the known-good hash.
#
# The conversion is deterministic: spike 01's file hashed to ca17b05a…, so a match proves the
# pipeline. The weights are licensed for NON-COMMERCIAL RESEARCH ONLY (InsightFace model_zoo
# README); see apps/mobile/assets/models/NOTICE-w600k_mbf.txt.
#
# Usage: scripts/face-model.sh [--out DIR] [--work DIR] [--allow-mismatch]
#   --out   where w600k_mbf_float32.tflite is written (default: apps/mobile/assets/models)
#   --work  scratch directory for the download, venv and conversion (default: a new mktemp dir)
#   --allow-mismatch  still copy the model to --out when the hash differs (exit code stays 3)
#
# Needs: bash, curl, unzip or python3, and either `uv` (preferred: fetches Python 3.12) or a
# python3 >= 3.12 with venv + pip. onnx2tf 2.6.9 requires Python >= 3.12 and pins numpy 2.2.6.
set -euo pipefail

ZIP_URL="https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_s.zip"
ONNX_NAME="w600k_mbf.onnx"
TFLITE_NAME="w600k_mbf_float32.tflite"
ONNX2TF_VERSION="2.6.9"
PYTHON_VERSION="3.12"
# Known-good output. Spike 01's file hashed to ca17b05a… (FINDINGS §3.2 / TASKS D0-M2); this script
# reproduced it in full on 2026-11-08 (13,635,536 bytes), with and without onnx-simplifier.
EXPECTED_SHA256="${EXPECTED_SHA256:-ca17b05ac6e92ff819d81191d865e3864f4e6779df60468f0db547c982091033}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="$repo_root/apps/mobile/assets/models"
work_dir=""
allow_mismatch=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out_dir="$2"; shift 2 ;;
    --work) work_dir="$2"; shift 2 ;;
    --allow-mismatch) allow_mismatch=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

if [[ -z "$work_dir" ]]; then
  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/face-model.XXXXXX")"
fi
mkdir -p "$work_dir" "$out_dir"
work_dir="$(cd "$work_dir" && pwd)"
out_dir="$(cd "$out_dir" && pwd)"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Downloads and extracted archives are untrusted data: keep them in their own directories and
# never run anything from inside them.
dl_dir="$work_dir/download"
x_dir="$work_dir/extracted"
conv_dir="$work_dir/converted"
venv_dir="$work_dir/venv"
mkdir -p "$dl_dir" "$x_dir" "$conv_dir"

zip_path="$dl_dir/buffalo_s.zip"
if [[ ! -s "$zip_path" ]]; then
  echo "==> downloading $ZIP_URL"
  curl -fL --retry 3 --proto '=https' --tlsv1.2 -o "$zip_path.part" "$ZIP_URL"
  mv "$zip_path.part" "$zip_path"
fi
echo "buffalo_s.zip sha256: $(sha256 "$zip_path")"

echo "==> extracting $ONNX_NAME"
rm -rf "$x_dir"/*
if command -v unzip >/dev/null 2>&1; then
  # -j: junk paths, so only the one member lands flat in $x_dir.
  unzip -q -j -o "$zip_path" "*$ONNX_NAME" -d "$x_dir"
else
  python3 -I -c '
import sys, zipfile, os
zp, member, dest = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(zp) as z:
    names = [n for n in z.namelist() if n.endswith(member)]
    if len(names) != 1:
        sys.exit(f"expected exactly one {member} in archive, found {names}")
    with z.open(names[0]) as src, open(os.path.join(dest, member), "wb") as dst:
        dst.write(src.read())
' "$zip_path" "$ONNX_NAME" "$x_dir"
fi
onnx_path="$x_dir/$ONNX_NAME"
[[ -s "$onnx_path" ]] || { echo "error: $ONNX_NAME not found in buffalo_s.zip" >&2; exit 1; }
echo "$ONNX_NAME sha256: $(sha256 "$onnx_path")"

echo "==> installing onnx2tf==$ONNX2TF_VERSION into $venv_dir"
if [[ ! -x "$venv_dir/bin/onnx2tf" ]]; then
  if command -v uv >/dev/null 2>&1; then
    uv venv --quiet --python "$PYTHON_VERSION" "$venv_dir"
    uv pip install --quiet --python "$venv_dir/bin/python" "onnx2tf==$ONNX2TF_VERSION"
  else
    python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' \
      || { echo "error: need uv, or python3 >= 3.12 (onnx2tf $ONNX2TF_VERSION)" >&2; exit 1; }
    python3 -m venv "$venv_dir"
    "$venv_dir/bin/python" -m pip install --quiet "onnx2tf==$ONNX2TF_VERSION"
  fi
fi

echo "==> converting (onnx2tf -b 1, fp32)"
rm -rf "$conv_dir"/*
# Run from an empty directory so nothing from the download or the repo is on the import path.
# onnx2tf shells out to the `onnxsim` CLI, so the venv's bin must be on PATH (otherwise it warns
# "Failed to optimize the onnx file" and skips that step; the output hash is the same either way).
(cd "$conv_dir" && PATH="$venv_dir/bin:$PATH" "$venv_dir/bin/onnx2tf" -i "$onnx_path" -b 1 -o "$conv_dir/out")
tflite_path="$conv_dir/out/$TFLITE_NAME"
[[ -s "$tflite_path" ]] || { echo "error: onnx2tf did not write $TFLITE_NAME" >&2; ls -la "$conv_dir/out" >&2 || true; exit 1; }

digest="$(sha256 "$tflite_path")"
size="$(wc -c < "$tflite_path" | tr -d ' ')"
echo "$TFLITE_NAME sha256: $digest ($size bytes)"

match=1
[[ "$digest" == "$EXPECTED_SHA256" ]] || match=0

if [[ "$match" -eq 1 ]]; then
  cp "$tflite_path" "$out_dir/$TFLITE_NAME"
  echo "OK: hash matches the known-good conversion; wrote $out_dir/$TFLITE_NAME"
  exit 0
fi

echo "MISMATCH: expected $EXPECTED_SHA256, got $digest" >&2
if [[ "$allow_mismatch" -eq 1 ]]; then
  cp "$tflite_path" "$out_dir/$TFLITE_NAME"
  echo "copied anyway (--allow-mismatch) to $out_dir/$TFLITE_NAME; do NOT commit it" >&2
fi
exit 3
