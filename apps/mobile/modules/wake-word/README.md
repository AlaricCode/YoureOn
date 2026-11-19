# WakeWord (local Expo module)

On-device "Jarvis" wake phrase listener for iOS. The phone streams microphone audio
(`AVAudioEngine` input tap) into `SFSpeechAudioBufferRecognitionRequest` and sends every partial
transcription to JS. JS decides when "Jarvis, <the challenge>" has been said, pulls the sentence
after "Jarvis", calls `stop()`, and once `stop()` resolves the microphone and the audio session are
free for the ElevenLabs / LiveKit judge session.

Autolinked from `apps/mobile/modules/` (no package.json; the pod version lives in
`ios/WakeWord.podspec`). Apple only. A binary built without it still runs: `WakeWord` is `null`,
the listener helpers are no-ops and `startWakeWord()` resolves `{ ok: false, reason: 'unavailable' }`.

## Files

| File                         | What                                                               |
| ---------------------------- | ------------------------------------------------------------------ |
| `expo-module.config.json`    | `{ platforms: ['apple'], apple: { modules: ['WakeWordModule'] } }` |
| `ios/WakeWord.podspec`       | ExpoModulesCore dependency, `Speech` + `AVFoundation`, iOS 16.4    |
| `ios/WakeWordModule.swift`   | The Expo module definition (`Name("WakeWord")`, events, functions) |
| `ios/WakeListener.swift`     | Speech + audio engine logic, on one serial queue                   |
| `index.ts`                   | Typed JS binding + never-throwing helpers                          |
| `src/types.ts`               | The contract's TypeScript types                                    |
| `src/payload.ts`             | Pure payload validators and option defaults (node-testable)        |
| `__tests__/wakeWord.test.ts` | Payload tests + Swift/JS/build-config drift guards                 |

## Contract

```ts
import {
  WakeWord, // WakeWordModule | null (requireOptionalNativeModule('WakeWord'))
  addTranscriptListener,
  addStateListener,
  isWakeWordAvailable,
  requestWakeWordPermissions,
  startWakeWord,
  stopWakeWord,
} from '../../modules/wake-word'; // path from apps/mobile/src/<dir>/
```

Native module (`WakeWord`):

| Member                            | Returns                                                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isAvailable(locale?)` (sync)     | `boolean`: `SFSpeechRecognizer(locale:)` exists (default `en-US`) and `isAvailable`                                                                |
| `requestPermissions()`            | `{ speech: 'granted'\|'denied'\|'restricted'\|'undetermined'; mic: 'granted'\|'denied'\|'undetermined' }`                                          |
| `start(options?)`                 | `{ ok: boolean; onDevice: boolean; reason?: string }`                                                                                              |
| `stop()`                          | `void`, resolved only after the task is cancelled, the tap removed, the engine stopped and the session deactivated (`.notifyOthersOnDeactivation`) |
| `addListener('onTranscript', fn)` | `{ text: string; isFinal: boolean; segment: number }`                                                                                              |
| `addListener('onState', fn)`      | `{ state: 'listening'\|'stopped'\|'restarting'\|'error'\|'interrupted'; message?: string }`                                                        |

`start` options: `locale` (default `'en-US'`), `contextualStrings` (default `['Jarvis']`; also the
words native treats as "the wake word was heard"), `onDevice` (default `true`:
`requiresOnDeviceRecognition` is set when the recognizer `supportsOnDeviceRecognition`; the result's
`onDevice` says whether it was).

Neither `start` nor `requestPermissions` rejects. `start` failure reasons: `speech-permission`,
`mic-permission`, `unsupported-locale`, `recognizer-unavailable`, `no-audio-input`,
`audio-session: …`, `audio-engine: …` (plus, from the JS helper, `unavailable` and `native-error: …`).
`start` does not prompt; call `requestPermissions()` first.

### Transcript semantics

- `text` is the cumulative best transcription (`bestTranscription.formattedString`) of the
  **current** recognition task. It is not appended across tasks.
- `segment` increments every time a new task starts (monotonic for the app launch). When it
  changes, start parsing from scratch: the previous task's text is gone.
- Within one segment the text normally grows, but the recognizer may revise earlier words (and on
  some iOS versions restarts its text after a long pause), so always re-parse the whole `text`.

### Task rotation (why `segment` changes)

A fresh request + task replaces the current one (the audio engine keeps running, `onState` emits
`restarting` then `listening`) when:

- the task ends on its own: a final result, or an error ("no speech detected", cancellation, …);
- 50 s have passed (Apple ends a task at about a minute). If the wake word is already in the
  transcript, it waits 8 s more, once, so "Jarvis, <challenge>" is not cut in half;
- the transcript is longer than 200 characters without the wake word (1000 with it).

Hard errors back off (0.25 s × n, at most 1.5 s). After 6 in a row with no transcript in between,
the listener gives up: it releases the mic and emits `onState { state: 'error', message }`
(terminal: no `stopped` follows; call `start` again to retry).

### Audio session

`start` sets `.playAndRecord`, mode `.default`, options `[.mixWithOthers, .defaultToSpeaker,
.allowBluetoothHFP]` (`.allowBluetooth` before Xcode 26) and activates the session. `.mixWithOthers`
instead of `.duckOthers`: the listener can stay on for minutes and ducking other apps that long is
worse than slightly noisier recognition. Mode `.default` rather than `.measurement`, which turns
playback down. `stop` deactivates with `.notifyOthersOnDeactivation` and restores the category, mode
and options that were set before `start` (only when the deactivation succeeded, so audio still
playing elsewhere in the app is not re-categorised). LiveKit / WebRTC configure their own session
when they start, so start the judge session **after** `stop()` resolves, and never run `start` while
a LiveKit room is connected (it would re-categorise WebRTC's session).

### Interruptions and route changes

- `AVAudioSession.interruptionNotification` `.began` (a call, Siri, an alarm): the task and engine
  stop and `onState { state: 'interrupted' }` is emitted. `.ended`: the session is reactivated, a new
  engine and task start (`restarting` → `listening`), up to 3 attempts, then `error`.
- Route changes (`.newDeviceAvailable` / `.oldDeviceUnavailable`, e.g. AirPods in or out),
  `AVAudioEngineConfigurationChange` for our engine, and `mediaServicesWereReset` rebuild the engine
  (debounced 0.4 s) with the new input format.
- App backgrounding is **not** handled natively: JS should `stop()` on `AppState` `background`
  (and `start()` again on `active` if the screen still wants it).

## Permissions (app.json)

Both keys must be in `expo.ios.infoPlist`. Without `NSSpeechRecognitionUsageDescription`, iOS kills
the app the moment speech authorization is requested, so `requestPermissions()` refuses to prompt
and reports `denied` instead (and logs `[WakeWord] … is missing from Info.plist`).

```json
"NSSpeechRecognitionUsageDescription": "You're On listens for \"Jarvis\" on this device so you can say your challenge out loud instead of typing it.",
"NSMicrophoneUsageDescription": "…already present; it should also mention saying \"Jarvis\" to start a challenge."
```

No entitlement or background mode is needed (listening happens in the foreground only).

## Rebuilding

New native code: the installed dev client / TestFlight binary does not have it until it is rebuilt.

- Local device build: `cd apps/mobile && npx expo prebuild -p ios --clean` then
  `cd ios && pod install` and build from Xcode (or `npx expo run:ios --device`). Check that the
  `pod install` log lists `WakeWord`.
- EAS: `eas build -p ios --profile <profile>`. The root `.easignore` already re-includes
  `apps/mobile/modules/*/ios/` (the repo-wide `ios/` rule would drop it).
- JS-only changes to `index.ts` / `src/*` need no rebuild.

## Device test checklist

Run on a real iPhone (the simulator has no reliable microphone and no on-device speech models).

1. Fresh install: `requestWakeWordPermissions()` shows the speech prompt, then the mic prompt;
   both granted → `{ speech: 'granted', mic: 'granted' }`. Deny one → `start` resolves
   `{ ok: false, reason: 'speech-permission' | 'mic-permission' }`, no crash.
2. `isWakeWordAvailable()` is `true`; `startWakeWord()` → `{ ok: true, onDevice: true }` on a device
   with the en-US on-device model (Settings → General → Keyboard → Dictation enabled helps).
3. Say "Jarvis, I bet you can't do ten push-ups": `onTranscript` events grow in one segment and the
   text contains "Jarvis" (check how it is spelled/cased in practice; "Jarvis" is the contextual
   string). The orange mic indicator is on.
4. `stopWakeWord()` resolves within ~100 ms; the mic indicator goes off; an ElevenLabs/LiveKit
   session started right after it hears you (no silent mic, no "session activation failed").
5. Stay silent for 2 minutes: `segment` keeps increasing (rotation every ~50 s or on "no speech"),
   no `error` state, and saying "Jarvis …" afterwards still works.
6. Talk continuously without saying Jarvis for 30 s: a new segment starts once the text passes
   200 characters.
7. Plug in / unplug wired or Bluetooth headphones while listening: `restarting` → `listening`, and
   recognition keeps working from the new mic.
8. Trigger Siri or receive a call while listening: `interrupted`, then `restarting` → `listening`
   when it ends.
9. Background the app (JS stops it) and come back: listening resumes if the screen restarts it.
10. Play music in another app, then start listening: the music keeps playing (mixed, not ducked
    or stopped); after `stop` it is unaffected.
11. Call `startWakeWord()` twice in a row: the second call replaces the first session (one segment
    bump, no crash, no double audio).
12. Install a build without the module (or Expo Go): importing the module does not crash;
    `WakeWord === null`; `startWakeWord()` → `{ ok: false, reason: 'unavailable' }`.
