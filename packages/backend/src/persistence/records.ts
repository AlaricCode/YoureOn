/**
 * Persisted record shapes and collection names (§12.7). Service agents add
 * their own collections (huddles, drafts, bets mirror, booth, keeper, …)
 * through `JsonStore.collection<T>(name)`; names are reserved here so they
 * don't collide.
 */

export const COLLECTIONS = {
  users: 'users',
  sessions: 'sessions',
  nonces: 'nonces',
  emailCodes: 'email_codes',
  txs: 'txs',
  chainEvents: 'chain_events',
  faucet: 'faucet',
  // owned by service agents:
  huddles: 'huddles',
  drafts: 'drafts',
  challenges: 'challenges',
  bets: 'bets',
  witnesses: 'witnesses',
  chunks: 'chunks',
  booth: 'booth',
  keeper: 'keeper',
  quotes: 'quotes',
  enrollments: 'enrollments',
} as const;

export interface UserRecord {
  id: string;
  /** base58 wallet bound at the first POST /auth/session (§12.1) */
  wallet: string;
  display_name: string;
  /** login identity: "email:<addr>" or "google:<sub/email>" */
  identity: string;
  email: string | null;
  enrolled: { face: boolean; voice: boolean };
  created_at_ms: number;
  updated_at_ms: number;
  /**
   * Identity agent: encrypted templates (AES-256-GCM, BIOMETRIC_KEY, base64),
   * commitments (hex) and salts. Never sent to clients.
   */
  biometrics?: {
    face_template_enc?: string;
    voice_template_enc?: string;
    face_commit?: string;
    voice_commit?: string;
    face_salt_enc?: string;
    voice_salt_enc?: string;
  };
}

/** §12.2 UserView */
export interface UserView {
  id: string;
  wallet: string;
  display_name: string;
  enrolled: { face: boolean; voice: boolean };
}

export function userView(u: UserRecord): UserView {
  return { id: u.id, wallet: u.wallet, display_name: u.display_name, enrolled: { ...u.enrolled } };
}

export interface SessionRecord {
  /** sha256(token) hex — the raw token is never stored */
  id: string;
  user_id: string;
  created_at_ms: number;
  last_used_ms: number;
}

export interface NonceRecord {
  nonce: string;
  expires_at_ms: number;
}

export interface EmailCodeRecord {
  email: string;
  code: string;
  expires_at_ms: number;
  attempts: number;
}

export type TxStatus = 'pending' | 'confirmed' | 'failed';

export interface TxRecord {
  tx_id: string;
  user_id: string;
  /** wallet that must sign (the user's) */
  signer: string;
  /** what the tx does, e.g. "fund", "create_bet", "pay" (service hook key) */
  kind: string;
  /** serialized message, base64 */
  message_b64: string;
  expires_at_ms: number;
  summary: string;
  status: TxStatus;
  signature: string | null;
  error: { code: string; message: string; detail?: string } | null;
  /** free-form context for the confirm hook (JSON) */
  meta: Record<string, unknown>;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface FaucetRecord {
  /** `${user_id}:${utc day}` */
  id: string;
  user_id: string;
  amount_units: number;
  signature: string | null;
  at_ms: number;
}
