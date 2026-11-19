// "Is this the iOS Simulator?", for the Simulator-only sample Dance Off round (../dance/model/
// simRound). The app has no expo-device (adding a native module means a native rebuild), and
// React Native exports no simulator flag, so this reads where iOS put the app's sandbox: on the
// Simulator the data container is a folder of the Mac user's CoreSimulator tree
// (/Users/<you>/Library/Developer/CoreSimulator/Devices/<UDID>/data/Containers/Data/Application/…);
// on an iPhone it is always /var/mobile/Containers/Data/Application/… (or /private/var/…), which
// the app cannot choose. So the sample round is impossible on a real phone, whatever its camera
// permission says (anti-cheat; the server re-scores every upload regardless).
//
// Pure: the caller hands in the documents directory URI (../dance/fs appDocumentsUri).

const SIMULATOR_CONTAINER =
  /^file:\/\/\/Users\/[^/]+\/Library\/Developer\/CoreSimulator\/Devices\/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\/data\/Containers\/Data\/Application\//i;

/** True only for an app container inside the iOS Simulator's CoreSimulator tree. */
export function isSimulatorContainer(documentsUri: string | null | undefined): boolean {
  if (typeof documentsUri !== 'string') return false;
  let uri = documentsUri;
  try {
    uri = decodeURI(documentsUri);
  } catch {
    return false;
  }
  return SIMULATOR_CONTAINER.test(uri);
}

/**
 * Does the dance screen offer "Simulator: play a sample round"? Only in the Simulator (by its
 * container) and only when the camera reports none: never on a real phone, camera or not.
 */
export function simulatorSampleOffered(o: {
  platform: string;
  documentsUri: string | null | undefined;
  camera: 'ok' | 'none' | 'error';
}): boolean {
  return o.platform === 'ios' && o.camera === 'none' && isSimulatorContainer(o.documentsUri);
}
