// Reference media per routine (DANCE-OFF §2 `media`, §6.2 step 4):
//   - bye-bye-shuffle: a real Vision take. Its reference is a neon silhouette of the dancer on
//     the routine's dark background (the SAM 3.1 mask of the source take, never the footage
//     itself), 720x808 at 23.976 fps, 32.6 s, with an ORIGINAL synthesized drum track (172.6 BPM,
//     royalty-free by construction) muxed in: one clock for picture and music.
//     A local demo build may carry the original song instead: with DANCE_LOCAL_MEDIA=1 (opt-in,
//     never in CI / on EAS; scripts/eas-update.ts refuses it) metro.config.js bundles
//     assets/dance/local/bye-bye-shuffle.mp4 (gitignored, never committed) in place of the
//     committed drum version when that file exists. The routine's hash is the same either way.
//   - wave-pop, bounce-back: SYNTHETIC placeholders, silent: the phone draws the reference as a
//     mirrored animated skeleton (ReferencePanel).
// Never bundle the source dance footage or a copyrighted song in the repo.
//
// To add a real reference (after recording it and running tools/dance-ref + scripts/
// dance-routine.ts import --video <id>.mp4, which sets the hashed routine's media.video):
//   1. Put the clip (H.264 mp4 with the royalty-free music muxed in: one clock) at
//      apps/mobile/assets/dance/<routine-id>.mp4.
//   2. Set the entry below: 'wave-pop': { video: require('../../assets/dance/wave-pop.mp4'), audio: null }
// A video plays mirrored (scaleX −1) with its sound from t0 (ReferenceVideo). Separate audio (no
// video) plays through expo-audio from t0; for music only, import the .m4a here and pass
// `--audio <file>` to the import so the routine's own media.audio is non-null.

import BYE_BYE_SHUFFLE_VIDEO from '../../assets/dance/bye-bye-shuffle.mp4';

export interface RoutineMedia {
  /** Metro asset id of the reference clip (its music muxed in), or null. */
  video: number | null;
  /** Metro asset id of a music track (only when there is no video), or null. */
  audio: number | null;
}

const NONE: RoutineMedia = { video: null, audio: null };

const MEDIA: Readonly<Record<string, RoutineMedia>> = {
  'bye-bye-shuffle': { video: BYE_BYE_SHUFFLE_VIDEO, audio: null },
  'wave-pop': NONE,
  'bounce-back': NONE,
};

/** The bundled media for a routine: only used when the routine itself names media too. */
export function routineMedia(routine: {
  id: string;
  media: { video: string | null; audio: string | null };
}): RoutineMedia {
  const m = MEDIA[routine.id] ?? NONE;
  return {
    video: routine.media.video !== null ? m.video : null,
    audio: routine.media.audio !== null ? m.audio : null,
  };
}

/** The routine has music somewhere: muxed into its clip, or a separate track. */
export const routineHasMusic = (m: RoutineMedia): boolean => m.video !== null || m.audio !== null;
