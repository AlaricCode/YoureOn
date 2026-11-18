// Stick figures over a panel (the camera preview or the black reference panel): bones as round-
// capped lines, a head disc, and dots on the hands and feet. Coordinates come through the same
// contain-fit math as the native preview (model/overlay), so the lines sit on the people.
import { memo } from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Circle, G, Line } from 'react-native-svg';

import { containRect, headCircle, jointPoints, skeletonSegments, type Size } from './model/overlay';

/** Wrists and ankles get a dot (the ends people watch). */
const END_JOINTS = [10, 11, 17, 18] as const;

export interface SkeletonFigure {
  k: readonly number[];
  tint: string;
  /** Bone width in points. */
  width?: number;
  /** Draw flipped (the mirrored reference). */
  mirrored?: boolean;
  opacity?: number;
}

export const SkeletonLayer = memo(function SkeletonLayer({
  size,
  image,
  figures,
}: {
  /** The panel's size in points. */
  size: Size;
  /** The keypoints' image size (720×1280 upright). */
  image: Size;
  figures: readonly SkeletonFigure[];
}) {
  if (size.width <= 0 || size.height <= 0) return null;
  const rect = containRect(size, image);
  return (
    <Svg
      width={size.width}
      height={size.height}
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    >
      {figures.map((f, i) => {
        const opts = { mirrored: f.mirrored ?? false };
        const bones = skeletonSegments(f.k, rect, opts);
        const head = headCircle(f.k, rect, opts);
        const ends = jointPoints(f.k, rect, END_JOINTS, opts);
        const w = f.width ?? Math.max(3, rect.height * 0.012);
        return (
          <G key={i} opacity={f.opacity ?? 1}>
            {bones.map((s, j) => (
              <Line
                key={j}
                x1={s.x1}
                y1={s.y1}
                x2={s.x2}
                y2={s.y2}
                stroke={f.tint}
                strokeWidth={w}
                strokeLinecap="round"
              />
            ))}
            {head ? (
              <Circle
                cx={head.x}
                cy={head.y}
                r={head.r}
                stroke={f.tint}
                strokeWidth={w}
                fill="none"
              />
            ) : null}
            {ends.map((p, j) => (
              <Circle key={`e${j}`} cx={p.x} cy={p.y} r={w * 0.9} fill={f.tint} />
            ))}
          </G>
        );
      })}
    </Svg>
  );
});
