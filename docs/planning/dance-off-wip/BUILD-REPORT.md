# Dance Off build — WIP snapshot (workflow wf_9afc6ab2-9e9, stopped during Fix phase)

## native:dance-pose
I built the DancePose local Expo module (contract §6.1). Nothing has been compiled or run: no build, no pod install, no tsc, no vitest. The only checks I ran were the `.easignore` rules, using `git check-ignore` in a scratch repo and the `ignore@5.3.2` package (the matcher eas-cli uses). Both confirm the module's ios/ folder is now uploaded while apps/mobile/ios stays ignored.

**Expo APIs checked against the installed versions** (expo-modules-core 58.0.30, autolinking 58.0.17):
- The `View` builder, and `AsyncFunction` with the view as first argument and `Promise` last. The builder sets `takesOwner` and runs these on the main queue.
- `Prop` setters run on the main thread. `EventDispatcher` properties are bound by property name.
- `Record`/`@Field` for the options struct.
- The first view becomes the module's default view, so `requireNativeView('DancePose')` (exported from 'expo') finds it.
- `requireOptionalNativeModule` comes from 'expo'.
- `./modules` is scanned by default. With no package.json the module name is the folder name, and the pod is found at ios/*.podspec.

**Native side.** The podspec copies the expo-video shape: swift_version 5.9, ios 16.4, ExpoModulesCore, plus the AVFoundation, Vision, CoreImage, CoreMedia, CoreVideo, ImageIO and CryptoKit frameworks. expo-video calls view methods from AsyncFunction closures the same way under 5.9, so this pattern already builds in this app.
- **Queues.** The pipeline class `DancePoseEngine` uses five threads:
  - session queue: setup and start/stop
  - capture queue: the clock, the round, the writer, the throttle and the fps estimate; it never blocks
  - vision queue: the body-pose request, pinned to Revision1, with orientation `.up`
  - snapshot queue: the JPEGs
  - main thread: every event

  The flags shared across queues sit behind a lock.
- **Camera.** The connection is rotated to portrait (`videoRotationAngle` 90 on iOS 17+, else `.portrait`), so buffers arrive upright at 720x1280. The pixel format is 420f, falling back to BGRA. There is no audio input, and the session never takes over the app's audio.
- **Rounds.** t0 is the first frame after `startRound`. The writer starts at that frame's timestamp and gets every frame, including ones the pose throttle drops. Snapshots come out at most 512 px and 200 KB, with a SHA-256 each. `stopRound` finishes the writer, collects the snapshots, then streams the clip through SHA-256. A failed recording returns `clipUri: null` and still returns the snapshots.
- **Lifecycle.** The camera runs only while `active` is true and the view is on screen. Removing the view abandons the round and stops the session.
- **Status.** `no_camera` is sent on the simulator or when access is denied. `error` is sent on a runtime error, an interruption or a recording failure.

**Addition beyond the spec.** Every onPoses event also carries `ts`, ms since the session started. Pre-round frames (framing, count-in) can then be placed on the round clock as negative times, which PoseSeries allows (−3000..20000).

**JS side.** index.ts exports:
- `DancePoseView`, wrapped in `forwardRef`, with the handle `startRound` / `stopRound`
- `isDancePoseAvailable`
- every requested type
- pure validators, constants and `joint()` in src/frame.ts

Importing never touches native code. Without the module, the view renders black, reports `no_camera` once, and the handle answers `{ok: false}` and an empty `stopRound`.

**Other changes:**
- `app.json` version 1.0.0 → 1.1.0 (runtimeVersion follows appVersion). No test pins the version, and no plugin or plist entry is needed.
- `.easignore` now re-includes `apps/mobile/modules/*/ios/`.
- Tests are in modules/dance-pose/__tests__/dancePose.test.ts. They cover the pure helpers plus source-scanning guards: Swift and TS joint order match, module name, events, props, functions and payload keys, podspec target equal to app.json, the pinned revision and the y-flip, and the `.easignore` order.

**Files:** /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/modules/dance-pose/expo-module.config.json, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/modules/dance-pose/ios/DancePose.podspec, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/modules/dance-pose/ios/DancePoseModule.swift, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/modules/dance-pose/ios/DancePoseView.swift, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/modules/dance-pose/ios/DancePoseEngine.swift, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/modules/dance-pose/ios/DancePoseFiles.swift, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/modules/dance-pose/ios/PoseExtraction.swift, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/modules/dance-pose/index.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/modules/dance-pose/src/types.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/modules/dance-pose/src/frame.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/modules/dance-pose/src/native.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/modules/dance-pose/src/DancePoseView.tsx, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/modules/dance-pose/__tests__/dancePose.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/modules/dance-pose/README.md, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/app.json, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/.easignore

**API:** apps/mobile/modules/dance-pose/index.ts:
- Component: DancePoseView = forwardRef<DancePoseHandle, DancePoseViewProps>
  - props: { style?: StyleProp<ViewStyle>; active: boolean; maxFps?: number /*1..60, default 30*/; onPoses?(e:{nativeEvent:PoseFrameEvent}):void; onStatus?(e:{nativeEvent:StatusEvent}):void }
- DancePoseHandle { startRound(opts:{snapshotAtMs:number[]}): Promise<StartRoundResult /*{ok:boolean; message?:string}*/>; stopRound(): Promise<StopRoundResult> }
- isDancePoseAvailable(): boolean
- DANCE_POSE_MODULE = 'DancePose'
- Types:
  - PoseFrameEvent {t:number; ts?:number /*ms since session start, always sent by native*/; w:number; h:number; fps:number; people:{k:number[]}[]}
  - StatusEvent {state: DancePoseState; message?:string}
  - DancePoseState = 'starting'|'running'|'recording'|'error'|'no_camera'
  - StopRoundResult {clipUri:string|null; clipSha256:string|null; snapshots: DanceSnapshot[]}
  - DanceSnapshot {t_ms:number /*int*/; uri:string /*file://*/; width:number; height:number; bytes:number; sha256:string /*lowercase hex*/}
  - StartRoundOptions, StartRoundResult, DancePoseViewProps, JointName
- Pure helpers (src/frame.ts, node-safe):
  - JOINT_ORDER (19 names, contract order), KEYPOINT_COUNT=57, DEFAULT_MAX_FPS=30, SNAPSHOT_MAX_LONG_SIDE=512, SNAPSHOT_MAX_BYTES=200000
  - clampMaxFps(n?), joint(k, name) -> [x,y,c]|null
  - toKeypoints(raw) -> number[]|null, toPoseFrame(raw) -> PoseFrameEvent|null, toStatusEvent(raw) -> StatusEvent|null, toStopRoundResult(raw) -> StopRoundResult, emptyStopResult()

Native (Swift):
- module Name("DancePose"), class DancePoseModule
- default view DancePoseView: Events onPoses/onStatus; Props active (Bool?), maxFps (Double?); AsyncFunction startRound(view, StartRoundOptions{snapshotAtMs:[Double]}, promise), stopRound(view, promise)
- Files are written to Caches/dance-pose/ (round-<id>.mp4, snap-<id>-<i>.jpg); files older than 24 h are pruned.

**Requests:**
- ROOT /.gitignore (required, blocking): add the line `!apps/mobile/modules/*/ios/` directly after the existing `ios/` rule. Today `git check-ignore -v apps/mobile/modules/dance-pose/ios/DancePose.podspec` matches `.gitignore:10:ios/`, so the Swift sources and the podspec would never be committed (git status will not show them). Once .easignore uploads that folder, eas-preflight's 'upload has nothing git ignores' audit would also fail. The drift test in easConfig.test.ts skips `!` lines, so it is unaffected.
- apps/mobile/vitest.config.mts: change include to ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'modules/**/*.test.ts'] so apps/mobile/modules/dance-pose/__tests__/dancePose.test.ts runs (pure node test, no React Native imports).
- Optional, apps/mobile/src/__tests__/easConfig.test.ts, 'keeps everything the build and the workspace install need': add 'apps/mobile/modules/dance-pose/ios/DancePose.podspec' and 'apps/mobile/modules/dance-pose/ios/DancePoseModule.swift' to the `needed` list. Both pass against the new .easignore (checked with git check-ignore and the ignore package).
- Mobile-app agent: load via `importSafely(() => import('../../modules/dance-pose'))` (the path is relative from src/<area>/), gate on `isDancePoseAvailable()`, and call startRound only after onStatus 'running'. Otherwise it resolves {ok:false, message:'camera is not running'}. Use the `ts` field to place framing/count-in frames on the round clock (t_round = ts - ts_of_first_round_frame). Map StatusEvent states to your own copy; the native `message` strings are for logs and diagnostics only.
- Lead/orchestrator: after merge, run `npx expo prebuild -p ios --clean`, then `pod install`, then a new dev-client build (native change; expo.version is now 1.1.0). Then work through the on-device checklist in apps/mobile/modules/dance-pose/README.md.
- Run `prettier --write` on apps/mobile/modules/dance-pose/** before `format:check`. I formatted by hand to the repo's prettier rules but could not run prettier.

**Open issues:**
- Never compiled. The Swift was written against the installed expo-modules-core 58.0.30 sources and mirrors the patterns of expo-video and expo-camera (Swift 5.9 language mode, calling view methods from AsyncFunction closures), but it has not been through Xcode.
- The tests are written but not run, and they will not run at all until the vitest include is widened (see requests).
- The preview layer is fixed to portrait. app.json orientation is 'default', so if the UI rotates to landscape the preview will look sideways. The dance screen should stay portrait.
- The connection is rotated to portrait, so buffers are rotated on the capture path, and at most one Vision request is in flight. Whether two people at 720p hold 25 to 30 pose fps is untested; it needs a real phone.
- The frame rate is locked to 30 fps after the preset and input are set. If a device resets that on startRunning, the preset's default rate applies; harmless.
- The camera can be held by only one screen at a time. If VisionCamera or expo-camera is still mounted while DancePoseView is active, they will contend for it.
- Snapshot time is the actual frame time (rounded to whole ms) of the first frame at or past each requested time. If several requested times fall on one frame, they each get a JPEG of the same frame. A snapshot that fails to encode is left out of the list, so callers should check the count.
- pod source is `{ git: '' }`, as in Expo's local-module template, and there is no package.json; autolinking names the package 'dance-pose'. Verified by reading the autolinking code, not by running pod install.

## tools:dance-ref
I built the reference routine tool from contract §8 as a new Swift package in tools/dance-ref. Nothing was compiled, built or run, as the task required. That includes `swift build` and `swift test`.

**Layout** (swift-tools-version 5.9, macOS 14+, no outside dependencies):
- `DanceRefCore`: pure logic that doesn't touch AVFoundation or Vision, so it can be unit tested.
- `dance-ref`: the executable, an `@main` async CLI.
- `DanceRefCoreTests`: XCTest unit tests.

**How it works:**
- `AVAssetReaderTrackOutput` decodes BGRA frames over [start, start + duration + 1 s]. The track `preferredTransform` (a, b, c, d) is mapped to an EXIF orientation; iPhone portrait (0,1,-1,0) becomes `.right`, and all 8 axis-aligned cases are covered. That orientation becomes a `CGImagePropertyOrientation` passed to `VNImageRequestHandler(cvPixelBuffer:orientation:)`.
- `FrameSampler` keeps the first frame at or after each 1/fps tick, with 1 ms tolerance.
- `VNDetectHumanBodyPoseRequest` runs with `revision = VNDetectHumanBodyPoseRequestRevision1`. The tool checks that revision against `supportedRevisions` and stops if it is missing.
- The tool keeps one person per frame: the one with the highest joint bounding-box area in pixels × mean confidence over 19 joints.
- It writes the 19 joints in contract order, as y → 1−y, values clamped to [0,1] with NaN becoming 0, and a missing joint as 0,0,0. `--mirrored` flips x and swaps L/R using an involutive mirror index.
- `w`/`h` are the upright pixel size taken from the decoded buffer. Frames with nobody in them are left out and counted. `t` is whole ms since `--start-ms`, strictly increasing.

**Key moves:**
- From `--key-moves` (validated in range, no duplicates).
- Or from `--every K` (needs `--bpm`): beats anchored on `--first-beat-ms`, skipping beats before 500 ms and after duration−500 so the §4.6 judging windows fit. With neither option, `key_moves` is left out.
- Ids are `km01…`; names are "Move N" or come from `--key-move-names`. It warns when the count is outside 8–16, when a move is near the end, or when two moves are under 700 ms apart.

**JSON output:** a hand-rendered, locale-independent file, one frame per line, with exactly the RoutineData keys: schema_version 1, id, version, title, song, bpm, duration_ms, first_beat_ms, count_in_beats 3, w, h, mirrored_source false, source 'vision', frames, optional key_moves, and media {video: null, audio: null}. Floats have 6 decimals with trailing zeros removed.

**Summary output:**
- Frames written and analysed, the time span, mean confidence, and frames with no person or more than one person.
- Per-joint counts below 0.3 (the scorer's MIN_CONF), and absent counts.
- Warnings on stderr: a short video, joints the scorer uses being weak in over 10% of frames, low confidence, a missing `--bpm` (defaults to 120), `--duration-ms` other than 15000, and `--fps` above the source frame rate.

**Other flags:** `--routine-version` (default 1). I used that name because `--version` normally prints the tool's own version. `--id` must match `[a-z0-9][a-z0-9_-]*` (max 48); by default it is a slug of the video's file name.

**README:** covers the whole workflow. It explains choreography for two dancers side by side, music that is royalty-free or from ElevenLabs Music (never copyrighted songs), and recording: one dancer, full body, steady tripod, plain background, back camera, a 2 s silent lead-in, a wired speaker, and a left-hand check for mirroring. The ffmpeg steps use silencedetect to find where the music starts, then trim and mux the clean track into apps/mobile/assets/dance/<id>.mp4 (with an hflip variant for mirrored footage). It then shows the `swift run --package-path tools/dance-ref -c release dance-ref ...` command, the import and selftest commands, and setting `media`. The README says plainly that none of this has been built or run, and the user should do it later.

**Files:** /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/tools/dance-ref/Package.swift, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/tools/dance-ref/.gitignore, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/tools/dance-ref/README.md, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/tools/dance-ref/Sources/dance-ref/DanceRef.swift, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/tools/dance-ref/Sources/DanceRefCore/Joints.swift, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/tools/dance-ref/Sources/DanceRefCore/Orientation.swift, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/tools/dance-ref/Sources/DanceRefCore/Sampling.swift, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/tools/dance-ref/Sources/DanceRefCore/KeyMoves.swift, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/tools/dance-ref/Sources/DanceRefCore/Options.swift, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/tools/dance-ref/Sources/DanceRefCore/RoutineJSON.swift, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/tools/dance-ref/Sources/DanceRefCore/Summary.swift, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/tools/dance-ref/Tests/DanceRefCoreTests/DanceRefCoreTests.swift

**API:** CLI: dance-ref <video> -o <out.json> [--fps 15 (1..30)] [--id slug] [--title] [--song] [--bpm (40..240; default 120 with a warning)] [--first-beat-ms 0] [--routine-version 1] [--key-moves ms,ms,... | --every K] [--key-move-names a,b,...] [--mirrored] [--start-ms 0] [--duration-ms 15000]. Exit 64 on a usage error, 1 on any other failure.
Output JSON (the input for 'scripts/dance-routine.ts import'): {schema_version:1, id:string, version:int, title:string, song:string, bpm:number, duration_ms:int, first_beat_ms:int, count_in_beats:3, w:int, h:int, mirrored_source:false, source:'vision', frames:[{t:int ms, strictly increasing, k:number[57] floats in [0,1], x,y top-left upright unmirrored, missing joint = 0,0,0}], key_moves?:[{id:'km01'..., t:int, name:string}] (omitted when neither --key-moves nor --every is given), media:{video:null, audio:null}}.
Frames where Vision found nobody are left out, so gaps are possible.

**Requests:**
- scripts/dance-routine.ts (another agent) 'import <json>': accept exactly the key set above. In particular: 'version' may be a number other than 1; 'key_moves' may be absent (the importer picks beats then); key move ids look like 'km01'; frames can have gaps where Vision saw nobody (don't assume a fixed cadence); 'source' is 'vision'; 'media' is {video:null, audio:null}. If the importer zod-parses strictly, it should not reject these keys. CLI flags given to import (e.g. --id) should override or match the JSON's id.
- Whoever owns the routine media convention (shared dance routines / the mobile reference player): define the exact form of 'media.video' (e.g. 'dance/<id>.mp4' resolved through a require() map in apps/mobile). README step 7 currently says 'set media.video to that asset in the form the mobile reference player resolves' and should be made concrete once that convention exists.
- Root .gitignore / .easignore owner (optional): decide whether apps/mobile/assets/dance/*.mp4 is committed (the README aims for about 4 MB or less per clip) or gitignored and fetched like the .tflite model. tools/dance-ref/.gitignore already ignores .build/, .swiftpm/, work/, *.mov, *.wav and *.json inside the tool directory.

**Open issues:**
- None of this has been compiled or run (no swift build or swift test, by rule). The first build may need small fixes. The riskiest spots are the async AVFoundation load APIs (loadTracks, load(.preferredTransform, .naturalSize, .nominalFrameRate)), the throwing closure inside autoreleasepool, and the XCTest bridging assertions in JSONTests.
- Assumption: the phone module also uses VNImageRequestHandler with the upright orientation (back camera portrait = .right) and Revision1. If the phone instead passes .up and rotates coordinates itself, the results should be the same geometrically but are unverified.
- Person pick has no temporal continuity: it picks the largest/most confident person per frame. That is fine for a one-dancer reference, but a bystander would only be warned about, not tracked out.
- KEY_LEAD_MS=500 and KEY_TAIL_MS=500 for --every are my own choices, derived from the §4.6 window [t-200, t+500]. The importer may re-snap or re-pick beats.
- The ffmpeg commands in the README (silenceremove/silencedetect thresholds, autorotate behaviour, crf target) are untested on real footage.
- Tests are XCTest under tools/dance-ref/Tests. They need Xcode's toolchain (installed at /Applications/Xcode.app) and are not part of any vitest suite or README test count.

## shared:scorer+contracts
I built the shared foundation for Dance Off in packages/shared/src/dance/, plus the hashed-record widenings, the wire schemas, the routine tool and the docs. I ran only what the task allowed: the three new dance test files (45/45 pass) and `scripts/dance-routine.ts synth` and `selftest`. Every routine scores exactly 100.0 against itself, all key moves PERFECT. I did not run tsc or prettier. I reviewed types by hand, but some type errors may still be there.

**Scorer (`dance-score@1`).** It follows contract §4 and uses only + − × ÷ and Math.sqrt on dequantized ints (Math.pow only in the display curve).
- Limbs are aspect-correct unit vectors; joints below MIN_CONF are skipped. Limb weights are 1.5 arms / 1.0 legs / 0.8 torso, remapped through COS_FLOOR.
- Lag: each player frame takes its best match in the window [t−500, t+200] ms, with a penalty past a grace period. When two matches are equally good, the one with the smaller |lag| wins. Without that, held poses broke the self-score.
- Movement: overlap is Σmin/Σmax of limb angular speeds, with a dead zone so pose jitter doesn't count as movement. It multiplies the continuous score and gates key moves.
- Each player is scored under both conventions (identity and mirror) and keeps the better one. Coverage is time-based (500 ms bins).
- The live scorer runs the same functions, and its `final()` is exactly `scoreRound` over the quantized series it built. A test checks this.

**Calibration.** Synthetic players come from a seeded LCG (slow per-limb angle errors, keypoint jitter, lag):
- pro: 92–94
- better: 81–87
- amateur (12°, ~250 ms late): 66–83
- 18° amateur: 46–59
- sloppy: 0–17
- half routine: 30–42
- standing still: 0
- In 20 seeded head-to-heads the better dancer won all 20.

The constants that changed during calibration are COS_FLOOR 0.75, PERFECT_AT 0.95, GOOD_AT 0.82, RAW_CEIL 0.95 and CURVE_GAMMA 0.9.

**Decisions:**
- **Tracker:** it uses the cheapest-total assignment for the two slots plus a constant-velocity prediction, rather than plain greedy matching. This keeps identities when players cross. Side-swap semantics are as specified.
- **`too_close`:** it is the margin check only. A failed round has `winner` null, and the ruling helper treats failed as VOID.
- **`DanceEvidence.failed`:** it is the enum coverage_a | coverage_b | no_frames rather than a free string.
- **`dance.scored` validation:** the contract and the task disagreed. It carries both `verdict` ('valid'|'invalid'|'skipped') and `skipped`, with a refine that requires them to agree.
- **Challenge category:** dance stays 'other', so the category enum and odds tables are untouched.
- **Typed endpoint:** `TypedTermsRequest.type` is narrowed to skill|real_world, so a dance off can only come through /terms/dance.
- **Cross rules:** `mapProposeTermsArgs` now checks dance_off fields, including that `success_criteria[0]` names a bundled routine.
- **Unchanged:** the voice agent's `PROPOSE_TERMS_BODY_SCHEMA` and the el-config tool counts. Golden vectors and doc hashes are untouched.

**Hashes and docs:** routine sha16s are wave-pop 812f15c411edd626, bounce-back 7cfedcae2fd032a0 and side-shuffle 70b4dc8ccb3953ae. SCHEMAS.md documents the widenings in §2.1/§2.2, a new §2.7, a new §4.2, §5.2, §10.1, §11 rule 4 and the changelog. No new control frames.

**Files:** /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/dance/joints.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/dance/pose.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/dance/routine.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/dance/routines/wave-pop.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/dance/routines/bounce-back.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/dance/routines/side-shuffle.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/dance/track.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/dance/score.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/dance/terms.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/dance/evidence.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/dance/index.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/judge/dance-terms.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/index.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/terms.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/ruling.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/evidence.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/realtime.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/api.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/stage-voice.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/judge/propose-terms.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/judge/typed-terms.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/judge/reply.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/test/review.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/test/dance-helpers.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/test/dance-score.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/test/dance-track.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/test/dance-terms.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/scripts/dance-routine.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/docs/planning/SCHEMAS.md

**API:** ROOT `@youre-on/shared` re-exports all of dance/* (also importable as `@youre-on/shared/dance/index` or per file, e.g. `@youre-on/shared/dance/score`).

joints.ts: JOINT_NAMES (19, contract order); type JointName; JOINT_COUNT=19; KEYPOINT_LEN=57; JOINT {nose:0..rightAnkle:18}; JOINT_SWAP: readonly number[]; MID_HIP_POINT=19; NECK_POINT=20; POINT_COUNT=21; LIMB_IDS ['l_upper_arm','r_upper_arm','l_forearm','r_forearm','l_thigh','r_thigh','l_shin','r_shin','torso']; type LimbId; LIMB_COUNT=9; LIMBS: readonly {id,from,to,group:'arm'|'leg'|'torso'}[]; LIMB_SWAP; SKELETON_EDGES: readonly [number,number][]; mirrorKeypoints(k: readonly number[]): number[] (floats; flip x, swap L/R).

pose.ts: POSE_SCHEMA_VERSION=1; POSE_XY_SCALE=10000; POSE_C_SCALE=1000; POSE_MAX_FRAMES=700; POSE_MAX_FPS=30; POSE_T_MIN_MS=-3000; POSE_T_MAX_MS=20000; SYNC_OFFSET_MAX_MS=500; PoseKeypoints (zod int[57]); PoseFrame = strict {t,n,a:int[57]|null,b}; PoseSeries = strict {schema_version:1,w,h,fps_cap,sync_offset_ms,frames}; quantizePerson(k: readonly number[]): number[]; dequantizePerson(q: readonly number[]): number[]; poseSha256(series: PoseSeries): string.

routine.ts: ROUTINE_DURATION_MS=15000; RoutineId; RoutineKeyMove; RoutineData (zod + type); interface RoutineRef {id,version,sha256}; routineSha256(r): string (cached); routineRef(r): RoutineRef; ROUTINES: readonly RoutineData[] (exactly 3: 'wave-pop' 120bpm, 'bounce-back' 112bpm, 'side-shuffle' 128bpm; 720x1280, 15fps, 11-12 key moves); ROUTINE_IDS; getRoutine(id): RoutineData|null; beatMs(r): number.

track.ts: DANCE_TRACKING {FRAMING_CONF:0.3, FRAMING_CENTER:0.5, FRAMING_GAP:0.02, TRACK_*, SWAP_MIN_MS:1000}; type FramingReason = 'ok'|'need_two'|'too_many'|'feet'|'head'|'same_side'|'too_close'; framingCheck(people: readonly (readonly number[])[], w, h): {ok, reason, a?: number, b?: number}; hipCenter(k, minConf?): [x,y]|null; createTracker({w,h}): Tracker { push<P extends readonly number[]>(t, people: readonly P[]): {t, n, a: P|null, b: P|null}; stats(): {frames,max_people,frames_over_two,side_swaps}; started(): boolean }; seriesChecks(series: PoseSeries): {max_people, frames_over_two, side_swaps}. Inputs are RAW floats [0,1].

score.ts: DANCE_SCORER_VERSION='dance-score@1'; DANCE_SCORING {...all constants...}; type DanceConvention='identity'|'mirror'; KeyMoveGrades; type KeyMoveGrade='PERFECT'|'GOOD'|'MISS'; type DanceFailure='coverage_a'|'coverage_b'|'no_frames'; scoreRound(routine: RoutineData, series: PoseSeries): DanceRoundResult; interface DanceRoundResult {scorer_version, a: DancePlayerScore, b, winner: 'A'|'B'|null, too_close: boolean /* margin only */, failed: DanceFailure|null}; interface DancePlayerScore {score_x10:int 0..1000, raw, key_moves: KeyMoveResult[] {id,name,t,grade,sim,lag_ms,moved}, key, continuous, mean_sim, movement, convention, coverage_pct:int, mean_lag_ms:int, limbs: Record<LimbId,number>, frames_scored}; keyMoveBreakdown(r): {id,a,b}[]; decideRound(a,b,failed): {winner,too_close}; displayX10(raw): number; createLiveScorer(routine, opts?: {syncOffsetMs?, w?, h?, fpsCap?}): LiveScorer { push(f: {t, n, a: readonly number[]|null, b: readonly number[]|null, w?, h?}): LiveUpdate; series(): PoseSeries; final(): {series: PoseSeries; result: DanceRoundResult} }; LiveUpdate = {a: LivePlayerState, b: LivePlayerState, events: {key_move_id, name, t, player:'A'|'B', grade}[]}; LivePlayerState = {meter: 0..100, sim: number|null, lagMs: number|null, limbs: (number|null)[9], convention}. Lower-level helpers are also exported: limbVectors(k,w,h), mirrorLimbs, limbSimilarity, lagFactor, normalizePose, isScorablePose, routineModel, bestLagMatch, newTrack, trackAdd, gradeKeyMove, finishPlayer, LIMB_WEIGHTS.

dance/terms.ts: DANCE_TERMS_TYPE='dance_off'; DANCE_ROUND_SECONDS=15; DANCE_TIE_MARGIN_POINTS=2; isDanceOff(t: Pick<Terms,'type'>): boolean; danceClaim(r, stakeMicro): string; danceRoutineLine(r): string; DANCE_RULE_LINE; danceTermsText(r, stakeMicro): {claim, success_criteria:[string,string], failure_criteria:[]}; parseDanceRoutineLine(line): {routine_id,version,sha16}|null; parseDanceTermsRoutine(terms: Pick<Terms,'type'|'success_criteria'>): {ok:true, routine, routine_id, version, sha16} | {ok:false, reason:'not_dance'|'malformed'|'unknown_routine'|'version_mismatch'|'sha_mismatch'}.

dance/evidence.ts: buildDanceEvidence({bet_id, attempt_no, terms_hash, routine, series /*parsed*/, frames: EvidenceFrame[], clip_sha256: string|null}): {evidence: DanceEvidence; result: DanceRoundResult}; danceRulingOutcome(e: {winner,too_close,failed}, valid: boolean): {outcome:'A_WINS',claim_result:'MET',void_reason:null}|{outcome:'B_WINS',claim_result:'NOT_MET',void_reason:null}|{outcome:'VOID',claim_result:'UNCLEAR',void_reason:'undecidable'}.

evidence.ts (root): DanceKeyMoveGrade; DanceFailureReason; DANCE_MAX_KEY_FRAMES=6; DANCE_FRAME_MAX_BYTES=200000; DanceEvidence (strict, exactly the contract §5 fields; failed is the enum); danceEvidenceHash(e): string; DanceUploadFrame {index,t_ms,sha256,width,height,bytes}; DanceUpload {routine_id, routine_sha256, series: PoseSeries, pose_sha256, client_scores:{a,b}, clip_sha256: Hex32|null, frames: DanceUploadFrame[1..6]}.

ruling.ts: DANCE_OFF_MODEL='rule/dance-off@1'; Ruling now allows void_reason 'undecidable' iff model === DANCE_OFF_MODEL.

terms.ts: TermsV1.type = 'skill'|'real_world'|'dance_off' (dance branch: camera, market null, performer null, yes_party 'A', single, stakes.a===stakes.b).

realtime.ts: DanceValidation {verdict:'valid'|'invalid'|'skipped', notes: string<=400, skipped: boolean} (refine: skipped === (verdict==='skipped')); DanceScoredPayload {evidence: DanceEvidence, evidence_hash: Hex32, validation: DanceValidation, announcer_line: string<=280}; RealtimeEvent gains 'dance.scored'; bet.invited payload gains rematch_of?: BetId, suggested_stake_usd?: number>0.

api.ts (subpath `@youre-on/shared/api`): re-exports DANCE_STAKES_USD, DanceTermsRequest, DanceTermsResponse, danceTermsPath; danceUploadPath(betId, attemptNo) = /v1/bets/:id/attempts/:n/dance; DanceUploadResponse {judging:true, evidence_hash, pose_sha256, scores:{a,b}, client_mismatch: boolean, frame_hashes: Hex32[]}; rematchPath(betId); RematchRequest = z.object({}); RematchResponse {bet_id: BetId, suggested_stake_usd: number}; suggestedRematchStakeUsd(stakes:{a,b}, maxStake=MAX_STAKE): number (2×max(a,b), capped, dollars to the cent).

judge/dance-terms.ts (subpath): danceTermsPath(betId) = /v1/bets/:id/terms/dance; DANCE_STAKES_USD=[1,5,10,20]; DanceTermsRequest {routine_id, amount_usd}; DanceTermsResponse = TypedTermsResponse; danceTermsArgs(req): ProposeTermsProjection|null (null for an unknown routine).

judge/propose-terms.ts: ProposeTermsArgs.type also accepts 'dance_off', with dance cross rules. judge/reply.ts: DANCE_READBACK_TAIL; readbackSay handles dance_off. judge/typed-terms.ts: TypedTermsRequest.type is 'skill'|'real_world' only. stage-voice: a VOID with model DANCE_OFF_MODEL speaks "<reason>. It's void: both stakes go back."

Script: `npx tsx scripts/dance-routine.ts synth | import <json> [--id --title --song --bpm --first-beat-ms --version --key-moves ms,ms | --every K] | selftest`.

**Requests:**
- apps/server (persistEvaluation/composeTerms path): the server must apply evaluateProposeTerms to danceTermsArgs(req) output and answer 404/400 when danceTermsArgs returns null. The odds autoOffer must SKIP type 'dance_off', because Terms rejects unequal dance stakes. The appeal/review/'check again' gates must treat dance_off like gemini (no appeal).
- apps/server dance ruling: build the Ruling with stage 'attempt', model DANCE_OFF_MODEL, confidence 1, cited_frames [], frame_hashes = evidence.frames[].sha256, evidence_hash = danceEvidenceHash(evidence), plus the outcome, claim_result and void_reason from danceRulingOutcome(evidence, validation.verdict !== 'invalid'). A too-close/failed/invalid reason should START with 'Too close to call.' (or name the problem), because the stage speaks the reason verbatim and then says "It's void: both stakes go back."
- apps/server dance.scored: emit DanceScoredPayload with validation.skipped === (verdict === 'skipped'). The payload has BOTH verdict (incl. 'skipped') and skipped, because the contract and the task text disagreed.
- apps/stage and apps/mobile: any test that pins RealtimeEvent type counts or lists (shared review.test.ts went from 43 to 44 with 'dance.scored') needs the new type. Mobile bets/store.ts and stage ticker.ts should fold 'dance.scored'. Mobile bets/view.ts kind currently only knows 'skill'|'market' and must handle terms.type 'dance_off'.
- apps/mobile: createLiveScorer needs the image w/h, either in opts or on the first pushed frame (onPoses w/h). Without them, frames are recorded but not live-scored and the series gets w=h=1. Feed it the tracker's assigned people (raw floats) in t order and with t in ms since round t0.
- README.md test counts (not mine): packages/shared gained 45 tests in 3 files (dance-score 17, dance-track 11, dance-terms 17).
- docs/planning/API-CONTRACT.md (not mine): document POST /terms/dance, POST /attempts/:n/dance (DanceUpload, DanceUploadResponse), POST /bets/:id/rematch (RematchRequest/Response), and the bet.invited rematch fields.

**Open issues:**
- I did not run tsc or prettier. I hand-checked the types, but there may still be type errors. The generated routine files are large literals with an explicit `: RoutineData` annotation and a `// prettier-ignore` above them; they may need a .prettierignore entry if format:check still complains.
- I did not run existing shared tests other than my 3 new files. By reasoning, these should still pass: review.test.ts (count updated to 44), ruling/stage-voice/judge/terms/realtime/sign-card/vectors tests. Golden hashes were not touched.
- The scorer is calibrated only on synthetic players (sinusoidal per-limb angle errors plus Gaussian keypoint jitter). Real Apple Vision data may need retuning of DANCE_SCORING, which means bumping the scorer_version. Synthetic profiles score: pro 92-94, amateur 66-83, standing 0.
- mean_lag_ms understates a constant lag, because held poses also match at lag 0 (a tie-break prefers the smallest |lag|). The value is for display only and does not affect scores.
- Contract deviation: DanceEvidence.failed is the enum coverage_a|coverage_b|no_frames rather than any string. too_close is the margin check only, and a failed round has winner null.
- Routine music and video are placeholders (media null; song strings say 'Placeholder click track, royalty-free'). The 3 routines are SYNTHETIC; real routines go through `scripts/dance-routine.ts import` from the macOS tool. A new id must also be added to ROUTINES in routine.ts.
- Pulling api.ts or the root barrel into the stage/mobile bundle now includes the 3 routine data files (about 80 KB of source each).

## server
I built the server side of Dance Off: the dance terms route, the dance attempt rules, the dance upload, validation and ruling, the appeal/review/replay gates, and the rematch route, with tests and API-CONTRACT docs. Following the hard rules, nothing was compiled, type-checked, prettier-formatted or run, so all of it is unverified. Types were checked by hand against the real signatures.

**Terms.** `POST /v1/bets/:bet_id/terms/dance` lives in `terms/routes.ts`. It allows party A only, in DRAFTING or TERMS_PROPOSED. It returns 422 for a bad amount and 404 `{routine_id, routines}` for an unknown routine. It calls `danceTermsArgs`, then `evaluateProposeTerms`, then `persistEvaluation` with source `'dance'`. I pulled the typed route's response switch out into a shared `typedResponse` helper. `presentationOf` now titles a dance card `Dance Off: <routine title>`. Odds skip dance offs on their own: `isOddsTerms` is skill-only, so confirm never waits on `odds_pending`.

**Attempts.** `termsFor` now accepts a dance off with `performer` null. For a dance off:
- Either party may record with `'self'`.
- `'judge_cam'` uses the room's judge cam of either party (`findDanceJudgeCam`).
- `max_ms` is `DANCE_MAX_MS` (30000).
- `performer` in the response and in `attempt.started` is the yes party, A, because that field must be a Party.
- `danceArmedCue` names both dancers.
- `/frames` refuses a dance off (409 `dance_upload`), and `/dance` refuses any other bet (409 `not_dance`).

Skill bets behave exactly as before.

**Upload.** `POST /v1/bets/:bet_id/attempts/:n/dance` is inside `createJudgeRoutes`, with a 2.5 MiB body limit. It reuses the recorder check and multipart parsing, now shared helpers that `/frames` also uses with its original messages. In order, it checks:
- the replay case: the same `pose_sha256` and frame hashes replay the 202 and restart a lost job;
- that the terms' routine is in the bundle (409 `routine_unavailable`);
- the routine id and sha (422 `wrong_routine`);
- `pose_sha256` (422 `EVIDENCE_HASH_MISMATCH`);
- each JPEG's magic, size and sha256.

It then re-scores the series on the server with `buildDanceEvidence`; client scores are only compared and a mismatch is logged. One transaction sets the attempt to judging. It stores `evidence_canonical = jcs(DanceEvidence)` and `attempts.evidence_hash = sha256(canonical)`. `client_clip_hash` is `clip_sha256`, or that hash as a stand-in when the phone kept no clip. It writes the `attempt_frames` rows, moves the bet to JUDGING, and emits `bet.state` and an audit row. There is no `attempt.evidence`, since its payload is CameraEvidence. Then the job starts.

**Ruling.** The job is now a union of camera and dance jobs. Both share one commit: the rulings row with `evidence_kind 'camera'` and `evidence_canonical` set, then `dance.scored`, then `ruling.issued`, then `judge.cue`. `restartJob` and `resumeStuck` rebuild a dance job from the stored evidence and take `evidence_hash` from `hashJcs` of that evidence, never from `client_clip_hash`.

The new `judge/dance.ts` holds the prompt, the hand-written wire schema (VALID listed first, so the mock's default answer is the happy path) and `callDanceValidator`:
- It uses `JUDGE_MODEL`, effort low, an 8 s timeout and stats source `'dance'`.
- With `cached_ruling` on, it returns a canned valid check and makes no call.
- If the call fails or the job is lost, the check counts as skipped and the round settles on the score. A dance round never gets a REDO.

`buildDanceRuling` uses `rule/dance-off@1` with confidence 1:
- **Winner:** decisive.
- **Too close or failed:** VOID `'undecidable'` with a "Too close to call…" reason.
- **Invalid:** VOID `'undecidable'`, and the reason names the problem.

The model's line is used only if it names the winner, or starts with "Too close to call" when there is no winner. Otherwise a canned line is used. The dance cues never say "three tries" or "check it again".

**Gates.** `isDanceOffBet` checks the final terms type, or failing that a dance ruling on the bet.
- Appeals: GET/POST return 409 `dance_off`, and no appeal request is pushed at RULED.
- Review: `request_review` answers `FINAL`.
- Slow-mo replay: returns `no_frames` for a dance ruling.

**Rematch.** I pulled the body of POST /v1/bets out into `createChallenge`; POST /v1/bets keeps its checks and their order. `POST /v1/bets/:id/rematch` (exported list `REMATCH_FROM`):
- Signed, either party, terminal states only, same room, caller becomes A, `supersedes_bet_id` set, `challenge_method 'list'`.
- The `bet.invited` event carries `rematch_of` and `suggested_stake_usd`.
- It shares the pair_busy check, the open-bet cap and the bets rate limit with POST /v1/bets.
- A repeat by the same caller while their rematch is still pre-lock returns that same bet.

No migration was needed.

**Files:** /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/server/src/judge/dance.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/server/src/judge/dance-bet.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/server/src/judge/routes.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/server/src/judge/cues.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/server/src/judge/stats.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/server/src/terms/routes.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/server/src/lock/terms.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/server/src/bets/routes.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/server/src/appeal/service.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/server/src/review/service.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/server/src/replay/routes.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/server/test/dance.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/server/test/rematch.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/docs/planning/API-CONTRACT.md

**API:** Routes (wire):
- POST /v1/bets/:bet_id/terms/dance (S, party A) body DanceTermsRequest -> 200 DanceTermsResponse (= TypedTermsResponse) | 404 {routine_id, routines} | 422 | 403 | 409
- POST /v1/bets/:bet_id/attempts (existing) for a dance off: either party may use recorder:'self'; 'judge_cam' = any judge cam of either party in the room; response/attempt.started performer = 'A'; max_ms = 30000
- POST /v1/bets/:bet_id/attempts/:n/dance (S, recorder device, multipart parts 'upload' = DanceUpload JSON, 'frame' x upload.frames.length) -> 202 DanceUploadResponse {judging, evidence_hash, pose_sha256, scores:{a,b}, client_mismatch, frame_hashes}; errors 422 VALIDATION_FAILED {reason:'wrong_routine'}, 422 EVIDENCE_HASH_MISMATCH {what:'pose'}, 422 FRAME_HASH_MISMATCH {index}, 413, 403 not_recorder, 409 ATTEMPT_NOT_OPEN, 409 INVALID_STATE {reason:'not_dance'|'routine_unavailable'}
- POST /v1/bets/:bet_id/rematch (S, either party, body {}) -> 201 {bet_id, suggested_stake_usd, bet: BetSnapshot, voice:{dynamic_variables}} (superset of RematchResponse); 409 {reason:'not_finished'|'no_rematch'|'pair_busy'}
- Events: dance.scored (DanceScoredPayload) right before ruling.issued in the same commit; judge.cue RULING (kv outcome, winner, score "84.2-61.0", reason, gg_secs) or VOIDED {reason:'undecidable', why:'too_close'|'invalid'|'coverage_a'|'coverage_b'|'no_frames'}; bet.invited gains rematch_of + suggested_stake_usd on a rematch.
- Ruling for dance: model 'rule/dance-off@1', confidence 1, stage 'attempt', void_reason 'undecidable' for VOID, evidence_hash = hashJcs(DanceEvidence), reason = announcer line.
- Appeal GET/POST on a dance off -> 409 INVALID_STATE {reason:'dance_off'}; request_review -> fix 'FINAL'; GET /replay -> {replay:null, why:'no_frames'}.

TS exports (apps/server):
- judge/dance.ts: DANCE_TIMEOUT_MS=8000, DANCE_MAX_OUTPUT_TOKENS, DANCE_CACHED_MODEL='cache/demo-dance@1', DANCE_SYSTEM_PROMPT, DANCE_VALIDATION_JSON_SCHEMA, DanceValidatorVerdict, DANCE_OUTPUT, type DanceCheck, DanceNames, DanceValidatorInput, danceScore(x10), clipText(s,max), cannedDanceLine(e,names), danceTermsBlock, danceResultText, buildDanceParts(input), callDanceValidator(deps,input): Promise<DanceCheck>, DanceRulingContext, DanceRuled, buildDanceRuling(ctx, evidence, check, names): {ruling, validation, announcer_line}
- judge/dance-bet.ts: isDanceOffBet(db: Pick<Tx,'select'>, betId): Promise<boolean>
- judge/cues.ts: danceArmedCue(attemptNo, names), type DanceVoidWhy, danceRulingCue(ruling, scores, why, names, ggSecs)
- judge/routes.ts: DANCE_MAX_MS=30000, DANCE_BODY_LIMIT (2.5 MiB)
- judge/stats.ts: JudgeCallSource = 'ruling'|'warmup'|'dance'
- bets/routes.ts: REMATCH_FROM ['PAID','VOIDED','FINALIZED','EXPIRED'], interface ChallengeInput, createChallenge(deps, input): Promise<{row, refA, refB}>

**Requests:**
- Mobile (apps/mobile): for a dance_off bet, decide routes and who starts from Terms.type, never from attempt.started.performer (the server sends 'A' because that field must be a Party). Either phone may call POST /attempts with recorder 'self'; startAttemptVia's judge_cam-then-self fallback still works. max_ms is 30000. Upload with danceUploadPath / DanceUpload / DanceUploadResponse. No attempt.evidence event is sent for a dance round. dance.scored arrives just before ruling.issued.
- Mobile GG/ruling screens: hide appeal and 'check it again' for a dance off. The server refuses an appeal with 409 INVALID_STATE {reason:'dance_off'}, request_review answers FINAL, and no appeal tx.sign_request is pushed.
- Mobile rematch: POST rematchPath(betId) with {} returns 201 {bet_id, suggested_stake_usd, bet, voice:{dynamic_variables}}. This is a superset of the shared RematchResponse, so RematchResponse.parse still works. A repeat by the same caller returns the same bet. 409 pair_busy means the other player already asked for a rematch.
- Stage (apps/stage): handle the new 'dance.scored' event if it should show the scores; otherwise it is dropped as an unknown type. A dance VOID's ruling-time judge.cue VOIDED carries {reason:'undecidable', why} and no a/b values, so stage-voice does not speak it twice.
- DANCE-OFF.md §5/§7 (owner of the contract doc): optionally note that (a) the validator's wire verdict enum is upper-case VALID|INVALID, mapped to valid|invalid; (b) the rematch 201 also carries bet + voice; (c) a dance attempt's attempt.started.performer is 'A'; (d) a dance key frame JPEG is capped at 200 KB (DANCE_FRAME_MAX_BYTES), and the DB CHECK allows 204800.

**Open issues:**
- Nothing was compiled, type-checked, prettier-formatted or run (class rule). The tests in apps/server/test/dance.test.ts and rematch.test.ts are unexecuted and need Postgres (describeDb). Possible TS errors in the new code: narrowing on `dance !== null && dance.ok` in lock/terms.ts, the `respond` closure's typing in the rematch route, and the `c.json` union return.
- dance.test.ts assumes the shared scorer's self-score is exactly 1000 (per the shared report) and that a held first pose scores near 0. It builds series from ROUTINE.frames with fps_cap 15. If the scorer disagrees, the pure test asserting scores.a === 1000 fails.
- The keeper-sweep test calls resumeStuck, which scans all judging attempts across the shared test DB (limit 20). A parallel suite's stuck attempts are skipped because their terms aren't injected, so the count assertion should hold. It is order-sensitive in principle.
- The rematch idempotency lookup only finds a still-pre-lock rematch by the same caller. After that rematch locks, a second tap creates another rematch of the same old bet. This is allowed by design.
- attempts.evidence_hash is now written for dance rows; its column comment says 'sha256(stored clip bytes)'. Nothing in the server reads it. client_clip_hash holds the evidence hash as a stand-in when clip_sha256 is null.
- The model's announcer line goes through a sanity check: for a winner, it must contain the winner's display name, case-insensitive; for no winner, it must start with 'Too close to call' and not say 'win'. An INVALID round's reason quotes the model's notes, which are cleaned but not filtered for family-friendliness.

## mobile:bet-flow
I built the mobile bet flow for Dance Off and double or nothing, everything except the dance screens and the native module. Nothing was run: no tsc, no prettier, no vitest. Every signature I call was checked by reading the source, and I wrapped long lines by hand.

**Negotiate.** `app/danceTerms.ts` is a reducer copied from the market panel (closed → browsing → sending → sent → confirming → confirmed), plus `submitDanceTerms`. It calls `api.proposeDanceTerms`, which POSTs to `/terms/dance`. Confirm reuses `confirmTypedTerms`. The routine cards come from shared `ROUTINES` (`DANCE_ROUTINE_CHOICES`), so the panel never imports `src/dance`. The panel previews the claim with shared `danceClaim`, which gives the same string the server builds. On a restart it reopens on the card already shown (`danceCardOf`). `ChallengeScreens` has a new `DancePanel` and a "Dance off" button (`dance-open`) in both the typed form and the voice view. The panel is gated by `EXPO_PUBLIC_DANCE`.

**Routing.** `machine.ts` adds the routes 'dance' and 'danceWatch' for dance bets in LOCKED, ATTEMPT and JUDGING:
- A judge-cam device goes straight to 'dance'.
- A party phone sees the locked card until it is acknowledged.
- The recording phone is whichever device the attempt names; before any attempt it is A's phone. The other phone gets 'danceWatch'.
- RULED, VOIDED and PAID use the existing screens. Nothing changes for other bet types.

**Starting and uploading.** `app/danceFlow.ts` asks for the judge cam first, then 'self' on `no_judge_cam`. The start response is patched into the hub so the count-in doesn't wait for the push. `sendDanceUpload` checks the bundle against `DanceUpload`, orders the frames by index and checks each frame's sha and byte count. It caches the first build per Idempotency-Key, so a retry resends the same bytes; after a 4xx it drops the cache and DemoApp mints a new key. `api.uploadDance` sends a signed multipart body: the `upload` JSON, then `frame` parts named NN.jpg, with `boundaryFor(key)`.

**DemoApp.** It lazily loads `DanceOffScreen`, `DanceWatchScreen` and `DanceResultBreakdown` through `importSafely`, each inside `PanelErrorBoundary` and `Suspense`. The voice judge's `request_attempt` is refused for dance bets, because the dance screen owns Start.

**Bet view and store.**
- `bets/view`: dance bets get their own kind, 'dance'. Evidence reads 'Pose score', and the round shows as '15 seconds' (a 'Round' row on the lock card instead of 'Tries').
- The routine line on the card shows the routine's title, but only after the routine is verified against the bundled one.
- `canAppeal` is false for dance, `gg/model reviewable` is false for dance, and odds are already skipped through `oddsApply`.
- The store folds `dance.scored` into `danceScored` (cleared when a new attempt starts) and `bet.invited`'s `rematch_of` and `suggested_stake_usd` into `rematchOf` and `suggestedStakeUsd`.

**Ruling.** On a dance bet the reason is labelled "Announcer", the per-move breakdown shows, and there is no appeal button. A void round shows "Too close to call" (only when `too_close` or `failed` is set and the round wasn't invalid) plus "Both stakes go back."

**Double or nothing.** `app/rematch.ts` POSTs to `/rematch` under a pinned key, then reads the new bet. The phone adopts it, patches A and the rematch fields into the hub, subscribes and opens it. The button appears on the ruling, payout and GG payout screens once the bet is PAID, VOIDED, FINALIZED or EXPIRED. Stake defaults on the new bet:
- **Typed form:** whole dollars, rounded down, minimum $1.
- **Bitcoin panel:** the largest chip at or below the suggestion.
- **Dance panel:** the exact suggestion, added as its own chip.

B's invite shows a "Double or nothing" chip.

**Preview and tests.** I added a `danceOff()` builder (real hashed terms) and `previewDanceScored()` to the preview data, and 7 letters-only menu keys at the end of the menu, mirrored in `sim-preview.yaml`. New and updated tests cover the dance reducer, dance flow, rematch, dance routes, the store fold, view kind, typed and market stake defaults, `reviewable`, copy, and a `bootImports` guard on `modules/dance-pose`.

**Files:** /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/app/danceTerms.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/app/danceFlow.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/app/rematch.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/app/machine.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/app/DemoApp.tsx, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/app/typedTerms.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/app/marketTerms.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/net/api.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/bets/store.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/bets/view.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/gg/model.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/gg/GgScreens.tsx, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/screens/copy.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/screens/ChallengeScreens.tsx, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/screens/PlayScreens.tsx, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/screens/LockScreens.tsx, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/preview/data.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/preview/PreviewApp.tsx, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/e2e/maestro/sim-preview.yaml, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/app/__tests__/fixtures.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/app/__tests__/danceTerms.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/app/__tests__/danceFlow.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/app/__tests__/rematch.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/app/__tests__/machine.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/app/__tests__/typedTerms.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/app/__tests__/marketTerms.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/app/__tests__/bootImports.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/bets/__tests__/danceStore.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/bets/__tests__/view.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/gg/__tests__/model.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/screens/__tests__/copy.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/net/__tests__/danceRoutes.test.ts

**API:** app/danceTerms.ts: DANCE_STAKES_USD (re-export); DEFAULT_DANCE_STAKE_USD=5; interface DanceRoutineChoice {id,title,song,bpm}; DANCE_ROUTINE_CHOICES: readonly DanceRoutineChoice[] (from shared ROUTINES); type DancePhase; interface DanceState {bet_id,phase,routineId,stakeUsd:number,proposedHash,note}; initialDance; ShownDanceCard {terms_hash,routineId,stakeUsd}; SubmitDanceOutcome; DanceEvent ('init'{bet_id,shown?,stakeUsd?}|'open'|'close'|'routine'{id}|'stake'{usd}|'submit'|'submitted'|'confirm'|'confirmed'|'confirm_failed'); danceReducer(s,e); danceOpen(s); canSubmitDance(s); canConfirmDance(s, shownHash, inviteAnswer); waitingForAcceptDance(s, shownHash, inviteAnswer); danceCardOf(env): ShownDanceCard|null; amountUsd(usd): string; stakeChips(chips, suggested?): number[]; danceClaimPreview(routineId, stakeUsd): string|null; submitDanceTerms({api: Pick<YoApi,'proposeDanceTerms'>}, {betId, routineId, stakeUsd}).

app/danceFlow.ts: isDanceBet(b); inDanceRound(state); recordsDance(app:{judgeCam,deviceId}, b:Pick<BetModel,'attempt'|'my_party'>): boolean; type DanceWatchPhase='waiting'|'dancing'|'judging'; danceWatchPhase(state); danceRecorderOrder(judgeCam, me): Recorder[]; startDanceAttemptVia(start, judgeCam, me); danceStartNote(e); interfaces DanceFrameBytes {index,bytes,sha256}, DanceBundleIn {upload: DanceUpload; frames: readonly DanceFrameBytes[]}, PreparedDance; type DanceUploadResult = {ok:true}|{ok:false;message;freshKey}; prepareDance(bundle); sendDanceUpload({api: Pick<YoApi,'uploadDance'>}, {betId, attemptNo, bundle, idempotencyKey}, cache?).

app/rematch.ts: canRematch(state); rematchStakeUsd(b); chipAtMost<T extends number>(chips, usd): T|null; withRematch(m, of, suggestedStakeUsd): BetModel; type RematchOutcome; startRematch({api: Pick<YoApi,'rematch'|'getBet'>}, betId, idempotencyKey).

net/api.ts YoApi additions: proposeDanceTerms(betId, DanceTermsRequest) -> DanceTermsResponse; uploadDance(betId, attemptNo, upload: DanceUpload, frames: readonly Uint8Array[], idempotencyKey) -> DanceUploadResponse (multipart: 'upload' application/json, then 'frame' parts 'NN.jpg' in order, boundaryFor(key)); rematch(betId, idempotencyKey) -> RematchResponse (POST json {}).

machine.ts Route += 'dance' | 'danceWatch'. BetModel += danceScored: DanceScoredPayload|null, rematchOf: string|null, suggestedStakeUsd: number|null. BetView.kind: BetKind = 'skill'|'market'|'dance'; BetView.routineTitle: string|null; kindOf(terms). typedTerms: TypedState.stakeUsd is now number; init event gets stakeUsd?; typedStakeFor(usd). marketTerms init event gets stakeUsd?: MarketStakeUsd|null. gg/model reviewable() is false for type 'dance_off'.

Screen props: NegotiateScreen dance?: DanceTermsPanel (exported interface); IncomingScreen rematch?: boolean; RulingScreen title?, note?, detail?: ReactNode, onRematch?, rematchBusy?; PayoutScreen and GgPayoutScreen onRematch?, rematchBusy?, alert?. COPY.dance.*, COPY.rematch.*, COPY.terms.round, fill.bpm(n). preview/data: danceOff(myName, opponent?, routineId?, stake?), DANCE_REASON, previewDanceScored(bet, tooClose?). Test IDs: dance-open, dance-routine-<id>, dance-stake-<usd>, dance-send, dance-confirm, dance-waiting, ruling-rematch, payout-rematch, incoming-rematch.

DemoApp imports from '../dance/index' lazily via importSafely: DanceOffScreen, DanceWatchScreen, DanceResultBreakdown; type-only DanceUploadBundle.

**Requests:**
- Dance agent (apps/mobile/src/dance/index.ts): export DanceOffScreen, DanceWatchScreen, DanceResultBreakdown and the DanceUploadBundle type exactly as the contract names them. Each component must also work alone through `import('../dance/index').then(m => ({default: m.X}))`. DemoApp and PreviewApp lazily import all three from '../dance/index'; they never import '../dance/routines'.
- Dance agent (DanceOffScreen): the `attempt` prop's go_at is already converted to THIS phone's clock (server go_at minus clock offset, as for the judge cam), passed as an ISO string. The prop can also arrive without this screen having called onStartAttempt, for example when A's phone started the round but the room's judge cam was named recorder. In that case the judge cam must still count in and record.
- Dance agent: onUpload(bundle, attemptNo) may be called again after `{ok:false}`. The app resends the first bundle built under the same Idempotency-Key, and a fresh build only goes out after a 4xx. Each bundle.frames entry's sha256 and bytes.length must equal the matching upload.frames entry, otherwise the app refuses the bundle locally and answers 'Upload failed'.
- Server: for a dance_off bet, POST /v1/bets/:id/attempts must accept recorder 'judge_cam' from A's phone or the judge-cam device, and recorder 'self' from A's phone when the room has no judge cam (answer 409 INVALID_STATE {reason:'no_judge_cam'} for judge_cam when there is none). Both the 201 AttemptStartedResponse and attempt.started must carry a non-null Party in `performer`, for example 'A', because the mobile schema and the shared realtime schema require it.
- Server: POST /v1/bets/:id/attempts/:n/dance reads multipart part 'upload' (JSON) first, then 'frame' parts named 00.jpg, 01.jpg… in upload.frames index order. It must honour the Idempotency-Key, replaying the same answer for the same bytes. Rejections should use 409 INVALID_STATE or ATTEMPT_NOT_OPEN; the phone shows 'Round closed' for those.
- Server: POST /v1/bets/:id/rematch receives an Idempotency-Key and a JSON body of {}. On a refusal it should send 409 with reason 'pair_busy', or RATE_LIMITED with reason 'too_many_open_bets', so the phone shows the existing challenge labels. /terms/typed must accept a typed rematch at a stake that isn't a chip, such as amount_usd '2'. /terms/dance must accept cents, such as '4.96'.
- ui/__tests__/cryptoCopyAudit.test.ts (outside my ownership): add 'dance' to SCREEN_DIRS so the dance agent's screen strings are audited.
- README.md test counts (outside my ownership): update after these new tests land. New mobile test files: app/__tests__/danceTerms, danceFlow, rematch; bets/__tests__/danceStore; net/__tests__/danceRoutes. Existing files also gained cases: machine, view, typedTerms, marketTerms, gg model, copy, bootImports.

**Open issues:**
- Nothing was compiled or run (no tsc, prettier, vitest or maestro). In particular, the DemoApp and PreviewApp lazy imports of '../dance/index' type-check only once the dance agent's file exists with the contract exports.
- On A's phone the voice judge session stays mounted during the dance. Its mic is already muted in LOCKED, ATTEMPT and JUDGING, but its audio output may duck or fight with the dance music on that phone. Not tested; it needs a device.
- If DanceOffScreen fails to load or throws, PanelErrorBoundary shows its 'Dance off failed to load' box and nothing falls back to DanceWatchScreen, so the round can't continue on that phone.
- With a judge cam in the room, A's phone and the judge cam both show the dance screen with a live camera until an attempt names the recorder. Then A's phone switches to danceWatch. This only works if DanceOffScreen handles an attempt it did not start.
- Rematch stake defaults: the typed form takes whole dollars, rounded down, with a minimum of $1, so an odds or market bet's $4.96 becomes $4. The Bitcoin panel uses the largest of its chips (1, 2, 5, 10) at or below the suggestion, so $20 becomes $10. Only the dance panel uses the exact suggestion.
- The 'Too close to call' headline appears only when dance.scored reached the phone. A VOID dance bet restored without its event log shows 'No contest'; the refund line and the rematch button still appear.
- If GET /v1/bets/:id for the new rematch bet fails, the phone opens a bet with state null, which shows home, until the socket brings its events. That path is untested.
- PayoutScreen and GgPayoutScreen now show 'Double or nothing' for every bet type once it is PAID or FINALIZED, in the preview too. This changes the existing payout screens slightly: an extra quiet button, plus an alert slot when it is shown.

## mobile:dance-ui
I built the phone side of Dance Off (contract §6.2–6.4) in `apps/mobile/src/dance/`, plus the hidden calibration entry in diagnostics. Nothing has been compiled or run: no tsc, no vitest, no build. I hand-checked the types against the installed expo-file-system, expo-video and expo-audio declarations, the shared `dance/*` sources and the native module's `index.ts`.

**Pure logic** (under `model/`, all with vitest tests):
- `round.ts`: the state machine framing → ready → starting → countIn → dancing → scoring → result → uploading → submitted, or failed.
  - Start unlocks after framing holds for 1000 ms. A dropout shorter than 250 ms does not reset that timer.
  - Count-in is 3 beats at the routine's bpm, and GO is t0. Recording runs 15 s + 600 ms so the last key-move window closes.
  - Snapshots: 4 key moves spread over the routine, each taken 150 ms after its beat.
  - A camera error mid-round does not abort. The round runs out and the scorer marks it failed (the refund path).
- `pipeline.ts`: native frames → shared tracker → shared live scorer → PoseSeries.
  - Count-in frames are buffered by `ts` and land at negative t once the first round frame fixes the clock offset.
  - Frames are capped at about 30 fps; the tracker runs on the session clock.
  - Also here: the self-test series, real-time replay inputs, and a sync-offset sweep that re-scores a saved round at −300..300 ms and picks the best offset.
- `upload.ts`: builds the `DanceUploadBundle`. It recomputes every frame's sha256 from the bytes and flags a mismatch with the native hash. It drops unusable frames, keeps at most 6, and checks the result with the shared `DanceUpload` schema before sending.
- `overlay.ts`: the letterbox math that matches the native preview's `resizeAspect`, mirroring, panel fitting and popup positions.
- `reference.ts`: interpolates the reference pose between routine frames.
- `liveStore.ts`: a throttled store (about 15 Hz) so a pose frame re-renders the meters and skeletons, not the whole screen.

**Display** (`Stage.tsx`, `LiveParts.tsx`): names and live match meters on top, a beat bar (4 beat dots, progress, next key move, clock), then two equal 9:16 panels that fit portrait or landscape.
- Left panel: the mirrored reference skeleton, or the reference video when a routine has one (expo-video, mirrored, loaded lazily).
- Right panel: the camera with A in green and B in white, and PERFECT / GOOD / MISS popups over each player's half.
- A large 3-2-1-GO count-in sits over both panels. The debug readout shows when the setting is on.
- Colours come only from the palette. Animations use RN Animated and respect Reduce Motion; there is no reanimated `withTiming` or `withSpring`.

**Screens:**
- `DanceOffScreen`: framing guide and reason, Start, starting the attempt, count-in, dancing, result card (rolling scores, winner or "Too close to call", per-move grid). It then uploads automatically, shows "Sending to judge" / "With the judge", and shows the announcer line when the ruling arrives. A failed upload can be retried; other failures offer "Dance again".
- `DanceWatchScreen` and `DanceResultBreakdown` contain no native code.
- `DanceCalibrationScreen`: live camera with a Solo mode (one dancer counts as both players), records each round as a session, replays sessions in real time or scores them at once with the sweep, a sync offset stepper, the debug overlay switch, and a self test.

**Supporting files:**
- `settings.ts` and `recordings.ts` are pure, and `fs.ts` is the expo-file-system adapter (documents directory, `dance-sessions/`).
- `copy.ts` holds `DANCE_COPY` with copy roles. `media.ts` is the asset registry (all null for now, with comments on how to add a video).

**Other edits:**
- Diagnostics: a "Dance calibration" button opens a lazy Modal, the same pattern as App preview.
- `cryptoCopyAudit.test.ts`: added `'dance'` to the scanned directories.
- `bootImports.test.ts`: the bet-flow agent had edited this file at the same time and added a directory-based check for `modules/dance-pose/`. I kept their check and added `DANCE_LAZY_MODULES` for the calibration screen in the startup, preview and `import()` checks.

**Decisions:**
- The pose module is only reached through `importSafely(() => import('../../modules/dance-pose'))` in `hooks.ts`; every other reference to it is a type-only import.
- The camera panel is not mirrored, so A shows on the left as the contract says.
- "Too close to call" is four words, so it uses the copy role 'body'.

**Files:** /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/index.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/routines.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/copy.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/theme.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/media.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/settings.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/recordings.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/fs.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/hooks.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/useDanceRound.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/SkeletonLayer.tsx, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/LiveParts.tsx, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/Stage.tsx, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/ReferenceVideo.tsx, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/ResultCard.tsx, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/DanceResultBreakdown.tsx, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/DanceWatchScreen.tsx, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/DanceOffScreen.tsx, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/DanceCalibrationScreen.tsx, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/model/round.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/model/pipeline.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/model/upload.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/model/overlay.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/model/reference.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/model/liveStore.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/__tests__/helpers.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/__tests__/round.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/__tests__/pipeline.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/__tests__/upload.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/__tests__/overlay.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/__tests__/liveStore.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/__tests__/settings.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/dance/__tests__/copy.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/diagnostics/DiagnosticsScreen.tsx, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/ui/__tests__/cryptoCopyAudit.test.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/app/__tests__/bootImports.test.ts

**API:** apps/mobile/src/dance/index.ts:
- export function DanceOffScreen(props: DanceOffScreenProps): JSX.Element
- export type DanceOffScreenProps = { betId: string; terms: Terms; me: 'A'|'B'; names: {a: string; b: string}; attempt: {attempt_no: number; go_at: string; max_ms: number} | null; ruling: {outcome: string; reason: string} | null; onStartAttempt: () => Promise<{ok: true} | {ok: false; message: string}>; onUpload: (bundle: DanceUploadBundle, attemptNo: number) => Promise<{ok: true} | {ok: false; message: string}>; onLeave?: () => void }
- export type DanceUploadBundle = { upload: DanceUpload /* @youre-on/shared/evidence */; frames: {index: number; bytes: Uint8Array; sha256: string; t_ms: number; width: number; height: number}[] }. The frames are in index order, and each sha256 is recomputed from the bytes.
- export function DanceWatchScreen(props: DanceWatchScreenProps): JSX.Element
- export type DanceWatchScreenProps = { terms: Terms; me: 'A'|'B'; names: {a; b}; phase: 'waiting'|'dancing'|'judging'; scored: DanceScoredPayload | null }
- export function DanceResultBreakdown(props: {scored: DanceScoredPayload; names: {a; b}; me?: 'A'|'B'}): JSX.Element
- export const DANCE_ROUTINE_CHOICES: {id: string; title: string; song: string; bpm: number}[]. It is also exported, with no native code, from apps/mobile/src/dance/routines.ts.
- export type DanceRoutineChoice
- export const DANCE_COPY
- export function resultFromRound(routine, DanceRoundResult): ResultData
- export function resultFromScored(DanceScoredPayload): ResultData

Not in index.ts (diagnostics loads it lazily): apps/mobile/src/dance/DanceCalibrationScreen.tsx has `export default function DanceCalibrationScreen({onClose}: {onClose: () => void})`.

**Requests:**
- Bet flow: DanceOffScreen calls onStartAttempt() only when Start is pressed and there is no attempt it has not yet used. It then waits for a NEW props.attempt (compared by attempt_no plus go_at) and gives up after 12 s. onUpload(bundle, attemptNo) must send multipart: an `upload` part with JSON.stringify(bundle.upload), then one `frame` part per entry of bundle.frames in index order, to danceUploadPath(betId, attemptNo). The upload starts on its own as soon as the local result is shown. Pass `ruling` (outcome plus the reason text) as soon as ruling.issued arrives; the screen shows the announcer line, then routing to RulingScreen can follow.
- Bet flow: if the app restarts during ATTEMPT or JUDGING on the recording phone, route to DanceWatchScreen (phase 'judging') rather than DanceOffScreen. A fresh DanceOffScreen starts back at framing.
- Optional, ui/copyRule.ts CONTRACT_COPY: add { template: 'Too close to call', source: 'DANCE-OFF §5' } and change DANCE_COPY.tooCloseToCall to role 'contract'. It is 'body' today so that tests pass without that change.
- Optional, ui/tokens.ts haptics: add named moments for the dance (for example danceBeat = selection and danceGo = medium impact). The dance currently uses the existing 'select' on each beat and 'holdComplete' at GO.
- When a real reference video or audio exists: add `declare module '*.mp4'` (and '*.m4a' or '*.mp3' if needed) to apps/mobile/src/types/assets.d.ts, and fill in dance/media.ts. See the steps in that file's header.
- app.json orientation is 'default'. The native preview layer is fixed to portrait, so if the dance screen rotates to landscape the camera preview will look sideways. Either lock the app to portrait, or add expo-screen-orientation and lock it while the dance screen is up (owner: app config / bet flow).
- PreviewApp and e2e/maestro/sim-preview.yaml (bet-flow or preview owner): add menu entries for DanceWatchScreen and DanceResultBreakdown, which contain no native code, plus the routine cards. Keys must be letters only. If they import from 'src/dance/index' statically, the preview graph will include hooks.ts and fs.ts (expo-file-system) but not modules/dance-pose, because the dance files only import that module as types. bootImports covers this.

**Open issues:**
- Nothing has been compiled or run (no tsc, no vitest, no prettier). The types were checked by hand against the installed expo-file-system 58 (File, Directory, Paths), expo-video, expo-audio, the shared dance/* sources and modules/dance-pose/index.ts. Some lines may need prettier reflowing.
- The pipeline test expects a dancer who copies the reference exactly to score at least 900, someone standing still under 200, and at least 9 of 12 PERFECT. I reasoned these from the scorer constants; if a run fails, the thresholds may need adjusting.
- The sync-sweep test only asserts how the scores are ordered (a positive offset beats a negative one, and the best offset is ≥ 0), not one exact best offset.
- The live meter and popups depend on 30 Hz onPoses reaching JS without trouble, and the reference skeleton redraws at 30 fps. This has not been measured on a real phone, and the HDMI mirroring latency is unknown. The sync offset stepper and sweep exist to calibrate for it.
- The camera panel is not mirrored, so A shows on the left of the screen, as the contract's 'A = left in the image' says. Dancers who watch the display may find it unintuitive; the guide names which side is which.
- The haptics on the beat and at GO are probably silent while the camera runs, so the screen also flashes each beat.
- The music-only path (media.audio without video) loads expo-audio's createAudioPlayer lazily at the count-in. It is untested, and every routine's media is null today.
- In calibration, Solo mode duplicates a single dancer into both slots so the tracker starts. Framing is bypassed with a forced start (a `force` flag on the 'start' event).
- Settings are stored in a JSON file in the documents directory (dance-settings.json), not SecureStore. Sessions also need the file system, and these are not secrets.
- Another agent was editing bootImports.test.ts at the same time. I merged their DANCE_NATIVE_DIR check with my DANCE_LAZY_MODULES check, so the next editor should re-read the file before changing it.

## stage
I added dance off support to the web stage (projector). Nothing has been run: no tsc, vitest, prettier or build, as the task required. Every type and signature I call was checked by hand against the shared sources.

**New pure module `apps/stage/src/dance.ts`.** It holds the helpers every stage file uses for a dance off:
- `isDanceBet` is true when the terms type is `dance_off`, or `bet.dance` is set, or the ruling model is `DANCE_OFF_MODEL`. Every code path that reads `performer` now checks it first.
- `danceRoutineOf` returns the routine id, title and key-move names. It parses `success_criteria[0]` with `parseDanceRoutineLine` and looks the routine up with `getRoutine`, trusting it only when the version matches. If that fails it takes the title from the claim, then from the routine id in `dance.scored`.
- Other helpers cover play steps (framing, dancing, scoring), the verdict (win, too close to call, no contest), the key-move grid rows, grade tallies and score text (874 prints as "87.4").
- Importing the routine data adds nothing to the stage bundle, because `@youre-on/shared/api` already pulls it in.

**`ticker.ts`.** `BetView` has a new field `dance: DanceView | null`, and `foldCard` folds `dance.scored` into it.

**`phase.ts`.** The play phase label reads "Dance off" for a dance off.

**`panes.ts`.**
- `phoneCues`: during the round both phones get 'act'; while the round is being scored, neither does.
- `cueText(bet, cue, slot?)`: the optional third argument is new. In a dance round the recording phone (A) reads "filming" and the other reads "dancing". `PhonePanes.tsx` now passes the slot.
- `railSummary` shows framing, dancing and scoring lines, "Logan wins · 87.4 to 71.0", and "Too close to call · stakes refunded" or "No contest · stakes refunded". It never names a single performer.

**`view.tsx`.**
- The play panel shows the routine title, "15 seconds", where each player stands, "Logan and Jake are dancing ● REC", then "Scoring the round…".
- The ruling panel shows the verdict ("Too close to call" for a void), the announcer line, both scores with the winner highlighted, each player's tally and the key-move grid. It shows no confidence percent, and the countdown reads "GG window" instead of "Appeal window".
- The terms panel shows the routine instead of the sha line. The paid panel adds a summary line with the result and both scores.
- Styles are in `stage.css`, using only the existing colour tokens.

**Other changes.**
- `format.ts`: `eventLabel` handles `dance.scored`.
- `slowmo.ts`: slow-mo never auto-plays for a dance off, because there is no evidence clip.
- New `preview-dance.ts`, wired in `App.tsx`: `?preview=dance` loops a full bet (Logan wins 87.4 to 71.0), `?preview=dance-tie` plays the too-close refund (78.3 to 77.1), and `dance-<step>` / `dance-tie-<step>` freeze on one moment. Every preview frame goes through `applyFrame` and the shared schemas, so it also smoke-tests the reducer.

**Tests:** new file `apps/stage/test/dance.test.tsx` (not run). It covers parsing (no dropped frames), every step rendering without a crash, the fold, the routine fallbacks, the result logic, the phase label, cues, the rail, the panel HTML (including a check for no percent text) and slow-mo. No existing test should break: `cueText`'s new argument is optional, and `emptyBet` adds `dance: null`.

**Files:** /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/stage/src/dance.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/stage/src/preview-dance.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/stage/src/ticker.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/stage/src/phase.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/stage/src/panes.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/stage/src/PhonePanes.tsx, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/stage/src/view.tsx, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/stage/src/format.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/stage/src/slowmo.ts, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/stage/src/App.tsx, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/stage/src/stage.css, /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/stage/test/dance.test.tsx

**API:** apps/stage/src/dance.ts:
- type DanceGrade = 'PERFECT'|'GOOD'|'MISS'; DANCE_GRADES
- interface DanceView {attempt_no, routine_id, routine_version, scores:{a,b} (tenths), winner, too_close, failed, key_moves:{id,a,b}[], checks, validation:{verdict,notes}, announcer_line, evidence_hash}
- danceViewOf(p: DanceScoredPayload): DanceView
- isDanceBet(b: BetView|null|undefined): boolean
- danceRoutineOf(b): {id, title, moves: Record<id,name>}|null
- danceRoutineLabel(b): string
- danceScoreText(x10): string
- type DancePlayStep = 'framing'|'dancing'|'scoring'; dancePlayStep(b)
- DANCE_RECORDER: PartyKey = 'A'
- type DanceResult; danceResult(b): DanceResult|null; danceVerdictLine(r, name)
- keyMoveRows(b); gradeTally(moves, party); tallyLine(t); danceScoreLine(d); danceSummaryLine(b, name)

apps/stage/src/ticker.ts: BetView.dance: DanceView|null; foldCard handles 'dance.scored'.

apps/stage/src/panes.ts: cueText(bet, cue, slot?: SlotId) (new optional 3rd param).

apps/stage/src/view.tsx: export function DanceBoard({bet}).

apps/stage/src/preview-dance.ts: DANCE_PREVIEW='dance', isDancePreview(p), DANCE_LOOP_MS, DANCE_STEPS {terms,lock,framing,dancing,scoring,ruling,paid}, previewDanceAt(startMs, nowMs, preview) -> {state, now, t}.

**Requests:**
- Server (bets/dance pipeline): emit 'dance.scored' in the same commit as 'ruling.issued', as contract section 5 says. The stage folds them in either order. The stage reads only evidence.scores, winner, too_close, failed, key_moves, checks, routine.{id,version}, validation.{verdict,notes}, announcer_line and evidence_hash.
- Server: 'attempt.started' still requires a performer (Party). For a dance off, send 'A' (the default recorder). The stage ignores performer for dance offs, so any value works.
- Server/shared (optional, future): the stage cannot tell whether a room judge-cam phone or A's phone is filming, so it labels A's pane 'filming'. To make this exact, add an optional party field to attempt.started (e.g. recorder_party: 'A'|'B'|null), and dance.ts DANCE_RECORDER can read it.
- Server (optional): the stage has no live dance meters. Contract section 6.3 puts the meters on the phone, which reaches the projector through HDMI mirroring. If you want them on the web stage, add an unsequenced WsStageDance control frame to WsServerControlFrame (shared api.ts), modelled on stage.market, and the stage can fold it in applyFrame.

**Open issues:**
- Nothing has been run (no tsc, vitest, prettier or vite build). Types and signatures were checked by hand. apps/stage/test/dance.test.tsx is written but has never run.
- The dance preview, and the parse assertion in the test, assume my hand-built sample objects (dance_off Terms, DanceEvidence, a rule/dance-off@1 Ruling with void_reason 'undecidable', DanceValidation) parse under the shared schemas. If the test reports dropped > 0, a field in preview-dance.ts does not match a shared schema.
- CSS (.dance-board, .dance-grid, .dance-duo and the rest in stage.css) has not been checked visually on a projector or at 720p. With 12+ key moves the grid uses 0.6em cells with clipped text, which may need tuning. Check it with ?preview=dance-ruling and ?preview=dance-tie-ruling.
- DANCE_RECORDER is fixed to 'A'. When a separate room judge-cam phone films, A's pane is still badged 'filming'.
- A void with validation 'invalid' (and not too close or failed) reads 'No contest'. All other dance voids read 'Too close to call'. The VOID ruling panel shows no GG/appeal countdown.
- Pressing R on a dance off still tries the slow-mo fetch and shows the existing 'No slow-mo yet' toast. Only auto-play is suppressed.
- Some new lines may not exactly match prettier's output (multi-line JSX and the RESULT type in preview-dance.ts). Run prettier --write on apps/stage/src/{dance.ts,preview-dance.ts,view.tsx,panes.ts} and test/dance.test.tsx when allowed.

## fix:shared: NOT FINISHED (stopped)

## fix:native: NOT FINISHED (stopped)

## fix:tools: NOT FINISHED (stopped)

## fix:server: NOT FINISHED (stopped)

## fix:mobileApp: NOT FINISHED (stopped)

## fix:mobileDance: NOT FINISHED (stopped)

## fix:stage: NOT FINISHED (stopped)

## Review findings (24) — fixers were mid-way when paused; each must be re-verified

- **[blocker] native** `.gitignore:10` — The root .gitignore rule `ios/` (line 10) also matches apps/mobile/modules/dance-pose/ios/. `git check-ignore -v` confirms it ignores DancePose.podspec and every Swift file (DancePoseModule, DancePoseView, DancePoseEngine, DancePoseFiles, PoseExtraction). A commit would therefore leave out the whole native module: the JS index.ts is committed, but autolinking finds no podspec on any other checkout or in CI. The new .easignore comment says 'the root .gitignore carries the same exception', which is false today. Also, once .easignore re-includes that folder, eas-preflight's 'upload has nothing git ignores' audit (git ls-files -o -i --exclude-standard) lists apps/mobile/modules/dance-pose/ios/ and fails.  
  Fix: Add the line `!apps/mobile/modules/*/ios/` directly after `ios/` in the root .gitignore. That folder is the directory the `ios/` rule matches, so the negation re-includes it. The easConfig drift test skips `!` lines, so it is unaffected. After the change, `git check-ignore` on the podspec returns rc=1.
- **[blocker] native** `.gitignore:10` — The root .gitignore rule `ios/` matches apps/mobile/modules/dance-pose/ios/. `git check-ignore -v` confirms that DancePose.podspec, DancePoseModule.swift, DancePoseEngine.swift, DancePoseView.swift, DancePoseFiles.swift and PoseExtraction.swift all match `.gitignore:10:ios/`, and `git status --untracked-files=all` lists none of them. A commit or a fresh clone would therefore carry index.ts and src/* but no podspec or Swift sources. Autolinking would then find no pod, `isDancePoseAvailable()` would be false on every build, and the dance screen would always show 'No camera'. EAS preflight's 'nothing git ignores' audit also conflicts with the new .easignore re-include.  
  Fix: In the root .gitignore, add `!apps/mobile/modules/*/ios/` on the line directly after `ios/`. The `ios/` pattern matches a directory, so the negation must name the directory itself. Then confirm the six files show up in `git status --untracked-files=all`. This file has no owner; the native agent asked for this change.
- **[major] server** `apps/server/src/judge/routes.ts:907` — For a dance off, POST /attempts accepts recorder 'self' from EITHER party, even when the room has a judge cam (the `!dance &&` guard switches off the old non-performer rule, and the 'self' branch at ~956 just takes the caller's device). For a dance, the server trusts the uploaded PoseSeries completely: it re-scores whatever series the recorder sends. So either dancer can skip the neutral judge cam, film on their own phone and upload a made-up series that makes them win real money. This trust model is weaker than skill bets, where 'self' is only allowed for the opposing non-performer. It also goes beyond contract §6.2, which says the recording phone is the room's judge cam, or else A's phone.  
  Fix: In the dance branch, when body.recorder === 'self', first run findDanceJudgeCam(tx, bet). If a cam exists, refuse with 409 INVALID_STATE {reason:'judge_cam_present'}, or simply use the cam as recorder. Also allow 'self' only when partyOf(bet0, me.user_id) === 'A' (NOT_A_PARTY {reason:'recorder_is_a'} otherwise). Update apps/server/test/dance.test.ts: the 'either party records itself' case and every `post(B, …/attempts, {recorder:'self'})` and `uploadDance(B, …)` should use A.
- **[major] mobileDance** `apps/mobile/src/dance/DanceOffScreen.tsx:242` — DanceOffScreen only counts in an attempt after its own Start press, so in a room with a judge cam the round can stall. The count-in effect returns unless state.phase is 'starting', and roundReducer 'attempt' (model/round.ts:181) is ignored outside 'starting'. Before any attempt exists, machine.recordsDance sends A's phone to 'dance' too, so both A's phone and the judge cam show a live camera with a Start button. If A presses Start on A's phone, startDanceAttemptVia asks for 'judge_cam' first, the server names the room judge cam as recorder, and A's phone switches to danceWatch ('Dance off live'). The judge cam is still in framing/ready and never counts in or records. The attempt's 30 s window then runs out with nothing recorded. The bet-flow agent asked for exactly this case: "the judge cam must still count in and record".  
  Fix: Add an effect in DanceOffRound on [attemptKey, state.phase]. When props.attempt is present, its attempt_no is not in usedAttempts, it was not already present at mount, and the phase is 'framing' or 'ready', add it to usedAttempts, dispatch {type:'start', at: nowMs(), force: true}, then beginCountIn(a.attempt_no). Alternatively, let roundReducer accept 'attempt' from 'framing' and 'ready'.
- **[major] mobileApp** `apps/mobile/src/app/machine.ts:174` — Once the ruling lands, the judge-cam phone stops showing the dance and goes to the standby camera screen. The dance branch covers only LOCKED, ATTEMPT and JUDGING. At RULED, routeForBet falls through to `if (app.judgeCam && !isOver(state)) return 'judgeCam'` (line 183), because RULED is not terminal. ruling.issued and the move to RULED arrive in the same commit, so DanceOffScreen unmounts at once. Its result card and announcer line (ResultStatus with props.ruling) are never visible on the judge cam. The judge cam is the HDMI display (contract §6.3), so the projector drops from the result to the standby camera screen. For comparison, VOIDED on the same device routes to 'ruling'.  
  Fix: In the dance branch, keep the judge cam on the round screen through the ruling: `if (isDanceBet(b) && app.judgeCam && (inDanceRound(state) || state === 'RULED')) return 'dance';`. Alternatively, route it to 'ruling'. Add a machine.test case for cam + RULED.
- **[major] server** `apps/server/src/judge/routes.ts:905` — This is a trust hole. For a dance off, POST /attempts drops the recorder restriction completely: `if (!dance && body.recorder === 'self' && ...)`. So party B, or a modified client of either party, can claim 'self' while the bet is LOCKED and become the recorder device. The recorder uploads the whole PoseSeries, and the server only re-scores what it is given. B can upload a series in which B's slot is the routine's own frames (score 1000) and A stands still, with any 1 to 6 JPEGs. The validator sees only those JPEGs, so B wins A's stake. Contract §6.2 allows only the room's judge cam or A's phone. `findDanceJudgeCam` (line 278) also accepts a judge-cam device of either party and picks the most recently seen, so B can register a judge cam in the room and win the pick. The mobile client never does either of these, so only the server can enforce the rule.  
  Fix: In the dance branch, reject `recorder === 'self'` unless `partyOf(bet0, me.user_id) === 'A'`, and when the room has a judge cam, also reject it (respond 409 `judge_cam_required`). In `findDanceJudgeCam`, use only party A's judge-cam devices, i.e. `findJudgeCam(tx, bet, 'B')`, so that the non-performer is A, matching the 'second device of A' convention the mobile judge-cam poll assumes. Add a test in which B self-records a dance off and gets 403 or 409.
- **[major] mobileDance** `apps/mobile/src/dance/DanceOffScreen.tsx:276` — 'Dance again' after a round has started can never start again. Once the round reaches count-in, its attempt_no is added to `usedAttempts`. `danceAgain()` resets the engine but keeps that set. The next Start then calls `onStartAttempt()`, which in DemoApp is `startAttempt(b.bet_id, nextAttemptNo(b) = lastAttemptNo + 1, ...)`. The server answers 409 INVALID_STATE: the bet is ATTEMPT, attempt 1 is still 'recording', and a new number is only accepted after a REDO. That error is not `no_judge_cam`, so the 'self' fallback never runs, and the screen shows start_failed again and again. Every path that offers 'Dance again' after the attempt exists is affected: round_failed (startRound refused or the camera dropped), scored ok:false (no key frames) and no_attempt. The bet then stays in ATTEMPT with both stakes locked until the deadline refund. The server still accepts an upload for the open attempt, so dancing again on that same attempt would work.  
  Fix: In `danceAgain`, when the round never uploaded (`state.phase !== 'submitted'` and the bet is not JUDGING), delete the current attempt from `usedAttempts.current` (`usedAttempts.current.delete(state.attemptNo)`), or clear the set. The next Start then takes the `a && !usedAttempts.current.has(a.attempt_no)` branch and counts in on the open attempt. As a belt-and-braces change (mobileApp, DemoApp.startDance), pass `b.attempt.attempt_no` instead of `nextAttemptNo(b)` when `b.state === 'ATTEMPT'`; the server replays the 201 for the current attempt.
- **[major] mobileDance** `apps/mobile/src/dance/DanceOffScreen.tsx:241` — The judge cam does not count in for an attempt it did not start. The mobileApp contract said the judge cam must still count in and record when A's phone started the round and the server named the judge cam as recorder. The screen only reads `props.attempt` while `state.phase === 'starting'`, which happens only after Start is pressed on this device. When A presses Start on A's phone, `startDanceAttemptVia` asks for 'judge_cam' first, so the server picks the judge cam. A's phone then switches to danceWatch, while the judge-cam phone stays in framing with Start still to press. Nothing counts in, the dancers wait, and someone has to walk to the judge cam and press Start.  
  Fix: Add an effect. When `phase` is 'framing' or 'ready' and a new `props.attempt` arrives (its attempt_no is not in `usedAttempts`), DemoApp only renders DanceOffScreen on the recording device. So call `engine.start(true)`, then `beginCountIn(a.attempt_no)` with the same used-attempt bookkeeping. Alternatively, have the reducer accept an 'attempt' event from framing or ready. Do not auto-start on mount for an attempt that was already danced, which the fix in the previous finding covers.
- **[minor] shared** `/Users/loganstaples/dev/hackathons/ubc26/UBC-2026/scripts/dance-routine.ts:485` — `import` moves every key-move time to the nearest frame (`uniq = times.map(snap)`, then a name lookup by `Math.round(m.t) === t` at line 513). The dance-ref tool writes frames at real video timestamps (for example 1001, 1034 ms) and leaves gaps where Vision saw nobody. So the moved times almost never equal the tool's beat times. (1) Names from the JSON or `--key-move-names` are silently replaced with 'Move N'. (2) Key moves are no longer on the beat, which RoutineKeyMove.t documents and the bundled-routine test asserts. (3) Across a Vision gap, a key move can shift by hundreds of ms. The scorer does not need any of this, because routineModel already uses nearestRef(t) for the reference pose.  
  Fix: Drop the snap. Use `times` as given, de-duplicated and sorted, and look names up against the original times. If clamping is wanted, only clamp the times into [0, duration].
- **[minor] shared** `/Users/loganstaples/dev/hackathons/ubc26/UBC-2026/scripts/dance-routine.ts:502` — Contract §8 says `import <json>` 'validates, quantizes, picks beats'. When the JSON has no key_moves, which is the dance-ref tool's default without --key-moves or --every, the importer throws 'key moves: pass --key-moves … or --every K' instead of picking beats. The tools agent built its output around the importer doing this.  
  Fix: In the final else branch, fall back to the `--every` logic with a default K (for example 2 beats, or whatever gives 8 to 16 moves) from bpm and first_beat_ms. Keep the error only when bpm is missing.
- **[minor] tools** `/Users/loganstaples/dev/hackathons/ubc26/UBC-2026/tools/dance-ref/Sources/DanceRefCore/Options.swift:59` — The tool accepts and generates routine ids that the shared contract rejects. ID_PATTERN is `^[a-z0-9][a-z0-9_-]{0,47}$`, and slugFromPath keeps '_' and allows 48 characters. Shared RoutineId is kebab-case `^[a-z0-9]+(-[a-z0-9]+)*$`, max 32, and the Terms routine-line regex (dance/terms.ts ROUTINE_LINE_RE) has the same rule. A video named `salsa_basic.mov` or `a--b.mov`, or an id over 32 characters, gives JSON whose import fails `RoutineData.parse`. Such a routine could never appear in hashed Terms.  
  Fix: Set ID_PATTERN to `^[a-z0-9]+(-[a-z0-9]+)*$` with a 32-character limit. In slugFromPath, map '_' to '-', collapse repeated dashes and truncate to 32. Update the usage text and the XCTest.
- **[minor] shared** `/Users/loganstaples/dev/hackathons/ubc26/UBC-2026/packages/shared/src/judge/propose-terms.ts:173` — Widening ProposeTermsArgs.type to include 'dance_off' also widens the ElevenLabs webhook parse. apps/server/src/voice/tools.ts:357 calls `evaluateProposeTerms(body, …)` with no type guard. A voice-agent call with type 'dance_off' and a correct routine line would therefore become a dance-off proposal. Contract §1 says the voice agent does NOT propose dance offs in v1. Only the tool JSON schema (PROPOSE_TERMS_BODY_SCHEMA) leaves it out, and the server does not enforce that.  
  Fix: Add an `allowDanceOff?: boolean` option to EvaluateOptions, default false. evaluateProposeTerms returns `{kind:'invalid', issues:[{path:'type', message:'dance_off only via /terms/dance'}]}` unless the option is set, and the /terms/dance route passes true. Alternatively, have voice/tools.ts reject `body.type === 'dance_off'` before evaluating (a server-area change).
- **[minor] server** `apps/server/src/lock/service.ts:858` — The LOCKED judge.cue tells the voice judge to 'call request_attempt with attempt_no 1' on every non-market bet, dance offs included. The same text is in apps/server/src/chain/projector.ts:795 (cueFor). For a dance bet the phone refuses that tool: judgeTools.request_attempt returns 'error: INVALID_STATE', because the dance screen owns Start. On every dance off the voice judge is therefore told to make a call that fails, and it may read the error aloud during the lock moment.  
  Fix: Both places already load the final envelope (`final?.envelope.terms` / loadEnvelope). When terms.type === 'dance_off', use a dance instruction instead, for example 'Announce both stakes are locked in one transaction, then tell <A> and <B> to get in frame for the dance off. Do not call request_attempt.' The kv can drop `performer`, which is already absent because performer is null.
- **[minor] server** `apps/server/src/judge/dance.ts:188` — acceptedLine accepts the model's announcer line for a decisive round as long as it contains the winner's name anywhere. A line like 'Logan tried, but Jake wins this one!' is accepted when Logan won. It becomes Ruling.reason (hashed and on chain), and the stage speaks it as 'Logan wins. Logan tried, but Jake wins this one!', so the spoken result contradicts the deterministic score.  
  Fix: Also reject the line when it names the loser next to a win word. Escape the name, then return null when `new RegExp(`\\b${esc(loserName)}\\b[^.!?]*\\b(wins?|won|takes it|champion)\\b`, 'i').test(s)`. Alternatively, only accept a line with a win word when that word follows the winner's name. Add a test case 'Logan tried, but Jake wins' that should fall back to the canned line.
- **[minor] server** `apps/server/src/judge/dance.ts:36` — DANCE_MAX_OUTPUT_TOKENS is 512. The default JUDGE_MODEL is claude-sonnet-5-5, which thinks adaptively, and providers/types.ts says thinking can't be disabled on it. Thinking tokens count against max_tokens. The vision judge sends a similar-sized JSON with 1024 (JUDGE_MAX_OUTPUT_TOKENS) and the appeal panel uses 1024. At 512, a live round check can be cut off (invalid_output), so validation is silently 'skipped' and the model's announcer line is lost much more often than intended. The round still settles, but the check stops doing its job.  
  Fix: Set DANCE_MAX_OUTPUT_TOKENS = 1024, the same as JUDGE_MAX_OUTPUT_TOKENS, and update the '`max_tokens` 512' cell in API-CONTRACT §7.1.
- **[minor] mobileDance** `apps/mobile/src/dance/DanceOffScreen.tsx:276` — 'Dance again' after a round that already started (camera error, or no key frames) can never start again. usedAttempts already holds the open attempt, so Start calls onStartAttempt. That makes DemoApp POST /attempts with nextAttemptNo = 2 while the bet is in ATTEMPT. The server (apps/server/src/judge/routes.ts:933-936) only accepts attempt 1 from LOCKED, so it answers INVALID_STATE and the user sees "Couldn't start". The open attempt is never danced or uploaded and just expires. The same thing happens after an app restart during JUDGING: the recording phone remounts at framing and Start fails.  
  Fix: In danceAgain, clear the open attempt from usedAttempts while the bet is still ATTEMPT and nothing was uploaded, so the next Start counts in on it. The server also replays a 201 for the same attempt_no, so DemoApp.startDance could re-POST b.attempt.attempt_no instead of nextAttemptNo(b) for a dance bet in ATTEMPT. For JUDGING on a fresh mount, route to danceWatch (phase 'judging'), as the dance agent requested.
- **[minor] mobileDance** `apps/mobile/src/dance/DanceOffScreen.tsx:238` — The screen decides whether an attempt is new from `${attempt_no}|${go_at}`, but DemoApp builds go_at with the live clock offset (`Date.parse(a.go_at) - rt.clock.offsetMs`, DemoApp.tsx:1816). rt.clock is re-synced from server responses, so the same attempt gets a new key whenever the offset moves by a millisecond. While the screen waits in 'starting' with an old attempt present (for example after 'Dance again'), any re-render after a re-sync makes the second effect see a different key. It then begins the count-in on an attempt that was already used, racing the start_failed from the refused POST.  
  Fix: Compare attempts by attempt_no only (attempt_no plus recorder if needed), not by the clock-adjusted go_at. Alternatively, DemoApp could pass the raw server go_at and a separate offset.
- **[minor] native** `apps/mobile/vitest.config.mts:9` — The vitest include is ['src/**/*.test.ts', 'scripts/**/*.test.ts'], so apps/mobile/modules/dance-pose/__tests__/dancePose.test.ts never runs. That file holds the Swift/TS joint-order guard, the module-name and event-name guards, the payload-key guards and the .easignore-order guard, and none of them run in CI.  
  Fix: Change include to ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'modules/**/*.test.ts']. The test imports only node:fs and ../src/frame, with no React Native.
- **[minor] tools** `tools/dance-ref/Sources/DanceRefCore/Options.swift:59` — ID_PATTERN `^[a-z0-9][a-z0-9_-]{0,47}$` and slugFromPath (which keeps '_', up to 48 chars) accept ids that the shared RoutineId schema rejects. That schema is `/^[a-z0-9]+(-[a-z0-9]+)*$/` with .max(32). scripts/dance-routine.ts import ends in RoutineData.parse, so a tool run with `--id wave_1` (the tool's own test example), or on a file such as 'my_dance.mov', or with a long file name, writes JSON that import always rejects. The tool's 'next:' hint passes the same --id, so following it fails too.  
  Fix: Set ID_PATTERN to `^[a-z0-9]+(-[a-z0-9]+)*$` and require id.count <= 32. In slugFromPath, map '_' to '-' (collapse repeated dashes) and truncate to 32 chars, then trim dashes. Update the usage text, testAllFlags ('wave_1' -> 'wave-1') and testSlug ('_a_b.mp4' -> 'a-b'). Optionally cap the default title at 40 chars, the RoutineData title max.
- **[minor] shared** `scripts/dance-routine.ts:521` — The importer does `song: flag(args,'song') ?? raw.song ?? 'Unnamed track'`, but the dance-ref tool's default song is the empty string. The tool then writes `"song": ""`, `??` keeps the "", and RoutineData.parse fails on song.min(1). So any tool run without --song produces JSON that cannot be imported. Title on line 520 has the same `??` pattern.  
  Fix: Use `||` instead of `??` for the string fallbacks: `song: flag(args,'song') || raw.song || 'Unnamed track'` and `title: flag(args,'title') || raw.title || id`. Clamp them to the schema maximums (title 40, song 80) with .slice. Alternatively, make the tool's default song non-empty.
- **[minor] shared** `scripts/dance-routine.ts:514` — Key-move names from the tool's JSON are dropped. Line 509 snaps every key-move time to the nearest frame time. Line 514 then looks names up with `Math.round(m.t) === t` against the SNAPPED time, so the lookup fails whenever a beat is not exactly on a frame. At 15 fps (a 66.67 ms grid), a move at 500 ms snaps to 467, and its --key-move-names entry is replaced with 'Move N'.  
  Fix: Build the names map before snapping, e.g. `const named = new Map(raw.key_moves?.map(m => [snap(Math.round(m.t)), m.name]) ?? [])`, then use `named.get(t) ?? 'Move ' + (i+1)`.
- **[minor] mobileApp** `apps/mobile/src/app/danceFlow.ts:46` — Before an attempt exists, `recordsDance` routes A's phone to 'dance' even when the room has a judge cam. A's phone then runs its own camera and framing check. Start stays disabled until A's camera sees both dancers, so A usually cannot start the round, and the judge cam (finding above) cannot either until someone presses Start there. Contract §6.2: 'the recording phone (the room's judge cam, or else A's phone) routes to dance'.  
  Fix: When the room is known to have a judge cam (room presence, or the room info DemoApp already polls), route A's phone to 'danceWatch' before the attempt. Keep 'dance' on A's phone only when the room has no judge cam.
- **[minor] tools** `tools/dance-ref/Sources/DanceRefCore/Options.swift:59` — The tool's id rule `^[a-z0-9][a-z0-9_-]{0,47}$` and `slugFromPath` disagree with the shared rules. Shared allows only kebab case without underscores: `RoutineId` `/^[a-z0-9]+(-[a-z0-9]+)*$/` with max 32, the routine-line regex in dance/terms.ts, and DanceUpload/DanceEvidence routine.id max 32. The tool accepts underscores and ids up to 48 characters, and keeps underscores from file names, so 'wave_pop_take2.mov' becomes 'wave_pop_take2'. `scripts/dance-routine.ts import` then fails RoutineData validation unless the user passes `--id`. A routine id would never parse as `Routine <id> v..` in the terms.  
  Fix: Use `^[a-z0-9]+(-[a-z0-9]+)*$` with max 32 in ID_PATTERN and the usage text. In slugFromPath, map '_' to '-', collapse repeated dashes, and truncate to 32.
- **[minor] native** `apps/mobile/modules/dance-pose/__tests__/dancePose.test.ts:1` — The native module's tests never run. The include list in apps/mobile/vitest.config.mts covers src/** and scripts/** but not modules/**. So the source-scanning guards never execute: Swift and TS joint order, events and props, the pinned revision, and the .easignore order.  
  Fix: Add 'modules/**/*.test.ts' to `include` in apps/mobile/vitest.config.mts. That file has no owner; the native agent asked for this change.