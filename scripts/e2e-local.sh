#!/usr/bin/env bash
# Local end-to-end proof of the deploy tooling (ESCROW §10.3 steps 7-11, TASKS D1-L3/L5/L6) on a
# throwaway solana-test-validator. LOCAL ONLY: no devnet, no faucet other than the local one.
#
#   npm run e2e:local                          (needs programs/escrow/target/deploy/escrow.so)
#   KEEP=1 npm run e2e:local                   keep the temp dir (keys, ledger, logs) for inspection
#   E2E_DATABASE_URL=postgres://... npm run e2e:local
#                                              LOCAL db only: nonce-pool upserts nonce_pool rows (or
#                                              prints the SQL) and the smoke waits for its 5
#                                              chain_events rows (something must write them locally)
#
# Steps: temp keys -> validator with the escrow loaded upgradeable (authority = the temp deployer)
# -> local airdrops to deployer + fee payer -> a 6-dp local SPL mint standing in for USDC, minted to
# the treasury -> keys (rerun: refuses to overwrite) -> init-config (twice: idempotent) ->
# check-config -> nonce-pool (twice) -> fund -> smoke-devnet -> CR1: crank-fixture (expired Locked,
# Open and Resolved bets) -> crank.ts with a fresh locally-airdropped key -> verify (all closed,
# payouts exact, rent -> fee payer). The validator dies on exit (trap).
#
# Ports (override via env): RPC 28899 (+ websocket 28900), faucet 29900, gossip 28001,
# dynamic range 28100-28200.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC_PORT="${RPC_PORT:-28899}"
FAUCET_PORT="${FAUCET_PORT:-29900}"
GOSSIP_PORT="${GOSSIP_PORT:-28001}"
DYN_RANGE="${DYN_RANGE:-28100-28200}"
SO="${ESCROW_SO:-$ROOT/programs/escrow/target/deploy/escrow.so}"
PROGRAM_ID="FyJQHCE1TBuaCtaueeoSzLDzV5Gns6iUSA7Yd2m8UNvm"
URL="http://127.0.0.1:${RPC_PORT}"

[[ -f "$SO" ]] || { echo "missing $SO (cd programs/escrow && anchor build)"; exit 2; }
WORK="$(mktemp -d -t yo-e2e-XXXXXX)"
KEYS="$WORK/keys"
VALIDATOR_PID=""

cleanup() {
  local code=$?
  if [[ -n "$VALIDATOR_PID" ]] && kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    kill "$VALIDATOR_PID" 2>/dev/null || true
    wait "$VALIDATOR_PID" 2>/dev/null || true
    echo "validator stopped"
  fi
  if [[ "${KEEP:-0}" == "1" ]]; then echo "kept $WORK"; else rm -rf "$WORK"; fi
  exit "$code"
}
trap cleanup EXIT INT TERM

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
cd "$ROOT"

step "keys (temp dir)"
npx tsx scripts/keys.ts --dir "$KEYS"
DEPLOYER="$(solana-keygen pubkey "$KEYS/deployer-keypair.json")"
FEE_PAYER="$(solana-keygen pubkey "$KEYS/fee-payer-keypair.json")"
TREASURY="$(solana-keygen pubkey "$KEYS/treasury-keypair.json")"

step "solana-test-validator on $URL (escrow upgradeable, authority $DEPLOYER)"
cp "$SO" "$WORK/escrow.so" # snapshot: a concurrent anchor build can't change it under the validator
solana-test-validator \
  --ledger "$WORK/ledger" --reset --quiet \
  --bind-address 127.0.0.1 \
  --rpc-port "$RPC_PORT" --faucet-port "$FAUCET_PORT" --gossip-port "$GOSSIP_PORT" \
  --dynamic-port-range "$DYN_RANGE" \
  --upgradeable-program "$PROGRAM_ID" "$WORK/escrow.so" "$DEPLOYER" \
  >"$WORK/validator.log" 2>&1 &
VALIDATOR_PID=$!
for i in $(seq 1 120); do
  if solana -u "$URL" -k "$KEYS/deployer-keypair.json" slot >/dev/null 2>&1; then break; fi
  kill -0 "$VALIDATOR_PID" 2>/dev/null || { echo "validator died:"; tail -50 "$WORK/validator.log"; exit 1; }
  sleep 0.5
  [[ $i == 120 ]] && { echo "validator did not start"; exit 1; }
done
SOL=(solana -u "$URL" -k "$KEYS/deployer-keypair.json")
"${SOL[@]}" program show "$PROGRAM_ID"

step "local airdrops (deployer 10 SOL, fee payer 5 SOL; local faucet only)"
"${SOL[@]}" airdrop 10 "$DEPLOYER" >/dev/null
"${SOL[@]}" airdrop 5 "$FEE_PAYER" >/dev/null
echo "deployer $("${SOL[@]}" balance "$DEPLOYER"), fee payer $("${SOL[@]}" balance "$FEE_PAYER")"

step "local 6-dp SPL mint standing in for devnet USDC; 200 to the treasury"
solana-keygen new --no-bip39-passphrase --silent --force -o "$WORK/mint-keypair.json" >/dev/null
MINT="$(solana-keygen pubkey "$WORK/mint-keypair.json")"
SPL=(spl-token -u "$URL" --fee-payer "$KEYS/deployer-keypair.json")
"${SPL[@]}" create-token --decimals 6 --mint-authority "$KEYS/deployer-keypair.json" --enable-freeze "$WORK/mint-keypair.json" >/dev/null
"${SPL[@]}" create-account "$MINT" --owner "$TREASURY" >/dev/null
"${SPL[@]}" mint "$MINT" 200 --recipient-owner "$TREASURY" --mint-authority "$KEYS/deployer-keypair.json" >/dev/null
echo "mint $MINT"

export SOLANA_RPC_URL="$URL"
COMMON=(--keys-dir "$KEYS")

step "keys again (must keep every existing file)"
npx tsx scripts/keys.ts --dir "$KEYS"

step "init-config"
npx tsx scripts/init-config.ts "${COMMON[@]}" --mint "$MINT"
step "init-config again (idempotent)"
npx tsx scripts/init-config.ts "${COMMON[@]}" --mint "$MINT"

step "check-config"
npx tsx scripts/check-config.ts "${COMMON[@]}" --mint "$MINT"

step "nonce-pool"
npx tsx scripts/nonce-pool.ts "${COMMON[@]}" ${E2E_DATABASE_URL:+--database-url "$E2E_DATABASE_URL"}
step "nonce-pool again (idempotent)"
npx tsx scripts/nonce-pool.ts "${COMMON[@]}" >/dev/null && echo "ok: nothing to create"

step "fund (to \$40)"
npx tsx scripts/fund.ts "${COMMON[@]}" --mint "$MINT"

step "smoke-devnet (local)"
npx tsx scripts/smoke-devnet.ts "${COMMON[@]}" --mint "$MINT" \
  ${E2E_DATABASE_URL:+--database-url "$E2E_DATABASE_URL" --db-wait "${E2E_DB_WAIT:-30}"}

step "CR1 (local): server stopped, expired bets, the permissionless crank with a fresh key"
npx tsx scripts/crank-fixture.ts setup --state "$WORK/crank-state.json" "${COMMON[@]}" --mint "$MINT"
solana-keygen new --no-bip39-passphrase --silent --force -o "$WORK/crank-keypair.json" >/dev/null
"${SOL[@]}" airdrop 1 "$(solana-keygen pubkey "$WORK/crank-keypair.json")" >/dev/null # local faucet
npx tsx scripts/crank.ts --payer "$WORK/crank-keypair.json" --dry-run
npx tsx scripts/crank.ts --payer "$WORK/crank-keypair.json"
npx tsx scripts/crank-fixture.ts verify --state "$WORK/crank-state.json" "${COMMON[@]}" --mint "$MINT"
step "crank again (nothing due)"
npx tsx scripts/crank.ts --payer "$WORK/crank-keypair.json"

step "e2e OK"
