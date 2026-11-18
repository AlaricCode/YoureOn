# On-device QA

Everything here needs real iPhones: nothing in it can run in CI or a simulator. Work top to
bottom; each check says what to do, what passes, and what to write down. Put numbers in
`docs/measurements.md` as a new dated section ("YYYY-MM-DD: on-device QA, build #N").

Phones: **A** (challenger, runs the judge's voice), **B** (opponent), **J** (judge cam), plus the
non-demo phone for anything that could lock Face ID. All on iOS ≥ 16.4, passcode set, Low Power
Mode off.

## 0. Before you start

- [ ] Fresh build installed on every phone (`eas build -p ios --profile development`, or the
      preview profile). Note the build number.
- [ ] The face model is in the build: `apps/mobile/assets/models/w600k_mbf_float32.tflite`
      exists locally before you build (git ignores it), and its sha256 is
      `ca17b05ac6e92ff819d81191d865e3864f4e6779df60468f0db547c982091033`.
- [ ] Server env for the face routes: `FACE_KEK_ACTIVE=face-kek-2026-11-a`,
      `FACE_KEK_2026_11_A=$(openssl rand -base64 32)`, `MATCH_TICKET_SECRET=$(openssl rand -base64 32)`.
      Without a KEK the face routes refuse to run in production, on purpose.
- [ ] Build diagnostics → **Run checks**: every required row green. Fix anything red first.
- [ ] Turn Wi-Fi **off** on A, B and J for every check marked _cellular_.

## 1. Camera recording (judge cam, phone J)

- [ ] Diagnostics → **expo-camera** → the 2 s record check is green.
- [ ] Judge cam from Profile → Judge cam. Start: "3, 2, 1, Go" counts down, "Recording" shows
      red with a dot, **Stop** (square in the ring) ends it early; with no Stop it ends by itself
      at 6 s.
- [ ] Record 10 clips of a bottle flip. Each gives 8 frames (diagnostics **expo-video extracts
      frames** check) and the clip plays back at 720p.
- [ ] Kill the network during "Sending": the screen offers **Try again**; tapping it resends the
      same clip (not a retake) once the network is back.

Write down: clip duration p50, frames per clip (must be 8), any clip with < 8 frames.

## 2. Frames upload over React Native fetch (J → server, _cellular_)

- [ ] Run Beat 4 ten times end to end (`scripts/cp1-drive.ts --through paid` sets up the bet).
- [ ] Every `POST /v1/bets/:id/attempts/:n/frames` returns 202 and `judging: true`.
- [ ] The server's recomputed hashes equal the phone's: `client_clip_hash` matches 10/10, no
      `FRAME_HASH_MISMATCH`.
- [ ] The multipart body is accepted as signed (no `SIGNATURE_INVALID`): this is the check that
      React Native's fetch sends the bytes we signed, unchanged.

Write down: upload time p50 and p95 on cellular (target p50 < 1 s), any error codes.

## 3. Face ID (phones A and B)

- [ ] Terms card: **Hold to lock in $5** fills over 0.8 s; letting go early empties it and no
      Face ID appears; moving your finger away cancels it too.
- [ ] Full hold → Face ID → "You're in. Waiting for Jake…" and a tick on your avatar.
- [ ] Cancel Face ID: the red line says **Face ID failed** and the hold works again.
- [ ] Fail Face ID twice (on the non-demo phone), tap **Use Passcode**, enter it: the lock still
      goes through, and the server records `passcode_hold` for that party.
- [ ] GG on the loser's phone is a **tap** then Face ID (no hold).
- [ ] VoiceOver on: the hold button offers an "activate" action that opens Face ID.

Write down (D1-M2): Face ID time to success p50, passcode fallback time, warm and cold signing
time (targets: warm < 30 ms, cold < 300 ms, Face ID p50 < 1.5 s).

## 4. WebSocket over cellular (A and B, _cellular_)

- [ ] A challenges B from the room list 10 times: B's full-screen "Logan challenged you" with a
      buzz appears within 1 s, 10/10.
- [ ] Turn airplane mode on for 10 s on B, then off: the **Reconnecting** bar slides in at the
      top and leaves on its own once the socket is back, and B's screen catches up with no missing
      state (the bet resyncs).
      _Today the bar shows on Home only. After the src/app merge, wire
      `setConnectionStatus(status)` (src/ui/connection.ts) where DemoApp dispatches `offline`,
      and it shows on every screen._
- [ ] Lock 10 times in each order (A first, B first): both phones double-buzz on LOCKED and the
      badge pulses twice.
- [ ] Background B for 30 s during DRAFTING, bring it back: the challenge is still there.

Write down: second authorization → LOCKED p50 (target < 2 s), any missed buzz.

## 5. Face scan (Beat 1) — needs the src/app wiring

Wiring after the merge, in DemoApp: give Home an `onScan`, and render `ScanScreen` with
`scan={createFaceScanner({ detect: (u) => detector.detectFaces(u), embed: (u, f) =>
embedder.embed(u, f), match: (req) => rt.api.faceMatch(roomId, req) })}` and `onChallenge={(m)
=> rt.api.createBetFromScan(roomId, m.user.user_id, m.matchTicket)}`, where `embedder =
createModelEmbedder()`. The enroll flow takes the same embedder in place of
`createPreviewEmbedder()`.

### 5a. The crop and the embedding (diagnostics → **Face embed**)

- [ ] Capture your own face: the 112 × 112 crop shows your whole face, centred, upright, from
      brows to chin. If it is rotated or off to one side, stop: the photo orientation handling in
      `src/enroll/embedder.ts` needs a fix before anything else.
- [ ] Same person, five captures (ahead, a little left, a little right): cosine vs previous is
      ≥ 0.45 every time.
- [ ] Two different people back to back: cosine ≤ 0.25.
- [ ] Front camera then back camera on the same person, with **Mirror crop** off and then on.
      Keep whichever setting scores higher across cameras, and pass it as
      `createModelEmbedder({ mirror })` for the front-camera (enroll) embedder.
- [ ] If faces are cut off or too loose, tune `FACE_CROP_SCALE` in `src/face/preprocess.ts`
      (1.15 now) and repeat.

Write down: embed time p50 (warm), the cosine table, the mirror decision, the crop scale.

### 5b. Enroll, scan, abstain (three teammates + strangers)

- [ ] Each teammate: Profile → Face matching → consent → three photos → "Face saved".
- [ ] All three join one room. Each scans each of the others five times: the right name every
      time (0 wrong-person matches), tap to name p50 < 1 s.
- [ ] Scan 30 strangers or photos of strangers: **No match** every time, and nothing about anyone
      appears. On the server, `face_enrollments` still has 3 rows and `audit_log` gained no rows
      from the scans.
- [ ] One teammate turns **Face matching** off: scanning them now says **No match**. Turn it back
      on: they match again.
- [ ] One teammate deletes their face data (red **Delete face data**, **Yes, delete**): their row
      is gone and they no longer match.
- [ ] **Challenge** from a match creates the bet (challenge_method 'face'); the same match 61 s
      later is refused ("That face match expired. Scan again.").

## 6. Moments, haptics and polish

- [ ] Ruling: one firm tap on both phones as it appears; the 10 s bar drains; the loser sees **GG**.
- [ ] Run it back: a light tick; the attempt dots show which try this is.
- [ ] Payout (winner): success buzz, "+$5" fades in beside the balance, the balance stays grey
      while paying and turns white with a count-up when paid.
- [ ] With the judge cam's camera open on the same phone, haptics go silent; the on-screen pulse
      still marks LOCKED.
- [ ] Icon on the home screen is the purple switch. After the splash patch and a new build: the
      app opens on the dark splash with no white flash, and the keyboard and system alerts are
      dark.

## 7. Report

Post one message in the team chat with: build number, the boxes that failed (with a screenshot
or screen recording), and the link to the new `docs/measurements.md` section.
