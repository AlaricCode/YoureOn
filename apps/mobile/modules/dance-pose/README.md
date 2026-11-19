# DancePose (local Expo module)

The Dance Off judge-cam view (contract: `docs/planning/DANCE-OFF.md` §6.1). It is Swift only, it
does not use VisionCamera or expo-camera, and it is iOS only.

## What it does

`<DancePoseView active maxFps onPoses onStatus />` owns its own `AVCaptureSession`:

- **Camera.** The back wide-angle camera at 1280x720 (`hd1280x720`), locked to 30 fps when the
  format allows it. The video data output's connection is rotated to portrait
  (`videoRotationAngle = 90` on iOS 17+, `.portrait` before that), so every buffer is upright
  720x1280. The pixel format is `420f`, or BGRA where `420f` is not offered. Late frames are
  discarded. The preview is an `AVCaptureVideoPreviewLayer` set to `resizeAspect`, filling the
  view, so the image is letterboxed and never cropped.
- **Pose.** `VNDetectHumanBodyPoseRequest` is pinned to `VNDetectHumanBodyPoseRequestRevision1`
  and runs on its own queue with orientation `.up`. A frame is dropped while Vision is busy or
  when it comes faster than `maxFps` (default 30, clamped to 1..60). Each person is 57 numbers,
  `[x, y, c] × 19`, in the contract's joint order. x and y use a top-left origin
  (`y = 1 − vision.y`) and are rounded to 4 decimals. A missing joint is `0, 0, 0`. At most 6
  people are reported per frame.
- **One clock.** `startRound({snapshotAtMs})` makes the next captured frame t0. That frame's
  PTS starts the `AVAssetWriter` session (mp4, H.264, 720x1280, real-time), and from then on
  every `onPoses.t` is ms since t0. Every captured frame is appended to the clip, including
  frames the pose throttle drops. Outside a round, `t` is ms since the session's first frame.
  Every event also carries `ts`, which is always ms since the session's first frame. Pre-round
  frames (framing, count-in) map onto the round clock as `ts − (ts₀ − t₀)`, where `ts₀` and `t₀`
  come from the first round frame (`t₀ = 0`).
- **Snapshots.** When a frame's `t` first reaches a requested `snapshotAtMs`, that frame becomes
  a JPEG: long side ≤ 512 px, quality 0.7, lowered until the file is ≤ 200 KB. It is written to
  `Caches/dance-pose/` with its SHA-256.
- **`captureStill()`.** The next frame that goes to Vision is also written as one full-size JPEG
  (the whole upright 720x1280 frame, quality 0.9, ≤ 1.5 MB) to `Caches/dance-pose/still-*.jpg`.
  It resolves `{ok: true, uri, width, height, ts}`, where `ts` is that frame's `onPoses.ts`, so
  the faces found in the still pair with that frame's people (the Dance Off face assignment,
  DANCE-OFF.md §3). Without fresh frames it resolves `{ok: false, message}`. The caller deletes
  the file once the faces are embedded (the cache prune is the backstop).
- **`stopRound()`.** Finishes the clip, hashes it by streaming the file (SHA-256, 1 MB chunks)
  and returns `{clipUri, clipSha256, snapshots}`. If recording failed, `clipUri` and
  `clipSha256` are `null`, and the snapshots still come back. Files older than a day in
  `Caches/dance-pose/` are deleted the next time the view is created.
- **Status.** `onStatus` reports `starting`, `running`, `recording` (t0 captured, writer
  started), `error` (with a message: runtime error, interruption, recording failure) and
  `no_camera` (no back camera, as on the simulator, or camera access is off). The `message`
  strings are for logs and diagnostics. App screens should pick their own copy for each state
  (see `src/ui/copyRule.ts`).
- **Lifecycle.** The camera runs only while `active` is true and the view is in a window. Leaving
  the window stops it, and coming back restarts it. Deallocating the view abandons a running
  round and tears the session down. Camera access is requested on first use if it is not yet
  determined (the app already has `NSCameraUsageDescription`). No audio is captured, and the
  session never reconfigures the app's audio session.

Threads: the session queue handles configuration and start/stop. The capture queue owns the
clock, the round, the writer and the throttle, and never blocks. Vision and JPEG work each run on
their own queue. Events reach JS on the main thread. Cross-queue flags sit behind a lock.

## JS

```ts
const pose = await importSafely(() => import('../../modules/dance-pose'));
if (!pose.isDancePoseAvailable()) {
  // Old binary: offer the debug replay.
}
const ref = useRef<DancePoseHandle>(null);
<pose.DancePoseView ref={ref} active maxFps={30} onPoses={(e) => feed(e.nativeEvent)} />;
await ref.current?.startRound({ snapshotAtMs: [2000, 6000, 10000, 14000] }); // {ok}
const { clipUri, clipSha256, snapshots } = await ref.current!.stopRound();
```

Importing the module never throws. Without the native module, `isDancePoseAvailable()` is false,
the view renders a black box and reports `no_camera` once, and the ref answers
`startRound → {ok: false}`, an empty `stopRound` and `captureStill → {ok: false}` (also in a
binary built before `captureStill` existed). `toPoseFrame`, `toStatusEvent`, `toStillResult` and
`toStopRoundResult` validate payloads, for example frames replayed from a saved session.
`JOINT_ORDER` and `joint(k, name)` read keypoints. The pure helpers live in `src/frame.ts` and are
tested in node by `__tests__/dancePose.test.ts`.

## Rebuild (native change: a new dev client is required)

Autolinking finds this module because `apps/mobile/modules` is the default `nativeModulesDir`
of expo-modules-autolinking. Neither `app.json` nor a plugin needs an entry for it. The binary
must be rebuilt, and `expo.version` in `app.json` is bumped, because runtimeVersion follows
appVersion:

```sh
cd apps/mobile
npx expo prebuild -p ios --clean          # regenerates ios/, picks up modules/dance-pose
(cd ios && pod install)                   # "Installing DancePose" should appear
npx expo run:ios --device                 # or the EAS dev-client profile
```

The repo-wide `ios/` ignore rule would otherwise hide `modules/dance-pose/ios/`, so the root
`.gitignore` and `.easignore` both re-include `apps/mobile/modules/*/ios/` (in `.gitignore`, the
line `!apps/mobile/modules/*/ios/` sits directly after `ios/`). Check before committing:
`git check-ignore -v apps/mobile/modules/dance-pose/ios/DancePose.podspec` must print nothing
(exit 1). If it prints `.gitignore:10:ios/`, the podspec and Swift sources are not committed, and
every other checkout builds without the module (the dance screen then always shows no camera).

## On-device test checklist

1. The simulator shows a black box and reports `no_camera` ("No back camera"). It must not crash.
2. First use on a device: the camera prompt appears. Deny it and `no_camera` arrives. Allow it
   (Settings) and `starting` then `running` arrive.
3. The preview is upright in portrait and letterboxed, not cropped. `onPoses.w/h` are 720/1280.
4. One person: raise your left hand. The `leftWrist` y drops toward 0 (top) and x matches the
   image. Nose y is less than ankle y.
5. Two people: `people.length === 2`, and `fps` holds about 25 to 30 on an iPhone 12 or newer.
6. `startRound` gives `{ok: true}` and then `recording`. `t` restarts near 0 and grows in real
   time.
7. After 15 s, `stopRound` returns a `file://` mp4 that plays in about 15 s. `clipSha256` equals
   `shasum -a 256` of the file once it is pulled off the device.
8. Four snapshots come back, each ≤ 512 px and ≤ 200 KB, with `t_ms` near the requested times.
   The JPEG shows the same moment as the clip at `t_ms`.
9. Toggle `active` off and on, and navigate away and back. The camera stops and resumes, and the
   green camera dot goes off after leaving the screen.
10. A call or Control Center interruption reports `error` "Camera interrupted", then `running`.
11. `stopRound` without `startRound` resolves `{clipUri: null, clipSha256: null, snapshots: []}`.
