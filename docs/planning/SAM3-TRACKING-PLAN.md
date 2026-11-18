> **Status (2026-11-18):** reference plan only. Alaric owns the SAM build. Written before the switch to **SAM 3.1**: read "SAM 3" as SAM 3.1, and note fal.ai was only verified to host SAM 3, not 3.1, so 3.1 means self-hosting (e.g. Modal, where the `huggingface` secret already exists in the `loganstaples` workspace).

# SAM 3 video review and staged-cheat detection (rev 2)

**On stage, one bet and one throw.** Jake throws a paper ball into the bin and Claude rules MET. Logan appeals. The projector plays **VIDEO REVIEW · SAM 3**: boxes on the ball and Jake's shoes, a ball trail, the tape line drawn as a laser, slow motion at the release, then a freeze on **FOUL · toe 17 cm over**. Claude confirms the foul, the three-model panel overturns the ruling, and the escrow pays Logan. The cheat is announced as staged (ARCHITECTURE §7.1).

**D16** (`docs/planning/README.md`) amends D10, because SAM 3 now runs on attempt clips as appeal evidence. It supersedes D11: the paper ball replaces the bottle flip, and the appeal is shown live. Claude's still-frame ruling stays the fast path. Setting `TRACKING_ENABLED=false` turns every change below off (the §8 kill path).

## 1. Pitch budget: Beats 4 and 5 merge into 2:25–3:45 (80 s)

| Step | Time | Cumulative, best / p90 |
|---|---|---|
| GO (`GO_DELAY_MS`) | 3 s | 3 / 3 |
| Record (`MS_PER_TRY`) | 6 s | 9 / 9 |
| Frames upload, Claude ruling → RULED MET | 5–9 s | 14 / 18 |
| Operator key, appeal tx | 3–5 s | 17 / 23 |
| Clip upload → tracking `ready` (starts at about 10 s) | 15–40 s | 25 / 50 |
| `confirmFoul` | 4–8 s | 30 / 58 |
| Panel (`PANEL_VOTE_TIMEOUT_MS` 8 s) | 5–8 s | 36 / 66 |
| `resolve_appeal` → PAID | 3–10 s | 45 / 76 |

- **Hard cutoff at 3:40.** The presenter moves to Beat 6 and the result arrives on the ticker. If tracking failed, press 7.
- Update `docs/pitch.md` (Beat 2 terms become the paper ball, Beats 4 and 5 merge, no live GG), `docs/runbook.md`, and the "No phones" variant (cp1-drive `--webcam` or `--clip`).

## 2. Pipeline, using the clip contract in API-CONTRACT §2.9

Flow: the laptop encodes, hashes and samples the clip; frames go to Claude as today; the clip PUT and clip-complete start tracking; a confirmed foul enters the gated appeal panel.

- **Clip upload field.** In `apps/server/src/judge/schemas.ts:33`, change `clip_upload` from `z.null()` to `PresignedUpload.nullable()`.
- **Hash.** The clip's sha256 is already the ruling's `evidence_hash` (`routes.ts:888`), which goes on chain at resolve. Every re-encode (CFR, rotation strip, 720p) therefore happens on the laptop, before hashing. The worker derives its own proxy, because the server image has no ffmpeg.
- **Storage** (`apps/server/src/storage/evidence.ts`).
  - Tigris via aws4fetch when it is configured.
  - Otherwise the upload URL points at a server-signed `PUT /v1/evidence/:token`. It streams to `/tmp/evidence` (25 MB cap, hashed while writing) on the 512 MB shared VM. A restart wipes the disk, which is acceptable: the clip is consumed within minutes, and key 7 covers a loss.
- **Clip metadata.** clip-complete sets `attempts.clip_key`, `clip_mime` and `clip_bytes` (`packages/db/src/schema/judge.ts:76-83`).

## 3. Staging and geometry

**Layout** (about 5 × 4.5 m):
- **Line:** 1 m of blue gaffer tape, plus a 30 cm perpendicular tick at the stance spot for scale.
- **Bin:** a low, wide, see-through bin 2 m past the line.
- **Camera (line-judge placement):** on the tape's extension, about 4 m back, 1.8–2 m high, angled down, 1x lens. The vertical plane over the tape projects to a single image line, so a raised toe past the line shows past it, with no parallax.
- **Visibility:** neon ball, bright shoes and light; the bin inside the landing crop's middle 80 %.

**Script.** Jake releases at about 3.0 s after GO. The lead stills of `judgeFrameTimesMs(6000)` are at 1.18, 2.36 and 3.54 s, so the release falls between them. The ball lands at about 3.8 s and is at rest throughout the landing window (4.72–5.92 s), so Claude sees a clean make. His toe slides 15–20 cm over for about 0.3 s around the release, then he steps back.

**`tools/sam3/venue.json`**, tapped once per venue: the line endpoints, the tick, the throw-zone ROI and the bin box.

**Geometry** (`tools/sam3/geometry.py`, pytest on synthetic masks):
1. **Release t_r:** the first of 3 consecutive frames in which the ball moves more than 12 px per frame toward the bin, minus 1. No hand or person prompt is needed.
2. **Performer:** shoe masks inside the throw-zone ROI, keeping the 2 nearest the ball at t_r. Bystander shoes are excluded.
3. **Penetration:** the largest signed distance of a shoe-mask pixel past the line, in cm (scale from the tick).
4. **FOUL:** at least 6 cm (about 17 px, beyond mask jitter and shadow) in 2 consecutive frames within [t_r−5, t_r+1]. The staged cheat is 15–20 cm. A toe on the tape is legal.
5. **Landing:** in or out of the bin box, for display only.

## 4. SAM 3 backend: build one, chosen by T2

- **fal `fal-ai/sam-3/video-rle`** (verified; `sam-3-1` is not).
  - One call per concept, `"paper ball"` and `"shoe"`, run in parallel.
  - T2 confirms each parameter name: the box/RLE output and the threshold.
  - The worker trims the clip to [2.0, 4.8] s, about 84 frames and $0.05 per attempt.
- **Decision rule.** If fal's p90 from upload to `ready`, measured on a hotspot, is under 15 s and ball recall is at least 80 %, skip Modal. Otherwise go Modal-only (T4):
  - HF `Sam3VideoModel`, with `new_det_thresh` and `hotstart_delay` checked against the transformers source.
  - Weights baked into the image.
  - Logan's HF token stored as a Modal secret.
  - `min_containers=1` on Saturday.
- **Worker** (`tools/sam3/`: backend, `geometry.py`, `render.py`, `cli.py`).
  - The OpenCV render burns into an MP4 of 5 MB or less: the boxes, the trail, the line, 0.25× slow motion and the FOUL freeze.
  - It also writes 3 release JPEGs with geometry only and no text.

## 5. Server work

- **Data.**
  - Migration `0009_tracking.sql` and `packages/db/src/schema/tracking.ts`: table `attempt_tracking` (`attempt_id` PK, `status` queued/running/ready/failed/late, `backend`, `track`, `tracking_sha256` via `hashJcs`, `foul`, `confirm`, `replay_key`, `vr_keys`, `vr_hashes`, timings). Nothing goes in `attempt_frames`.
  - `packages/shared/src/tracking.ts`: TrackingTrack v1.
  - `attempt.tracking` joins the `RealtimeEvent` union (`packages/shared/src/realtime.ts`) and the stage ticker.
- **`apps/server/src/tracking/service.ts`.**
  - Calls the worker (`TRACKING_WORKER_URL` plus an HMAC secret) with a 45 s deadline, then marks the run `failed`.
  - `confirmFoul`: Claude gets the 3 JPEGs plus a text part with the server's measurements. A foul goes to the panel only if confirmed at confidence ≥ 0.7.
  - Writes `audit_log 'tracking.foul'`.
  - `GET …/attempts/:n/tracking` returns the status and a 5-minute signed replay GET (DATA-MODEL §9).
- **Appeal gate** (`appeal/service.ts`).
  - `ensurePanel` stops being speculative at filing whenever tracking is pending. It runs when tracking finishes or when `TRACKING_GATE_MS` expires (default 25 s, then set from T2).
  - The sweep and boot recovery start overdue panels.
  - A result after the panel starts is `late`, display only. Tests cover gate, expiry, sweep, restart, late.
- **Panel** (`appeal/panel.ts`).
  - `PanelInput` gains `video_review {VR1–VR3 images, measurements_text}`, sent as a labelled block before the ruling frames.
  - `PANEL_SYSTEM_PROMPT` gets a foul rule: the server's video review decides the stance criterion, and the last frames still decide the result.
  - VR hashes join `frame_hashes` (16 of 24); bottle-flip appeal fixtures are regression-tested.
  - A flip needs 2 of 3 votes at ≥ 0.6. **Logan confirms `OPENAI_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY` on Fly.**
- **Judge (T10).**
  - Make `JUDGE_SYSTEM_PROMPT` (`judge/prompt.ts`) generic over terms, with a throw section covering release, flight, ball at rest in the container, and `checks`. Re-run the bottle fixtures.
  - Add `PAPER_BALL_TERMS_ARGS` (from `04-paper-ball.json`) and a `preset` on `POST /v1/demo/bets/:id/terms`.
  - Update the Beat 2 text in `demo/warmup.ts`.
  - Add `judge-eval --terms`.
  - Defer the `isBottleFlip` fix: paper-ball terms never trigger it, and a fix should use a positive bottle-flip regex. Defer the mobile edits too, since those files are dirty on `feat/visual-refresh`.

## 6. Stage (T8, about 3 h)

- `apps/stage/src/tracking.ts` and `view.tsx`:
  - While tracking runs, show "SAM 3 · tracking…".
  - On `ready`, play the signed URL in a full-screen `<video muted playsinline>`, then show the votes in a lower third.
- Key 7: add a `track` entry to `REPLAY_BEATS` and `BEAT_TITLES` (`apps/stage/src/replays.ts`), 5 MB or less in the preload.
- Replays ship in the server image (`public/replay/`), so **Logan deploys at Thu 11:00**.
- A live canvas overlay is a stretch goal (T15).

## 7. Clip source (`scripts/cp1-drive.ts`, T9)

- `--terms paper-ball`. Today the script posts `{}`.
- `--webcam <idx>`, using ffmpeg avfoundation:
  - Trim from the laptop's receipt of `attempt.started` plus `GO_DELAY_MS`, never from `go_at`.
  - Encode with `-fps_mode cfr -r 30` at 720p and 2 Mbps, then hash, sample (`scripts/lib/clip-frames.ts`), upload and complete.
  - Re-arm for every REDO.
  - Continuity Camera needs one Apple ID and Wi-Fi; a USB webcam is the fallback.
- `--clip <file>`: a pre-filmed foul, sent through the same live path.
- `--appeal-key`: waits for an operator keypress before filing, so the appeal is visible. The current `--appeal` files instantly.

## 8. Tasks and schedule (now Wed 13:00; code freeze Thu 20:00)

| # | Task | Owner | h |
|---|---|---|---|
| T0 | fal account, HF token, Tigris yes/no, panel keys on Fly, approve the `ALLOW_SPEND` eval budget (~$15) | Logan | 0.5 |
| T1 | Props (tape, neon paper, tripod, bin). Film ≥ 10 clean throws (≥ 4 with a toe on the tape), ≥ 6 fouls at 15–20 cm, 2 misses. `labels.json` | humans | 2.5 |
| T10 | Judge prompt, preset, `judge-eval --terms`, `cp1-drive --terms` | agent | 2 |
| T11 | Real Claude and the real sampler on T1. **Wed 19:00 go/no-go:** ≥ 9 of 10 makes ruled MET, 0 REDO | agent | 1 |
| T2 | fal probe: parameters, latency, recall | agent | 1.5 |
| T3 | Worker, geometry, pytest, render | agent | 5 |
| T4 | Modal (only if T2 fails) | agent | (3) |
| T5 | Clip contract, evidence store, tests | agent | 3.5 |
| T6 | 0009, tracking service, event, GET, `confirmFoul` (starts on a hand-made track) | agent | 4 |
| T7 | Gate, panel video review, tests; offline panel eval on T1 (flip rate and false-flip rate) | agent | 4 |
| T8 | Stage | agent | 3 |
| T9 | cp1-drive | agent | 3.5 |
| T12 | Offline renders, Devpost footage | agent + human | 1.5 |
| T17 | Docs: D16, pitch, runbook; API-CONTRACT (`GET …/tracking`, §7.2 gate and video-review input); DATA-MODEL (0009); SCHEMAS | agent | 1.5 |
| T14 | Deployed rehearsal on the hotspot: 5 webcam runs and 5 clip runs | humans | 2 |

About 30 agent hours over 3 lanes, in a worktree off `main`.

| When | Lane A | Lane B | Lane C | Humans |
|---|---|---|---|---|
| Wed 13–19 | T10 → T11 | T5 | T8 | T0; T1 (props by 14:00, filming 15–17) |
| Wed 19 – Thu 02 | T2 → T3 | T6 | T9 | Logan merges visual-refresh |
| Thu 02–08 | T3 | T7 | T17 | sleep |
| **Thu 08:00** | **Integration milestone:** end to end on a local server with fal | | | |
| Thu 08–12 | T12, tuning | fixes | ElevenLabs go-live | Logan deploys at 11:00 |
| **Thu 12:00** | **Kill criterion** (see below) | | | |
| Thu 12–16 | fixes, re-filming | | | iPhone build, if Apple approves |
| Thu 16–19 | | | | T14 |
| Thu 20 – Fri 10 | | | | Devpost video edit |

**Kill criterion at Thu 12:00.** Kill the live foul beat if any of these holds:
- fewer than 5 of 6 fouls flagged
- any false foul
- Claude's MET ruling is unreliable

The fallback ships only key 7 and the Devpost footage, with `TRACKING_ENABLED=false`. Live Beat 4 stays the bottle flip, ending with GG.

## 9. Validation

1. **Offline, on the T1 set.**
   - Ball recall ≥ 80 %.
   - Fouls flagged: at least 5 of 6.
   - Clean throws flagged: 0 of 10 or more, including the toe-on-line throws.
   - Every landing correct.
   - Results go to `docs/sam3-eval.md`.
2. **Panel, with real vendors.** Each foul clip is overturned in at least 2 of 3 runs. No clean clip is ever overturned.
3. **Latency.** 10 runs from upload to `ready` on the Saturday hotspot. The result sets `TRACKING_GATE_MS`.
4. **Integration.** `cp1-drive --clip` overturns the ruling 3 times in a row on the deployed server, then the same with `--webcam`.
5. **Tests.** vitest, jsdom and pytest.

**Saturday on-site go/no-go, before T−30 min:** tape and tap `venue.json`; one clean throw and one staged foul live; check the ROI for bystander feet; warm the backend; preload key 7. Any failure → kill path.

## Review notes

- **Tracking window.** [go, go+3.5 s] would cut off the scripted flight and landing: release at about 3.0 s, ball at rest by about 4.7 s. Track [2.0, 4.8] s instead.
- **Landing time.** If the ball lands at 4–5 s, it is still in the air in the early landing frames (from 4.72 s). A release at about 3.0 s keeps it at rest for the whole window and avoids the 3.54 s still.
- **Hours.** The 37.5 h runs in three parallel lanes. The real limits are the serial chain T1 → T2 → T3 → T6/T7 and the steps only Logan can do, which the milestones address.
- **Geometry.** Both options are used: line-judge placement for parallax, venue taps for ROI and scale.
