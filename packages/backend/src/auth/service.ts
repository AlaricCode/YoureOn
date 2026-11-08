/**
 * §12.1 / §12.3 auth: login nonces, wallet-signature verification, users
 * bound to one wallet, bearer sessions.
 *
 *   wallet_sig = ed25519(wallet, "VERDICT/LOGIN/v1" ‖ utf8(nonce))
 *
 * Login identity: Google (mock credential "mock:<email>") or email + code
 * (mock code "000000"). A different wallet for an existing user, or a wallet
 * already bound to another user, is WALLET_MISMATCH.
 */
import { createHash } from 'node:crypto';
import { verifyEd25519 } from '../crypto/keys.js';
import { ApiError, ensure } from '../errors.js';
import type { Collection, JsonStore } from '../persistence/store.js';
import {
  COLLECTIONS,
  type EmailCodeRecord,
  type NonceRecord,
  type SessionRecord,
  type UserRecord,
} from '../persistence/records.js';
import { concat, fromBase64, isPubkey, utf8 } from '../util/bytes.js';
import type { Clock } from '../util/clock.js';
import { randomToken, uuid } from '../util/ids.js';

export const LOGIN_TAG = 'VERDICT/LOGIN/v1';
export const NONCE_TTL_MS = 5 * 60_000;
export const EMAIL_CODE_TTL_MS = 10 * 60_000;
export const MOCK_EMAIL_CODE = '000000';
export const MAX_EMAIL_ATTEMPTS = 5;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}$/;

export function loginMessage(nonce: string): Uint8Array {
  return concat(utf8(LOGIN_TAG), utf8(nonce));
}

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface SessionRequest {
  provider: 'google' | 'email';
  credential: string;
  email_code?: string;
  wallet: string;
  nonce: string;
  wallet_sig_b64: string;
}

export interface AuthServiceOptions {
  store: JsonStore;
  clock: Clock;
  /** Google ID-token verifier; null ⇒ only mock credentials ("mock:<email>") */
  verifyGoogle?: ((credential: string) => Promise<{ sub: string; email: string | null } | null>) | null;
}

export function defaultDisplayName(email: string | null): string {
  const local = (email ?? '').split('@')[0] ?? '';
  const word = local.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ')[0] ?? '';
  return word ? word[0]!.toUpperCase() + word.slice(1, 32) : 'Player';
}

export class AuthService {
  readonly users: Collection<UserRecord>;
  readonly sessions: Collection<SessionRecord>;
  private readonly nonces: Collection<NonceRecord>;
  private readonly emailCodes: Collection<EmailCodeRecord>;

  constructor(private readonly opts: AuthServiceOptions) {
    this.users = opts.store.collection<UserRecord>(COLLECTIONS.users);
    this.sessions = opts.store.collection<SessionRecord>(COLLECTIONS.sessions);
    this.nonces = opts.store.collection<NonceRecord>(COLLECTIONS.nonces);
    this.emailCodes = opts.store.collection<EmailCodeRecord>(COLLECTIONS.emailCodes);
  }

  private now(): number {
    return this.opts.clock.nowMs();
  }

  issueNonce(): string {
    this.pruneNonces();
    const nonce = randomToken(24);
    this.nonces.set(nonce, { nonce, expires_at_ms: this.now() + NONCE_TTL_MS });
    return nonce;
  }

  /** Single use: true iff the nonce existed and had not expired. */
  consumeNonce(nonce: string): boolean {
    const n = this.nonces.get(nonce);
    if (!n) return false;
    this.nonces.delete(nonce);
    return n.expires_at_ms >= this.now();
  }

  private pruneNonces(): void {
    const now = this.now();
    for (const [k, v] of this.nonces.entries()) if (v.expires_at_ms < now) this.nonces.delete(k);
  }

  /** POST /auth/email/start. No email provider exists in §13: the code is always the mock code. */
  startEmail(emailRaw: unknown): { sent: true } {
    const email = normalizeEmail(emailRaw);
    this.emailCodes.set(email, { email, code: MOCK_EMAIL_CODE, expires_at_ms: this.now() + EMAIL_CODE_TTL_MS, attempts: 0 });
    return { sent: true };
  }

  private checkEmailCode(email: string, code: string | undefined): void {
    const rec = this.emailCodes.get(email);
    ensure(rec && rec.expires_at_ms >= this.now(), 'CODE_INVALID');
    if (rec.attempts >= MAX_EMAIL_ATTEMPTS) throw new ApiError('RATE_LIMITED');
    if (code !== rec.code) {
      this.emailCodes.set(email, { ...rec, attempts: rec.attempts + 1 });
      throw new ApiError('CODE_INVALID');
    }
    this.emailCodes.delete(email);
  }

  private async resolveIdentity(req: SessionRequest): Promise<{ identity: string; email: string | null }> {
    if (req.provider === 'email') {
      const email = normalizeEmail(req.credential);
      this.checkEmailCode(email, req.email_code);
      return { identity: `email:${email}`, email };
    }
    if (req.provider === 'google') {
      if (req.credential.startsWith('mock:')) {
        const email = normalizeEmail(req.credential.slice(5));
        return { identity: `google:${email}`, email };
      }
      const v = this.opts.verifyGoogle ? await this.opts.verifyGoogle(req.credential) : null;
      ensure(v, 'UNAUTHORIZED', 'google credential rejected');
      return { identity: `google:${v.email ?? v.sub}`, email: v.email };
    }
    throw new ApiError('UNAUTHORIZED', 'unknown provider');
  }

  /** POST /auth/session → {token, user}. */
  async createSession(raw: unknown): Promise<{ token: string; user: UserRecord }> {
    const req = parseSessionRequest(raw);
    ensure(this.consumeNonce(req.nonce), 'CHALLENGE_EXPIRED', 'unknown or expired nonce');
    let sig: Uint8Array;
    try {
      sig = fromBase64(req.wallet_sig_b64);
    } catch {
      throw new ApiError('UNAUTHORIZED', 'wallet_sig_b64 is not base64');
    }
    ensure(verifyEd25519(sig, loginMessage(req.nonce), req.wallet), 'UNAUTHORIZED', 'bad wallet signature');

    const { identity, email } = await this.resolveIdentity(req);
    const now = this.now();
    let user = this.users.find((u) => u.identity === identity);
    if (user) {
      ensure(user.wallet === req.wallet, 'WALLET_MISMATCH');
    } else {
      ensure(!this.users.find((u) => u.wallet === req.wallet), 'WALLET_MISMATCH', 'wallet bound to another user');
      user = {
        id: uuid(),
        wallet: req.wallet,
        display_name: defaultDisplayName(email),
        identity,
        email,
        enrolled: { face: false, voice: false },
        created_at_ms: now,
        updated_at_ms: now,
      };
      this.users.set(user.id, user);
    }
    const token = randomToken(32);
    this.sessions.set(hashToken(token), { id: hashToken(token), user_id: user.id, created_at_ms: now, last_used_ms: now });
    return { token, user };
  }

  /** Bearer token → user id (null if unknown). */
  authenticate(token: string): string | null {
    if (!token) return null;
    const s = this.sessions.get(hashToken(token));
    if (!s || !this.users.has(s.user_id)) return null;
    return s.user_id;
  }

  requireUser(userId: string): UserRecord {
    const u = this.users.get(userId);
    if (!u) throw new ApiError('UNAUTHORIZED');
    return u;
  }

  userByWallet(wallet: string): UserRecord | undefined {
    return this.users.find((u) => u.wallet === wallet);
  }

  revoke(token: string): void {
    this.sessions.delete(hashToken(token));
  }
}

function normalizeEmail(x: unknown): string {
  if (typeof x !== 'string') throw new ApiError('CODE_INVALID', 'email missing');
  const e = x.trim().toLowerCase();
  if (!EMAIL_RE.test(e)) throw new ApiError('CODE_INVALID', 'email invalid');
  return e;
}

function parseSessionRequest(raw: unknown): SessionRequest {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : null);
  const provider = str('provider');
  const credential = str('credential');
  const wallet = str('wallet');
  const nonce = str('nonce');
  const sig = str('wallet_sig_b64');
  if ((provider !== 'google' && provider !== 'email') || !credential || !nonce || !sig) {
    throw new ApiError('UNAUTHORIZED', 'malformed session request');
  }
  if (!isPubkey(wallet)) throw new ApiError('UNAUTHORIZED', 'wallet is not a base58 public key');
  const code = str('email_code');
  return { provider, credential, wallet, nonce, wallet_sig_b64: sig, ...(code !== null ? { email_code: code } : {}) };
}
