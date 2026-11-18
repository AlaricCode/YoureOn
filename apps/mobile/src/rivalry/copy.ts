// Every fixed string the live rivalry overlay shows, with its copy role, checked against
// ui/copyRule in rivalry/__tests__/copy.test.ts. Lines the scan screen already has are reused
// from screens/copy.ts (read only) so the two never drift apart.
import { COPY } from '../screens/copy';
import type { CopyRole } from '../ui/copyRule';

type Line = readonly [text: string, role: CopyRole];

export const RIVALRY_COPY = {
  point: COPY.scan.point,
  checking: COPY.scan.checking,
  closer: COPY.scan.closer,
  challenge: COPY.home.challenge,
  joinRoom: COPY.scan.joinRoom,
  unavailable: COPY.scan.unavailable,
  rivals: ['Rivals', 'label'],
  firstBet: ['First bet', 'label'],
  /** Templates: `{n}` is the streak length (2 or more). Filled by `rivalryFill`. */
  wonStreak: ['Won {n} straight', 'label'],
  lostStreak: ['Lost {n} straight', 'label'],
} as const satisfies Record<string, Line>;

export const rt = (line: Line): string => line[0];

export const rivalryFill = {
  streak: (holder: 'me' | 'them', n: number): string =>
    rt(holder === 'me' ? RIVALRY_COPY.wonStreak : RIVALRY_COPY.lostStreak).replace(
      '{n}',
      String(n),
    ),
} as const;
