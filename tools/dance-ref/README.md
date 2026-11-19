# dance-ref

A macOS command line tool that turns a reference dance video into the routine JSON for Dance Off
(`docs/planning/DANCE-OFF.md` §2 and §8). It runs the same Apple Vision request the phone uses,
`VNDetectHumanBodyPoseRequest` pinned to `VNDetectHumanBodyPoseRequestRevision1`, on every sampled
frame. It keeps the largest, most confident person and writes the 19 joints in contract order,
upright, unmirrored, with a top-left origin. `scripts/dance-routine.ts import` then validates,
quantizes and writes `packages/shared/src/dance/routines/<id>.ts`.

> **Status:** the package was written without being compiled. Run `swift test` first, and expect
> to fix small compile errors on the first build. None of the steps below have been run yet. Do
> them when you record the real routines; they are not needed for the synthetic placeholders.

## Requirements

- macOS 14 or later and Xcode 15 or later (Swift 5.9)
- `ffmpeg` for trimming and muxing (`brew install ffmpeg`)
- An iPhone on a tripod, a speaker with a cable (Bluetooth adds 100–300 ms of delay), and a plain
  wall

## Workflow

Run every command from the repo root. Replace `<id>` with the routine id, for example `wave`. Ids
are kebab case: lowercase letters and digits in words joined by single `-`, at most 32 characters,
as shared `RoutineId` requires. Raw files go in `tools/dance-ref/work/`, which git ignores.

### 1. Choreograph for two dancers side by side

Both players dance the SAME routine at the same time, side by side, in one camera frame. Each gets
about half the frame width, so the routine has to stay on the spot:

- No travelling. One step out and back is the most anyone can do.
- Use big, clear arm shapes and hold them on the key beats. Key moves are scored on the pose at
  the beat (§4.6), and arms carry the most weight in the scorer.
- Face the camera. Full turns and back-to-camera moves confuse left and right in Vision.
- No floor work, no jumps that leave the frame, and nothing that hides the hands behind the body.
- A routine is 5 to 40 s long (`--duration-ms`, 15000 by default; each routine has its own length
  and the Terms text says it). Plan 8–16 key moves over it. For 15 s at 120 bpm, a key move every 2
  beats gives about 14, and every 4 beats from a first beat at 500 ms gives 8; for the 32.6 s
  `bye-bye-shuffle` at 172.6 bpm, every 8 beats from 235 ms gives 11.

### 2. Make the music

Use royalty-free music whose license allows use in an app and a public demo, or generate a track
with ElevenLabs Music on a plan whose terms allow that use. **Never use a copyrighted song**, and
no rips from streaming or video sites. Keep the license or the generation record with the track,
and put the credit in `--song`.

An example ElevenLabs Music prompt: "Upbeat instrumental dance pop, 120 BPM, 4/4, punchy kick on
every beat, no vocals, 20 seconds."

Write down the tempo (`--bpm`). Trim the track so the music starts at 0:

```sh
ffmpeg -i tools/dance-ref/work/track-raw.mp3 -af silenceremove=start_periods=1:start_threshold=-40dB \
  tools/dance-ref/work/track.m4a
```

Then find the first downbeat in ms from the start, in Audacity or any waveform view. That number
is `--first-beat-ms`, and it is often 0.

### 3. Record the reference video

- **One dancer**, full body. Keep the head and both feet in frame the whole time, with a margin
  above and below. Nobody else may be in the shot, not even passing behind.
- **A steady tripod** at about hip height, 3–4 m away, using the **back camera** in portrait at
  30 fps (1080p or 720p). Don't zoom and don't move the phone.
- **A plain background**, even light from the front, and clothes that contrast with the wall. Avoid
  loose sleeves that hide the elbows.
- Start recording, wait about 2 s in silence, then play the track from the wired speaker. Dance the
  routine to the music and keep filming for 2 s after it ends. The quiet lead-in is what step 4
  uses to find where the music starts.
- Check the result for mirroring: raise your LEFT hand in a test clip. The back camera shows it on
  the image's right side, which is unmirrored and correct. A selfie-style recording shows it on the
  left, which is mirrored; fix that with `hflip` in step 4.

Copy the recording to `tools/dance-ref/work/raw.mov`.

### 4. Trim the video and mux the clean audio into the final mp4

Find where the music starts in the raw recording, using the camera's own microphone track:

```sh
ffmpeg -hide_banner -i tools/dance-ref/work/raw.mov \
  -af silencedetect=noise=-30dB:d=0.3 -f null - 2>&1 | grep silence_end
```

The first `silence_end: S` is the music start, `S` seconds into the raw file. Cut the clip at S,
replace the camera audio with the clean track, keep exactly the routine length (`-t`, here 15 s; it
must match `--duration-ms`), and encode for the phone:

```sh
mkdir -p apps/mobile/assets/dance
ffmpeg -ss S -i tools/dance-ref/work/raw.mov -i tools/dance-ref/work/track.m4a \
  -t 15 -map 0:v:0 -map 1:a:0 \
  -vf "scale=-2:1280,fps=30" \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 26 -preset slow \
  -c:a aac -b:a 128k -ar 44100 -ac 2 \
  -movflags +faststart \
  apps/mobile/assets/dance/<id>.mp4
```

Notes:

- `-ss` before the first `-i` trims only the video, so the track still starts at 0. Video and music
  now share one clock, and t = 0 in the mp4 is the routine start.
- ffmpeg auto-rotates portrait iPhone clips while re-encoding, so the output is upright. The tool
  also handles clips that still carry a rotation.
- If the recording was mirrored (step 3), use `-vf "hflip,scale=-2:1280,fps=30"`. Then run the tool
  WITHOUT `--mirrored`. The phone flips the reference itself when it shows it (§4.2), so the
  shipped mp4 and the pose data must both be unmirrored.
- Aim for about 4 MB or less. Raise `-crf` (28–30) if the file is bigger.
- Watch the mp4 and check that the moves land on the beats. If the music is early or late, nudge S
  by ±0.05 s and encode again.

### 5. Extract the poses

```sh
swift run --package-path tools/dance-ref -c release dance-ref \
  apps/mobile/assets/dance/<id>.mp4 \
  -o tools/dance-ref/work/<id>.json \
  --id <id> --title "The Wave" --song "Night Drive (ElevenLabs Music)" \
  --bpm 120 --first-beat-ms 0 --every 2 \
  --fps 15
```

The tool prints a summary: frames written and analysed, the time span, mean confidence, frames
with nobody or with more than one person, and how often each joint was missing or weak (below
0.3, the scorer's `MIN_CONF`). Warnings go to stderr. Record again if the ankles, wrists or hips
are weak in more than a few percent of frames, if anyone else was seen, or if the mean confidence
is low.

### 6. Import it into the app

```sh
npx tsx scripts/dance-routine.ts import tools/dance-ref/work/<id>.json --id <id>
npx tsx scripts/dance-routine.ts selftest
```

`import` writes `packages/shared/src/dance/routines/<id>.ts`. It keeps the JSON's `duration_ms`
(5000..40000; `--duration-ms` overrides it, and a JSON without one gets 15000), keeps only the
frames inside it, and picks key moves inside it. `--audio <file>` / `--video <file>` set the
routine's `media` (the bundled file under `apps/mobile/assets/dance/`). `selftest` scores every
routine against itself and expects 100.

The real routine `bye-bye-shuffle` (32.6 s, a silhouette reference clip with an original
synthesized drum track muxed in) was imported with:

```sh
npx tsx scripts/dance-routine.ts import tools/dance-ref/work/left.json --id bye-bye-shuffle \
  --title "Bye Bye Shuffle" --song "Original drum track (You're On), 172.6 BPM" \
  --bpm 172.6 --first-beat-ms 235 --every 8 --video bye-bye-shuffle.mp4
```

Its source footage stays in `tools/dance-ref/work/` (gitignored) and never ships. The phone plays
`apps/mobile/assets/dance/bye-bye-shuffle.mp4` (`work/silhouette-drums.mp4`: the SAM 3.1 silhouette
on #0b0614 with the drum track). For a local demo build with the original song, copy
`work/silhouette-song.mp4` to `apps/mobile/assets/dance/local/bye-bye-shuffle.mp4` (gitignored and
in `.easignore`; Metro bundles it in place of the committed one). Never commit that file. There are exactly 3 bundled routines (`ROUTINES`), so either reuse
the id of the synthetic placeholder you are replacing, or swap the new routine into the registry
in its place. Raise `--routine-version` whenever you re-import a routine that is already in use.
Its sha256 is part of the bet terms (§1).

### 7. Ship the video

The mp4 is already in `apps/mobile/assets/dance/<id>.mp4` (step 4). In the generated routine
module, set `media.video` to that asset in the form the mobile reference player resolves, and leave
`media.audio` null, because the music is muxed into the mp4. Changing `media` changes the routine
sha256, so do it before the routine is used in any bet, and run `selftest` again.

## Options

```
dance-ref <video> -o <out.json>
  [--fps 15]                    analysis rate, 1..30
  [--id <slug>]                 kebab case, max 32; default: from the video file name
                                ('_' and other separators become '-')
  [--title <text>]              max 40; default: the id
  [--song <text>]               max 80; default: Unnamed track
  [--routine-version 1]
  [--bpm <n>]                   default 120, with a warning
  [--first-beat-ms <ms>]        default 0, ms after the routine start
  [--key-moves ms,ms,... | --every K]
  [--key-move-names a,b,...]    optional, in time order (default "Move N")
  [--mirrored]                  un-mirror a mirrored source: flip x and swap left/right
  [--start-ms 0] [--duration-ms 15000]
```

- `--start-ms` analyses a window inside a longer video, and frame times stay relative to it. Trim
  the mp4 in step 4 instead when you can, so the shipped media and the poses share t = 0.
- With `--every K`, key moves fall on every K-th beat from `--first-beat-ms`. The tool skips beats
  before 500 ms and after `duration − 500` ms, because their judging windows would be cut short.
  With neither option, `key_moves` is left out and the importer picks beats.
- Key move ids are `km01`, `km02`, … in time order.

## Output

The output is RoutineData (contract §2) with float keypoints:

```json
{
  "schema_version": 1, "id": "wave", "version": 1, "title": "The Wave", "song": "…",
  "bpm": 120, "duration_ms": 15000, "first_beat_ms": 0, "count_in_beats": 3,
  "w": 720, "h": 1280, "mirrored_source": false, "source": "vision",
  "frames": [{"t": 0, "k": [/* 57 floats: x, y, c × 19 */]}, …],
  "key_moves": [{"id": "km01", "t": 1000, "name": "Move 1"}, …],
  "media": {"video": null, "audio": null}
}
```

- `t` is whole ms since the routine start, strictly increasing, at about `--fps`.
- `k` holds the 19 joints in the contract order (nose, leftEye, rightEye, leftEar, rightEar, neck,
  leftShoulder, rightShoulder, leftElbow, rightElbow, leftWrist, rightWrist, root, leftHip,
  rightHip, leftKnee, rightKnee, leftAnkle, rightAnkle). x and y are in [0,1] in the upright,
  unmirrored image with a top-left origin, and c is in [0,1]. A missing joint is `0,0,0`.
- `w` and `h` are the upright pixel size.
- Frames where Vision found nobody are left out, and the summary counts them.
- `mirrored_source` is always false, because `--mirrored` un-mirrors the data before writing it.

## How it works

- `AVAssetReader` decodes the video track as BGRA over `[start, start + duration]`.
- The track's `preferredTransform` becomes a `CGImagePropertyOrientation`; an iPhone portrait clip
  maps to `.right`. That orientation goes to `VNImageRequestHandler`, so Vision returns coordinates
  in the upright image, the same geometry the phone feeds it.
- `FrameSampler` keeps the first decoded frame at or after each 1/fps tick.
- Each person gets a score: the joint bounding-box area in pixels times the mean confidence. The
  highest score wins.
- Vision's bottom-left origin is flipped to top-left: y → 1 − y.

The pure logic (arguments, joint order, mirroring, orientation, sampling, person pick, key moves,
JSON, summary) lives in `Sources/DanceRefCore` and is unit tested:

```sh
swift test --package-path tools/dance-ref
```
