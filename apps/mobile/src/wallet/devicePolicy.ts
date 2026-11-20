// Phone-side wiring of the device signing policy (packages/shared/src/device-policy.ts; ESCROW
// §5.0.2, API-CONTRACT §6.3). The shared module is pure and takes its PDA / ATA derivations by
// injection; this file supplies them from noble (./pda), because Kit's getProgramDerivedAddress
// throws on Hermes. The wallet runs the policy with its OWN stored public key and
// clock, so a screen can never make it check one key and sign with another.
//
// Screens call runDevicePolicy at card mount to enable the hold button (and report a rejection's
// {bet_id, kind, rule} to POST /v1/bets/:bet_id/policy-rejections); wallet.authorizeTransaction
// runs it again on the exact bytes right before Face ID.
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  checkDevicePolicy,
  DEVICE_POLICY_PINS,
  type DevicePolicyDerivations,
  type DevicePolicyInput,
  type DevicePolicyPins,
  type DevicePolicyVerdict,
} from '@youre-on/shared/device-policy';

import { addressToBytes } from './bytes';
import { createPdaHelper, deriveEventAuthorityPda, findProgramAddress } from './pda';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * What a screen supplies: its own UI state (screen, lock mode, rendered card, verified ruling)
 * and the server request. The wallet adds the device key, the device clock, the derivations and
 * the G1 pins. `pins` is the policy's root of trust (fee payer, program, mint, token program,
 * cluster), so a screen can never supply it: always DEVICE_POLICY_PINS, see runDevicePolicy.
 */
export type DevicePolicyRequest = DistributiveOmit<
  DevicePolicyInput,
  'devicePubkey' | 'nowSecs' | 'derive' | 'pins'
>;

/** True in a release build (Metro defines the global `__DEV__ = false`). */
const isReleaseBuild = () => (globalThis as { __DEV__?: unknown }).__DEV__ === false;

const ATA_CACHE_LIMIT = 16;

/** Noble-backed derivations for the pinned program / token program, cached per bet and owner. */
export function createNobleDerivations(
  pins: DevicePolicyPins = DEVICE_POLICY_PINS,
): DevicePolicyDerivations {
  const helper = createPdaHelper(pins.programId);
  let eventAuthority: string | undefined;
  const atas = new Map<string, string>();
  const tokenProgram = addressToBytes(pins.tokenProgram);
  return {
    betPdas(betId) {
      const p = helper.forBet(betId);
      return { bet: p.bet.address, vault: p.vault.address, config: p.config.address };
    },
    eventAuthority: () => (eventAuthority ??= deriveEventAuthorityPda(pins.programId).address),
    associatedTokenAddress(owner, mint) {
      const key = `${owner}:${mint}`;
      const hit = atas.get(key);
      if (hit) return hit;
      const ata = findProgramAddress(
        [addressToBytes(owner), tokenProgram, addressToBytes(mint)],
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ).address;
      if (atas.size >= ATA_CACHE_LIMIT) atas.clear();
      atas.set(key, ata);
      return ata;
    },
  };
}

const derivationCache = new Map<string, DevicePolicyDerivations>();

/** One cached derivation set per (program, token program) pin pair. */
export function derivationsFor(pins: DevicePolicyPins = DEVICE_POLICY_PINS) {
  const key = `${pins.programId}:${pins.tokenProgram}`;
  let d = derivationCache.get(key);
  if (!d) {
    d = createNobleDerivations(pins);
    derivationCache.set(key, d);
  }
  return d;
}

/**
 * Runs the shared policy with this phone's key, clock, noble derivations and the compiled-in
 * DEVICE_POLICY_PINS. Never throws. Any `pins` smuggled in at runtime (e.g. a spread server
 * payload) is overwritten. `pinsForTests` exists for the test worlds only (the wallet takes it
 * from WalletPlatform.policyPinsForTests, which expoPlatform never sets) and is ignored in a
 * release build.
 */
export function runDevicePolicy(
  message: Uint8Array,
  request: DevicePolicyRequest,
  device: { devicePubkey: string; nowMs: number; pinsForTests?: DevicePolicyPins },
): DevicePolicyVerdict {
  const pins =
    device.pinsForTests !== undefined && !isReleaseBuild()
      ? device.pinsForTests
      : DEVICE_POLICY_PINS;
  return checkDevicePolicy(message, {
    ...request,
    pins,
    devicePubkey: device.devicePubkey,
    nowSecs: Math.floor(device.nowMs / 1000),
    derive: derivationsFor(pins),
  } as DevicePolicyInput);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX: Readonly<Record<string, number>> = Object.fromEntries(
  [...B64].map((c, i) => [c, i]),
);

/**
 * Strict standard base64 (padded) -> bytes. Hand-written: the app ships no Buffer polyfill, and
 * the policy re-checks these bytes against message_b64 with Kit's codec anyway.
 */
export function base64ToBytes(text: string): Uint8Array {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new Error('base64: malformed');
  }
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const n =
      ((B64_INDEX[text[i] as string] ?? 0) << 18) |
      ((B64_INDEX[text[i + 1] as string] ?? 0) << 12) |
      ((B64_INDEX[text[i + 2] as string] ?? 0) << 6) |
      (B64_INDEX[text[i + 3] as string] ?? 0);
    if (o < out.length) out[o++] = (n >> 16) & 0xff;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out;
}

/** The exact bytes the phone signs: the request's own message_b64, nothing else (API-CONTRACT §6.3). */
export function messageBytesOf(request: unknown): Uint8Array {
  const b64 =
    request !== null && typeof request === 'object'
      ? (request as { message_b64?: unknown }).message_b64
      : undefined;
  if (typeof b64 !== 'string') throw new Error('request has no message_b64');
  return base64ToBytes(b64);
}
