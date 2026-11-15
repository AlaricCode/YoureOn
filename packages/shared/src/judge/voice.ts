// API-CONTRACT §2.6 `POST /v1/voice/tokens` request/response (voice stream; not in §2.18, so it
// lives next to the judge code rather than in api.ts).
import { z } from 'zod/v4';
import { BetId, IsoUtc, Uuid } from '../primitives';

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
  /** Token lifetime is undocumented (FINDINGS §7): null. Treat each token as single-use. */
  expires_at: IsoUtc.nullable(),
});
export type VoiceTokenResponse = z.infer<typeof VoiceTokenResponse>;

/** ElevenLabs `GET /v1/convai/conversation/token` 200 body (TokenResponseModel, live OpenAPI). */
export const ElTokenResponse = z.object({
  token: z.string().min(1),
  conversation_id: z.string().min(1),
});
export type ElTokenResponse = z.infer<typeof ElTokenResponse>;
