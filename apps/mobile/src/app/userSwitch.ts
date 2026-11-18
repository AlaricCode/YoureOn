// When the signed-in user changes (a demo claim from Profile, or sign-out), the old user's bet and
// room subs and followed bets must go: the server closes 4403 on a hello sub the new user may not
// see, and the socket would reconnect with the same subs forever. Pure TS: tested in node.
import type { Session } from '@youre-on/shared/api';

export function resetOnUserSwitch(
  sessions: { onChange(l: (s: Session | null) => void): () => void },
  targets: { ws: { reset(): void }; hub: { clear(): void } },
  initialUserId: string | null = null,
): () => void {
  let userId = initialUserId;
  return sessions.onChange((s) => {
    const next = s?.user.user_id ?? null;
    if (next === userId) return;
    if (userId !== null) {
      targets.ws.reset();
      targets.hub.clear();
    }
    userId = next;
  });
}
