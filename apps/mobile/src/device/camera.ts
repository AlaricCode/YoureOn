// "This phone has no camera", for the expo-camera screens (judge cam, demo claim). With no
// capture device (the iOS Simulator) expo-camera still fires onCameraReady (it fires once the
// session starts, device or not) and never onMountError: the stage just stays empty and a
// recording fails with SimulatorNotSupported. Its lens list is the real signal: empty when the
// facing side has no camera. So after onCameraReady the screen asks for the lenses and says
// "No camera" instead of waiting silently.

export interface LensSource {
  getAvailableLensesAsync(): Promise<readonly unknown[]>;
}

/** False only when the camera answered and listed no lens; unknown counts as present. */
export async function hasCameraLens(view: LensSource | null | undefined): Promise<boolean> {
  if (!view) return true;
  try {
    return (await view.getAvailableLensesAsync()).length > 0;
  } catch {
    return true;
  }
}
