# Verdict

**Bet your friends on anything you can film. Math rules on what it can, humans consent to the rest, and Solana pays out.**

## The experience

1. **Point your phone at your friends.** Everyone in the huddle is recognized by face and resolved to their wallet. Nobody types an
   address or scans a QR code.
2. **Say the bet out loud.** For example: "I bet I can get this paper ball in the bin from the line, 3 tries, $5." A voice agent asks
   what's ambiguous ("Where is the throw line?") and reads back the **compiled rule program**, not your original sentence.
3. **Each counterparty says "I accept."** Their voice is matched to their enrolled voiceprint, and a passkey tap on their own phone
   signs the acceptance.
4. **Scene check.** The camera labels every entity the rules mention ("Friend", "Paper ball", "Bin"). You place the throw line and
   watch each condition's live dot flip during a practice attempt.
5. **Stake.** Everyone's USDC goes into a Solana escrow. The backend pays the gas, and the wallet is embedded in the app.
6. **Prop up one phone and play.** A start sound carries a recent Solana slot hash. Footage is hash-chained as it's recorded, and every
   other phone in the huddle records audio as a witness.
7. **The ruling.** Computer vision turns the footage into tracks, and the Solana program runs the rule program on them to produce a
   pre-ruling. Everyone taps **Agree** or **Dispute**. Silence counts as Agree.
8. **Disputes go to the replay booth.** AI advocates and a 3-judge AI panel rule on short clips. This is the one trusted step, and it is
   labeled **Trusted** wherever it appears.
9. **World Mode.** Bet a friend on a real-world event from Gemini Prediction Markets. The stakes are split by the market's odds.

- Product spec: [`verdict-spec.md`](verdict-spec.md)
- Binding interface contract: [`docs/CONTRACTS.md`](docs/CONTRACTS.md). Implementation decisions are in
  [`docs/CONTRACTS-ERRATA.md`](docs/CONTRACTS-ERRATA.md).

---

## Setup

### Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Node.js | ≥ 20 (≥ 22.6 for `circuits/scripts/vk-to-rust.ts`, which uses type stripping) | engine, backend, demo, circuits |
| Rust + Anchor | Rust stable, Anchor **0.32.1**, Agave CLI as pinned in `Anchor.toml` (`3.0.11`; the contract asks for 2.x, see errata `[anchor]` 12) | `crates/verdict-rules`, `programs/verdict` |
| circom + snarkjs | circom 2.1.x (native, or the pinned `circom2` wasm package in `circuits/`) and snarkjs 0.7.5 | `circuits/` |
| Flutter | stable ≥ 3.24 | `app/` |
| Python ≥ 3.11 | optional | `services/` sidecars only |

### Install

```sh
npm install                 # root workspaces: packages/engine, packages/backend
(cd circuits && npm install)
cp .env.example .env        # optional: the backend creates .env and generates its keys on first run
```

**Everything below runs offline, with no API keys and no money.** Every provider defaults to `mock`/`off` (§13). `ALLOW_SPEND` is
never set in scripts, tests or CI. Nothing in this repo pushes to a remote, and keypairs and `.env` are never committed.

### Run the tests

```sh
npm test                                   # engine + backend (vitest); includes the vector generator check
npm run vectors -- --check                 # testvectors/ is up to date (`npm run vectors` regenerates it)
cargo test -p verdict-rules                # no_std rule interpreter: golden vectors + fuzz
anchor build                               # programs/verdict → target/deploy/verdict.so + target/idl/verdict.json
cargo test -p verdict                      # Anchor program on LiteSVM (no validator, no network, no SOL)
(cd circuits && npm test)                  # biometric circuit (needs circuits/build, see "Circuits setup")
(cd app && flutter analyze && flutter test)
```

The program tests load prebuilt `.so` files. `anchor build` writes `target/deploy/verdict.so`. The `mock-zk` and `sp1` variants are
built separately:

```sh
cargo build-sbf --manifest-path programs/verdict/Cargo.toml --features mock-zk     --sbf-out-dir target/deploy-mock-zk
cargo build-sbf --manifest-path programs/verdict/Cargo.toml --features sp1,mock-zk --sbf-out-dir target/deploy-sp1
cargo test -p verdict --features sp1,mock-zk --test sp1
```

After `anchor build`, copy `target/idl/verdict.json` to `packages/backend/idl/verdict.json` if they differ. The backend, the mock chain
and the Dart codegen all read the committed IDL, and the IDL is normative for account order (§9.1).

### Run the end-to-end demo

```sh
npm run demo:e2e
```

This starts the backend on a random port (`SOLANA_MODE=mock`, all providers mocked, spend disabled) and drives two simulated phones
(Alice and Bob) through four flows:

1. The paper-ball shot, settled by consent.
2. The cup tower, disputed, then settled by the replay-booth panel.
3. An AI-judged bet, settled by the panel.
4. A World Mode market bet.

It ends with `PASS — 39 checks`.

### Run the backend

```sh
npm start -w packages/backend              # :8787, mock chain + mock providers; writes .env with generated keys on first run
```

For Solana devnet (free), set `SOLANA_MODE=devnet` and `PROVER=snarkjs`, plus `CHAIN_EVENTS_SOURCE=quicknode` or `rpc_ws`. The deployed
program rejects mock proofs.

### Run the app

```sh
cd app
flutter run --dart-define=VERDICT_API=http://10.0.2.2:8787     # Android emulator → host backend; backend root, without /v1
```

See [`app/README.md`](app/README.md) for app-specific notes (for a physical device, point `VERDICT_API` at the host's LAN address).

### Build and deploy the program

```sh
anchor build
anchor deploy --provider.cluster devnet    # needs target/deploy/verdict-keypair.json (uncommitted) and devnet SOL from a faucet
```

### Circuits setup

```sh
cd circuits
npm run setup        # scripts/setup.sh: compile, local Powers of Tau (2^14), phase 2 with the fixed dev beacon; ~2 min, offline
npm test
npm run vk:rust      # writes circuits/build/vk.rs; copy it to programs/verdict/src/zk/vk.rs if it changed
```

The committed `circuits/build/verification_key.json` and `programs/verdict/src/zk/vk.rs` are reproducible byte-for-byte from this
setup. A test checks that they are in sync.

---

## Architecture

```
 ┌──────────────────────────── Phones (Flutter, app/) ─────────────────────────────────────┐
 │ enroll face+voice · huddle scan · spoken bet · scene check · camera witness (hash chain) │
 │ audio witnesses · beacon player · embedded ed25519 wallet behind passkey · receipt      │
 └──────────┬───────────────────────────┬─────────────────────────────┬────────────────────┘
            │ HTTP + WS                 │ chunk hashes, then bodies   │ user-signed tx payloads
            ▼                           ▼                             ▼
 ┌───────────────────────────────── Backend (packages/backend, Fastify) ───────────────────┐
 │ identity (closed-set match) · huddles · drafts (LLM bet compiler) · evidence store       │
 │ perception jobs (2 hosts → cross-check) · replay booth (advocates + 3 judges)           │
 │ World Mode (Gemini adapter) · keeper · provers (snarkjs Groth16) · fee payer / oracle   │
 │ all logic shared with packages/engine (TS): rule language, eval, encodings, settle math │
 └───────────┬──────────────────────────────────────────────────────────────▲──────────────┘
             │ transactions (fee-paid by backend)                           │ decoded events (HMAC webhook)
             ▼                                                              │
 ┌─────────────────────────── Solana devnet: programs/verdict ──────┐   ┌───┴──────────────────────┐
 │ Profile (Poseidon commitments) · Bet · SPL vault · TrackBuffer   │──▶│ QuickNode Stream          │
 │ run_rules → crates/verdict-rules (no_std interpreter)            │   │ filter: Verdict program,  │
 │ Groth16 verify (alt_bn128) · consent / dispute / settle_panel    │   │ decode Anchor events      │
 └──────────────────────────────────────────────────────────────────┘   └───────────────────────────┘
   circuits/ (circom BiometricMatch + snarkjs) → vk.rs        services/ (optional Python: SAM 3 perception, ArcFace/ECAPA embedder)
```

### Components

| Path | What |
|---|---|
| `packages/engine` | The TypeScript engine and the single source of truth offchain. It holds the rule language (YAML → AST → `program_bin`), evaluation (§3), binary encodings (§5), perception quantization and cross-check (§6), evidence hash chains and Merkle roots (§7), identity fusion (§8), settlement math (§9.8), event codecs, `chainModel` (a TS model of the program) and `simulate`. |
| `packages/backend` | The Fastify + `ws` backend (§12). Every external provider sits behind an interface with a deterministic mock (§13), and a spend guard protects the paid modes. See [`packages/backend/README.md`](packages/backend/README.md). |
| `crates/verdict-rules` | A `no_std`, heap-free Rust interpreter for the rule language. It is bit-identical to the TS engine on all golden vectors and fuzz cases, and the program links it. |
| `programs/verdict` | The Anchor 0.32.1 program, with 15 instructions and 14 events. Tested with LiteSVM. |
| `circuits/` | circom `BiometricMatch(192)` + snarkjs Groth16 over BN254. Produces the verifying key `vk.rs` for `groth16-solana`. |
| `app/` | Flutter client (iOS/Android). |
| `services/` | Optional Python sidecars, not built by default. `perception/` runs SAM 3 tracks plus MediaPipe Pose on a GPU host or Nosana. `embedder/` produces ArcFace face and ECAPA voice embeddings and runs locally for free. See [`services/README.md`](services/README.md). |
| `infra/quicknode/` | QuickNode Streams config (`stream.json`) and filter (`filter.js`). |
| `testvectors/` | Golden vectors shared by TS, Rust, the program and Dart. 239 files, generated by `npm run vectors`. |

### Trust map (as built)

| Component | Where it runs | Trust status |
|---|---|---|
| Capture + sealing | Players' phones | **Checkable.** Per-witness hash chains, rolling onchain evidence roots, a SlotHashes freshness beacon, and audio witnesses (advisory, D-19) |
| Bet compilation | LLM (mock by default) | **Checkable.** Players approve the plain-English read-back of the compiled program, and its hash goes onchain |
| Perception | Two independent hosts (mock by default; `http`/`nosana` real) | **Checkable.** Cross-checked (IoU ≥ 0.5 on ≥ 90% of frames, D-18), with pinned open weights, so anyone can re-run it |
| Identity matching | Identity service + ZK | **Proven** that the oracle-held embedding matches the onchain commitment. Binding that embedding to the footage is **trusted** (D-25) |
| Rule execution | Solana program (`run_rules`) | **Onchain** |
| Oversized rule runs | — | SP1 is **not built** (D-9). Oversized runs go to the replay booth |
| Consent settlement | Players' signatures | **Onchain** |
| Replay booth | LLM APIs + backend-held judge keys | **Trusted, labeled** |
| Orchestration | Our backend | It can't change an outcome without detection. It can delay one, and permissionless refund timeouts bound that delay |

---

## Program ID

```
dbqDmF6YtjPygXTvJD31CNADoLqiUG8pZgj1zpHaMye
```

The same ID is used for localnet and devnet (`Anchor.toml` `[programs.localnet]` / `[programs.devnet]`, and `declare_id!` in
`programs/verdict/src/lib.rs`). The same address also appears in three other places, and all of them must change together:

- `VERDICT_PROGRAM_ID` in `.env`. Its default is the `address` in `packages/backend/idl/verdict.json`.
- The `VERDICT_PROGRAM_ID` constant at the top of `infra/quicknode/filter.js`.
- `packages/backend/idl/verdict.json`.

The program keypair (`target/deploy/verdict-keypair.json`) is never committed.

## How we use Solana

Solana is the escrow and the judge of record, not just a payment rail.

- **Accounts (PDAs):**
  - `Profile ["profile", wallet]` holds Poseidon commitments to the face/voice templates, never the templates themselves.
  - `Bet ["bet", creator, nonce]` holds the participants, stakes, `program_hash`, `calibration_hash`, the acceptance audio hash, the
    state, deadlines, rolling evidence roots, the consent bitmap, the dispute bond and `winner_mask`.
  - `Vault ["vault", bet]` is a classic SPL Token account with the Bet PDA as its authority. It escrows the stakes in devnet USDC or a
    backend-created test mint (D-34).
  - `TrackBuffer ["tracks", bet]` holds the decisive-window tracks and is closed at settlement to reclaim rent.
- **Onchain rule interpreter.** `run_rules` loads the approved program, which must hash to `program_hash`, and the tracks in
  `TrackBuffer`. It evaluates every leg with `crates/verdict-rules` and writes the pre-ruling. Evaluation cost is capped
  (`MAX_EVAL_COST` = 8192, D-47), so every accepted buffer runs in ≤ 1.08M CU, under the 1.4M CU limit. Programs above the cap go to
  the replay booth.
- **Freshness beacon from SlotHashes.** `start` reads a recent slot hash straight from the SlotHashes sysvar, using a binary search
  instead of full deserialization. The phones play it as an audio start signal and fold it into every witness's hash chain, which
  shows the footage was recorded after that slot. Rolling `commit_evidence` roots bound when the footage ended.
- **Groth16 verification.** `verify_biometric_proof` checks a circom/snarkjs Groth16 proof with `groth16-solana` (`alt_bn128`
  syscalls, about 132K CU) against the profile commitment. The proof is bound to the bet, the evidence root and the frame.
- **Consent-first settlement.** `consent` settles when every party agrees, and silence after the window counts as consent. `dispute`
  posts a bond (D-17). `settle_panel` verifies 2-of-3 judge signatures through the Ed25519 precompile, read from the instructions
  sysvar. `refund` is permissionless after a timeout.
- **Gas abstraction.** The backend wallet pays every fee. Users sign only as authority, with the embedded wallet in the app.
- **Every transaction fits 1,232 bytes** (legacy/v0, no lookup tables). For example, `create_bet` is about 1,050 B and
  `settle_panel` about 1,100 B, and `post_tracks` sends about 700 B chunks.
- **Instructions (15):** `init_profile`, `create_bet`, `fund`, `cancel`, `start`, `commit_evidence`, `end`, `post_tracks`,
  `verify_biometric_proof`, `verify_sp1_run` (feature-gated, fail-closed stub), `run_rules`, `consent`, `dispute`, `settle_panel`,
  `refund`.
- **Events (14),** emitted with Anchor `emit!`, drive the backend through QuickNode Streams (below).

---

## ElevenLabs usage

ElevenLabs is part of the core flow (spec §5.11). The integration is in `packages/backend/src/providers/real/elevenlabs.ts`.

| Use | Product | Where |
|---|---|---|
| Spoken bet creation, clarifying questions, read-back. The Agent calls our compile tool at `POST /v1/webhooks/elevenlabs/tool`, which is authenticated by `ELEVENLABS_TOOL_SECRET`. | Agents (Conversational AI), with Scribe Realtime | `AGENT_PROVIDER=elevenlabs` |
| Who said "I accept" and when; in-game speaker segments for the identity timeline; audio event tags (impacts, speech) for the advisory audio cross-check (§7.6) | Scribe (`scribe_v1`, diarization + audio events) | `STT_PROVIDER=elevenlabs` |
| Questions, read-back and the verdict announcer (audio only) | Text to Speech (`eleven_multilingual_v2`) | `TTS_PROVIDER=elevenlabs` |
| The audible start cue, played right before the locally synthesized beacon data tones (D-8) | Sound Effects | `SFX_PROVIDER=elevenlabs` |

**Precision statement (ECAPA vs. Scribe).** Speaker *verification* is our ECAPA model (SpeechBrain `spkrec-ecapa-voxceleb`,
ECAPA-TDNN, 192-d), served by `services/embedder` when `IDENTITY_PROVIDER=http`. The default build uses the deterministic mock embedder
instead. **ElevenLabs Scribe supplies only diarized segments and audio events (plus transcripts).** It tells us *when someone spoke and what
they said*. It does not decide *who* the speaker is. We decide that by comparing the ECAPA embedding of the segment against the
participant's enrolled voiceprint (§8.1, threshold τ plus closed-set margin δ).

All four ElevenLabs modes are paid, so they are spend-guarded. The default runs, tests and the demo use mocks: text-only agent, a
transcript taken from a header or the draft, and bundled WAVs.

---

## Gemini Prediction Markets (World Mode)

The adapter is in `packages/backend/src/providers/real/world.ts`, with normalization in `geminiNormalize.ts`. Contract §11.

- **Browse events in the bet composer.** It uses public, keyless REST: `GET {GEMINI_BASE_URL}/v1/prediction-markets/events` and
  `/events/{ticker}`. Each event is normalized to `{id, title, category, close_time_ms, status, contracts[{prob_bps, bid_bps,
  ask_bps}]}`, where `prob_bps` = the bid/ask mid, else the last trade, else the ask.
- **Odds-calibrated stakes.** The favored side stakes more. A 70/30 market gives a 70/30 split of the pot, floored to whole cents
  (§11.2, engine bigint math).
- **Parlays.** 1 to 4 legs. The leg probabilities are multiplied, assuming independence, and the UI says so (§11.3).
- **Live prices.** These come from the public WebSocket `wss://{host}/v1/marketdata/{symbol}?top_of_book=true&trades=true`. They are
  relayed to the app as `world.price` messages while a World bet or the composer's selected event is open.
- **Resolution.** The oracle reads `status: settled` and each contract's `resolutionSide`, then posts a `market_bin` to the program.
  The same `run_rules` and consent flow settles it (D-16). A counterparty's `fund` is their acceptance (D-32).
- **Hedge (stretch).** `POST /world/bets/:id/hedge` returns a mock order. Live mode targets Gemini's demo environment through OAuth and
  is spend-guarded.

`GEMINI_PROVIDER=live` is free (public reads). The default `mock` serves the fixtures in `packages/backend/fixtures/gemini/`.

---

## QuickNode Streams

Config: [`infra/quicknode/stream.json`](infra/quicknode/stream.json). Filter: [`infra/quicknode/filter.js`](infra/quicknode/filter.js).
Contract §12.5.

| Field | Value |
|---|---|
| network | `solana-devnet` |
| dataset | `block` |
| filter | `filter_function` = base64 of `filter.js`. The filter keeps successful transactions that mention `VERDICT_PROGRAM_ID` and decodes their `Program data:` log lines (while Verdict is the innermost program) into the 14 §9.5 Anchor events. It returns `{stream, events: [{signature, slot, block_time, index, name, data}]}`, or `null` when a block has no Verdict events. `filter.js` is a self-contained copy of the engine's `decodeEvent`, and `packages/backend/test/streams.test.ts` checks it against the engine for every event. |
| destination | `webhook` → `${API}/v1/webhooks/quicknode`, `security_token: ${QUICKNODE_SECRET}`, `max_retry: 3`, `retry_interval_sec: 1`, `post_timeout_sec: 10` |
| other | name `verdict-devnet`, region `usa_east`, `start_range: -1` / `end_range: -1` (from the tip, open-ended), `dataset_batch_size: 1`, metadata in `header` |

**Webhook security.** `packages/backend/src/chain/quicknode.ts` checks `x-qn-nonce`, `x-qn-timestamp` and `x-qn-signature`, where
`signature = hex(HMAC_SHA256(QUICKNODE_SECRET, nonce ‖ timestamp ‖ raw_body))`. It rejects requests with a bad signature or with
`|now − timestamp| > 300 s`. Handling is idempotent on `(signature, index)`.

**Setup.** Replace `${API}` and `${QUICKNODE_SECRET}` in `stream.json` and set `filter_function` to `base64(filter.js)`. Then
`POST https://api.quicknode.com/streams/rest/v1/streams` and run the backend with `SOLANA_MODE=devnet CHAIN_EVENTS_SOURCE=quicknode`.
Without a QuickNode account, `CHAIN_EVENTS_SOURCE=rpc_ws` feeds the same handler from `logsSubscribe`.

**Why Streams.** The backend is event-driven, and each program event triggers the next step:

| Event | Next step |
|---|---|
| `Funded{all_funded}` | the bet is Ready |
| `BetEnded` | start perception |
| `TracksPosted` | proofs, then `run_rules` |
| `PreRuled` | announcer + notify |
| `Disputed` | replay booth |
| `Settled` / `Refunded` | announcer + close-out |

Streams pushes exactly these events, already filtered to our program and decoded at the edge. Delivery is ordered and retried, so
the backend doesn't poll RPC for every open bet, and a trigger isn't silently lost when a socket drops. Handling is idempotent, so
retries are harmless. The same events become live bet state in the app (WS `chain` messages) and its notifications (D-29).

---

## ZK

## Trusted-setup statement

The biometric circuit (`circuits/biometric_match.circom`, `BiometricMatch(192)`, BN254 Groth16) uses a **development trusted
setup**:

- `circuits/scripts/setup.sh` defaults to an offline local Powers of Tau (2^14). The fixed public beacon
  `sha256("VERDICT/ZK-DEV-BEACON/v1")` = `d227b82c…4ba1` is applied in both phases (single-party phase 2 via `snarkjs zkey beacon`),
  so the setup is reproducible byte-for-byte. `--download-ptau` (Hermez `powersOfTau28_hez_final_14.ptau`) is available but produces
  a different key.
- **Committed:** `circuits/build/verification_key.json` and `programs/verdict/src/zk/vk.rs`. **Not committed:** the zkey, ptau, r1cs
  and wasm. `setup.sh` regenerates them.
- **Because the beacon is public, anyone can forge proofs for this verifying key.** This is a hackathon/devnet setup, not a production
  ceremony. Production would need a multi-party phase-2 ceremony.
- The program's `mock-zk` feature, which accepts a fixed mock proof, is for tests only. The `anchor build` artifact does not enable it.

## Honest ZK framing (D-25)

The proof shows that the oracle holds an embedding within τ (cosine) of the committed enrollment template, bound to this bet,
evidence root and frame, without revealing either the embedding or the template. The closed-set margin δ is enforced offchain (D-15).

It does **not** show:

- that the embedding came from the person in the footage. That binding is **trusted**, the same trust class as perception, and the
  receipt's Proof row says so (`binding: "trusted"`);
- that the vision model drew the boxes correctly;
- that the replay booth reasoned correctly.

Sealing (hash chains, onchain roots, the beacon), two-host perception cross-checks, audio witnesses and disputes cover those gaps.
What ZK buys here is **privacy**: a fact about a biometric template is checked onchain without the template being published.

**SP1 (oversized runs) is not built** (spec §5.8.2 fallback (a), D-9, errata `[sp1-dropped]`). There is no SP1 guest or host, and
`SP1_PROVER` is treated as `off` with a startup warning. Runs whose decisive windows exceed the onchain caps go to the replay booth
(reason 13). `verify_sp1_run` is a feature-gated, fail-closed stub.

---

## Trusted replay booth

The booth runs when a bet enters **Disputed**. That happens on a participant dispute, a low-confidence outcome, an AI-judged bet, a
failed perception cross-check, or a run too large for the onchain caps. It is labeled **Trusted** in the UI and here.

- **Exhibits, never the whole video.** The panel sees ±2 s clips per camera, audio per microphone, track and identity excerpts, the
  Scribe transcript, the program, the read-back and the flags. Every exhibit carries hash-chain proofs to the onchain evidence root.
- **Advocates,** one per side, write briefs that cite exhibits (`cam1@12.4s`).
- **Three judges on mixed models.** J0 is video-capable. Each judge commits to its verdict before any verdict is revealed.
- **Ruling.** A 2-of-3 majority above the confidence floor wins, otherwise the result is No contest and everyone is refunded. Two
  judges sign the ruling, and `settle_panel` verifies those signatures onchain.
- **Trust assumption.** The judge keys are held by our backend, and the models are third-party LLMs. The program checks the quorum
  signatures, not the reasoning. On the roadmap: zkTLS for model provenance, and independent judge operators or TEEs (D-35).

---

## Grok

*Placeholder.* The `xai` provider exists for `COMPILER_PROVIDER`, `ADVOCATE_PROVIDER` and `JUDGE_PROVIDERS` (for example, Grok as
replay-booth judge J1 or J2). It is off by default and spend-guarded. It will not be relied on until we confirm eligibility with the
sponsor. Once that is settled, this section will hold the 3–4 sentence description and a link to the Grok Bot chat export.

---

## Legal / consent note

- **Devnet only.** Verdict uses devnet tokens (a test mint or Circle devnet USDC). No real money moves. Peer-to-peer wagering with real
  money is regulated differently in each jurisdiction, and this project does not offer it.
- **Biometric consent.** Enrollment asks for explicit consent before capturing face and voice templates. Several US states, such as
  Illinois under BIPA, require informed consent, a retention policy and deletion for biometric identifiers. Templates are encrypted at
  rest (AES-256-GCM, `BIOMETRIC_KEY`). Only Poseidon commitments go onchain, and the face/voice data itself is never published.
- **Deletion actually deletes.** `DELETE /v1/enroll` erases the stored templates and zeroes the Profile commitments onchain.
- **Identity checks run only when needed.** Face and voice matching run only for legs that name a specific person (actor-bound legs).
- **Visible consent.** Each bet is accepted out loud and signed on the participant's own device, and settlement is consent-first.

---

## Providers, mocks and spend guard

Every external dependency sits behind an interface with a deterministic mock, selected by env vars (§13, `.env.example`). Every
provider defaults to `mock`/`off`. A mode that can cost money refuses to start (`SPEND_DISABLED`) unless `ALLOW_SPEND=1`.

| Env | Default | Real modes | Costs money (spend-guarded) | Needs |
|---|---|---|---|---|
| `SOLANA_MODE` | `mock` (in-memory chain = engine `chainModel`) | `devnet` | no | devnet SOL for the fee payer (faucet) |
| `CHAIN_EVENTS_SOURCE` | `mock` | `quicknode`, `rpc_ws` | no | `QUICKNODE_SECRET` + a QuickNode stream |
| `COMPILER_PROVIDER`, `ADVOCATE_PROVIDER` | `mock` (keyword templates / fixed text) | `anthropic`, `openai`, `gemini`, `xai` | **yes** | the matching `*_API_KEY` |
| `JUDGE_PROVIDERS` | `mock,mock,mock` | the same LLMs (J0: `gemini`, video-capable) | **yes** | API keys |
| `AGENT_PROVIDER`, `STT_PROVIDER`, `TTS_PROVIDER`, `SFX_PROVIDER` | `mock` | `elevenlabs` | **yes** | `ELEVENLABS_API_KEY` (+ `ELEVENLABS_AGENT_ID`) |
| `PERCEPTION_PROVIDER` | `mock` (`engine.simulate` per `MOCK_SCENARIO`) | `http`, `nosana` | **yes** (GPU) | `PERCEPTION_URL`, or `NOSANA_API_KEY` + image + 2 markets |
| `DETECTOR_PROVIDER` | `mock` | `http` | no (local) | `DETECTOR_URL` |
| `IDENTITY_PROVIDER` | `mock` (deterministic embeddings) | `http` (`services/embedder`) | no (local) | `EMBEDDER_URL` + pinned weights |
| `GEMINI_PROVIDER` | `mock` (fixtures) | `live` (public REST/WS) | no | nothing |
| `GEMINI_HEDGE` | `mock` | `live` | **yes** | Gemini OAuth (demo environment) |
| `PROVER` | `mock` | `snarkjs` (real Groth16, in-process) | no | `circuits/build` (run `npm run setup`) |
| `SP1_PROVER` | `off` | not implemented (always treated as `off`) | — | — |
| `ALLOW_SPEND` | unset | `1` | — | never set in scripts or CI |

Backend keys (`FEE_PAYER_KEY`, `ORACLE_KEY`, `JUDGE_KEY_0..2`, `BIOMETRIC_KEY`, `ELEVENLABS_TOOL_SECRET`) are generated into the
git-ignored `.env` on first run.

### What's real and what's mocked by default

| Real in every run (no keys) | Mocked by default (real version exists) | Not built |
|---|---|---|
| Rule language, compiler validation, read-back, evaluation (TS + Rust, bit-identical) | Solana chain (in-memory model of the program; `devnet` is real and free) | SP1 oversized-run proofs (D-9) |
| The Anchor program, executed in LiteSVM, including a **real** Groth16 proof verified onchain | LLM compiler, advocates and judges | zkTLS, TEEs, independent judge operators (D-35) |
| Groth16 circuit, setup, proving and verification (circuits tests) | ElevenLabs Agent / Scribe / TTS / SFX | BLE/geo proximity (D-22); FCM/APNs push (D-29) |
| Hash chains, Merkle roots, beacon encode/decode, settlement math | Perception (SAM 3), detector, face/voice embedders | Multi-camera fusion (D-23) |
| QuickNode filter decoding + HMAC verification; event handling | Gemini events/prices (fixtures; `live` is free) | |
| Flutter app logic, wallet signing, capture sealing (widget/unit tests) | Sign-in providers (D-10) | |

---

## Repository layout

```
app/                      Flutter client (lib/, test/)
circuits/                 BiometricMatch circom circuit, setup/prove/verify scripts, committed verification_key.json
crates/verdict-rules/     no_std rule interpreter (linked into the program)
docs/                     CONTRACTS.md (binding contract), CONTRACTS-ERRATA.md (implementation decisions)
infra/quicknode/          stream.json, filter.js
packages/engine/          TS engine (+ scripts/ for the vector generator)
packages/backend/         Fastify backend, providers, mocks, idl/verdict.json, scripts/demo-e2e.ts, fixtures/gemini
programs/verdict/         Anchor program, src/zk/vk.rs, LiteSVM tests
scripts/test-services.sh  CPU tests for the optional Python sidecars (not part of npm test)
services/                 optional Python sidecars: perception/, embedder/, common/
testvectors/              golden vectors (generated)
verdict-spec.md           product spec
```

---

## Test status

Measured on 2026-11-08 (WSL2 Ubuntu 24.04; Flutter run on the Windows host). All commands are offline, with no keys and no spend.

| Command | Result |
|---|---|
| `npm test`, backend (`@verdict/backend`, vitest) | 31 files, **229 passed** |
| `npm test`, engine (`@verdict/engine`, vitest) | 44 files, **798 passed** |
| `npm run vectors -- --check` | up to date (239 files) |
| `npm run demo:e2e` | **PASS, 39 checks** (consent, dispute → panel, AI-judged → panel, market) |
| `anchor build` | OK. `target/idl/verdict.json` is identical to `packages/backend/idl/verdict.json` |
| `cargo test -p verdict-rules` | **75 passed** |
| `cargo test -p verdict` (LiteSVM) | **76 passed**, 1 ignored (a fixture-printing helper) |
| `cargo test -p verdict --features sp1,mock-zk --test sp1` | **5 passed** |
| `cd circuits && npm test` | **15 passed** |
| `flutter analyze` | no issues |
| `flutter test` | **155 passed** |
