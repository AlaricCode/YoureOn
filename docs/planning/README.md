Status: DRAFT — Phase 0 planning written 2026-11-08 (before the build window). Re-author into the repo during the window; if committed verbatim, commit it as 'docs: import Phase 0 planning (written pre-window)'.

# You're On: Phase 0 planning index

**UBC 2026.** Tracks: Consumer Apps, plus Best use of Solana. Bounties: ElevenLabs, QuickNode Streams, Gemini Prediction Markets.
- **Build window:** Fri 2026-11-13 18:00 UTC → Fri 2026-11-20 18:00 UTC (12:00 PM CST at both ends).
- **Finals:** in person at UT Austin, Sat 2026-11-21 (5 min pitch + 2 min Q&A).
- **Team:** three people. L = lead engineer, E2 = iOS app, E3 = judge, voice, markets and stage (TASKS §1.1).

## Summary (one screen)

- **What this folder is.** It holds eight planning docs, the requirements matrix (TRACEABILITY.md) and this index. It holds no code: code blocks are interface specs to re-author in the repo. Measured numbers and pinned versions live in `../youre-on-spikes/FINDINGS.md` (§3 stack, §4 risks, §5 costs, §6 pending steps).
- **Consistency.** All eight docs were reconciled on 2026-11-08 against D1–D7 and FINDINGS.
  - Names match across docs.
  - Each kind of thing has one owner: SCHEMAS (types), ESCROW-PROGRAM (onchain), DATA-MODEL (tables), API-CONTRACT (endpoints, events, voice tools), SETUP-CHECKLIST §7 (env var names).
- **The lock is atomic everywhere (D3).** No doc keeps the two-transaction lock as the default. `LOCK_MODE=sequential` survives only as a fallback switch.
- **Start here:** the decisions table, then your role's reading order, then the open questions.
- **Today's human to-dos** (SETUP-CHECKLIST §6):
  - Apple Developer enrollment.
  - Register the 4 iPhones, by Tue Nov 10 18:00 UTC at the latest.
  - Devnet SOL into a human-held bank wallet.
  - Film the 20 judge-cam clips.
  - Approve or decline the paid items.

## Decisions in force

| # | Decision | Since | Where it's applied |
|---|---|---|---|
| D1 | **No handshake.** Face identification only finds and addresses the person being challenged and sends them the request. A face match never authorizes anything. | 2026-11-07 (brief amendment) | SCHEMAS §9, DATA-MODEL D7/D9, API-CONTRACT §2.4, ARCHITECTURE §3.1 |
| D2 | **On-phone authorization.** Both phones show the same terms card. Each party holds to confirm, then passes Face ID (`authenticateAsync`, `deviceOwnerAuthentication`: Face ID, then passcode). That unlocks the device key and signs. The seed sits in `expo-secure-store` **without** `requireAuthentication`. The passcode fallback is allowed and the method is recorded (`faceid_hold`/`passcode_hold`, detected with two calls). | 2026-11-07; passcode and method rule 2026-11-08 | SCHEMAS O8, ESCROW §5.0, API-CONTRACT §2.8, ARCHITECTURE §3.3 |
| D3 | **Atomic lock.** One server-built transaction `[AdvanceNonce, ComputeBudget, create_bet, accept_bet]`, signed by A, B and the fee payer.<br>• The fee payer is also the nonce authority (the server hot key), and the durable nonce comes from a 5-account pool.<br>• Both phones sign the same bytes, in either order. The server submits once, at the second authorization, with preflight ON.<br>• A decline or an expiry advances the nonce. Nothing moves unless both sign. | 2026-11-08 | ESCROW §5.0.1–§5.0.3, SCHEMAS §9/§9.4, DATA-MODEL §5.8/§5.20, API-CONTRACT §2.8/§6 |
| D4 | **iOS only.** All demo phones are iPhones: 3 for the demo plus 1 non-demo phone for the Face ID reset test. Builds run in EAS cloud from Linux (there is no Mac), under the Apple Developer Program, with APNs. | 2026-11-07 | FINDINGS §3.15, SETUP-CHECKLIST A1–A5, TASKS §4.0 |
| D5 | **API keys arrive later or during the window.** Every number that depends on a key stays PENDING. | 2026-11-08 | Every doc's PENDING labels; TASKS §2.2 key gates |
| D6 | **Voice topology** (FINDINGS §3.10).<br>• One long-lived ElevenLabs Agent session per bet, on A's phone, on speakerphone.<br>• A spoken "accept" is theatre only.<br>• Webhook tools: `propose_terms`, `confirm_terms`, `open_hearing`, `file_appeal`, `get_market_odds`. Client tools: `request_attempt`, `show_terms_card`, `cue`.<br>• There is no `ask_clarification`, `lock_bet` or `issue_ruling` tool.<br>• Server results reach the judge as `judge.cue`, which becomes `sendUserMessage("[EVENT] …")`. | 2026-11-08 | API-CONTRACT §4, SCHEMAS §3/§9.2, ARCHITECTURE §3.2 |
| D7 | **Rulings.**<br>• A Ruling commits to the exact frames the model saw (`frame_hashes`). Example hashes were recomputed: `997ce278…5daa` and `a7721bbc…d368`.<br>• An appeal with no majority upholds the original ruling.<br>• Gemini bets keep the 10 s appeal window, with the GG prompt.<br>• `MAX_REDOS = 2`, then HEARING. | 2026-11-08 | SCHEMAS O3/O6/O7/X18, DATA-MODEL §5.13, API-CONTRACT §2.9/§7 |

## What we're building and how (10 lines)

1. **The app.** You're On is an iPhone app for betting friends on anything, settled by an AI judge. Users never see crypto: money shows in dollars, and there are no seed phrases or gas fees.
2. **Beat 1, challenge by face.** Point the camera at a friend. An on-device embedding is matched only against opted-in members of the same room, and a match only addresses the challenge (D1).
3. **Beat 2, terms by voice.** An ElevenLabs Agent on A's phone negotiates the bet. Its `propose_terms` webhook lets the server compose the binding `Terms` and set `terms_hash = sha256(JCS(Terms))`.
4. **Beat 3, lock it in.** Both phones show one terms card. Each person holds and passes Face ID to sign the same atomic durable-nonce transaction, and the second signature submits it (D2, D3).
5. **The escrow.** An Anchor 1.2.2 program on devnet holds the stakes in a PDA-owned vault of Circle devnet USDC.
   - It pays out only to the two parties, caps stakes at $20, and gives every state a permissionless timeout.
   - The server is the fee payer and can never choose where money goes.
6. **Beat 4, the attempt.** The judge-cam iPhone records and extracts 8 frames, and Claude returns `claim_result`.
   - Confidence below 0.8 means REDO, with at most 2 REDOs.
   - Then `resolve` opens a 10 s window, followed by GG or `finalize`.
   - The payout animation fires at `processed`.
7. **Beat 5, dispute.** A 10 s-per-side hearing happens before `resolve`. After it, the loser can appeal to three providers in parallel (Anthropic, OpenAI, Google), and no majority upholds the ruling.
8. **Beat 6, the closer.** Gemini's BTC 5-minute market sets fair stakes from the mid price, bound into the terms. Its settled result is the evidence. There is no key and no trading.
9. **Two lanes.**
   - The server's own `signatureSubscribe` drives the UX.
   - The QuickNode Stream webhook carries the decoded `emit_cpi!` events. It is the source of truth for money moving, and it feeds the stage view.
10. **Stack** (FINDINGS §3 has the exact pins):
    - Expo SDK 58 dev builds via EAS;
    - a Hono server on one Fly `dfw` machine;
    - Neon Postgres and Tigris/R2;
    - `@solana/kit` + Codama, with noble ed25519 on the phone.

## The documents

| Doc | What it owns | Size |
|---|---|---|
| [BRIEF.md](BRIEF.md) | The lead engineer's brief, with the 2026-11-07 AMENDMENT. **Read-only.** | 356 lines, 19 KB |
| [SCHEMAS.md](SCHEMAS.md) | Every JSON shape and Zod type: Terms and hashing, rulings, hearing, appeals, Gemini fair stakes, `BetState`, `AuthorizeRequest`/`PartyAuthorization`, realtime events (§10) | 1,791 lines, 138 KB |
| [ESCROW-PROGRAM.md](ESCROW-PROGRAM.md) | The Anchor program: accounts, instructions, the atomic lock composition (§5.0.1), the device signing policy (§5.0.2), events, errors, threat model, test matrix (N1–N17, DP1–DP16), keys and deploy | 1,655 lines, 162 KB |
| [DATA-MODEL.md](DATA-MODEL.md) | Postgres tables and enums, the onchain ↔ DB projection, `chain_txs` lock rows, `nonce_pool`, `api_sessions`, idempotency, evidence storage, biometric handling, seed data | 1,439 lines, 121 KB |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Components, deployment and keys, one sequence diagram per beat, the latency budget, the realtime model, trust boundaries, failure modes and demo mode, the sponsor map, the README skeleton (§9) | 971 lines, 84 KB |
| [API-CONTRACT.md](API-CONTRACT.md) | REST endpoints, the WebSocket and event catalogue (§3.4), the ElevenLabs tool contract (§4), the QuickNode receiver (§5), Solana tx contracts and phone checks (§6), internal model calls, and a Beat 2→4 trace | 1,368 lines, 121 KB |
| [TASKS.md](TASKS.md) | The week's plan: workstreams, pre-window to-dos (P-01–P-18), the Friday kickoff (K-00–K-10), day-by-day tasks, checkpoints and the cut line, the testing plan, deliverables, the critical path | 1,063 lines, 103 KB |
| [TRACEABILITY.md](TRACEABILITY.md) | The requirements matrix: every BRIEF requirement (as amended) → spec section → the task whose DoD proves it, with a status. Also the contradictions checked and the remaining risks. | 418 lines, 42 KB |
| [SETUP-CHECKLIST.md](SETUP-CHECKLIST.md) | Accounts, keys, devices and keypairs, what each costs and when it's needed; where each secret lives; the canonical `.env.example` names (§7) | 575 lines, 48 KB |
| `../youre-on-spikes/FINDINGS.md` | The verified Phase-0 roll-up (outside this folder; reference only, never copied into the repo) | 892 lines, 78 KB |

## Reading order by role

| Role | Read, in order |
|---|---|
| **Lead (L)**: escrow, devnet, LockService + nonce pool, Streams, server skeleton, CI | 1. This README and the BRIEF amendment<br>2. FINDINGS §1, §3.5–§3.7, §3.12, §4, §6<br>3. All of ESCROW-PROGRAM, especially §5.0, §9, §10<br>4. DATA-MODEL §5.6, §5.8, §5.20, §8<br>5. API-CONTRACT §1, §2.8, §5, §6<br>6. ARCHITECTURE §1–§2, §3.3, §5, §6<br>7. TASKS §1–§5, §9, §10<br>8. SETUP-CHECKLIST §1, §3, §6, §7 |
| **Eng2 (E2)**: iOS app, EAS build path, wallet + Face ID, terms card, face scan, judge cam, payout UX | 1. This README and the BRIEF amendment<br>2. FINDINGS §3.1–§3.4, §3.14–§3.15, §7, and spike 3b §(d)<br>3. SETUP-CHECKLIST A1–A5 and §6<br>4. ESCROW §5.0.2 (device policy) and its DP rows in §9.2<br>5. SCHEMAS §2.3–§2.4, §9, §10<br>6. API-CONTRACT §1.3, §2.1–§2.5, §2.8–§2.10, §3, §6.3<br>7. ARCHITECTURE §3.1, §3.3–§3.4, §6.4, §6.7<br>8. TASKS §1, §4 (the M rows), §5 |
| **Eng3 (E3)**: schemas, ElevenLabs judge, vision ruling, hearing + panel, Gemini, stage, demo mode, video, Devpost | 1. This README and the BRIEF amendment<br>2. FINDINGS §3.8–§3.11, plus the spike 02, 04 and 05 sections<br>3. SCHEMAS §2–§8, §10<br>4. API-CONTRACT §2.6–§2.7, §2.11–§2.13, §2.17, §4, §7<br>5. ARCHITECTURE §3.2, §3.4–§3.6, §7, §8, §9<br>6. DATA-MODEL §5.10–§5.16<br>7. TASKS §1, §4 (the J rows), §6.5–§6.7, §7, §8<br>8. SETUP-CHECKLIST K1, K2, K4, K5, S2 |

## Open questions for the lead

**A. Defaults to confirm or overturn.** Each is in force until you change it.

| # | Question | Default | Source |
|---|---|---|---|
| 1 | How is the lock pushed to the phones? | As `terms.authorize_request` carrying SCHEMAS `AuthorizeRequest`. `tx.sign_request` carries only the concede/appeal messages. | Consistency pass; SCHEMAS §10.1, API-CONTRACT §3.4 |
| 2 | Is the API auth key the wallet key? | No: a separate, ungated device key signs logins and requests, so a later OS-enforced Face ID gate never prompts on API calls. | API-CONTRACT §1.3, DATA-MODEL §5.2 |
| 3 | How do phones know the nonce pool? | Each address is `createWithSeed(fee payer, "yo-nonce-<k>")` with k < 16, so phones verify it offline and no list ships. This is a design choice (E), not a spike result. | ESCROW §5.0.1, API-CONTRACT O7 |
| 4 | What happens after a failed lock? | Cancel (`lock_failed`), then re-propose the same terms under a new `bet_id`, at most once (`MAX_LOCK_REBUILDS = 1`). | SCHEMAS §9.4 |
| 5 | How do GG and "I appeal!" authorize? | A tap plus Face ID, with no hold. GG needs Face ID like every device signature. | API-CONTRACT O1, ARCHITECTURE O-A1 |
| 6 | Whose device is the judge cam? | A device of party A, with `devices.role = 'judge_cam'`, bound to the room. `recorded_by = 'A'`. | API-CONTRACT §2.9 |
| 7 | How is A's hearing turn captured? | Through the live agent session's ASR, not a second recorder. PENDING-PHONE. | ARCHITECTURE O-A3 |
| 8 | Does the guardrail block? | Yes. A keyword prefilter runs inline, and an LLM check runs asynchronously and fails closed before the lock. The terms audit is P1 and advisory. No model has been evaluated (PENDING-KEY). | API-CONTRACT O3, ARCHITECTURE O-A4 |
| 9 | Do model timeouts and errors count toward `MAX_REDOS`? | Yes. | API-CONTRACT O4 |
| 10 | When does the appeal panel start? | Speculatively, at the `appeal` preflight. Votes are discarded if the tx fails. | API-CONTRACT O5 |
| 11 | Who voices the appeal votes? | Stage-laptop TTS with 3 voices, not the agent. | API-CONTRACT O6, ARCHITECTURE O-A5 |
| 12 | Is the face embedding sealed in transit? | Yes: sealed to a server x25519 key, with a `plain-v0` switch. This adds `FACE_SEAL_SECRET_KEY`. Drop it if it isn't worth the time. | API-CONTRACT O8, SETUP-CHECKLIST §7 |
| 13 | What priority is the stage view? | A bare stage ticker is P0; the full stage view is P1. BRIEF §7 lists the stage view as P1. | TASKS §0 |
| 14 | Does Saturday's run match BRIEF §8? | No: Saturday's devnet smoke lock is signed by the custodial demo keys, and the phone-signed lock lands Sunday. | TASKS §10.2 item 6 |
| 15 | What CU floor does the lock use before N11 runs? | A provisional 100k (E). The spike max was 63,675 (M). | API-CONTRACT §6 |

**B. Spending.** Nothing has been signed up for or paid. Approving every paid item comes to about **$181 plus usage** (SETUP-CHECKLIST summary):

| Item | Cost | When |
|---|---|---|
| Apple Developer | $99 | Today |
| EAS Starter | $19 | — |
| ElevenLabs Creator | $11 for the first month | By Thu |
| QuickNode Build | $49 | Pause the Stream when idle |
| Fly | about $3 | — |
| Tigris | PENDING | — |
| AI providers | pay-as-you-go | — |

**C. Choices scheduled in TASKS P-13 and D1-M1:**
- the EAS, QuickNode and ElevenLabs plans;
- the voice LLM, after FINDINGS §6 step 1. Haiku 5.5 is not in ElevenLabs' Supported LLMs table.
- the judge model, Haiku 5.5 vs Opus-low, after step 2 and the 20 clips;
- the camera stack, decided on Saturday;
- the repo name and licence.

**D. Reopen only if needed:**
- A per-bet `appeal_window_secs` for Gemini bets (SCHEMAS O6), if a payout ~T+17–20 s after expiry is too late for the pitch. It must be decided before the escrow is written on Fri/Sat.

**E. Known stale text outside the editable set.**
- **FINDINGS.md** was updated from the main session on 2026-11-08: decision 4 (atomic lock) in the header, §1 Decision 2, §2.2 / §2.3, §3.7 and the §4 Beat 3 rows now say the atomic lock is decided.
- **BRIEF.md** is read-only.
  - §5d still lists `ask_clarification`, `lock_bet` and `issue_ruling`.
  - §8 has Saturday's create/accept "from the app".
  - D6 and TASKS §10.2 supersede both.

**F. PENDING measurements that could still change the design** (FINDINGS §6):
- **Judge read-back after a tool result:** 1.25–2.2 s against the 1.5 s target (steps 1, 9).
- **Vision accuracy:** the bar is 0 wrong winners (steps 0, 2).
- **Real lock CU and size:** ESCROW N11/N12, step 13.
- **Devnet second authorization → LOCKED, in both orders, over cellular:** step 12.
- **Face ID method detection on a device:** step 8.
- **Stream → webhook latency and credit burn:** steps 4, 6.

## Phase-0 rules (until Fri 2026-11-13 18:00 UTC)

- **Allowed now:** planning documents in this folder, plus throwaway spikes in `../youre-on-spikes/`.
- **Not before the window:** no git repo and no product code.
- **Money and accounts:** never sign up for or pay for anything without the lead's approval.
- **Nothing is copied from the spikes,** neither code nor the FINDINGS file. Re-author everything in the repo from these specs during the window.
- **Getting these docs into the repo:**
  - These docs enter the repo only through TASKS K-04: copied verbatim into `docs/planning/`, committed as `docs: import Phase 0 planning (written pre-window)`.
  - Any change after that is its own reviewed `docs(<doc>): …` commit (TASKS K-05, §3.2).
- **Secrets** never go in git. EAS env holds `EXPO_PUBLIC_*` values only.

## Changelog

- **2026-11-08:** first version, written at the end of the cross-doc consistency pass. It indexes the eight planning docs and records D1–D7. It also lists the defaults that need the lead's confirmation and the stale text left in FINDINGS and BRIEF.
- **2026-11-08, completeness pass:** added TRACEABILITY.md (207 requirements: 169 covered, 33 fixed now, 5 deliberately out of scope). The fixes landed in TASKS (new D0-J4, D1-L6, D1-M6, D5-X2, D6-X2, plus stronger DoDs), SETUP-CHECKLIST C2 (USDC timing) and ARCHITECTURE §9 item 15 (pre-window artifacts).
- **2026-11-18:** D10 built (see its row). The judge cam became optional: with two phones the non-performer's own phone films with `recorder:'self'` (API-CONTRACT §2.9), on A's phone too when B performs, video only so the voice judge keeps the mic (ARCHITECTURE §1.1 row, a deliberate deviation from FINDINGS §4 Beat 4).

## Decisions added 2026-11-14 (merge)

Added when the team merged its two prototypes (You're On and Verdict) into one repo. Background and the kept / ported / dropped tables are in [`../MERGE-PLAN.md`](../MERGE-PLAN.md). These rows take precedence over any earlier text in this folder that conflicts with them, including BRIEF.md (read-only).

| # | Decision | Since | Supersedes / where it applies |
|---|---|---|---|
| D8 | **Base and name.** You're On is the base, and the contracts in this folder win on any conflict. The product is called "You're On" everywhere in code and UI. "Verdict" is named only as the source of ported ideas, in comments and docs. Verdict's specs are reference material in `docs/reference/verdict/`. Ported code is re-implemented in this stack and cites its Verdict source path in a header comment. | 2026-11-14 | All docs; `docs/reference/verdict/` |
| D9 | **No voiceprint, no spoken acceptance.** Reaffirms D1 and D2: the face scan only addresses the challenge, and each person authorizes on their own phone with hold + Face ID. Verdict's voiceprint acceptance and server-side face matching are not adopted. | 2026-11-14 | D1, D2 (unchanged) |
| D10 | **Judge inputs.** Claude rules on 12–16 frames clustered at the end of the attempt plus one landing crop, alongside deterministic checks (cap tape visible, bottle at rest). If the model and the deterministic checks disagree, the result is REDO. `MAX_REDOS = 2` and the D7 ruling rules are unchanged. SAM 3 is not used for now (gated access was approved 2026-11-14); it is a candidate for a later video-only overlay on disputes. **Built 2026-11-18** (`packages/shared/src/judge/frames.ts`, one sampler for the phone, the server and `judge-eval`): 12 frames (the latency cap; 4 spread over the clip, 8 in its last ~1.2 s, ≤ 512 px) plus one landing crop (the last frame's middle 80 % at full resolution, ≤ 1024 px), every JPEG ≤ 200 KB; the prompt labels the landing frames and the crop. The server still takes 8–12 frames with no crop. | 2026-11-14 | Supersedes the 8-frame extraction (item 6 above; BRIEF §5c; ARCHITECTURE summary, §1.1, §3.4; API-CONTRACT §7.1 first-ruling row; TASKS D3-M1) |
| D11 | **Demo scope.** The live physical challenge is the bottle flip. The Gemini BTC 5-minute bet is locked first and settled at the end of the pitch. The dispute / hearing / appeal flow is shown in the video. Push-ups, cup tower and paper-ball judging are out of demo scope. | 2026-11-14 | TASKS demo plan; judge-cam clip set |
| D12 | **Consent-first settlement.** The loser's GG, or silence until the appeal window closes (`finalize`), settles the bet. The AI hearing and three-provider appeal panel run only on a dispute. (Verdict spec §2, principle 2, "Consent first": `docs/reference/verdict/verdict-spec.md`.) | 2026-11-14 | Consistent with D7; ARCHITECTURE §3.4–§3.5 |
| D13 | **Build path.** Expo dev builds are made locally with Xcode on the lead's Mac. All demo phones stay iPhones. APNs push is out of demo scope: the WS hub carries every event to phones that have the app open. `LOCK_MODE=sequential` is out of demo scope: the atomic lock (D3) is the only path. | 2026-11-14 | Supersedes D4's "EAS cloud from Linux (there is no Mac) … with APNs"; the `LOCK_MODE` fallback in the summary above |
| D14 | **Providers and spend guard.** LLM, STT and SFX sit behind interfaces with deterministic mocks and default to the mock; any `live` mode refuses to start unless `ALLOW_SPEND=true`. Paid paths without a mock mode (the ElevenLabs Agent conversation token, the judge fixture runner) call out only with `ALLOW_SPEND=true`. Under `NODE_ENV=production` the mock LLM and STT refuse every call. Tests and CI never set `ALLOW_SPEND`. (Ported from Verdict.) | 2026-11-14 | SETUP-CHECKLIST §7 (adds `ALLOW_SPEND` and the provider-mode names); D5 |
| D15 | **Design system and copy rule.** From Verdict spec §6.2–§6.4: one sans-serif family, two weights; monochrome, dark by default, one accent for the primary action and live state; 8-pt grid; functional motion ≤ 200 ms. Labels are 1–3 words, nothing has a sentence description under it, and money shows in dollars with no chain jargon in primary UI. | 2026-11-14 | `apps/mobile`, `apps/stage` |
