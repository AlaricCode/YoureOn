// Native bodies for the 'auto' and 'confirm' diagnostics checks. Each one imports its native
// module with a dynamic import(), so a module missing from the build fails only its own row
// instead of crashing the whole screen at startup. App code only (never imported by tests).
import type { CheckId } from './catalog';
import type { CheckBody } from './runner';

const fmt = (ms: number) => `${ms.toFixed(1)} ms`;

/** Throwaway Keychain item. Must never collide with the wallet's or D0-M4's item names. */
export const DIAGNOSTICS_SECURE_STORE_KEY = 'youreon.diagnostics.probe.v1';

const tfliteWarmup: CheckBody = async () => {
  const { loadFaceModel, warmUpFaceModel } = await import('../face/loadModel');
  const { model, loadMs } = await loadFaceModel();
  const warm = await warmUpFaceModel(model);
  // A second run shows the warm cost (what a real embed pays).
  const second = await warmUpFaceModel(model);
  return `load ${fmt(loadMs)}; warm-up ${fmt(warm.ms)}; 2nd run ${fmt(second.ms)}; 512-d finite`;
};

const localAuthHardware: CheckBody = async () => {
  const LA = await import('expo-local-authentication');
  const hasHardware = await LA.hasHardwareAsync();
  const enrolled = await LA.isEnrolledAsync();
  const types = await LA.supportedAuthenticationTypesAsync();
  const names = types.map((t) => LA.AuthenticationType[t] ?? String(t)).join(',') || 'none';
  const detail = `hasHardware=${hasHardware} enrolled=${enrolled} types=${names}`;
  if (!hasHardware) throw new Error(detail);
  return detail;
};

const secureStoreRw: CheckBody = async () => {
  const SecureStore = await import('expo-secure-store');
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  const value = `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  await SecureStore.setItemAsync(DIAGNOSTICS_SECURE_STORE_KEY, value, options);
  const read = await SecureStore.getItemAsync(DIAGNOSTICS_SECURE_STORE_KEY, options);
  await SecureStore.deleteItemAsync(DIAGNOSTICS_SECURE_STORE_KEY, options);
  const after = await SecureStore.getItemAsync(DIAGNOSTICS_SECURE_STORE_KEY, options);
  if (read !== value) throw new Error(`read back ${JSON.stringify(read)}, wrote ${value}`);
  if (after !== null) throw new Error('item still present after delete');
  return 'write, read-back and delete OK';
};

const haptics: CheckBody = async () => {
  const Haptics = await import('expo-haptics');
  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
  await new Promise((r) => setTimeout(r, 250));
  await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  return { confirm: 'impact(heavy) + notification(success) sent; did you feel them?' };
};

const micLivekit: CheckBody = async () => {
  const { requestRecordingPermissionsAsync } = await import('expo-audio');
  const perm = await requestRecordingPermissionsAsync();
  const lk = await import('@livekit/react-native');
  if (typeof lk.registerGlobals !== 'function') throw new Error('registerGlobals missing');
  if (typeof lk.AudioSession?.configureAudio !== 'function')
    throw new Error('AudioSession.configureAudio missing');
  // Importing the ElevenLabs RN entry calls LiveKit's registerGlobals(), which installs the WebRTC
  // globals livekit-client needs. That fails here if @livekit/react-native-webrtc is not linked.
  const el = await import('@elevenlabs/react-native');
  if (typeof el.ConversationProvider !== 'function')
    throw new Error('ElevenLabs ConversationProvider missing');
  const hasPeerConnection =
    typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection === 'function';
  if (!hasPeerConnection) throw new Error('RTCPeerConnection global missing after import');
  const detail = `mic=${perm.status}; LiveKit + ElevenLabs imported; RTCPeerConnection global OK`;
  if (!perm.granted) throw new Error(detail);
  return detail;
};

const reanimatedWorklets: CheckBody = async () => {
  const Reanimated = await import('react-native-reanimated');
  const { runOnUIAsync } = await import('react-native-worklets');
  const sv = Reanimated.makeMutable(0);
  const result = await runOnUIAsync((a: number) => {
    'worklet';
    sv.value = a * 2;
    return sv.value + 1;
  }, 20);
  if (result !== 41) throw new Error(`worklet returned ${String(result)}, expected 41`);
  return 'runOnUIAsync worklet returned 41';
};

const gestureHandler: CheckBody = async () => {
  const GH = await import('react-native-gesture-handler');
  if (!GH.GestureHandlerRootView) throw new Error('GestureHandlerRootView missing');
  return 'react-native-gesture-handler imported';
};

const notifications: CheckBody = async () => {
  const N = await import('expo-notifications');
  const p = await N.getPermissionsAsync();
  return `permission=${p.status} (local notifications are the P0 path, FINDINGS §3.14)`;
};

// Read-only on purpose: diagnostics must never mint a wallet. A key created here would survive a
// reinstall (Keychain) and make a later custodial importSeed({replaceExisting:false}) fail with
// WALLET_EXISTS. So it reads the pubkey item, probes the CSPRNG without storing anything, and
// pre-warms noble.
const wallet: CheckBody = async () => {
  const { createWallet, prewarmSigner } = await import('../wallet');
  const { expoWalletPlatform } = await import('../wallet/expoPlatform');
  const w = createWallet(expoWalletPlatform);
  const t0 = performance.now();
  const publicKey = await w.getPublicKey();
  const probe = new Uint8Array(32);
  expoWalletPlatform.getRandomValues(probe);
  const randomOk = probe.some((b) => b !== 0);
  probe.fill(0);
  if (!randomOk) throw new Error('getRandomValues returned 32 zero bytes');
  const t1 = performance.now();
  prewarmSigner();
  const t2 = performance.now();
  const key =
    publicKey === null ? 'no wallet yet' : `wallet ${publicKey.slice(0, 4)}…${publicKey.slice(-4)}`;
  return `${key}; getRandomValues OK in ${fmt(t1 - t0)}; prewarm ${fmt(t2 - t1)}`;
};

const jcsVectors: CheckBody = async () => {
  const { jcsVectorsCheck } = await import('./jcsVectors');
  return jcsVectorsCheck();
};

export const AUTO_CHECKS: Partial<Record<CheckId, CheckBody>> = {
  'tflite-warmup': tfliteWarmup,
  'local-auth-hardware': localAuthHardware,
  'secure-store-rw': secureStoreRw,
  haptics,
  'mic-livekit': micLivekit,
  'reanimated-worklets': reanimatedWorklets,
  'gesture-handler': gestureHandler,
  notifications,
  wallet,
  'jcs-vectors': jcsVectors,
};
