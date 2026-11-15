# Measurements

Measured numbers that the planning docs mark PENDING or ESTIMATED. Each section is dated and
names the command that produced it. Re-run a command to refresh its section: append a new dated
section rather than editing an old one.

## 2026-11-15: escrow CU1, N11, N12 and atomic-lock timing (local only)

Toolchain: Anchor 1.2.2, Agave 4.1.2 `solana-test-validator`, npm `litesvm` 1.6.2, `@solana/kit`
8.6.0, the Codama client (`@youre-on/shared/escrow-client`), and `escrow.so` built from branch
`escrow/complete` (program ID `FyJQHCE1TBuaCtaueeoSzLDzV5Gns6iUSA7Yd2m8UNvm`). No devnet was used.

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
