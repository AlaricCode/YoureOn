#!/usr/bin/env bash
# Face ID on an iOS Simulator from the command line (what Features > Face ID does in the
# Simulator app). Checked on the iOS 26.5 runtime.
#
#   apps/mobile/e2e/sim-faceid.sh <udid|booted> enroll     Face ID set up (enrolled=true)
#   apps/mobile/e2e/sim-faceid.sh <udid|booted> unenroll   no Face ID (the app offers the passcode)
#   apps/mobile/e2e/sim-faceid.sh <udid|booted> match      answer an open Face ID prompt: success
#   apps/mobile/e2e/sim-faceid.sh <udid|booted> nomatch    answer an open Face ID prompt: wrong face
#
# The simulator's passcode sheet (the fallback) accepts any passcode.
set -euo pipefail

DEVICE="${1:?usage: sim-faceid.sh <udid|booted> enroll|unenroll|match|nomatch}"
notify() { xcrun simctl spawn "$DEVICE" notifyutil "$@"; }

case "${2:-}" in
  enroll | unenroll)
    notify -s com.apple.BiometricKit.enrollmentChanged "$([[ $2 == enroll ]] && echo 1 || echo 0)"
    notify -p com.apple.BiometricKit.enrollmentChanged
    ;;
  match) notify -p com.apple.BiometricKit_Sim.pearl.match ;;
  nomatch) notify -p com.apple.BiometricKit_Sim.pearl.nomatch ;;
  *)
    echo "usage: sim-faceid.sh <udid|booted> enroll|unenroll|match|nomatch" >&2
    exit 2
    ;;
esac
