// When the judge has finished saying the ruling (../gg): the voice host's mic opens in RULED only
// after that (session.ts micMutedFor), so the room's cheering can't cut the ruling off and the
// judge can hear "check that again" right after it. Pure, with injected timers (tested in node).
//
//   [EVENT] RULING cue   arm: wait for the judge's next speaking -> listening turn
//   onMode('speaking')   the ruling line started
//   onMode('listening')  after a speaking turn: spoken -> onChange(true)
//   fallback             RULING_SPOKEN_FALLBACK_MS after the cue, spoken anyway (a lost mode
//                        event must not keep the room unheard for the whole window)
// A later RULING cue (after a REDO) arms it again from scratch.
import type { JudgeCueName } from '@youre-on/shared/api';

export const RULING_SPOKEN_FALLBACK_MS = 5_000;

interface GateTimers {
  setTimeout(f: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}
const realTimers: GateTimers = {
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createRulingGate(o: {
  onChange(spoken: boolean): void;
  timers?: GateTimers;
  fallbackMs?: number;
}) {
  const timers = o.timers ?? realTimers;
  let armed = false;
  let sawSpeaking = false;
  let spoken = false;
  let timer: unknown = null;

  const clear = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  const fire = () => {
    clear();
    armed = false;
    if (!spoken) {
      spoken = true;
      o.onChange(true);
    }
  };

  return {
    spoken: () => spoken,
    onCue(cue: JudgeCueName) {
      if (cue !== 'RULING') return;
      clear();
      armed = true;
      sawSpeaking = false;
      if (spoken) {
        spoken = false;
        o.onChange(false);
      }
      timer = timers.setTimeout(fire, o.fallbackMs ?? RULING_SPOKEN_FALLBACK_MS);
    },
    onMode(mode: string) {
      if (!armed) return;
      if (mode === 'speaking') sawSpeaking = true;
      else if (mode === 'listening' && sawSpeaking) fire();
    },
    stop() {
      clear();
      armed = false;
    },
  };
}
export type RulingGate = ReturnType<typeof createRulingGate>;
