# STATUS — D0 (integration pass, 2026-11-08)

> **Merged into the team repo (2026-11-14).** This snapshot was written before the You're On
> monorepo was imported into the team repo, where it now sits at the root (so `cd youre-on` below
> means the repo root). Later decisions are in [`MERGE-PLAN.md`](MERGE-PLAN.md) and rows D8–D15 of
> [`planning/README.md`](planning/README.md). In particular: builds are local Xcode on the lead's
> Mac (not EAS from Linux), the judge uses 12–16 frames plus deterministic checks, and
> `LOCK_MODE=sequential` and APNs are out of demo scope. The rest of this file is unchanged.

State of every TASKS §4.1 D0 task after the six parallel streams and one integration pass.
"Done" means the code and its tests are in the repo and green locally. **PENDING** means the
remaining step is blocked on something external (an account, a key, a phone, devnet SOL).
Nothing has been committed: git has not been run.

## Summary

| Check (repo root unless noted)                                       | Result                                                                            |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `npm run typecheck` (all 5 workspaces)                               | green                                                                             |
| `npm run lint`                                                       | green                                                                             |
| `npm run format:check`                                               | green                                                                             |
| `npm test` with `DATABASE_URL` (local Postgres 17)                   | green: mobile 113, server 142, stage 15, db 10, shared 174                        |
| `npm test` without `DATABASE_URL`                                    | green: the DB suites skip (server 80 passed / 61 skipped, stage 13 / 2, db 1 / 9) |
| `programs/escrow`: `anchor build` (forced rebuild)                   | green, 0 warnings, no stack-offset lines                                          |
| `programs/escrow`: `cargo test`                                      | 58 passed (LiteSVM matrix)                                                        |
| `programs/escrow`: `cargo clippy --all-targets`, `cargo fmt --check` | clean                                                                             |
| `apps/mobile`: `npx expo export --platform ios`                      | bundles (Metro resolves `@youre-on/shared`)                                       |
| `apps/server/scripts/smoke.ts` against a local `tsx src/main.ts`     | all green (health, challenge, signup, login, WS hello→welcome)                    |
| `drizzle-kit check` (local DB)                                       | "Everything's fine"                                                               |

## Per task

| ID                                               | Status                                   | What is done                                                                                                                                                                                                                                                                                                                    | What waits, and on what                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D0-L1 Escrow core                                | **Done**                                 | `Config`/`Bet`/vault, enums, constants, `EscrowError` 6000–6036, `initialize_config`, `update_config`, all boxed. C1–C5 and U1–U10 green.                                                                                                                                                                                       | U3, U6, U7 run only their D0 legs. The rest needs the D1-L1 instructions.                                                                                                                                                                                                                        |
| D0-L2 `create_bet` / `accept_bet`                | **Done** (local)                         | Every check (I2, I3, I13, I15–I17, P3, P9, P10), `emit_cpi!` on each. Program keypair generated (gitignored), `declare_id!` = Anchor.toml = IDL = `FyJQHCE1TBuaCtaueeoSzLDzV5Gns6iUSA7Yd2m8UNvm`. B1–B12, B15–B22, A1–A12 green. IDL in `packages/shared/idl/escrow.json` (matches `target/idl` key for key).                   | **PENDING (devnet SOL, deployer keypair `~/.config/solana/youre-on-deployer.json`)**: deploy, onchain IDL, `init-config`. **Human**: back up `programs/escrow/target/deploy/escrow-keypair.json` to the vault before `target/` is ever wiped. `security.json` still holds template placeholders. |
| D0-L3 Server skeleton                            | **Partial**: code done, deploy PENDING   | Hono, zod env, `/health`, WS hub (per-bet channels, 20 s ping, replay, backpressure), auth (challenge/signup/login/logout), idempotency, rate limits, Drizzle migrations 0000–0002, Dockerfile (image built and smoke-tested with podman by the server stream), `fly.toml`, CI workflow.                                        | **PENDING (Fly + Neon accounts)**: `fly launch`, secrets, deploy, Neon URLs, migrate on Neon. The cellular DoD (`https://<app>.fly.dev/health` from an iPhone, WS round trip) needs Fly and a phone. CI has never run on GitHub (no repo yet).                                                   |
| D0-M1 Mobile config                              | **Partial**                              | SDK 58 pins, dev client, `expo-build-properties` iOS 16.4, bundle ID `dev.youreon.app`, one usage string each, `eas.json` with 3 profiles. `expo-doctor` 20/20.                                                                                                                                                                 | **PENDING (Expo account)**: `eas init` (projectId and owner in app.json).                                                                                                                                                                                                                        |
| D0-M2 Native stack + build #1                    | **Partial**                              | Native stack installed (VisionCamera 5.2.4, face detector + iOS patch, fast-tflite, nitro-modules 0.37.2, LiveKit, ElevenLabs RN, expo-camera, reanimated/worklets). Diagnostics screen with the 8 checks. `scripts/face-model.sh` reproduces the `.tflite` byte for byte (`ca17b05a…`).                                        | **PENDING (Apple Developer + Expo accounts, phones)**: EAS build #1, `eas device:create`, and every diagnostics check green on a device. The Swift patch has never been compiled.                                                                                                                |
| D0-M3 Wallet module                              | **Done** (Node)                          | getRandomValues seed, SecureStore `WHEN_UNLOCKED_THIS_DEVICE_ONLY` without `requireAuthentication`, separate pubkey item, `authorize()` (Face ID → seed → noble sign → wipe), the passcode-fallback logic, serialized create, KEY_MISMATCH guard. The noble PDA helper matches Kit for 20 bet_ids under the pinned `ESCROW_ID`. | **PENDING (phone)**: the passcode fallback on a device, plus timing (warm < 30 ms, cold < 300 ms; D1-M2).                                                                                                                                                                                        |
| D0-M4 Login/signup shell                         | **Partial**                              | Server side complete. Its tests cover the DoD: a valid signature gets a session; a replayed nonce gets 401 `CHALLENGE_EXPIRED`; the wrong key gets 401 `SIGNATURE_INVALID`; no 18+ gets `AGE_REQUIRED`.                                                                                                                         | **Not built**: the mobile screens. `App.tsx` shows only the diagnostics screen, and there is no device-auth-key module or name + 18+ form. This is the next mobile task and needs no external account.                                                                                           |
| D0-J1 Shared schemas                             | **Done** (Node)                          | Every listed schema. The JCS vectors pass: `terms-v1-001` → `05860f0a…f998f`, ruling → `997ce278…5daa`, hearing → `a7721bbc…d368`. NFC and key-order pass; extra-key and non-normalized throw. Hermes `isWellFormed` fallback.                                                                                                  | **PENDING (phone, D1-M4)**: run the vectors on Hermes.                                                                                                                                                                                                                                           |
| D0-J2 ElevenLabs agent + token                   | **Partial**: written, never run for real | `scripts/el-agent.ts` (create/update, `--dry-run`), `POST /v1/voice/tokens`, `POST /el/tools/propose_terms` with the secret header, binding check and audit. Tested against a fake ElevenLabs client.                                                                                                                           | **PENDING-KEY (ElevenLabs key, tool secret, public HTTPS URL = Fly)**: a real run, a second run showing it is a no-op, the desktop conversation reaching `propose_terms` on Fly, and the data-retention setting.                                                                                 |
| D0-J3 Persona, tool schema, guardrails, fixtures | **Partial**                              | Persona, the `propose_terms` LLM projection → `TermsProposal`, the keyword prefilter for the 4 BRIEF 5c categories, 12 fixtures (4 refusals, 2 clarifications) and a fixture runner. Unit tests are green.                                                                                                                      | **PENDING-KEY (Anthropic key)**: the DoD fixture run (8/8 benign, 4/4 refusals, ≤ 2 questions). The async LLM guardrail is not built.                                                                                                                                                            |
| D0-J4 Rooms + challenge API                      | **Done** (local)                         | Rooms create/join (code + `youreon://`)/leave/presence, `room.presence` frames, `POST /v1/bets` (`list`), invite accept/decline, `bet.invited` (seq 1) → `bet.state DRAFTING` (seq 2), outbox `challenge_received`, voice binding + `dynamic_variables`. All DoD tests are green.                                               | `challenge_method:'face'` waits on D4-M1. No push dispatcher yet. The "invite < 1 s on two phones" check is D1-M6 (phones).                                                                                                                                                                      |

## Integration-pass changes

Cross-stream contract checks and the fixes they needed:

- **Signing-policy pins were missing from `packages/shared`.** Added `packages/shared/src/chain/constants.ts` with `ESCROW_ID`, `USDC_MINT_DEVNET`, `TOKEN_PROGRAM_ID`, `SYSTEM_PROGRAM_ID`, the PDA seeds, `NONCE_SEED_PREFIX` and `nonceSeed(k)`. `FEE_PAYER_PUBKEY` is `null` because KP3 does not exist yet (PENDING, needed before preview build #3). `packages/shared/test/chain-constants.test.ts` pins them against `declare_id!`, both Anchor.toml clusters, the IDL address, the IDL seed constants and `constants.rs`.
- **Mobile now uses the shared pins.** `apps/mobile` depends on `@youre-on/shared`, `wallet/pda.ts` imports the seeds from it (no second copy), and the PDA tests run under the real `ESCROW_ID` and `nonceSeed()`.
- **Server.** `env.ts` refuses a `PROGRAM_ID` that differs from `ESCROW_ID`, because phones would refuse every lock. `bets/routes.ts` takes the default mint from the shared pin. The `fly.toml` comment now shows the real program ID.
- **RealtimeEvent union.** It now includes the API-CONTRACT §3.4 extensions: `bet.invite_answered`, `tx.sign_request`, `judge.cue`, `hearing.turn_open`, and `attempt.started` + `recorder_device_id`/`go_at`. Without them, clients following SCHEMAS §10.1 dropped the `judge.cue DECLINED` line. The server's untyped `ExtensionEventInput` escape hatch is removed, so every appended event now type-checks against the union (36 types).
- **Rooms privacy leak.** A member who left a room kept receiving `room.presence`. Added `hub.leaveRoom()`, called from `POST /v1/rooms/:id/leave`. Regression test added and mutation-checked.
- **`@youre-on/shared/idl/escrow.json`** is now an exported subpath, for the Codama step.
- **db enum parity test** now also covers `room_kind` and `challenge_method`.
- **Format and CI.** Prettier now ignores `packages/db/migrations/meta/` (drizzle-kit output), and three files were reformatted. CI's `ts` job gained `lint` and `format:check`. A root `.dockerignore` mirrors `apps/server/Dockerfile.dockerignore`.

Checked with no change needed:

- The 45 error codes and HTTP statuses in `shared/api.ts` match API-CONTRACT §1.5 (checked by script).
- The server imports its schemas from `@youre-on/shared` and defines no wire schemas of its own (`env.ts` is the only local Zod object).
- Onchain enums agree across Rust, the IDL and Zod (`BetStatus`, `Outcome`, instruction names).
- react 19.3.0, zod 4.6.7, @noble/hashes 2.4.0, @noble/ed25519 3.2.0 and @solana/kit 8.6.0 each have a single version across workspaces.
- No `.env`, keypair, PEM or 64-byte key array exists outside gitignored paths. The only keypair, `programs/escrow/target/deploy/escrow-keypair.json`, is under `target/`.
- "spike" appears only in comments that cite FINDINGS.

## How to run each suite

```sh
cd youre-on
docker compose up -d db            # or: podman-compose up -d db  (Postgres 17 on :54329)
export DATABASE_URL=postgres://yo:yo@localhost:54329/youre_on

npm run typecheck && npm run lint && npm run format:check
npm test                           # every workspace; DB suites skip without DATABASE_URL
npm test -w @youre-on/shared       # schemas, JCS vectors, chain pins, judge
npm test -w @youre-on/server       # auth, WS hub, rooms/bets, voice (global-setup migrates DATABASE_URL)
npm test -w @youre-on/db           # migrations, triggers, enum parity
npm test -w @youre-on/mobile       # wallet, PDA vs Kit, diagnostics logic, native config
npm test -w @youre-on/stage
npx tsx apps/server/scripts/smoke.ts http://127.0.0.1:8080   # against a running server

export PATH=$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH
(cd programs/escrow && NO_DNA=1 anchor build && cargo test)   # tests include_bytes! the built .so
(cd apps/mobile && CI=1 npx expo-doctor)
```

## Known risks and open items

- **Spec edits owed** (docs/planning not edited here): ESCROW §9.2 B11 should expect `IncorrectProgramId` (Anchor runs init before constraints), not `ConstraintMintTokenProgram`. §9.2 N8 should expect `InvalidDeadline` at ix 3, not `AcceptDeadlinePassed`. SCHEMAS §10.1 can now say the extensions have joined the union.
- **TypeScript version split.** `apps/mobile` pins `typescript ~6.0.3` and the root pins `~5.9` (5.9.3). Both typecheck clean. Check that Expo SDK 58 needs 6.0 before aligning.
- **Voice binding squat.** `POST /v1/bets` still creates a bound `voice_sessions` row for an unknown conversation id. It should become a 422 once `/v1/voice/tokens` mints for real (PENDING-KEY).
- **No idle-draft sweeper.** An unanswered challenge holds `pair_busy` and counts toward the 3-open-bets cap indefinitely, which is a demo risk until the D1 sweeper lands.
- **`AuthorizeRequest` is strict.** It now requires `expires_at = (accept_deadline − 5) s` and `nonce_index` set iff `atomic_lock`, so LockService (D1) must build requests exactly that way.
- **WS authorization happens only at hello.** Session expiry is not re-checked on an open socket, and device revocation does not close sockets.
- **Body size on tool routes.** A body over 64 KB on `/el/tools/*` gets 413 from the global bodyLimit, while API-CONTRACT §4.2 allows only 401 as a non-2xx.
- **Spoofable client IP.** `Fly-Client-IP` is trusted off Fly, so the per-IP auth bucket can be dodged in dev or through a tunnel.
- **Mutable PDA cache.** The mobile PDA helper's cached byte arrays can be changed by a caller. Return copies when the device policy (D2-L1) is wired up.
- **Escrow test coverage is partly approximate.** The N-row lock tests are LiteSVM approximations. N10, N11 (CU across ≥ 50 bet_ids), N13–N17 and DP1–DP16 still need the local-validator/TS suites and D2-L1. CI must run `anchor build` before `cargo test`.
- **Hermes is unverified.** `String#normalize` and the canonicalize transpile are untested there (D1-M4). Mobile now imports `@youre-on/shared/chain/constants`, which is dependency-free.
- **Large file.** The `.tflite` is 13.6 MB. TASKS §3.2 rule 9 allows it in git, but check the LFS policy before the first commit.
