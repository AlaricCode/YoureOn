# Merge plan: You're On + Verdict

On 2026-11-14 the team combined its two prototypes for the same product into this repo:

- **You're On** (Logan): the Expo iOS app, the Hono + Postgres server, the Anchor escrow and the
  Phase 0 specs in [`docs/planning/`](planning/README.md).
- **Verdict** (Alaric): a Fastify backend, a Flutter app, an onchain rule interpreter, Groth16
  circuits and a product spec. Its specs now live in [`docs/reference/verdict/`](reference/verdict/INDEX.md).
  Its code was removed from the tree in the merge's first commit and stays in git history.

This file records what was decided, what was kept, what was ported and what was dropped. The
binding decisions are also rows D8–D15 in [`docs/planning/README.md`](planning/README.md#decisions-added-2026-11-14-merge).

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Base = You're On.** Its stack and its `docs/planning` contracts win on any conflict. Verdict code is re-implemented in this stack, not copied, and each ported file cites its Verdict source in a header comment.                                                                                                              |
| 2   | **Name = You're On** everywhere in product code and UI. "Verdict" is named only as the source of ported ideas, in comments and docs.                                                                                                                                                                                             |
| 3   | **No voiceprint and no spoken "I accept".** The face scan only finds and addresses the person being challenged. Each person authorizes on their own phone with a hold and Face ID (planning D1, D2).                                                                                                                             |
| 4   | **Judge = Claude on 12–16 frames** clustered at the end of the attempt, plus one landing crop, plus deterministic checks (cap tape visible, bottle at rest). If the model and the deterministic checks disagree, the ruling is REDO. `MAX_REDOS = 2` still applies.                                                              |
| 5   | **SAM 3 is not used for now.** Gated access was approved on 2026-11-14. It is a candidate for a later video-only overlay on disputes, not for the ruling path.                                                                                                                                                                   |
| 6   | **Demo = bottle flip, live, plus the Gemini BTC 5-minute bet.** The BTC bet is locked first and settled at the end of the pitch. The dispute and appeal flow is shown in the video, not live.                                                                                                                                    |
| 7   | **Consent-first settlement.** The loser's GG, or silence until the appeal window closes, settles the bet. The AI panel runs only on a dispute. (From Verdict spec §2, principle 2, "Consent first" ([`verdict-spec.md`](reference/verdict/verdict-spec.md)); it matches You're On's GG / `finalize` path.)                       |
| 8   | **Expo, built locally with Xcode** on the lead's Mac. This replaces the EAS-cloud-from-Linux path in planning D4. Demo phones are still all iPhones.                                                                                                                                                                             |
| 9   | **Providers behind mocks.** LLM, STT and SFX sit behind interfaces with deterministic mocks and default to the mock; any `live` mode refuses to start unless `ALLOW_SPEND=true`. The ElevenLabs Agent token endpoint has no mock and calls ElevenLabs only with `ALLOW_SPEND=true` and `ELEVENLABS_API_KEY` set. (From Verdict.) |
| 10  | **Design system and copy rule from Verdict spec §6.** Monochrome, dark by default, one accent, 8-pt grid, motion ≤ 200 ms. Labels are 1–3 words and nothing has a sentence description under it.                                                                                                                                 |

## Kept from You're On

| Path                    | Status                                                                                                                     | What changes                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/planning/`        | Binding specs (SCHEMAS, API-CONTRACT, DATA-MODEL, ESCROW-PROGRAM, ARCHITECTURE, TASKS, SETUP-CHECKLIST)                    | Decisions D8–D15 appended to the index. The 8-frame judge, EAS-from-Linux, APNs and `LOCK_MODE=sequential` text is superseded by those rows. |
| `programs/escrow`       | `initialize_config`, `update_config`, `create_bet`, `accept_bet` built and tested in LiteSVM; program ID `FyJQHCE1…m8UNvm` | Nothing in this PR. The 8 remaining instructions are next.                                                                                   |
| `packages/shared`       | zod contract, JCS terms hashing, chain pins, judge persona and guardrails                                                  | Gains the shapes the ports need (additive only).                                                                                             |
| `packages/db`           | Drizzle schema and SQL migrations                                                                                          | Gains `chain_events` for the QuickNode receiver.                                                                                             |
| `apps/server`           | Hono server: auth, rooms, bets, WS hub, idempotency, rate limits, ElevenLabs agent tools                                   | Gains the ported provider registry, spend guard, LLM caller, Scribe + SFX, QuickNode receiver and keeper.                                    |
| `apps/mobile`           | Expo SDK 58 app: diagnostics screen, wallet module (Face ID → sign), on-device face model                                  | Gains the device signing policy and design tokens. Screens are next, built to the Flutter screens as a UI spec. Builds move to local Xcode.  |
| `apps/stage`            | Vite stage view with the escrow ticker                                                                                     | Nothing in this PR.                                                                                                                          |
| `scripts/face-model.sh` | Rebuilds the face `.tflite` from the official release (not committed)                                                      | Nothing.                                                                                                                                     |
| `scripts/el-agent.ts`   | Creates or updates the ElevenLabs agent (`--dry-run`)                                                                      | Nothing.                                                                                                                                     |

## Ported from Verdict

| Item                                                                | Verdict source                                                                                                    | Destination                                                                                                                          | Status in this PR |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| Provider registry + deterministic mocks + `ALLOW_SPEND` spend guard | `packages/backend/src/providers/{registry,types,index}.ts`, `providers/mock/`, `config/spend.ts`                  | `apps/server/src/providers/` (`ALLOW_SPEND`, `*_PROVIDER` in `env.ts`)                                                               | In this PR        |
| Multi-vendor LLM caller (Anthropic, OpenAI, Google)                 | `packages/backend/src/providers/real/boothLlm.ts` (`chat()`)                                                      | `apps/server/src/providers/live/llm.ts`, `providers/structured.ts`; non-streaming for now                                            | In this PR        |
| ElevenLabs Scribe (batch STT) + Sound Effects                       | `packages/backend/src/providers/real/elevenlabs.ts`                                                               | `apps/server/src/voice/elevenlabs.ts`, `providers/live/voice.ts`                                                                     | In this PR        |
| QuickNode Streams receiver (HMAC) + `chain_events` + filter         | `packages/backend/src/chain/{quicknode,streams}.ts`, `routes/webhooks.ts`, `infra/quicknode/`                     | `apps/server/src/chain/`, `packages/db/src/schema/chain.ts` + migration `0003_chain_events`, `infra/quicknode/`; projector is a stub | In this PR        |
| Keeper / sweeper (+ the rooms presence-test fix)                    | `packages/backend/src/keeper/keeper.ts`, `persistence/housekeeping.ts` (ideas only)                               | `apps/server/src/keeper/` (first task: draft-idle expiry, SCHEMAS §9.3), `rooms/service.ts`                                          | In this PR        |
| Device signing policy (decode and check before signing)             | `app/lib/wallet/wallet.dart` (`checkTxMessage`)                                                                   | `packages/shared/src/device-policy.ts` (ESCROW-PROGRAM §5.0.2), `apps/mobile/src/wallet/devicePolicy.ts`; no screen calls it yet     | In this PR        |
| Design tokens + copy rule                                           | `app/lib/ui/tokens.dart`, `app/lib/ui/theme.dart`, `app/test/support/copy_rule.dart`, `verdict-spec.md` §6.2–§6.4 | `apps/mobile/src/ui/{tokens,copyRule}.ts` (no screens yet)                                                                           | In this PR        |
| Gemini Prediction Markets service                                   | `packages/backend/src/providers/real/{world,geminiNormalize}.ts`, `providers/mock/gemini.ts`                      | `apps/server`, to ARCHITECTURE §8.4                                                                                                  | Next              |
| Flutter screens as the UI spec                                      | `app/lib/screens/`                                                                                                | `apps/mobile` screens (rebuilt in React Native)                                                                                      | Next              |
| Consent-before-capture enroll (Eva)                                 | branch `enroll-redesign`                                                                                          | `apps/mobile` enroll flow (rebuilt)                                                                                                  | Next              |
| Rule interpreter (Alaric)                                           | `crates/verdict-rules`, [`docs/reference/verdict/CONTRACTS.md`](reference/verdict/CONTRACTS.md) §3                | Roadmap: deterministic rules beyond the bottle flip                                                                                  | Roadmap           |

## Not in this PR (next)

| Item                                                                  | Source                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Escrow's 8 remaining instructions                                     | ESCROW-PROGRAM (You're On)                                                            |
| Judge endpoint                                                        | `youre-on-spikes/02-vision-judge`, re-authored to decision 4 above                    |
| Gemini service                                                        | ARCHITECTURE §8.4, with Verdict's Gemini adapter as reference                         |
| Mobile screens                                                        | SCHEMAS / API-CONTRACT flows, Verdict's Flutter screens as the UI spec                |
| Lock service + nonce pool                                             | ESCROW-PROGRAM §5.0.1–§5.0.3, DATA-MODEL §5.8 / §5.20                                 |
| Chain projector (bet state, payouts, outbox), RPC fallback reconciler | DATA-MODEL §8.2–§8.3; the receiver's stub projector only appends `chain.*` bet events |
| Keeper lock-window, timeout-refund, nonce and outbox sweeps           | ESCROW-PROGRAM §5.0, DATA-MODEL §8; register in `apps/server/src/keeper/index.ts`     |
| Streaming first ruling (2.5 s first-token deadline)                   | API-CONTRACT §7.1; the LLM caller is non-streaming for now                            |

## Dropped

Verdict items stay in git history (`git show 1d9139c:<path>`) and none of them is in the tree. The last three rows are You're On scope cuts.

| Item                                                              | Why                                                                                                                   |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Onchain rule interpreter (`run_rules`, `crates/verdict-rules`)    | The bottle flip needs only a few deterministic checks. Kept on the roadmap (credit Alaric).                           |
| Groth16 circuits (`circuits/`, onchain verify)                    | They prove a biometric match. Under decision 3, a face match never authorizes anything, so there is nothing to prove. |
| SAM 3 perception (`services/perception`)                          | Claude on frames plus deterministic checks is enough for one challenge (decisions 4, 5).                              |
| Voiceprint acceptance                                             | Decision 3: each person authorizes on their own phone.                                                                |
| Server-side face matching (`services/embedder`, identity service) | You're On matches on device, against opted-in members of the same room only.                                          |
| Audio beacon (slot-hash start sound)                              | Freshness is out of scope for a live, filmed demo.                                                                    |
| Multi-phone witnesses (audio, camera hash chains)                 | One judge-cam phone records the attempt.                                                                              |
| Scene check                                                       | Not needed for a fixed bottle-flip setup.                                                                             |
| Advocates and bonds                                               | Disputes use You're On's hearing and three-provider appeal (planning D7).                                             |
| World Mode parlays                                                | The demo has one Gemini bet: BTC 5-minute.                                                                            |
| Fastify backend with JSON-file persistence                        | Replaced by the Hono server on Postgres/Drizzle. The useful modules are ported above.                                 |
| Flutter app                                                       | Replaced by the Expo app. Its screens are kept as the UI spec.                                                        |
| Push-ups, cup tower and paper-ball judging (You're On)            | Dropped from demo scope. The bottle flip is the only live physical challenge.                                         |
| `LOCK_MODE=sequential` (You're On)                                | Dropped from demo scope. The atomic durable-nonce lock (planning D3) is the only path.                                |
| APNs push (You're On)                                             | Dropped from demo scope. Every demo phone has the app open, and the WS hub carries every event.                       |

## Credits

- **Alaric** wrote Verdict. From it we take the consent-first thesis (spec §2.2), the design system
  and copy rule (spec §6), the provider/mock/spend-guard pattern and the modules ported above. His rule
  interpreter is on the roadmap.
- **Eva** built the consent-before-capture enroll flow on Verdict's `enroll-redesign` branch. The
  branch stays as it is, and the flow will be rebuilt in `apps/mobile`.
- **Logan** wrote You're On, the base of this repo.
