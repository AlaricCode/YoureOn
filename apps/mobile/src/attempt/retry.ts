// What the judge cam's "Try again" does after a failed recording or upload. Pure: tested in node.
//   resend   a server-armed attempt whose clip was recorded: send that same clip again (the
//            upload is cached by its Idempotency-Key, so the server sees the same bytes)
//   retake   a server-armed attempt with no clip (recordAsync failed): record again now
//   standby  the preview (manual start), or the server moved on (no arm): back to standby
export type CamRetry = 'resend' | 'retake' | 'standby';

export function camRetryAction(a: { armed: boolean; hasClip: boolean }): CamRetry {
  if (!a.armed) return 'standby';
  return a.hasClip ? 'resend' : 'retake';
}
