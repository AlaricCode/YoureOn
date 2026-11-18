// Is there a VisionCamera device to show? VisionCamera 5's <Camera> subscribes to the physical
// device orientation (the accelerometer) as soon as it mounts and throws when there is none,
// which on the iOS Simulator took down the whole screen ("OrientationManager.
// startOrientationUpdates(...): ... accelerometer is not available!"). The simulator has no
// camera either, so the VisionCamera screens (face scan, face enrollment, the diagnostics panel)
// mount <Camera> only once a device is known to exist, and say "No camera" otherwise.
import { useEffect, useState } from 'react';

export type CameraPresence = 'checking' | 'present' | 'none';

export interface DeviceFactoryLike {
  getDefaultCamera(position: 'front' | 'back'): unknown;
}

/** 'present' when the factory has a default camera on that side; a failed factory is 'none'. */
export async function cameraPresence(
  factory: Promise<DeviceFactoryLike>,
  position: 'front' | 'back',
): Promise<Exclude<CameraPresence, 'checking'>> {
  try {
    return (await factory).getDefaultCamera(position) ? 'present' : 'none';
  } catch {
    return 'none';
  }
}

/** The hook over VisionCamera's own device factory (loaded on first use). */
export function useVisionCameraPresence(position: 'front' | 'back'): CameraPresence {
  const [presence, setPresence] = useState<CameraPresence>('checking');
  useEffect(() => {
    let live = true;
    void import('react-native-vision-camera')
      .then(({ VisionCamera }) => cameraPresence(VisionCamera.createDeviceFactory(), position))
      .catch(() => 'none' as const)
      .then((p) => {
        if (live) setPresence(p);
      });
    return () => {
      live = false;
    };
  }, [position]);
  return presence;
}
