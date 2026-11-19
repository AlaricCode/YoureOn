// Lazy access to the native DancePose module and view. Nothing here touches native code at import
// time: a binary built before the module existed (or one where it failed to link) just reports
// "unavailable" instead of throwing.
import { requireNativeView, requireOptionalNativeModule } from 'expo';
import type { ReactElement, Ref } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import type { PoseFrameEvent, StartRoundOptions, StartRoundResult, StatusEvent } from './types';

/** The Expo module name (Name("DancePose") in ios/DancePoseModule.swift). */
export const DANCE_POSE_MODULE = 'DancePose';

/** The view functions Expo attaches to the native component's instance (the ref target). */
export interface NativeDancePoseInstance {
  startRound(opts: StartRoundOptions): Promise<StartRoundResult>;
  stopRound(): Promise<unknown>;
  /** Absent in a binary built before captureStill existed. */
  captureStill?(): Promise<unknown>;
}

export interface NativeDancePoseProps {
  ref?: Ref<NativeDancePoseInstance>;
  style?: StyleProp<ViewStyle>;
  active: boolean;
  maxFps: number;
  onPoses?(e: { nativeEvent: PoseFrameEvent }): void;
  onStatus?(e: { nativeEvent: StatusEvent }): void;
}

/**
 * The native component. At runtime it is Expo's class wrapper (its instance carries the view
 * functions); it is typed as a function component taking `ref` as a prop so the ref type is ours.
 */
export type NativeDancePoseComponent = (props: NativeDancePoseProps) => ReactElement | null;

let available: boolean | null = null;
let nativeView: NativeDancePoseComponent | null = null;

/** True when this binary has the DancePose native module (a device or simulator dev build). */
export function isDancePoseAvailable(): boolean {
  if (available === null) {
    try {
      available = requireOptionalNativeModule(DANCE_POSE_MODULE) != null;
    } catch {
      available = false;
    }
  }
  return available;
}

/** The native view component, created on first use; null when the module is missing. */
export function getNativeDancePoseView(): NativeDancePoseComponent | null {
  if (!isDancePoseAvailable()) return null;
  if (nativeView === null) {
    try {
      nativeView = requireNativeView<NativeDancePoseProps>(
        DANCE_POSE_MODULE,
      ) as unknown as NativeDancePoseComponent;
    } catch {
      available = false;
      return null;
    }
  }
  return nativeView;
}
