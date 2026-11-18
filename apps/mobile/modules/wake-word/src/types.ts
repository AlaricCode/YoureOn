// The WakeWord native module contract (ios/WakeWordModule.swift + ios/WakeListener.swift).
// Types only: no runtime code, so both index.ts and the node tests can import it.

export type SpeechPermission = 'granted' | 'denied' | 'restricted' | 'undetermined';
export type MicPermission = 'granted' | 'denied' | 'undetermined';

/** requestPermissions(): speech recognition and microphone statuses after asking. */
export interface WakeWordPermissions {
  speech: SpeechPermission;
  mic: MicPermission;
}

export interface WakeWordStartOptions {
  /** BCP-47 locale for SFSpeechRecognizer. Default 'en-US'. */
  locale?: string;
  /** Phrases the recognizer should favour. Default ['Jarvis']; also the wake words native checks. */
  contextualStrings?: string[];
  /** Require on-device recognition when the locale supports it. Default true. */
  onDevice?: boolean;
}

export interface WakeWordStartResult {
  ok: boolean;
  /** True when recognition runs on device (requiresOnDeviceRecognition). */
  onDevice: boolean;
  /**
   * Why start failed: 'speech-permission' | 'mic-permission' | 'unsupported-locale' |
   * 'recognizer-unavailable' | 'no-audio-input' | 'audio-session: …' | 'audio-engine: …' |
   * 'unavailable' (no native module in this binary) | 'native-error: …'.
   */
  reason?: string;
}

export interface WakeWordTranscriptEvent {
  /** Cumulative best transcription of the CURRENT recognition task. */
  text: string;
  isFinal: boolean;
  /** Increments each time a new recognition task starts (monotonic per app launch). */
  segment: number;
}

export type WakeWordState = 'listening' | 'stopped' | 'restarting' | 'error' | 'interrupted';

export interface WakeWordStateEvent {
  state: WakeWordState;
  message?: string;
}

export type WakeWordEvents = {
  onTranscript: (event: WakeWordTranscriptEvent) => void;
  onState: (event: WakeWordStateEvent) => void;
};

export interface WakeWordSubscription {
  remove(): void;
}

/** The native module object (requireOptionalNativeModule('WakeWord')). */
export interface WakeWordModule {
  /** SFSpeechRecognizer exists for the locale (default 'en-US') and is available right now. */
  isAvailable(locale?: string): boolean;
  /** Prompts for whatever is still undetermined (speech first, then mic). Never rejects. */
  requestPermissions(): Promise<WakeWordPermissions>;
  /** Starts listening (restarts with the new options when already listening). Never rejects. */
  start(options?: WakeWordStartOptions): Promise<WakeWordStartResult>;
  /**
   * Resolves only after the recognition task is cancelled, the input tap removed, the audio engine
   * stopped and the audio session deactivated (notifyOthersOnDeactivation).
   */
  stop(): Promise<void>;
  addListener<E extends keyof WakeWordEvents>(
    eventName: E,
    listener: WakeWordEvents[E],
  ): WakeWordSubscription;
}
