// The live judge on A's phone (D6: only A hosts the ElevenLabs session). Renders nothing; it
// owns the session for the whole bet so the judge can hear [EVENT] lines through the lock and
// the attempt. Loaded lazily by DemoApp (importing the SDK registers WebRTC globals), inside an
// error boundary, so a voice failure never takes the app down; the screens still work from
// server pushes alone.
//
//   token:   POST /v1/voice/tokens {purpose:'terms', bet_id} (server holds the API key)
//   start:   startSession({conversationToken, dynamicVariables, clientTools})
//   tools:   ./judgeTools (request_attempt, show_terms_card, cue)
//   cues:    judge.cue for this bet -> sendUserMessage / sendContextualUpdate (verbatim)
//   lines:   onMessage -> local captions + batched POST /v1/bets/:id/voice/lines (stage)
import { ConversationProvider, useConversation } from '@elevenlabs/react-native';
import { useEffect, useMemo, useRef } from 'react';

import type { VoiceDynamicVariables } from '@youre-on/shared/api';

import type { Runtime } from '../app/runtime';
import {
  ATTEMPT_CUES,
  createLineBatcher,
  cueAction,
  judgeClientTools,
  type VoiceLine,
} from './judgeTools';

export interface JudgeVoiceProps {
  rt: Runtime;
  betId: string;
  dynamicVariables: VoiceDynamicVariables;
  startAttempt(attemptNo: number): Promise<void>;
  onShowTermsCard(): void;
  onStatus?(s: string): void;
}

export default function JudgeVoice(p: JudgeVoiceProps) {
  return (
    <ConversationProvider>
      <Session {...p} />
    </ConversationProvider>
  );
}

function Session({
  rt,
  betId,
  dynamicVariables,
  startAttempt,
  onShowTermsCard,
  onStatus,
}: JudgeVoiceProps) {
  const canAttempt = useRef(false);
  const seq = useRef(0);
  const batcher = useMemo(
    () =>
      createLineBatcher(async (lines: VoiceLine[]) => {
        await rt.client.request('POST', `/v1/bets/${encodeURIComponent(betId)}/voice/lines`, {
          json: { lines },
        });
      }),
    [rt, betId],
  );
  const tools = useMemo(
    () =>
      judgeClientTools({
        startAttempt,
        showTermsCard: onShowTermsCard,
        cue: async (kind) => {
          await rt.client.request('POST', `/v1/bets/${encodeURIComponent(betId)}/cues`, {
            json: { kind },
          });
        },
        canAttempt: () => canAttempt.current,
      }),
    [rt, betId, startAttempt, onShowTermsCard],
  );

  const conv = useConversation({
    clientTools: tools,
    onMessage: (m) => {
      const who: 'judge' | 'a' = m.role === 'agent' ? 'judge' : 'a';
      const id = `${betId.slice(0, 8)}-${m.event_id}-${seq.current++}`;
      rt.hub.patch(betId, (b) => ({
        ...b,
        lines: [...b.lines, { id, who, text: m.message }].slice(-40),
      }));
      batcher.add({
        utterance_id: uuidish(betId, m.event_id),
        role: m.role === 'agent' ? 'judge' : 'party',
        ...(m.role === 'agent' ? {} : { party: 'A' as const }),
        text: m.message.slice(0, 600),
        final: true,
        at: new Date(rt.clock.now()).toISOString(),
      });
    },
    onStatusChange: (s) => onStatus?.(String((s as { status?: unknown }).status ?? s)),
    onError: (e) => console.warn('[yo] voice error', e),
  });
  const convRef = useRef(conv);
  convRef.current = conv;

  // Mint and start once per bet; end on unmount.
  useEffect(() => {
    let live = true;
    rt.api.voiceToken(betId).then(
      (tok) => {
        if (!live) return;
        convRef.current.startSession({
          conversationToken: tok.conversation_token,
          dynamicVariables: dynamicVariables as unknown as Record<string, string>,
          clientTools: tools,
        });
      },
      (e: unknown) => console.warn('[yo] voice token failed', e),
    );
    return () => {
      live = false;
      batcher.flush();
      try {
        convRef.current.endSession();
      } catch {
        // already closed
      }
    };
    // Once per bet: the token is single-use.
  }, [betId]);

  // [EVENT] lines from the server, verbatim (§4.5).
  useEffect(
    () =>
      rt.hub.onChange((e) => {
        if (!e || e.bet_id !== betId || e.type !== 'judge.cue') return;
        if (ATTEMPT_CUES.has(e.payload.cue)) canAttempt.current = true;
        if (e.payload.cue === 'ATTEMPT_ARMED') canAttempt.current = false;
        const a = cueAction(e.payload);
        if (a.send === 'user') convRef.current.sendUserMessage(a.text);
        else convRef.current.sendContextualUpdate(a.text);
      }),
    [rt, betId],
  );

  return null;
}

/** A UUIDv4-shaped id from the bet and the SDK event id (voice/lines idempotency: utterance_id + final). */
function uuidish(betId: string, eventId: number): string {
  const h = (eventId >>> 0).toString(16).padStart(12, '0').slice(-12);
  return `${betId.slice(0, 8)}-${betId.slice(9, 13)}-4${betId.slice(15, 18)}-8${betId.slice(20, 23)}-${h}`;
}
