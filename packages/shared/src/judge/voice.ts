// API-CONTRACT §2.6 `POST /v1/voice/tokens` request/response (voice stream; not in §2.18, so it
// lives next to the judge code rather than in api.ts).
import { z } from 'zod/v4';
import { StageCueKind } from '../api';
import { BetId, IsoUtc, Party, Uuid } from '../primitives';

export const VOICE_TOKENS_PATH = '/v1/voice/tokens';

export const VoiceTokenRequest = z.object({
  purpose: z.literal('terms'),
  /** Given once the bet exists; omitted when pre-minting on the scan screen. */
  bet_id: BetId.optional(),
});
export type VoiceTokenRequest = z.infer<typeof VoiceTokenRequest>;

export const VoiceTokenResponse = z.object({
  conversation_token: z.string().min(1),
  conversation_id: z.string().min(1),
  agent_id: z.string().min(1),
  voice_session_id: Uuid,
  /** Token lifetime is undocumented: null. Treat each token as single-use. */
  expires_at: IsoUtc.nullable(),
});
export type VoiceTokenResponse = z.infer<typeof VoiceTokenResponse>;

/** ElevenLabs `GET /v1/convai/conversation/token` 200 body (TokenResponseModel, live OpenAPI). */
export const ElTokenResponse = z.object({
  token: z.string().min(1),
  conversation_id: z.string().min(1),
});
export type ElTokenResponse = z.infer<typeof ElTokenResponse>;

// ---- §2.6 relays from A's phone (the voice host, D6) ---------------------------------------

/** SCHEMAS §10.1 judge.line text cap (party.line allows 600). */
export const JUDGE_LINE_MAX = 400;
export const PARTY_LINE_MAX = 600;
/** One POST carries at most this many lines (the phone flushes every ≤ 250 ms). */
export const VOICE_LINES_MAX_BATCH = 50;

export const voiceLinesPath = (betId: string) =>
  `/v1/bets/${encodeURIComponent(betId)}/voice/lines`;
export const cuesPath = (betId: string) => `/v1/bets/${encodeURIComponent(betId)}/cues`;

/** One transcript line (SDK agent_response -> 'judge', user_transcript -> 'party'). */
export const VoiceLine = z
  .object({
    utterance_id: Uuid,
    role: z.enum(['judge', 'party']),
    /** Required for role 'party', absent for 'judge'. */
    party: Party.optional(),
    text: z.string().min(1).max(PARTY_LINE_MAX),
    final: z.boolean(),
    at: IsoUtc,
  })
  .refine((l) => (l.role === 'party') === (l.party !== undefined), {
    message: "party is required for role 'party' and not allowed for 'judge'",
    path: ['party'],
  });
export type VoiceLine = z.infer<typeof VoiceLine>;

/** `POST /v1/bets/:bet_id/voice/lines` (S, A). */
export const VoiceLinesRequest = z.object({
  lines: z.array(VoiceLine).min(1).max(VOICE_LINES_MAX_BATCH),
});
export type VoiceLinesRequest = z.infer<typeof VoiceLinesRequest>;

/** 202: `accepted` became judge.line / party.line events; the rest were repeats or dropped. */
export const VoiceLinesResponse = z.object({
  accepted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
});
export type VoiceLinesResponse = z.infer<typeof VoiceLinesResponse>;

/** `POST /v1/bets/:bet_id/cues` (S, A): the `cue` client tool; the stage plays the clip. */
export const StageCueRequest = z.object({ kind: StageCueKind });
export type StageCueRequest = z.infer<typeof StageCueRequest>;
/** 202: `relayed` is false when the bet has no room (nothing to play it). */
export const StageCueResponse = z.object({ relayed: z.boolean() });
export type StageCueResponse = z.infer<typeof StageCueResponse>;
