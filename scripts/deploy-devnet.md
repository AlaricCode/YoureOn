# Devnet deploy runbook (ESCROW §10.3 steps 1–12; TASKS D1-L3, D1-L5, D1-L6)

The exact sequence a human runs to put the escrow on devnet, using the scripts in this folder.
Every script takes `--url` (default: env `SOLANA_RPC_URL`; there is no other default) and
`--keys-dir` (default `~/.config/solana/youre-on/`). Scripts print an RPC URL as `scheme://host/…`
only, and refuse mainnet-beta (detected by genesis hash).

| Script            | npm                           | What it does                                                                                                           |
| ----------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `keys.ts`         | `npm run keys -- --dir <dir>` | Creates the missing role keypairs (never overwrites), chmod 600, prints pubkeys only                                   |
| `init-config.ts`  | `npm run init-config`         | `initialize_config` with the §3.1 demo values; idempotent                                                              |
| `check-config.ts` | `npm run check-config`        | Reads Config and checks it against the demo values (D1-L3 DoD)                                                         |
| `nonce-pool.ts`   | `npm run nonce-pool`          | The 5 lock nonces at `createWithSeed(fee payer, "yo-nonce-<k>")`; prints addresses + values; optional `--database-url` |
| `fund.ts`         | `npm run fund`                | Treasury USDC → wallets up to $40 each; the fee payer creates ATAs and pays fees                                       |
| `smoke-devnet.ts` | `npm run smoke-devnet`        | Atomic lock → resolve → `[finalize, close_bet]`, timings, Explorer links, 0-lamport party check                        |
| `e2e-local.sh`    | `npm run e2e:local`           | All of the above against a throwaway local `solana-test-validator`                                                     |

**Rehearse first:** `npm run e2e:local` (needs `programs/escrow/target/deploy/escrow.so`). It
uses ports 28899/28900 (RPC/WS), 29900 (faucet), 28001 (gossip) and 28100–28200, a temp ledger and
temp keys, and kills the validator on exit.

## What a human must fund (agents never use a faucet)

| Who       | Amount             | From                                                             | Why                                                                                                                                                                |
| --------- | ------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| deployer  | ≈ 5 SOL            | bank wallet (SETUP-CHECKLIST KP0)                                | the 446 KB `.so` needs ≈ 2 × size × 5,080 lamports/B ≈ 4.5 SOL while the buffer exists (the buffer half is refunded), + Config rent 0.0027 SOL + IDL metadata rent |
| fee payer | 2 SOL              | bank wallet                                                      | every tx fee, bet rent float (returned on close), the nonce pool (5 × 0.00106 SOL); alert below 1 SOL                                                              |
| treasury  | ≥ $160 devnet USDC | [faucet.circle.com](https://faucet.circle.com) → "Solana Devnet" | 20 USDC per 2 h **per address**: start early, and you may also request straight to each phone wallet and demo wallet (then `fund.ts` only tops up the gap)         |

Judge, appeal, treasury and every party wallet hold **0 SOL**. Never send SOL to a party wallet.

## 0. Shell setup (every session)

```bash
cd UBC-2026
read -rs SOLANA_RPC_URL && export SOLANA_RPC_URL   # paste the QuickNode devnet HTTPS URL; no echo, no history
export ANCHOR_PROVIDER_URL="$SOLANA_RPC_URL"
KEYS=~/.config/solana/youre-on                       # or pass --keys-dir everywhere
```

## 1. Keys and Solana CLI config

```bash
npm run keys                                   # creates $KEYS/<role>-keypair.json, prints pubkeys
solana config set --url "$SOLANA_RPC_URL" --keypair "$KEYS/deployer-keypair.json"
```

Roles: `deployer` (upgrade authority = Config admin; password manager only, never Fly), `fee-payer`,
`judge`, `appeal`, `treasury`, `demo-a`, `demo-b`. Now:

- fund the deployer and the fee payer from the bank wallet (table above);
- pin the fee-payer pubkey in `packages/shared/src/chain/constants.ts` (`FEE_PAYER_PUBKEY`) before
  preview build #3 (TASKS D1); phones verify the nonce pool from it.

The program keypair (`programs/escrow/target/deploy/escrow-keypair.json`, program ID
`BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp`) already exists; never regenerate, copy or commit it.

## 2. Build and test

```bash
cd programs/escrow
anchor build                  # any "Stack offset exceeded" warning is an error
cargo test                    # the whole LiteSVM matrix must be green
cd ../..
npm run codama -- --check     # IDL copy + generated client match the build
```

## 3. Deploy

```bash
cd programs/escrow
anchor deploy --provider.cluster "$SOLANA_RPC_URL" --provider.wallet "$KEYS/deployer-keypair.json"
```

Anchor 1.2.2 `deploy` also uploads the IDL by default (`--no-idl` to skip; then do step 4). Retry
path under devnet load (resumes from a buffer):

```bash
solana program deploy target/deploy/escrow.so \
  --program-id target/deploy/escrow-keypair.json \
  --upgrade-authority "$KEYS/deployer-keypair.json" \
  --keypair "$KEYS/deployer-keypair.json" \
  --url "$SOLANA_RPC_URL" --with-compute-unit-price 1000 --use-rpc
```

Check: `solana program show BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp` shows the deployer as
authority.

## 4. Publish the IDL

Anchor 1.2.2's `anchor idl` stores the IDL through the **Program Metadata** program (the old
Anchor IDL account protocol moved to `anchor legacy-idl`, deprecated). Skip `init` if step 3
already uploaded it.

```bash
anchor idl init    -f target/idl/escrow.json BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp \
  --provider.cluster "$SOLANA_RPC_URL" --provider.wallet "$KEYS/deployer-keypair.json"
anchor idl upgrade -f target/idl/escrow.json BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp \
  --provider.cluster "$SOLANA_RPC_URL" --provider.wallet "$KEYS/deployer-keypair.json"   # later changes
anchor idl fetch BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp --provider.cluster "$SOLANA_RPC_URL"  # verify
cd ../..
```

Not exercised locally: `solana-test-validator` does not ship the Program Metadata program.

## 5. Client

```bash
npm run codama -- --from-target   # copies target/idl/escrow.json into packages/shared/idl/ and regenerates
```

Commit the IDL and `packages/shared/src/chain/generated/` together.

## 6. security.json (optional, P1)

Fill `programs/escrow/security.json` (team contact, repo) **before step 3** and add
`--security-metadata` to that `anchor deploy` (Anchor 1.2.2 uploads it on-chain after the deploy).

## 7. Config

```bash
npm run init-config               # admin = deployer, judge/appeal from $KEYS, mint = devnet USDC
npm run check-config              # D1-L3 DoD: prints the demo values read from devnet, exit 0
```

Demo values (ESCROW §3.1): `max_stake` 20,000,000 ($20), `appeal_window_secs` 10,
`accept_deadline_secs` 600, `resolve_deadline_secs` 3600, `appeal_resolve_secs` 300,
`allowed_mints` [devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`]. Re-running
`init-config` reports the existing Config instead of failing. Record the printed Config PDA.

## 8. Fly secrets and USDC

Set the server secrets from the key files without echoing them (`fly secrets import` reads
`NAME=VALUE` lines from stdin; the server accepts the solana-keygen JSON form):

```bash
{
  printf 'FEE_PAYER_SECRET_KEY=%s\n'        "$(tr -d '\n' < "$KEYS/fee-payer-keypair.json")"
  printf 'JUDGE_AUTHORITY_SECRET_KEY=%s\n'  "$(tr -d '\n' < "$KEYS/judge-keypair.json")"
  printf 'APPEAL_AUTHORITY_SECRET_KEY=%s\n' "$(tr -d '\n' < "$KEYS/appeal-keypair.json")"
  printf 'TREASURY_SECRET_KEY=%s\n'         "$(tr -d '\n' < "$KEYS/treasury-keypair.json")"
} | fly secrets import
```

Never set the deployer key as a Fly secret. Then get devnet USDC to the treasury (faucet table
above) and top up the wallets (D1-L6):

```bash
npm run fund -- --dry-run                                    # plan: who needs what
npm run fund                                                 # demo-a + demo-b to $40
npm run fund -- --wallet <phone A pubkey> --wallet <phone B pubkey>   # the phones' device wallets
```

`fund` logs each balance after, and warns when a party wallet holds any SOL.

## 9. Nonce pool

```bash
npm run nonce-pool                                           # prints k, seed, address, value
npm run nonce-pool -- --database-url "$DATABASE_URL"         # also upserts nonce_pool rows (DATA-MODEL §5.20)
```

Creates `yo-nonce-0` … `yo-nonce-4` (authority = fee payer) or verifies the existing ones. With
`--database-url` it upserts the rows if the `nonce_pool` table exists, else prints the SQL. The
server's boot reconcile re-reads all of them.

## 10. QuickNode Stream

Point the Stream filter at the program ID (D1-L4, `scripts/qn-stream.ts` and the Streams doc).

## 11. Smoke

```bash
npm run smoke-devnet                                         # chain only
npm run smoke-devnet -- --database-url "$DATABASE_URL"       # + waits for the 5 chain_events rows (Stream -> webhook)
```

Uses nonce `k=4` by default (`--nonce-index`); with `--database-url` it refuses a nonce that is not
`free` in `nonce_pool`. It asserts both party wallets hold 0 lamports before and after, the payout
(A wins by default, `--winner b`), and the five events `BetCreated, BetAccepted` (one lock tx),
`BetResolved`, `BetFinalized, BetClosed`. Paste the program ID, Config PDA and the printed Explorer
links (`?cluster=devnet`) into the README, and the send → processed → confirmed timings into
`docs/measurements.md` (FINDINGS §6 step 5).

## 12. Verifiable build (optional, P2)

`anchor build --verifiable`, then `anchor deploy --verifiable …` and `solana-verify` for the
Explorer "verified" badge.

## Upgrades

```bash
cd programs/escrow && anchor build
anchor upgrade target/deploy/escrow.so --program-id BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp \
  --provider.cluster "$SOLANA_RPC_URL" --provider.wallet "$KEYS/deployer-keypair.json"
anchor idl upgrade -f target/idl/escrow.json BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp \
  --provider.cluster "$SOLANA_RPC_URL" --provider.wallet "$KEYS/deployer-keypair.json"
```

Re-run the full matrix and `npm run smoke-devnet` after every upgrade. A Bet layout change drops
open devnet bets: only before the demo freeze.
