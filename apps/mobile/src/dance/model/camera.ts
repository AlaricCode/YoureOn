// Which camera the Dance Off round uses. The selfie camera, so the phone can stand facing the
// dancers with its screen towards them: they see themselves, their skeletons and their scores.
// EXPO_PUBLIC_DANCE_CAMERA=back puts the back camera back (a rebuild of the bundle, no native
// change). Pure TS, tested in node.
//
// What does NOT change with the camera: the poses, the recording and the stills are the scene as
// the camera sees it, never mirrored, so the scoring and the "A = left in the image" rule
// (shared dance/track) are the same for both. What does: the selfie camera's PREVIEW is a mirror
// image, so a player on the image's left is on the SCREEN's right. Everything drawn over the
// preview is flipped to match (../Stage), and so is the framing guide.

export type DanceCamera = 'front' | 'back';

/** The camera for a flag value: anything but 'back' is the selfie camera. */
export const danceCameraFrom = (flag: string | undefined): DanceCamera =>
  flag?.trim().toLowerCase() === 'back' ? 'back' : 'front';

export const DANCE_CAMERA: DanceCamera = danceCameraFrom(process.env.EXPO_PUBLIC_DANCE_CAMERA);

/** Is the picture on screen a mirror image of what the camera sees? */
export const previewMirrored = (camera: DanceCamera): boolean => camera === 'front';

/**
 * The framing guide's two sides on screen: who stands on the screen's left and right. A is on
 * the IMAGE's left; on a mirrored preview that is the screen's right.
 */
export function guideSides(mirrored: boolean): { left: 'a' | 'b'; right: 'a' | 'b' } {
  return mirrored ? { left: 'b', right: 'a' } : { left: 'a', right: 'b' };
}
