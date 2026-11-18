// Demo claim tokens (API-CONTRACT §1.3, §2.17): the stage QR that lets a phone take over one of
// the two custodial demo parties (decision D-A: phones A / B import the demo-a / demo-b seeds, so
// phone-signed and custodial locks use the same party keys).
//
//   token  `yo_dc_<base64url 32 B>`, single use, 10 min, stored as sha256(token) only
//   qr     `youreon://<word>/<token>` (the word only helps the operator tell two QRs apart)
//
// In-process like the auth challenges (one Fly machine, ARCHITECTURE §1.3): a restart costs the
// operator one re-issue. Found through `claimTokensOf(deps)`, so no AppDeps field is needed.
import { randomInt } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { getAddressDecoder, getBase58Encoder, type Address } from '@solana/kit';
import { DEMO_CLAIM_TOKEN_TTL_MS, demoClaimQr, type DemoParty } from '@youre-on/shared/api';
import type { AppDeps } from '../context';
import type { Env } from '../env';
import { randomB64Url, sha256Hex } from '../crypto'; // crypto also installs noble's sha512

export const CLAIM_TOKEN_PREFIX = 'yo_dc_';

const WORDS = [
  'apple',
  'bison',
  'cedar',
  'delta',
  'ember',
  'fjord',
  'gecko',
  'harbor',
  'igloo',
  'jade',
  'koala',
  'lemon',
  'maple',
  'nectar',
  'otter',
  'pepper',
  'quartz',
  'raven',
  'salmon',
  'tiger',
  'umber',
  'violet',
  'walrus',
  'yarrow',
  'zebra',
  'comet',
  'orbit',
  'pixel',
  'river',
  'sprout',
  'tundra',
  'willow',
] as const;

export interface ClaimTokenEntry {
  party: DemoParty;
  display_name: string | null;
  word: string;
  issued_at: number;
  expires_at: number;
  used_at: number | null;
}

export interface IssuedClaimToken {
  token: string;
  word: string;
  qr: string;
  entry: ClaimTokenEntry;
}

export type ClaimConsumeResult =
  { ok: true; entry: ClaimTokenEntry } | { ok: false; reason: 'unknown' | 'expired' | 'used' };

export class ClaimTokenStore {
  /** sha256(token) -> entry. Used entries stay (as tombstones) until they expire. */
  private readonly map = new Map<string, ClaimTokenEntry>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DEMO_CLAIM_TOKEN_TTL_MS,
    private readonly maxEntries = 1_000,
  ) {}

  issue(a: { party: DemoParty; display_name?: string | null }): IssuedClaimToken {
    const now = this.now();
    this.sweep(now);
    const token = CLAIM_TOKEN_PREFIX + randomB64Url(32);
    const word = WORDS[randomInt(WORDS.length)]!;
    const entry: ClaimTokenEntry = {
      party: a.party,
      display_name: a.display_name ?? null,
      word,
      issued_at: now,
      expires_at: now + this.ttlMs,
      used_at: null,
    };
    this.map.set(sha256Hex(token), entry);
    return { token, word, qr: demoClaimQr(word, token), entry };
  }

  /** Single use: a token is spent by the first consume, whatever happens after it. */
  consume(token: string): ClaimConsumeResult {
    const key = sha256Hex(token);
    const entry = this.map.get(key);
    if (!entry) return { ok: false, reason: 'unknown' };
    const now = this.now();
    if (now > entry.expires_at) {
      this.map.delete(key);
      return { ok: false, reason: 'expired' };
    }
    if (entry.used_at !== null) return { ok: false, reason: 'used' };
    entry.used_at = now;
    return { ok: true, entry: { ...entry } };
  }

  get size() {
    return this.map.size;
  }

  private sweep(now: number) {
    for (const [k, e] of this.map) if (e.expires_at < now) this.map.delete(k);
    // Bounded: drop the oldest when an operator script runs away.
    for (const k of this.map.keys()) {
      if (this.map.size < this.maxEntries) break;
      this.map.delete(k);
    }
  }
}

const registry = new WeakMap<object, ClaimTokenStore>();

/** The claim-token store of this deps bag (issued by /v1/demo, spent by /v1/auth/demo-claim). */
export function claimTokensOf(deps: Pick<AppDeps, 'now'>): ClaimTokenStore {
  let s = registry.get(deps);
  if (!s) registry.set(deps, (s = new ClaimTokenStore(deps.now)));
  return s;
}

// ---------------------------------------------------------------------------------------------
// The custodial party keys

export interface DemoPartyKey {
  /** 32-byte ed25519 seed. Never logged. */
  seed: Uint8Array;
  /** base58 wallet pubkey. */
  pubkey: Address;
}

const PARTY_ENV = { a: 'DEMO_A_SECRET_KEY', b: 'DEMO_B_SECRET_KEY' } as const;

/**
 * DEMO_A/B_SECRET_KEY -> seed + pubkey, in the formats chain/tx.ts parseSecretKey accepts
 * (base58 64-byte secret‖pubkey or 32-byte seed, or solana-keygen JSON), so the key here is the
 * same one the server's custodial lock signer uses. null when the env var is unset.
 */
export function demoPartyKey(
  env: Pick<Env, 'DEMO_A_SECRET_KEY' | 'DEMO_B_SECRET_KEY'>,
  party: DemoParty,
): DemoPartyKey | null {
  const name = PARTY_ENV[party];
  const raw = env[name]?.trim();
  if (!raw) return null;
  let bytes: Uint8Array;
  if (raw.startsWith('[')) {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((b) => Number.isInteger(b) && b >= 0 && b <= 255))
      throw new Error(`${name}: not a JSON byte array`);
    bytes = Uint8Array.from(parsed as number[]);
  } else {
    bytes = new Uint8Array(getBase58Encoder().encode(raw));
  }
  if (bytes.length !== 32 && bytes.length !== 64)
    throw new Error(`${name}: expected 32 or 64 bytes, got ${bytes.length}`);
  const seed = bytes.slice(0, 32);
  const pub = ed.getPublicKey(seed);
  if (bytes.length === 64 && !pub.every((b, i) => b === bytes[32 + i]))
    throw new Error(`${name}: keypair halves disagree`);
  bytes.fill(0);
  return { seed, pubkey: getAddressDecoder().decode(pub) };
}
