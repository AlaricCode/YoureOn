/**
 * Biometric template vault (§8.2, §8.4).
 *
 * Per modality the backend stores `{q, salt}` encrypted with AES-256-GCM
 * under `BIOMETRIC_KEY`. The additional authenticated data binds every
 * ciphertext to the user, the wallet and the field, so a blob copied to
 * another user/wallet/modality fails to decrypt.
 *
 * Pending (not yet completed) enrollment templates live in the
 * `enrollments` collection, encrypted the same way. "Delete biometrics"
 * removes every ciphertext and commitment from the store (the JSON file is
 * rewritten atomically, so the old bytes are no longer referenced).
 */
import { randomBytes } from 'node:crypto';
import {
  commitmentToBytes,
  FACE_DIM,
  poseidonCommit,
  saltFromBytes,
  SALT_BYTES,
  VOICE_DIM,
  type Modality,
} from '@verdict/engine';
import { decryptAesGcm, encryptAesGcm } from '../crypto/aes.js';
import { COLLECTIONS, type UserRecord } from '../persistence/records.js';
import type { Collection, JsonStore } from '../persistence/store.js';
import { fromBase64, toBase64, toHex } from '../util/bytes.js';
import type { Clock } from '../util/clock.js';

export const ZERO_COMMIT_HEX = '00'.repeat(32);

export const DIM: Record<Modality, number> = { face: FACE_DIM, voice: VOICE_DIM };

export interface PendingEnrollment {
  user_id: string;
  wallet: string;
  challenge_id: string;
  face_template_enc?: string;
  voice_template_enc?: string;
  updated_at_ms: number;
}

export interface StoredTemplate {
  modality: Modality;
  /** quantized template (128-d face / 192-d voice) */
  q: Int8Array;
  /** 31-byte salt, little-endian (§8.4) */
  salt: bigint;
  /** 32-byte big-endian commitment, hex */
  commit: string;
}

type Field = 'template' | 'salt' | 'pending';

function aad(userId: string, wallet: string, modality: Modality, field: Field): Uint8Array {
  return new TextEncoder().encode(`verdict/biometric/v1|${userId}|${wallet}|${modality}|${field}`);
}

function int8ToBytes(q: Int8Array): Uint8Array {
  return new Uint8Array(q.buffer.slice(q.byteOffset, q.byteOffset + q.byteLength));
}

function bytesToInt8(b: Uint8Array, dim: number): Int8Array {
  if (b.length !== dim) throw new Error(`template has ${b.length} dims, expected ${dim}`);
  const out = new Int8Array(dim);
  for (let i = 0; i < dim; i++) out[i] = (b[i]! << 24) >> 24;
  return out;
}

/** §8.4 commitment over the (face zero-padded) template. */
export function commitTemplate(q: Int8Array, salt: bigint): string {
  return toHex(commitmentToBytes(poseidonCommit(q, salt)));
}

export class BiometricVault {
  readonly users: Collection<UserRecord>;
  readonly pending: Collection<PendingEnrollment>;

  constructor(
    store: JsonStore,
    private readonly key: Uint8Array,
    private readonly clock: Clock,
  ) {
    this.users = store.collection<UserRecord>(COLLECTIONS.users);
    this.pending = store.collection<PendingEnrollment>(COLLECTIONS.enrollments);
  }

  private enc(u: Pick<UserRecord, 'id' | 'wallet'>, m: Modality, f: Field, plain: Uint8Array): string {
    return toBase64(encryptAesGcm(this.key, plain, aad(u.id, u.wallet, m, f)));
  }

  private dec(u: Pick<UserRecord, 'id' | 'wallet'>, m: Modality, f: Field, b64: string): Uint8Array {
    return decryptAesGcm(this.key, fromBase64(b64), aad(u.id, u.wallet, m, f));
  }

  // ---- pending enrollment -------------------------------------------------------

  /** Stores a pending template for `modality` (replacing any earlier one). */
  putPending(user: Pick<UserRecord, 'id' | 'wallet'>, challengeId: string, modality: Modality, q: Int8Array): void {
    if (q.length !== DIM[modality]) throw new Error(`pending ${modality} template must have ${DIM[modality]} dims`);
    const cur = this.pending.get(user.id);
    const base: PendingEnrollment =
      cur && cur.wallet === user.wallet
        ? cur
        : { user_id: user.id, wallet: user.wallet, challenge_id: challengeId, updated_at_ms: 0 };
    const rec: PendingEnrollment = {
      ...base,
      challenge_id: challengeId,
      [`${modality}_template_enc`]: this.enc(user, modality, 'pending', int8ToBytes(q)),
      updated_at_ms: this.clock.nowMs(),
    };
    this.pending.set(user.id, rec);
  }

  getPending(user: Pick<UserRecord, 'id' | 'wallet'>, modality: Modality): Int8Array | null {
    const rec = this.pending.get(user.id);
    if (!rec || rec.wallet !== user.wallet) return null;
    const b64 = modality === 'face' ? rec.face_template_enc : rec.voice_template_enc;
    return b64 ? bytesToInt8(this.dec(user, modality, 'pending', b64), DIM[modality]) : null;
  }

  clearPending(userId: string): void {
    this.pending.delete(userId);
  }

  // ---- committed templates ---------------------------------------------------

  /**
   * Seals a template: fresh 31-byte salt, §8.4 commitment, encrypted `{q, salt}`.
   * Returns the updated biometrics block (not yet persisted).
   */
  seal(user: UserRecord, modality: Modality, q: Int8Array): NonNullable<UserRecord['biometrics']> {
    const saltBytes = new Uint8Array(randomBytes(SALT_BYTES));
    const salt = saltFromBytes(saltBytes);
    const bio = { ...(user.biometrics ?? {}) };
    if (modality === 'face') {
      bio.face_template_enc = this.enc(user, 'face', 'template', int8ToBytes(q));
      bio.face_salt_enc = this.enc(user, 'face', 'salt', saltBytes);
      bio.face_commit = commitTemplate(q, salt);
    } else {
      bio.voice_template_enc = this.enc(user, 'voice', 'template', int8ToBytes(q));
      bio.voice_salt_enc = this.enc(user, 'voice', 'salt', saltBytes);
      bio.voice_commit = commitTemplate(q, salt);
    }
    return bio;
  }

  /** Decrypted enrolled template for a user, or null if not enrolled in `modality`. */
  template(userId: string, modality: Modality): StoredTemplate | null {
    const u = this.users.get(userId);
    const b = u?.biometrics;
    if (!u || !b) return null;
    const [t, s, c] =
      modality === 'face' ? [b.face_template_enc, b.face_salt_enc, b.face_commit] : [b.voice_template_enc, b.voice_salt_enc, b.voice_commit];
    if (!t || !s || !c) return null;
    const q = bytesToInt8(this.dec(u, modality, 'template', t), DIM[modality]);
    const saltBytes = this.dec(u, modality, 'salt', s);
    return { modality, q, salt: saltFromBytes(saltBytes), commit: c };
  }

  commits(user: UserRecord): { face_commit: string; voice_commit: string } {
    return {
      face_commit: user.biometrics?.face_commit ?? ZERO_COMMIT_HEX,
      voice_commit: user.biometrics?.voice_commit ?? ZERO_COMMIT_HEX,
    };
  }

  /** Erases every template, salt, commitment and pending enrollment of the user. */
  erase(userId: string): UserRecord {
    this.clearPending(userId);
    return this.users.update(userId, (u) => {
      const { biometrics: _gone, ...rest } = u;
      return { ...rest, enrolled: { face: false, voice: false }, updated_at_ms: this.clock.nowMs() };
    });
  }
}
