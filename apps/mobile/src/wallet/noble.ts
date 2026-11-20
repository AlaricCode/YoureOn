// The one place that configures @noble/ed25519 for synchronous use. Hermes has no crypto.subtle, so
// noble's *Async functions (which use WebCrypto SHA-512) cannot run there; the sync API needs
// `ed.hashes.sha512` set from @noble/hashes. Import `ed` from here, not from the package.
import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';

ed.hashes.sha512 = sha512;

export { ed, sha256 };

// A fixed, public, non-secret seed used only to warm noble's base-point tables. Never a wallet key.
const WARMUP_SEED = new Uint8Array(32).fill(7);

let warmed = false;

/**
 * Builds noble's base-point precompute tables (cold cost measured at 92-127 ms on Hermes)
 * so the first real signature after Face ID is fast. Idempotent and cheap once warm.
 */
export function prewarmSigner(): void {
  if (warmed) return;
  const pub = ed.getPublicKey(WARMUP_SEED);
  const sig = ed.sign(WARMUP_SEED, WARMUP_SEED);
  ed.verify(sig, WARMUP_SEED, pub);
  warmed = true;
}
