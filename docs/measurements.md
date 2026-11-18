# Measurements

Measured numbers that the planning docs mark PENDING or ESTIMATED. Each section is dated and
names the command that produced it. Re-run a command to refresh its section: append a new dated
section rather than editing an old one.

## 2026-11-15: escrow CU1, N11, N12 and atomic-lock timing (local only)

Toolchain: Anchor 1.2.2, Agave 4.1.2 `solana-test-validator`, npm `litesvm` 1.6.2, `@solana/kit`
8.6.0, the Codama client (`@youre-on/shared/escrow-client`), and `escrow.so` built from branch
`escrow/complete` (program ID `BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp`). No devnet was used.

Commands (from `packages/shared`; set `ESCROW_MEASURE_OUT=<file>` to collect the JSON lines):

- `npm run test:escrow`: TS LiteSVM. CU1 is `test/escrow/cu-budget.test.ts`, and N1 and N12 are
  `test/escrow/atomic-lock.test.ts`.
- `npm run test:validator`: local Agave on rpc 18899. N1, N10 and N11 are
  `test/validator/atomic-lock.validator.test.ts`.

### CU1: compute units per instruction (TS LiteSVM; budget = top of the ESCROW §10.1 estimate)

Each value is one transaction holding only that instruction ("standalone"), or the bundled
`[terminal ix, close_bet]` the server sends.

| Instruction                                     |                                                          CU |                                         §10.1 budget | OK        |
| ----------------------------------------------- | ----------------------------------------------------------: | ---------------------------------------------------: | --------- |
| `initialize_config`                             |                                                      19,495 |                200,000 (no estimate; per-ix default) | yes       |
| `update_config`                                 |                                                       8,631 |                                200,000 (no estimate) | yes       |
| `create_bet` (standalone, sequential fallback)  |                      27,672 / 33,672 (two random `bet_id`s) |                                               55,000 | yes       |
| `accept_bet` (standalone)                       |                                                      18,671 |                                               25,000 | yes       |
| `resolve`                                       |                                                       8,977 |                                               10,000 | yes (90%) |
| `appeal`                                        |                                                       8,479 |                                               10,000 | yes       |
| `resolve_appeal` (standalone)                   |                                               21,814–21,833 |                                               35,000 | yes       |
| `finalize` (standalone)                         |                                               19,473–19,492 |                                               35,000 | yes       |
| `concede` (standalone)                          |                                                      19,793 |                                               35,000 | yes       |
| `timeout_refund` (standalone, from Locked)      |                                                      21,431 |                                               35,000 | yes       |
| `cancel_open_bet` (standalone)                  |                                                      17,189 |                                               35,000 | yes       |
| `close_bet` (standalone)                        |                                                      12,874 |                                               20,000 | yes       |
| `[finalize, close_bet]`                         |                                               32,347–32,366 |                                               55,000 | yes       |
| `[concede, close_bet]`                          |                                                      32,667 |                                               55,000 | yes       |
| `[resolve_appeal, close_bet]`                   |                                                      32,681 |                                               55,000 | yes       |
| `[timeout_refund, close_bet]`                   |                                                      34,298 |                                               55,000 | yes       |
| `[cancel_open_bet, close_bet]`                  |                                                      30,056 |                                               55,000 | yes       |
| `nonce_advance` (revoke)                        |                                                         150 |                           "small" (asserted < 3,000) | yes       |
| **atomic lock** (whole tx, 64 random `bet_id`s) | min 46,793 · p50 48,293–49,793 · max 57,293–60,293 (2 runs) | 80,000 (create + accept budgets; §10.1 says PENDING) | yes       |

`resolve` uses 90% of its 10k estimate. `create_bet` varies by about 1,500 CU for each extra bump
attempt in its `init` PDA searches (Bet and vault), so its CU depends on the `bet_id`. That is
why the lock's CU is a range.

### N11: atomic-lock CU on local Agave (50 random `bet_id`s per run, LockService limit rule)

The rule is limit = max(ceil(simulated × 1.3), floor), and every one of the 150 locks landed
under it. On every lock the executed CU equalled the simulated CU.

| Run              |   n |    min |    p50 |    max | > 60k | limits used   |
| ---------------- | --: | -----: | -----: | -----: | ----: | ------------- |
| 1 (floor 63,100) |  50 | 46,791 | 49,791 | 61,791 |     1 | 63,100–80,329 |
| 2 (floor 68,000) |  50 | 46,791 | 49,791 | 58,791 |     0 | 68,000–76,429 |
| 3 (floor 75,000) |  50 | 46,791 | 49,791 | 58,791 |     0 | 75,000–76,429 |

- **Low cap.** A fresh `bet_id` whose simulated CU is at least the run's max, locked with limit =
  max − 1, is refused at preflight (-32002). Agave logs `exceeded CUs meter at BPF instruction` or
  `Computational budget exceeded`, depending on where the meter runs out. It costs 0 lamports and
  the nonce is unchanged. Run 1: cap 61,790 against a need of 61,791. Run 2: cap 58,790 against
  67,791. Run 3: cap 58,790 against 63,291.
- **Highest lock CU seen: 67,791** (simulated, fresh `bet_id`, run 2). The spike's "a 60k cap
  failed 1 in 20" still holds: 1 lock in 50 went over 60k in run 1.
- **Floor.** Use **75,000** (67,791 + 10%) until devnet numbers exist. The suite now uses it
  (`CU_FLOOR`). The per-lock rule (simulated × 1.3) already covers every observed `bet_id`; the
  floor only protects against an unlucky id that simulation didn't see.
- **Agave vs LiteSVM.** For the same bump path, Agave reports 2 CU less than LiteSVM (46,791 vs
  46,793).

### N12: lock wire size

**1,001 B** of 1,232. This is the full form `[AdvanceNonce, SetComputeUnitLimit,
SetComputeUnitPrice, create_bet, accept_bet]`, v0 with no ALT, 3 signatures and 16 unique keys.
The estimate was ~990–1,005 B (FINDINGS §2.3), which leaves 231 B of headroom. LiteSVM and
Agave give the same value.

### N1 / N10: fees on local Agave

| Case                                                                                                                         | Fee to S                                                                                                            | Nonce                                 |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Clean lock (N1), preflight on                                                                                                | 15,200 = 3 × 5,000 + priority (ceil(200,000 CU × 1,000 µlamports / 1e6) = 200), plus the Bet + vault rent it fronts | advanced                              |
| Doomed lock (N10, `accept_bet` `TermsHashMismatch`), **preflight on**                                                        | **0** (-32002)                                                                                                      | **unchanged**                         |
| Same bytes, **`skipPreflight: true`**                                                                                        | **15,200** (committed with an error)                                                                                | **advanced** (both signatures burned) |
| Held past `accept_deadline` (N8), squat (N13), paused (N14), A's balance drained (N15), revoked nonce (N6); all preflight on | 0 (-32002)                                                                                                          | unchanged                             |
| Revoke (`nonce_advance`, fee payer only)                                                                                     | 5,000                                                                                                               | advanced                              |

**LiteSVM 1.6.2 differs from Agave, and the suites show it.** A durable-nonce transaction that
fails _in execution_ is charged its fee in LiteSVM, but its nonce is **not** advanced. LiteSVM also
has no preflight. ESCROW §9.1 says LiteSVM "doesn't commit failed txs", which is half right: the
fee is committed and the nonce advance is not.

### Atomic-lock timing on local Agave (send → status, polled every 20 ms, 150 locks)

|                    |    min |        p50 |    max |
| ------------------ | -----: | ---------: | -----: |
| send → `processed` | 356 ms | 378–380 ms | 401 ms |
| send → `confirmed` | 359 ms | 399–401 ms | 423 ms |

These figures come from one local node with default 400 ms slots, so they show only the local
slot time, not devnet. The < 2 s target (ESCROW §8.4) still needs the devnet re-run (TASKS §6.2
"Budget" row, D3-L3).

## 2026-11-18: live devnet

The first numbers from the deployed stack: the server on Fly (`youre-on`, https://youre-on.fly.dev,
one machine in `dfw`) with Neon Postgres, against the devnet escrow
`BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp` (Config PDA
`FYF8BZaszwttYxSsnXXdtf75YQUhAMwYDNK73eNzDoz`), deployed from `devnet-launch` at `edc3613`.
Server config from `fly.toml`: `LLM_PROVIDER=live`, `ALLOW_SPEND=true`, `CACHED_RULING=false`,
`JUDGE_MODEL` unset (default `claude-sonnet-5-5`). No QuickNode Stream yet (key pending), so the
chain events reached the server through the `rpc_poll` fallback, over a non-QuickNode devnet RPC.
No iPhone was involved: the iPhone build is pending. The numbers come from the team's live runs;
their exact command lines are not recorded here. The driver for this path is
`npm run cp1-drive -- --base-url https://youre-on.fly.dev --through paid [--gg]`.

### Results

| Measure                        | Result                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| Soak                           | **10/10 runs passed**: 5 settled by `finalize`, 5 by GG (`concede`)                    |
| Terms confirm → `LOCKED`       | **4.0–4.6 s** (n = 11; today's run 4,531 ms)                                           |
| A full bet, end to end         | **18–28 s**: GG about 19 s; finalize about 26 s, which includes the 10 s appeal window |
| Live ruling, Claude Sonnet 5.5 | **2.8–4.0 s** per attempt                                                              |
| Timeout-refund keeper          | Settled a stranded bet on boot                                                         |

- **Confirm → LOCKED is not the BRIEF §6 span.** It starts at the terms confirm, so it includes the
  nonce lease, building and simulating the lock, both signatures, the send and the confirmation.
  The BRIEF §6 target ("second on-phone authorization → lock confirmed < 2 s") needs a phone and is
  still to be measured.
- **Ruling.** The 2.8–4.0 s is the model call per attempt. The BRIEF §6 target (attempt → ruling
  < 4 s) also counts the frame upload from the judge cam, which needs a phone and is not measured
  here.

### Sample transactions (Explorer, devnet)

| What                               | Signature                                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Atomic lock                        | [`3Dq7rQ9h1b1PdVEwfEsQzqT9C2Lc9GXz73zWbqG4eysTJ1bj3CTJyK3E5A4dDfYkKBoLAHWzQmFT51GwmXrHgU9q`](https://explorer.solana.com/tx/3Dq7rQ9h1b1PdVEwfEsQzqT9C2Lc9GXz73zWbqG4eysTJ1bj3CTJyK3E5A4dDfYkKBoLAHWzQmFT51GwmXrHgU9q?cluster=devnet) |
| `resolve`                          | [`4LLGESFAjhRXZ79AgcCBvUuxB4fp91iduMRfshCRR1vAyHy1J637kkBUQBiwybJUgJ2vEx8EvNrCdFkbcTsKVvft`](https://explorer.solana.com/tx/4LLGESFAjhRXZ79AgcCBvUuxB4fp91iduMRfshCRR1vAyHy1J637kkBUQBiwybJUgJ2vEx8EvNrCdFkbcTsKVvft?cluster=devnet) |
| `finalize`                         | [`3AzeFcB97yfdUWDeM4VCodbb7n8ktgo6MHkkxgJU27dt2vC9c53uscZdA85ZMgppc8fzEdfPncNaWrbPdGKUhUFg`](https://explorer.solana.com/tx/3AzeFcB97yfdUWDeM4VCodbb7n8ktgo6MHkkxgJU27dt2vC9c53uscZdA85ZMgppc8fzEdfPncNaWrbPdGKUhUFg?cluster=devnet) |
| `timeout_refund` (keeper, on boot) | [`2dvcUpmFNiE76aRqRoGCUKrLTAYywAfFSkuZnkEQKP6CVyTVYnHMj53HXa2egLnY42U7sQqhgoLq5WqFC2JxmXzx`](https://explorer.solana.com/tx/2dvcUpmFNiE76aRqRoGCUKrLTAYywAfFSkuZnkEQKP6CVyTVYnHMj53HXa2egLnY42U7sQqhgoLq5WqFC2JxmXzx?cluster=devnet) |

### Program build

`programs/escrow/target/deploy/escrow.so` from the lead's `anchor build` has sha256
`826f0874b350743c8f6fcd99f2bd57bc472b618e8a5846593fb26e9843b9e67a` (446,552 bytes), the same as
the deployed program. Rebuilt from `edc3613` in a separate worktree with
`cargo build-sbf --arch v3 --tools-version v1.57` (cargo-build-sbf 4.0.0, platform-tools v1.57,
Rust 1.89.0, macOS arm64): the same sha256, byte for byte. With the defaults (`--arch v0`,
platform-tools v1.53) the bytes differ, so pass both flags (`anchor build` does).

### Test counts at `edc3613`

| Suite                                                          | Count                                |
| -------------------------------------------------------------- | ------------------------------------ |
| Server (`npm test -w @youre-on/server`)                        | 658                                  |
| Mobile (`npm test -w @youre-on/mobile`)                        | 827, 1 skipped                       |
| Shared (`npm test -w @youre-on/shared`)                        | 259                                  |
| Database (`npm test -w @youre-on/db`)                          | 26                                   |
| Escrow, TS LiteSVM (`npm run test:escrow -w @youre-on/shared`) | 23, 1 skipped                        |
| Escrow, Rust LiteSVM matrix (`cargo test`)                     | 167                                  |
| Stage (`npm test -w @youre-on/stage`)                          | TBD: the stage suite is being merged |

Re-run on branch `docs/submission` (at `edc3613`, local Postgres 17, the `escrow.so` above): server
658, shared 259, db 26, escrow TS 23 + 1 skipped, Rust matrix 167, all green. Mobile gave 826 + 2
skipped there, because that checkout has no face-model `.tflite` (gitignored; `scripts/face-model.sh`
rebuilds it), so the model test skips too; with the model present it is 827 + 1 skipped.

### Beat 6 (Gemini BTC 5-minute closer)

Live on 2026-11-18 against the deployed server (`npm run cp1-drive -- --base-url https://youre-on.fly.dev --market down --amount 2 --through paid`):

- Contract `BTC05M2611180835` (expiry 08:35 UTC). A quoted DOWN at 0.53 (Gemini mid): stakes A $1.88 / B $2.12. Binding snapshot sha256 `ec5b7cd8a6626b1f580bc68c69c9d7f1401bd9fb6d13f6ba238f7921016eea2d`.
- Confirm → `AWAITING_MARKET` (locked) in 4537 ms. Lock: [`4t9wP5ht…`](https://explorer.solana.com/tx/4t9wP5htPThcqYT6riWpbkqJA2zxuTEWcTq7ALVA5oVxFKrVgpYEvFEg3M8a1Nz9Ejd2LFkRXrGQjMTBdPKRpLkE?cluster=devnet).
- Gemini settled DOWN: BTC 64,665.71 below the 64,684.59 line. The settlement ruling (`rule/gemini-settlement@1`, A_WINS) went on chain with evidence hash `ca291532…`. Resolve: [`5v68hm8p…`](https://explorer.solana.com/tx/5v68hm8pRofXZDcGvjPyksmMuSPCTBwewxJFB29zHFUSnQivHXUSgu5FX4BfPDB5eqPsYvrhPrQDS9WypCeBzax5?cluster=devnet).
- After the 10 s appeal window: finalize, PAID to A. Finalize: [`3vjg2iMd…`](https://explorer.solana.com/tx/3vjg2iMdkEKZaaQryi93DLKz1hWb7oK3MVc4foCUVKKXgeNvct21BUKPHYf5jtZd1HvDmRPkjMCqmgXQRHcNTzWt?cluster=devnet).

### Beat 5 (appeal, live devnet)

2026-11-18, `npm run cp1-drive -- --base-url https://youre-on.fly.dev --through paid --appeal`, with the runtime cached ruling switched on for a decisive B_WINS (`POST /v1/demo/toggles`), then off again:

- Lock in 5638 ms. The cached ruling B_WINS resolved on chain. A appealed inside the 10 s window: [`4d53oi6F…`](https://explorer.solana.com/tx/4d53oi6F9qc6gWk1xtKV2xynsbJwbMoGdfwFThj8x9mx6uTFBjzcwXjpQrXpP331APbMEZFc9NwcnTNRm6FRBhFe?cluster=devnet).
- Panel: the Claude seat (Opus 5.5) answered REDO in 2986 ms on the synthetic frames (counted as an abstention); the OpenAI and Google seats abstained (no keys on the server). No majority, so the ruling stood.
- `resolve_appeal` paid B: [`4XevQ7To…`](https://explorer.solana.com/tx/4XevQ7TodjnCFN6kQXN7UpPPe6czky2Xe9st1kdR9qzjCuuNAV36dPQgw63c5mpiy6rQwyb1LmJU9QaKSyTLarJm?cluster=devnet).
