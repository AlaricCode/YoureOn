# Dance Off — design contract (v1)

Status: build contract for branch `feat/dance-off`. This file is the single source of truth that the shared,
server, mobile-native, mobile-app, stage and tools work all code against. If code and this file disagree, fix
one of them in the same change.

## 0. What it is

A new bet type. Two players dance side by side, at the same time, to a reference routine in front of one
judge-cam phone. Each routine has its own length, 5 to 40 s (`RoutineData.duration_ms`): the bundled ones are
15 s and 32.6 s. Each is scored on-device (Apple Vision body pose → deterministic pure-TS scorer) on how closely
they match the reference. Higher score wins the escrow. Claude never picks the winner: it only validates the
round (danced the whole time, nobody left, no third person, no side swap) and writes a 1–2 sentence announcer
line. Settlement, GG, the 10 s window and payout are the existing paths, unchanged.

Reality notes (the brief vs. this repo):
- There is no "long shot" bet type. The existing bet types are `Terms.type` `skill` (one performer, Claude judges
  12 still frames: bottle flip, paper-ball throw, …) and `real_world` (Gemini BTC market). In this doc,
  "long shot" = a typed `skill` bet such as the paper-ball throw.
- There is no double-or-nothing or rematch today. This feature adds it (§7) for every bet type.
- GG is the loser's swipe + Face ID concede, not speech. "10 s silence" is the onchain appeal window, after which
  the server auto-finalizes. Both are reused unchanged.
- There is no second-screen (UIScreen) support. The HDMI display shows the phone's screen through iOS mirroring,
  so the dance screen is designed as the display layout (§6.3).
- The announcer speaks via the existing ElevenLabs paths. Ruling.reason is spoken on the stage as
  "<Winner> wins. <reason>", and the phone voice judge paraphrases it.

## 1. Terms (hashed)

`TermsV1.type` is widened in place to `['skill', 'real_world', 'dance_off']`, following the SCHEMAS §11
widened-refinement precedent. Every existing record still parses and hashes identically. The refinement becomes
a three-way branch. For `dance_off`:
- `evidence_source = 'camera'` (no pg enum migration), `market = null`, `performer = null` (both perform)
- `yes_party = 'A'`. The claim reads as "A out-dances B": claim_result MET ⇔ A wins
- `attempts = {count: 1, rule: 'single'}`
- `stakes.a === stakes.b` (even money, no odds)
- `edge_cases = []` is allowed

The routine is hashed through the text fields. No new keys:
- `claim`: `Dance Off: <routine title>, <N> seconds, higher match score wins, $X each` (A = challenger), where
  N = `Math.round(routine.duration_ms / 1000)` (`routineSeconds`). A 15 s routine reads "15 seconds" exactly as
  before, so its Terms text and terms hash are unchanged; the 32.6 s `bye-bye-shuffle` reads "33 seconds".
- `success_criteria[0]`: `Routine <routine_id> v<version> sha256:<first 16 hex of routine sha256>`
- `success_criteria[1]`: `Higher match score wins; scores within <TIE_MARGIN> points are too close to call (refund)`
- `failure_criteria`: `[]`

`parseDanceTermsRoutine(terms)` (shared) extracts `{routine_id, version, sha16}` from `success_criteria[0]` and
verifies it against the bundled registry. Producer: `danceTermsArgs({routine_id, amount_usd})` →
`ProposeTermsProjection` → `evaluateProposeTerms` → `persistEvaluation`. This is the same pipeline as the
typed and market terms. The voice agent does NOT propose dance offs in v1, because that needs an ElevenLabs
agent re-sync.

## 2. Pose data (shared, `packages/shared/src/dance/`)

Joint order is fixed, with 19 Apple Vision joints at indices 0..18:
`nose, leftEye, rightEye, leftEar, rightEar, neck, leftShoulder, rightShoulder, leftElbow, rightElbow, leftWrist,
rightWrist, root, leftHip, rightHip, leftKnee, rightKnee, leftAnkle, rightAnkle`.

**Raw person** (native → JS): `k: number[57]` = `[x, y, c] × 19`. x and y are in [0,1] in the UPRIGHT,
UNMIRRORED image, with a top-left origin and y pointing down. c is in [0,1]. A missing joint has c = 0.

**Quantized** (hashed and uploaded): every value is an int. x and y are in 0..10000, c is in 0..1000.
`quantizePerson`/`dequantizePerson` live in shared. All scoring runs on DEQUANTIZED values, so the phone and
the server score bit-identical inputs. No floats are ever hashed, except a routine's `bpm` (whole or one
decimal, e.g. bye-bye-shuffle's 172.6; JCS prints it with ECMAScript's shortest round trip, and
`ROUTINE_SHA256_PINS` checks the routine shas on V8 in tests and on Hermes in the calibration self-test).

```ts
PoseSeries = strict {
  schema_version: 1,
  w: int, h: int,                 // upright image size, for aspect-correct vectors
  fps_cap: int,                   // ≤ 30
  sync_offset_ms: int,            // −500..500, already-applied A/V offset (see §4.4)
  frames: { t: int /*ms since round t0, −3000..45000*/, n: int /*people seen*/, a: int[57] | null, b: int[57] | null }[]  // ≤ 1500
  // POSE_MAX_FRAMES 1500 / POSE_T_MAX_MS 45000: a 40 s round + the count-in + the tail at the 30 fps cap
}
pose_sha256 = hashJcs(PoseSeries)
```

**Routine** (`packages/shared/src/dance/routines/<id>.ts`, generated):
```ts
RoutineData = { schema_version: 1, id, version: int, title, song, bpm,
  duration_ms: int,                      // 5000..40000 (ROUTINE_MIN/MAX_DURATION_MS), per routine
  first_beat_ms,                         // ≤ duration_ms
  count_in_beats: 3, w, h, mirrored_source: false, source: 'synthetic' | 'vision',
  frames: { t: int, k: int[57] }[],      // quantized, ~15–30 fps, ≤ 1500, every t ≤ duration_ms
  key_moves: { id: string, t: int, name: string }[],   // 8–16, beat-aligned, every t ≤ duration_ms
  media: { video: string | null, audio: string | null } }
routineSha256(r) = hashJcs(r)   // cached
ROUTINES: readonly RoutineData[]  // exactly 3, the first is the default card; getRoutine(id)
```
The bundled routines, in card order:
- `bye-bye-shuffle` (32.6 s, 172.6 bpm, `source: 'vision'`): a real take extracted with the macOS tool (§8).
  Its reference is a silhouette clip (`media.video = 'bye-bye-shuffle.mp4'`, `media.audio = null`: the music
  is muxed in): a neon SAM 3.1 mask of the dancer on a dark `#0b0614` background, 720x808, 23.976 fps,
  32.6 s, with an ORIGINAL synthesized drum track (first beat at 235 ms). The source footage is never
  bundled. A local demo build may carry the original song instead: Metro (`apps/mobile/metro.config.js`)
  bundles `apps/mobile/assets/dance/local/<name>` in place of `apps/mobile/assets/dance/<name>` when it
  exists; that folder is gitignored and in `.easignore`, so only the drum version is ever committed or
  uploaded. The routine (and its sha256) is the same either way.
- `wave-pop`, `bounce-back` (15 s each): SYNTHETIC placeholders, generated procedurally by
  `scripts/dance-routine.ts synth`. Their bytes, sha256s and scores are unchanged by the per-routine length.

The phone renders the reference as a mirrored animated skeleton when `media.video` is null, and plays the
mirrored clip (with its sound) otherwise.
Everything timed on the round comes from the routine's `duration_ms`: the scorer's window and coverage bins
(§4), the phone's round length, stop time, key-frame snapshot schedule, progress bar, beat counter and clock
(§6), the stage's "N seconds" line, and the attempt's `max_ms` (`DANCE_MAX_MS` 50 s fits the longest).

## 3. Identity tracking + framing (shared, `dance/track.ts`)

- `framingCheck(people, w, h)` → `{ok, reason: 'ok'|'need_two'|'too_many'|'feet'|'head'|'same_side'|'too_close', a?: idx, b?: idx}`.
  It passes only when there are exactly 2 people, each full body (nose or neck, both ankles, both hips with
  c ≥ FRAMING_CONF), one hip-center left of image center and the other right of it, with a gap between them.
- `createTracker()`. Players are assigned at round start by hip-center x: **A = left in the image** (the
  challenger stands on the left of the display). From then on, each person is matched to the nearest previous
  hip-center (greedy NN with a max jump). Extra people are counted (`n`) and never become A or B.
  The tracker also counts side swaps (A's hip x > B's hip x for ≥ SWAP_MIN_MS) and frames with n > 2.

## 4. Scorer (shared, `dance/score.ts`, scorer_version `dance-score@1`)

Everything here is pure and deterministic. It uses only + − × ÷ and `Math.sqrt`, plus `Math.pow` in the display
curve. All weights and thresholds sit in one exported `DANCE_SCORING` constants object.

4.1 **Normalization.** Coordinates are scaled to aspect-correct space (x·w/h). The hip center is the mid hips
(or root), and the scale is the torso length |mid-shoulders − mid-hips|. A joint below `MIN_CONF` (0.3) is
skipped.

4.2 **Mirroring.** The reference is SHOWN flipped horizontally, so a player who copies the screen like a mirror
raises the same anatomical arm as the reference. In the unmirrored back-camera image that player's joints
already line up with the reference's raw joints. In that camera geometry, the brief's "compare with left/right
swapped" is the comparison you need when the player feed is itself mirrored, as with the front camera. The
scorer canonicalizes both cases: `canonical(person, mirrored)` flips x and swaps L/R labels when mirrored.
Players don't all copy the same way, so the round is scored under BOTH conventions per player (`identity` and
`mirror`, the latter being flip x + swap L/R), and each player keeps the better total. The chosen convention is
reported in the breakdown. The reference scored against itself gets 100 under `identity`.

4.3 **Limb similarity.** There are 9 limbs: L/R upper arm (shoulder→elbow), L/R forearm (elbow→wrist), L/R
thigh (hip→knee), L/R shin (knee→ankle) and the torso (mid-hips→neck). Each limb is a unit direction vector,
and the comparison is the cosine with the reference limb. The per-limb score is
`clamp((cos − COS_FLOOR)/(1 − COS_FLOOR), 0, 1)`. The weights are arms 1.5, legs 1.0, torso 0.8, and the
result is the weighted mean over limbs present in both poses. A frame whose present weight is below
`MIN_LIMB_WEIGHT_FRAC` scores as "no pose".

4.4 **Reaction lag.** The player frame at time t (after subtracting `sync_offset_ms`) is compared with the
reference frames in [t − 500 ms, t + 200 ms], and the best match wins: `sim × (1 − LAG_PENALTY · max(0, |lag| − LAG_GRACE_MS)/500)`.
The lag of the best match is reported.

4.5 **Movement term.** The per-limb angular speed is |Δunit-vector| over `SPEED_DT_MS`. Movement overlap for
the round is `Σ min(v_p, v_r) / Σ max(v_p, v_r)` over limbs and frames, comparing each player frame with the
best-lag reference frame. A player standing still therefore scores ≈ 0 even through the reference's neutral
poses. The overlap multiplies the continuous score, and it gates key moves: a key move counts only when the
player's motion energy in the preceding `KEY_MOTION_WINDOW_MS` is at least `KEY_MOTION_MIN` × the reference's.

4.6 **Two layers.**
- Live meter (display only): an EMA (`LIVE_EMA_ALPHA`) of the per-frame best-lag similarity × a short-window
  movement overlap.
- Key moves: for each key move at time t, take the best sim of the player frames in [t − 200, t + 500] against
  the reference pose at t. ≥ `PERFECT_AT` is PERFECT (100 pts), ≥ `GOOD_AT` is GOOD (60 pts), anything lower,
  or a failed motion gate, is a MISS (0).
- Raw score: `KEY_WEIGHT · keyPoints/100 + CONT_WEIGHT · continuous`, with the defaults 0.7 / 0.3.

4.7 **Display mapping.** `display = 100 · clamp((raw − RAW_FLOOR)/(RAW_CEIL − RAW_FLOOR), 0, 1)^CURVE_GAMMA`, rounded
to 0.1 and stored as int tenths (0..1000). Self-score is exactly 1000. A player standing still lands near 0, and
decent amateurs land at 60–90.

4.8 **Result.** `scoreRound(routine, series)` returns `{a: {score_x10, raw, key_moves[], continuous,
movement, convention, coverage_pct, mean_lag_ms, limbs: per-limb mean}, b: {...}, winner: 'A'|'B'|null, too_close,
failed: null | 'coverage_a' | 'coverage_b' | 'no_frames'}`. `too_close` is true when
|a − b| < `TIE_MARGIN_X10` (default 20 = 2.0 pts). `failed` is set when a player's coverage is below
`MIN_COVERAGE`. Any `failed` result is treated as too close to call.

## 5. Evidence + ruling

```ts
DanceEvidence = strict {           // packages/shared/src/evidence.ts; evidence_hash = hashJcs(DanceEvidence)
  schema_version: 1, kind: 'dance', bet_id, attempt_no, terms_hash,
  routine: { id, version, sha256 }, scorer_version: 'dance-score@1',
  pose_sha256, pose_frames: int, sync_offset_ms: int,
  scores: { a: int, b: int },       // tenths, SERVER-recomputed from PoseSeries
  winner: 'A' | 'B' | null, too_close: boolean, failed: string | null,
  key_moves: { id, a: 'PERFECT'|'GOOD'|'MISS', b: 'PERFECT'|'GOOD'|'MISS' }[],
  checks: { coverage_a_pct, coverage_b_pct, max_people, side_swaps },
  frames: EvidenceFrame[] (1..6, the key frames uploaded), clip_sha256: Hex32 | null }
```

- Upload: `POST /v1/bets/:bet_id/attempts/:n/dance` (multipart, signed). The parts are `upload` (JSON
  `DanceUpload = {routine_id, routine_sha256, series: PoseSeries, pose_sha256, client_scores:{a,b}, clip_sha256,
  frames: [{index, t_ms, sha256, width, height, bytes}]}`) and `frame` × 4 JPEGs (≤ 200 KB each). The body cap
  (`DANCE_BODY_LIMIT`) is 4 MiB: a 40 s round at 30 fps is ~1300 frames, ≤ ~1.1 MB of JSON. The server
  verifies the frame hashes and pose_sha256, recomputes the scores with the shared scorer (against the bundled
  routine, so the round window is that routine's `duration_ms`), builds
  DanceEvidence, and stores `attempts.evidence_canonical = jcs(DanceEvidence)`. The bet moves to JUDGING.
- Validation job (Claude, `apps/server/src/judge/dance.ts`) gets the terms, both scores, the per-move breakdown,
  the deterministic checks and the 4 frames. It returns `{verdict: 'valid'|'invalid', danced_full_time,
  nobody_left, no_third_person, no_side_swap, notes, announcer_line}`. `valid` comes first, so the mock LLM's
  default is the happy path. If the LLM fails or times out, the round settles on the score with a canned line,
  and the validation is recorded as skipped.
- Ruling (strict `Ruling`, unchanged shape): stage `'attempt'`, model `rule/dance-off@1`, confidence 1.00,
  `frame_hashes` = the key frames, `evidence_hash = hashJcs(DanceEvidence)`, `reason` = the cleaned announcer line.
  - A winner gives a decisive ruling (`claim_result` MET ⇔ winner = A).
  - `too_close` or `failed` gives VOID with `void_reason 'undecidable'` and a "Too close to call" line.
  - `invalid` gives VOID `'undecidable'` (both refunded), and the reason names the problem.
  - The Ruling refinement is widened so that `'undecidable'` is allowed when `model === DANCE_OFF_MODEL`. This
    needs no DB enum change, because `undecidable` already exists in pg.
- Event `dance.scored` {evidence, evidence_hash, validation: {verdict, notes, skipped}, announcer_line} is
  appended in the same commit as `ruling.issued`, following the `market.settled` precedent.
- No appeal or "check it again" for dance offs, because the score is deterministic. They are gated the same way
  as gemini.
- No SAM 3.1 camera checks (`apps/server/src/judge/camera-checks.ts`, PR #13), although the terms are
  `evidence_source 'camera'`: `checksEligible()` refuses `dance_off` terms, so no `bet_checks` row and no
  `checks.compiled` is ever written for one; the dance ruling path never calls `runAttemptChecks` (no
  `checks.report`), POST …/attempts never warms SAM for a dance off, and the stage shows no ref cam line on it.

## 6. Mobile

6.1 **Native module** `apps/mobile/modules/dance-pose` is a local Expo module, autolinked from `./modules`,
written in Swift. It does NOT use VisionCamera, because v5 has no frame-processor plugin API here and the
worklets package is not installed.
- `DancePoseView` (Expo native view) owns an AVCaptureSession on the back camera at 720p, portrait. It shows an
  AVCaptureVideoPreviewLayer (resizeAspect) and runs `VNDetectHumanBodyPoseRequest` (pinned revision) on an
  AVCaptureVideoDataOutput queue, dropping frames while busy and capping at `maxFps`. It records with
  AVAssetWriter from the SAME sample buffers, so poses and video share one clock.
- Events: `onPoses {t, w, h, fps, people: {k: number[57]}[]}` and `onStatus {state: 'starting'|'running'|'recording'|'error'|'no_camera', message?}`.
- View async functions:
  - `startRound({snapshotAtMs: number[]})` → `{ok}`. Event `t` becomes ms since the first frame of the round,
    and recording starts.
  - `stopRound()` → `{clipUri, clipSha256, snapshots: {t_ms, uri, width, height, bytes, sha256}[]}`. The
    snapshots are JPEGs, ≤ 512 px and ≤ 200 KB.
- JS: `apps/mobile/modules/dance-pose/index.ts` exports the typed view plus `isDancePoseAvailable()`. The app
  loads it only through `importSafely`. The simulator has no camera, so it reports `no_camera`, and the app
  offers the debug replay.

6.2 **Flow.**
- The negotiate screen gets a "Dance off" panel: 3 routine cards and a stake → `POST /terms/dance` → the
  existing confirm → "You're on" + Face ID lock.
- On LOCKED, the recording phone (the room's judge cam, or else A's phone) routes to `dance`:
  1. Framing check (live skeletons, "A ← | → B"). Start is disabled until framing passes for 1 s.
  2. `POST /attempts`.
  3. Count-in "3, 2, 1" on the routine's beat (visual + haptic), starting at the attempt's `go_at`
     (the server's instant, GO_DELAY_MS after POST /attempts).
  4. At one shared instant t0 = `go_at` + 3 beats: `startRound`, the reference video (or skeleton) and the
     music start, and the live scoring starts. Both phones map `go_at` onto their own monotonic clock
     through the server-time offset the app keeps (`apps/mobile/src/dance/model/schedule.ts`), so they
     agree to within the clock-sync error. A recorder handed an attempt too late to meet its t0 ("Dance
     again" on an attempt already used, one open at mount) counts in from now and plays the music itself.
  5. The routine's `duration_ms` of dancing (the music, if any, plays from t0).
  6. `stopRound` → local final scoring → result screen, with no network so far.
  7. Upload → ruling → the existing RulingScreen, GG and payout.
- B's phone is the DISPLAY while the bet is LOCKED or in ATTEMPT (the recorder is always one of A's devices,
  so B's phone never records): full screen, portrait, the reference MIRRORED and contain-fit on the
  routine's dark backdrop, with its music, the screen kept awake, a big beat-synced "3, 2, 1" from `go_at`,
  then the reference from t0. A routine without a clip shows its mirrored skeleton full screen. From
  JUDGING on it shows the "Dance off live" screen with the score, then the usual ruling screens.
- Presence: the recorder plays the music and shows its own reference only when there is no display
  phone: party B online in the bet's room (room presence: a live socket now or within 30 s), read when
  the count-in starts. With a display phone it is silent and shows the camera panel only. There is no
  display-to-recorder ack on the wire (it would need a new event type and route).
- A's phone, when a judge cam records, shows the "Dance off live" status screen.

6.3 **Display layout** (it is what HDMI mirroring shows): the mirrored reference, the live camera view with
skeleton overlays for A and B, two live match meters, PERFECT/GOOD/MISS popups at each key move, and the beat
counter. With a display phone in the room the recording phone drops the reference panel (the display phone
shows it) and the camera panel takes the space.

6.4 **Debug / calibration** (hidden; Diagnostics → "Dance calibration"):
- Live readout of the raw scores, per-limb similarity, current lag and FPS.
- Record and replay a session from saved keypoints (JSON under documentDirectory/dance-sessions).
- A sync offset setting in ms (−500..500), persisted.

## 7. Double or nothing (all bet types)

`POST /v1/bets/:bet_id/rematch` (signed; either party; only for a terminal bet: PAID, VOIDED, FINALIZED,
EXPIRED). It creates a new DRAFTING bet in the same room with caller = A and the other party = B, sets
`supersedes_bet_id` = the old bet, and emits `bet.invited` with `rematch_of` and `suggested_stake_usd`
(2 × the old per-side stake, capped at MAX_STAKE). The challenger then picks ANY bet type on the normal negotiate
screen, with the stake chip defaulting to the suggestion. Dance Off → rematch → typed throw ("long shot") is one
continuous flow. A too-close-to-call VOID offers the same button.

## 8. Reference routine tool

- `tools/dance-ref/` is a Swift package macOS CLI that uses the SAME Vision request and revision. It reads a
  reference video, runs VNDetectHumanBodyPoseRequest per frame (largest person), and writes RoutineData JSON.
  Key moves are given with `--key-moves ms,ms,…` or `--bpm N --first-beat-ms M --every K`.
- `scripts/dance-routine.ts` has three subcommands:
  - `synth`: writes the 3 placeholder routines.
  - `import <json>`: validates, quantizes, picks beats, and writes `packages/shared/src/dance/routines/<id>.ts`.
  - `selftest`: scores each routine against itself and expects 100.
- Music must be royalty-free or ElevenLabs Music output, never a copyrighted song.
