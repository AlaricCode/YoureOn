// The live judge on A's phone (D6: only A hosts the ElevenLabs session). Renders nothing; it
// owns the session for the whole bet so the judge can hear [EVENT] lines through the lock and
// the attempt. Loaded lazily by DemoApp (importing the SDK registers WebRTC globals), inside an
// error boundary, so a voice failure never takes the app down; the screens still work from
// server pushes alone.
//
// A thin binding of ./session (the tested controller) to @elevenlabs/react-native 1.2.38:
//   useConversation({clientTools, callbacks})  ->  session.onStatus / onConnect / onDisconnect /
//                                                  onError / onMessage
//   mic:     expo-audio requestRecordingPermissionsAsync before the mint (the iOS prompt is
//            not on the connect clock); denied -> typed terms
//   token:   POST /v1/voice/tokens {purpose:'terms', bet_id} (server holds the API key)
//   tools:   ./judgeTools (request_attempt, show_terms_card, cue) passed to useConversation and
//            to startSession (API-CONTRACT §4.4: useConversationClientTool is not used)
//   cues:    judge.cue for this bet -> session.onCue (verbatim [EVENT] line, queued until live)
//   mute:    props.micMuted (DemoApp: micMutedFor(bet state)) -> session.setMuted
//   lines:   captions into the bet hub + batched POST /v1/bets/:id/voice/lines (the stage)
import { ConversationProvider, useConversation } from '@elevenlabs/react-native';
import { useEffect, useMemo, useRef } from 'react';

import type { VoiceDynamicVariables } from '@youre-on/shared/api';
import { cuesPath, voiceLinesPath } from '@youre-on/shared/judge/voice';

import type { Runtime } from '../app/runtime';
import { upsertLine } from '../bets/store';
import { judgeClientTools } from './judgeTools';
import { createRulingGate, type RulingGate } from './rulingGate';
import {
  createJudgeSession,
  type ConversationPort,
  type FailReason,
  type JudgeSession,
  type SessionPhase,
} from './session';

export interface JudgeVoiceProps {
  rt: Runtime;
  betId: string;
  dynamicVariables: VoiceDynamicVariables;
  /** Mute, don't end (FINDINGS §4): true from the terms card on, except in a hearing. */
  micMuted: boolean;
  /** Resolves with who films (../attempt/recorder): the judge cam, or this phone. */
  startAttempt(attemptNo: number): Promise<'judge_cam' | 'self' | void>;
  onShowTermsCard(): void;
  onPhase?(p: SessionPhase): void;
  /** The judge is talking (SDK mode 'speaking') vs listening. */
  onSpeaking?(speaking: boolean): void;
  /** The session could not start or broke (no key, token refused, SDK error): type it instead. */
  onFailed?(reason: FailReason): void;
  /** ../gg: the judge finished saying the latest ruling (./rulingGate); false when re-armed. */
  onRulingSpoken?(spoken: boolean): void;
}

export default function JudgeVoice(p: JudgeVoiceProps) {
  return (
    <ConversationProvider>
      <Session {...p} />
    </ConversationProvider>
  );
}

function Session(p: JudgeVoiceProps) {
  const { rt, betId } = p;
  const props = useRef(p);
  props.current = p;
  const port = useRef<ConversationPort | null>(null);
  // One controller per mounted bet (DemoApp keys this component by bet_id). No StrictMode in
  // this app, so the mount effect below runs once: the token is single-use.
  const session = useRef<JudgeSession | null>(null);
  session.current ??= createJudgeSession({
    betId,
    conv: () => {
      if (!port.current) throw new Error('No active conversation.');
      return port.current;
    },
    micPermission: async () => {
      const { requestRecordingPermissionsAsync } = await import('expo-audio');
      return (await requestRecordingPermissionsAsync()).granted;
    },
    mintToken: () => rt.api.voiceToken(betId),
    dynamicVariables: { ...props.current.dynamicVariables },
    postLines: async (lines) => {
      await rt.client.request('POST', voiceLinesPath(betId), { json: { lines } });
    },
    onCaption: (c) =>
      rt.hub.patch(betId, (b) => ({ ...b, lines: upsertLine(b.lines, c.id, c.who, c.text) })),
    onFailed: (r) => props.current.onFailed?.(r),
    onPhase: (ph) => props.current.onPhase?.(ph),
    log: (msg, extra) => console.warn(`[yo] ${msg}`, extra ?? ''),
    now: () => rt.clock.now(),
  });
  const s = session.current;
  // ../gg: when the ruling has been said (the RULED mic gate, micMutedFor in DemoApp).
  const gate = useRef<RulingGate | null>(null);
  gate.current ??= createRulingGate({ onChange: (v) => props.current.onRulingSpoken?.(v) });
  const g = gate.current;
  useEffect(() => () => g.stop(), [g]);

  const tools = useMemo(
    () =>
      judgeClientTools({
        startAttempt: (n) => props.current.startAttempt(n),
        showTermsCard: () => props.current.onShowTermsCard(),
        cue: async (kind) => {
          await rt.client.request('POST', cuesPath(betId), { json: { kind } });
        },
        canAttempt: () => s.canAttempt(),
      }),
    [rt, betId, s],
  );

  const conv = useConversation({
    clientTools: tools,
    onMessage: (m) => s.onMessage(m),
    onStatusChange: ({ status }) => s.onStatus(status),
    onConnect: (c) => s.onConnect(c),
    onDisconnect: (d) => s.onDisconnect(d),
    onError: (message) => s.onError(message),
    onModeChange: ({ mode }) => {
      props.current.onSpeaking?.(mode === 'speaking');
      g.onMode(mode);
    },
  });
  port.current = {
    startSession: (o) => conv.startSession({ ...o, clientTools: tools }),
    endSession: () => conv.endSession(),
    sendUserMessage: (t) => conv.sendUserMessage(t),
    sendContextualUpdate: (t) => conv.sendContextualUpdate(t),
    sendUserActivity: () => conv.sendUserActivity(),
    setMuted: (m) => conv.setMuted(m),
  };

  // Mint and start once per bet; end on unmount (a quiet stop: no typed fallback).
  useEffect(() => {
    s.start();
    return () => s.stop();
  }, [s]);

  useEffect(() => s.setMuted(p.micMuted), [s, p.micMuted]);

  // [EVENT] lines from the server, verbatim (§4.5). Never throws into the hub's listener loop.
  useEffect(
    () =>
      rt.hub.onChange((e) => {
        if (e && e.bet_id === betId && e.type === 'judge.cue') {
          s.onCue(e.payload);
          g.onCue(e.payload.cue);
        }
      }),
    [rt, betId, s, g],
  );

  return null;
}
