// The diagnostics list for EAS build #1 (TASKS D0-M2, "D0-M2 diagnostics that must be green").
// Pure data: no native imports, so it is testable in Node and shared by the screen and the report.

export type CheckKind =
  /** Runs by itself from the "Run checks" button. */
  | 'auto'
  /** Needs a camera panel open, where the user presses a button. */
  | 'interactive'
  /** Runs by itself, then needs the person holding the phone to confirm (haptics). */
  | 'confirm';

export type CameraPanel = 'vision' | 'expo';

export interface CheckSpec {
  id: string;
  label: string;
  /** Required = on the D0-M2 list; the build is green only when every required check passes. */
  required: boolean;
  kind: CheckKind;
  /** For interactive checks: which camera panel runs it. */
  panel?: CameraPanel;
  /** One line shown under the label: what the check does, or what to do. */
  hint: string;
}

export const CHECKS = [
  // ---- Required (TASKS D0-M2, in the spec's order) ----
  {
    id: 'vision-camera-preview',
    label: 'VisionCamera preview',
    required: true,
    kind: 'interactive',
    panel: 'vision',
    hint: 'Open the VisionCamera panel; passes on the first preview frame.',
  },
  {
    id: 'tflite-warmup',
    label: 'TFLite model loads + one warm-up inference',
    required: true,
    kind: 'auto',
    hint: 'Loads w600k_mbf_float32.tflite (CPU), checks tensors, runs one zero input.',
  },
  {
    id: 'mlkit-still-face',
    label: 'ML Kit detects a face on a still',
    required: true,
    kind: 'interactive',
    panel: 'vision',
    hint: 'In the VisionCamera panel, face the camera and tap "Capture still + detect".',
  },
  {
    id: 'expo-camera-record',
    label: 'expo-camera records 2 s',
    required: true,
    kind: 'interactive',
    panel: 'expo',
    hint: 'Open the expo-camera panel and tap "Record 2 s" (avc1, 720p).',
  },
  {
    id: 'local-auth-hardware',
    label: 'LocalAuthentication.hasHardwareAsync() is true',
    required: true,
    kind: 'auto',
    hint: 'Also reports enrolment and the supported biometry types. Never prompts.',
  },
  {
    id: 'secure-store-rw',
    label: 'SecureStore write + read',
    required: true,
    kind: 'auto',
    hint: 'Writes, reads back and deletes a throwaway item (WHEN_UNLOCKED_THIS_DEVICE_ONLY).',
  },
  {
    id: 'haptics',
    label: 'Haptics fire',
    required: true,
    kind: 'confirm',
    hint: 'Fires impact + success haptics; confirm you felt them (off in Low Power Mode).',
  },
  {
    id: 'mic-livekit',
    label: 'Mic permission granted + LiveKit imports',
    required: true,
    kind: 'auto',
    hint: 'Requests the mic, imports @livekit/react-native and @elevenlabs/react-native.',
  },
  // ---- Extra (not on the D0-M2 list; they catch a missing native module early) ----
  {
    id: 'reanimated-worklets',
    label: 'Reanimated + worklets run on the UI runtime',
    required: false,
    kind: 'auto',
    hint: 'Runs one worklet with runOnUIAsync (HoldToConfirm, D1-M5, needs it).',
  },
  {
    id: 'gesture-handler',
    label: 'Gesture handler loads',
    required: false,
    kind: 'auto',
    hint: 'Imports react-native-gesture-handler 3 (GestureHandlerRootView wraps the app).',
  },
  {
    id: 'notifications',
    label: 'Notifications module loads',
    required: false,
    kind: 'auto',
    hint: 'Reads the notification permission status. Never prompts.',
  },
  {
    id: 'expo-video-frames',
    label: 'expo-video extracts frames from the clip',
    required: false,
    kind: 'interactive',
    panel: 'expo',
    hint: 'After the 2 s recording: 2 thumbnails via generateThumbnailsAsync, plus the clip sha256.',
  },
  {
    id: 'wallet',
    label: 'Wallet store + CSPRNG + signer pre-warm',
    required: false,
    kind: 'auto',
    hint: 'Reads the pubkey item (never creates a wallet), probes getRandomValues, pre-warms noble (D0-M3).',
  },
] as const satisfies readonly CheckSpec[];

export type CheckId = (typeof CHECKS)[number]['id'];

export const REQUIRED_CHECK_IDS: readonly CheckId[] = CHECKS.filter((c) => c.required).map(
  (c) => c.id,
);

export function getCheck(id: CheckId): CheckSpec {
  const found = CHECKS.find((c) => c.id === id);
  if (!found) throw new Error(`unknown check ${id}`);
  return found;
}
