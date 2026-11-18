// Request/response shapes for the judge routes (API-CONTRACT §2.9, §2.15). packages/shared/api.ts
// has no types for these yet; they live here until the mobile slice needs them, then move there.
import { z } from 'zod/v4';
import { Hex32, IsoUtc, Party, Uuid } from '@youre-on/shared/primitives';

/** PATCH /v1/devices/current (§2.15). The judge-cam role is bound to a room. */
export const DevicePatchRequest = z.object({
  role: z.enum(['phone', 'judge_cam']).optional(),
  room_id: Uuid.nullish(),
});
export type DevicePatchRequest = z.infer<typeof DevicePatchRequest>;

/** POST /v1/bets/:bet_id/attempts (§2.9). */
export const StartAttemptRequest = z.object({
  attempt_no: z.number().int().min(1).max(32767),
  recorder: z.enum(['judge_cam', 'self']).default('judge_cam'),
});
export type StartAttemptRequest = z.infer<typeof StartAttemptRequest>;

export const StartAttemptResponse = z.object({
  attempt_no: z.number().int().min(1),
  performer: Party,
  recorder_device_id: Uuid,
  max_ms: z.number().int().positive(),
  go_at: IsoUtc,
});
export type StartAttemptResponse = z.infer<typeof StartAttemptResponse>;

/** POST …/attempts/:n/frames → 202. clip_upload is null until object storage (S3) is wired. */
export const FramesAcceptedResponse = z.object({
  judging: z.literal(true),
  frame_hashes: z.array(Hex32),
  clip_upload: z.null(),
});
export type FramesAcceptedResponse = z.infer<typeof FramesAcceptedResponse>;
