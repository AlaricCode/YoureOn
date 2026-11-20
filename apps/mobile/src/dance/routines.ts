// The routine cards for the negotiate screen's "Dance off" panel (DANCE-OFF §6.2). Native-free on
// purpose: the bet flow and the design preview import this without touching the pose module.
import { ROUTINES, routineDisplayTitle, routineSeconds } from '@youre-on/shared/dance/routine';

export interface DanceRoutineChoice {
  id: string;
  title: string;
  song: string;
  bpm: number;
  /** The round length in whole seconds (each routine has its own, 5..40). */
  seconds: number;
}

/** The bundled routines in card order (exactly 3). */
export const DANCE_ROUTINE_CHOICES: DanceRoutineChoice[] = ROUTINES.map((r) => ({
  id: r.id,
  title: routineDisplayTitle(r),
  song: r.song,
  bpm: r.bpm,
  seconds: routineSeconds(r),
}));
