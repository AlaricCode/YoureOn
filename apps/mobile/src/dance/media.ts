// Reference media per routine (DANCE-OFF §2 `media`, §6.2 step 4). No routine ships a video, so
// the phone always draws the reference as a mirrored animated skeleton (ReferencePanel):
//   - bye-bye-shuffle: a real Vision take, with music only (an ORIGINAL synthesized drum track,
//     172.6 BPM, royalty-free by construction) played through expo-audio from t0;
//   - wave-pop, bounce-back: SYNTHETIC placeholders, silent.
// Never bundle the source dance footage: only the pose data and our own music ship.
//
// To add a real reference (after recording it and running tools/dance-ref + scripts/
// dance-routine.ts import, which bumps the routine's version and hash):
//   1. Put the clip (H.264 mp4 with the royalty-free music muxed in: one clock) at
//      apps/mobile/assets/dance/<routine-id>.mp4. Large files follow the .tflite pattern
//      (gitignored, fetched by the EAS hook).
//   2. Declare the asset type once in src/types/assets.d.ts:
//        declare module '*.mp4' { const assetId: number; export default assetId; }
//   3. Set the entry below: 'wave-pop': { video: require('../../assets/dance/wave-pop.mp4'), audio: null }
//   4. The routine's own `media.video` must be non-null too (it is part of the hashed routine).
// A video plays muted-off, mirrored (scaleX −1), starting in the same tick as startRound. Separate
// audio (no video) plays through expo-audio from t0; for music only, import the .m4a here and
// pass `--audio <file>` to the import so the routine's own media.audio is non-null.

import BYE_BYE_SHUFFLE_AUDIO from '../../assets/dance/bye-bye-shuffle.m4a';

export interface RoutineMedia {
  /** Metro asset id of the reference clip, or null. */
  video: number | null;
  /** Metro asset id of a music track (only when there is no video), or null. */
  audio: number | null;
}

const NONE: RoutineMedia = { video: null, audio: null };

const MEDIA: Readonly<Record<string, RoutineMedia>> = {
  'bye-bye-shuffle': { video: null, audio: BYE_BYE_SHUFFLE_AUDIO },
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
