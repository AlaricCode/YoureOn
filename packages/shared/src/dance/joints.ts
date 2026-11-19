// DANCE-OFF §2: the fixed Apple Vision body joint order, the 9 scored limbs and the L/R swap maps.
// A person is `k: number[57]` = [x, y, c] × 19 in this order (x, y in the upright, unmirrored
// image, top-left origin, y down; c = confidence, 0 = missing).

/** VNHumanBodyPoseObservation.JointName, in the order every keypoint array uses (indices 0..18). */
export const JOINT_NAMES = [
  'nose',
  'leftEye',
  'rightEye',
  'leftEar',
  'rightEar',
  'neck',
  'leftShoulder',
  'rightShoulder',
  'leftElbow',
  'rightElbow',
  'leftWrist',
  'rightWrist',
  'root',
  'leftHip',
  'rightHip',
  'leftKnee',
  'rightKnee',
  'leftAnkle',
  'rightAnkle',
] as const;
export type JointName = (typeof JOINT_NAMES)[number];

export const JOINT_COUNT = 19;
/** [x, y, c] × JOINT_COUNT. */
export const KEYPOINT_LEN = 57;

/** Joint name → index into a keypoint array (multiply by 3 for the x slot). */
export const JOINT = {
  nose: 0,
  leftEye: 1,
  rightEye: 2,
  leftEar: 3,
  rightEar: 4,
  neck: 5,
  leftShoulder: 6,
  rightShoulder: 7,
  leftElbow: 8,
  rightElbow: 9,
  leftWrist: 10,
  rightWrist: 11,
  root: 12,
  leftHip: 13,
  rightHip: 14,
  leftKnee: 15,
  rightKnee: 16,
  leftAnkle: 17,
  rightAnkle: 18,
} as const satisfies Record<JointName, number>;

/** Joint index → the index of its left/right counterpart (centre joints map to themselves). */
export const JOINT_SWAP: readonly number[] = [
  0, 2, 1, 4, 3, 5, 7, 6, 9, 8, 11, 10, 12, 14, 13, 16, 15, 18, 17,
];

/**
 * Virtual points the scorer derives per person: the hip centre (mid hips, else root) and the
 * neck (neck, else mid shoulders). They follow the 19 real joints.
 */
export const MID_HIP_POINT = 19;
export const NECK_POINT = 20;
export const POINT_COUNT = 21;

export const LIMB_IDS = [
  'l_upper_arm',
  'r_upper_arm',
  'l_forearm',
  'r_forearm',
  'l_thigh',
  'r_thigh',
  'l_shin',
  'r_shin',
  'torso',
] as const;
export type LimbId = (typeof LIMB_IDS)[number];
export const LIMB_COUNT = 9;

export type LimbGroup = 'arm' | 'leg' | 'torso';

export interface Limb {
  id: LimbId;
  /** Point index (0..18 a joint, MID_HIP_POINT / NECK_POINT a virtual point). */
  from: number;
  to: number;
  group: LimbGroup;
}

/** The 9 scored limbs, in LIMB_IDS order (DANCE-OFF §4.3). */
export const LIMBS: readonly Limb[] = [
  { id: 'l_upper_arm', from: JOINT.leftShoulder, to: JOINT.leftElbow, group: 'arm' },
  { id: 'r_upper_arm', from: JOINT.rightShoulder, to: JOINT.rightElbow, group: 'arm' },
  { id: 'l_forearm', from: JOINT.leftElbow, to: JOINT.leftWrist, group: 'arm' },
  { id: 'r_forearm', from: JOINT.rightElbow, to: JOINT.rightWrist, group: 'arm' },
  { id: 'l_thigh', from: JOINT.leftHip, to: JOINT.leftKnee, group: 'leg' },
  { id: 'r_thigh', from: JOINT.rightHip, to: JOINT.rightKnee, group: 'leg' },
  { id: 'l_shin', from: JOINT.leftKnee, to: JOINT.leftAnkle, group: 'leg' },
  { id: 'r_shin', from: JOINT.rightKnee, to: JOINT.rightAnkle, group: 'leg' },
  { id: 'torso', from: MID_HIP_POINT, to: NECK_POINT, group: 'torso' },
];

/** Limb index → its left/right counterpart (the torso maps to itself). */
export const LIMB_SWAP: readonly number[] = [1, 0, 3, 2, 5, 4, 7, 6, 8];

/** Skeleton edges for drawing (joint index pairs); not used for scoring. */
export const SKELETON_EDGES: readonly (readonly [number, number])[] = [
  [JOINT.nose, JOINT.neck],
  [JOINT.leftEye, JOINT.nose],
  [JOINT.rightEye, JOINT.nose],
  [JOINT.leftEar, JOINT.leftEye],
  [JOINT.rightEar, JOINT.rightEye],
  [JOINT.neck, JOINT.leftShoulder],
  [JOINT.neck, JOINT.rightShoulder],
  [JOINT.leftShoulder, JOINT.leftElbow],
  [JOINT.leftElbow, JOINT.leftWrist],
  [JOINT.rightShoulder, JOINT.rightElbow],
  [JOINT.rightElbow, JOINT.rightWrist],
  [JOINT.neck, JOINT.root],
  [JOINT.root, JOINT.leftHip],
  [JOINT.root, JOINT.rightHip],
  [JOINT.leftHip, JOINT.leftKnee],
  [JOINT.leftKnee, JOINT.leftAnkle],
  [JOINT.rightHip, JOINT.rightKnee],
  [JOINT.rightKnee, JOINT.rightAnkle],
];

/**
 * A keypoint array flipped horizontally (x → 1 − x) with left/right labels swapped: what the same
 * person looks like in a mirrored feed. Values stay in [0, 1]; a missing joint stays missing.
 */
export function mirrorKeypoints(k: readonly number[]): number[] {
  const out = new Array<number>(KEYPOINT_LEN).fill(0);
  for (let j = 0; j < JOINT_COUNT; j++) {
    const s = JOINT_SWAP[j]!;
    const x = k[s * 3] ?? 0;
    const c = k[s * 3 + 2] ?? 0;
    out[j * 3] = c > 0 ? 1 - x : x;
    out[j * 3 + 1] = k[s * 3 + 1] ?? 0;
    out[j * 3 + 2] = c;
  }
  return out;
}
