Status: DRAFT — Phase 0 planning written 2026-11-08 (before the build window). Re-author into the repo during the window; if committed verbatim, commit it as 'docs: import Phase 0 planning (written pre-window)'.

# TRACEABILITY — BRIEF requirements → spec → task

Every requirement in BRIEF.md (as amended, plus D1–D7) mapped to the spec section that defines it and the TASKS item whose definition of done (DoD) proves it. Written by the 2026-11-08 completeness pass. Where a requirement had no spec, no task, or a DoD that didn't prove it, the gap was fixed in place in the doc named in the row.

## Summary (one screen)

**Counts (207 requirements):**

| Status | Count | Meaning |
|---|---|---|
| covered | 169 | A spec section defines it and a task's DoD proves it |
| fixed-now | 33 | A spec, task or DoD was missing or contradicted another doc; fixed in place on 2026-11-08 |
| deliberately-out-of-scope | 5 | Not built, with a recorded reason (P2 items, Solana Pay, the three LLM tools D6 removed) |

**Gaps fixed now** (details in §13):
1. **No task built rooms or the challenge API** (`POST /v1/rooms…`, `POST /v1/bets`, invite accept/decline, `bet.invited`). The Sunday checkpoint needs a bet to exist before the face scan lands Tuesday. New: TASKS D0-J4 (server) and D1-M6 (screens; also the `face_pick_list` fallback).
2. **No task put USDC into the phone wallets before Sunday's lock.** The "top-up job" was cited in ARCHITECTURE §2.3 and ESCROW §10.2, but no task built it. New: D1-L6 `scripts/fund.ts`. SETUP-CHECKLIST C2's timing ("window only") now matches TASKS P-10 and FINDINGS §1 ("claim early").
3. **Dollar balance, history, avatar photos and face disable** were spec'd (API-CONTRACT §2.1, §2.2, §2.14) but untasked. Added to D3-L1, D3-M2, D3-M3, D5-M2, D2-J3 and D5-L1.
4. **Demo controls.** `force-hearing`, `lock-mode`, `toggles`, `warmup`, `health` and the `stream/*` routes (API-CONTRACT §2.17) were untasked. Added to D4-J1 and D5-L1.
5. **No finals pitch run-of-show or Q&A prep** (BRIEF §2: 5 min + 2 min Q&A; judging criteria). New: D5-X2.
6. **No clean-clone setup run.** §8.4 asked for one, but no task ID owned it. New: D6-X2.
7. **DoDs that didn't prove the requirement:**
   - 18+ (D0-M4);
   - every refusal category (D0-J3);
   - 1–2 edge-case questions (D2-J1);
   - the card deadline (D2-M1);
   - users hold 0 SOL (D1-L5, T-SMK);
   - nothing stored on no match (D4-M1);
   - the 30-second hearing (D4-J1);
   - Stream config committed (D1-L4);
   - the crypto-copy audit (D5-M2).
8. **Rules.** Official docs first (TASKS §0). README moves with the code (TASKS §3.2 rule 11). Pre-window artifacts (§3.2 rule 9, D0-M2, ARCHITECTURE §9 item 15).

**Contradictions found** (§12):
- **Fixed in TASKS:**
  - GG and appeal are tap + Face ID, not hold;
  - stale route names;
  - the attempt → ruling clock;
  - REPLAY vs "recorded".
- **Fixed in SETUP-CHECKLIST:** the USDC timing.
- **Fixed for the timing rule:** the face model and the eval clips are pre-window artifacts.
- **Recorded as deliberate:** face matching moves from Mon to Tue.
- **Nothing contradicts the amendment.** No doc has a handshake, a binding spoken accept, or a face match that authorizes.
- **Nothing schedules repo or product work before Fri 2026-11-13 18:00 UTC.**

**Remaining risks** (§14): PENDING measurements that can still miss a target (judge read-back, vision accuracy, devnet lock, Face ID method detection, Streams latency and credits), the iOS build path, the Beat 6 payout timing, and about +9 h of added work in a full week.

## Legend

- **Docs:** SCH = SCHEMAS, ESC = ESCROW-PROGRAM, DM = DATA-MODEL, API = API-CONTRACT, ARCH = ARCHITECTURE, SET = SETUP-CHECKLIST, FND = `../youre-on-spikes/FINDINGS.md`.
- **Tasks:** TASKS IDs (`P-`, `K-`, `Dd-X`, `T-`). "§x" in the task column means a TASKS section.
- **Status:**
  - **covered**: a spec defines it and a task's DoD proves it.
  - **fixed-now**: the gap was closed in this pass; the note says where.
  - **deliberately-out-of-scope**: not built; the reason is in the note.
- **PENDING-KEY / -PHONE / -SOL:** covered by a spec and a task, but the number is still unmeasured (FND §6). A PENDING row can still fail in the window. See §14.

---

## 1. Timing rule ("READ THIS FIRST")

| ID | Requirement | Brief | Spec | Tasks | Status |
|---|---|---|---|---|---|
| T1 | Substantially built during the window, Fri 2026-11-13 18:00 UTC → Fri 2026-11-20 18:00 UTC | Timing | README Phase-0 rules; ARCH §9 item 15 | K-01, §3.2 rule 1 | covered |
| T2 | Repo public; judges can see the commit history | Timing | SET S1 | K-01; §3.2 rules 1–4, 10 | covered |
| T3 | Run `date -u` first | Timing | — | K-01 | covered |
| T4 | Before the window: Phase 0 only (docs + throwaway spikes); no submission repo, no product code | Timing | README Phase-0 rules; SET §3 rules, §6 "Not today" | §2, P-01–P-18 | covered |
| T5 | Spike code lives outside the repo; nothing from it is copied in | Timing | README; ARCH §9 item 15 | K-04, §3.2 rules 7, 9; D0-M2 | **fixed-now**: the face-model `.tflite` is regenerated in the window by a committed script (D0-M2); the pre-window eval clips stay out of git and are disclosed (§3.2 rule 9, ARCH §9 item 15) |
| T6 | After the window opens: Phase 1 in a fresh repo | Timing | SET S1 | K-01 (empty, no template) | covered |
| T7 | If told to start early: remind once, then comply | Timing | README Phase-0 rules | — | covered (agent behaviour rule; nothing to build) |

## 2. Product (BRIEF §1)

| ID | Requirement | Brief | Spec | Tasks | Status |
|---|---|---|---|---|---|
| PR1 | Challenge a friend by pointing the phone at their face; the scan only finds and addresses them (D1) | §1, 5e | ARCH §3.1; API §2.3–§2.5; SCH §9 | D1-M3, D3-M3, D4-M1, **D0-J4**, **D1-M6** | **fixed-now**: no task built rooms or the challenge API (gap 1) |
| PR2 | Say the bet out loud; the judge asks edge-case questions and reads the terms back | §1 | SCH §3; API §4.3; ARCH §3.2 | D0-J2, D0-J3, D1-J1, D2-J1, D2-J2, D2-M3 | covered |
| PR3 | Each person reviews the final terms and authorizes their own stake on their own phone (hold + Face ID); both → stakes lock in a Solana escrow | §1 (AMENDED) | SCH §9, §9.4; ESC §5.0.1–§5.0.2; API §2.8; ARCH §3.3 | D1-M5, D2-L1, D2-L2, D2-M1, D2-M2 | covered |
| PR4 | The judge watches the attempt through the camera and rules out loud | §1 | SCH §4–§5; API §2.9, §4.5; ARCH §3.4 | D2-J4, D3-M1, D3-J1 | covered |
| PR5 | The winner is paid in under a second | §1 | ARCH §4, §5.2; SCH X10; ESC §8.4 | D3-L1, D3-M2, D3-L3 | covered (PENDING-SOL; holds only when the UI flips at `processed`) |
| PR6 | Disputes get a 30-second hearing | §1 | SCH §6; ARCH §3.5 | D4-J1, D4-M3 | **fixed-now**: D4-J1's DoD now bounds `hearing.opened` → verdict voiced at ≤ 30 s (2 × (10 + 2 s) turns + the verdict) |
| PR7 | Appeal to a panel of three different AI models | §1 | SCH §7; API §7.2 | D4-J2, D4-L1 | covered |
| PR8 | Real-world bets: fair odds from Gemini prediction markets, settled from Gemini's results | §1 | SCH §2.6, §8; API §2.13, §7.3; ARCH §3.6, §8.4 | D1-J3, D4-L2, D4-J3, D4-M4 | covered |
| PR9 | Signup is a selfie | §1, 5e | API §2.1–§2.2; DM §5.3, §10 | D0-M4, D3-M3, D5-M2 | **fixed-now**: D3-M3 offers enrollment as a skippable step right after signup (opt-in, 5e) |
| PR10 | No seed phrases | §1 | FND §3.4; SCH §0 | D0-M3 | covered |
| PR11 | No gas fees: the server pays every fee and rent | §1, 5b | ESC §1 overview, §5.0; API §6.1 | D2-L2, D3-L1, D1-L5, T-SMK | **fixed-now**: D1-L5 and T-SMK assert both party wallets hold 0 lamports |
| PR12 | Money shows as dollars | §1, 5b | SCH §0, §1.1, §2.3; API §1.4, §2.14 | D2-M1, D3-L1, D3-M2, D5-M2 | **fixed-now**: the balance endpoint, balance header and history had no task (gap 3); D5-M2 adds a crypto-copy audit |
| PR13 | Pitch line: "Friends bet each other every day… enforceable in under a second" | §1 | FND §4 "Pitch copy"; ARCH §9 item 1 | **D5-X2**, D5-J3 | **fixed-now**: D5-X2 puts the line in the run-of-show as copy, explained without a handshake (D1) |

## 3. Hackathon context, tracks and bounties (BRIEF §2)

| ID | Requirement | Brief | Spec | Tasks | Status |
|---|---|---|---|---|---|
| H1 | Finals in person at UT Austin, Sat Nov 21: 5 min pitch + 2 min Q&A | §2 | ARCH §7.2 pre-show checklist | §4.8 Finals, R1 (§6.6), P-14, **D5-X2** | **fixed-now**: no task wrote the pitch run-of-show or the Q&A prep (gap 5) |
| H2 | Consumer: interacts with the blockchain | §2 | ESC; ARCH §8.1 | D0-L1–D1-L3, D2-L2 | covered |
| H3 | Consumer: working user-facing frontend | §2 | ARCH §1 | D0-M1–D5-M2; D1-J5–D5-J1 (stage) | covered |
| H4 | Consumer objective: hide crypto complexity (bridging, gas, seed phrases) | §2 | SCH §0 "Users never see crypto"; ARCH §8.1 | D0-M3, D2-L2, D5-M2 | **fixed-now**: D5-M2's crypto-copy audit (no SOL, gas, seed, address or transaction strings on party screens) |
| H5 | Consumer objective: something people want to use every day | §2 | DM §7.1 (head-to-head); ARCH §9 item 18 | D4-M2, D5-M3, D5-X2 | covered (judged qualitatively; the real-user test is the evidence) |
| H6 | Consumer objective: intentional design and UX | §2 | FND §3.4 (terms card, haptics map); ARCH §5.2 | D1-M5, D2-M1, D3-M2, D5-M2, D5-M3 | covered |
| H7 | Solana: core onchain functionality on Solana (devnet is fine) | §2 | ESC §1–§8 | D0-L1, D0-L2, D1-L1, D1-L3 | covered |
| H8 | Solana: include program IDs | §2 | ARCH §9 item 5; ESC §10.2 | D1-L3, D6-L1, §8.3, §8.4 | covered |
| H9 | Solana: the README explains how the project uses Solana | §2 | ESC §11; ARCH §8.1 | D6-L1 | covered |
| H10 | Solana objective: Anchor or native Rust | §2 | ESC §9.1; FND §3.6 | D0-L1 | covered |
| H11 | Solana objective: Solana-native primitives, SPL tokens | §2 | ESC §3.3, I15 | D0-L2, D1-L1 | covered (also durable nonces and `emit_cpi!`, ARCH §8.1) |
| H12 | Solana objective: Token Extensions | §2 | ESC TM-K; §9.2 T22 rows | D4-L5 (P1, cut-line #4) | covered (P1; the README claims Token-2022 support only for rows that are green, §5.2 #4) |
| H13 | Solana objective: Solana Pay | §2 | — | — | **deliberately-out-of-scope**: the product has no merchant or payment-request flow. The only candidate is the P2 web-link accept (cut). The Solana-native story is SPL USDC, a PDA vault, the durable-nonce lock and `emit_cpi!` (ARCH §8.1). |
| H14 | Solana objective: integrate existing tooling | §2 | FND §3.5–§3.6; ARCH §8.1 | D1-L3 (Codama), D1-L4 (QuickNode), T-ESC (LiteSVM) | covered |
| H15 | Solana objective: smooth wallet UX | §2 | FND §3.4; ESC §5.0.2 | D0-M3, D1-M5, D2-M2 | covered |
| H16 | ElevenLabs: the API/SDK is a core feature, not an add-on | §2, 5d | ARCH §8.2; API §4 | D0-J2, D1-J1, D2-J1, D2-M3 | covered |
| H17 | ElevenLabs: the demo video shows it in action, with audio | §2 | TASKS §8.2 shot 3 | D6-M2, D6-J1, §8.4 | covered |
| H18 | ElevenLabs: the README says which products we used and how | §2 | ARCH §8.2 | D6-J2 | covered |
| H19 | QuickNode: Streams is a core data source | §2, 5h | ARCH §5.1, §8.3; DM §5.9, §8.2 | D1-L4, D1-L5 | covered |
| H20 | QuickNode: at least one Stream configured with a filter and a destination | §2, 5h | API §5.1–§5.2; ARCH §8.3 | D1-L4 | **fixed-now**: the DoD now requires the filter source and `scripts/qn-stream.ts` committed and linked from the README |
| H21 | QuickNode: the README explains the network, dataset, filter logic, destination and why | §2, 5h | ARCH §8.3 | D6-L1 | covered |
| H22 | Gemini: uses the Prediction Markets API (market data and/or trading) | §2 | ARCH §8.4; API §7.3 | D1-J3, D3-J5, D4-J3 | covered (cut-line #11 keeps the live odds widget, so the API stays used) |
| H23 | Judging criteria: technical execution, product & UX, innovation, impact & potential, demo | §2 | ARCH §9 item 18 | K-07 (CI), T-ESC, D5-M3, §8.3, **D5-X2** | **fixed-now**: D5-X2 maps each criterion to a pitch moment |
| H24 | Team of three; the user is the lead engineer | §2 | — | §1, P-15 | covered |
| H25 | The demo runs only on the team's phones; judges install nothing | §2 | ARCH §9 item 2; FND §3.15 | P-02, P-04, D6-M1 | covered |
| H26 | Plus a laptop driving a big-screen stage view | §2 | ARCH §1.2, §2.1 | P-17, D1-J5, D2-J3, D5-J1 | covered |

## 4. Submission (BRIEF §2)

| ID | Requirement | Brief | Spec | Tasks | Status |
|---|---|---|---|---|---|
| S1 | Due Fri Nov 20, 12:00 PM CST | §2 | SET S2 | §4.8 (submit 10:00 CST, buffer to 12:00) | covered |
| S2 | Public GitHub repo with source | §2 | SET S1 | K-01, §8.4 | covered |
| S3 | Setup instructions | §2 | ARCH §9 item 13 | D6-L1, D6-M3, §8.1 Setup row, **D6-X2** | **fixed-now**: the clean-clone run had no task (gap 6) |
| S4 | README with technical docs and architecture | §2 | ARCH §9 | K-03, D6-L1, D6-J2, D6-M3, §3.2 rule 11 | covered |
| S5 | Working demo | §2 | ARCH §7 | D6-X1 (R3), §4.8 smoke | covered |
| S6 | 2–3 minute demo video | §2 | TASKS §8.2 | D5-J3, D6-M2, D6-J1 | covered |
| S7 | Devpost answers: What did you build? What problem does it solve? How does it work? What makes it unique? What would you build next? | §2 | ARCH §9 item 18 | D5-J3, D6-J3, §8.3 | covered |
| S8 | Technologies used | §2 | ARCH §9 item 18 | §8.3, D6-J3 | covered |
| S9 | Program IDs | §2 | ARCH §9 item 5 | D1-L3, §8.3, §8.4 | covered |

## 5. Demo beats (BRIEF §3)

| ID | Requirement | Brief | Spec | Tasks | Status |
|---|---|---|---|---|---|
| B0 | Every P0 feature exists to make these moments work live | §3 | ARCH §7 | §5.1 checkpoints; §5.2 "never cut" | covered |
| B1a | A points the camera at B → "Challenge Jake?" | Beat 1 | ARCH §3.1; API §2.4 | D4-M1 | covered (PENDING-PHONE) |
| B1b | B's phone buzzes with the challenge | Beat 1 | API §2.5, §3.4; FND §3.14 | **D0-J4**, D1-M4, **D1-M6**, D5-M4 | **fixed-now**: no task built the server side of the challenge and invite (gap 1) |
| B2a | A says "Bet you $5 you can't land a bottle flip"; the judge asks 1–2 funny edge-case questions | Beat 2 | SCH §3; API §4.3 | D2-J1, D2-J2 | **fixed-now**: D2-J1's DoD required only "≤ 2"; it now requires 1–2 on the Beat 2 line |
| B2b | The judge reads the final terms back; the terms card appears on both phones | Beat 2 | SCH §2.3, §9; API §3.4 | D1-J1, D2-M1 | covered |
| B3a | Each person confirms the terms and their stake on their own phone (hold + Face ID) | Beat 3 (AMENDED) | SCH §9; ESC §5.0.2 | D1-M5, D2-M2 | covered |
| B3b | The second confirmation locks both stakes onchain | Beat 3 | ESC §5.0.1; SCH §9.4 | D2-L2 | covered (PENDING-SOL/PHONE: FND §6 step 12) |
| B3c | The transaction appears on the stage view | Beat 3 | ARCH §3.3; API §3.4 | D1-J5, D2-J3 | covered |
| B3d | No handshake detection | Beat 3 (AMENDED) | SCH X1, X13; API §2.16 | — | covered (nothing to build; no handshake state, field or test exists in any doc) |
| B4a | The camera records the flip | Beat 4 | SCH §4; API §2.9 | D3-M1 | covered |
| B4b | The judge rules out loud within a few seconds | Beat 4 | ARCH §3.4, §4 | D3-J1 | covered (PENDING-KEY) |
| B4c | The loser taps "GG", or it auto-finalizes after 10 s | Beat 4 | ESC §5.2 (`concede`, `finalize`), §8.3; API §2.10 | D3-L1, D3-M2 | **fixed-now**: TASKS said "hold + Face ID" for GG; aligned to tap + Face ID (API O1) |
| B4d | The winner's phone buzzes with the payout | Beat 4 | SCH X10 | D3-M2 | covered |
| B5a | Contested shot → each side gets about 10 s to argue | Beat 5 | SCH §6; API §2.11 | D4-J1, D4-M3 | **fixed-now**: `force-hearing` (trigger `'demo'`) makes the contested shot deterministic on stage |
| B5b | The judge reviews the clip and rules | Beat 5 | SCH §6 `HearingRuling` | D4-J1 | covered (PENDING-KEY) |
| B5c | "I appeal!" → the three-model panel votes live | Beat 5 | SCH §7; API §2.12, §7.2 | D4-L1, D4-J2, D4-M3, D4-J4 | **fixed-now**: the appeal gesture aligned to tap + Face ID (D4-M3) |
| B5d | The ruling stands or flips | Beat 5 | SCH §7 | D4-L1 | covered |
| B6a | "Bitcoin's up by the end of this pitch" → the judge pulls Gemini's 5-minute BTC market | Beat 6 | API §4.3 `get_market_odds`; ARCH §3.6 | D4-J3 | covered |
| B6b | Fair stakes from the live price (e.g. 62/38) | Beat 6 | SCH §8.2 | D1-J3, D4-M4 | covered |
| B6c | Settles from Gemini's result at the end | Beat 6 | SCH §4 `GeminiSettlementRecord`, §8.3 | D4-L2, D4-J3 | covered (risk: pays ~T+17–20 s after expiry unless GG; §14) |
| BX | Extra: point the camera at a friend to see the head-to-head record | Extra | DM §7.1; API §2.4, §2.14 | D4-L4, D4-M2 | covered |

## 6. Architecture (BRIEF §4)

| ID | Requirement | Brief | Spec | Tasks | Status |
|---|---|---|---|---|---|
| A1 | Monorepo: `apps/mobile`, `apps/server`, `apps/stage`, `programs/escrow`, `packages/shared` | §4 | ARCH §1 | K-06 | covered |
| A2 | `apps/mobile`: Expo dev build (not Expo Go); camera, face, voice, flows, haptics, push | §4 | ARCH §1.2; FND §3.1 | D0-M1, D0-M2 | covered |
| A3 | `apps/server`: Node + TS (Hono), Postgres, WebSockets, plus the listed services | §4 | ARCH §1.2–§1.3 | D0-L3 | covered |
| A4 | `apps/stage`: web app for the projector | §4 | ARCH §1.2 | K-06, D1-J5 | covered |
| A5 | `programs/escrow`: Anchor on devnet | §4 | ESC | D0-L1 | covered |
| A6 | `packages/shared`: types and Zod schemas (Terms, Ruling, BetState, events) | §4 | SCH | D0-J1 | covered |
| A7 | Public HTTPS for the ElevenLabs tools and the QuickNode webhook | §4 | ARCH §2.2 | D0-L3 | covered |
| A8 | Verify library compatibility first | §4 | FND §3 | P-05, P-06, D0-M2 | covered |

## 7. Component specs (BRIEF §5a–§5i)

### 7.1 Escrow (5a)

| ID | Requirement | Brief | Spec | Tasks | Status |
|---|---|---|---|---|---|
| E1 | Config: admin, judge_authority, appeal_authority, max_stake ($20), default deadlines | 5a | ESC §3.1, §5.1 | D0-L1 (C1–C5, U1–U10), D1-L3 `init-config` | covered |
| E2 | Bet PDA `["bet", bet_id]` with the listed fields; vault owned by the PDA | 5a | ESC §3.2–§3.3 | D0-L1, D0-L2 | covered |
| E3 | `create_bet`: A deposits | 5a | ESC §5.2 | D0-L2 (B rows) | covered |
| E4 | `accept_bet`: B deposits; must match `terms_hash` → Locked | 5a | ESC §5.2, I3 | D0-L2 (A rows) | covered |
| E5 | `resolve`: judge_authority only; outcome A/B/Split/Refund; stores hashes; opens the appeal window | 5a | ESC §5.2, I7 | D1-L1 (R rows), D3-L1 | covered |
| E6 | `concede`: the loser finalizes immediately | 5a | ESC §5.2, I9 | D1-L1 (K rows), D3-L1 | covered |
| E7 | `appeal`: the loser, within the window | 5a | ESC §5.2, I9 | D1-L1 (P rows), D4-L1 | covered |
| E8 | `resolve_appeal`: appeal_authority only | 5a | ESC §5.2, I8 | D1-L1 (RA rows), D4-L1 | covered |
| E9 | `finalize`: after the window closes | 5a | ESC §5.2, I10 | D1-L1 (F rows), D3-L1 | covered |
| E10 | `timeout_refund`: anyone, after the deadlines | 5a | ESC §5.2, I12 | D1-L1 (T rows), D3-L2 | covered |
| E11 | Hard rule: funds go only to party_a or party_b | 5a | ESC I1, TM-F | D1-L1 (K7, RA7, F6), D4-L5 (CPI1) | covered |
| E12 | Hard rule: stakes ≤ max_stake | 5a | ESC I2 | D0-L2 (B rows) | covered |
| E13 | Hard rule: terms_hash is immutable after the lock | 5a | ESC I3 | D0-L2 | covered |
| E14 | Hard rule: no admin withdrawal path | 5a | ESC I4 | D0-L1, D1-L1 | covered |
| E15 | An Anchor event for every state change (read by Streams) | 5a | ESC §7 | D0-L2, D1-L1 (E1–E4) | covered |
| E16 | Test every path, including an attempted payout to a third party (must fail) | 5a | ESC §9.2 | T-ESC, §6.2 | covered |

### 7.2 Wallets and money (5b)

| ID | Requirement | Brief | Spec | Tasks | Status |
|---|---|---|---|---|---|
| W1 | An embedded Solana wallet at signup (a device keypair in secure storage) | 5b | FND §3.4; API §1.3 | D0-M3, D0-M4 | covered |
| W2 | The server is the fee payer for every transaction; users never hold SOL | 5b | ESC §5.0; ARCH §6.2 | D2-L2, D3-L1, D1-L5, T-SMK | **fixed-now**: the 0-lamport assertion (PR11) |
| W3 | Balances display as dollars | 5b | API §2.14; SCH §1.1 | D3-L1, D3-M2, D5-M2 | **fixed-now**: gap 3 |
| W4 | Demo accounts pre-funded with devnet USDC (Circle faucet); devnet test money only | 5b | SET C2, KP6, KP8; DM §11 | P-10, **D1-L6**, D6-L3 | **fixed-now**: gap 2; SET C2 timing aligned with P-10 |

### 7.3 AI judge (5c)

| ID | Requirement | Brief | Spec | Tasks | Status |
|---|---|---|---|---|---|
| J1 | Claude via the Anthropic API, structured JSON outputs validated by Zod | 5c | FND §3.8; API §7.1 | D2-J4, D3-J1, D1-J1 | covered (terms extraction runs on Claude inside the ElevenLabs agent, D6; the server validates it with Zod) |
| J2 | Terms schema: claim, type, attempts, criteria, edge_cases, evidence_source, stakes, deadline | 5c | SCH §2.1 | D0-J1 | covered |
| J3 | At most 2 clarifying questions, then read the terms back | 5c | SCH §0.1 `MAX_CLARIFICATIONS`, §3 | D2-J1 | covered |
| J4 | Ruling: a short clip, ~8 frames including the final ones, sent with the terms | 5c | SCH §4; FND §3.3; README D10 | D3-M1, D3-J1 | covered (D10: 12 frames, 8 of them on the landing, + one landing crop) |
| J5 | Output A_WINS / B_WINS / REDO, confidence, reason; confidence < 0.8 → REDO | 5c | SCH §5.1–§5.2 | D3-J1, D3-J2 | covered (deliberate shape: the model emits `claim_result` and the server maps it, FND §2.3; `MAX_REDOS` = 2 then HEARING, D7) |
| J6 | Hash the clip → `evidence_hash` onchain | 5c | SCH §4 table; ESC `resolve` | D3-M1, D3-L1 | covered (plus `frame_hashes` in `ruling_hash`, D7) |
| J7 | Hearing: push-to-talk turns, one phone each; the ruling cites the evidence | 5c | SCH §6; API §2.11 | D4-J1, D4-M3 | covered |
| J8 | Appeals: three providers vote independently on the same evidence; majority decides | 5c | SCH §7 | D4-J2 | covered (no majority upholds the original, D7) |
| J9 | Persona: quick, stern, funny, PG-13, short lines | 5c | SCH §3 (`quip`); API §4.1 | D0-J3, D2-J2 | covered |
| J10 | Refuses dangerous, illegal or harmful challenges (dangerous, alcohol/drugs, self-harm, minors) with a joke | 5c | SCH §3 `RefusalCategory`; API §4.3 | D0-J3, D1-J1, D2-J1 | **fixed-now**: the fixtures had 3 refusals for 4 categories; now one per category |
| J11 | Guardrail: 18+ only | 5c | API §2.1, §2.5 `AGE_REQUIRED`; DM §5.1 | D0-M4 | **fixed-now**: the DoD now tests `AGE_REQUIRED` |
| J12 | Guardrail: stake cap | 5c | ESC I2; SCH `MAX_STAKE`; API §2.5 | D0-L2, D1-J1 | covered |
| J13 | P2P money bets are skill-only in the product; real-world bets route to Gemini's regulated market; the demo closer uses our escrow with Gemini as the oracle | 5c | ARCH §8.4 paragraph, §9 item 10 | D6-M3, D6-J2, D5-X2 Q&A | covered (a documentation and pitch item) |

### 7.4 Voice (5d)

| ID | Requirement | Brief | Spec | Tasks | Status |
|---|---|---|---|---|---|
| V1 | The judge is an ElevenLabs Agent whose server tools call our backend | 5d | API §4; ARCH §3.2, §8.2 | D0-J2, D1-J1, D2-J1, D4-J1, D4-J3 | covered (5 webhook tools + 3 client tools, D6) |
| V2 | Tools `ask_clarification`, `lock_bet`, `issue_ruling` as LLM-callable tools | 5d | API §4 (D6) | — | **deliberately-out-of-scope**: D6 replaces them. Clarifications are spoken; the lock and the ruling are server-driven and voiced through `judge.cue` → `[EVENT]`; `request_attempt` is a client tool. |
| V3 | ElevenLabs voices the rulings and announcements and handles the parties' speech | 5d | API §4.5; ARCH §3.2, §8.2 | D2-M3, D3-J1, D4-J2 (stage TTS) | covered |
| V4 | First judge audio < 1.5 s after a party stops talking | 5d, §6 | ARCH §4 | D1-J2, D2-J2, §6.5 | covered (PENDING-KEY; the post-tool read-back is 1.25–2.2 s, E) |
| V5 | Verify ElevenLabs React Native/Expo support and tool-call latency early | 5d | FND §3.10, §6 steps 1, 9 | P-05, P-12, D1-J2 | covered (PENDING-KEY/PHONE) |

### 7.5 Face scan (5e)

| ID | Requirement | Brief | Spec | Tasks | Status |
|---|---|---|---|---|---|
| F1 | Opt-in; selfie enrollment at signup with liveness (blink or head turn) and an explicit consent screen | 5e | API §2.2; DM §10; ARCH §6.7 | D3-M3 | **fixed-now**: skippable at signup; the consent text `face-consent-v1` is now owned by D3-M3 (it was PENDING with no owner) |
| F2 | Users can disable or delete it any time | 5e | API §2.2 (`PATCH`/`DELETE`); DM §10 | D3-M3 | **fixed-now**: disable had no task or DoD |
| F3 | Embeddings computed on the device; never raw images to the server | 5e | ARCH §6.7; API §2.2 | D1-M3, D3-M3, D4-M1 | covered |
| F4 | Encrypted at rest, never logged, never onchain | 5e | DM §10; ESC TM-P | D3-M3 | covered |
| F5 | Match only opted-in users in the same room; never a global search | 5e | API §2.3–§2.4; DM §7.2 | D4-M1, **D0-J4** | **fixed-now**: rooms had no task (gap 1) |
| F6 | No confident match → show nothing, store nothing | 5e | API §2.4 | D4-M1 | **fixed-now**: the DoD checked "shows nothing" only; it now checks "stores nothing" too |
| F7 | A match only addresses the challenge; the other person accepts on their own phone | 5e (AMENDED) | API §2.4 `match_ticket`; SCH §9 | D4-M1, D2-M2 | covered |
| F8 | Match < 1 s | 5e, §6 | ARCH §4 | D4-M1, §6.5 | covered (PENDING-PHONE) |
| F9 | The README explains the design (Texas and Illinois biometric laws) | 5e | ARCH §6.7 | D6-M3 | covered |

### 7.6 On-phone authorization (5f, AMENDED)

| ID | Requirement | Brief | Spec | Tasks | Status |
|---|---|---|---|---|---|
| O1 | Both phones show the same terms card (claim, criteria, edge cases, dollar stakes, deadline) and the terms_hash it binds to | 5f | SCH §2.3, §9 item 1 | D2-M1 | **fixed-now**: D2-M1's card contents lacked the bet deadline |
| O2 | Hold-to-confirm + Face ID (iOS LocalAuthentication) | 5f, D2 | FND §3.4; SCH O8 | D0-M3, D1-M2, D1-M5, D2-M2 | covered |
| O3 | This unlocks that party's device key, which signs only their own deposit (A `create_bet`, B `accept_bet`); the server is only the fee payer | 5f, D3 | ESC §5.0.1–§5.0.2 | D2-L1, D2-M2 | covered |
| O4 | The second authorization locks the bet onchain | 5f, D3 | ESC §5.0.1; SCH §9.4 | D2-L2 | covered |
| O5 | Either party can decline or let it expire; nothing moves without each party's own signature | 5f, D3 | SCH §9.2, §9.4 | D2-M1, D2-M4, D2-L2 | covered |
| O6 | Handshake detection is dropped | 5f | SCH X1, X13 | — | covered (nothing to build) |
| O7 | Passcode fallback allowed; the method is recorded (D2) | D2 | SCH O8; FND §7 | D0-M3, D1-M2 | covered (PENDING-PHONE: the two-call method detection, FND §6 step 8) |

### 7.7 Gemini Prediction Markets (5g)

| ID | Requirement | Brief | Spec | Tasks | Status |
|---|---|---|---|---|---|
| G1 | Market data is public; no key | 5g | ARCH §8.4 | D1-J3 | covered |
| G2 | List active events | 5g | API §7.3; ARCH §8.4 | D1-J3 | covered |
| G3 | Event details | 5g | API §7.3; SCH §4 | D1-J3, D4-J3 | covered |
| G4 | Live prices over WebSocket via `<instrumentSymbol>@bookTicker` | 5g | FND §3.11 | D1-J3 | covered |
| G5 | Recently-settled events, for resolution | 5g | SCH §4 note | D4-J3 | covered (deliberate substitution: event details shows `resolutionSide` 7.5–8.7 s after expiry, while recently-settled lags 26–36 s) |
| G6 | Strike from the API, not the ticker; never build symbols by hand | 5g | FND §3.11 | D1-J3 | covered |
| G7 | Fair stakes: A stakes pot × p, B stakes pot × (1 − p) | 5g | SCH §8.2 | D1-J3, D4-L2 | covered |
| G8 | Settlement: the judge resolves the escrow with Gemini's result as evidence | 5g | SCH §4, §8.3 | D4-L2, D4-J3 | covered |
| G9 | Read the docs (llms.txt); check whether the sandbox lists prediction markets | 5g | FND §7 "Gemini" | P-12 (done in spike 05) | covered (the sandbox books are empty) |

### 7.8 QuickNode Streams (5h)

Bounty rows H19–H21 cover "core", "filter + destination" and the README.

| ID | Requirement | Brief | Spec | Tasks | Status |
|---|---|---|---|---|---|
| Q1 | One Stream on Solana devnet | 5h | API §5.1 | D1-L4 | covered |
| Q2 | JS filter: only transactions that invoke our program; decode the Anchor events | 5h | API §5.2; ARCH §8.3 | D1-L4, T-WH | covered |
| Q3 | Destination: a webhook to `apps/server` | 5h | API §5.3–§5.4 | D1-L4 | covered |
| Q4 | The webhook updates the DB and pushes every state change (locked, resolved, appealed, paid) to both phones and the stage in real time | 5h | DM §8.2; API §5.4 | D1-L4, D1-L5, D1-J5 | covered (PENDING-KEY latency) |
| Q5 | The Stream is the source of truth for "money moved" | 5h | ARCH §5.1; SCH X10 | D1-L4; §5.2 "never cut" | covered |
| Q6 | Free-trial Streams follow the tip only; that is acceptable | 5h | FND §5 | P-13 | covered |

### 7.9 Stage view (5i)

| ID | Requirement | Brief | Spec | Tasks | Status |
|---|---|---|---|---|---|
| ST1 | One screen per active bet | 5i | ARCH §1.2 | D2-J3 | covered |
| ST2 | Both parties' photos and names | 5i | SCH §2.3 avatars; API §2.1; DM §5.1, §9, §11 | D2-J3, D5-L1, D5-M2 | **fixed-now**: avatars had no task (gap 3) |
| ST3 | Terms card | 5i | ARCH §3.2 | D1-J5, D2-J3 | covered |
| ST4 | Live judge transcript | 5i | API §2.6 (`voice/lines`) | D2-J3 | covered |
| ST5 | Evidence frames | 5i | SCH §5.2 `cited_frames` | D3-J4 | covered |
| ST6 | Ruling | 5i | ARCH §3.4 | D3-J4 | covered |
| ST7 | Escrow events streaming in, with Solana Explorer links | 5i | ARCH §8.3 | D1-J5 | covered (P0) |
| ST8 | Gemini price chart + countdown for the closer | 5i | FND §3.11 | D3-J5, D4-J4 | covered |
| ST9 | Demo mode: seeded accounts | 5i | DM §11 | D4-L4, D5-L1 | covered |
| ST10 | Demo mode: short timers | 5i | ARCH §7.2; SCH §9.3 | D1-L3 (`init-config`), D5-L1 | covered |
| ST11 | Demo mode: a toggle to play a pre-recorded fallback for any beat | 5i | ARCH §7.1–§7.2; API §2.17 | D5-J1, D5-J2, D5-L1 | **fixed-now**: the label is now REPLAY everywhere, and the remaining `/v1/demo/*` routes are tasked (gap 4) |

## 8. Performance targets (BRIEF §6)

| ID | Requirement | Brief | Spec | Tasks | Status |
|---|---|---|---|---|---|
| PF1 | Face match < 1 s | §6 | ARCH §4 | §6.5, D4-M1 | covered (PENDING-PHONE) |
| PF2 | Judge first audio < 1.5 s | §6 | ARCH §4 | §6.5, D2-J2 | covered (PENDING-KEY; post-tool marginal) |
| PF3 | Second on-phone authorization → lock confirmed < 2 s (AMENDED) | §6 | ESC §8.4; ARCH §4 | §6.5, D3-L3 | covered (PENDING-SOL/PHONE) |
| PF4 | Attempt → ruling < 4 s | §6 | ARCH §4 | §6.5, D3-J1 | **fixed-now**: TASKS started the clock at the STOP tap; it now uses ARCH §4's "bottle at rest" |
| PF5 | Concede/finalize → payout visible < 1 s | §6 | ARCH §4; SCH X10 | §6.5, D3-M2, D3-L3 | covered (only at `processed`) |
| PF6 | Everything works over cellular | §6 | ARCH §7.1 | T-CELL, §5.1 | covered |

## 9. Priorities (BRIEF §7, AMENDED)

| ID | Requirement | Brief | Spec | Tasks | Status |
|---|---|---|---|---|---|
| P0-1 | Escrow program + tests on devnet | §7 | ESC | D0-L1, D0-L2, D1-L1, D1-L2, D1-L3 | covered |
| P0-2 | Embedded wallets + fee sponsorship | §7 | FND §3.4; ESC §5.0 | D0-M3, D0-M4, D2-L2, D1-L6 | covered |
| P0-3 | Voice terms | §7 | SCH §3; API §4 | D0-J2, D0-J3, D1-J1, D2-J1, D2-M3 | covered |
| P0-4 | On-phone authorization (hold + Face ID) → lock | §7 | SCH §9; ESC §5.0 | D1-M2, D1-M5, D2-L1, D2-L2, D2-M1, D2-M2, D2-M4 | covered |
| P0-5 | Skill-challenge vision ruling | §7 | SCH §4–§5 | D2-J4, D3-M1, D3-J1, D3-J2 | covered (PENDING-KEY accuracy) |
| P0-6 | Payout UX (haptics + animation) | §7 | SCH X10; ARCH §5.2 | D3-L1, D3-M2 | covered |
| P0-7 | Face scan (room-scoped) | §7 | API §2.2–§2.4; DM §7.2 | D1-M3, D3-M3, D4-M1, **D0-J4**, **D1-M6** | **fixed-now**: gap 1 |
| P0-8 | QuickNode Stream → realtime updates | §7 | API §5; DM §8.2 | D1-L4, D1-L5, D1-J5 | covered |
| P0-9 | README skeleton | §7 | ARCH §9 | K-03 | covered |
| P1-1 | Hearing + appeals panel | §7 | SCH §6–§7 | D4-J1, D4-J2, D4-L1, D4-M3 | covered |
| P1-2 | Gemini BTC closer | §7 | SCH §8 | D1-J3, D1-J4, D4-L2, D4-J3, D4-M4 | covered |
| P1-3 | Head-to-head records | §7 | DM §7.1 | D4-L4, D4-M2 | covered |
| P1-4 | Stage view | §7 | ARCH §1.2 | D1-J5, D2-J3, D3-J4, D4-J4 | covered (the bare ticker was promoted to P0, TASKS §0) |
| P1-5 | Demo mode | §7 | ARCH §7.2; API §2.17 | D5-L1, D5-J1, D5-J2 | covered |
| P2-1 | Web link so a judge can accept without installing | §7 | API §2.5 (`challenge_method:'link'` reserved) | — | **deliberately-out-of-scope**: P2, cut-line #1. Judges watch; they don't play (BRIEF §2). |
| P2-2 | More real-world markets (NFL/NBA via Gemini) | §7 | — | — | **deliberately-out-of-scope**: P2, cut-line #1; Devpost "next" |
| P2-3 | Top-up flow | §7 | — | — | **deliberately-out-of-scope**: P2, cut-line #1. The internal treasury script D1-L6 is not the user flow. |

## 10. Build plan (BRIEF §8) and Phase 0 (BRIEF §9)

| ID | Requirement | Brief | Spec | Tasks | Status |
|---|---|---|---|---|---|
| BP1 | Fri: scaffold; escrow skeleton + tests; Expo app with auth + wallet; server skeleton | §8 | — | §4.1 (D0) | covered |
| BP2 | Sat: escrow complete on devnet; create/accept/resolve/finalize end to end "from the app"; Stream → webhook → push | §8 | ARCH §3.3 | §4.2 (D1) | covered (deliberate re-plan: Saturday's lock is custodial-signed, triggered from a phone; TASKS §10.2 item 6) |
| BP3 | Sun: ElevenLabs judge + terms flow; on-phone authorization → lock | §8 (AMENDED) | — | §4.3 (D2) | covered |
| BP4 | Mon: vision rulings + REDO; payout UX; face enrollment + matching | §8 | — | §4.4 (D3), D4-M1 | covered (deliberate re-plan: matching moves to Tue; TASKS §10.2 item 13, new) |
| BP5 | Tue: hearing + appeals; Gemini closer; head-to-head | §8 | — | §4.5 (D4) | covered |
| BP6 | Wed: stage view + demo mode; polish; testing with real users; bug bash | §8 | — | §4.6 (D5) | covered |
| BP7 | Thu: README + architecture diagram + bounty sections; video; Devpost; rehearse | §8 | ARCH §9 | §4.7 (D6) | covered |
| BP8 | Fri morning: final fixes; submit before 12 PM CST | §8 | — | §4.8 (D7) | covered |
| BP9 | Sponsor office hours Nov 16–19; have something to show by Monday | §8 | — | §7, D3-L4, D3-J3, P-14 | covered |
| PZ1 | Phase-0 spikes 1–6 (face; vision; Face ID signing in place of the handshake; ElevenLabs; Gemini; QuickNode) with results in FINDINGS | §9 | FND §2, §6 | P-05, P-11, P-12 | covered (PENDING-KEY/PHONE/SOL items per FND §6) |
| PZ2 | Draft docs: architecture diagram, data model, API contract, Terms/Ruling schemas, task breakdown | §9 | ARCH, DM, API, SCH, TASKS | — | covered |
| PZ3 | Checklist of accounts and keys (Apple, Expo/EAS, Anthropic, ElevenLabs, QuickNode, two more LLM providers, hosting, Postgres, Gemini) | §9 | SET §1 | P-07, P-13 | covered |

## 11. How to work (BRIEF §10)

| ID | Requirement | Brief | Spec | Tasks | Status |
|---|---|---|---|---|---|
| HW1 | TypeScript everywhere except the Rust program; shared Zod schemas | §10 | SCH §0; ARCH §1 | K-06, D0-J1 | covered |
| HW2 | Secrets in `.env`, never committed | §10 | SET §4, §7 | K-03, K-08, §3.2 rule 8 | covered |
| HW3 | Work in small, verified steps; run tests | §10 | — | §3.2 rules 2, 5; K-07 | covered |
| HW4 | Commit early and often with clear messages (history = evidence) | §10 | — | §3.2 rules 1–4 | covered |
| HW5 | Keep the README current as features land (setup, Mermaid, program IDs, Solana, Streams, ElevenLabs, Gemini, privacy, guardrails) | §10 | ARCH §9 | §8.1, **§3.2 rule 11** | **fixed-now**: no rule tied README updates to the feature PRs; Thursday was the first real fill |
| HW6 | Read the official docs first for any external API | §10 | — | **§0** | **fixed-now**: the rule was absent from TASKS |
| HW7 | Ask before signing up for paid services; say exactly which keys are needed and where they go | §10 | SET §1, §4, §7 | P-07, P-13, §2 | covered |
| HW8 | Optimize for the demo: fix whatever threatens a beat first | §10 | ARCH §7 | §5.1, §5.2, §1.3 | covered |

---

## 12. Contradictions with the amendment, the timing rule, or between docs

| # | Where | Contradiction | Resolution |
|---|---|---|---|
| X1 | TASKS D3-M2, D4-M3, §5.1 Mon | GG and "I appeal!" were "hold + Face ID". API O1, ARCH O-A1 and README question 5 say tap + Face ID, no hold. | **Fixed** in TASKS (§10.2 item 14). The hold stays for the stake authorization only. |
| X2 | TASKS D3-M3, D4-M1 | Old routes `POST /face/enroll` and `POST /rooms/:id/match`. | **Fixed:** `POST /v1/face/enrollment` and `POST /v1/rooms/:room_id/face-match` (API §2.2, §2.4). |
| X3 | TASKS §6.5, D3-J1 vs ARCH §4 | The attempt → ruling clock started at STOP in TASKS but at "bottle at rest" in ARCH. | **Fixed:** "bottle at rest" in TASKS; STOP → audio is also logged. |
| X4 | TASKS §6.7, D5-J1 vs ARCH §7.1, API §2.17, TASKS §8.1 | Fallback label "recorded" vs "REPLAY". | **Fixed:** REPLAY. |
| X5 | SET C2 vs TASKS P-10, FND §1 | USDC was "window only, from Fri evening" in SET, but P-10 collects $400 before the window. | **Fixed** in SET (C2, summary, master row, §6 step 13): collect into human-held addresses now, move it into product wallets in the window (D1-L6). Not a timing-rule breach: it is account setup, not product work. |
| X6 | TASKS §3.2 rule 9 (timing rule) | "The face model" was committed with no source; the only converted file is in `youre-on-spikes/`. The 20 eval clips are also pre-window. | **Fixed:** regenerated in the window by `scripts/face-model.sh` (D0-M2, sha256 check against spike 01's `ca17b05a…`); the clips stay out of git and are disclosed (ARCH §9 item 15). |
| X7 | TASKS vs BRIEF §8 Mon | Face matching moved from Mon to Tue without a recorded reason. | **Recorded** as a deliberate re-plan (TASKS §10.2 item 13). |
| X8 | BRIEF §1 pitch line | "makes a handshake enforceable" while D1 drops the handshake. | **Kept** as copy: D5-X2 frames "handshake" as the agreement, not a gesture. |
| X9 | BRIEF §5d, §8 Sat; FND §1 "Decision 2", §2.3 lock row, §3.7 "the spec today", §4 Beat 3 "Lock design not decided" | Stale text in read-only or non-editable files. | No action: D3 and D6 supersede them (planning README §E). |
| X10 | All docs vs the amendment | Checked every doc for a handshake, a binding spoken accept, or a face match that authorizes. | **None found.** The only mentions are "no handshake" statements and changelog history. |
| X11 | All docs vs the timing rule | Checked for repo creation, product code or product keys before Fri 18:00 UTC. | **None found.** The repo is K-01 at 18:00 UTC; product keys are window-only (SET §3); pre-window work is human setup and spikes. |

## 13. Gaps fixed now (where each edit landed)

| # | Gap | Edit |
|---|---|---|
| 1 | Rooms + challenge API + invite UI | TASKS **D0-J4** (new), **D1-M6** (new), D4-M1 depends on D0-J4 and adds the `match_ticket` check |
| 2 | USDC into the phone and demo wallets | TASKS **D1-L6** (new), D1-L5 depends on it; SET C2, the summary, the master row and §6 step 13 |
| 3 | Balance, history, avatars, face disable/consent | TASKS D3-L1 (balance reads), D3-M2 (balance header, GG tap), D3-M3 (skippable, consent v1, disable/delete, v1 route), D2-J3 (photos), D5-L1 (seed avatars), D5-M2 (history, avatar, copy audit) |
| 4 | Demo-control routes | TASKS D4-J1 (`force-hearing`), D5-L1 (`reset`, `lock-mode`, `toggles`, `stream/*`, `warmup`, `health`) |
| 5 | Pitch run-of-show + Q&A + criteria map | TASKS **D5-X2** (new); D5-X1 depends on it |
| 6 | Clean-clone setup run | TASKS **D6-X2** (new); §8.4 row 1 points at it |
| 7 | DoDs that didn't prove the requirement | TASKS D0-M4, D0-J3, D1-L4, D1-L5, T-SMK, D2-J1, D2-M1, D4-M1, D4-J1, D5-M2, §6.5 |
| 8 | Rules | TASKS §0 (official docs; traceability), §3.2 rules 9 and 11, §10.2 items 13–16, D0-M2 (face model), D0-J2 (ElevenLabs data retention); ARCH §9 item 15 |

## 14. Remaining risks (not closable in Phase 0)

| # | Risk | Rows | Closes | If it fails |
|---|---|---|---|---|
| 1 | The judge's post-tool read-back is 1.25–2.2 s (E) against 1.5 s; ElevenLabs may not serve `claude-haiku-5-5` | PF2, V4 | FND §6 steps 1, 9; D1-J2 | Fillers; Haiku 4.5; Speech Engine. Edit the README paragraph if the fallback ships (ARCH §8.2). |
| 2 | Vision accuracy is unmeasured (bar: 0 wrong winners) | P0-5, J5 | P-11 → P-12 step 2; D3-J2; D5-J4 | REDO; `cached_ruling` |
| 3 | The devnet atomic lock's CU, size and latency (both orders, cellular) are unmeasured | PF3, B3b | FND §6 steps 12–13; D3-L3; N11/N12 | `LOCK_MODE=sequential` (A first); REPLAY Beat 3 |
| 4 | The Face ID vs passcode method detection is an inference | O7 | FND §6 step 8; D1-M2 | Record `faceid_hold` only when it is known; the README says what is recorded |
| 5 | Stream → webhook latency and credit burn (credits shared with the RPC) | Q4, H19 | FND §6 steps 4, 6; P-13 | Fast lane; `replay_streams`; Build plan |
| 6 | iOS build path: no Mac, 24–72 h device processing, the stack has never been compiled together | all beats | P-04, P-06, D0-M2 | Spike builds before Friday; TestFlight for a late phone |
| 7 | Beat 6 pays ~T+17–20 s after expiry unless GG; liquidity at the finals slot is unmeasured | B6c | D1-J4; D5-X2 run-of-show | GG prompt; a labelled 50/50 on the next contract; REPLAY |
| 8 | Hearing ≤ 30 s depends on Opus-medium latency (PENDING-KEY) | PR6 | D4-J1 log | Shorter turns; Sonnet for the hearing; REPLAY Beat 5 |
| 9 | Load: this pass adds about 9 h (Fri E3 +2, Sat L +1 and E2 +1, Mon +1, Tue +0.5, Wed +2.5, Thu +1; D5-X2 counted once) to a plan already at ~80 h per person | — | TASKS changelog | Take it from bug-bash hours; rebalance per TASKS §1.3; the cut line |
| 10 | Requirements judged qualitatively ("use every day", "intentional design") have no pass/fail beyond the real-user test | H5, H6 | D5-M3 | Fix the top 5 issues it files |
| 11 | The event's rule on commits after the deadline is PENDING | T1, S1 | P-14 | No pushes to `main` after 12:00 CST Fri (TASKS §4.8) |
| 12 | The camera stack is undecided (VisionCamera + expo-camera in one app is untested) | B1a, B4a | D1-M1 | Open the two stacks one after the other, never together |

## Changelog

- **2026-11-08:** first version (completeness critic pass). 207 requirements from BRIEF (as amended) and D1–D7, mapped to spec and task. 33 rows fixed in place in TASKS, SETUP-CHECKLIST and ARCHITECTURE; 5 rows are deliberately out of scope; 11 contradictions checked (7 fixed or recorded, 2 kept or stale with no action, 2 checks found none).
- **2026-11-18:** J4 points at D10 (12 frames + the landing crop, branch `feat/attempt-capture`).
