## native
API: From apps/mobile/modules/wake-word (index.ts):
  const WakeWord: WakeWordModule | null
  function addTranscriptListener(fn: (e: WakeWordTranscriptEvent) => void): WakeWordSubscription
  function addStateListener(fn: (e: WakeWordStateEvent) => void): WakeWordSubscription
  function isWakeWordAvailable(locale?: string): boolean
  function requestWakeWordPermissions(): Promise<WakeWordPermissions>   // never rejects
  function startWakeWord(options?: WakeWordStartOptions): Promise<WakeWordStartResult>   // never rejects; {ok:false, reason:'unavailable'} without native
  function stopWakeWord(): Promise<void>   // resolves after mic + session are released
  pure: normalizeStartOptions, toTranscriptEvent, toStateEvent, toStartResult, toPermissions, permissionsGranted
  consts: WAKE_WORD_MODULE='WakeWord', TRANSCRIPT_EVENT='onTranscript', STATE_EVENT='onState', DEFAULT_LOCALE='en-US', DEFAULT_CONTEXTUAL_STRINGS=['Jarvis']
  types: WakeWordModule { isAvailable(locale?): boolean; requestPermissions(): Promise<WakeWordPermissions>; start(options?): Promise<WakeWordStartResult>; stop(): Promise<void>; addListener<E extends keyof WakeWordEvents>(name: E, fn: WakeWordEvents[E]): WakeWordSubscription }
         WakeWordPermissions { speech: 'granted'|'denied'|'restricted'|'undetermined'; mic: 'granted'|'denied'|'undetermined' }
         WakeWordStartOptions { locale?: string; contextualStrings?: string[]; onDevice?: boolean }
         WakeWordStartResult { ok: boolean; onDevice: boolean; reason?: string }
         WakeWordTranscriptEvent { text: string; isFinal: boolean; segment: number }
         WakeWordStateEvent { state: 'listening'|'stopped'|'restarting'|'error'|'interrupted'; message?: string }
         WakeWordEvents, WakeWordSubscription, ResolvedStartOptions, SpeechPermission, MicPermission
Native (Swift): Name("WakeWord"); Events("onTranscript","onState"); Function("isAvailable"); AsyncFunction("requestPermissions"|"start"|"stop").
INTEGRATION:
- apps/mobile/app.json, under expo.ios.infoPlist: add "NSSpeechRecognitionUsageDescription": "You're On listens for \"Jarvis\" on this device so you can say your challenge out loud instead of typing it." Without it, requestPermissions reports speech as 'denied' and start fails with 'speech-permission'. The 'has both usage strings' test in modules/wake-word/__tests__/wakeWord.test.ts fails until this key exists. Optionally extend NSMicrophoneUsageDescription to mention saying "Jarvis".
- apps/mobile/vitest.config.mts: change include to ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'modules/**/*.test.ts']. Right now no test under modules/ runs, including the existing dance-pose tests.
- Native rebuild required: npx expo prebuild -p ios --clean, then pod install (the log should list the WakeWord pod), or a new EAS build. .easignore already re-includes apps/mobile/modules/*/ios/, so no change is needed there.
- Import from app code (for example apps/mobile/src/app/*.ts): import { addTranscriptListener, addStateListener, requestWakeWordPermissions, startWakeWord, stopWakeWord, isWakeWordAvailable } from '../../modules/wake-word'. A static import is boot-safe: it only pulls in 'expo', and requireOptionalNativeModule is wrapped in try/catch. importSafely is not needed.
- JS wake flow (integration step): requestWakeWordPermissions(), check permissionsGranted, then startWakeWord({ contextualStrings: ['Jarvis'] }). On each onTranscript, re-parse the whole text, because it is cumulative within one segment and resets when segment changes. Match the wake word loosely (e.g. /\b(jarvis|jervis)\b[\s,.!?:-]*(.*)$/i) and show the rainbow loop when it first matches. Treat the challenge as finished on isFinal or after ~1.2-1.5 s with no change to the text after the wake word. Then await stopWakeWord() and only then start the ElevenLabs/LiveKit session with the captured sentence as its first user message.
- JS must call stopWakeWord() on AppState 'background', since native does not handle backgrounding. JS must also never call startWakeWord while a LiveKit room is connected, because start re-categorises the shared AVAudioSession.
- onState emits 'restarting' then 'listening' on every task rotation (about every 50 s or on silence). UI such as the rainbow loop must not react to those. 'error' is terminal: the mic is released and no 'stopped' follows. 'interrupted' means a call or Siri took the audio, and the listener resumes by itself afterwards.
OPEN:
- Nothing was compiled, type-checked or run (that was the rule while you're in class). The Swift was checked by reading the expo-modules-core 58.0.30 sources and the iOS 26.5 SDK headers, but it still needs a real Xcode build. The riskiest spots are which AsyncFunction overload Swift picks for the non-async closures (the same pattern as expo-local-authentication and dance-pose) and the `#if compiler(>=6.2)` switch to .allowBluetoothHFP.
- The 'benign' speech error codes (kAFAssistantErrorDomain 203, 216, 301, 1101, 1110 and SFSpeechErrorDomain 12) are undocumented and taken from what people have observed. Classifying them wrong only changes whether a failure is counted toward the 6-error cutoff.
- The recognizer may spell the wake word differently ('Jervis', 'Travis', 'jarvis,'). contextualStrings helps, but the JS matcher should be fuzzy. The native check for 'wake word heard' (which only extends the rotation limits) does a case- and diacritic-insensitive substring match on contextualStrings.
- On some iOS versions the on-device recognizer restarts its text within the same task after a long pause, so JS must not assume the text only grows.
- On-device recognition needs the en-US model (Dictation enabled). If it is missing, start reports onDevice:false and uses server recognition. If requiresOnDeviceRecognition is set but the model isn't usable, tasks may keep failing until the 6-error cutoff stops the listener. There is no automatic fallback to server recognition, to respect the onDevice choice.
- stop() restores the audio category that was set before start. If expo-audio or another library relies on the session staying .playAndRecord afterwards, that is a change. LiveKit reconfigures its own session, so it is unaffected.
- None of the tests have been run. They live under modules/wake-word/__tests__, which the current vitest include does not cover (see integration notes).

## detector
API: useWakeWord({ enabled: boolean; onWake(): void; onUtterance(text: string): void; onCancel?(): void; onError?(message: string): void; timing?: Partial<WakeTiming> }) => { status: WakeStatus; available: boolean; resume(): void }
WakeStatus = 'off' | 'unavailable' | 'denied' | 'listening' | 'capturing' | 'heard' | 'error'   // 'heard' is extra: challenge delivered, mic released, waiting for resume() or a re-enable
createWakeDetector(timing?: Partial<{endSilenceMs (1300); maxUtteranceMs (9000); noTailTimeoutMs (4000); finalQuietMs (500)}>) => { feed({text,isFinal,segment}, nowMs): WakeEvent[]; tick(nowMs): WakeEvent[]; reset(opts?: {skipThroughSegment?: number}): void; phase: 'idle'|'capturing'|'done'; partial: string; lastSegment: number }
WakeEvent = {type:'wake'} | {type:'utterance'; text: string; reason: 'silence'|'final'|'max'|'no_tail'}
createWakeController({ load(): Promise<WakeNative|null>; callbacks: {onWake, onUtterance, onCancel?, onError?, onStatus?, onAvailable?}; timing?; clock?; tickMs?; locale? }) => { setEnabled(b); setForeground(b); resume(); dispose(); status; available }
phrase: WAKE_WORD='Jarvis', WAKE_SPELLINGS, LEADING_FILLERS, isWakeKey(key), findWakes(text): {start,end}[], hasWake(text), splitAfterWake(text): {found, tail}, cleanTail(text), normalizeTranscript(text), tokenize, wordKey, boundedLevenshtein
copy: WAKE_COPY {hint 'Say “Jarvis”', listening 'Listening', capturing 'Go ahead', heard 'Heard you', youSaid 'You said', noChallenge 'Say the challenge', tapToTalk 'Tap to talk', denied 'Mic access off'(error), openSettings 'Open Settings', unavailable 'Voice unavailable'(error), failed 'Voice stopped'(error)}, STATUS_COPY: Record<WakeStatus, Line|null>, wt(line)
Barrel: apps/mobile/src/wake/index.ts (no static import of the native module; does not re-export RainbowLoop)
INTEGRATION:
- Mount useWakeWord ONCE (DemoApp level): there is one native recognizer per app. Suggested wiring: `const wake = useWakeWord({ enabled: <a screen where a challenge can start> && !judgeVoiceActive, onWake: () => setLoopVisible(true), onUtterance: (text) => { setLoopVisible(false /* or switch RainbowLoop to mode 'thinking' */); startJudgeWith(text /* may be '' */); }, onCancel: () => setLoopVisible(false) })`. The rainbow can also be driven straight from `wake.status === 'capturing'`.
- Set enabled to false while the ElevenLabs/LiveKit judge session is live, and back to true when it ends. The false → true toggle re-arms listening after 'heard'; `wake.resume()` does the same without toggling.
- When onUtterance('') arrives (only "Jarvis" was said), start the judge with no first message, or show WAKE_COPY.noChallenge.
- Fallbacks: for status 'denied', 'unavailable' or 'error', show WAKE_COPY.tapToTalk and the line from STATUS_COPY[status]; for 'denied', also WAKE_COPY.openSettings (Linking.openSettings()).
- apps/mobile/src/ui/__tests__/cryptoCopyAudit.test.ts: add 'wake' to SCREEN_DIRS so the new strings are audited (they contain no flagged words).
- app.json / Info.plist need NSSpeechRecognitionUsageDescription. NSMicrophoneUsageDescription probably exists already for the judge. This belongs to the native/config agent.
- The barrel does not re-export RainbowLoop (another agent's file). Add `export { RainbowLoop } from './RainbowLoop'; export type { RainbowLoopMode, RainbowLoopProps } from './RainbowLoop';` to src/wake/index.ts if you want one import site.
- Type-checking useWakeWord.ts needs modules/wake-word/index.ts to export WakeWord, isWakeWordAvailable, requestWakeWordPermissions, startWakeWord, stopWakeWord, addTranscriptListener and addStateListener. It exports all of them now. The real module is assigned to a local WakeWordBinding interface, so any later rename shows up as a tsc error in useWakeWord.ts.
- bootImports.test.ts needs no change: the native module is reached only through importSafely(() => import(...)). The wake files contain no animation, so the motion audit is unaffected.
OPEN:
- Not run: tsc and vitest were deliberately skipped (user in class). Every test case was traced by hand, but please run `npx vitest run src/wake` and `npx tsc -p apps/mobile` when possible.
- If the recognizer adds a final result to the transcript only after a pause, finalQuietMs (500 ms) lets that final end the capture early. Otherwise capture ends on endSilenceMs (1.3 s of no text change). Tune both on a device.
- Interruption mid-capture (a call, Siri) cancels the capture rather than delivering a partial challenge. Backgrounding mid-capture or disabling while the mic is being released does the same.
- Native 'error' and unsolicited 'stopped' are treated as fatal: status 'error' plus onError. The controller retries when the app returns to the foreground, on a re-enable, or on resume(). This matches WakeListener.swift, which emits 'error' only from fail() after tearing down.
- isWakeWordAvailable() is called with the default locale ('en-US'). The controller's `locale` option is only passed to start().

## loop
API: RainbowLoop.tsx:
- `export function RainbowLoop(props: RainbowLoopProps): JSX.Element | null`
- `export type RainbowLoopProps = { active: boolean; mode?: RainbowLoopMode /* default 'listening' */; cornerRadius?: number /* default displayCornerRadius(window) */; testID?: string /* default 'rainbow-loop' */ }`
- `export type RainbowLoopMode = 'listening' | 'thinking'`

spectrum.ts (pure; no react-native imports):
- `LOOP` (tuning constants: segment counts, widths, overlap, turn ms, breathMs, fadeInMs = motion.momentMs, fadeOutMs = modeMs = MAX_TRANSITION_MS, zIndex 1000, defaultCornerRadius 48, saturation, lightness)
- `loopGeometry(width, height, radius, inset = 0): { d: string; length: number; radius: number }`
- `roundedRectPerimeter(w, h, r): number`
- `fmt(n): string`
- `segmentDashes(length, n, overlap = LOOP.overlap): { start: number; dash: readonly [number, number] }[]`
- `type LoopSegment`, `type LoopGeometry`, `type SpectrumOptions`
- `displayCornerRadius(width, height): number`
- worklets: `dashOffset(start, phase, length)`, `advancePhase(phase, dtMs | null, level)`, `glowOpacity(breath, level)`, `coreOpacity(level)`, `clamp01`, `mix`
- `hslToRgb(hue, s, l): [r, g, b]`
- `spectrumColor(t, opts?): string` (an 'rgb(r, g, b)' string)
- `spectrumColors(n, opts?: { saturation?, lightness?, hueStart? }): string[]`
INTEGRATION:
- Mount once as the LAST child of the app's root view (after the navigator, sheets and toasts), e.g. `<RainbowLoop active={wakeState !== 'idle'} mode={judgeIsThinking ? 'thinking' : 'listening'} />`. It is absolute-fill with zIndex 1000 and pointerEvents 'none', and it ignores safe areas. Mode semantics: 'listening' runs from the wake word through the challenge sentence; 'thinking' is for while the judge processes or replies.
- It will not draw over native modals: RN <Modal> and react-native-screens formSheet/modal presentations render in their own window or view controller. If the wake flow can fire while one is open, render a second <RainbowLoop> inside that modal too.
- The overlay is hidden from VoiceOver (accessibilityElementsHidden / no-hide-descendants). The screen that owns the mic should announce it, e.g. `AccessibilityInfo.announceForAccessibility('Listening')` when the wake fires.
- Recommended ui/tokens.ts exception (tokens.ts is not in my ownership). Add after `glow`:
```ts
/**
 * Voice activation only ("Jarvis" heard, the judge listening/thinking): the full hue wheel,
 * computed by wake/spectrum as rgb() strings for the RainbowLoop edge light. Never a fill, never
 * text, never a screen colour. The one documented exception to "two chromatic colours";
 * ALLOWED_COLORS stays palette-only.
 */
export const spectrum = {
  saturation: 1,
  lightness: 0.6,
  reservedFor: 'voice-activation',
} as const;
```
Then, in wake/spectrum.ts, set `LOOP.saturation: spectrum.saturation, lightness: spectrum.lightness` (import { spectrum } from '../ui/tokens'). Optionally add to ui/__tests__/tokens.test.ts: `it('the voice spectrum is a reserved exception, not a palette colour', () => { expect(spectrum.reservedFor).toBe('voice-activation'); expect(Object.keys(palette)).not.toContain('spectrum'); })`. Today's audits (the tokens.test palette checks, motionAudit, bootImports) pass without this change.
- No new native dependencies. It uses only react-native-reanimated, react-native-svg, react-native-worklets (scheduleOnRN) and react-native, so no bootImports or importSafely changes are needed, and it is safe to import statically at boot.
- Haptic pairing is not included (the visual only). Suggested: fire `feel('challengeArrived')` or a light impact from device/feedback when the wake is detected, at the same moment `active` turns true.
OPEN:
- Not verified anywhere: no tsc, no vitest, no device. Highest-risk spots to check on first run: (a) the TS type of `animatedProps={useAnimatedProps<PathProps>(...)}` on `Animated.createAnimatedComponent(Path)`; if tsc complains, drop the `<PathProps>` generic; (b) strokeDashoffset actually updating on Fabric iOS. That pattern is reanimated's documented Circle example, and the RNSVGRenderable setter invalidates and redraws.
- Performance budget: while visible, 60 animated props update per frame (36 core + 24 glow; halo and glow share one) and two full-screen SVG canvases redraw on the main thread. This should be fine at 60fps but is worth profiling on an older phone. If it's heavy: lower LOOP.coreSegments to 24, or switch to one animated strokeDashoffset on a <G> per layer. Children would encode their start in the dash array as [0, start, dash, rest] and inherit the offset; RNSVGGroup's mergeProperties supports this inheritance, but I didn't use it because it is the less-trodden path.
- The display corner radii in displayCornerRadius are approximate public figures. Sizes shared by two models resolve to the larger radius, so the arc stays on the screen rather than being clipped. iPhone Air / 17-series sizes not in the table fall back to 48. The cornerRadius prop overrides.
- useReducedMotion (reanimated) is read once and does not update live if the user toggles Reduce Motion while the app runs. This matches press.tsx and Skeleton.tsx.
- Hue banding: 36 core hues are 10 degrees apart. Banding on the 3.5pt line should be faint thanks to the overlap but is untested on a real display. Raising coreSegments costs one animated prop per extra hue.

## findings
- [native/major] /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/app.json: expo.ios.infoPlist has NSMicrophoneUsageDescription but no NSSpeechRecognitionUsageDescription. Without the key, WakeListener.requestPermissions skips the speech prompt and reports speech 'denied'. The controller then latches 'denied' and never calls start(), so the feature can't work on any build. The 'has both usage strings in app.json' test in modules/wake-word/__tests__/wakeWord.test.ts also fails. This is the integration step the builder listed; it is still undone.
- [native/minor] /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/vitest.config.mts: test.include is ['src/**/*.test.ts', 'scripts/**/*.test.ts'], so modules/wake-word/__tests__/wakeWord.test.ts never runs. It is the only guard on the Swift/JS name and payload contract and on the build config. The dance-pose module tests have the same gap.
- [detector/minor] /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/wake/controller.ts: ensureLoaded() checks native.isAvailable() (SFSpeechRecognizer.isAvailable) once, at mount. If it is false at that moment (offline with no on-device model, or Dictation off), the controller sets 'unavailable' for the rest of the session. wanted() then stays false, the transcript and state listeners are never subscribed, and nothing re-checks: not foregrounding, not resume(), not toggling enabled. Apple documents that availability changes over time. Native start() already returns 'recognizer-unavailable', and that path recovers on its own (status 'error', retried on foreground or resume).
- [detector/minor] /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/wake/detector.ts: The 'revised the wake word away' branch (segment === wakeSegment, wake not found) keeps the old tail and drops every new word. The native OPEN notes say the iOS on-device recognizer can restart formattedString within the same task after a pause. Example: 'Jarvis, I bet Mo' then, after a short pause in the same segment, 'can't do ten pushups'. The detector captures only 'I bet Mo', and the extra words just hold the capture open until the silence timeout.
- [loop/minor] /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/wake/spectrum.ts: loopGeometry starts the closed path at cx = width / 2. On 393/430-pt-wide phones (14 Pro, 15, 16, Plus) that is x = 196.5 / 215, a half-pixel boundary on a 3x display. Whichever dash crosses the path start is drawn as two butt-capped pieces meeting there (CoreGraphics does not join dashes across the closepath). Both pieces are anti-aliased on the same half-covered pixel column, so it composites to about 75% alpha: a faint dark hairline at the top centre as each hue passes, every lap.

## fixes
[
 {
  "owner": "native",
  "fixed": [],
  "rejected": [
   "app.json lacks NSSpeechRecognitionUsageDescription (major). I checked this and it is a REAL bug, but I did not fix it because the file is outside my ownership (apps/mobile/modules/wake-word/**). It must go to the integrator. What I confirmed: apps/mobile/app.json expo.ios.infoPlist has only NSCameraUsageDescription (line 16) and NSMicrophoneUsageDescription (line 17). WakeListener.swift:138 checks hasUsageDescription(\"NSSpeechRecognitionUsageDescription\"), and without the key it reports speech 'denied' and start fails with 'speech-permission' (line 242). The test at modules/wake-word/__tests__/wakeWord.test.ts:136-139 would fail. Nothing inside the module can supply the key. expo-module.config.json cannot set Info.plist keys, and a module config plugin would itself need an entry in app.json 'plugins', which is also outside my ownership. The native side refusing to prompt without the key is correct (iOS would kill the app). Fix for the integrator: add \"NSSpeechRecognitionUsageDescription\": \"You're On listens for \\\"Jarvis\\\" on this device so you can say your challenge out loud instead of typing it.\" under expo.ios.infoPlist in /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/app.json, then do a native rebuild (prebuild + pod install or a new EAS build).",
   "vitest.config.mts include skips modules/**/*.test.ts (minor). I checked this and it is a REAL gap, but I did not fix it because the file is outside my ownership. What I confirmed: /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/vitest.config.mts has include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'], so neither modules/wake-word/__tests__/wakeWord.test.ts nor the dance-pose module tests run. A nested vitest config inside modules/wake-word would not fix it, because it is ignored unless --config is passed explicitly. Fix for the integrator: change include to ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'modules/**/*.test.ts']. Once the app.json key above is added, the wake-word test's app.json assertions will pass."
  ]
 },
 {
  "owner": "detector",
  "fixed": [
   "controller.ts availability (minor, confirmed). ensureLoaded() did set `available = native !== null && native.isAvailable()` once at load and subscribed to the listeners only when that was true, so a recognizer that was unavailable at mount left the controller stuck in 'unavailable'. Native WakeListener.swift start() already checks `recognizer.isAvailable` and returns 'recognizer-unavailable' (line 250). Fix: `available = native !== null`, and the listeners are subscribed whenever native is non-null. I removed `isAvailable()` from the WakeNative interface (its doc comment explains why) and from the adapter and WakeWordBinding in /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/wake/useWakeWord.ts. I also updated the status and `available` doc comments: 'unavailable' now means only that the module is missing from this binary. An unavailable recognizer now goes through start() failing, then failed=true and 'error', which retries on setForeground(true), resume() and re-enable. Tests in /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/wake/__tests__/controller.test.ts: I dropped FakeNative.available/isAvailable and the 'no recognizer for the locale' unavailable case. I added 'a recognizer unavailable right now is a retried error, not a stuck unavailable': start returns recognizer-unavailable, giving status 'error' with available=true; then background/foreground retries, the status becomes 'listening', and a transcript fires 'wake', which proves the listeners are subscribed.",
   "detector.ts same-task restart (minor, confirmed). In the branch where segment === wakeSegment and no wake word is found, the code only bumped lastChangeAt, so a restarted formattedString lost every new word. Fix in /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/wake/detector.ts: a new helper `revises(text, tail)` counts it as a revision when the normalized tail occurs in the normalized text as whole words (space-bounded, so 'go' does not match 'going'), or when the tail is empty, since there is then nothing to tell the two cases apart. On a revision the old behaviour stays: lastChangeAt is bumped when the raw key changed. Otherwise it is a restart: `committed = join(committed, current); current = cleanTail(text); wakeSegment = -1;`, so later events in that task take the continuation branch. I traced the existing 'revising the wake word away' test by hand and it still passes, as do all other detector tests, because their same-segment feeds contain the wake word. New tests in /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/wake/__tests__/detector.test.ts: 'Jarvis I bet Mo' at 0, \"can't do ten\" at 800, then \"can't do ten pushups\" at 1200 gives partial \"I bet Mo can't do ten pushups\" and silence at 2500. A whole-word check makes 'Jarvis go' followed by 'going home' give 'go going home'. Prettier --check passes on all 5 touched files. Not run: tsc and vitest (as instructed)."
  ],
  "rejected": []
 },
 {
  "owner": "loop",
  "fixed": [
   "spectrum.ts loopGeometry (path start on a half point): the closed path now starts at a whole point, `const cx = Math.min(Math.max(Math.round(width / 2), x0 + r), x1 - r);`, in /Users/loganstaples/dev/hackathons/ubc26/UBC-2026/apps/mobile/src/wake/spectrum.ts. The split where the dash crosses the path start now falls on a whole pixel at every scale. This replaces the old width / 2, which was 196.5 or 215 on 393 and 430 pt wide phones.",
   "I added a clamp that the suggested fix did not have. With Math.round alone, a radius clamped to half an odd width (for example width 101, r 50.5) would put the start at 51, past x1 - r = 50.5. The first H would then run backwards and the top would overdraw. The clamp keeps the start on the top straight run. When r equals w/2 there is no straight run, so the start stays at the exact arc join (unrounded), which is correct.",
   "Path length is unchanged because the path is closed and the start point only moves along the top run. RainbowLoop.tsx needed no change: it only uses geometry.d and geometry.length.",
   "spectrum.test.ts: changed the phone expectation to `[Math.round(PHONE.width / 2), 0]`. The inset test (width 400, start [200, 4]) is unchanged.",
   "spectrum.test.ts: added the test 'starts on a whole point, kept on the top run when the radius fills an odd width'. For widths 393, 430, 375, 402 and 440 it checks that the start x is a whole number within 0.5 of the centre. For loopGeometry(101, 300, 999) it checks that the start is [50.5, 0] and that the walked length equals the perimeter. The walker sums abs deltas, so a path that ran backwards would fail this test.",
   "Nothing was run (no vitest, no tsc), per the rules. My new lines are within the 100-character print width. The only longer line in the test file was already there: the existing 'draws a closed, clockwise rounded rect...' test name, at 104 characters."
  ],
  "rejected": []
 }
]