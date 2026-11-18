// Every fixed string of the GG moment and the review sheet, with its copy role (ui/copyRule),
// checked by ./__tests__/copy.test.ts like screens/copy. Names and the record ("5–7") are data.
import type { CopyRole } from '../ui/copyRule';
import type { ConfirmFailure } from './model';

type Line = readonly [text: string, role: CopyRole];

export const GG_COPY = {
  // The loser's review sheet (opens when someone asks the judge to check the ruling again).
  review: ['Review', 'label'],
  checkAgain: ['Check it again', 'label'],
  keepRuling: ['Keep ruling', 'label'],
  confirmIn: ['Confirm in', 'label'],
  appealPrompt: ['Appeal the ruling', 'label'],
  // Everyone else's tag on the ruling screen.
  reviewAsked: ['Review requested', 'label'],
  stands: ['Ruling stands', 'label'],
  // The GG payout screens.
  saidGG: ['said GG', 'label'],
  goodGame: ['Good game', 'label'],
  record: ['Record', 'label'],
  firstMeeting: ['First meeting', 'label'],
  streak: ['Streak', 'label'],
  // Sheet errors (the window runs on; they can try again or keep the ruling).
  faceIdFailed: ['Face ID failed', 'error'],
  refused: ["Something's off. Not signing.", 'contract'],
  tooLate: ['Too late', 'error'],
  failed: ['Try again', 'error'],
} as const satisfies Record<string, Line>;

export const gt = (line: Line): string => line[0];

/** "Jake said GG": first name only, so a full name still reads as a 3-word label. */
export const saidGG = (name: string) =>
  `${name.trim().split(/\s+/)[0] || 'They'} ${gt(GG_COPY.saidGG)}`;

/** "×3" streak value (data). */
export const streakLabel = (n: number) => `×${n}`;

/** The sheet's red line per failure; a cancelled Face ID prompt shows none (they chose). */
export const FAILURE_COPY: Readonly<Record<ConfirmFailure, Line | null>> = {
  cancelled: null,
  faceid: GG_COPY.faceIdFailed,
  refused: GG_COPY.refused,
  too_late: GG_COPY.tooLate,
  failed: GG_COPY.failed,
};
