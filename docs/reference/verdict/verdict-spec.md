# VERDICT — Working Spec v0.2

> **Bet your friends on anything you can film. Math rules on what it can, humans consent to the rest, and Solana pays out.**
>
> Working name: **Verdict** (renamed from Courtside to drop the single-sport framing).
> Status: **draft for discussion.** 🟡 = open decision, 🔴 = feasibility risk.
>
> **Changes since v0.1:** the product is general-purpose (any filmable bet, not one sport); bets compile into a rule program; computer vision judges and the LLM only reviews; settlement is optimistic (consent first); the rule engine runs onchain; ZK covers biometrics and oversized runs; identity checks run only when a bet names a specific person; perception runs on a decentralized GPU network with cross-checking; UI is Flutter, held to a strict minimalism standard.

---

## 0. TL;DR

1. **Point your phone at your friends.** Face recognition resolves each person to their wallet. No addresses, no QR codes.
2. **Say the bet out loud.** ("I bet my friend can't get a paper ball in the trash can from across the room.") An LLM **compiles** it into a small rule program over objects, people and regions, asks clarifying questions, and reads it back. Each counterparty's voiceprint plus a spoken "I accept" binds them to it. The program's hash goes onchain.
3. **Scene check.** The camera labels every entity the rules refer to ("Friend", "Paper ball", "Trash can") and shows each condition live. Players fix any wrong label, take a practice attempt, then stake.
4. **Everyone stakes evenly** into a Solana escrow (USDC, gas sponsored, embedded wallets).
5. **Prop up a phone and play.** One camera is enough. Footage is sealed as it's captured, and every other phone in the huddle records audio as an independent witness.
6. **Computer vision tracks the entities** on a decentralized GPU network, run on two independent hosts and cross-checked. **Identity checks (face, plus voice when someone speaks) run only if a win condition names a specific person.**
7. **The Solana program runs the rule program** on the sealed tracking data and computes the outcome. Players see a pre-ruling and sign Agree or Dispute.
8. **Disputes go to the replay booth**: AI advocates argue over short clips around the decisive moments and an AI judge panel rules. This is the only trusted path, and it's labeled as such.
9. **ZK proofs** prove biometric matches without publishing any face or voice data, and compress runs too large to post onchain.

---

## 1. Prize Strategy

### 1.1 Target stack

| Prize | Amount | Fit | How Verdict qualifies |
|---|---|---|---|
| **Consumer Applications — Track Winner** | $2,000 | Primary | Social app; embedded wallets, sponsored gas, no seed phrases, no addresses; polished Flutter app |
| **Best use of Solana** (Consumer) | $1,500 | Strong | Onchain rule interpreter, SPL USDC escrow, Groth16 verification via `alt_bn128` syscalls |
| **Official UBC 2026 Winner** (auto) | 1st $2,500 + ElevenLabs Pro / 2nd $1,000 / 3rd $500 | Strong | Rule-of-cool density |
| **Gemini Prediction Markets** | 1st $2,500 / 2nd $1,000 / 3rd $500 | Strong if done for real | World Mode: peer-to-peer side bets on real events, stakes calibrated to Gemini odds (§5.11) |
| **QuickNode Streams** | $500 | Strong, cheap | Program-log stream on Solana devnet → webhook → live bet state, notifications, settlement triggers (§5.11) |
| **ElevenLabs** | 3 mo. Scale / member | Strong | Spoken bets (Agents), diarized transcripts for identity and evidence (Scribe), verdict announcer (TTS), start signal (Sound Effects) |
| **Grok Bot** | Mechanical keyboard / member | Weak 🟡 | Stretch; confirm eligibility with sponsor first (§5.11) |
| Participation prize | Perks | Auto | Meet every "What to Submit" item |

**Chain award: Solana.** It pays $500 more than Arc, has a mature Groth16 verifier (`groth16-solana`) and an SP1 verifier (`sp1-solana`), and QuickNode Streams supports Solana devnet program logs.

### 1.2 Theoretical max (cash)
Consumer Track $2,000 + Solana $1,500 + Official 1st $2,500 + Gemini 1st $2,500 + QuickNode $500 = **$9,000**, plus ElevenLabs Scale + Pro, keyboards if Grok lands, and participation perks.

### 1.3 Finalist paths
Four ways onto the 13-team stage: top Consumer contender, top Consumer-Solana contender, top-3 Official contender, Gemini 1st place.

### 1.4 Requirement checklist
- [ ] Public GitHub repo, setup instructions, README with architecture
- [ ] Working app + 2–3 min demo video **with audio showing ElevenLabs**
- [ ] Interacts with blockchain; working user-facing frontend (Consumer)
- [ ] Program ID(s) + "how we use Solana" section in README
- [ ] ElevenLabs products used + how, in README
- [ ] Gemini Prediction Markets API used
- [ ] QuickNode Stream config (network, dataset, filter, destination) + why, in README
- [ ] (Stretch) Grok Bot chat export + 3–4 sentence README section
- [ ] Devpost: Consumer track, chain award = Solana, opt into Gemini / ElevenLabs / QuickNode (/ Grok)
- [ ] Team physically present Sat Nov 21

---

## 2. Design Principles

1. **Math rules on what it can.** Deterministic computer vision plus a deterministic rule engine decide outcomes. The LLM compiles bets and reviews disputes; it is never the default judge.
2. **Consent first.** The strongest oracle is the signatures of the people with money at stake. Most bets should settle on Agree.
3. **Checkable, not trusted.** Every input is sealed when it's captured; every computation is either onchain, ZK-proven, or re-runnable from pinned open models. Anything that's trusted is labeled as trusted.
4. **Compute only what the bet needs.** Identity checks, extra camera angles and proofs run only when the compiled rules require them.
5. **One camera is a first-class case.** Audio witnesses, gap-free hash chains and freshness beacons make a single camera verifiable.
6. **No ornament.** The UI is as quiet as the Linear home page (§6).

---

## 3. Core Flows

### 3.1 Enrollment (one-time, ~30 s)
1. Sign in with Google, email or passkey → embedded Solana wallet created silently.
2. **Face:** 3–5 frames with a randomized head-turn liveness prompt.
3. **Voice:** read 3 random challenge phrases.
4. Embeddings are computed, quantized and stored encrypted in the backend, keyed to the wallet. **Onchain only a commitment:** `Poseidon(quantized_embedding, salt)` per modality in the user's Profile PDA.
5. Explicit biometric consent, with a delete action that actually deletes.

### 3.2 Pay-by-Face
Point the camera at someone in your huddle → closed-set match → confirm name → enter amount → send USDC. Falls back to voice if face confidence is low.

### 3.3 Create a bet
1. Creator opens a **Huddle** (room code + proximity); friends join on their phones.
2. Creator pans the camera across the group; every enrolled person is added.
3. Creator speaks the bet. The ElevenLabs Agent transcribes it and the LLM compiles it into a rule program (§5.1), asking clarifying questions when the wording is ambiguous ("Where is the throw line?", "How many attempts?").
4. Plain-English read-back of the **compiled program**, not the original sentence.
5. Each counterparty says **"I accept."** Scribe diarizes it; the speaker embedding is verified against that participant's voiceprint. A passkey tap on their own phone authorizes the stake. Voice is the ritual; the device signature is the security.
6. `program_hash` and the acceptance audio hash go onchain in `create_bet`.

### 3.4 Scene check
1. Camera frames the scene; the rule program's entities are detected by text prompt and labeled.
2. Users tap to correct a wrong or missing label; tap to place regions (lines, zones).
3. Each condition shows a live state dot.
4. Optional practice attempt to confirm conditions flip as expected.
5. Calibration (entity references, regions, camera pose) is hashed into the bet.

### 3.5 Fund
Equal stakes into a PDA-owned USDC vault (odds-weighted stakes only in World Mode). Backend is fee payer. QuickNode Stream marks the bet live when all deposits land.

### 3.6 Record
1. Any participant or bystander can be a camera witness; every other huddle phone is automatically an **audio witness**.
2. Start signal: an ElevenLabs-generated sound that encodes a recent Solana blockhash. It provides shared time zero for syncing devices and proves the footage was recorded after that slot.
3. 5-second chunks, hash-chained (each chunk hash includes the previous one), hashes uploaded before chunk bodies, rolling roots committed onchain every ~30 s.
4. End by tapping End or when the program's time limit expires.

### 3.7 Settlement
1. Perception runs on the sealed footage (§5.2), plus identity checks only if required (§5.3).
2. Rule program executes onchain over the sealed tracking data → **pre-ruling**.
3. Each party signs **Agree** or **Dispute**. Silence after the window counts as Agree.
4. All Agree → settle. Any Dispute (with bond) → replay booth (§5.9) → settle with the panel's ruling.
5. Timeouts refund permissionlessly. Low-confidence outcomes resolve to **No contest** → full refund.

---

## 4. Architecture

```
 ┌──────────────────────────── Phones (Flutter, iOS + Android) ───────────────────────────────┐
 │ Camera witness: chunk recorder → hash chain        Audio witnesses: mic → hash chain       │
 │ On-device face detect (ML Kit) · Embedded wallet (passkey) · Huddle · Scene check          │
 └──────────┬──────────────────────────────┬───────────────────────────────┬──────────────────┘
            │ enroll / match               │ chunks + hashes               │ signed txs
            ▼                              ▼                               ▼
 ┌─────────────────────┐   ┌─────────────────────────────────┐   ┌──────────────────────────────┐
 │ Identity Service    │   │ Evidence Service                │   │ Solana devnet: Verdict prog. │
 │ face + speaker emb. │   │ storage, Merkle roots, beacon   │──▶│ profiles (commitments)       │
 │ closed-set matcher  │   │ decode, cross-device sync       │   │ bets + escrow vaults         │
 │ identity timeline   │   └───────────────┬─────────────────┘   │ evidence roots               │
 └─────────┬───────────┘                   │                     │ rule interpreter             │
           │ (only for actor-bound legs)   ▼                     │ Groth16 / SP1 verify         │
           │                ┌─────────────────────────────────┐  │ consent + dispute bonds      │
           └───────────────▶│ Perception jobs (Nosana ×2)     │  └──────────────┬───────────────┘
                            │ SAM 3 tracks → cross-check      │                 │ program logs
                            │ → sealed track data             │                 ▼
                            └───────────────┬─────────────────┘  ┌──────────────────────────────┐
                                            ▼                    │ QuickNode Stream → webhook   │
 ┌──────────────────────────┐   ┌──────────────────────────────┐ │ → bet state, notifications,  │
 │ Bet Compiler (LLM)       │   │ Replay Booth (LLM panel)     │ │   settlement triggers        │
 │ speech → rule program    │   │ disputes + uncovered bets    │ └──────────────────────────────┘
 └──────────────────────────┘   └──────────────────────────────┘
 ┌──────────────────────────┐   ┌──────────────────────────────┐
 │ Provers: circom/snarkjs  │   │ Gemini PM adapter (World)    │
 │ + SP1 via prover network │   │ REST events + WS prices      │
 └──────────────────────────┘   └──────────────────────────────┘
```

### 4.1 Trust map

| Component | Where it runs | Trust status |
|---|---|---|
| Capture + sealing | Players' phones | Checkable: hash chains, onchain roots, freshness beacon, audio cross-check |
| Bet compilation | LLM API | Checkable: players approve the compiled program before staking |
| Perception | Nosana, two independent hosts | Checkable: cross-checked; pinned open weights; anyone can re-run |
| Identity matching | Identity service | Proven: ZK match against onchain commitments |
| Rule execution | Solana program | Onchain |
| Oversized rule runs | SP1 via Succinct prover network | Proven |
| Consent settlement | Players' signatures | Onchain |
| Replay booth | LLM APIs | **Trusted, labeled** |
| Orchestration | Our backend | Can't change an outcome without detection |

---

## 5. Components

### 5.1 Bet compiler and rule language

The LLM translates speech into a small, typed rule program. Players approve the program, and its hash is what everything downstream binds to.

**Entities**
- `person(participant)` — bound to a participant's identity
- `object("noun phrase")` — open-vocabulary, kept to simple nouns (the vision model handles nouns; the rule engine handles relations)
- `region(tap)` — lines, zones, openings placed during scene check

**Primitives (~15)**
- Relations: `overlaps`, `inside`, `above`, `below`, `near`
- Motion: `moving`, `at_rest(duration)`, `speed`, `direction`
- Events: `enters`, `leaves`, `disappears_into`, `touches`, `crosses(line)`, `released_by(person)`
- Time and logic: `then_within`, `for_duration`, `count`, `before_deadline`, `and`, `or`, `not`
- Optional pose attributes (MediaPipe): `standing`, `rep_count` for exercise-style bets

**Example**
```yaml
version: 2
entities:
  shooter: person(<friend_pk>)
  ball:    object("crumpled paper ball")
  can:     object("trash can")
  line:    region(tap)
legs:
  - id: 1
    actor_bound: true            # names a specific person → identity pipeline on
    valid_attempt: ball released_by shooter while shooter behind line
    success: ball disappears_into can.opening
             or (ball inside can and ball at_rest 1s)
    rule: count(success) >= 1 within attempts 3
outcome: side(shooter) wins iff leg 1 true; else side(creator)
stake_each: 5_000_000
time_limit_s: 180
```

**`actor_bound` flag.** The compiler sets `actor_bound: true` on any leg whose condition requires a **specific person** to do something. This flag gates the whole identity pipeline (§5.3). Bets with no actor-bound legs ("the cup tower survives the fan for 10 s") skip in-game identity entirely.

**Compiler rules**
- Ambiguity is resolved with clarifying questions before staking, never guessed.
- Bets that can't be expressed in the language compile to an **AI-judged** program, labeled as such before anyone stakes.
- Output is validated against the schema; invalid programs are rejected and recompiled.

### 5.2 Perception

- **Final tracking:** SAM 3 (open-vocabulary detection, segmentation and tracking from text prompts) on GPU.
- **Live scene check:** a lighter real-time detector (e.g., YOLO-World, boxes only) for the overlay.
- **Output:** per-frame tracks `{entity, track_id, bbox, mask_area, t, confidence}` → quantized to integers → sealed as a Merkle root.
- **Decisive windows:** the rule engine flags frames where conditions change; those windows are what gets posted onchain and what the replay booth sees.

**Known hard cases**
- **Containment:** a successful shot often disappears into the container. `disappears_into` = last seen descending inside the opening, never seen outside for N seconds.
- **2D vs 3D:** an object behind a container overlaps it on screen. Mitigate with a second angle, an audio impact cue, or descent-trajectory checks.
- **Small, fast objects:** motion blur; require tripods or clamps and decent lighting.
- **Camera motion:** a still camera is mandatory; detect motion and flag low confidence.

### 5.3 Identity: face and voice

**Closed-set by design.** Matching only ever happens against participants in the current huddle (2–10 people). That turns a hard recognition problem into an easy verification among a handful of known people, and keeps it within the privacy story.

| | Face | Voice |
|---|---|---|
| Detection | ML Kit / MediaPipe face detection | VAD + ElevenLabs Scribe diarization |
| Embedding | ArcFace/FaceNet-class model | ECAPA-TDNN speaker embedding (SpeechBrain) |
| Match rule | cosine ≥ τ **and** margin over 2nd-best ≥ δ | same |
| Liveness | randomized head-turn at enrollment and pay | random challenge phrase at enrollment and acceptance |

**Always on (regardless of the bet):** enrollment, huddle membership, pay-by-face, the spoken "I accept."

**In-game identity — conditional:**
- **If any leg is `actor_bound`:** whenever humans are in the shot, the system continuously verifies who's who.
  - **Faces:** verify every person track at 2–5 fps; propagate identity along the track between checks.
  - **Voices:** whenever anyone speaks (VAD), diarize with Scribe and verify each segment against the huddle's voiceprints.
  - **Identity timeline:** face and voice evidence is fused into a per-track identity confidence that accumulates over time, so a person who turns away or goes silent keeps their identity from earlier strong matches. Clothing and body re-identification bridges gaps where faces aren't visible.
  - **Decisive moments** (e.g., `released_by(shooter)`) require identity confidence above threshold at that moment, or the leg resolves to low confidence → replay booth or No contest.
- **If no leg is `actor_bound`:** no in-game face or voice verification runs. Person tracks stay anonymous and compute is saved.

**Why fuse face and voice:** faces fail on turned heads and occlusion; voices fail in noise and are easy to clone. Each covers the other's blind spot, and the challenge phrase answers "can't I just clone your voice?"

### 5.4 Evidence integrity
- **Gap-free hash chains** per witness device; the onchain program checks chunk indices are continuous from start to end.
- **Freshness beacon:** the start signal encodes a recent blockhash; rolling onchain roots bound the end. Footage is provably recorded inside the bet's window.
- **Audio witnesses:** every non-camera phone records audio and seals it the same way. Scribe's audio event tags (impacts, speech, reactions) and beacon timing must agree with the video's timeline. One biased camera has to agree with independent microphones held by the other side.
- **Sealed derivatives:** perception tracks are sealed with a hash of the pinned model and settings, so anyone can re-run from the raw footage and challenge a mismatch.

### 5.5 Decentralized perception compute
- **Primary:** Nosana (Solana-native GPU marketplace; jobs, payments and staking coordinated by Solana programs). Each perception run has an onchain job record that's linked from the bet receipt.
- **Cross-check:** every perception job runs on **two independent hosts**. Tracks are compared by overlap (IoU) and event-timing tolerance, not identical bytes, since GPUs aren't bit-for-bit deterministic. Agreement → seal. Disagreement → replay booth.
- **Fallback:** the same container on io.net or a conventional cloud GPU; switching is a config flag. Rehearse the switch.
- **Practical notes:**
  - Use a market with 24 GB-class GPUs; SAM 3 video needs the headroom.
  - SAM 3 weights (~4 GB, gated on Hugging Face) are built into the image; keep a warm job during the demo instead of cold-starting per bet.
  - These networks run on mainnet with real funds while bets run on devnet. Fund compute from a team wallet; the receipt shows both the mainnet job and the devnet settlement.
- **Phones as nodes:** each phone also runs lightweight detection on its own view and commits the result, adding another independent cross-check.

### 5.6 Settlement paths (optimistic)

| Path | Trigger | What settlement verifies | Trust |
|---|---|---|---|
| **Consent** | All parties Agree (or silence after the window) | Signatures from every party over the bet and evidence root | None beyond the players |
| **Rule** | Disputed pre-ruling resolved by re-run, or explicit rule settlement | Onchain execution of the approved program over sealed tracks; ZK biometric proofs for actor-bound legs | Perception (checkable) |
| **Panel** | Dispute bond posted; uncovered or low-confidence legs | 2-of-3 judge quorum over committed evidence | **Trusted, labeled** |
| **Refund** | Timeout, No contest, cancel before funding | State + timer | None |

- **Dispute bond:** forfeited if the panel upholds the pre-ruling.
- **Silence = consent** after the window, so a losing party can't stall by ghosting.

### 5.7 Onchain program (Anchor, Solana devnet)

**Limits to design against:** 1.4M compute units per transaction (200K per instruction default); transactions up to 4,096 bytes in the v1 format (1,232 bytes in legacy/v0). No practical floating point: everything is fixed-point integers.

**Accounts**
- `Profile` PDA `[b"profile", wallet]` — `face_commit`, `voice_commit`, `display_name`
- `Bet` PDA `[b"bet", creator, nonce]` — participants (≤8), stakes, mint, `program_hash`, `calibration_hash`, acceptance audio hash, state, deadlines, evidence roots, consent bitmap, dispute bond, `winner_mask`
- `Vault` — PDA-owned USDC token account
- `TrackBuffer` — decisive-window track data, written in one or a few transactions, closed after settlement to reclaim rent

**State machine**
```
Proposed ─fund×N→ Funded ─start→ Live ─end→ Perceiving ─post_tracks→ PreRuled
   │                                                                   │
   └─cancel→ Refunded                       ┌──────────────────────────┤
                                            │ all Agree / window       │ Dispute + bond
                                            ▼                          ▼
                                         Settled ◄──panel ruling── Disputed
                                            ▲
                       timeout / No contest ┴──→ Refunded
```

**Instructions:** `init_profile`, `create_bet`, `fund`, `cancel`, `start`, `commit_evidence`, `end`, `post_tracks`, `run_rules`, `consent`, `dispute`, `settle_panel`, `verify_biometric_proof`, `verify_sp1_run`, `refund`.

**Rule interpreter.** The program is an interpreter for the bet language: it loads the approved program (matching `program_hash`), reads the decisive-window tracks from `TrackBuffer`, evaluates the legs, and writes the pre-ruling. A typical decisive window (3 entities × 4 coordinates × 10 fps × 6 s ≈ 1.4 KB) fits in a single v1 transaction and evaluates in thousands of compute units.

**Gas abstraction:** backend wallet is fee payer; users only sign as authority. Devnet USDC from the Circle faucet; onboarding auto-drips demo funds.

### 5.8 ZK proofs

**Where ZK is used and why:** onchain execution provides transparency; ZK provides **privacy** (proving a fact about data that's never published) and **compression** (proving a computation too large to post). Neither makes the input data truthful; that's what sealing, cross-checking and disputes are for.

**1. Biometric match (circom + snarkjs → Groth16 → `groth16-solana`).** Runs only for `actor_bound` legs.
- Public inputs: `bet_id`, participant face/voice commitments, `evidence_root`, decisive-moment index, result bit.
- Proves: the enrolled embedding opens the onchain commitment (`Poseidon`); the identity-timeline embedding at the decisive moment matches it (cosine via `dot > 0 ∧ dot² ≥ τ² · ‖e‖² · ‖o‖²` in fixed point); no embedding is revealed.
- Small circuit; proves in seconds on a laptop CPU. Single-party phase-2 trusted setup on public Powers of Tau, stated in the README.

**2. Oversized rule runs (SP1 zkVM → `sp1-solana`).** For games whose track data is too large to post.
- The same rule engine, written once in Rust, runs inside SP1 and proves that the approved program over the sealed tracks yields the outcome.
- Verification ~280K compute units; raise the limit explicitly.
- Proof generation through Succinct's prover network (decentralized; local proving needs far more hardware than a laptop).

**What the proofs do not show:** that the vision model drew the boxes correctly, or that the replay booth reasoned correctly. Say so up front.

**Fallback ladder:** (a) drop SP1, keep onchain execution over decisive windows only; (b) drop the voice clause, keep face; (c) verify identity with signed attestations and present the circuit as in progress.

### 5.9 Replay booth (LLM panel)
Runs only on disputes, uncovered (AI-judged) bets, or low-confidence decisive moments.
- **Input:** short clips around the decisive frames the rule engine flagged, the compiled program, the identity timeline, diarized transcripts. Never the whole video.
- **Advocates (one per side):** cite exhibits as `witness@timestamp`; footage from your own device earns one extra exhibit slot.
- **Judges (×3, mixed models):** one video-native model plus frame-sampled multimodal models.
- **Commit-reveal:** judges commit verdict hashes before any are revealed.
- **Ruling:** 2-of-3; below confidence floor → No contest.
- **Signatures:** each judge signs `(bet_id, outcome, evidence_root)`; `settle_panel` verifies the quorum.
- **Roadmap:** zkTLS to prove responses came from the named model provider (currently alpha tooling and impractical for video payloads); independent judge operators or TEEs.

### 5.10 Compute and hardware

| Workload | Where |
|---|---|
| Flutter app, Anchor program, rule engine, circom circuits | Team laptops (incl. RTX 3050 laptop) |
| Face/voice embeddings, lightweight detection | Laptop or phone |
| SAM 3 video tracking | Nosana (24 GB-class GPU), fallback cloud GPU |
| SP1 proofs | Succinct prover network |
| Compiler, replay booth | Model APIs |

A laptop RTX 3050 (typically 4–6 GB VRAM) can't run SAM 3 on video or prove SP1 locally. Check with `nvidia-smi`.

### 5.11 Sponsor integrations

**ElevenLabs (core, not decoration)**
| Use | Product |
|---|---|
| Spoken bet creation, clarifying questions, read-back | Agents (+ Scribe Realtime) |
| "I accept" attribution; in-game speaker segments for the identity timeline | Scribe (diarization, audio event tags) |
| Verdict announcer (audio only) | TTS |
| Start signal / blockhash beacon | Sound Effects |

Speaker *verification* is our ECAPA model; ElevenLabs supplies diarized segments. State this precisely in the README.

**Gemini Prediction Markets — World Mode**
1. Browse Gemini events inside the bet composer (public REST, no key).
2. Odds-calibrated stakes: a 70/30 market proposes a 70/30 stake split.
3. Parlay pricing from leg probabilities.
4. Live price via WebSocket while the bet is open.
5. 🔴 Resolution from Gemini event data; verify which settlement fields the API exposes before committing.
6. Stretch: hedge order via OAuth in Gemini's demo environment.

**QuickNode Streams**
- Solana devnet, program logs filtered to the Verdict program ID.
- Filter parses Anchor events (`BetCreated`, `Funded`, `EvidenceCommitted`, `PreRuled`, `Disputed`, `Settled`).
- Webhook (HMAC validated) → live bet state in the app, push notifications, triggers for perception and settlement, leaderboard backfill.
- README: why Streams (ordered, guaranteed delivery; triggers can't miss events).

**Grok Bot 🟡** — Ask the sponsor at office hours whether xAI API usage (e.g., Grok as one replay-booth judge) qualifies before spending time.

---

## 6. UI Specification

### 6.1 Platform
- **Flutter**, iOS and Android from one codebase.
- Key packages to evaluate: `camera`, `google_mlkit_face_detection`, an audio recorder, `crypto` for hashing, a Dart Solana client, and an embedded-wallet provider with a Flutter SDK and Solana support (verify: e.g., Web3Auth, Privy).

### 6.2 Visual standard
The UI must be as clean as the Linear home page. No miscellaneous bells and whistles.

- **Type:** one sans-serif family (e.g., Inter), two weights, a small type scale.
- **Color:** monochrome, dark by default, one accent color reserved for the primary action and live state.
- **Layout:** 8-pt spacing grid, generous whitespace, hairline dividers.
- **Motion:** functional transitions only, ≤200 ms, no bounce or spring.
- **Icons:** one outline set, used sparingly.
- **Money:** shown in dollars. Never show addresses, token names or chain jargon in primary UI.

### 6.3 Copy rule
**Nothing has a sentence description below it.** No subtitles, helper text, captions, card descriptions, empty-state paragraphs, onboarding blurbs or explanatory tooltips. Labels are 1–3 words. Errors are short noun phrases ("Face not matched").

### 6.4 Banned
Confetti, gradients, illustrations, mascots, emoji, achievements or badges, carousels, decorative sounds, gamified meters, marketing copy, splash animations.

### 6.5 Screen inventory

| Screen | Elements |
|---|---|
| Sign in | Wordmark · Continue with Google · Continue with email |
| Enroll | Camera · Face · Voice · Done |
| Home | Balance · New bet · Bets list (title, stake, state) · Pay |
| Huddle | Camera · Participant chips · Continue |
| Terms | Dictate · Who · What · Stake · Limit · Question chips · Acceptance status per participant · Accept |
| Scene check | Camera with entity labels · Region placement · Condition rows with state dots · Practice · Stake |
| Record | Viewfinder · Timer · Witness count · End |
| Ruling | Outcome · Amount · Agree · Dispute |
| Receipt | Verified · Terms · Evidence · Compute · Proof · Settlement (each a link row) |
| Pay | Camera · Name · Amount · Send |
| World | Search · Event · Odds · Stake split · Propose |

---

## 7. Stage Demo (5 min + 2 min Q&A)

**Setup:** a table of pre-tested props (paper balls, trash can, cups, ring toss), two phone clamps, a backup pre-recorded full-flow video, and a warm perception job.

| Time | Beat |
|---|---|
| 0:00 | Pan the camera across two teammates → names resolve. |
| 0:25 | Spoken bet: "I bet she can't get a paper ball in the can from behind that line." The compiler asks where the line is; read-back; spoken "I accept" → voiceprint verified. |
| 0:55 | Scene check: entities labeled, condition rows live, one practice toss flips the dots. Stake. |
| 1:20 | Attempt filmed by one clamped phone; other phones are audio witnesses; the start signal plays. |
| 2:00 | Pre-ruling appears; both tap Agree → settles instantly. The announcer reads it. |
| 2:30 | **A judge invents a bet** using props on the table. Compile, scene check, play. |
| 3:30 | Open the Receipt: program hash, sealed evidence, Nosana job links (two hosts agreed), biometric proof, settlement. One sentence per row on what each guarantees. |
| 4:10 | World Mode: real-event side bet with Gemini-calibrated stakes. |
| 4:40 | Close: "Math rules on what it can. Humans consent to the rest." |

---

## 8. Build Plan

**Timeline:** kickoff Thu Nov 12 6 PM CST · build Fri Nov 13 noon → **submit Fri Nov 20 noon CST** · finalists notified by 11:59 PM Nov 20 · stage Sat Nov 21. Before Nov 13: design, accounts, API keys, Nosana and Succinct setup, faucet funds, docs. No code.

**Roles (4-person team)**
- **A — Chain + ZK:** Anchor program, rule interpreter, biometric circuit, SP1, QuickNode.
- **B — Vision + identity:** perception pipeline, Nosana jobs + cross-check, face/voice embeddings, identity timeline.
- **C — Language + sponsors:** compiler + rule schema, ElevenLabs, replay booth, Gemini.
- **D — Flutter:** all screens to the §6 standard, wallet, recording + hashing, demo video, README.

**Day by day**
| Day | Goal |
|---|---|
| Fri 13 (pm) | Repo, schema v1, Anchor skeleton (create/fund/consent/settle), Flutter shell + sign-in |
| Sat 14 | Enrollment + huddle matching; escrow end-to-end on devnet USDC; compiler produces valid programs for 3 bet types |
| Sun 15 | Recording + hash chains + onchain roots; SAM 3 tracking on any GPU; rule engine in Rust (off-chain) |
| Mon 16 | Rule interpreter onchain; scene check UI; spoken acceptance; attend workshops |
| Tue 17 | Conditional identity timeline; biometric circuit + verify; QuickNode Stream; Gemini World Mode data |
| Wed 18 | Move perception to Nosana ×2 with cross-check; replay booth v1; audio witnesses; rehearsal #1 |
| Thu 19 | Feature freeze 6 PM; polish; README; demo video; Devpost |
| Fri 20 | Submit by ~9 AM; rehearse |

**Cut lines**
- **Must:** Flutter app to §6 standard, enrollment + huddle, compiler for a few primitives, scene check, recording + hash chains, perception (any GPU), onchain rule interpreter, consent settlement, devnet escrow, README, video.
- **Should:** conditional identity timeline + voice, biometric ZK proof, replay booth, QuickNode Stream, Gemini World Mode (data + calibrated stakes), Nosana ×2 cross-check, audio witnesses, blockhash beacon.
- **Stretch:** SP1 oversized runs, Gemini resolution + hedge, pose primitives, Grok, zkTLS.

---

## 9. Risks and Feasibility

1. 🔴 **Scope.** Many hard subsystems in seven days. The cut lines exist so a slipped "Should" never breaks the demo.
2. 🔴 **Perception robustness.** Small fast objects, containment and 2D-vs-3D ambiguity. Test real props on Day 2; keep the demo props to known-good ones.
3. 🔴 **Compiler reliability.** Constrain output to the schema, validate, and show the read-back; a wrong program is caught at scene check, before money moves.
4. 🟡 **Identity in motion.** Faces turn away constantly; the identity timeline and re-identification carry identity between strong matches. Low confidence at a decisive moment resolves to replay booth or No contest, never a guess.
5. 🟡 **Decentralized compute.** Availability and cold starts; keep a warm job and a rehearsed fallback.
6. 🟡 **Honest ZK framing.** Proofs cover privacy and compression, not perception correctness.
7. 🔴 **Legal surface:** real-money peer-to-peer wagering is regulated differently by jurisdiction, and several US states have biometric privacy laws (e.g., Illinois' BIPA) that require informed consent and deletion. Devnet funds only, visible consent flow, one-line answer ready for judges.
8. 🟡 **Track fit.** Lead the pitch with the experience, not the cryptography.

---

## 10. Open Questions

1. Team size and strengths (Rust/Anchor, vision/ML, Flutter)?
2. Keep the name Verdict?
3. Which 3 bet types are guaranteed for the demo?
4. Gemini depth: data-only, resolution loop, or hedge?
5. Is Grok worth any time, pending the sponsor's answer?
6. Embedded-wallet provider for Flutter + Solana?

---

## 11. References
- groth16-solana: https://lib.rs/crates/groth16-solana
- sp1-solana: https://docs.rs/crate/sp1-solana/latest
- SP1 hardware requirements: https://docs.succinct.xyz/docs/getting-started/hardware-requirements
- Solana larger transactions: https://solana.com/upgrades/larger-transaction-sizes
- Solana compute budget: https://docs.chainstack.com/docs/solana-compute-budget
- SAM 3 overview: https://voxel51.com/glossary/sam-3-segment-anything-model-3
- Nosana: https://solanacompass.com/projects/nosana
- io.net: https://solanacompass.com/projects/ionet
- Gemini Prediction Markets: https://developer.gemini.com/prediction-markets/getting-started
- ElevenLabs Speech to Text: https://elevenlabs.io/docs/overview/capabilities/speech-to-text
- QuickNode Streams supported chains: https://www.quicknode.com/docs/streams/supported-chains
