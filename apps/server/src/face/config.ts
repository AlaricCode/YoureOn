// Face module configuration, resolved once per Env (DATA-MODEL §10, SETUP-CHECKLIST §7):
//
//  - The KEK ring for embeddings at rest. `FACE_KEK_ACTIVE` names the key_id new rows use
//    (e.g. `face-kek-2026-11-a`); its 32 bytes live in `FACE_KEK_<KEY_ID in UPPER_SNAKE>`
//    (`FACE_KEK_2026_11_A`), base64 (`openssl rand -base64 32`) or 64 hex chars. Old rows keep
//    their key_id, so a rotation adds a key without re-encrypting first. Outside production a
//    fixed dev KEK (`face-kek-dev`) is used when none is configured; in production there is no
//    default: without a KEK, enrollment fails closed (500 `face_kek_missing`) and the boot log
//    says so, but the rest of the server (and the list-pick fallback) keeps working.
//  - The match-ticket HMAC key: FACE_TICKET_SECRET, else SESSION_SECRET (the documented HMAC
//    key for opaque tokens), domain-separated. Outside production a fixed dev secret is the
//    default. In production with neither set, a random per-process key is used: tickets live
//    60 s on one machine, so the only cost is that a restart voids tickets in flight.
//
// Cached per Env object, so the face routes and POST /v1/bets (which verifies tickets) share
// one key even when it is the random per-process one.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Env } from '../env';

export const DEV_KEK_ID = 'face-kek-dev';
/** The key_ids this server can resolve from Env (EnvSchema strips unknown names). */
export const KEK_ENV_NAMES = {
  'face-kek-2026-11-a': 'FACE_KEK_2026_11_A',
} as const satisfies Record<string, keyof Env>;

export interface FaceConfig {
  /** key_id -> 32-byte KEK. */
  readonly keyring: ReadonlyMap<string, Uint8Array>;
  /** key_id for new writes; null = enrollment disabled (production without a KEK). */
  readonly activeKeyId: string | null;
  /** HMAC-SHA256 key for match tickets (already domain-separated). */
  readonly ticketKey: Uint8Array;
  readonly ticketKeySource: 'FACE_TICKET_SECRET' | 'SESSION_SECRET' | 'dev-default' | 'ephemeral';
  /** API-CONTRACT §2.2: plain-v0 is accepted only while this is false. */
  readonly sealRequired: boolean;
  /** Configuration problems to log at boot (names only, never values). */
  readonly warnings: readonly string[];
}

/** 32 bytes from base64 (std, padded) or 64 hex chars; null otherwise. */
export function parseKey32(s: string): Uint8Array | null {
  const t = s.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return new Uint8Array(Buffer.from(t, 'hex'));
  const b = Buffer.from(t, 'base64');
  return b.length === 32 && b.toString('base64') === t ? new Uint8Array(b) : null;
}

const DEV_KEK = new Uint8Array(createHash('sha256').update('yo.face.kek.dev.v1').digest());
const DEV_TICKET_SECRET = 'yo-dev-match-ticket-secret';

export function resolveFaceConfig(env: Env): FaceConfig {
  const prod = env.NODE_ENV === 'production';
  const warnings: string[] = [];
  const keyring = new Map<string, Uint8Array>();
  for (const [keyId, name] of Object.entries(KEK_ENV_NAMES)) {
    const raw = env[name];
    if (raw === undefined) continue;
    const key = parseKey32(raw);
    if (key) keyring.set(keyId, key);
    else warnings.push(`${name} is not 32 bytes of base64 or hex; ignored`);
  }

  let activeKeyId: string | null = null;
  if (env.FACE_KEK_ACTIVE !== undefined) {
    if (keyring.has(env.FACE_KEK_ACTIVE)) activeKeyId = env.FACE_KEK_ACTIVE;
    else warnings.push(`FACE_KEK_ACTIVE names ${env.FACE_KEK_ACTIVE}, which has no usable key`);
  } else if (keyring.size === 1) {
    activeKeyId = [...keyring.keys()][0]!;
  }
  if (!prod) {
    keyring.set(DEV_KEK_ID, DEV_KEK);
    activeKeyId ??= DEV_KEK_ID;
  } else if (activeKeyId === null) {
    warnings.push(
      'no face KEK (set FACE_KEK_ACTIVE and FACE_KEK_2026_11_A): face enrollment is disabled',
    );
  }

  let secret: string;
  let ticketKeySource: FaceConfig['ticketKeySource'];
  if (env.FACE_TICKET_SECRET !== undefined) {
    secret = env.FACE_TICKET_SECRET;
    ticketKeySource = 'FACE_TICKET_SECRET';
  } else if (env.SESSION_SECRET !== undefined) {
    secret = env.SESSION_SECRET;
    ticketKeySource = 'SESSION_SECRET';
  } else if (!prod) {
    secret = DEV_TICKET_SECRET;
    ticketKeySource = 'dev-default';
  } else {
    secret = randomBytes(32).toString('base64');
    ticketKeySource = 'ephemeral';
    warnings.push('no FACE_TICKET_SECRET or SESSION_SECRET: match tickets use a per-process key');
  }
  const ticketKey = new Uint8Array(
    createHmac('sha256', secret).update('yo.match_ticket.v1').digest(),
  );

  return {
    keyring,
    activeKeyId,
    ticketKey,
    ticketKeySource,
    sealRequired: env.FACE_SEAL_REQUIRED,
    warnings,
  };
}

const cache = new WeakMap<Env, FaceConfig>();

/** The face config for this Env, resolved once (see the module comment). */
export function faceConfigOf(env: Env): FaceConfig {
  let c = cache.get(env);
  if (!c) cache.set(env, (c = resolveFaceConfig(env)));
  return c;
}
