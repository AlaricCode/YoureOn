# VERDICT — Interface Contracts (v2)

This document is the **single source of truth** shared by the four implementation teams:

| Team | Directories | Language |
|---|---|---|
| Engine | `packages/engine`, `testvectors/` | TypeScript (pure, no I/O) |
| Backend | `packages/backend`, `services/` (optional sidecars, not built by default), `infra/` | TypeScript (Node ≥ 20); Python sidecars |
| Chain + ZK | `programs/verdict`, `crates/verdict-rules`, `circuits/`, `sp1/` (not built: errata [sp1-dropped]) | Rust (Anchor 0.32.1), circom 2.1.x |
| App | `app/` | Flutter (stable ≥ 3.24, Dart ≥ 3.5) |

It refines `verdict-spec.md` (product spec, v0.2). `courtside-spec.md` is a byte-identical copy of `verdict-spec.md` (v0.2); both are covered by this document.

Precedence: where the spec is open, a decision is made here and marked **[D-n]**. **Any deviation from the spec MUST appear in §16 with the spec section it overrides**; an unlogged deviation is a defect in this document, and the spec wins until it is logged. If two sections of this document conflict, the more specific (byte-level) section wins; report the conflict in `docs/CONTRACTS-ERRATA.md`.

Normative words: MUST, MUST NOT, SHOULD, MAY.

**No money, no pushes.** Every component runs offline against deterministic mocks by default. Nothing that can incur cost runs unless `ALLOW_SPEND=1` (§13). The repository is never pushed by tooling.

---

## 0. Global conventions

### 0.1 Integers and endianness
- All binary layouts in this document are **little-endian**, packed, no padding, unless stated otherwise. The only big-endian data is Groth16 / BN254 field elements and curve points (§8.6, §9.7), the CRC-16 in the beacon (§7.5) and the Profile commitments (§8.4).
- Onchain account and instruction-argument layouts use **Borsh** (Anchor default): integers LE; `[T; N]` has no length prefix; `Vec<T>` is `u32 LE length` + items; `bool` is one byte `0|1`; `Pubkey` is 32 raw bytes; `Option<T>` is `0` or `1` + T. The one exception is `TrackBuffer` (zero-copy header + raw payload, §9.3).
- JSON numbers MUST be integers in `[-(2^53-1), 2^53-1]`. No floats anywhere in hashed or consensus data. (Non-consensus fields MAY carry floats only where stated.)
- **Canonical encodings.** Every reserved, unused or "0 if unused" field in every binary format in this document MUST be zero, and decoders reject non-zero values. Encodings are canonical: one AST maps to exactly one `program_bin`, one calibration to one `calibration_bin`.

### 0.2 Encodings in JSON
| Data | JSON encoding |
|---|---|
| Solana public key | base58 string |
| 32-byte hash / digest | lowercase hex, 64 chars, no `0x` |
| Arbitrary bytes (audio, images, tx messages, signatures) | standard base64 with padding |
| USDC amounts | integer base units (`1 USDC = 1_000_000`), field names end in `_units` |
| Probabilities, confidences, ratios | integer basis points `0..10000` (`_bps`) unless stated |
| Image coordinates and bboxes (all API and calibration data) | integers `0..10000`, normalized to the **full captured image** (§0.4) |
| Wall-clock time | integer Unix **milliseconds** (`_ms`) in the API; Unix **seconds** (`i64`) onchain |
| Session-relative time | integer frames (engine) or ms since `t0` (API, `t_ms`) |

### 0.3 Hash functions
- `sha256` = SHA-256 (FIPS 180-4). Used for everything except identity commitments.
- `poseidon` = circomlib Poseidon over the BN254 scalar field (`poseidon-lite` in TS, `circomlib/poseidon.circom` in circuits). Used only for biometric commitments (§8.4).
- `‖` denotes byte concatenation. ASCII tags like `"VERDICT/CHUNK/v1"` are their raw ASCII bytes, no terminator, no length prefix.

### 0.4 Fixed-point conventions (normative everywhere)
| Quantity | Representation |
|---|---|
| Image coordinates | `u16` in `0..=10000`, normalized to the full captured frame width (x) and height (y). Origin **top-left**, **x right, y down**. `x_norm = floor(x_px * 10000 / width_px)` clamped to `[0, 10000]`. "up" means decreasing y. |
| Areas | `u64` in normalized units² (full frame = 10^8) |
| Distances | normalized units (Euclidean over normalized x,y, so anisotropic for non-square frames — accepted) |
| Speed | normalized units per second (`ups`) |
| Time inside the engine | integer **frame index** at `FPS = 10`. Frame `f` covers `t_ms ∈ [f*100, f*100+100)` after `t0` |
| Durations in DSL | seconds or ms in source, converted with `frames = ceil(ms * FPS / 1000)` |
| Detection / identity confidence (track records) | `u8` percent `0..=100` |
| Everything else probabilistic | `u16` bps `0..=10000` |
| Embeddings | `i8` per dim in `[-127, 127]` (§8.2) |
| Money | `u64` USDC base units (6 decimals) |
| Integer square root | `isqrt(n) = floor(sqrt(n))` on unsigned 64-bit, computed with **integer Newton's method** |
| Division | always truncating integer division on **non-negative** operands; every formula is written so operands are non-negative before division. Rust: `i64` for signed intermediates, `u128` for money products. |

**TS integer safety (consensus code: `packages/engine/src/{eval,encode,settle,identity,world}/**`).**
- Use `number` only where a stated bound proves `|x| < 2^53`. Use `bigint` otherwise. `bigint` is mandatory for: settlement (`pot·stakes[i]` reaches about 8·10^24), `stakeSplit` (`T·p`), `parlayProb` products, `circuitMatch` (`dot²·10^8`), Poseidon packing.
- `isqrt` MUST be integer Newton's method. `Math.sqrt`, `Math.round`, `Math.floor` on non-integers, and `/` on numbers are forbidden in `packages/engine/src/eval/**`. This is enforced by an ESLint `no-restricted-syntax` / `no-restricted-properties` rule. Division goes only through `idiv(a, b)`, which asserts `a ≥ 0, b > 0` and both are safe integers.
- `evaluateProgram` MUST be implemented as `encode*` followed by `evaluate`. It is not a separate code path.

### 0.5 Global constants
All teams MUST use these values (engine: `packages/engine/src/constants.ts`; Rust: `crates/verdict-rules/src/constants.rs`, re-exported by `programs/verdict`; Dart: `app/lib/contracts/constants.dart`, generated from the engine by `npm run gen:dart`).

| Name | Value | Meaning |
|---|---|---|
| `FPS` | 10 | track frame rate |
| `COORD_MAX` | 10000 | |
| `MAX_PARTICIPANTS` | 8 | per bet |
| `MIN_PARTICIPANTS` | 2 | |
| `MAX_HUDDLE` | 10 | huddle members (spec §5.3) |
| `MAX_ENTITIES` | 16 | |
| `MAX_LEGS` | 8 | |
| `MAX_EXPR_BYTES` | 512 | per encoded leg expression |
| `MAX_EXPR_NODES` | 64 | per leg expression (node = op byte) |
| `MAX_EXPR_DEPTH` | 12 | leaf depth = 1 |
| `MAX_COND_NODES` | 32 | outcome condition |
| `MAX_SEGMENTS` | 16 | decisive windows per TrackBuffer |
| `MAX_BUFFER_PAYLOAD` | 10000 | bytes in TrackBuffer payload; MUST satisfy `8 + 48 + MAX_BUFFER_PAYLOAD ≤ 10240`, so never raise above 10184 |
| `MAX_EVAL_FRAMES` | 1024 | total buffer frames `Σ n_frames` |
| `MAX_EVAL_COST` | 8192 | evaluation cost cap (§3.13; was 16384, see D-47) |
| `EVAL_COST_SETUP_FRAMES` | 4 | frames charged per unit of weight for per-node set-up: `cost = (\|F\| + EVAL_COST_SETUP_FRAMES) × Σw` (§3.13) |
| `POST_TRACKS_CHUNK` | 700 | max `data` bytes per `post_tracks` instruction |
| `MAX_WITNESSES` | 8 | |
| `MAX_CHECKPOINTS` | 8 | identity checkpoints per bet |
| `PRESENCE_MIN` | 30 | record conf (%) below which an entity is treated as absent |
| `DECISIVE_CONF_MIN` | 50 | conf (%) required at decisive frames |
| `ID_CONF_MIN` | 60 | identity confidence (%) at checkpoints |
| `VEL_K` | 2 | frames between velocity samples |
| `MOVE_MIN_UPS` | 300 | `moving` threshold |
| `STILL_MAX_UPS` | 250 | `still` threshold (used by `at_rest`); vectors at 1 px and 5 px jitter |
| `NEAR_DEFAULT` | 500 | default `near` distance |
| `NEAR_MAX` | 14143 | max `near` distance |
| `SPEED_MAX` | 100000 | max `speed` comparison value |
| `REPS_MAX` | 1000 | max `rep_count` value and count `k` |
| `ATTEMPTS_MAX` | 20 | `within attempts N` (actor-bound legs: 8) |
| `RELEASE_HOLD` | 2 | held frames required before release |
| `RELEASE_GAP` | 3 | max frames between presence samples (lastSeen, release, crossing) |
| `HAND_EXPAND_PCT` | 10 | person bbox expansion for "held" |
| `DISAPPEAR_FRAMES` | 10 | frames (1 s) an object must stay unseen-outside after `disappears_into` |
| `DESCEND_LOOKBACK` | 3 | frames |
| `STALE_REGION_FRAMES` | 30 | how long a derived region survives its object's absence |
| `INTACT_PCT` | 75 | `intact` height threshold |
| `ATTEMPT_WINDOW_DEFAULT` | 50 | frames (5 s) |
| `TAIL_MS` / `TAIL_FRAMES` | 2000 / 20 | recording continues after End; look-ahead-only frames |
| `OCCLUSION_FILL_FRAMES` | 3 | max interior gap filled by `quantizeSession` (non-consensus) |
| `REBIND_DELAY_FRAMES` | 15 | object entity absence after its track ends (> `DISAPPEAR_FRAMES`) |
| `PULSE_LATCH_FRAMES` | 10 | UI latch for event rows (scene check, practice) |
| `DEFAULT_TIME_LIMIT_S` | 120 | compiler default |
| `TIME_LIMIT_MAX_S` | 3600 | rules / ai_judged programs |
| `MARKET_TIME_LIMIT_MAX_S` | 2592000 | market programs (30 days) |
| `MIN_STAKE_UNITS` | 10000 | $0.01, every stake |
| `MAX_STAKE_UNITS` | 1000000000000 | |
| `FUND_WINDOW_S` | 900 | Proposed → refundable after |
| `START_WINDOW_S` | 900 | Funded → refundable after |
| `LIVE_GRACE_S` | 300 | Live past time limit → refundable after |
| `PERCEPTION_TIMEOUT_S` | 3600 | Perceiving → refundable after |
| `CONSENT_WINDOW_S` | 120 | PreRuled consent/dispute window |
| `PANEL_TIMEOUT_S` | 3600 | Disputed → refundable after; also PreRuled stuck escape |
| `BEACON_MAX_AGE_SLOTS` | 150 | |
| `PLAY_DELAY_MS` | 1500 | start sound plays this long after the WS `start` message |
| `EVIDENCE_COMMIT_INTERVAL_S` | 30 | target |
| `EVIDENCE_MAX_GAP_S` | 90 | larger gap sets all witness gap bits |
| `CHUNK_MS` | 5000 | |
| `CHUNK_LATE_MS` | 10000 | hash record later than chunk end + this ⇒ `late` (advisory) |
| `CHUNK_GAP_MAX_MS` | 500 | tolerated inter-chunk gap (shown as `gaps_ms`) |
| `MAX_CHUNK_BODY_BYTES` | 20971520 | 20 MiB |
| `MAX_CHUNKS_PER_COMMIT` | 24 | |
| `DISPUTE_BOND_DIV` | 5 | bond = `max(min_i stakes[i] / 5, DISPUTE_BOND_MIN)` |
| `DISPUTE_BOND_MIN` | 100000 | 0.10 USDC |
| `FACE_DIM` | 128 | |
| `VOICE_DIM` | 192 | |
| `CIRCUIT_DIM` | 192 | |
| `EMB_SCALE` | 512 | |
| `TAU_FACE_BPS` / `DELTA_FACE_BPS` | 5500 / 1000 | |
| `TAU_VOICE_BPS` / `DELTA_VOICE_BPS` | 5000 / 1000 | |
| `IOU_AGREE_BPS` | 5000 | perception cross-check |
| `TRACK_AGREE_BPS` | 9000 | |
| `EVENT_TOL_FRAMES` | 3 | |
| `PANEL_CONF_FLOOR_BPS` | 6000 | |
| `PROB_CLAMP_MIN_BPS` / `PROB_CLAMP_MAX_BPS` | 100 / 9900 | World Mode |
| `MAX_PARLAY_LEGS` | 4 | |
| `CAMERA_POSE_DRIFT_CDEG` | 300 | "Camera moved" warning |
| `RECENT_HUDDLE_S` | 86400 | pay closed set window |
| `KEEPER_INTERVAL_S` | 5 | §12.6 |
| `FAUCET_UNITS` | 50000000 | demo drip |

### 0.6 Shared golden test vectors (mandatory)
The Engine team owns `testvectors/` at repo root. Vectors are **generated by the engine** (`npm run vectors`, deterministic, committed). Each file `testvectors/<name>.json`:
```json
{
  "name": "paper_ball_success",
  "program": { /* AST, §2.6 */ },
  "yaml": "<canonical YAML, §2.9>",
  "readback": ["…"],
  "program_canonical_json": "<string>",
  "json_hash": "<hex>",
  "program_bin": "<hex>",
  "program_hash": "<hex>",
  "calibration": { /* §5.2 JSON */ },
  "calibration_bin": "<hex>",
  "calibration_hash": "<hex>",
  "track_bin": "<hex>",
  "verified_checkpoints": [{"participant": 1, "frame": 41}],
  "expected": {
    "status": "ok",
    "reason": 0,
    "leg_results": [1],
    "leg_causes": [[]],
    "preruling": 1,
    "winner_mask": 2,
    "n_checkpoints": 1,
    "checkpoints": [{"participant": 1, "frame": 41}],
    "decisive_frames": [[41, 58]]
  }
}
```
`decisive_frames` is a list of frames per leg, not a range: `[[41, 58]]` means leg 0 has decisive frames 41 (attempt) and 58 (success). Decoder-rejection vectors use `"expected": {"error": "MalformedTracks"}` (the §9.6 name).

- `cargo test -p verdict-rules` and the program's LiteSVM tests MUST load every file in `testvectors/` and assert identical `status`, `reason`, `leg_results`, `preruling`, `winner_mask`, `n_checkpoints`, `checkpoints`, or the identical error.
- `testvectors/fuzz.jsonl`: at least 2,000 cases from a seeded TS generator (`seed = 1`): random valid programs, calibrations and track buffers within all limits, each line `{program_bin, calibration_bin, track_bin, verified, expected}`. Rust MUST match all of them.
- Vectors MUST cover at least:
  - the worked examples (§15) in pass and fail variants; one multi-segment buffer; one `Unknown` case per cause (§3.9); one ai_judged and one market program
  - every primitive at its boundaries: segment start; stale region at 30 and 31 frames; `disappears_into` look-ahead at the segment end; line `side = 0`; polygon edge and vertex points; attempt-window overlap
  - `rising` at absolute frame 0; a level success that stays true across attempts; a one-frame dropout during `enters`; an occluded hold before release
  - multi-ball rebind after `disappears_into` (via `quantizeSession`); an event within 1 s of the time limit (tail frames); the greedy identity-assignment conflict (§8.5)
  - more than 8 checkpoints; `holds` failing on occlusion vs. on the predicate; `MAX_EVAL_COST` exceeded
  - `still` at 1 px and 5 px center jitter
  - every decoder rejection in §5 with its expected error code
  - readback lines for every template in §2.8

---

## 1. Ownership and data flow (summary)

```
speech ─▶ backend.compiler (COMPILER_PROVIDER) ─▶ YAML ─▶ engine.parseYaml ─▶ AST ─▶ engine.canonicalize/validate
       ─▶ engine.encodeProgram ─▶ program_bin ─▶ sha256 ─▶ program_hash ─▶ draft (GET /drafts/:id on every phone)
       ─▶ counterparties accept on their own phones (voice + device signature) ─▶ acceptance_audio_hash ─▶ create_bet (creator + oracle sign)
scene check ─▶ engine.encodeCalibration ─▶ calibration_hash ─▶ fund (every funder; also binds program_hash and terms_hash)
record ─▶ WS start (beacon) ─▶ chunk hash chains (app) ─▶ backend.evidence ─▶ commit_evidence / end (rolling roots, oracle heads)
footage (primary camera) ─▶ perception ×2 (PERCEPTION_PROVIDER) ─▶ engine.quantizeSession ─▶ engine.crossCheck
       ─▶ identity timeline (engine.fuseTimeline + bindPersons, actor-bound only) ─▶ SessionTracks
       ─▶ engine.extractDecisiveWindows ─▶ track_bin
       ─▶ post_tracks ×n (program_bin ‖ calibration_bin ‖ track_bin, 700 B chunks) ─▶ verify_biometric_proof ×k ─▶ run_rules (oracle, onchain interpreter)
       ─▶ PreRuled ─▶ consent | dispute ─▶ settle_panel ─▶ Settled / refund
```
The TypeScript engine evaluator and the Rust interpreter (`crates/verdict-rules`, used by the Anchor program and the SP1 guest) MUST produce identical results for the same `(program_bin, calibration_bin, track_bin, verified_checkpoints)`. The authoritative semantics are §3 applied to the **TrackBuffer** contents.

---

## 2. Rule language

### 2.1 Program kinds
| `kind` | Meaning | Settles via |
|---|---|---|
| `rules` | computer-vision rule program (default) | rule interpreter → consent / panel |
| `ai_judged` | cannot be expressed in the language; a natural-language question judged by the replay booth. Labeled **AI-judged** in the UI before staking | panel only |
| `market` | World Mode bet on Gemini prediction-market outcomes (§11) | oracle-posted resolution → interpreter → consent / panel |

### 2.2 Entities
Entity names match `^[a-z][a-z0-9_]{0,23}$` and MUST NOT be a reserved word (§2.5). Max 16 entities. Order = declaration order (it is significant: it defines entity indices).

| Surface syntax | AST | Code (§5.1) | Notes |
|---|---|---|---|
| `person(<base58 pubkey>)`, `person(p0)`…`person(p9)` (huddle index), `person("Display Name")` (case-insensitive exact match on a confirmed huddle member) | `{kind:"person", participant: idx}` | 0 | bound to a participant; **makes any leg using it actor-bound**. All three forms canonicalize to the participant index. The member MUST be enrolled (`NOT_ENROLLED`). At most one `person` entity per participant (`DUPLICATE_PERSON`). |
| `person(any)` | `{kind:"person_any"}` | 1 | anonymous; perception uses the largest person track per frame |
| `object("noun phrase")` | `{kind:"object", phrase}` | 2 | phrase normalized: lowercase, trimmed, internal whitespace collapsed to one space, must match `^[a-z0-9][a-z0-9 '\-]{0,47}$` |
| `region(line)` | `{kind:"region", shape:"line"}` | 3 | two points + "behind" side, placed at scene check |
| `region(zone)` | `{kind:"region", shape:"zone"}` | 4 | polygon, 3–8 vertices, placed at scene check |
| `region(tap)` | resolved to `line` or `zone` during canonicalization **[D-1]** | — | `line` if the entity is ever used as the `b` operand of `behind`, `beyond` or `crosses`; otherwise `zone`. Using the same region in both line-only and zone-only positions is a validation error. |

Entity values are parsed by these exact patterns (not by the expression lexer):
`^person\(([1-9A-HJ-NP-Za-km-z]{32,44}|p[0-9]|any|"[^"]{1,32}")\)$`, `^object\("([^"]{1,64})"\)$`, `^region\((tap|line|zone)\)$`. The compiler SHOULD emit `person(pN)`; placeholders such as `<friend_pk>` are only legal in prompt templates.

**Anchor point** of an entity at a frame: `person`/`person_any` → bottom-center `(floor((x0+x1)/2), y1)` (feet); `object` → center `(floor((x0+x1)/2), floor((y0+y1)/2))`. **Center** of any box = `(floor((x0+x1)/2), floor((y0+y1)/2))`.

### 2.3 References and derived sub-regions
A reference (`Ref`) names an entity, optionally with a sub-region suffix. Sub-regions are only allowed on `object` entities, and only as a `b` operand. The `a` operand of every primitive MUST be a plain ref (`BAD_OPERAND`). Openings are derived, never tapped **[D-2]**:

| Suffix | Kind | Geometry at frame f, from the object's box `B=(x0,y0,x1,y1)`, `w=x1-x0`, `h=y1-y0` |
|---|---|---|
| `.opening` | rect | `(x0 + w/10, max(0, y0 - h/10), x1 - w/10, y0 + h/5)` (all `/` truncating) — a band straddling the rim |
| `.interior` | rect | `(x0 + w/10, y0 + h/10, x1 - w/10, y1 - h/10)` |

The **container** of a sub-region is the full box `B`. `B` is the object's box at frame f if present. Otherwise it is the box at the most recent present frame `p` in the **same segment** with `f - p ≤ STALE_REGION_FRAMES`. Otherwise the sub-region (and container) is **undefined** at f, and every primitive using it is false at f. Implementations track the last present frame in a running variable (O(|F|)).

### 2.4 Participants and sides
- `participants`: ordered list of base58 wallet keys, 2..8, distinct, each a confirmed huddle member (`UNKNOWN_PARTICIPANT`). **Index 0 is the creator.** Default when YAML omits it:
  1. creator, then the members bound by `person` entities, in huddle join order;
  2. if that gives fewer than 2 and the huddle has exactly 2 confirmed members, both members;
  3. otherwise error `PARTICIPANTS_UNRESOLVED`. The backend turns this into the clarifying question `{id:"who", text:"Who's in?", kind:"multi", chips:[display names]}`.
- Caps: huddle ≤ 10 members (`MAX_HUDDLE`), bet ≤ 8 participants.
- `sides`: array aligned with `participants`, each `0` or `1`. Side 0 always contains the creator. Both sides non-empty. Default **only when there are exactly 2 participants**: `[0, 1]`. With more than 2 participants the YAML MUST state `sides:` explicitly (the compiler asks) **[D-3]**. The map form `{A: [...], B: [...]}` accepts `person` entity names or base58 pubkeys only (no display names).
- `SideRef` (in outcome): `side(creator)` → side of participant 0; `side(<person entity>)` → side of that entity's participant (error for `person_any`); `side(other)` → the side not named by the other clause; `side(A)` / `side(B)` → side 0 / 1. A `person` entity used only in `side(...)` does not make any leg actor-bound and gets no track.

### 2.5 YAML surface syntax

Top-level keys (all others rejected):

| Key | Type | Required | Default |
|---|---|---|---|
| `version` | int, must be `2` | yes | |
| `kind` | `rules` \| `ai_judged` \| `market` | no | `rules`; `ai_judged: true` is accepted as a synonym for `kind: ai_judged` |
| `participants` | list of pubkeys | no | §2.4 |
| `sides` | list of `0`/`1` aligned with participants, **or** map `{A: [...], B: [...]}` | conditional | §2.4 |
| `entities` | map name → entity syntax | `rules`: yes (≥1); others: no | |
| `legs` | list of leg maps | `rules`, `market`: yes (1..8) | |
| `question` | string 1..280 chars | `ai_judged` only | |
| `outcome` | outcome string | yes | |
| `stake_each` | int `10_000..=1_000_000_000_000` | `rules`/`ai_judged` | (compiler asks "Stake each?") |
| `stakes` | list of int aligned with participants | `market` only | |
| `time_limit_s` | int | no | `120` (`DEFAULT_TIME_LIMIT_S`) for rules/ai_judged; market: computed (§11.4) |

Integers in `stake_each`, `stakes`, `time_limit_s` and leg fields MAY be written with `_` digit separators (`5_000_000`). The parser accepts an int, or a string matching `^[0-9]{1,16}(_[0-9]{3})*$` with the underscores removed **[D-4]**. (YAML 1.2 would otherwise parse it as a string.)

Leg keys:

| Key | Type | Required | Default |
|---|---|---|---|
| `id` | int 1..8, unique, legs listed in ascending id | yes | |
| `actor_bound` | bool | yes (compiler MUST emit it) | — validator recomputes it; a mismatch is an error |
| `valid_attempt` | expression string | no (rules only) | |
| `success` | expression string | rules: yes; market: forbidden | |
| `rule` | rule string | rules: yes; market: forbidden | |
| `attempt_window_s` | duration (`5s`) | no (rules only) | `5s` (50 frames) |
| `market` | `{event_id, contract_id, side: yes or no, prob_bps, venue?}` | market legs only | `venue: "gemini"` |

Market legs: `actor_bound` is always `false`; `attempt_window_frames = 0`; no `success`/`rule`/`valid_attempt`; `prob_bps` in `0..=10000` (quote-time probability, hashed via `json_hash`).

#### 2.5.1 Lexer (expression, rule and outcome strings)
Multi-line YAML plain scalars fold to single spaces before lexing. Tokens are matched **longest-match** at each position:
```
WS     := [ \t\r\n]+                                   (skipped)
PUNCT  := "(" | ")" | "," | ";"
CMP    := ">=" | "<=" | "==" | "!=" | ">" | "<"
DUR    := [0-9]{1,5}(\.[0-9]{1,3})?s | [0-9]{1,7}ms    (no space before the unit)
INT    := [0-9]{1,16}(_[0-9]{3})*
REF    := [a-z][a-z0-9_]{0,23}(\.(opening|interior))?
SIDEL  := "A" | "B"                                    (only valid inside side(...))
```
- A **keyword** is a REF token with no suffix whose text is in the reserved list.
- A DUR or INT token immediately followed by `[a-z_]` is a `PARSE_ERROR`. Any other character gives `PARSE_ERROR` with its 1-based column.
- Rule and outcome phrases are token sequences, not literal strings: `count(success)` is `count ( success )`, `within attempts` is two tokens, `wins iff` is two tokens.

#### 2.5.2 Expression grammar
Keywords are case-sensitive lowercase.
```
expr        := or_expr
or_expr     := and_expr ( "or" and_expr )*                    // left-assoc binary
and_expr    := while_expr ( "and" while_expr )*               // left-assoc binary
while_expr  := then_expr ( "while" then_expr )*               // "while" == "and" (sugar), binds tighter
then_expr   := unary ( "then_within" DUR unary )*             // left-assoc
unary       := "not" unary | postfix
postfix     := primary ( "for_duration" DUR | ( "before" | "before_deadline" ) DUR )*
primary     := "(" expr ")" | atom
atom        := REF REL2 REF                       // overlaps inside above below behind beyond
                                                  // enters leaves disappears_into touches crosses released_by
             | REF "near" REF [ INT ]             // INT = distance in normalized units, default 500
             | REF ( "moving" | "present" | "intact" | "standing" )
             | REF "at_rest" DUR
             | REF "speed" CMP INT                // INT in normalized units / second
             | REF "direction" DIR
             | "rep_count" "(" REF ")" CMP INT
             | FUNC "(" REF "," REF [ "," INT ] ")"   // FUNC ∈ REL2 ∪ {near}
             | FUNC1 "(" REF ")"                      // FUNC1 ∈ {moving, present, intact, standing}
             | "at_rest" "(" REF "," DUR ")"
             | "speed" "(" REF ")" CMP INT
             | "direction" "(" REF "," DIR ")"
DIR         := "up" | "down" | "left" | "right"
```
Functional forms: `FUNC(x, y)` ≡ `x FUNC y` (the first argument is `a`). `before_deadline` ≡ `before`.

**Precedence** (tightest first), with one worked parse per row:

| Level | Operators | Example → AST |
|---|---|---|
| 1 | postfix `for_duration`, `before`, `before_deadline` | `ball moving for_duration 2s and x present` → `and(for_duration(moving(ball)), present(x))` |
| 2 | `not` | `not ball moving for_duration 2s` → `not(for_duration(moving(ball)))` |
| 3 | `then_within` | `a present then_within 2s b present and c present` → `and(then_within(present(a), present(b)), present(c))` |
| 4 | `while` | `a present and b present while c present` → `and(present(a), and(present(b), present(c)))` |
| 5 | `and` | `a present or b present and c present` → `or(present(a), and(present(b), present(c)))` |
| 6 | `or` | `a present or b present or c present` → `or(or(present(a), present(b)), present(c))` |

`toYaml` MUST emit full parentheses around every non-atom operand of a binary or postfix node, so canonical YAML never depends on precedence.

Absent ⇒ primitive false ⇒ `not` true. This is intentional. The compiler prompt MUST avoid `not` directly over primitives.

#### 2.5.3 Rule grammar (`rule:` value)
```
rule := "success"                                                   // exists
      | "never" "(" "success" ")"
      | "count" "(" "success" ")" CMP INT [ "within" "attempts" INT ]
      | "holds" "(" "success" ")" "for" DUR
      | "success" ( "before" | "before_deadline" ) DUR
```
- `count … within attempts N` requires the leg to have `valid_attempt`. A leg with `valid_attempt` and a `count` rule without `within attempts` is `BAD_RULE`.
- `count(success)` without attempts counts rising edges of `success`.
- `k` in `0..=1000`, `N` in `1..=20`. `holds`/`before` durations MUST be `≤ time_limit_s·FPS` frames (`BAD_RULE`).

#### 2.5.4 Outcome grammar (`outcome:` value)
```
outcome  := SIDEREF "wins" "iff" legcond ";" "else" SIDEREF
          | SIDEREF "wins" "iff" "yes" ";" "else" SIDEREF        // ai_judged only
legcond  := legor
legor    := legand ( "or" legand )*
legand   := legnot ( "and" legnot )*
legnot   := "not" legnot | "(" legcond ")" | "leg" INT [ "true" | "false" ]   // "leg 2 false" == not leg 2
SIDEREF  := "side" "(" ( "creator" | "other" | SIDEL | REF ) ")"
```
At most one of the two SIDEREFs may be `side(other)`. The two must resolve to different sides.

**Reserved words**: `and or not while then_within for_duration before before_deadline near moving present intact standing at_rest speed direction rep_count overlaps inside above below behind beyond enters leaves disappears_into touches crosses released_by count within attempts success never holds for leg side wins iff else yes creator other any tap line zone up down left right opening interior true false`.

### 2.6 AST (TypeScript, normative; JSON form is identical)
```ts
export type Pubkey = string;                 // base58
export type Cmp = ">=" | ">" | "<=" | "<" | "==" | "!=";
export type Dir = "up" | "down" | "left" | "right";
export interface Ref { e: string; sub?: "opening" | "interior" }   // entity name; sub only on b operands

export type Entity =
  | { name: string; kind: "person"; participant: number }          // index into participants
  | { name: string; kind: "person_any" }
  | { name: string; kind: "object"; phrase: string }
  | { name: string; kind: "region"; shape: "line" | "zone" };      // "tap" never appears in canonical AST

export type Rel2 = "overlaps" | "inside" | "above" | "below" | "behind" | "beyond"
  | "enters" | "leaves" | "disappears_into" | "touches" | "crosses" | "released_by";

export type Expr =
  | { op: "and"; args: [Expr, Expr] }
  | { op: "or"; args: [Expr, Expr] }
  | { op: "not"; arg: Expr }
  | { op: "then_within"; frames: number; first: Expr; then: Expr }   // frames 1..=36000
  | { op: "for_duration"; frames: number; arg: Expr }                 // frames 1..=36000
  | { op: "before"; frames: number; arg: Expr }                       // frames 1..=36000
  | { op: Rel2; a: Ref; b: Ref }
  | { op: "near"; a: Ref; b: Ref; dist: number }                      // 0..=14143
  | { op: "moving" | "present" | "intact" | "standing"; a: Ref }
  | { op: "at_rest"; a: Ref; frames: number }                         // 1..=36000
  | { op: "speed"; a: Ref; cmp: Cmp; value: number }                  // 0..=100000
  | { op: "direction"; a: Ref; dir: Dir }
  | { op: "rep_count"; a: Ref; cmp: Cmp; value: number };             // 0..=1000

export type Rule =
  | { kind: "exists" }
  | { kind: "never" }
  | { kind: "count"; cmp: Cmp; k: number; attempts: number }        // attempts 0 = no valid_attempt
  | { kind: "holds"; frames: number }
  | { kind: "before"; frames: number };

export interface MarketRef { venue: "gemini"; event_id: string; contract_id: string; side: "yes" | "no"; prob_bps: number }

export interface Leg {
  id: number;                         // 1..8
  actor_bound: boolean;               // market: always false
  attempt_window_frames: number;      // rules legs: always present (default 50, 1..=36000); market legs: 0
  valid_attempt?: Expr;
  success?: Expr;                     // required for kind "rules"
  rule?: Rule;                        // required for kind "rules"
  market?: MarketRef;                 // required for kind "market"
}

export type LegExpr =
  | { op: "leg"; id: number }
  | { op: "and" | "or"; args: [LegExpr, LegExpr] }
  | { op: "not"; arg: LegExpr };

export interface Outcome {
  if_true: 0 | 1;                     // side that wins if condition is True
  condition: LegExpr | { op: "yes" }; // { op:"yes" } only for ai_judged
  else: 0 | 1;                        // MUST differ from if_true
}

export interface Program {
  version: 2;
  kind: "rules" | "ai_judged" | "market";
  participants: Pubkey[];             // 2..8, index 0 = creator
  sides: (0 | 1)[];                   // aligned; sides[0] = 0
  entities: Entity[];                 // [] allowed for ai_judged/market
  legs: Leg[];                        // [] for ai_judged
  question?: string;                  // ai_judged only
  outcome: Outcome;
  stake_each?: number;                // rules, ai_judged: 10_000..=1_000_000_000_000
  stakes?: number[];                  // market only, aligned with participants, each 10_000..=1_000_000_000_000
  time_limit_s: number;               // 1..=3600 (market: ..=2_592_000)
}
```
Binary operators are always 2-ary; n-ary source chains become left-nested (`a or b or c` → `or(or(a,b),c)`).

### 2.7 Compile context, canonicalization and validation
`parseYaml(src: string, ctx: CompileContext): { ok: true; program: Program; warnings: CompileError[] } | { ok: false; errors: CompileError[] }` where
```ts
interface CompileContext {
  creator: Pubkey;
  huddle: { wallet: Pubkey; display_name: string; enrolled: boolean }[];   // confirmed members, join order, creator first
}
interface CompileError { path: string /* e.g. "legs[0].success" */; code: string; message: string; col?: number }
```
Canonicalization (`canonicalize(p, ctx): Program`, idempotent) MUST:
1. Resolve `person(...)` forms to huddle members, then fill defaults (`participants` per §2.4, `sides`, `attempt_window_frames`, `kind`, `time_limit_s`, market `venue`), then map persons to participant indices.
2. Resolve `region(tap)` shapes (§2.2).
3. Normalize object phrases (§2.2).
4. Convert all durations to frames. Rewrite `while` → `and`, `before_deadline` → `before`, functional forms → canonical node, `leg N false` → `not`.
5. Rewrite `disappears_into(a, <object>)` → `disappears_into(a, <object>.opening)`.
6. Omit absent optional fields (never `null`).

Validation (`validateProgram(p, ctx): { errors: CompileError[]; warnings: CompileError[] }`) MUST reject (code in parentheses):
- `PARSE_ERROR` (lexer/grammar), `UNKNOWN_ENTITY`, `BAD_SUBREGION` (sub-region on a non-object or on an `a` operand), `UNKNOWN_PARTICIPANT`, `PARTICIPANTS_UNRESOLVED`, `NOT_ENROLLED`, `DUPLICATE_PERSON`.
- Operand kinds (`BAD_OPERAND`):
  - `a` of every primitive must be a plain ref to person/person_any/object.
  - `behind`/`beyond`/`crosses` require `b` = line region.
  - `enters`/`leaves` require `b` = zone region, sub-region, or object (object ⇒ `inside` semantics).
  - `disappears_into` requires `b` = `.opening` sub-region or zone (objects are rewritten in canonicalization).
  - `released_by` requires `b` = person/person_any.
  - `standing`/`rep_count` require `a` = person/person_any.
  - No primitive may take a line region except those three. All other `b` operands may be any non-line entity or sub-region.
- `ACTOR_BOUND_MISMATCH`: `actor_bound` ≠ (leg references any `kind:"person"` entity in `valid_attempt` or `success`).
- `UNUSED_PERSON`: a `person` entity referenced by no leg and no `side(...)`.
- `BAD_RULE`, for any of:
  - `count … within attempts` without `valid_attempt`
  - `valid_attempt` with a rule other than `count … within attempts`
  - `holds`/`before` frames > `time_limit_s·FPS`
  - range violations of `k`/`N`
- `NEGATIVE_ACTOR_RULE`: an actor-bound leg with rule `never`, or `count` with `cmp ∈ {<, <=, ==, !=}`, or `count >= 0`. The compiler MUST instead emit the positive leg and swap `if_true`/`else`.
- `CHECKPOINT_LIMIT`:
  - For each actor-bound `count` leg: `attempts ≤ 8`, and `k' ≤ 8`, where `k' = k` for `>=` and `k+1` for `>`.
  - The static checkpoint bound `Σ_{actor-bound legs} n_anchor(leg) × |persons(leg)|` MUST be `≤ MAX_CHECKPOINTS`.
  - `n_anchor` = `min(k', attempts)` for count with attempts, `k'` for count without attempts, and 1 for exists/before/holds. `persons` is defined in §3.8.
- `BAD_OUTCOME`: outcome references a missing leg, `if_true == else`, or both SIDEREFs are `side(other)`.
- `LIMIT`: §0.5 limits; an encoded expression > 512 bytes, > 64 nodes or depth > 12; a condition > 32 nodes; leaf parameter ranges (§5.1).
- `BAD_SIDES`; `BAD_STAKE` (any stake < 10_000 or > 10^12); `BAD_TIME_LIMIT`; `BAD_KIND` (e.g. `question` on rules, `success` on a market leg).

Warnings (non-blocking): an unused `object`/`person_any` entity (`UNUSED_ENTITY`; it gets no track); `for_duration` applied directly to an event primitive (`PULSE_DURATION`); a count with attempts where `k' > N` (`UNWINNABLE`).

### 2.8 Read-back
`readback(p: Program, ctx: { names: Record<Pubkey, string>; labels?: Record<string, string>; markets?: Record<string /*market_hash hex*/, string> }): string[]` returns deterministic English lines (no LLM, no wrapping, no trailing period). Entity substitution: persons → display name; objects → `labels[entity]` lowercased, else the phrase; regions → "the line" / "the zone"; `.opening` → "the opening of {e}"; `.interior` → "the inside of {e}".

Durations render as `"{n}s"` (one decimal if `frames % 10 ≠ 0`, e.g. `"1.5s"`), or `"{m}m {s}s"` / `"{m}m"` for whole seconds ≥ 60. CMP words: `>=` "at least", `>` "more than", `<=` "at most", `<` "fewer than", `==` "exactly", `!=` "not exactly". Money uses §12.9 format.

Expression templates:

| Op | Template |
|---|---|
| `overlaps` | "{a} overlaps {b}" |
| `inside` | "{a} is inside {b}" |
| `above` / `below` | "{a} is above {b}" / "{a} is below {b}" |
| `behind` / `beyond` | "{a} is behind {b}" / "{a} is past {b}" |
| `near` | "{a} is near {b}" |
| `moving` | "{a} is moving" |
| `present` | "{a} is visible" |
| `intact` | "{a} stays standing" |
| `standing` | "{a} is standing" |
| `at_rest` | "{a} stays still for {d}" |
| `speed` | "{a} moves {cmp} {v}" |
| `direction` | "{a} moves {dir}" |
| `rep_count` | "{a} does {cmp} {n} reps" |
| `enters` / `leaves` | "{a} enters {b}" / "{a} leaves {b}" |
| `disappears_into` | "{a} goes into {b}" |
| `touches` | "{a} touches {b}" |
| `crosses` | "{a} crosses {b}" |
| `released_by` | "{b} releases {a}" |
| `and` / `or` | "{x} and {y}" / "{x} or {y}". A child that is a different binary op is wrapped in "(…)" |
| `not` | "not: {x}" |
| `then_within` | "{x}, then within {d}, {y}" |
| `for_duration` | "{x} for {d}" |
| `before` | "{x} before {d}" |

Line order: for each leg in order, its rule lines, then the outcome line, the stake line and the limit line.

| Item | Lines |
|---|---|
| exists | "{success}" |
| never | "Never: {success}" |
| count without attempts | "{success}, {cmp} {k} times" |
| count with attempts | "Counts if: {valid_attempt}" / "Wins an attempt if: {success}" / "Needs {cmp} {k} of {N} attempts" |
| holds | "{success} for {d} straight" |
| before | "{success} within {d}" |
| market leg | "{markets[hash] or event_id/contract_id} resolves {yes\|no}" |
| ai_judged | "Question: {question}" |
| outcome | "{side names} win if {cond}; otherwise {side names} win". `cond` renders `leg N` as "leg N", `not` as "not leg N", and `and`/`or` as words; ai_judged uses "yes" |
| stake | "{$x.xx} each" (rules/ai_judged) or "Stakes {$a} / {$b}" (market, participant order) |
| limit | "Time limit {d}" |

Golden vectors include the readback lines.

### 2.9 Canonical YAML (`toYaml`)
Key order: `version, kind, participants, sides, entities, legs, question, outcome, stake_each, stakes, time_limit_s`. Leg key order: `id, actor_bound, valid_attempt, success, rule, attempt_window_s, market`. Persons are written as base58, integers without separators, durations as `{frames/10}s` (one decimal if needed), with full parentheses (§2.5.2). `parseYaml(toYaml(p))` MUST equal `p`.

---

## 3. Evaluation semantics (normative; identical in TS and Rust)

### 3.1 Inputs
`evaluate(program_bin, calibration_bin, track_bin | market_bin, verified: {participant, frame}[], opts?: { maxCost?: number /* default MAX_EVAL_COST; SP1 guest: Infinity */ }) → EvalResult`.
The TS engine additionally offers `evaluateProgram(program: Program, calibration, buffer: TrackBufferData, verified)`, implemented as `encode*` + `evaluate` (§0.4). Consensus code reads only the **decoded binary** values (§5).

**Check order** (identical in TS and Rust):
1. Decode errors (`MalformedProgram`, `MalformedCalibration`, `MalformedTracks`). Onchain these are rejected at `post_tracks` finalize, so `run_rules` never sees them.
2. Kind: `ai_judged` ⇒ `needs_panel`, reason 11, regardless of track flags. `market` ignores track flags (`market_bin` has none) and continues at §3.11.
3. track_bin flags bit3 (`window_unavailable`) ⇒ `needs_panel`, reason 13. Else flags bit1 (`cross_check_ok`) == 0 ⇒ `needs_panel`, reason 12.
4. Cost: `cost > maxCost` (§3.13) ⇒ `needs_panel`, reason 13.
5. Legs (§3.2–§3.9), outcome (§3.10).

In cases 2–4 every leg result is 2, `leg_causes` is `[]` per leg, and there are no checkpoints.

### 3.2 Frame space
- The buffer holds `S` segments; segment `s` covers absolute frames `[start_s, start_s + n_s)`. `F` = ordered set of all buffer frames. Signals are bitsets indexed by **position in F** (`pos(f)`), not by absolute frame.
- `LIMIT = time_limit_s · FPS`. The decoder guarantees every frame is `< LIMIT + TAIL_FRAMES` **[D-38]**. All node signals are computed over all of F. Frames `≥ LIMIT` exist only for look-ahead. Rule evaluation, attempt collection, decisive frames and checkpoints (§3.7–§3.8) consider only `F_R = { f ∈ F : f < LIMIT }`.
- `seg(f)` = segment containing f. `segstart(f)` = its first frame. `prev(f) = f-1` if `f-1 ∈ seg(f)`, else **none**. All look-backs and look-aheads stay **within the segment**. A frame outside the segment is "not available", and any requirement on it is unsatisfied.
- `lastSeen(a, f)` = the latest `p < f` in `seg(f)` with `present(a, p)` and `f - p ≤ RELEASE_GAP`, or none.
- For a tracked entity `e` at frame `f`: `rec(e,f)` is its 12-byte record (§5.4), found through the track table. `present(e,f) ⇔ rec.conf ≥ PRESENCE_MIN`. `box(e,f) = (x0,y0,x1,y1)` if present, else undefined.
- Region entities are static (from calibration). A sub-region Ref uses §2.3 (stale rule within segment). "b defined at f": region → always; object/person → `present(b,f)`; sub-region → container defined.
- Every expression node evaluates to a boolean signal `X[f]` for all `f ∈ F`. Any primitive whose operand is absent / undefined at f is **false** at f.

### 3.3 Geometry helpers
```
area(B)            = (x1-x0)*(y1-y0)                             // u64
inter(A,B)         = (max(ax0,bx0), max(ay0,by0), min(ax1,bx1), min(ay1,by1)); empty if ix0>=ix1 or iy0>=iy1
ptInRect(P,R)      = R.x0 <= P.x <= R.x1 && R.y0 <= P.y <= R.y1   // inclusive
side(L,P)          = sign( (bx-ax)*(py-ay) - (by-ay)*(px-ax) )   // i64; L = (a,b); returns -1, 0, +1
ptInPoly(P,V[0..n)) // even-odd, i64, exact:
    inside = false
    for i in 0..n: j = (i + n - 1) % n
        if (V[i].y > P.y) != (V[j].y > P.y):
            lhs = (P.x - V[i].x) * (V[j].y - V[i].y)
            rhs = (P.y - V[i].y) * (V[j].x - V[i].x)
            if (V[j].y - V[i].y) > 0 ? lhs < rhs : lhs > rhs: inside = !inside
    return inside
polyBBox(V)        = (min x, min y, max x, max y)
expand(B,pct)      = ex = (x1-x0)*pct/100, ey = (y1-y0)*pct/100 → (x0-ex, y0-ey, x1+ex, y1+ey), each clamped to [0,10000]
vel(e,f)           = defined iff present(e,f) && f-VEL_K ∈ seg(f) && present(e,f-VEL_K):
                     dx = cx(f)-cx(f-VEL_K), dy = cy(f)-cy(f-VEL_K)     (centers, i64)
speed(e,f)         = isqrt(dx*dx + dy*dy) * FPS / VEL_K                  // ups
```
"B-box of operand b" (`bbox_b`): object/person → `box(b,f)`; sub-region → its rect; zone → `polyBBox`. All products are bounded by 2·10^8, so `number` is safe in TS.

### 3.4 State primitives (level signals)
| op | true at f iff |
|---|---|
| `present(a)` | `present(a,f)` |
| `overlaps(a,b)` | b box/rect: `inter(box(a), bbox_b)` non-empty. b zone: `ptInPoly(center(a))` or `ptInPoly(anchor(a))` |
| `inside(a,b)` | b object/person: `ptInRect(center(a), box(b))` and `2*area(inter) >= area(box(a))` (if `area(box(a))=0`, only the point test). b sub-region: `ptInRect(center(a), rect)`. b zone: `ptInPoly(anchor(a), V)` |
| `above(a,b)` | `cy(a) < bbox_b.y0` and x-ranges overlap strictly (`a.x0 < b.x1 && b.x0 < a.x1`) |
| `below(a,b)` | `cy(a) > bbox_b.y1` and x-ranges overlap strictly |
| `near(a,b,d)` | `gx = max(0, b.x0-a.x1, a.x0-b.x1)`, `gy = max(0, b.y0-a.y1, a.y0-b.y1)` (on `bbox_b`, i64); `gx²+gy² <= d²` |
| `behind(a,L)` | `s = side(L, anchor(a))`; `s != 0 && s == L.behind_sign` |
| `beyond(a,L)` | `s != 0 && s == -L.behind_sign` |
| `moving(a)` | `vel` defined and `speed >= MOVE_MIN_UPS` |
| `speed(a) cmp v` | `vel` defined and `speed cmp v` |
| `direction(a,dir)` | `vel` defined, `speed >= MOVE_MIN_UPS`, and: up `dy<0 && 2*abs(dy) >= abs(dx)`; down `dy>0 && 2*dy >= abs(dx)`; left `dx<0 && 2*abs(dx) >= abs(dy)`; right `dx>0 && 2*dx >= abs(dy)` |
| `at_rest(a,D)` | `for_duration(D, still(a))` where `still(a)[f] = vel defined && speed <= STILL_MAX_UPS` |
| `intact(a)` | present and `(y1-y0)*100 >= ref_h * INTACT_PCT` (`ref_h` from the track table; `ref_h=0` ⇒ just present) |
| `standing(a)` | present and `pose & 0x01` |
| `rep_count(a) cmp n` | `present(a,f) && reps(a,f) cmp n`. `reps` is computed by scanning **all** frames of F in order (crossing segments): `phase := none; count := 0`; on a present frame with `pose&0x02` (low) → `phase := low`; with `pose&0x04` (high) → if `phase == low` then `count += 1`; `phase := high`. `reps(a,f)` = count after processing f |

`fill` (record byte 9) is **advisory**: no primitive reads it; it is sealed for exhibits.

### 3.5 Event primitives (pulse signals)
| op | true at f iff |
|---|---|
| `enters(a,b)` | `p = lastSeen(a,f)` exists; b defined at f and at p; `inside(a,b)[f] && !inside(a,b)[p]` |
| `leaves(a,b)` | `present(a,f)`; `p = lastSeen(a,f)` exists; b defined at f and at p; `!inside(a,b)[f] && inside(a,b)[p]` |
| `touches(a,b)` | `p = lastSeen(a,f)` exists; b defined at p; `overlaps(a,b)[f] && !overlaps(a,b)[p]` |
| `crosses(a,L)` | `present(a,f)`; `p = lastSeen(a,f)` exists; `side(L,anchor(a,p))` and `side(L,anchor(a,f))` both nonzero and different |
| `released_by(a,b)` | `held(g) = present(a,g) && present(b,g) && ptInRect(center(a,g), expand(box(b,g), HAND_EXPAND_PCT))`. True iff `present(a,f) && !held(f)`, `p = lastSeen(a,f)` exists, `held(p)`, and `heldrun(p) >= RELEASE_HOLD`, where `heldrun(g) = 1 + heldrun(lastSeen(a,g))` if `held(g)` and `lastSeen(a,g)` exists and is held, else `1` if `held(g)`, else 0 (absent gaps ≤ `RELEASE_GAP` between held frames are bridged; scanning stops at `RELEASE_HOLD`) |
| `disappears_into(a,b)` | `raw[f] && !(prev(f) exists && raw[prev])`, where `raw[f]` iff all hold: (1) `present(a,f)` and b defined at f; (2) entry: b `.opening` → `ptInRect(center(a,f), opening)`, b zone → `ptInPoly(center(a,f))`; (3) descending: ∃ `p ∈ [f-DESCEND_LOOKBACK, f-1]` in seg(f), `present(a,p)` and `cy(a,f) > cy(a,p)`; (4) look-ahead fits: `f + DISAPPEAR_FRAMES` ∈ seg(f); (5) for every `g ∈ (f, f+DISAPPEAR_FRAMES]`: `!present(a,g)` or `center(a,g)` inside the container at g (`.opening` → container box of the owning object at g (stale rule), `ptInRect`; zone → `ptInPoly`); container undefined ⇒ must be absent; (6) ∃ `g ∈ (f, f+DISAPPEAR_FRAMES]` with `!present(a,g)` |

### 3.6 Combinators
| op | signal |
|---|---|
| `and`, `or`, `not` | pointwise |
| `then_within(D, X, Y)` | `Y[g] && ∃ f ∈ [max(segstart(g), g-D), g] : X[f]` (running last-true frame) |
| `for_duration(D, X)` | `g-D+1 >= segstart(g) && ∀ f ∈ [g-D+1, g] : X[f]` (run-length counter) |
| `before(D, X)` | `X[g] && g < D` (absolute frame) |

`rising(X)[f] = X[f] && (f == 0 || (prev(f) exists && !X[prev(f)]))`. Absolute frame 0 has no predecessor by definition, so a signal true at frame 0 rises there.

### 3.7 Leg evaluation (kind `rules`)
Let `S` = success signal, `V` = valid_attempt signal, `W` = `attempt_window_frames`. All frames below are in `F_R`. The **raw value** is computed first; §3.9 may then turn it into Unknown.

| rule | raw value | decisive frames `DF` |
|---|---|---|
| `count`, attempts `N>0` | `R = rising(V)` frames ascending (all of them); attempts `a_1..a_m` = first `min(N, len(R))` of R. For each i: `end_i = min(a_i + W, next element of R after a_i, or +∞)`; `s_i` = first `f ∈ seg(a_i)` with `a_i <= f < end_i && rising(S)[f]`. `c` = number of i with `s_i` defined. Value = `c cmp k` | all `a_i` and all defined `s_i` |
| `count`, attempts `0` | `c = len(rising(S))`; value `c cmp k` | all frames of `rising(S)` |
| `exists` | `∃ f: S[f]` | first such f (if any) |
| `never` | `¬∃ f: S[f]` | first f with `S[f]` (if any) |
| `before(D)` | `∃ f < D: S[f]` | first such f (if any) |
| `holds(D)` | `∀ f ∈ [0, D): S[f]` — requires every frame `0..D-1` ∈ F, else **Unknown (COVERAGE)** | first f < D with `!S[f]` (if any) |

Leg value is `0 = False`, `1 = True`, or `2 = Unknown`.

### 3.8 Identity checkpoints (actor-bound legs only)
For each actor-bound leg whose **raw value is True** (checkpoints are computed whatever MOTION/CONF/COVERAGE/OCCLUSION say) **[D-40]**:
- `persons(leg)` = `kind:"person"` entities referenced in `valid_attempt` if it references at least one, else those in `success`.
- Anchor frames, with `k' = k` for `>=` and `k+1` for `>`:
  - count with attempts: the `a_i` of the first `k'` counted attempts (ascending i with `s_i` defined);
  - count without attempts: the first `k'` frames of `rising(S)`;
  - exists/before: the first f with `S[f]` (before `D` for before);
  - holds: `D-1`.
- Checkpoints = every pair `(participant(person), anchor frame)`.

The bet's checkpoint list = union over legs, deduplicated, sorted by `(frame, participant)`. If it has more than `MAX_CHECKPOINTS` entries, `n_checkpoints = 0`, the list is empty, and **every actor-bound leg is Unknown (IDENTITY)**. (Validation's static bound, §2.7, makes this unreachable for valid programs. It remains as a guard.)

A checkpoint **passes** iff all of these hold:
- the person entity's record at that frame is `present`;
- it has `id_conf >= ID_CONF_MIN`;
- `(participant, frame)` is in the verified list (onchain: `Bet.bio`, set by `verify_biometric_proof`).

Any failing checkpoint of a leg makes that leg **Unknown (IDENTITY)**.

### 3.9 Unknown causes (applied after 3.7, in this order; the first that applies is recorded, and any makes the leg Unknown)
1. `MOTION`: track_bin flags bit0 (camera motion) set ⇒ all `rules` legs Unknown.
2. `COVERAGE`: see `holds`.
3. `OCCLUSION`: a `holds` leg with raw value False, where some non-region entity referenced in `success` is absent at the first failing frame.
4. `CONF`: at any decisive frame `d`, some non-region entity referenced in the leg's `valid_attempt` or `success` (including the owning object of a sub-region ref) has `present(e,d)` and `rec.conf < DECISIVE_CONF_MIN`.
5. `IDENTITY`: §3.8.

### 3.10 Outcome and pre-ruling
- `condition` is evaluated with Kleene three-valued logic over leg values: `and(F,·)=F`, `and(T,T)=T`, else U; `or(T,·)=T`, `or(F,F)=F`, else U; `not(U)=U`.
- True ⇒ winning side = `if_true`; False ⇒ `else`; Unknown ⇒ no winner.
- `winner_mask` = bitmask over participants: bit i set iff `sides[i] == winning side`.
- Pre-ruling code: `1 = WINNER` (status ok), `3 = NEEDS_PANEL` (status needs_panel, winner_mask 0). Code `2 = NO_CONTEST` is produced only by the panel / refund paths.
- Reasons for NEEDS_PANEL: `10 LOW_CONFIDENCE` (Unknown condition), `11 AI_JUDGED`, `12 CROSS_CHECK_FAILED`, `13 WINDOW_UNAVAILABLE` (also used for the cost cap).

### 3.11 Other kinds
- `ai_judged`: result = NEEDS_PANEL, reason 11, `leg_results = []`.
- `market`: leg value from the market_bin entry whose `market_hash` equals the leg's (§5.5). `result 2 (void)` or a missing entry ⇒ Unknown (cause `VOID`). Otherwise True iff `result == expected` (`side yes` ⇒ expected 1, `no` ⇒ 0). Then §3.10.

### 3.12 Result object
```ts
type LegCause = "MOTION" | "COVERAGE" | "OCCLUSION" | "CONF" | "IDENTITY" | "VOID";
interface EvalResult {
  status: "ok" | "needs_panel";
  reason: 0 | 10 | 11 | 12 | 13;            // 0 when ok
  preruling: 1 | 3;
  winner_mask: number;                      // u8
  leg_results: (0 | 1 | 2)[];               // per leg in program order; onchain [u8;8] padded with 0xFF
  leg_causes: LegCause[][];                 // per leg; [] when not Unknown or when needs_panel came from §3.1 steps 2–4
  decisive_frames: number[][];              // per leg, list of frames
  attempts: { leg: number; frame: number; success_frame: number | null }[];
  checkpoints: { participant: number; frame: number }[];
  n_checkpoints: number;
  cost: number;
}
```
Rust returns `EvalOutput { preruling: u8, reason: u8, winner_mask: u8, leg_results: [u8; 8], n_checkpoints: u8, checkpoints: [(u8, u32); 8] }`.

### 3.13 Implementation constraints (normative)
- `crates/verdict-rules` is `#![no_std]`, has no Anchor dependency and **no `alloc`**. The Anchor program and the SP1 guest depend on it. It is generic over `const W: usize` signal words: onchain `W = 16` (`MAX_EVAL_FRAMES = 1024`). The SP1 guest uses a larger `W` and `maxCost = ∞`.
- A signal is `[u64; W]`, a bitset indexed by position in F. The interpreter evaluates expressions recursively and returns signals by value, so peak stack ≈ depth × 3 × 128 B. It reads records directly from the TrackBuffer account data. There is no copying and no heap. Do not use `request_heap_frame`.
- `then_within`, `for_duration`, `at_rest`, `rep_count`, `count`, `lastSeen`, `heldrun` and the stale-region lookups MUST be O(|F|): use running last-true / last-present frames and run-length counters, never an O(|F|·D) rescan.
- **Cost**: `cost = (|F| + EVAL_COST_SETUP_FRAMES) × Σ_legs Σ_nodes w(node)` over `valid_attempt` and `success`. `w` = 1 for combinators (`and or not then_within for_duration before`); 2 for state leaves, except 4 for `overlaps` and `inside`; 4 for event leaves, except 6 for `enters`, `leaves` and `touches` and 12 for `disappears_into`. (`overlaps`, `inside`, `enters`, `leaves`, `touches` and `disappears_into` can run an even-odd polygon test per frame.) The `EVAL_COST_SETUP_FRAMES` term charges each node's per-evaluation work that doesn't scale with |F| (decode, signal set-up, zone preparation). If `cost > MAX_EVAL_COST`, the result is `needs_panel`, reason 13 (§3.1 step 4). TS and Rust compute it identically before evaluating legs. (D-47)
- Every `run_rules` transaction carries `SetComputeUnitLimit(1_400_000)`. The Chain team benchmarks the worst case allowed by `MAX_EVAL_COST` in LiteSVM, and lowers `MAX_EVAL_COST` (in this document first) if it exceeds 1.2M CU. Current bound (`programs/verdict/tests/node_costs.rs`, release build): `CU(run_rules) ≤ 40,000 + 60 × records + 120 × cost` for every accepted buffer, i.e. ≤ 1.08M CU at `cost = MAX_EVAL_COST` with a full payload. The `worst_case_*` benchmarks in `programs/verdict/tests/compute.rs` run at the cap.

---

## 4. Canonical serialization and hashes

### 4.1 Canonical JSON (`canonicalJson(v): string`)
RFC 8785 (JCS) restricted to integers:
- Objects: keys sorted ascending by UTF-16 code units; no duplicate keys; members with `undefined` omitted; `null` forbidden (throw).
- Numbers: safe integers only, shortest decimal, no `+`, no leading zeros, no `-0`; non-integers throw.
- Strings: NFC-normalized; escapes: `\"` `\\` `\b` `\f` `\n` `\r` `\t`, other code points `< 0x20` as `\u00xx` (lowercase hex); everything else literal UTF-8 (`/` not escaped).
- No whitespace. Arrays keep order. Output UTF-8 bytes.

### 4.2 Hashes
| Name | Formula |
|---|---|
| `json_hash` | `sha256(utf8(canonicalJson(canonicalize(program))))` |
| `program_hash` | `sha256(program_bin)`. program_bin embeds json_hash, so it commits to everything including phrases, prob_bps and the question |
| `scene_hash` | `sha256(utf8(canonicalJson(calibration.scene)))` |
| `calibration_hash` | `sha256(calibration_bin)`; **32 zero bytes** for `ai_judged`/`market` (no calibration, calibration_bin empty) |
| `tracks_hash` | `sha256(track_bin)` (or market_bin); zero for an SP1-only buffer |
| `market_hash` | `sha256(utf8("gemini:" + event_id + ":" + contract_id))` |
| `accept_sig` | `ed25519_sign(wallet_i, "VERDICT/ACCEPT-SIG/v1" ‖ program_hash[32] ‖ sha256(wav_i)[32])`, produced on the counterparty's phone behind the passkey/biometric prompt |
| `acceptance_audio_hash` | rules/ai_judged: `sha256("VERDICT/ACCEPT/v1" ‖ u8 P ‖ h_0 ‖ … ‖ h_{P-1})`, `h_0 = sha256(creator dictation WAV bytes)` (32 zero bytes if typed), `h_i = sha256(sha256(wav_i) ‖ accept_sig_i[64])` for i ≥ 1. WAV = 16 kHz mono PCM16, as uploaded. **market: 32 zero bytes** |
| `terms_hash` | `sha256("VERDICT/TERMS/v1" ‖ oracle[32] ‖ judges[0][32] ‖ judges[1][32] ‖ judges[2][32] ‖ acceptance_audio_hash[32])` |
| `model_hash` | `sha256(utf8(canonicalJson({image, weights_sha256, prompts:[...phrases in entity order], settings:{...}})))` — computed by the perception job, embedded in track_bin |
| `bio_hash` | `sha256(u8 n_bio ‖ bio[0..n_bio])` (each BioCheck 6 bytes Borsh) — SP1 public values |

---

## 5. Binary encodings

### 5.1 `program_bin` (magic `VRDP`)
| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `0x56 0x52 0x44 0x50` ("VRDP") |
| 4 | 1 | `format_version` = 2 |
| 5 | 1 | `kind`: 0 rules, 1 ai_judged, 2 market |
| 6 | 1 | `fps` = 10 |
| 7 | 1 | `P` participants (2..8) |
| 8 | 32 | `json_hash` |
| 40 | 4 | `time_limit_s` u32 |
| 44 | 32·P | participant pubkeys |
| … | 8·P | `stakes` u64 per participant (rules/ai_judged: all = stake_each) |
| … | 1 | `side_b_mask` u8 (bit i ⇔ `sides[i] == 1`) |
| … | 1 | `E` entities (0..16) |
| … | 2·E | per entity: `kind` u8 (0 person, 1 person_any, 2 object, 3 line, 4 zone), `param` u8 (participant idx for person, else 0) |
| … | 1 | `L` legs (0..8) |
| … | var | L × Leg |
| … | 1 | outcome `if_true` u8 |
| … | 1 | outcome `else` u8 |
| … | 2 | `cond_len` u16 |
| … | cond_len | condition code |
The end of the buffer MUST coincide with the end of the condition code (no trailing bytes).

**Leg**:
| Size | Field |
|---|---|
| 1 | `id` |
| 1 | `flags`: bit0 actor_bound, bit1 has_valid_attempt, bits 2–7 = 0 |
| 1 | `rule_kind`: 0 exists, 1 count, 2 holds, 3 never, 4 before, 5 market |
| 1 | `rule_cmp` (CMP code for count; 0 otherwise) |
| 2 | `rule_k` u16 (count k; market: expected 1=yes/0=no; 0 otherwise) |
| 4 | `rule_n` u32 (count: attempts, 0 = none; holds/before: frames; 0 otherwise) |
| 2 | `attempt_window` u16 frames (rules legs: the canonical value even if unused; market: 0) |
| 2 | `va_len` u16 (0 if none) |
| va_len | valid_attempt code |
| 2 | `succ_len` u16 |
| succ_len | success code; **market legs: exactly 32 bytes = market_hash** |

**CMP codes**: 0 `>=`, 1 `>`, 2 `<=`, 3 `<`, 4 `==`, 5 `!=`. **DIR codes**: 0 up, 1 down, 2 left, 3 right.

**Ref byte**: bits 0–3 entity index; bits 4–5 sub-region (0 none, 1 opening, 2 interior); bits 6–7 zero. An `a` ref MUST have sub-region 0.

**Expression code** — prefix order. Node count = number of op bytes. Depth: a leaf has depth 1, so `not(leaf)` has depth 2.
| Op | Code | Encoding after the op byte |
|---|---|---|
| and | 0x01 | `[left][right]` |
| or | 0x02 | `[left][right]` |
| not | 0x03 | `[x]` |
| then_within | 0x04 | `u16 frames` (1..=36000), `[first][then]` |
| for_duration | 0x05 | `u16 frames` (1..=36000), `[x]` |
| before | 0x06 | `u32 frames` (1..=36000), `[x]` |
| *leaf* | 0x10–0x41 | `a: u8 ref`, `b: u8`, `p: i32` (6 bytes; unused = 0) |
| leg (condition only) | 0x50 | `u8 leg_id` (an existing leg **id**, not an index) |
| yes (ai_judged condition only) | 0x51 | — |

Leg expressions use only 0x01–0x06 and leaf codes. Conditions use only 0x01–0x03, 0x50 and 0x51, with at most 32 nodes and depth ≤ 12. `0x51` is allowed only as the entire condition of an ai_judged program, and is required there.

Leaf table (`b` is a Ref unless stated; `p` range enforced by decoders):
| Code | op | b | p |
|---|---|---|---|
| 0x10 | overlaps | ref | 0 |
| 0x11 | inside | ref | 0 |
| 0x12 | above | ref | 0 |
| 0x13 | below | ref | 0 |
| 0x14 | near | ref | dist `0..=14143` |
| 0x15 | behind | ref (line) | 0 |
| 0x16 | beyond | ref (line) | 0 |
| 0x20 | moving | 0 | 0 |
| 0x21 | at_rest | 0 | frames `1..=36000` |
| 0x22 | speed | CMP code `0..=5` | value `0..=100000` |
| 0x23 | direction | DIR code `0..=3` | 0 |
| 0x24 | present | 0 | 0 |
| 0x25 | intact | 0 | 0 |
| 0x30 | enters | ref | 0 |
| 0x31 | leaves | ref | 0 |
| 0x32 | disappears_into | ref | 0 |
| 0x33 | touches | ref | 0 |
| 0x34 | crosses | ref (line) | 0 |
| 0x35 | released_by | ref | 0 |
| 0x40 | standing | 0 | 0 |
| 0x41 | rep_count | CMP code `0..=5` | value `0..=1000` |

Decoders MUST reject the following with `MalformedProgram`:
- bad magic, version or fps; unknown codes; codes in the wrong context;
- refs ≥ E; a sub-region on a non-object or on `a`; operand kinds that violate §2.7;
- §0.5 limits exceeded; parameter ranges above;
- non-zero unused fields (§0.1);
- `leg_id` not naming a leg; duplicate or unordered leg ids;
- two `person` entities with the same participant;
- `side_b_mask` with bit 0 set, zero, or bits ≥ P;
- length mismatches; trailing bytes.

### 5.2 Calibration JSON
```ts
interface Calibration {
  version: 1;
  scene: {
    camera: {
      width_px: number; height_px: number;
      orientation: "landscape" | "portrait";
      ref_frame_sha256?: string;                         // JPEG of the frame used for placement
      pose?: { pitch_cdeg: number; roll_cdeg: number };  // phone IMU, integer centi-degrees
    };
    entity_refs: { entity: string; label: string; bbox: [number, number, number, number]; crop_sha256?: string }[];
  };
  regions: (
    | { entity: string; shape: "line"; points: [[number, number], [number, number]]; behind_sign: 1 | -1 }
    | { entity: string; shape: "zone"; points: [number, number][] }   // 3..8 vertices
  )[];
}
```
- All coordinates are normalized `0..10000` to the **full captured image**, not the preview. The app MUST invert its `CameraPreview` fit/crop transform. Recording MUST use the same orientation and resolution (§12.3 `CAMERA_MISMATCH`).
- The app places a line with two taps, then one tap on the side where the actor must stand; `behind_sign = side(L, tap)`, which must be nonzero. Degenerate lines (a == b) are invalid.
- Every region entity has exactly one region, and there are no other regions. `label` is 1–3 words, Title case. Label correction = the user taps the label, then taps the object. This sets `entity_refs[i].bbox` and uploads the crop (`PUT /bets/:id/scene/crops/:entity`).

### 5.3 `calibration_bin` (magic `VCAL`)
| Offset | Size | Field |
|---|---|---|
| 0 | 4 | "VCAL" |
| 4 | 1 | version = 1 |
| 5 | 1 | `R` regions |
| 6 | 2 | reserved = 0 |
| 8 | 32 | `scene_hash` |
| 40 | var | R × region, sorted by entity index ascending: `entity_idx u8`, `shape u8` (0 line, 1 zone), `n_points u8` (line: 2; zone: 3..8), `behind_sign i8` (line ±1; zone 0), then `n_points × (x u16, y u16)` |

Decoders reject the following with `MalformedCalibration`:
- a region for a non-region entity;
- a missing or duplicate region;
- a shape that mismatches the program;
- coordinates > 10000; a degenerate line;
- trailing bytes.

### 5.4 `track_bin` (magic `VTRK`)
| Offset | Size | Field |
|---|---|---|
| 0 | 4 | "VTRK" |
| 4 | 1 | version = 1 |
| 5 | 1 | fps = 10 |
| 6 | 1 | `T` tracks |
| 7 | 1 | `S` segments (0..16) |
| 8 | 1 | flags: bit0 camera_motion, bit1 cross_check_ok, bit2 audio_disagree (advisory), bit3 window_unavailable, bit4 phone_disagree (advisory), bits 5–7 = 0 |
| 9 | 3 | reserved = 0 |
| 12 | 32 | `model_hash` |
| 44 | 4·T | track table: `entity_idx u8`, `participant_idx u8`, `ref_h u16` |
| … | 8·S | segment table: `frame_start u32`, `n_frames u16` (≥1), `reserved u16` = 0. Strictly ascending; `frame_start_{i+1} >= frame_start_i + n_frames_i` |
| … | 12·T·Σn | records, segment-major, then frame, then track |

**Tracks exist for exactly the non-region entities referenced in at least one leg expression** (`valid_attempt` or `success`, including the owning object of a sub-region ref), in ascending entity index **[D-43]**. Track j MUST be the j-th such entity. `participant_idx` MUST equal the program's entity param for `person`, else `0xFF`.

Decoders reject the following with `MalformedTracks`:
- `T` ≠ number of referenced entities; a track table mismatch;
- `id_conf ≠ 0` on a non-`person` track; `pose ≠ 0` on a non-person (`object`) track;
- `S = 0` unless bit3 is set or the program is ai_judged (`T = 0`); `S ≠ 0` when bit3 is set;
- `Σ n_frames > MAX_EVAL_FRAMES`; any frame `≥ LIMIT + TAIL_FRAMES`;
- a record section whose length ≠ `12·T·Σn` exactly;
- non-zero reserved fields or flag bits 5–7;
- record constraint violations.

**Record (12 bytes)**:
| Off | Size | Field |
|---|---|---|
| 0 | 2 | `x0` u16 |
| 2 | 2 | `y0` u16 |
| 4 | 2 | `x1` u16 |
| 6 | 2 | `y1` u16 |
| 8 | 1 | `conf` u8 0..100 (0 ⇒ absent; then all other fields MUST be 0) |
| 9 | 1 | `fill` u8 0..100 = `min(100, mask_area*100 / area(bbox))` (0 if area 0); advisory |
| 10 | 1 | `id_conf` u8 0..100 (person tracks: identity confidence for the bound participant; else 0) |
| 11 | 1 | `pose` u8: bit0 standing, bit1 rep_low, bit2 rep_high (bits 1 and 2 exclusive), bits 3–7 = 0 |
Constraint: `x0 <= x1 <= 10000`, `y0 <= y1 <= 10000`.

Size check (spec §5.7): coordinates alone for 3 entities × 60 frames are 1,440 B. With the 4 extra bytes per record, a 6 s, 3-entity window is 2,160 B + 56 B header. It is written in `ceil(len / POST_TRACKS_CHUNK)` legacy-size transactions **[D-5]**.

### 5.5 `market_bin` (magic `VMKT`, replaces track_bin for kind market)
`"VMKT"`, `version u8 = 1`, `n u8`, `reserved u16 = 0`, then n × (`market_hash [32]`, `result u8`: 0 no, 1 yes, 2 void). A duplicate `market_hash`, a result > 2 or trailing bytes ⇒ `MalformedTracks`.

### 5.6 TrackBuffer payload
`payload = program_bin ‖ calibration_bin ‖ (track_bin | market_bin)`, with `len(payload) <= MAX_BUFFER_PAYLOAD (10000)`.
- ai_judged: `calibration_bin` is empty, and `track_bin` is the minimal form with `T=0, S=0, flags=0b10`.
- SP1-only (feature `sp1`): `payload = program_bin ‖ calibration_bin` with no third part (§9.4 `post_tracks`).
- Programs whose decisive windows don't fit, or exceed `MAX_EVAL_FRAMES` or `MAX_EVAL_COST`, go to the panel path (flags bit3) or to SP1 (§9.4 #14).

---

## 6. Perception

### 6.0 Perception job interface (`PERCEPTION_PROVIDER=http|nosana`)
Perception runs on the **primary camera** = the lowest-index camera witness. Other camera witnesses are exhibits only. Multi-angle fusion is out of scope **[D-23]**. The worker container lives in `services/perception/` (Python, Dockerfile, SAM 3 + MediaPipe + optical flow; not built by default). The `nosana` adapter posts this container as a Nosana job (two independent hosts). `http` is the io.net / cloud fallback. Both refuse to run unless `ALLOW_SPEND=1`.
```
POST {PERCEPTION_URL}/jobs
  { bet, job_nonce, fps: 10, offset_ms,
    video_urls: [{ index, url, sha256, start_ms, duration_ms, body_format: "mp4" | "mjpeg" }],
    prompts: [{ entity, phrase }], entity_refs: [...calibration.scene.entity_refs],
    need_pose: boolean, need_reid: boolean,
    need_faces?: boolean /* errata backend-audit-faces: true iff any leg is actor-bound */ }
  → { job_id }
GET {PERCEPTION_URL}/jobs/:id
  → { status: "queued" | "running" | "done" | "failed", model_hash, flags,
      detections_url /* JSON Lines of RawDetection */, host: { provider, job_id, url, market },
      frame?: { width_px, height_px } /* decoded source size, errata backend-audit-faces */ }
```
The backend runs two jobs (hosts A and B) per bet. Host A = the job that reports `done` first.
`video_urls[].url` are signed, expiring, tokenless URLs (`GET {API}/v1/media/chunks/:bet/:witness/:index?exp&sig`, errata backend-audit-media). Nosana jobs run the same image in one-shot mode and POST `{model_hash, flags, frame?, detections_jsonl}` to a signed `POST {API}/v1/media/perception/:bet/:job_nonce?exp&sig` (errata backend-audit-nosana).

### 6.1 Raw per-frame records (perception job output, JSON Lines)
```ts
interface RawDetection {            // one line per (frame, track)
  t_ms: number;                     // since t0, ≥ 0
  entity: string;                   // entity name, or "person" for unbound person tracks
  track_id: number;                 // u16, per job
  bbox_px: [number, number, number, number];   // x0,y0,x1,y1 in source pixels (floats allowed here)
  mask_area_px: number;
  confidence: number;               // 0..1 float
  pose?: { standing: boolean; elbow_deg?: number };   // MediaPipe, person tracks only
  reid?: number[];                  // appearance embedding (person tracks), optional
  face?: { emb: number[]; conf: number };   // `entity: "person"` lines only, when need_faces: 128 floats,
                                            // L2-normalized (services/embedder model), on frames with
                                            // floor(t_ms/100) % 3 == 0 where a face is found (errata backend-audit-faces)
}
```

### 6.2 Quantization (`quantizeSession(raw, meta)`, non-consensus but deterministic)
- Frame index `f = floor(t_ms / 100)`. If several samples for a track fall into one frame, keep the one with the **smallest** `t_ms`. Frames without a sample are absent.
- `x_norm = clamp(floor(x_px*10000/width_px), 0, 10000)`, same for y with height.
- `conf = clamp(floor(confidence*100), 0, 100)`; `mask_area_norm = floor(mask_area_px * 10^8 / (width_px*height_px))`; `fill` per §5.4.
- Pose bits: standing → bit0; `elbow_deg < 90` → rep_low; `elbow_deg > 160` → rep_high.
- **Object binding (sticky)** **[D-44]**:
  1. The initial track is the candidate (same entity label) with the max IoU against `calibration.entity_refs[e].bbox`, at the first frame where any candidate exists. Fallback: highest conf. Ties → lower track_id.
  2. Keep that track_id while it exists.
  3. **Hand-off**: if another candidate is `held` (§3.5) by a `released_by` actor `b` of this entity for `RELEASE_HOLD` consecutive frames while the bound track is not held, rebind to the held candidate.
  4. **After the bound track ends**, the entity is absent for `REBIND_DELAY_FRAMES`. It then rebinds to the candidate whose center is inside `expand(box(b), HAND_EXPAND_PCT)` of a `released_by` actor `b` for this entity, else to the highest-conf candidate; ties → lower track_id.
- `person_any` = the person track with the largest bbox area per frame. `person` (participant) = the identity-timeline stitched track (`bindPersons`, §8.5). Non-actor-bound bets never run identity. In practice (§12.3), `person` entities bind to the largest person track.
- **Occlusion fill**:
  - Applied after binding and before cross-check.
  - Fills interior gaps of ≤ `OCCLUSION_FILL_FRAMES` absent frames between two present frames `p < n` of the same bound track.
  - Box: `x = x_p + (x_n - x_p)*(f-p)/(n-p)`, computed with integer arithmetic, ordering operands so they are non-negative (if `x_n < x_p`, use `x_p - (x_p - x_n)*(f-p)/(n-p)`).
  - `conf = min(conf_p, conf_n)`; `fill`, `pose` and `id_conf` are copied from `p`.
- Camera motion: the job sets `flags.bit0` if global frame-to-frame motion (median optical-flow magnitude of the background) exceeds 1% of frame width for more than 5 consecutive frames.
- Output:
```ts
interface QFrame { x0: number; y0: number; x1: number; y1: number; conf: number; fill: number; id_conf: number; pose: number }
interface QuantizeMeta { width_px: number; height_px: number; n_frames: number; model_hash: string; flags: number; program: Program; calibration: Calibration | null }
interface SessionTracks {
  fps: 10; n_frames: number; model_hash: string; flags: number;
  // every non-region entity, entity order (unreferenced ones too; persons only in outcome stay all-null)
  tracks: { entity: string; entity_idx: number; participant_idx: number | null; ref_h: number; frames: (QFrame | null)[] }[];
}
```
`ref_h` = `y1 - y0` at the entity's first present frame in the session (0 if never present).

### 6.3 Cross-check (two hosts, `crossCheck(a, b, p, c): CrossCheckResult`)
1. For each referenced entity and each frame where either side is present (conf ≥ PRESENCE_MIN):
   - **Agree** if both are present and `IoU_bps >= IOU_AGREE_BPS`, where `IoU_bps = floor(area(inter)*10000 / (area(A)+area(B)-area(inter)))` (u64; union 0 ⇒ agree).
   - If only one side is present, the frame agrees only when that side's conf < DECISIVE_CONF_MIN.
   - Per entity, the check passes when `agree_frames*10000 / considered_frames >= TRACK_AGREE_BPS` (no considered frames ⇒ pass).
2. Evaluate the program over each full session (single segment, `verified` = all checkpoints, `maxCost = ∞`). Leg values MUST be equal and attempt counts equal. Each attempt frame, success frame and decisive frame MUST match pairwise within `±EVENT_TOL_FRAMES`.
3. Pass ⇒ `flags.bit1 = 1`, and the sealed tracks are **host A's**. Fail ⇒ `flags.bit1 = 0` (the bet goes to the replay booth, reason 12).
4. (Advisory) For each `detections` witness (phones as nodes), compute per-entity IoU agreement against the sealed tracks with the same formula. Agreement below `TRACK_AGREE_BPS` sets flags bit4 (`phone_disagree`) and adds an exhibit. It never changes the result **[D-30]**.
```ts
interface CrossCheckResult { ok: boolean; entity_agreement_bps: Record<string, number>; event_mismatches: string[]; phone_agreement_bps?: Record<string, number> }
```

### 6.4 Perception root
`perception_root` = Merkle root (§7.3) over leaves `leaf_f = sha256(0x00 ‖ u32 f ‖ rec(track_0,f) ‖ … ‖ rec(track_{T'-1},f))` for every session frame `f = 0..n_frames-1`. It covers all `SessionTracks.tracks` (`T'` of them, entity order); absent records are 12 zero bytes. It is sealed together with `model_hash` (inside track_bin).

### 6.5 Decisive-window extraction (`extractDecisiveWindows(p, c, session, verified)`) — not consensus, but MUST satisfy the post-condition
1. Evaluate on the full session (one segment, `maxCost = ∞`). Collect key frames: all `DF`, all frames of `rising(V)` and `rising(S)` in `F_R`, attempt frames, and checkpoints.
2. Window per key frame `k`: `[k-20, k+20]`. Additional coverage:

   | Rule or situation | Adds |
   |---|---|
   | each attempt | `[a_i - 20, end_i + 10]` |
   | `holds(D)` | `[0, D+5]` |
   | `rep_count` | `[0, k]` |
   | `before(D)` leg, raw False | `[0, D)` |
   | `exists` / `never` / count without attempts, raw False | full coverage |

   Clamp windows to `[0, min(n_frames, LIMIT + TAIL_FRAMES))` and merge windows whose gap is < 10 frames.
3. Encode. **Post-condition**: `evaluate(buffer)` MUST equal the full-session result (`leg_results`, `winner_mask`, `checkpoints`), with `cost ≤ MAX_EVAL_COST`, `Σ n ≤ MAX_EVAL_FRAMES`, `S ≤ 16`, and payload ≤ cap.
   - If not, widen all windows by 20 frames and retry, up to 3 times. Then try full coverage.
   - If it still fails, return `null`. The backend then either proves the full session with SP1 (`SP1_PROVER ≠ off`, feature `sp1`) or posts a track_bin with `T` tracks, `S = 0` and flags bit3 (`window_unavailable`), which routes the bet to the panel (reason 13).

---

## 7. Evidence integrity

### 7.1 Witnesses
| kind | code | body format |
|---|---|---|
| camera | 0 | `body_format = "mp4"`: MP4 (H.264, ≥720p) one file per chunk; or `"mjpeg"`: repeated `u32 len ‖ u32 t_ms_local ‖ jpeg[len]` (LE) at 10 fps from the camera image stream |
| audio | 1 | WAV, 16 kHz mono PCM16 |
| detections ("phone as node", optional) | 2 | UTF-8 canonical JSON `{ "frames": [ { "t_ms", "boxes": [[label, x0,y0,x1,y1, conf]] } ] }` (normalized ints) |

- Each witness generates a fresh **ed25519 witness key** per bet, stored only on the device.
- The phone that opens the viewfinder registers a `camera` witness **and** an `audio` witness. MJPEG has no audio track, and its own beacon offset needs one. Every other huddle phone auto-registers `audio`.
- Bystanders (confirmed huddle members who are not participants) may be witnesses.
- The witness list (≤ 8: keys + kinds) is fixed in `start`. Witness index = position in that list.

### 7.2 Hash chain (per witness)
```
G_w   = sha256("VERDICT/CHAIN/v1" ‖ bet[32] ‖ witness_key[32] ‖ u8 kind ‖ u64 beacon_slot ‖ beacon_hash[32])
c_i   = sha256("VERDICT/CHUNK/v1" ‖ prev[32] ‖ u32 i ‖ u8 kind ‖ i64 start_ms ‖ u32 duration_ms ‖ sha256(body)[32])
        prev = G_w for i = 0, else c_{i-1}
sig_i = ed25519_sign(witness_key, "VERDICT/CHUNK-SIG/v1" ‖ c_i)
```
- `start_ms` is **device-local**: milliseconds since that witness started recording (chunk 0 has `start_ms = 0`) **[D-20]**. The backend maps device time to session time with the beacon offset (§7.5).
- Chunks are nominally `CHUNK_MS = 5000` ms (the last may be shorter). Indices are gap-free from 0. Gaps between consecutive chunks (`start_ms_{i+1} - (start_ms_i + duration_ms_i)`) of up to `CHUNK_GAP_MAX_MS` are tolerated and reported as `gaps_ms`; larger ones are flagged `gap` on the Receipt.
- **Upload order**: the chunk hash record (`c_i`, `sig_i`, metadata) is POSTed first and the body follows. The backend rejects bodies whose sha256 doesn't match, and records arrival times. A hash record arriving more than `CHUNK_LATE_MS` after the witness's beacon-aligned chunk end is marked `late` (advisory, Receipt).

### 7.3 Merkle tree (used for evidence roots, perception roots, receipts)
```
merkle([])        = 32 zero bytes
merkle([x])       = x
level reduction:  pair (l, r) → sha256(0x01 ‖ l ‖ r); an odd last node is carried up unchanged
```
Leaves are already hashes (callers hash with a `0x00` prefix). Inclusion proof JSON: `{ "leaf": hex, "index": n, "siblings": [{ "hash": hex, "side": "L" | "R" }] }` (levels where the node was carried up contribute no sibling).

### 7.4 Rolling evidence roots
```
head_w  = (index_w, hash_w)        index_w = 0xFFFFFFFF and hash_w = G_w if witness w has no chunks yet
leaf_w  = sha256(0x00 ‖ witness_key[32] ‖ u32 index_w ‖ hash_w[32])
root    = merkle([leaf_0 … leaf_{n-1}])   // witness order
```
- The program computes `root` itself from the heads passed to `commit_evidence` / `end`. It stores `witness_kinds`, so for empty heads it can recompute `G_w`. It stores `witness_head_hashes`, so it can enforce "equal index ⇒ equal hash".
- `commit_evidence` is sent by the oracle every `EVIDENCE_COMMIT_INTERVAL_S` while Live. Only the **oracle** may pass heads to `end`. Any other `end` signer passes `heads = []`, and the final root is then the root of the last stored heads. `Bet.evidence_root` after `end` is final.
- Onchain checks per witness:
  - the new index is ≥ the old one (with 0xFFFFFFFF as −1);
  - equal index ⇒ equal hash;
  - a jump > `MAX_CHUNKS_PER_COMMIT` sets the witness's bit in `gap_mask`;
  - a commit more than `EVIDENCE_MAX_GAP_S` after the previous one sets all bits.
- Gap bits are shown on the Receipt and given to the replay booth; they do not change the interpreter result. Onchain chunk continuity is therefore advisory, not "checked" as spec §5.4 says **[D-6]**.

### 7.5 Freshness beacon (start signal)
- Beacon source: Solana **SlotHashes** sysvar entry `(slot, hash)`. The spec's "blockhash" is this bank hash, because it is the only recent-hash data a program can read **[D-7]**. The backend picks the newest entry. `start` verifies `current_slot - beacon_slot <= BEACON_MAX_AGE_SLOTS` and that the entry exists (§9.1 raw read), and stores `beacon_hash`.
- Payload (18 bytes): `u64 slot (LE) ‖ beacon_hash[0..8] ‖ crc16`, where crc16 = CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection, xorout 0) over the first 16 bytes, written **big-endian**.
- Modulation: 16-FSK. Tone `k ∈ 0..15` has frequency `f_k = 2000 + 250·k` Hz. Symbol length 50 ms. Symbols: preamble `[0, 15, 0, 15, 0, 15]`, then for each payload byte the high nibble then the low nibble ⇒ 6 + 36 = **42 symbols = 2.10 s**.
- Synthesis (normative for test vectors): sample rate 48000; for symbol j and sample n within the symbol (`0 ≤ n < 2400`): `s = 0.25 · env(n) · sin(2π · f_k · n / 48000)`, where `env` is a linear ramp 0→1 over the first 240 samples and 1→0 over the last 240; PCM16 = `round(32767·s)`. Phase resets each symbol. (Floats are allowed here; this is not consensus.)
- `t0` = the sample immediately after the last beacon symbol. All session times (`t_ms`, frames) and the time limit are relative to t0.
- **Start sequence**:
  1. Witnesses register (`POST /bets/:id/witnesses`).
  2. The creator taps Start → `POST /bets/:id/start`. The oracle sends `start` with the witness list.
  3. On confirmation, the server broadcasts WS `start` (§12.4) to `bet:<id>`, carrying the beacon.
  4. Every witness starts recording when this message arrives, so `G_w` is known before chunk 0 closes. Each replies `{"type":"recording"}`.
  5. The phone named in `play_on_user_id` (the camera phone) plays the ElevenLabs start sound (≤ 1.5 s), then the beacon tones, `PLAY_DELAY_MS` after receipt **[D-8]**.

  Chunk 0 begins before the tones; `offset_w` handles alignment. The Record screen timer counts from t0 (known locally from the playback schedule) to the limit.
- Decoding: resample to 16–48 kHz; slide a 50 ms Goertzel bank (16 tones) in 5 ms steps; find the preamble alignment that maximizes the summed energy of the expected tones; for each symbol take the argmax tone over its middle 40 ms; verify the CRC. The backend decodes the beacon from every audio witness (and from the MP4 audio track of mp4 camera witnesses) to get `offset_w` = device-local ms of t0. Session time = device time − `offset_w`. A camera witness without its own audio uses the offset of the audio witness registered from the same device. A witness whose beacon can't be decoded is marked unsynced on the Receipt and excluded from timing-based exhibits.

### 7.6 Audio cross-check (advisory)
For every decisive event of type `disappears_into`, `touches`, `released_by` or `crosses`, the backend looks for a Scribe audio-event tag (impact/thud/clap) within ±500 ms on each audio witness. If at least one audio witness has any impact tag in the session, but none within ±500 ms of a `disappears_into`/`touches` decisive frame, it sets track_bin flags bit2 (`audio_disagree`). This is advisory only: it is shown on the Receipt and included as an exhibit **[D-19]**. Scribe output is normalized to `{segments:[{speaker, start_ms, end_ms, text}], events:[{type, at_ms}]}` (device-local ms, then mapped to session time).

---

## 8. Identity

### 8.1 Models
| | Face | Voice |
|---|---|---|
| Embedding | MobileFaceNet/ArcFace-class, **128-d**, L2-normalized | ECAPA-TDNN (SpeechBrain `spkrec-ecapa-voxceleb`), **192-d**, L2-normalized |
| Provider interface | `embedFace(jpeg) → number[128]` | `embedVoice(wav) → number[192]` |
| Default | deterministic mock (§13) | deterministic mock |
| Real | optional sidecar `services/embedder/`: `POST {EMBEDDER_URL}/embed/face {images_b64:[...]} → {embeddings:[[...]]}`, `POST /embed/voice {wav_b64} → {embedding:[...]}` (runs locally, free) | |

Speaker *verification* is our ECAPA model. ElevenLabs Scribe supplies only diarized segments and audio events. The README states this precisely.

### 8.2 Quantization
`q_i = clamp(roundHalfAwayFromZero(x_i · EMB_SCALE), -127, 127)` on the L2-normalized float vector. Enrollment template = `quantize(normalize(mean of the 3–5 frame / 3 phrase embeddings))`. Face vectors are zero-padded to `CIRCUIT_DIM = 192` (`q_i = 0` for `i ≥ 128`) wherever they enter a commitment or proof.

### 8.3 Closed-set match
```
dot = Σ e_i·o_i, ne = Σ e_i², no = Σ o_i²       (i64)
cos_bps(e,o) = 0 if dot <= 0 or ne == 0 or no == 0 else floor(dot·10000 / isqrt(ne·no))
```
Candidates are enrolled templates from a **closed set**, never anyone else:

| Use | Closed set |
|---|---|
| huddle scan | all joined members of the huddle |
| pay | confirmed members of the caller's huddles from the last `RECENT_HUDDLE_S`, excluding the caller |
| "I accept" | all confirmed huddle members; the best match must be the caller |
| in-game | the bet's candidate list (§8.5) |

Best `c1` (ties → lower candidate index), `cos1`; second-best `cos2` (0 if only one candidate). **Matched** iff `cos1 >= τ_m` and `cos1 - cos2 >= δ_m` (§0.5).

Circuit predicate (exact, used for proofs): `circuitMatch(e,o,τ) := dot > 0 && dot²·10^8 >= τ²·ne·no` (bigint in TS). The backend only requests a proof when `circuitMatch` holds.

### 8.4 Commitment (onchain in `Profile`)
```
u_i  = q_i + 128                       (i = 0..191; 1..255)
F_k  = Σ_{j=0..30} u_{31k+j} · 256^j    for k = 0..5        (bytes 0..185, little-endian packing)
F_6  = Σ_{j=0..5}  u_{186+j} · 256^j
commit = Poseidon8(F_0, …, F_6, salt)  // circomlib Poseidon, t = 9
```
- `salt` = 31 uniformly random bytes interpreted little-endian. `commit` is stored as a 32-byte **big-endian** integer, which is always `< r` (the BN254 scalar modulus).
- The backend stores `{q, salt}` per modality, encrypted (AES-256-GCM, key `BIOMETRIC_KEY`). "Delete biometrics" erases them and calls `init_profile` with zero commitments.
- After deletion, bets still Perceiving cannot be proven, so their actor-bound legs end IDENTITY Unknown → panel.

### 8.5 Identity timeline fusion (`fuseTimeline`, `bindPersons`; offchain, engine)
Runs only if any leg is actor-bound. **Candidates** (frozen at `POST /bets`): indices `0..P-1` are the participants in order; `P..M-1` are the other enrolled confirmed huddle members, in join order (`M ≤ 10`). Observations matched to a non-participant add to that candidate's score, which competes in normalization but is never stitched.
```ts
interface PersonTrack { track_id: number; frames: (QFrame | null)[] }   // anonymous person tracks, session-length
interface IdObservation { frame: number; modality: "face" | "voice"; track_id: number | null; scores: { candidate: number; cos_bps: number }[] /* all M */ }
interface ReidLink { from_track: number; to_track: number; sim_bps: number }
interface FusedTimeline { n_frames: number; n_candidates: number; stitched: ({ track_id: number; conf: number } | null)[][] /* [participant][frame] */ }
```
Faces are sampled every 3rd frame (≈3.3 fps) per person track. Voice observations come from Scribe-diarized segments (one observation at the segment's midpoint frame).

State `S[t][c]` (u32, init 0). For `f = 0 … n_frames-1`:
1. **Re-ID inheritance** — for each track t whose first present frame is f: among links with `to_track = t`, `sim_bps >= 7000`, and `from_track`'s last present frame in `[f-50, f-1]`, take the highest sim (ties → lower from_track); `S[t][c] = S[from][c]·8000/10000` for all c.
2. **Decay** — for every track t present at f and not starting at f: `S[t][c] = S[t][c]·9977/10000`.
3. **Observations at f** (faces first, then voices; each by ascending track_id), using §8.3 with the modality's τ/δ:
   - face on track t, matched to c*: `w = min(4000, 1000 + (cos1-τ) + ((cos1-cos2)-δ))`; `S[t][c*] += w`. Face with `cos1 < τ` (clear non-match): `S[t][c] = S[t][c]·7000/10000` for all c. Otherwise nothing.
   - voice matched to c*: `w` computed with the voice τ/δ, then halved (`floor(w/2)`). Target track = the only present person track at f if there is exactly one; else the unique present track whose `argmax_c S[t][c]` (strict) equals c*; else drop.
4. `conf_c(t,f) = floor(100·S[t][c] / (Σ_{q<M} S[t][q] + 1000))`.

**Stitching (greedy, per frame)**: collect all pairs `(t, p)` with `p < P`, t present at f and `conf_p(t,f) > 0`. Sort them by `(conf desc, t asc, p asc)` and assign greedily. Each track and each participant is used at most once. A participant without an assignment is **absent** at f. Otherwise its QFrame = that track's QFrame with `id_conf = conf_p`. `bindPersons(session, personTracks, timeline, p)` writes the stitched frames into the `person` entity tracks.

### 8.6 Biometric ZK proof (circom → Groth16 → `groth16-solana`)
Circuit `circuits/biometric_match.circom`, `template BiometricMatch(D)`, compiled with circom 2.1.x, BN254, Powers of Tau `powersOfTau28_hez_final_14.ptau` (public Hermez, free download), single-party phase 2 applied with `snarkjs zkey beacon` using a fixed dev beacon. The main component MUST be literally:
```
component main {public [commitment, bet_field, evidence_field, participant_idx, frame, modality, tau_bps, result]} = BiometricMatch(192);
```
Public signals, in this exact order (snarkjs `public.json` order; no circuit outputs):
| # | Signal | Value |
|---|---|---|
| 0 | `commitment` | Profile `face_commit` / `voice_commit` as a field element |
| 1 | `bet_field` | big-endian integer of `0x00 ‖ bet_pubkey[1..32]` |
| 2 | `evidence_field` | big-endian integer of `0x00 ‖ evidence_root[1..32]` |
| 3 | `participant_idx` | 0..7 |
| 4 | `frame` | checkpoint frame |
| 5 | `modality` | 0 face, 1 voice |
| 6 | `tau_bps` | threshold used |
| 7 | `result` | must be 1 |

Private: `enrolled[192]`, `salt`, `observed[192]` (signed values; negatives as `p - |x|`).

Constraints:
- `u_i = enrolled_i + 128` and `observed_i + 128` are each range-checked to `[1, 255]` (`Num2Bits(8)` + nonzero).
- The commitment is recomputed per §8.4 and must equal the public `commitment`.
- `dot`, `ne` and `no` are computed. `dot + 2^22` is range-checked with `Num2Bits(23)`.
- `pos = dot > 0`; `big = (dot²·10^8 >= tau_bps²·ne·no)` via `GreaterEqThan(72)`; `result === pos · big`.
- `tau_bps` is range-checked with `Num2Bits(14)`. Signals 1–5 are bound with dummy quadratic constraints.

Ranges: `|dot| ≤ 192·127² = 3,096,768 < 2^22`. Max `dot²·10^8 ≈ 2^69.7`. Max `tau²·ne·no ≈ 2^71.1` for `tau < 2^14`. So `GreaterEqThan(72)` is sound.

**Prover input at checkpoint `(p, frame)`**, in order of preference:
1. the most recent face observation on p's stitched track at `g ∈ [frame-30, frame]`, with `cos_bps(p) ≥ τ_face` and `circuitMatch`;
2. otherwise, the voice observation matched to p whose segment covers `frame`;
3. otherwise, no proof. The checkpoint fails ⇒ IDENTITY.

**Honest framing [D-25]**: the proof shows that the oracle holds an embedding within τ of the committed enrollment template, bound to this bet, evidence root and frame, without revealing either. Binding that embedding to the footage is **trusted** (the same trust class as perception). The Receipt's Proof row says so (`binding: "trusted"`), and so does the README.

Onchain encoding (groth16-solana): every public input is 32-byte big-endian. `proof_a` = 64 bytes `x ‖ y` big-endian with **y negated** (`p - y`); `proof_b` = 128 bytes `x.c1 ‖ x.c0 ‖ y.c1 ‖ y.c0`; `proof_c` = 64 bytes `x ‖ y`. The engine exposes `encodeGroth16Proof(snarkjsProof) → {a, b, c}` and `biometricPublicInputs(...) → Uint8Array[8]`.

`circuits/scripts/vk-to-rust.ts` emits `programs/verdict/src/zk/vk.rs`:
```rust
pub const VK: Groth16Verifyingkey = Groth16Verifyingkey { nr_pubinputs: 8, vk_alpha_g1: [/* x‖y BE */], vk_beta_g2: [/* x.c1‖x.c0‖y.c1‖y.c0 */],
  vk_gamme_g2: [..], vk_delta_g2: [..], vk_ic: &[[u8; 64]; 9] };
```
Committed artifacts:
- `vk.rs` and `circuits/build/verification_key.json` are committed, so `anchor build` works without running the ceremony.
- The zkey is **not** committed. `circuits/scripts/setup.sh` regenerates it deterministically (ptau download, or `--local-ptau`, which generates one offline).

Pinning:
- `groth16-solana` is pinned to the release compatible with the solana-* 2.x crates of Anchor 0.32.1. Check with `cargo tree -d` that there are no duplicate `solana-program` versions.
- Verification costs ~100–150K CU with 8 inputs. `verify_biometric_proof` requests 300K CU for headroom (input preparation is a scalar multiplication per input, plus account deserialization).
- Cargo feature `mock-zk` (tests only, never in deployed builds) accepts any proof whose `proof_a` is 64 bytes of `0x01`.

---

## 9. Onchain program (Anchor 0.32.1, `programs/verdict`)

### 9.1 IDs, PDAs, external programs, toolchain
- Program ID: generated once by the Chain team (`anchor keys sync`) and committed in `declare_id!` and `Anchor.toml`. The backend reads `VERDICT_PROGRAM_ID` (default = that value). Keypairs are never committed.
- Toolchain: `Anchor.toml` `[toolchain] anchor_version = "0.32.1"`, `solana_version` = the matching Agave 2.x release, recorded there. Anchor feature `init-if-needed` is enabled. The program is tested with **LiteSVM** (`cargo test`, no validator, no network, no SOL) and `--features mock-zk`.
- **IDL is normative for account order**: `programs/verdict/target/idl/verdict.json` is committed to `packages/backend/idl/verdict.json` and used by the backend, the mock chain and Dart codegen. §9.4's account lists MUST match it, and a mismatch is fixed in the IDL's favour.
- Account discriminators: `sha256("account:Profile")[0..8]`, `sha256("account:Bet")[0..8]`, `sha256("account:TrackBuffer")[0..8]`.
- PDAs:
  | Account | Seeds |
  |---|---|
  | Profile | `["profile", wallet]` |
  | Bet | `["bet", creator, nonce.to_le_bytes() (u64)]` |
  | Vault (SPL token account, authority = Bet PDA) | `["vault", bet]` |
  | TrackBuffer | `["tracks", bet]` |
- Token program: classic SPL Token (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`). Mint = `USDC_MINT` (default devnet mode: a backend-created test mint with mint authority = fee payer **[D-34]**; Circle devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` if configured; any mint works).
- Sysvars:
  - Clock.
  - SlotHashes: an `UncheckedAccount` with `address = sysvar::slot_hashes::ID`. Never use `Sysvar<SlotHashes>`, since full deserialization is ~20 KB. Read `u64 len` at offset 0; entry i is at `8 + 40·i` (`u64 slot, [u8;32] hash`), descending by slot. Binary-search with `len ≤ 512`, without copying the data.
  - Instructions (`Sysvar1nstructions1111111111111111111111111`), via `load_current_index_checked` / `load_instruction_at_checked`.
- Transactions: **all transactions MUST fit 1,232 bytes (legacy/v0)**. Version-1 large transactions are not assumed.
- Fee payer: the backend wallet pays fees on every transaction; users sign only as authority. The fee payer need not appear in an instruction's account list unless it pays rent.
- `ORACLE_KEY` defaults to `FEE_PAYER_KEY` when unset, so rent paid by the payer is refunded to the same key.
- Every `Bet` in an instruction context is `Box<Account<'info, Bet>>` (4 KB stack frame limit).

### 9.2 State enum (`u8`)
`0 Proposed, 1 Funded, 2 Live, 3 Perceiving, 4 PreRuled, 5 Disputed, 6 Settled, 7 Refunded`.

Other enums:
- `preruling`: 0 none / 1 WINNER / 2 NO_CONTEST / 3 NEEDS_PANEL.
- `settle_path`: 0 none / 1 CONSENT / 2 RULE (pre-ruling produced by `verify_sp1_run`, settled by consent or silence; feature `sp1`) **[D-24]** / 3 PANEL / 4 REFUND.
- `dispute_reason`: 1 wrong_outcome / 2 wrong_identity / 3 bad_tracking / 4 other / 10 LOW_CONFIDENCE / 11 AI_JUDGED / 12 CROSS_CHECK_FAILED / 13 WINDOW_UNAVAILABLE.
- `refund_reason`: 1 fund_timeout / 2 no_contest / 3 start_timeout / 4 live_timeout / 5 perception_timeout / 6 panel_timeout / 7 cancelled / 8 consent_timeout.
- Bet `flags`: bit0 any_actor_bound, bit1 ai_judged, bit2 market. bit1 and bit2 are mutually exclusive. ai_judged/market require bit0 = 0.
- `tracks_finalized`: 0 no / 1 yes / 2 SP1-only.

### 9.3 Accounts (after the 8-byte Anchor discriminator, fields in this order)

**Profile** (Borsh, space 8 + 179):
`wallet Pubkey, face_commit [u8;32], voice_commit [u8;32], display_name [u8;32] (UTF-8, zero padded), name_len u8, flags u8 (bit0 face, bit1 voice), bump u8, created_at i64, updated_at i64, reserved [u8;32]`

**Bet** (Borsh, space **8 + 1580**), fields in order (read row by row, left to right):
```
version u8 (=1)            bump u8                    vault_bump u8              state u8
flags u8                   creator Pubkey             nonce u64                  mint Pubkey
oracle Pubkey              judges [Pubkey;3]          n_participants u8          participants [Pubkey;8]
stakes [u64;8]             side_b_mask u8             funded_mask u8             stake_each u64
time_limit_s u32           program_hash [u8;32]       calibration_hash [u8;32]   acceptance_audio_hash [u8;32]
created_at i64             fund_deadline i64          funded_at i64              started_at i64
beacon_slot u64            beacon_hash [u8;32]        n_witnesses u8             witnesses [Pubkey;8]
witness_kinds [u8;8]       witness_heads [u32;8]      witness_head_hashes [[u8;32];8]   gap_mask u8
evidence_seq u32           evidence_root [u8;32]      last_commit_at i64         ended_at i64
perception_root [u8;32]    tracks_hash [u8;32]        tracks_finalized u8        preruling u8
prerule_reason u8          winner_mask u8             leg_results [u8;8]         preruled_at i64
consent_deadline i64       consent_mask u8            disputer Pubkey            dispute_bond u64
dispute_reason u8          disputed_at i64            n_bio u8                   bio [BioCheck;8]
settled_at i64             settle_path u8             final_winner_mask u8       refund_reason u8
reserved [u8;64]
```
- `BioCheck = {participant u8, modality u8, frame u32}` (6 bytes).
- Unused participant/witness slots are zero. `witness_kinds` unused = `0xFF`. `witness_heads` unused/none = `0xFFFFFFFF`. `witness_head_hashes` = `G_w` for a registered witness with no chunks, and zero for unused slots. `leg_results` unused = `0xFF`. `disputer` = the all-zero key when there is none.
- Sum of field sizes = 1580: the v1 layout's 1316, minus `witness_audio_mask` (1), plus `witness_kinds` (8), `witness_head_hashes` (256) and `refund_reason` (1).

**TrackBuffer** (zero-copy header + raw payload; space `8 + 48 + payload_len`):
```rust
#[account(zero_copy)] #[repr(C)]
pub struct TrackBufferHeader { bet: Pubkey, payload_len: u32, program_len: u16, calibration_len: u16,
                               written: u32, finalized: u8, bump: u8, reserved: [u8; 2] }   // 48 bytes, Pod
```
- The payload is `data[56 .. 56 + payload_len]` (§5.6).
- The first `post_tracks` creates the account manually (`system_program::create_account` with the PDA signer) when `data_len == 0`. Do not use `init_if_needed`.
- In `cancel`, `consent`, `settle_panel` and `refund`, `track_buffer` is an `UncheckedAccount` constrained to `seeds = [b"tracks", bet]`. It is closed (rent → `oracle`) only if its owner == program and its data is non-empty.

**Vault**: SPL token account, mint = `bet.mint`, owner = Bet PDA.

### 9.4 Instructions
- Discriminator = Anchor default `sha256("global:<name>")[0..8]`. Args are Borsh, in the listed order. Accounts are in the listed order (`s` signer, `w` writable), with the IDL authoritative.
- `payer` (`s w`) appears only where it pays rent.
- "Payout accounts" = `n_participants` SPL token accounts (`w`), one per participant in participant order, each with `mint == bet.mint` and `owner == participants[i]` (the backend uses ATAs and creates missing ones idempotently, §12.6), passed as **remaining accounts**.

| # | Name | Args | Accounts | Rules |
|---|---|---|---|---|
| 1 | `init_profile` | `face_commit [u8;32], voice_commit [u8;32], display_name String (≤32 bytes)` | payer, wallet `s`, profile `w` (init_if_needed), system_program | Creates or overwrites; sets `updated_at = now`. Zero commitments = deleted. A non-zero commitment ≥ the BN254 scalar modulus `r` ⇒ `BadCommitment`. Emits `ProfileUpdated` |
| 2 | `create_bet` | `nonce u64, participants Vec<Pubkey>, stakes Vec<u64>, side_b_mask u8, stake_each u64, time_limit_s u32, flags u8, program_hash [u8;32], acceptance_audio_hash [u8;32], judges [Pubkey;3]` | payer, creator `s`, oracle `s`, bet `w` (init), vault `w` (init), mint, token_program, system_program | **Oracle co-signs** (backend endorses the judges) **[D-37]**. Checks: 2 ≤ P ≤ 8; participants distinct; `participants[0] == creator`; `side_b_mask` bit0 = 0, nonzero, only bits < P; rules/ai_judged: all `stakes[i] == stake_each ≥ 10_000`; market: `stake_each = 0`, each stake ≥ 10_000; time limit per kind; flags per §9.2; judges distinct, not participants, ≠ oracle; oracle not a participant; `program_hash ≠ 0`. Sets `fund_deadline = now + FUND_WINDOW_S`, `created_at = now`, state Proposed. Emits `BetCreated` |
| 3 | `fund` | `calibration_hash [u8;32], program_hash [u8;32], terms_hash [u8;32]` | participant `s`, bet `w`, vault `w`, participant_token `w`, token_program | Requires Proposed and `now <= fund_deadline`; signer is an unfunded participant. `program_hash` must equal the Bet's, and `terms_hash` must equal §4.2 recomputed from the Bet (`ConsentMismatch`). Rules: the supplied `calibration_hash` must be nonzero; if `bet.calibration_hash == 0`, set it; else it must be equal (`CalibrationMismatch` for a zero or unequal value). ai_judged/market: must be zero. Transfers `stakes[i]`. When all are funded → Funded, `funded_at = now`. Emits `Funded` |
| 4 | `cancel` | — | creator `s`, bet `w`, vault `w`, oracle `w`, track_buffer `w`, token_program, + payout accounts | Proposed only. Refunds funded stakes → Refunded (reason 7). Emits `BetCancelled`, `Refunded` |
| 5 | `start` | `beacon_slot u64, witnesses Vec<WitnessArg {key Pubkey, kind u8}>` | authority `s` (creator or oracle), bet `w`, slot_hashes | Requires Funded and `now <= funded_at + START_WINDOW_S`; ≤ 8 distinct witnesses, kind ≤ 2. Beacon per §7.5 (market: `beacon_slot = 0` and no witnesses). Stores kinds, sets heads to none and head hashes to `G_w`, computes the initial root. → Live, `started_at = now`. Emits `BetStarted` |
| 6 | `commit_evidence` | `seq u32, heads Vec<HeadArg {index u32, hash [u8;32]}>` | oracle `s`, bet `w` | Requires Live and `seq == evidence_seq + 1`; exactly `n_witnesses` heads in witness order; §7.4 checks. Stores heads and hashes. Emits `EvidenceCommitted {is_final: false}` |
| 7 | `end` | `seq u32, heads Vec<HeadArg>` | authority `s`, bet `w` | Requires Live. Oracle: any time, with heads (`seq` rules as in #6), or `[]`. A participant: any time, `heads = []`. Anyone else: once `now >= started_at + time_limit_s`, `heads = []`. Market: oracle only, heads empty. Sets the final root → Perceiving, `ended_at = now`. Emits `EvidenceCommitted {is_final: true}`, `BetEnded` |
| 8 | `post_tracks` | `payload_len u32, program_len u16, calibration_len u16, offset u32, data Vec<u8>, finalize bool, perception_root [u8;32]` | payer, oracle `s`, bet `w`, track_buffer `w`, system_program | Requires Perceiving and not finalized; `payload_len ≤ MAX_BUFFER_PAYLOAD`; `len(data) ≤ POST_TRACKS_CHUNK`. The first call creates the PDA (§9.3); later calls must repeat identical lengths. Writes must be sequential (`offset == written`). On `finalize`: `written == payload_len`; `sha256(program) == program_hash`; `sha256(calibration) == calibration_hash` (empty ⇔ zero hash); decode-validate all parts (§5); program participants/stakes/side_b_mask/time_limit/kind/actor-bound flag must equal the Bet's (`ProgramBetMismatch`); set `tracks_hash`, `perception_root` (read only when `finalize`; may be zero otherwise) and `tracks_finalized = 1`. If `payload_len == program_len + calibration_len` (no tracks part): allowed only with feature `sp1` (else `BufferLayout`); sets `tracks_finalized = 2`, `tracks_hash = 0`. Emits `TracksPosted` |
| 9 | `run_rules` | — | oracle `s`, bet `w`, track_buffer | Requires Perceiving and `tracks_finalized == 1` (`TracksNotFinalized` otherwise). The oracle must sign; after `ended_at + PERCEPTION_TIMEOUT_S`, `refund` is used instead **[D-36]** (`run_rules` then fails with `DeadlinePassed`; at exactly `ended_at + PERCEPTION_TIMEOUT_S` it still runs). Evaluates §3 with `verified = bet.bio`. WINNER → PreRuled, `consent_deadline = now + CONSENT_WINDOW_S`. NEEDS_PANEL → Disputed with `dispute_reason = reason`, bond 0, default disputer. Emits `PreRuled` (and `Disputed` if it needs the panel) |
| 10 | `consent` | `winner_mask u8, evidence_root [u8;32]` | authority `s`, bet `w`, vault `w`, oracle `w`, track_buffer `w`, token_program, + payout accounts | Requires PreRuled; args must equal the Bet's (`ConsentMismatch`). A participant signer before the deadline sets their consent bit (`AlreadyConsented` if already set). Settles when all bits are set, or when any signer (including the oracle) calls after `now > consent_deadline` (silence = consent). Settlement: path CONSENT (RULE if the pre-ruling came from `verify_sp1_run`); pays per §9.8; closes TrackBuffer and vault (rent → oracle). Emits `Consented` (if a bit was set), then `Settled` |
| 11 | `dispute` | `reason u8 (1..4), evidence_root [u8;32]` | disputer `s`, bet `w`, vault `w`, disputer_token `w`, token_program | Requires PreRuled and `now <= consent_deadline`; the signer is a participant who has not consented. `bond = max(min_i stakes[i] / DISPUTE_BOND_DIV, DISPUTE_BOND_MIN)` is transferred to the vault. → Disputed. Emits `Disputed` |
| 12 | `settle_panel` | `outcome u8 (0 no contest, 1 side 0 wins, 2 side 1 wins)` | bet `w`, vault `w`, oracle `w`, track_buffer `w`, token_program, instructions sysvar, + payout accounts | Requires Disputed, `now ≤ disputed_at + PANEL_TIMEOUT_S` (else `DeadlinePassed`; `refund` reason 6 applies after it) and a quorum per §9.7. Outcome 0 → refund all, bond back → Refunded (reason 2). Otherwise `winner_mask` = side mask; the bond is **upheld** iff `preruling == 1 && winner_mask == bet.winner_mask` (bond joins the pot), else it is returned to the disputer. → Settled, path PANEL. Emits `Settled` (or `Refunded`) |
| 13 | `verify_biometric_proof` | `participant u8, modality u8, frame u32, tau_bps u16, proof_a [u8;64], proof_b [u8;128], proof_c [u8;64]` | oracle `s`, bet `w`, profile | Requires Perceiving (tracks need not be posted). Checks: `profile.wallet == participants[participant]`; `profile.updated_at <= bet.created_at` (`ProfileTooNew`); the commitment for the modality is nonzero; `tau_bps >= TAU_*_BPS`. Builds public inputs per §8.6 with the final `bet.evidence_root`, then runs Groth16 verify. Appends a `BioCheck` (dedupe on participant+frame; `TooManyCheckpoints` past 8). The oracle proves only the checkpoints the engine computed from the posted buffer. Emits `BiometricVerified`. The tx requests 300K CU |
| 14 | `verify_sp1_run` | `public_values Vec<u8>, proof Vec<u8>` | oracle `s`, bet `w` | Cargo feature `sp1` (off by default ⇒ `Sp1Disabled`). Requires `tracks_finalized == 2`. Public values: `program_hash[32] ‖ calibration_hash[32] ‖ perception_root[32] ‖ evidence_root[32] ‖ bio_hash[32] ‖ preruling u8 ‖ reason u8 ‖ winner_mask u8 ‖ leg_results[8]`; all hashes must match the Bet; then it behaves like `run_rules` **[D-9]** |
| 15 | `refund` | — | bet `w`, vault `w`, oracle `w`, track_buffer `w`, token_program, + payout accounts | Permissionless when one of these holds: Proposed & `now > fund_deadline` (1); Funded & `now > funded_at + START_WINDOW_S` (3); Live & `now > started_at + time_limit_s + LIVE_GRACE_S` (4); Perceiving & `now > ended_at + PERCEPTION_TIMEOUT_S` (5); Disputed & `now > disputed_at + PANEL_TIMEOUT_S` (6); PreRuled & `now > consent_deadline + PANEL_TIMEOUT_S` (8, stuck escape). Returns each funded stake and any bond. → Refunded, `refund_reason` set. Emits `Refunded` |

After payouts, the vault is closed with rent to `oracle`. **Dust rule**: payouts are computed from Bet state, never from `vault.amount`. Before closing, any `vault.amount − accounted` (accounted = Σ funded stakes + bond held − paid) is transferred to the lowest-index winner (refund paths: participant 0). Stray deposits therefore cannot block `close_account`.

**Transaction size budgets** (legacy, no lookup table):

| Transaction | Budget |
|---|---|
| `post_tracks` | ≈ 470 B overhead (2 signatures 129, header 3, 6 keys 193, blockhash 32, instruction header ≈ 12, args ≈ 57, compute-budget instruction ≈ 45) + ≤ 700 B data |
| `create_bet` | ≈ 1,050 B with 3 signatures |
| `settle_panel` | ≈ 1,100 B: 1 signature, 17 keys, 367-byte Ed25519 instruction |

Every `run_rules` transaction carries `SetComputeUnitLimit(1_400_000)` (§3.13). `verify_biometric_proof` carries `SetComputeUnitLimit(300_000)`.

### 9.5 Events (Anchor `emit!`; logged as `Program data: base64(disc ‖ borsh)`, `disc = sha256("event:<Name>")[0..8]`)
Program logs can be truncated (10 KB log limit). Verdict events are small, so `emit!` is used. The backend's mock/rpc fallback re-reads the Bet account after every observed transaction, so a lost log line cannot leave state stale.
| Event | Fields (order) |
|---|---|
| `ProfileUpdated` | wallet Pubkey, flags u8 |
| `BetCreated` | bet Pubkey, creator Pubkey, nonce u64, participants Vec<Pubkey>, stakes Vec<u64>, side_b_mask u8, flags u8, program_hash [u8;32], time_limit_s u32, fund_deadline i64 |
| `Funded` | bet, participant Pubkey, participant_idx u8, amount u64, funded_mask u8, all_funded bool, calibration_hash [u8;32] |
| `BetCancelled` | bet |
| `BetStarted` | bet, beacon_slot u64, beacon_hash [u8;32], started_at i64, n_witnesses u8 |
| `EvidenceCommitted` | bet, seq u32, root [u8;32], gap_mask u8, is_final bool |
| `BetEnded` | bet, evidence_root [u8;32], ended_at i64 |
| `TracksPosted` | bet, perception_root [u8;32], tracks_hash [u8;32], payload_len u32 |
| `BiometricVerified` | bet, participant_idx u8, modality u8, frame u32 |
| `PreRuled` | bet, preruling u8, reason u8, winner_mask u8, leg_results [u8;8], consent_deadline i64 |
| `Consented` | bet, participant Pubkey, consent_mask u8 |
| `Disputed` | bet, disputer Pubkey, reason u8, bond u64 |
| `Settled` | bet, path u8, winner_mask u8, pot u64, payouts [u64;8] |
| `Refunded` | bet, reason u8, amounts [u64;8] |

### 9.6 Errors (`#[error_code]`, numbered from 6000 in this order)
`6000 InvalidState, 6001 NotParticipant, 6002 AlreadyFunded, 6003 BadParticipants, 6004 BadStake, 6005 BadSides, 6006 BadTimeLimit, 6007 BadJudges, 6008 CalibrationMismatch, 6009 DeadlinePassed, 6010 DeadlineNotReached, 6011 Unauthorized, 6012 BeaconSlotNotFound, 6013 BeaconTooOld, 6014 TooManyWitnesses, 6015 EvidenceSeq, 6016 EvidenceHeads, 6017 EvidenceRegress, 6018 BufferTooLarge, 6019 BufferLayout, 6020 BufferIncomplete, 6021 ProgramHashMismatch, 6022 CalibrationHashMismatch, 6023 MalformedProgram, 6024 MalformedCalibration, 6025 MalformedTracks, 6026 ProgramBetMismatch, 6027 TracksNotFinalized, 6028 AlreadyConsented, 6029 ConsentMismatch, 6030 InsufficientQuorum, 6031 BadOutcome, 6032 BadProof, 6033 TauTooLow, 6034 MissingCommitment, 6035 TooManyCheckpoints, 6036 Sp1Disabled, 6037 BadTokenAccount, 6038 MathOverflow, 6039 NotRefundable, 6040 BadReason, 6041 BadCommitment, 6042 ProfileTooNew, 6043 BadEd25519Instruction, 6044 BadFlags`.

The engine `ErrorCode` type is the string union of these names.

### 9.7 Panel judge signatures
```
M = "VERDICT/PANEL/v1" (16) ‖ program_id[32] ‖ bet[32] ‖ u8 outcome ‖ evidence_root[32] ‖ program_hash[32]      // 145 bytes
```
Each judge signs `M` with its ed25519 key (`bet.judges[j]`). The settle transaction contains **exactly one** Ed25519 precompile instruction, placed **immediately before** `settle_panel`, with `num_signatures = 2`. The signatures come from the two lowest-index judges that voted for the ruling. Fixed data layout (367 B):

| Bytes | Content |
|---|---|
| 0, 1 | `num_signatures = 2`, padding `0` |
| 2..16 | offsets entry 0: `signature_offset=62, signature_instruction_index=0xFFFF, public_key_offset=30, public_key_instruction_index=0xFFFF, message_data_offset=222, message_data_size=145, message_instruction_index=0xFFFF` (u16 LE each) |
| 16..30 | offsets entry 1: `158, 0xFFFF, 126, 0xFFFF, 222, 145, 0xFFFF` |
| 30..62 | `pk0` |
| 62..126 | `sig0` |
| 126..158 | `pk1` |
| 158..222 | `sig1` |
| 222..367 | `M` |

The program (`load_current_index_checked`, then `load_instruction_at_checked(current - 1)`) checks:
- the program ID is `Ed25519SigVerify111111111111111111111111111`;
- the data length is 367, and the fixed offsets are exactly as above (every index field `0xFFFF`);
- the message equals the `M` recomputed from the Bet and `outcome`;
- `pk0 ≠ pk1`, and both are in `bet.judges`.

Any failure ⇒ `BadEd25519Instruction` / `InsufficientQuorum`. The precompile itself verifies the signatures.

### 9.8 Settlement math (engine `settle.ts`, bigint, and Rust u128 MUST match)
```
pot      = Σ_{i funded} stakes[i] + (bond_upheld ? dispute_bond : 0)
SW       = Σ_{i ∈ W} stakes[i]                                  // W = winner_mask
payout_i = floor(pot · stakes[i] / SW)  for i ∈ W
rem      = pot - Σ payout_i  → added to the lowest-index winner
refund   : payout_i = stakes[i] for funded i
bond     : when not upheld (or no contest / refund), returned to the disputer's payout account (by participant index)
dust     : §9.4 dust rule, after the above
```
`Settled.payouts[i]` and `Refunded.amounts[i]` = total transferred to participant i (bond refunds and dust included). No protocol fee.

### 9.9 Timing summary
create → fund within 900 s → start within 900 s → Live ≤ `time_limit_s` (+300 s grace before refund) → Perceiving ≤ 3600 s → PreRuled consent window 120 s (silence = Agree; stuck escape after a further 3600 s) → Disputed ≤ 3600 s for a panel ruling, else refund.

---

## 10. Replay booth protocol

Runs when a bet enters **Disputed** (participant dispute, LOW_CONFIDENCE, AI_JUDGED, CROSS_CHECK_FAILED, WINDOW_UNAVAILABLE). It is labeled **Trusted** everywhere in the UI and README.

### 10.1 Exhibits (never the whole video)
```ts
interface Exhibit {
  id: string;                         // "E1", "E2", … in creation order
  kind: "clip" | "audio" | "tracks" | "transcript" | "identity" | "program" | "flags" | "rerun" | "phone";
  witness: string | null;             // "cam1".."cam8" / "mic1".."mic8" (numbered per kind in witness order)
  t_start_ms: number; t_end_ms: number;   // session time (relative to t0)
  uri: string;                        // GET /bets/:id/exhibits/:eid
  sha256: string;                     // of the exhibit bytes
  chain_proofs: {                     // ties footage to evidence_root
    witness: string; from_index: number;
    links: { index: number; kind: number; start_ms: number; duration_ms: number; body_sha256: string }[];  // from_index..head
    head_proof: MerkleProof;          // leaf_w (§7.4) in evidence_root
  }[];
}
```
Verification recomputes `c_{from}…c_head` from `links` (starting from `c_{from-1}`, which is included as the `prev` of the first link, or `G_w` when `from_index = 0`), checks `leaf_w`, then checks `head_proof`.

Built automatically:
- For every decisive frame `d` (or, if there is none, the last 6 s): a `clip` per camera witness and an `audio` exhibit per audio witness over `[d·100 − 2000, d·100 + 2000]` ms.
- A `tracks` excerpt (QFrames over the same span, JSON).
- An `identity` excerpt (stitched track, id_conf only, never embeddings) for actor-bound bets.
- A `transcript` (Scribe segments + audio events).
- `program` (YAML + read-back + pre-ruling) and `flags` (cross-check result, gap_mask, audio_disagree, phone_disagree).
- AI-judged bets: the last 6 s plus up to 4 evenly spaced 4 s clips.
- Dispute reason 3 (`bad_tracking`): the backend re-runs perception on a fresh pair of hosts (when allowed by `PERCEPTION_PROVIDER`/`ALLOW_SPEND`; mock re-runs are free) and adds a `rerun` exhibit (the cross-check result and tracks).

### 10.2 Advocates (one per side, `ADVOCATE_PROVIDER`)
Input: program, read-back, pre-ruling, exhibit catalogue. Output (JSON, validated):
```json
{ "side": 0, "claim": "≤ 600 chars", "citations": ["cam1@12.4s", "mic2@12.6s"], "exhibits": ["E1", "E4", "E5"] }
```
Citation regex: `^(cam|mic)[1-8]@[0-9]{1,5}(\.[0-9])?s$`. Exhibit slots: 3 per advocate, +1 if a participant on that side registered a camera witness. Extra or invalid citations are dropped.

### 10.3 Judges (×3, mixed models, `JUDGE_PROVIDERS`)
`J0` is a video-native model (clips as video). `J1` and `J2` are frame-sampled multimodal models (clips sampled at 2 fps). Grok is available via the `xai` provider. Each judge receives the program, read-back, both briefs, the exhibits cited by either brief, and `program` and `flags`. Output:
```json
{ "outcome": 1, "confidence_bps": 8200, "rationale": "≤ 1000 chars" }
```
`outcome`: 0 no contest, 1 side 0 wins, 2 side 1 wins. AI-judged bets: the judge answers the question; "yes" ⇒ the `if_true` side, "no" ⇒ the `else` side (outcome = side + 1).

### 10.4 Commit–reveal
```
commit_j = sha256("VERDICT/JUDGE-COMMIT/v1" ‖ bet[32] ‖ u8 j ‖ u8 outcome ‖ u16 confidence_bps ‖ sha256(utf8(rationale)) ‖ nonce[32])
```
The orchestrator collects all three commits (timeout 120 s; a judge without a commit is absent) and records them with timestamps **before** requesting any reveal. Reveals that don't match their commit are discarded.

### 10.5 Ruling and signatures
- Count the revealed judges with `confidence_bps >= PANEL_CONF_FLOOR_BPS`, per outcome. An outcome with ≥ 2 votes wins; otherwise the ruling is **0 (No contest)**.
- The two lowest-index judges that voted for the ruling sign `M` (§9.7) with their keys (`JUDGE_KEY_0..2`, held by the backend; pubkeys passed in `create_bet`). With No contest by default (fewer than 2 votes on any outcome), judges 0 and 1 sign outcome 0. The backend submits the Ed25519 instruction + `settle_panel`.
- Booth record (served at `GET /v1/bets/:id/booth`, pushed as WS `booth`): `{ status: "collecting"|"judging"|"ruled"|"submitted", exhibits, briefs, commits:[{judge, commit, at_ms}], reveals:[{judge, outcome, confidence_bps, rationale, nonce}], ruling: {outcome, votes} | null, tx_signature | null }`.

---

## 11. World Mode (Gemini Prediction Markets)

### 11.1 Normalized event model (backend adapter output)
```ts
interface WorldContract { id: string; label: string; prob_bps: number; bid_bps?: number; ask_bps?: number }
interface WorldEvent {
  id: string; title: string; category: string; close_time_ms: number;
  status: "open" | "closed" | "resolved";
  contracts: WorldContract[];
  resolution?: { contract_id: string; result: "yes" | "no" | "void" }[];
}
```
`prob_bps` = the mid of best bid/ask (`floor((bid+ask)/2)`) if both exist, else the last trade, else `ask`. Gemini dollar prices `p ∈ [0,1]` map to `round(p·10000)` (adapter, non-consensus). Exact Gemini REST/WS paths live only in the adapter (`GEMINI_BASE_URL`, default `https://api.gemini.com`; public, keyless). 🔴 The adapter team MUST verify the paths and resolution fields against the live docs. The mock adapter serves fixtures.

### 11.2 Stake split (single leg, bigint)
The proposer picks a contract and side. `p` = the probability of the proposer's side (`yes`: prob_bps, `no`: 10000 − prob_bps), clamped to `[PROB_CLAMP_MIN_BPS, PROB_CLAMP_MAX_BPS]`. For a total pot `T` (units):
```
proposer_stake     = floor(T · p / 10000 / 10_000) · 10_000      // floored to whole cents
counterparty_stake = T - proposer_stake
```
This is fair: the favored side stakes more, and a 70/30 market gives a 70/30 split. Both stakes must be ≥ 10_000, else `BAD_STAKE`.

### 11.3 Parlay
Legs `1..4` (distinct contracts); the proposer wins only if all legs hit: `P = p_1; P = floor(P · p_i / 10000)` for i = 2..n (leg order), then clamp and split as in §11.2 with `p = P`. Independence is assumed and stated in the UI ("Parlay").

### 11.4 Market program and flow
- Compiled by the backend (`compileMarket(quote, proposer, counterparty, nowMs)`, no LLM): `kind: "market"`, `participants: [proposer, counterparty]`, `sides: [0, 1]`.
- One leg per pick (`actor_bound: false`, `attempt_window_frames: 0`, `market: {...}` including `prob_bps` at quote time).
- Outcome `side(A) wins iff leg 1 and leg 2 …; else side(B)`; `stakes` from the split; `time_limit_s = min(2592000, ceil((close_time_ms − now_ms)/1000) + 86400)`.
- Title = the event title truncated to 40 chars on a word boundary (parlay: first event title + " +N").
- Flow:
  1. The counterparty is picked from the proposer's confirmed recent huddle members (§8.3 pay set).
  2. `create_bet` (`acceptance_audio_hash = 0`) → WS `notify` "Bet offered" to the counterparty.
  3. **Counterparty `fund` = acceptance** (no voice) **[D-32]**.
  4. The keeper sends `start` (no witnesses).
  5. The oracle sends `end` when all events resolve.
  6. `post_tracks` with `market_bin` → `run_rules` → consent window like any bet.
- Market bets skip Scene check and Record.

### 11.5 Live prices
The backend subscribes to Gemini WS for open World bets and the composer's selected event. It relays `{"type":"world.price","event_id","contract_id","prob_bps","at_ms"}` on the app WebSocket (mock: a deterministic random walk seeded by event id).

### 11.6 Hedge (stretch)
`POST /world/bets/:id/hedge {contract_id, side, amount_units}` → `{order_id, status:"mock"}` in mock mode. Live mode targets Gemini's demo environment via OAuth and refuses unless `ALLOW_SPEND=1` and the OAuth config are present (`SPEND_DISABLED`).

---

## 12. Backend API (used by the Flutter app)

Base URL `{API}/v1`. JSON UTF-8. Auth header `Authorization: Bearer <token>` on everything except `/auth/*` and `/webhooks/*`. Errors: HTTP 4xx/5xx with `{ "error": { "code": "SNAKE_CASE", "message": "<fixed message, §12.8>" } }`.

### 12.1 Signing model
The app holds an **embedded wallet**: an ed25519 keypair generated on device, kept in secure storage and unlocked by the device passkey/biometric prompt **[D-10]**. A user is bound to one wallet at their first `POST /auth/session`. A different wallet for an existing user is rejected (`WALLET_MISMATCH`). Recovery is out of scope **[D-33]**. Any action needing a user signature returns
```json
{ "sign": { "tx_id": "uuid", "message_b64": "<serialized Solana message>", "expires_at_ms": 0, "summary": "Stake $5.00" } }
```
- The app signs the `message_b64` bytes with the wallet key and calls `POST /tx/{tx_id}/submit {"signature_b64": "..."}` → `{ "status": "confirmed" | "failed", "signature": "<solana sig>" | null, "error": {...} | null }`.
- The backend adds the fee-payer (and, where required, oracle) signatures. `TX_EXPIRED` ⇒ the app re-requests the sign payload once, automatically.
- In mock-chain mode the message has the same bytes, and the mock chain verifies the ed25519 signature.
- The acceptance signature (§4.2 `accept_sig`) is a raw ed25519 signature over a message, not a transaction.

### 12.2 Shared shapes
```ts
interface UserView { id: string; wallet: Pubkey; display_name: string; enrolled: { face: boolean; voice: boolean } }
interface HuddleView { id: string; code: string; creator_user_id: string; members: { user: UserView; joined_at_ms: number; confirmed: boolean }[] }
type BetState = "proposed"|"funded"|"live"|"perceiving"|"preruled"|"disputed"|"settled"|"refunded";
interface ParticipantView { user_id: string; display_name: string; wallet: Pubkey; side: 0 | 1; accepted: boolean; funded: boolean; consent: "pending" | "agree" | "dispute" }
interface Question { id: string; text: string /* ≤ 6 words */; kind: "choice" | "multi" | "free" | "region"; chips: string[]; entity?: string; audio_url: string | null }
interface DraftView {
  draft_id: string; huddle_id: string; status: "needs_clarification" | "ready" | "invalid";
  kind: "rules" | "ai_judged" | "market"; title: string | null;          // compiler title, ≤ 40 chars, 1–5 words; not hashed
  questions: Question[];                                                  // "region" questions never block "ready"
  program?: Program; yaml?: string; readback?: string[]; program_hash?: string;
  bet_id?: Pubkey;                                                        // Bet PDA, set once create_bet confirmed (errata App: following the creator)
  labels: Record<string, string>;                                         // entity → 1–3 word Title-case label (persons = display name)
  participants: { user_id: string; display_name: string; side: 0 | 1; accepted: boolean; is_creator: boolean }[];
  errors?: CompileError[]; warnings?: CompileError[];
  frozen: boolean;                                                        // true once any acceptance exists
  readback_audio_url: string | null; updated_at_ms: number;
}
interface BetView {
  id: Pubkey;                       // Bet PDA
  title: string;                    // from the draft
  kind: "rules" | "ai_judged" | "market"; ai_judged: boolean;
  state: BetState; state_label: string;                                   // §12.9 map
  creator_user_id: string;
  participants: ParticipantView[];
  my_index: number | null; my_role: "participant" | "bystander";
  stake_each_units: number | null; stakes_units: number[]; pot_units: number;
  time_limit_s: number; actor_bound: boolean;
  program: Program; yaml: string; readback: string[]; program_hash: string; labels: Record<string, string>;
  calibration: Calibration | null; calibration_hash: string | null;
  conditions: { leg: number; field: "valid_attempt" | "success"; path: string; label: string }[];   // §12.10
  deadlines_ms: { fund: number | null; start: number | null; live_end: number | null; consent: number | null; panel: number | null };
  started_at_ms: number | null; t0_ms: number | null; ended_at_ms: number | null;
  witnesses: { id: string; label: string; kind: "camera" | "audio" | "detections"; user_id: string | null; synced: boolean | null }[];
  gap_mask: number;
  preruling: { code: 1 | 2 | 3; reason: number; winner_side: 0 | 1 | null; winner_mask: number; leg_results: number[]; consent_deadline_ms: number | null } | null;
  dispute: { by_user_id: string | null; reason: number; bond_units: number } | null;
  booth_status: "collecting" | "judging" | "ruled" | "submitted" | null;
  settlement: { path: "consent" | "rule" | "panel" | "refund"; winner_mask: number; payouts: { user_id: string; amount_units: number }[]; tx_signature: string } | null;
  refund_reason: number | null;
  updated_at_ms: number;
}
```

### 12.3 Routes
| Method & path | Request | Response |
|---|---|---|
| `GET /auth/nonce` | — | `{nonce}` |
| `POST /auth/email/start` | `{email}` | `{sent: true}` (mock code `000000`) |
| `POST /auth/session` | `{provider: "google"\|"email", credential: string, email_code?: string, wallet: Pubkey, nonce, wallet_sig_b64}` — `wallet_sig` over `"VERDICT/LOGIN/v1" ‖ utf8(nonce)` | `{token, user: UserView}` (mock: Google `credential = "mock:<email>"`). `WALLET_MISMATCH` |
| `GET /me` | — | `UserView` |
| `GET /enroll/challenge` | — | `{challenge_id, face_prompts: ("left"\|"right"\|"up"\|"down")[] (2), voice_phrases: string[3]}` |
| `POST /enroll/face` | `{challenge_id, frames_b64: string[3..5]}` — full-frame JPEG ≤ 640 px long side; `frames[0]` neutral, `frames[1..2]` in `face_prompts` order, extras neutral | `{ok, liveness: boolean}` (`LIVENESS_FAILED`) |
| `POST /enroll/voice` | `{challenge_id, clips_b64: string[3] (WAV)}` | `{ok}` (`PHRASE_NOT_HEARD`) |
| `POST /enroll/complete` | `{consent: true, display_name}` | `{face_commit, voice_commit, sign}` (init_profile) |
| `DELETE /enroll` | — | `{deleted: true, sign}` (zero commitments) |
| `GET /balance` | — | `{usdc_units}` |
| `POST /faucet` | — | `{usdc_units}` (demo drip, `FAUCET_UNITS` from the test mint, idempotent per day) |
| `POST /huddles` | — | `{huddle_id, code (6 digits)}` (creator is a confirmed member) |
| `POST /huddles/join` | `{code}` | `HuddleView` (member added with `confirmed: false`; `CODE_INVALID`, `HUDDLE_FULL`) |
| `GET /huddles/:id` | — | `HuddleView` |
| `POST /huddles/:id/scan` | `{faces: [{crop_b64 (JPEG), bbox: [x0,y0,x1,y1]}]}` | `{matches: [{bbox, user: UserView \| null, cos_bps, matched: boolean}]}` — the closed set is the joined members; matched members become `confirmed: true` |
| `DELETE /huddles/:id/members/:user_id` | — | `HuddleView` |
| `POST /bets/compile` | `{huddle_id, transcript?: string, audio_b64?: string (16 kHz PCM16 WAV of the dictation), draft_id?: string, answers?: [{question_id, answer}]}` | `DraftView`. Any recompile clears acceptances |
| `GET /drafts/:id` | — | `DraftView` |
| `PATCH /drafts/:id` | `{stake_each_units?, time_limit_s?, sides?: Record<user_id, 0\|1>, participants?: user_id[]}` | `DraftView` — re-canonicalizes deterministically through the engine (no LLM); clears acceptances |
| `GET /drafts/:id/readback.mp3` | — | TTS of the read-back (ElevenLabs or mock WAV) |
| `GET /drafts/:id/accept/challenge` | — | `{challenge_id, phrase: "I accept <w1> <w2>"}` (two random words) |
| `POST /drafts/:id/accept` | `{challenge_id, audio_b64, accept_sig_b64}` | `{accepted: boolean, cos_bps, participant_index}`. Voice must match the caller (§8.3); the normalized transcript (lowercase, strip `[^a-z ]`, collapse spaces) must contain `"i accept"` and both words; `accept_sig` must verify (§4.2). Freezes the draft. `VOICE_NOT_MATCHED`, `PHRASE_NOT_HEARD` |
| `POST /agent/session` | `{huddle_id, draft_id?}` | `{mode: "mock" \| "elevenlabs", signed_url: string \| null}` |
| `POST /bets` | `{draft_id}` | `{bet: BetView, sign}` (create_bet; creator signs, backend adds oracle). `NOT_ACCEPTED` until all `P-1` counterparties have accepted |
| `GET /bets` | `?state=` | `{bets: BetView[]}` |
| `GET /bets/:id` | — | `BetView` |
| `POST /bets/:id/scene/detect` | `{frame_b64}` | `{entities: [{entity, label, bbox, conf (percent)}], conditions: [{leg, field, path, label, state: boolean, placed: boolean}]}` (single-frame fallback; the WS stream is preferred) |
| `PUT /bets/:id/scene/crops/:entity` | raw JPEG | `{crop_sha256}` |
| `PUT /bets/:id/calibration` | `Calibration` | `{calibration, calibration_hash}`. Creator only (`WRONG_STATE` otherwise); `CALIBRATION_LOCKED` (409) once any participant has funded; `CALIBRATION_INCOMPLETE` until every region entity is placed |
| `POST /bets/:id/practice` | `{frames_b64: string[] (≤ 50, 10 fps)}` | `{conditions: [{leg, field, path, label, fired: boolean, frame: number \| null}]}` (identity ignored; persons bind to the largest person track) |
| `POST /bets/:id/fund` | — | `{sign}` (fund with the current calibration_hash, program_hash, terms_hash); refused with `CALIBRATION_INCOMPLETE` |
| `POST /bets/:id/witnesses` | `{witness_key: Pubkey, kind: "camera"\|"audio"\|"detections"}` | `{witness_id, label}` (before start) |
| `POST /bets/:id/start` | — | `{ok: true}`; the beacon arrives on WS `start` (§12.4). `NO_CAMERA` for rules/ai_judged with zero camera witnesses |
| `POST /bets/:id/chunks` | `{witness_key, index, kind, body_format: "mp4"\|"mjpeg"\|"wav"\|"json", width_px?, height_px?, orientation?, start_ms, duration_ms, body_sha256, chunk_hash, prev_hash, sig_b64, final: boolean}` | `{accepted: true, upload_url}` (`CAMERA_MISMATCH` if camera metadata differs from calibration) |
| `PUT /bets/:id/chunks/:witness_key/:index` | raw body (`application/octet-stream`, ≤ 20 MiB) | `{stored: true}` (`CHUNK_TOO_LARGE` 413) |
| `GET /bets/:id/chunks/:witness_key/:index` | — | raw body (footage download for re-runs) |
| `POST /bets/:id/end` | — | `{ok}`. The backend waits until every witness has posted `final` (or 10 s), then the oracle sends `end` with the final heads |
| `GET /bets/:id/ruling` | — | `{outcome_text, preruling, readback, legs: [{id, result, decisive_frames}], amount_units: number \| null, can_respond: boolean, bond_units}` (§12.10) |
| `POST /bets/:id/consent` | — | `{sign}` |
| `POST /bets/:id/dispute` | `{reason: 1..4}` | `{sign, bond_units}` |
| `GET /bets/:id/booth` | — | booth record (§10.5); bet viewers only, else `NOT_FOUND` (errata backend-audit-viewer) |
| `GET /bets/:id/exhibits/:eid` | — | raw exhibit bytes; bet viewers only |
| `GET /bets/:id/receipt` | — | `{rows: ReceiptRow[]}` (§12.11); bet viewers only |
| `GET /bets/:id/announce.mp3` | — | TTS of the verdict |
| `GET /pay/challenge` | — | `{challenge_id, face_prompt}` |
| `POST /pay/scan` | `{challenge_id, faces_b64: string[2] (crop at neutral, crop after prompt)}` | `{matches: [{user, cos_bps, matched}], liveness: boolean}` |
| `POST /pay/voice` | `{audio_b64}` | `{matches: [...]}` (same closed set, voice thresholds) |
| `POST /pay` | `{to_user_id, amount_units}` | `{sign}` (creates the recipient ATA if missing, payer-funded) |
| `GET /world/events` | `?q=&limit=` | `{events: WorldEvent[]}` |
| `GET /world/events/:id` | — | `WorldEvent` |
| `POST /world/quote` | `{legs: [{event_id, contract_id, side}], total_units}` | `{quote_id, p_bps, proposer_units, counterparty_units, legs: [{..., prob_bps}], expires_at_ms}` |
| `POST /world/bets` | `{quote_id, counterparty_user_id}` | `{bet: BetView, sign}` (`QUOTE_EXPIRED`) |
| `POST /world/bets/:id/hedge` | §11.6 | §11.6 |
| `GET /leaderboard` | `?huddle_id=` | `{rows: [{user_id, display_name, net_units}]}` (backfilled from `Settled`/`Refunded`) |
| `POST /tx/:tx_id/submit` | `{signature_b64}` | §12.1 |
| `POST /webhooks/quicknode` | §12.5 | `204` |
| `POST /webhooks/elevenlabs/tool` | `{draft_id?, huddle_id, transcript}` + header `x-verdict-tool-secret` | `DraftView` (the Agent's compile tool) |

### 12.4 WebSocket `GET {API}/v1/ws?token=…`
Client → server:
- `{"type":"subscribe","topics":["user","bet:<id>","huddle:<id>","world:<event_id>"]}` and `{"type":"unsubscribe",...}`. On subscribe, the server immediately sends a snapshot (`bet` / `huddle` / `draft`). While a bet is Live, the `bet:<id>` snapshot also replays its `start` message (clients treat `start` idempotently).
- `{"type":"scene.frame","bet_id","jpeg_b64","t_ms"}`: 10 fps, JPEG ≤ 640 px long side. The backend keeps a rolling 50-frame buffer and evaluates `leafSignals` with the last PUT calibration.
- `{"type":"recording","bet_id","witness_key"}`.
- `{"type":"ping"}` every 20 s. The server closes the socket after 60 s of silence. On reconnect, the client re-subscribes and treats the snapshots as truth.

Server → client:
- `{"type":"bet","bet":BetView}`, `{"type":"huddle","huddle":HuddleView}`, `{"type":"draft","huddle_id","draft":DraftView}` (on `huddle:<id>`).
- `{"type":"chain","bet_id","name":"<EventName>","data":{...},"signature","slot"}`.
- `{"type":"scene","bet_id","entities":[...],"conditions":[{leg,field,path,label,state,placed}]}`.
- `{"type":"start","bet_id","beacon":{"slot","hash_hex","symbols":[42]},"wav_url","sfx_url","play_on_user_id","play_delay_ms":1500}`.
- `{"type":"booth","bet_id","booth":BoothRecord}`, `{"type":"world.price",...}`, `{"type":"notify","title":"≤ 3 words","bet_id"}`, `{"type":"pong"}`.

Notifications are WS `notify` plus on-device local notifications only (no FCM/APNs) **[D-29]**. The app shows `notify` titles as an in-app banner in the foreground and as local notifications while backgrounded, schedules a local reminder before a pending consent deadline, and re-fetches bets on resume (the OS may suspend the socket in the background).

### 12.5 Chain events: QuickNode Streams webhook (`CHAIN_EVENTS_SOURCE=quicknode`)
- Stream config: `infra/quicknode/stream.json` (network Solana devnet, dataset `block`, filter `infra/quicknode/filter.js`, destination `{API}/v1/webhooks/quicknode`). The filter keeps transactions that mention `VERDICT_PROGRAM_ID`, decodes `Program data:` lines into events (§9.5) and returns:
```json
{ "stream": "verdict-devnet", "events": [
  { "signature": "…", "slot": 123, "block_time": 1700000000, "index": 0, "name": "PreRuled",
    "data": { "bet": "<base58>", "preruling": 1, "reason": 0, "winner_mask": 2, "leg_results": [1,255,255,255,255,255,255,255], "consent_deadline": "1700000120" } } ] }
```
- Decoded encoding: Pubkey → base58, `[u8;32]` → hex, u64/i64 → **decimal string**, smaller ints → number, bool → boolean, arrays of u8 → number arrays. The engine exposes `decodeEvent` and the filter bundles the same code.
- HMAC: headers `x-qn-nonce`, `x-qn-timestamp`, `x-qn-signature`; `signature = hex(HMAC_SHA256(QUICKNODE_SECRET, nonce ‖ timestamp ‖ raw_body))`. Reject if invalid or `|now − timestamp| > 300 s`. (Verify the header names against QuickNode docs; the scheme is isolated in one function.)
- The handler is idempotent on `(signature, index)`.
- `CHAIN_EVENTS_SOURCE=rpc_ws` uses `logsSubscribe` (mentions = program ID) into the same handler, so devnet works without a QuickNode account. In `mock` mode the mock chain calls the handler in-process (no HMAC).
- Triggers:

  | Event | Action |
  |---|---|
  | `Funded{all_funded}` | notify "Ready" |
  | `BetEnded` | start perception |
  | `TracksPosted` | submit proofs, then `run_rules` |
  | `PreRuled` | announcer + notify |
  | `Disputed` | replay booth |
  | `Settled`/`Refunded` | announcer, leaderboard, close-out |

### 12.6 Keeper
The backend runs a keeper loop every `KEEPER_INTERVAL_S` (mock chain: on every mock-clock tick). For each non-terminal bet it sends the first applicable action. All actions are idempotent; a "wrong state" reply is treated as done.
1. **Market**, Funded → `start` (oracle).
2. **Live**, rules/ai_judged, `now ≥ t0 + time_limit_s·1000 + TAIL_MS` → `POST /end` flow (wait for `final` chunks ≤ 10 s, then `end` with the final heads).
3. **Live**, market, all events resolved → `end`.
4. **Perceiving** → perception → `post_tracks` chunks → `verify_biometric_proof` ×k → `run_rules`, resuming from whatever step is missing.
5. **PreRuled**, `now > consent_deadline + 5 s` → `consent` with `authority = oracle`.
6. **Disputed**, no booth running → start the booth; when ruled → `settle_panel`.
7. Any `refund` condition in §9.4 #15 → `refund`.
8. Before any payout transaction, create missing participant ATAs (idempotent, payer-funded).

### 12.7 Persistence and storage
`DATA_DIR` (default `./.data`) holds SQLite (`better-sqlite3`) or JSON files for users, huddles, drafts, the bets mirror, the booth and the keeper state. Chunk bodies are stored at `DATA_DIR/chunks/<bet>/<witness>/<index>`, and exhibits at `DATA_DIR/exhibits/<bet>/<eid>`. There is no external database.

### 12.8 Error codes (normative; code → fixed message)
| code | message | | code | message |
|---|---|---|---|---|
| UNAUTHORIZED | Signed out | | CALIBRATION_LOCKED | Scene locked |
| NOT_FOUND | Not found | | CALIBRATION_INCOMPLETE | Place regions |
| WRONG_STATE | Not available | | CAMERA_MISMATCH | Camera changed |
| NOT_ENROLLED | Not enrolled | | NO_CAMERA | No camera |
| LIVENESS_FAILED | Liveness failed | | INSUFFICIENT_FUNDS | Insufficient balance |
| FACE_NOT_MATCHED | Face not matched | | TX_EXPIRED | Request expired |
| VOICE_NOT_MATCHED | Voice not matched | | TX_FAILED | Transaction failed |
| PHRASE_NOT_HEARD | Phrase not heard | | QUOTE_EXPIRED | Price changed |
| CODE_INVALID | Code invalid | | BAD_STAKE | Stake invalid |
| HUDDLE_FULL | Huddle full | | CHUNK_TOO_LARGE | Chunk too large |
| DRAFT_INVALID | Bet not understood | | RATE_LIMITED | Slow down |
| NOT_ACCEPTED | Awaiting acceptance | | WALLET_MISMATCH | Wrong device |
| CHALLENGE_EXPIRED | Challenge expired | | SPEND_DISABLED | Spending disabled |
| INTERNAL | Server error | | | |

Messages contain no chain jargon. The App maps codes to messages from this table (the server message is informational).

### 12.9 Display rules (App)
- **State labels** (copy rule): proposed "Waiting" · funded "Ready" · live "Live" · perceiving "Reviewing" · preruled "Ruled" · disputed "Replay booth" · settled "Won" / "Lost" (bystander "Settled") · refunded "Refunded". Spec §3.5's "marks the bet live" corresponds to `funded` ("Ready"), not `live`.
- **Money**: `$` + `floor(units / 10_000) / 100` with exactly 2 decimals and thousands separators (`$1,234.50`). Signed amounts: "+$5.00" / "−$5.00" (U+2212).
- Scene-check `conf` is shown in percent. Durations use §2.8 rendering.

### 12.10 Screens: behaviour contracts
- **Condition rows** (Scene check, Practice): one row per distinct leaf atom per leg/field: `{leg, field, path /* "0.1" = child indices from the root */, label}`, from `leafSignals`. Structurally equal atoms share a row (first path wins).
  - Label = a short-label template, at most 3 words: overlaps "On {b}", inside "In {b}", above "Above {b}", below "Below {b}", near "Near {b}", behind "Behind line", beyond "Past line", moving "{a} moving", present "{a} visible", intact "{a} standing", standing "{a} upright", at_rest "{a} still", speed "{a} speed", direction "{a} {dir}", rep_count "Reps", enters "Into {b}", leaves "Out of {b}", disappears_into "Into {b}", touches "Touches {b}", crosses "Crosses line", released_by "{a} released".
  - `{a}`/`{b}` = the entity label. If the result would exceed 3 words, the label's last word is used.
  - Event rows latch true for `PULSE_LATCH_FRAMES` in the live and practice views. Rows whose region is not yet placed show a grey dot (`placed: false`).
- **Ruling**:
  - Outcome text: "You win" / "You lose" / "{Name} wins" (bystander; side name = first participant name on that side) / "No contest" / "Replay booth".
  - `amount_units` is net: `payout_i − stakes[i]` for winners, `−stakes[i]` for losers; null for NEEDS_PANEL and bystanders.
  - Agree/Dispute are shown only when `state = preruled`, the caller is a participant, and their consent is pending (`can_respond`).
  - Dispute opens the chips "Wrong outcome" / "Wrong person" / "Bad tracking" / "Other" (reasons 1–4) plus "Bond $x.xx".
  - In the disputed state the screen shows "Replay booth", the booth status and a "Trusted" tag.
  - AI-judged bets show an "AI-judged" tag on Terms before staking.
  - Announcer: only the camera phone auto-plays `announce.mp3`, on `PreRuled` and `Settled`. Text template: "{Names} win{s} ${x}" / "No contest".
- **Terms**:
  - Dictate (Agent or record-and-compile) · Who / What / Stake / Limit chips (`PATCH /drafts`) · question chips (spoken via `audio_url`) · acceptance status per participant · Accept (counterparties: challenge phrase + passkey prompt → `accept_sig`).
  - The creator's Continue calls `POST /bets` once everyone has accepted.
  - A "World" chip opens World.
- **Scene check**: only the creator (camera owner) places regions and labels; other phones show it read-only plus "Stake". "Stake" is the second tap (`fund`). A camera pose drift > `CAMERA_POSE_DRIFT_CDEG` shows "Camera moved" on Record.
- **Record**: viewfinder · timer (t0 → limit) · witness count · End. The app keeps recording `TAIL_MS` after End.

### 12.11 Receipt rows
`ReceiptRow = {key, label, status: "ok"|"pending"|"failed"|"none", url: string | null, detail}`. Labels: Verified, Terms, Evidence, Compute, Proof, Settlement. Tapping a row opens a detail sheet of key/value rows. `url` values open in an external browser. In mock mode the urls are null.
```ts
type Detail =
  | { key: "verified"; participants: { name: string; accepted: boolean; voice_cos_bps: number | null }[];
      bio_checks: { participant_name: string; frame: number; modality: "face" | "voice" }[];
      cross_check_ok: boolean; audio_disagree: boolean; phone_disagree: boolean }
  | { key: "terms"; program_hash: string; readback: string[]; yaml_url: string }
  | { key: "evidence"; evidence_root: string; gap_mask: number;
      witnesses: { label: string; chunks: number; synced: boolean; gap: boolean; late_chunks: number; gaps_ms: number[] }[] }
  | { key: "compute"; hosts: { provider: string; job_id: string; url: string | null; network: "mainnet" | "mock"; model_hash: string }[];
      agreed: boolean; entity_agreement_bps: Record<string, number> }
  | { key: "proof"; biometric: { participant_name: string; modality: "face" | "voice"; frame: number; tx_url: string | null }[];
      binding: "trusted"; sp1: { tx_url: string | null } | null }
  | { key: "settlement"; path: "consent" | "rule" | "panel" | "refund"; tx_url: string | null; payouts: { name: string; amount_units: number }[] };
```

### 12.12 App design standard (spec §6.2–§6.4)
- Type: Inter, weights 400/600; scale 13/15/17/22/28.
- Colors: background `#0B0B0C`, surface `#141416`, hairline `#26262A`, text `#EDEDEF` / secondary `#8A8A8F`. Single accent `#5E6AD2`, used only for the primary action and the live dot.
- 8-pt grid; transitions 150 ms `easeOut`, no springs; one outline icon set (Lucide), used sparingly.
- Copy rule: labels are 1–3 words. There is no subtitle/description/helper text. A widget test (`test/copy_rule_test.dart`) walks every screen and fails on any `Text` whose style is a body/caption style below a label, and on any label longer than 3 words. Errors come only from §12.8.
- Banned (spec §6.4): confetti, gradients, illustrations, mascots, emoji, badges, carousels, decorative sounds, gamified meters, marketing copy, splash animations.
- Sign in shows Google + email only. The passkey/biometric prompt is used only to unlock the wallet **[D-41]**.

### 12.13 Navigation
- Sign in → Enroll (if not enrolled) → Home.
- Enroll: Camera · Face · Voice · "I consent" (toggle, required before Done) · Done. In enrolled mode it also shows "Delete biometrics".
- Home: Balance · New bet · Bets list (title, stake, state label) · Pay · profile row (→ Enroll in enrolled mode).
- New bet → Huddle (camera scan, participant chips = confirmed members, code) → Terms → Scene check → Record → Ruling → Receipt.
- Market bets: Terms/World → Ruling → Receipt (no Scene check or Record).
- World is reachable from Terms ("World" chip) and from Huddle: Search · Event · Odds · Stake split (e.g. "$7.00 / $3.00" from the entered total) · counterparty chip (confirmed recent members) · Propose.
- Pay: Camera · Name · Amount · Send (voice fallback when face is not matched).

---

## 13. Providers, configuration, mocks

Every external dependency sits behind an interface with a deterministic mock, selected by env vars. **All default to `mock`/`off`**, so `npm test` and `npm run demo:e2e` run offline with no keys and no money.

**Spend guard**: every provider mode that can incur cost (`PERCEPTION_PROVIDER=nosana|http`, the real LLM providers `anthropic|openai|gemini|xai`, `elevenlabs` STT/TTS/SFX/Agent, `SP1_PROVER=network`, live Gemini hedge) refuses to start, throwing `SPEND_DISABLED`, unless `ALLOW_SPEND=1`. Tests and the demo script never set it. Public keyless reads (Gemini events REST/WS) and Solana devnet are free and allowed.

| Env | Values (default first) | Mock behaviour |
|---|---|---|
| `SOLANA_MODE` | `mock` \| `devnet` | In-memory chain implementing §9 with the engine's `chainModel`. Deterministic slot/hash (`sha256("mock-slot" ‖ u64 slot)`); mints unlimited mock USDC; verifies ed25519 user signatures and the §9.7 Ed25519 layout; Groth16 verified with snarkjs if `circuits/build` exists, else accepts |
| `CHAIN_EVENTS_SOURCE` | `mock` \| `quicknode` \| `rpc_ws` | §12.5 |
| `COMPILER_PROVIDER` / `ADVOCATE_PROVIDER` | `mock` \| `anthropic` \| `openai` \| `gemini` \| `xai` | See the mock compiler below. Advocates produce deterministic text |
| `JUDGE_PROVIDERS` | `mock,mock,mock` (comma list of 3; J0 must be video-capable) | Judges vote the pre-ruling if any (confidence 8000). AI-judged → side 0 with 7000, unless the transcript contains "no" |
| `AGENT_PROVIDER` | `mock` \| `elevenlabs` | Text-only; questions and read-back are spoken from TTS WAVs |
| `STT_PROVIDER` / `TTS_PROVIDER` / `SFX_PROVIDER` | `mock` \| `elevenlabs` | STT returns header `x-mock-transcript`, else the draft's last transcript, else the challenge phrase (accept). TTS/SFX return a bundled silent/beep WAV |
| `PERCEPTION_PROVIDER` | `mock` \| `nosana` \| `http` | `engine.simulate(program, calibration, MOCK_SCENARIO, seed)`; host B = host A with ±1 px jitter (except `cross_fail`) |
| `MOCK_SCENARIO` | `pass` \| `fail` \| `cross_fail` \| `motion` \| `low_conf` \| `no_identity` \| `oversize` \| `occlusion` | Drives `simulate` and the booth paths (reasons 10, 12, 13) |
| `DETECTOR_PROVIDER` | `mock` \| `http` | Returns each `calibration.scene.entity_refs` bbox if calibration exists, else a deterministic layout seeded by `sha256(bet ‖ entity)`, conf 90 |
| `IDENTITY_PROVIDER` | `mock` \| `http` | Embedding = deterministic unit vector from `sha256(user_id ‖ modality)` (seeded PRNG), perturbed by ≤ 5% noise derived from the input bytes. In mock huddle scans, each face crop resolves to the next not-yet-confirmed joined member |
| `GEMINI_PROVIDER` | `mock` \| `live` | Fixtures in `packages/backend/fixtures/gemini/*.json` (live = public REST/WS, free) |
| `PROVER` | `mock` \| `snarkjs` | snarkjs = real Groth16 in-process (free, offline, needs `circuits/build`) |
| `SP1_PROVER` | `off` \| `mock` \| `network` | `network` costs money. Not implemented in this build: any value is treated as `off` with a startup warning (errata [sp1-dropped]) |
| `ALLOW_SPEND` | unset \| `1` | Spend guard |
| `DATA_DIR` | `./.data` | §12.7 |
| `USDC_MINT` | unset (devnet: create a test mint) | |
| `QUICKNODE_SECRET`, `ELEVENLABS_TOOL_SECRET` | string | |
| `BIOMETRIC_KEY` | 32-byte hex | AES-256-GCM |
| `JUDGE_KEY_0..2`, `ORACLE_KEY`, `FEE_PAYER_KEY` | base58 secret keys | Generated into `.env` on first run if absent (`.env` is git-ignored). `ORACLE_KEY` defaults to `FEE_PAYER_KEY` |

**Mock compiler** (keyword templates; titles in quotes; questions ≤ 6 words):

| Trigger words | Template | Questions |
|---|---|---|
| "paper", "trash", "can", "bin" | Example 1, "Paper ball shot" | `{id:"line", text:"Where is the throw line?", kind:"region", entity:"line"}` (never blocks `ready`; becomes a required placement); "How many attempts?" (choice `["1","3","5"]`) if no number was given |
| "cup", "tower", "fan" | Example 2, "Cup tower" | — |
| "push-up", "pushup" | Example 3, "Push-ups" (number and seconds parsed from the text) | — |
| anything else | ai_judged, with the transcript as the question (title = its first 5 words) | — |

Every template asks "Stake each?" (`["$1","$5","$10"]`) if no amount was given, and "Who's in?" when participants are unresolved. The default limit is 120 s.

`engine.simulate` MUST support every `MOCK_SCENARIO` for the three worked examples and produce SessionTracks whose evaluation matches the scenario. Each scenario has a test vector.

---

## 14. Engine public API (`packages/engine/src/index.ts`)
```ts
// language
parseYaml(src, ctx): {ok:true, program, warnings} | {ok:false, errors}
canonicalize(p, ctx): Program;  validateProgram(p, ctx): {errors, warnings};  readback(p, rctx): string[]
toYaml(p): string                                        // canonical YAML (§2.9)
leafSignals(p, c, session): { leg: number; field: "valid_attempt" | "success"; path: string; label: string; signal: boolean[] }[]
conditionRows(p, labels): { leg; field; path; label }[]
compileMarket(quote, proposer, counterparty, nowMs): Program
// hashing & encoding
canonicalJson(v): string; sha256(bytes): Uint8Array; jsonHash(p); programHash(p); sceneHash(c); marketHash(eventId, contractId)
encodeProgram(p): Uint8Array; decodeProgram(bin): DecodedProgram
encodeCalibration(c, p): Uint8Array; decodeCalibration(bin, decodedProgram): DecodedCalibration; calibrationHash(c, p)
encodeTrackBin(t: TrackBufferData): Uint8Array; decodeTrackBin(bin, decodedProgram): TrackBufferData
encodeMarketBin(entries); decodeMarketBin(bin); buildPayload(programBin, calibrationBin, trackBin?): Uint8Array
acceptSigMessage(programHash, wav): Uint8Array; acceptanceAudioHash(h: Uint8Array[]): Uint8Array; termsHash(oracle, judges, aah)
modelHash(spec); perceptionRoot(session); bioHash(bio); crc16CcittFalse(bytes)
// evaluation
evaluate(programBin, calibrationBin, trackBin, verified, opts?): EvalResult
evaluateProgram(p, c, buffer: TrackBufferData, verified): EvalResult     // = encode + evaluate
evaluateSession(p, c, session: SessionTracks, verified): EvalResult      // single full segment, maxCost ∞
evalCost(decodedProgram, nFrames): number
extractDecisiveWindows(p, c, session, verified): TrackBufferData | null
quantizeSession(raw: RawDetection[], meta: QuantizeMeta): SessionTracks
bindPersons(session, personTracks: PersonTrack[], timeline: FusedTimeline, p): SessionTracks
crossCheck(a, b, p, c): CrossCheckResult
simulate(p, c, scenario: MockScenario, seed: number): { a: SessionTracks; b: SessionTracks; raw?: RawDetection[] }
// evidence
chainGenesis(...), chunkHash(...), chunkSigMessage(c), merkleRoot(leaves), merkleProof(leaves, i), verifyMerkleProof(...), evidenceLeaf(...), evidenceRoot(heads)
encodeBeaconPayload(slot, hash): Uint8Array; beaconSymbols(payload): number[]; synthBeacon(symbols, sampleRate): Int16Array; decodeBeacon(pcm, sampleRate): {slot, hashPrefix, t0Sample} | null
// identity
quantizeEmbedding(f32): Int8Array; cosineBps(e, o); closedSetMatch(o, candidates, modality); circuitMatch(e, o, tau)
packEmbedding(q): bigint[7]; poseidonCommit(q, salt): bigint; fuseTimeline(tracks, observations, reid, nCandidates, nParticipants, nFrames): FusedTimeline
proverInput(timeline, observations, checkpoint): IdObservation | null
biometricPublicInputs(...): Uint8Array[]; encodeGroth16Proof(proof)
// chain model, borsh, events
chainModel: { initialBet(args), apply(bet, ix: {name, args, signers, accounts}, ctx: {now_s, slot, slot_hashes}): {bet, events, transfers} | {error: ErrorCode} }
encodeBetAccount(b); decodeBetAccount(bytes); decodeProfile(bytes); encodeInstruction(name, args): Uint8Array; encodeEvent(name, data); decodeEvent(bytes)
ed25519PanelIxData(pk0, sig0, pk1, sig1, M): Uint8Array
// booth, world, settlement
judgeCommit(...); panelMessage(programId, bet, outcome, evidenceRoot, programHash); panelQuorum(reveals)
stakeSplit(total, p_bps); parlayProb(ps); payouts(bet, winnerMask, bondUpheld)
CONSTANTS
```
Types referenced above that are not defined elsewhere:
```ts
interface TrackBufferData {
  flags: number; model_hash: string;
  tracks: { entity_idx: number; participant_idx: number | null; ref_h: number }[];
  segments: { frame_start: number; frames: (QFrame | null)[][] /* [frame][track] */ }[];
}
interface DecodedProgram { kind; P; json_hash; time_limit_s; participants; stakes; side_b_mask; entities: {kind; param}[];
  legs: { id; flags; rule_kind; rule_cmp; rule_k; rule_n; attempt_window; va: Uint8Array; succ: Uint8Array }[];
  if_true; else_side; cond: Uint8Array; tracked_entities: number[] }
interface DecodedCalibration { scene_hash; regions: { entity_idx; shape; points: [number, number][]; behind_sign }[] }
type MockScenario = "pass" | "fail" | "cross_fail" | "motion" | "low_conf" | "no_identity" | "oversize" | "occlusion";
type ErrorCode = /* §9.6 names */ string;
```
Allowed dependencies (pure): `@noble/hashes`, `@noble/curves`, `yaml`, `poseidon-lite`, `bs58`. No `fs`, network, clocks or randomness inside the engine (callers pass seeds and time).

---

## 15. Worked examples

`<creator_pk>` / `<friend_pk>` stand for real base58 keys (compile context: creator = `<creator_pk>`, huddle = `[<creator_pk>, <friend_pk>]`, both enrolled and confirmed). The AST JSON below is pretty-printed for reading; hashing uses canonical JSON (§4.1: sorted keys, no whitespace).

### 15.1 Paper-ball shot (actor-bound)
"I bet my friend can't get a paper ball in the trash can from behind that line. Three tries."
```yaml
version: 2
entities:
  shooter: person(p1)
  ball:    object("crumpled paper ball")
  can:     object("trash can")
  line:    region(tap)
legs:
  - id: 1
    actor_bound: true
    valid_attempt: ball released_by shooter while shooter behind line
    success: ball disappears_into can.opening
             or (ball inside can and ball at_rest 1s)
    rule: count(success) >= 1 within attempts 3
outcome: side(shooter) wins iff leg 1 true; else side(creator)
stake_each: 5_000_000
time_limit_s: 180
```
```json
{
  "version": 2,
  "kind": "rules",
  "participants": ["<creator_pk>", "<friend_pk>"],
  "sides": [0, 1],
  "entities": [
    { "name": "shooter", "kind": "person", "participant": 1 },
    { "name": "ball", "kind": "object", "phrase": "crumpled paper ball" },
    { "name": "can", "kind": "object", "phrase": "trash can" },
    { "name": "line", "kind": "region", "shape": "line" }
  ],
  "legs": [
    {
      "id": 1,
      "actor_bound": true,
      "attempt_window_frames": 50,
      "valid_attempt": { "op": "and", "args": [
        { "op": "released_by", "a": { "e": "ball" }, "b": { "e": "shooter" } },
        { "op": "behind", "a": { "e": "shooter" }, "b": { "e": "line" } } ] },
      "success": { "op": "or", "args": [
        { "op": "disappears_into", "a": { "e": "ball" }, "b": { "e": "can", "sub": "opening" } },
        { "op": "and", "args": [
          { "op": "inside", "a": { "e": "ball" }, "b": { "e": "can" } },
          { "op": "at_rest", "a": { "e": "ball" }, "frames": 10 } ] } ] },
      "rule": { "kind": "count", "cmp": ">=", "k": 1, "attempts": 3 }
    }
  ],
  "outcome": { "if_true": 1, "condition": { "op": "leg", "id": 1 }, "else": 0 },
  "stake_each": 5000000,
  "time_limit_s": 180
}
```
Notes:
- `line` resolves to shape `line` (used by `behind`). Participants default to creator + the shooter's member. Entity indices: shooter 0, ball 1, can 2, line 3 → the track table has 3 tracks (0, 1, 2).
- Encoded valid_attempt (15 bytes) = `01 35 01 00 00 00 00 00 15 00 03 00 00 00 00` = and(released_by(a=ball 1, b=shooter 0, p=0), behind(a=shooter 0, b=line 3, p=0)). The `can.opening` ref byte is `0x12`.
- Weight Σw = valid_attempt (1 + 4 + 2) + success (1 + 12 + 1 + 4 + 2) = 27, so `cost = (|F| + 4) × 27` and up to 299 buffer frames fit `MAX_EVAL_COST`.
- Static checkpoint bound = `min(1, 3) × 1 = 1`.
- Example calibration:
```json
{ "version": 1,
  "scene": { "camera": { "width_px": 1920, "height_px": 1080, "orientation": "landscape" },
             "entity_refs": [ { "entity": "ball", "label": "Paper ball", "bbox": [1200, 7000, 1500, 7500] },
                              { "entity": "can", "label": "Trash can", "bbox": [7600, 6200, 8800, 9400] },
                              { "entity": "shooter", "label": "Maya", "bbox": [500, 1500, 2500, 9800] } ] },
  "regions": [ { "entity": "line", "shape": "line", "points": [[3000, 6000], [3000, 10000]], "behind_sign": 1 } ] }
```
(`side(L, (1000, 9000)) = sign(0·3000 − 4000·(−2000)) = +1`, so standing at x < 3000 is "behind".)
- Identity: when the leg is raw True, there is one checkpoint `(1, a_i)` at the first counted attempt (k' = 1). The backend proves it with the face (or voice) circuit before `run_rules`. Pass result: `leg_results [1]`, winner side 1, `winner_mask = 0b10 = 2`.

### 15.2 Cup tower survives the fan for 10 s (not actor-bound)
"I bet the cup tower survives the fan for ten seconds."
```yaml
version: 2
entities:
  tower: object("cup tower")
  fan:   object("fan")
legs:
  - id: 1
    actor_bound: false
    success: tower intact
    rule: holds(success) for 10s
outcome: side(creator) wins iff leg 1 true; else side(other)
stake_each: 2_000_000
time_limit_s: 30
```
```json
{
  "version": 2,
  "kind": "rules",
  "participants": ["<creator_pk>", "<friend_pk>"],
  "sides": [0, 1],
  "entities": [
    { "name": "tower", "kind": "object", "phrase": "cup tower" },
    { "name": "fan", "kind": "object", "phrase": "fan" }
  ],
  "legs": [
    { "id": 1, "actor_bound": false, "attempt_window_frames": 50,
      "success": { "op": "intact", "a": { "e": "tower" } },
      "rule": { "kind": "holds", "frames": 100 } }
  ],
  "outcome": { "if_true": 0, "condition": { "op": "leg", "id": 1 }, "else": 1 },
  "stake_each": 2000000,
  "time_limit_s": 30
}
```
Notes:
- There is no identity pipeline (no `person` entities). Participants default to the 2-member huddle.
- `fan` is unused in conditions (warning `UNUSED_ENTITY`). It gets no track in track_bin, but stays in SessionTracks and the exhibits.
- Window: frames `[0, 105)`, 1 track → 105·12 = 1,260 B of records. `calibration.regions = []`.
- If the recording ends before frame 100, the leg is Unknown (COVERAGE) → panel. If the tower is absent (occluded) at the first failing frame → Unknown (OCCLUSION) → panel. If it is present but short → False.
- Pass: `winner_mask = 1`.

### 15.3 Push-ups (rep_count, actor-bound)
"I bet I can do 20 push-ups in a minute."
```yaml
version: 2
entities:
  me: person(p0)
legs:
  - id: 1
    actor_bound: true
    success: rep_count(me) >= 20
    rule: success before 60s
outcome: side(me) wins iff leg 1 true; else side(other)
stake_each: 10_000_000
time_limit_s: 90
```
```json
{
  "version": 2,
  "kind": "rules",
  "participants": ["<creator_pk>", "<friend_pk>"],
  "sides": [0, 1],
  "entities": [ { "name": "me", "kind": "person", "participant": 0 } ],
  "legs": [
    { "id": 1, "actor_bound": true, "attempt_window_frames": 50,
      "success": { "op": "rep_count", "a": { "e": "me" }, "cmp": ">=", "value": 20 },
      "rule": { "kind": "before", "frames": 600 } }
  ],
  "outcome": { "if_true": 0, "condition": { "op": "leg", "id": 1 }, "else": 1 },
  "stake_each": 10000000,
  "time_limit_s": 90
}
```
Notes:
- Participants: creator + persons = [creator] only (< 2), and the huddle has exactly 2 → both.
- `rep_count` needs full coverage from frame 0 to the decisive frame (≤ 600 frames · 1 track · 12 B = 7,200 B, within the 10 KB cap; cost (600 + 4) × 2 = 1,208).
- `success` is true at f only while `me` is present and has ≥ 20 reps. Checkpoint: `(0, first such frame)`. If he fails, the leg is raw False and there is no checkpoint.
- Pass: `winner_mask = 1`.

### 15.4 AI-judged (for completeness)
```yaml
version: 2
kind: ai_judged
question: "Does Sam finish the hot sauce wing without drinking anything?"
outcome: side(B) wins iff yes; else side(A)
stake_each: 3_000_000
time_limit_s: 120
```
AST: `{"version":2,"kind":"ai_judged","participants":[…2],"sides":[0,1],"entities":[],"legs":[],"question":"…","outcome":{"if_true":1,"condition":{"op":"yes"},"else":0},"stake_each":3000000,"time_limit_s":120}`. Encoded with `L = 0` and condition `0x51`. A camera witness is still required (footage for the booth).

---

## 16. Decision log and spec deviations

Every deviation from the spec is listed with the spec section it overrides.

| # | Decision | Spec section |
|---|---|---|
| D-1 | `region(tap)` shape is inferred from usage (line if used with behind/beyond/crosses, else zone); explicit `region(line\|zone)` is also accepted. | §5.1 |
| D-2 | Openings are **derived** from object boxes (`.opening`/`.interior`, stale up to 3 s), never tapped. | §5.1 `region(tap)` "openings" (deviation) |
| D-3 | Two sides only; the creator is always side 0; `sides:` is mandatory with > 2 participants (the compiler asks). | §3.3 |
| D-4 | `_` digit separators are accepted in integer fields. | §5.1 example |
| D-5 | Track records are 12 bytes. The TrackBuffer payload is capped at 10,000 B and written in ≤ 700 B chunks over legacy-size transactions; v1 4 KB transactions are not assumed. Larger runs → panel or SP1. | §5.7 "fits a single v1 transaction" (deviation) |
| D-6 | Evidence continuity is cryptographic (hash chains). Onchain monotonic head checks set advisory `gap_mask` bits and do not change the outcome. | §5.4 "the onchain program checks chunk indices" (deviation) |
| D-7 | The beacon "blockhash" is the SlotHashes bank hash for a recent slot; the audio carries slot + 8-byte hash prefix + CRC in 2.1 s of 16-FSK. | §3.6.2 |
| D-8 | The ElevenLabs Sound Effects start sound is the audible cue; the data tones are synthesized locally and played right after it. t0 = end of the tones. | §3.6.2, §5.11 (deviation: the sound itself doesn't encode the hash) |
| D-9 | The SP1 path is specified but compiled out by default (`sp1` feature, `SP1_PROVER=off`); onchain decisive-window execution is the shipping path (spec fallback (a)). This build ships no SP1 guest/host and never routes to SP1; oversized runs always go to the panel (errata [sp1-dropped]). | §5.8.2 |
| D-10 | Embedded wallet = device-generated ed25519 key in secure storage behind the platform passkey/biometric prompt; sign-in providers are mocked offline. | §3.1.1, §6.1 |
| D-11 | `program_hash = sha256(program_bin)`; program_bin embeds the canonical-JSON `json_hash`. | §3.3.6 |
| D-12 | Calibration is committed by funding: the first `fund` sets `calibration_hash`, and every later funder must pass the same value. | §3.4.5 |
| D-13 | Unknown (low confidence), AI-judged, cross-check failures and the cost cap go to **Disputed** without a bond; the panel's No contest refunds everyone. | §3.7.5, §5.6 |
| D-14 | Oracle and judges are named per bet in `create_bet`; the oracle co-signs (see D-37); there is no global config account. | §5.7 (instruction list fixed at 15) |
| D-15 | Identity proofs cover the threshold only (cosine ≥ τ); the closed-set margin δ is enforced offchain. Face vectors are zero-padded to 192. | §5.8.1 |
| D-16 | World Mode bets are `market` programs settled through TrackBuffer/run_rules/consent, with the oracle posting Gemini resolutions. | §5.11 |
| D-17 | Dispute bond = max(20% of the smallest stake, $0.10); an upheld bond goes to the winners' pot. | §5.6 |
| D-18 | Perception cross-check: IoU ≥ 0.5 on ≥ 90% of frames per entity, and event timing within ±3 frames; the sealed tracks are host A's. | §5.5 |
| D-19 | Audio-witness agreement is advisory (flag + exhibit). | §5.4 "must agree" (deviation) |
| D-20 | Chunk `start_ms` is device-local; the backend decodes the beacon per witness to align devices. | §3.6 |
| D-21 | When decisive windows can't reproduce the full-session result within the caps, the oracle posts flags bit3 → Disputed, reason 13 (or SP1 when enabled). | §5.2 |
| D-22 | Proximity = the 6-digit room code + face confirmation in the creator's scan. BLE/geo are not implemented. | §3.3.1 "proximity" (deviation) |
| D-23 | Perception runs on the primary camera only; extra cameras are exhibits; there is no multi-angle fusion. | §2.4, §5.2 "second angle" (deviation) |
| D-24 | RULE settle path = consent/silence over a pre-ruling produced by `verify_sp1_run`. A `bad_tracking` dispute triggers an offchain re-run on fresh hosts, given to the panel as an exhibit. There is no onchain re-run instruction. | §5.6 "resolved by re-run" (deviation) |
| D-25 | The biometric proof binds an oracle-held embedding to the onchain commitment; binding that embedding to the footage is trusted and labeled so. | §5.8.1 "identity-timeline embedding … matches it" (partial) |
| D-26 | Camera pose = resolution + orientation + optional IMU pitch/roll, with a drift warning; no extrinsic calibration. | §3.4.5 |
| D-27 | Acceptance happens on the draft, before `create_bet`: spoken "I accept" + 2 challenge words, voice match, and a device signature (`accept_sig`). Funds move at `fund` (the second tap). | §3.3.5–6 (ordering) |
| D-28 | Scene check streams frames at 10 fps to the backend detector (mock or http), not YOLO-World on device. | §5.2 |
| D-29 | Notifications = WS + local notifications; no FCM/APNs. | §5.11 QuickNode "push notifications" (deviation) |
| D-30 | Phones as perception nodes are optional and advisory (flags bit4, exhibit). | §5.5 (deviation) |
| D-31 | Huddle = joined members; a face scan confirms them; only confirmed members can be participants. Huddle ≤ 10, bet ≤ 8. | §3.3.2, §5.3 |
| D-32 | Market bets: no voice acceptance; counterparty `fund` = acceptance; `acceptance_audio_hash = 0`. | §3.3.5 |
| D-33 | One wallet per user; wallet recovery is out of scope (`WALLET_MISMATCH`). | §3.1.1 |
| D-34 | Devnet uses a backend-created test mint by default (the Circle faucet can't be scripted); `USDC_MINT` overrides. | §5.7 "Circle faucet" (deviation) |
| D-35 | Out of scope (roadmap only): zkTLS, TEEs, independent judge operators, the attestation fallback (§5.8 ladder (c)), live Gemini hedge (mock only unless `ALLOW_SPEND`), Grok (the `xai` provider exists, off by default, pending the sponsor). | §5.8, §5.9, §5.11 |
| D-36 | `run_rules` and evidence heads at `end` are oracle-gated, to stop front-running and root poisoning. Liveness is guaranteed by refund timeouts. | §5.7 |
| D-37 | The oracle co-signs `create_bet`; every `fund` commits to `program_hash` and `terms_hash` (oracle, judges, acceptance hash). | §5.7, §5.9 |
| D-38 | The time limit counts from t0. Frames up to `LIMIT + TAIL_FRAMES` are kept for look-ahead only; recording continues 2 s after End. | §3.6.4 |
| D-39 | `holds` failing on an absent entity is Unknown (`OCCLUSION`) → panel, not False. | §5.2 known hard cases |
| D-40 | Identity checkpoints are generated only for actor-bound legs that are raw True, at the minimal anchor set. Negative actor-bound rules are compiled into positive form. There is a static checkpoint bound. | §5.3 "decisive moments" |
| D-41 | Sign-in screen shows Google + email; passkey is used only for wallet unlock. | §3.1.1 vs §6.5 |
| D-42 | The onchain interpreter is heap-free with a cost cap (`MAX_EVAL_COST`); programs above the cap go to the panel. | §5.7 "thousands of compute units" |
| D-43 | track_bin carries tracks only for entities referenced by leg expressions; unused entities stay offchain (exhibits, perception root). | §5.1 |
| D-44 | Object binding is sticky with hand-off and rebind delay (multi-object scenes). | §5.2 |
| D-45 | Scene-check/practice persons bind to the largest person track (no identity). | §3.4.4 |
| D-46 | The spec's 2–5 fps face verification becomes face sampling every 3rd frame at 10 fps (≈3.3 fps). | §5.3 |
| D-47 | Onchain compute budget (§3.13): `MAX_EVAL_COST` 16384 → 8192; `cost = (\|F\| + EVAL_COST_SETUP_FRAMES) × Σw` with `EVAL_COST_SETUP_FRAMES = 4`; `overlaps`/`inside` weigh 4 and `enters`/`leaves`/`touches` 6 (polygon tests). With the interpreter optimizations (overflow checks off for `verdict-rules` only, squared-speed thresholds, prepared polygons, word-level signal ops), every buffer accepted under the cap runs `run_rules` in ≤ 1.08M CU (bound) — the old cap needed 3–11M CU. Programs above the cap still go to the panel (reason 13) or SP1. | §5.7 "thousands of compute units", D-42 |

---

## 17. Repository, toolchain and deliverables

- **Layout**: npm workspaces (`packages/engine`, `packages/backend`) at the repo root; `crates/verdict-rules`, `programs/verdict` and `sp1/` (feature-gated; not built in this build, errata [sp1-dropped]) in one Cargo workspace; `circuits/`; `app/`; `services/perception`, `services/embedder` (Python, optional, not built by default); `infra/quicknode/{stream.json,filter.js}`; `testvectors/`; `scripts/`.
- **Toolchain**: Node ≥ 20; Rust stable + Anchor 0.32.1 + the Agave 2.x CLI pinned in `Anchor.toml`; circom 2.1.x + snarkjs; Flutter stable ≥ 3.24.
- **Commands that MUST pass** (offline, no keys, no money):
  - `npm test` (engine + backend, including the vector generator check `npm run vectors -- --check`);
  - `npm run demo:e2e` (a scripted full flow against all mocks: two simulated users, the paper-ball bet through consent settlement; a dispute → panel; ai_judged; a market bet);
  - `anchor build && cargo test` (LiteSVM, `mock-zk`, vectors + fuzz);
  - `flutter analyze && flutter test`, run when the Flutter SDK is available.
- **Committed artifacts**:
  - `.env.example`;
  - `packages/backend/idl/verdict.json`;
  - `programs/verdict/src/zk/vk.rs` and `circuits/build/verification_key.json` (fixed dev beacon; the zkey is not committed; `circuits/scripts/setup.sh` regenerates it);
  - `infra/quicknode/stream.json`;
  - the README sections: setup, architecture, program ID, "How we use Solana", ElevenLabs usage (including the ECAPA-vs-Scribe precision statement), QuickNode config + why, trusted-setup statement, honest ZK framing (D-25), Trusted replay booth, a Grok section placeholder, and the legal/consent note.
- **Never**: commit keypairs or `.env`, push to a remote, or set `ALLOW_SPEND` in scripts or CI.
