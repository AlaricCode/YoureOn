#!/usr/bin/env bash
# `npm run test:validator -w packages/shared`: the local-validator suite (ESCROW §9.1), the rows
# LiteSVM hides (N1/N8/N10/N11/N13-N15 on Agave, atomic-lock timing). Not part of `npm test`.
#
# Starts its own solana-test-validator (Agave 4.1.2) on fixed, non-default ports so it cannot clash
# with another validator on this machine, loads target/deploy/escrow.so as an UPGRADEABLE program
# (initialize_config checks ProgramData.upgrade_authority) with a throwaway upgrade authority made in
# a temp dir, runs vitest against it, and always kills the validator and removes the temp dir.
# Local only: no devnet/mainnet, the airdrops hit this validator's own faucet.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$PKG_DIR/../.." && pwd)"
SO="${ESCROW_SO:-$REPO_DIR/programs/escrow/target/deploy/escrow.so}"
PROGRAM_ID="BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp"

RPC_PORT=18899
FAUCET_PORT=19900
GOSSIP_PORT=18001
DYNAMIC_PORTS=18100-18200
RPC_URL="http://127.0.0.1:${RPC_PORT}"

if [[ ! -f "$SO" ]]; then
  echo "test:validator: $SO not found; run \`anchor build\` in programs/escrow first." >&2
  exit 1
fi
command -v solana-test-validator >/dev/null || {
  echo "test:validator: solana-test-validator not on PATH (Agave 4.1.2)." >&2
  exit 1
}
if curl -s --max-time 1 "$RPC_URL" >/dev/null 2>&1; then
  echo "test:validator: something already listens on $RPC_URL; refusing to share it." >&2
  exit 1
fi

TMP="$(mktemp -d -t yo-validator-XXXXXX)"
VALIDATOR_PID=""
cleanup() {
  if [[ -n "$VALIDATOR_PID" ]] && kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    kill "$VALIDATOR_PID" 2>/dev/null || true
    wait "$VALIDATOR_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

# Throwaway upgrade authority (= Config admin in the suite). Never printed; deleted on exit.
solana-keygen new --no-bip39-passphrase --silent --force -o "$TMP/upgrade-authority.json" >/dev/null

solana-test-validator \
  --reset \
  --quiet \
  --ledger "$TMP/ledger" \
  --bind-address 127.0.0.1 \
  --rpc-port "$RPC_PORT" \
  --faucet-port "$FAUCET_PORT" \
  --gossip-port "$GOSSIP_PORT" \
  --dynamic-port-range "$DYNAMIC_PORTS" \
  --upgradeable-program "$PROGRAM_ID" "$SO" "$TMP/upgrade-authority.json" \
  >"$TMP/validator.out" 2>&1 &
VALIDATOR_PID=$!

echo "test:validator: waiting for $RPC_URL (ledger in $TMP) ..."
for _ in $(seq 1 120); do
  if ! kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    echo "test:validator: solana-test-validator exited early:" >&2
    tail -n 40 "$TMP/validator.out" >&2 || true
    exit 1
  fi
  if curl -s --max-time 1 "$RPC_URL" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"ok"'; then
    break
  fi
  sleep 0.5
done
curl -s --max-time 1 "$RPC_URL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"ok"' || {
  echo "test:validator: validator not healthy after 60 s" >&2
  tail -n 40 "$TMP/validator.out" >&2 || true
  exit 1
}

cd "$PKG_DIR"
status=0
VALIDATOR_RPC="$RPC_URL" VALIDATOR_ADMIN_KEYPAIR="$TMP/upgrade-authority.json" \
  npx vitest run --config vitest.validator.config.ts "$@" || status=$?
exit "$status"
