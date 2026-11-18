// Migration 0006 (face_enrollments, DATA-MODEL §5.3) against Postgres; skips without
// DATABASE_URL. Checks the CHECKs the face module relies on, the one-row-per-user rule, the
// cascade on user deletion and the audit_log biometric tripwire (migration 0001).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { auditLog, createDb, faceEnrollments, users, type DbHandle } from '../src/index';

async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return err.cause?.message ?? err.message ?? String(e);
  }
  throw new Error('expected the query to fail');
}

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fakeKey = () => Array.from(randomBytes(44), (b) => B58[b % B58.length]).join('');
const HASH = 'a'.repeat(64);

d('migration 0006: face_enrollments', () => {
  let h: DbHandle;
  beforeAll(() => {
    h = createDb({ url: URL! });
  });
  afterAll(async () => {
    await h?.close();
  });

  const mkUser = async () => {
    const [u] = await h.db
      .insert(users)
      .values({
        display_name: 'F',
        wallet_pubkey: fakeKey(),
        age_attested_18plus: true,
        attested_at: new Date(),
      })
      .returning();
    return u!;
  };

  const row = (userId: string, over: Partial<typeof faceEnrollments.$inferInsert> = {}) => {
    const now = new Date();
    return {
      user_id: userId,
      embedding_ciphertext: new Uint8Array(512 * 4 + 16),
      embedding_nonce: new Uint8Array(12),
      key_id: 'face-kek-test',
      embedding_dim: 512,
      model_name: 'w600k_mbf',
      model_version: 'buffalo_s-fp32',
      consent_version: 'face-consent-v1',
      consent_text_sha256: HASH,
      consent_at: new Date(now.getTime() - 5_000),
      liveness_method: 'head_turn' as const,
      liveness_passed_at: now,
      created_at: now,
      ...over,
    };
  };

  it('stores one active row per user', async () => {
    const u = await mkUser();
    const [r] = await h.db.insert(faceEnrollments).values(row(u.id)).returning();
    expect(r).toMatchObject({ status: 'active', disabled_at: null, last_used_at: null });
    expect(await pgError(h.db.insert(faceEnrollments).values(row(u.id)))).toMatch(
      /face_enrollments_user_id_uq/,
    );
  });

  it('CHECKs: nonce is 12 bytes, ciphertext is dim*4 + 16, dim in 64..1024', async () => {
    const u = await mkUser();
    expect(
      await pgError(
        h.db.insert(faceEnrollments).values(row(u.id, { embedding_nonce: new Uint8Array(16) })),
      ),
    ).toMatch(/face_enrollments_nonce_len/);
    expect(
      await pgError(
        h.db
          .insert(faceEnrollments)
          .values(row(u.id, { embedding_ciphertext: new Uint8Array(512 * 4) })),
      ),
    ).toMatch(/face_enrollments_ciphertext_len/);
    expect(
      await pgError(
        h.db.insert(faceEnrollments).values(
          row(u.id, {
            embedding_dim: 32,
            embedding_ciphertext: new Uint8Array(32 * 4 + 16),
          }),
        ),
      ),
    ).toMatch(/face_enrollments_dim/);
    // 128-d (the SFace fallback) is a valid shape.
    await h.db.insert(faceEnrollments).values(
      row(u.id, {
        embedding_dim: 128,
        embedding_ciphertext: new Uint8Array(128 * 4 + 16),
        model_name: 'sface',
        model_version: '2021dec',
      }),
    );
  });

  it('CHECKs: consent before capture, disabled_at iff disabled, consent hash format', async () => {
    const u = await mkUser();
    const now = new Date();
    expect(
      await pgError(
        h.db
          .insert(faceEnrollments)
          .values(row(u.id, { consent_at: new Date(now.getTime() + 60_000), created_at: now })),
      ),
    ).toMatch(/face_enrollments_consent_before_capture/);
    expect(
      await pgError(h.db.insert(faceEnrollments).values(row(u.id, { status: 'disabled' }))),
    ).toMatch(/face_enrollments_disabled_at/);
    expect(
      await pgError(h.db.insert(faceEnrollments).values(row(u.id, { disabled_at: new Date() }))),
    ).toMatch(/face_enrollments_disabled_at/);
    expect(
      await pgError(
        h.db.insert(faceEnrollments).values(row(u.id, { consent_text_sha256: 'NOT-HEX' })),
      ),
    ).toMatch(/face_enrollments_consent_text_sha256_fmt/);
    await h.db
      .insert(faceEnrollments)
      .values(row(u.id, { status: 'disabled', disabled_at: new Date() }));
  });

  it('a deleted user takes the enrollment with them (CASCADE)', async () => {
    const u = await mkUser();
    await h.db.insert(faceEnrollments).values(row(u.id));
    await h.db.delete(users).where(eq(users.id, u.id));
    const left = await h.db
      .select({ id: faceEnrollments.id })
      .from(faceEnrollments)
      .where(eq(faceEnrollments.user_id, u.id));
    expect(left).toEqual([]);
  });

  it('audit_log refuses biometric keys in details (0001 tripwire)', async () => {
    for (const key of ['embedding', 'embedding_ciphertext', 'embedding_nonce', 'probe']) {
      expect(
        await pgError(
          h.db
            .insert(auditLog)
            .values({ actor_kind: 'user', action: 'face.enrolled', details: { [key]: 'x' } }),
        ),
      ).toMatch(/check constraint/i);
    }
  });
});
