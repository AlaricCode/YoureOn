/**
 * Mock chain ledger state (SOLANA_MODE=mock): Verdict accounts held as engine
 * models, SPL token accounts as balances. Snapshots use the engine's Borsh
 * encoders so a restart restores byte-identical accounts.
 */
import {
  decodeBetAccount,
  decodeProfile,
  decodeTrackBufferHeader,
  encodeBetAccount,
  encodeProfile,
  encodeTrackBufferHeader,
  type BetAccount,
  type ProfileAccount,
  type TrackBufferAccount,
} from '@verdict/engine';
import { fromBase64, toBase64 } from '../../util/bytes.js';

export interface TokenAccount {
  mint: string;
  owner: string;
  amount: bigint;
}

export interface LedgerState {
  /** Bet PDA → account */
  bets: Map<string, BetAccount>;
  /** Profile PDA → account */
  profiles: Map<string, ProfileAccount>;
  /** TrackBuffer PDA → account */
  trackBuffers: Map<string, TrackBufferAccount>;
  /** token account address → balance */
  tokens: Map<string, TokenAccount>;
}

export function emptyState(): LedgerState {
  return { bets: new Map(), profiles: new Map(), trackBuffers: new Map(), tokens: new Map() };
}

/** Copy-on-write clone for atomic transaction execution (accounts are replaced, never mutated in place). */
export function forkState(s: LedgerState): LedgerState {
  return {
    bets: new Map(s.bets),
    profiles: new Map(s.profiles),
    trackBuffers: new Map(s.trackBuffers),
    tokens: new Map([...s.tokens].map(([k, v]) => [k, { ...v }])),
  };
}

export interface LedgerSnapshot {
  version: 1;
  genesis_ms: number;
  bets: Record<string, string>;
  profiles: Record<string, string>;
  track_buffers: Record<string, { header: string; payload: string }>;
  tokens: Record<string, { mint: string; owner: string; amount: string }>;
}

export function snapshotState(s: LedgerState, genesisMs: number): LedgerSnapshot {
  const out: LedgerSnapshot = { version: 1, genesis_ms: genesisMs, bets: {}, profiles: {}, track_buffers: {}, tokens: {} };
  for (const [k, b] of s.bets) out.bets[k] = toBase64(encodeBetAccount(b));
  for (const [k, p] of s.profiles) out.profiles[k] = toBase64(encodeProfile(p));
  for (const [k, t] of s.trackBuffers) {
    out.track_buffers[k] = { header: toBase64(encodeTrackBufferHeader(t.header)), payload: toBase64(t.payload) };
  }
  for (const [k, t] of s.tokens) out.tokens[k] = { mint: t.mint, owner: t.owner, amount: t.amount.toString() };
  return out;
}

export function restoreState(snap: LedgerSnapshot): LedgerState {
  if (snap.version !== 1) throw new Error(`unsupported mock chain snapshot version ${String(snap.version)}`);
  const s = emptyState();
  for (const [k, v] of Object.entries(snap.bets)) s.bets.set(k, decodeBetAccount(fromBase64(v)));
  for (const [k, v] of Object.entries(snap.profiles)) s.profiles.set(k, decodeProfile(fromBase64(v)));
  for (const [k, v] of Object.entries(snap.track_buffers)) {
    s.trackBuffers.set(k, { header: decodeTrackBufferHeader(fromBase64(v.header)), payload: fromBase64(v.payload) });
  }
  for (const [k, v] of Object.entries(snap.tokens)) s.tokens.set(k, { mint: v.mint, owner: v.owner, amount: BigInt(v.amount) });
  return s;
}
