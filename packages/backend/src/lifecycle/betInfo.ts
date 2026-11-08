/**
 * Resolves what the lifecycle service needs about a bet from the shared
 * `bets` mirror (written by POST /bets / POST /world/bets, owned by another
 * service) plus the users collection, and the authoritative Bet account from
 * the chain.
 *
 * Records are looked up in `bets`, then `world_bets`, then the draft whose
 * `bet.address` is the bet. Fields read (see CONTRACTS-ERRATA "bet-lifecycle"):
 *   program (Program AST, required), labels, title, creator_user_id,
 *   huddle_id, candidate_user_ids (§8.5 candidates frozen at POST /bets;
 *   `candidates` accepted as an alias). Missing optional fields are derived
 *   from the program's participant wallets.
 */
import { BET_STATE, type BetAccount, type Program } from '@verdict/engine';
import type { AppContext } from '../context.js';
import { ApiError } from '../errors.js';
import { COLLECTIONS, type UserRecord } from '../persistence/records.js';
import type { IxEnv } from '../chain/ixs.js';
import { isPubkey } from '../util/bytes.js';

export interface BetParticipant {
  index: number;
  wallet: string;
  user_id: string | null;
  display_name: string;
  side: 0 | 1;
}

export interface BetInfo {
  id: string;
  program: Program;
  labels: Record<string, string>;
  title: string;
  creator_user_id: string | null;
  huddle_id: string | null;
  participants: BetParticipant[];
  /** §8.5 candidate user ids: participants (in order) first, then other enrolled huddle members */
  candidates: string[];
}

type Raw = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function isProgram(v: unknown): v is Program {
  const p = v as Program | null;
  return !!p && typeof p === 'object' && p.version === 2 && Array.isArray(p.participants) && Array.isArray(p.legs);
}

export function userByWallet(ctx: AppContext, wallet: string): UserRecord | null {
  return ctx.store.collection<UserRecord>(COLLECTIONS.users).find((u) => u.wallet === wallet) ?? null;
}

export function userById(ctx: AppContext, id: string): UserRecord | null {
  return ctx.store.collection<UserRecord>(COLLECTIONS.users).get(id) ?? null;
}

/** Collections searched for a bet's record, in order (bets mirror, World Mode bets). */
export const BET_RECORD_COLLECTIONS = [COLLECTIONS.bets, 'world_bets'] as const;

/**
 * Raw record of a bet: the bets mirror, World Mode bets, else the draft whose
 * `bet.address` is this bet (POST /bets stores it there). Null if unknown.
 */
export function rawBetRecord(ctx: AppContext, betId: string): Raw | null {
  if (!isPubkey(betId)) return null;
  for (const name of BET_RECORD_COLLECTIONS) {
    const r = ctx.store.collection<Raw>(name).get(betId);
    if (r) return r;
  }
  return ctx.store.collection<Raw>(COLLECTIONS.drafts).find((d) => str((d['bet'] as Raw | null | undefined)?.['address']) === betId) ?? null;
}

/** Every bet id the backend knows (keeper sweep). */
export function knownBetIds(ctx: AppContext): string[] {
  const ids = new Set<string>();
  for (const name of BET_RECORD_COLLECTIONS) for (const [id] of ctx.store.collection<Raw>(name).entries()) if (isPubkey(id)) ids.add(id);
  for (const d of ctx.store.collection<Raw>(COLLECTIONS.drafts).values()) {
    const a = str((d['bet'] as Raw | null | undefined)?.['address']);
    if (a && isPubkey(a)) ids.add(a);
  }
  return [...ids];
}

/** Confirmed huddle members in join order (user ids). */
function huddleMembers(ctx: AppContext, huddleId: string | null): string[] {
  if (!huddleId) return [];
  const h = ctx.store.collection<Raw>(COLLECTIONS.huddles).get(huddleId);
  const members = Array.isArray(h?.['members']) ? (h!['members'] as Raw[]) : [];
  return members.flatMap((m) => {
    const uid = str(m['user_id']) ?? str((m['user'] as Raw | undefined)?.['id']);
    return uid && m['confirmed'] !== false ? [uid] : [];
  });
}

export function loadBetInfo(ctx: AppContext, betId: string): BetInfo {
  const raw = rawBetRecord(ctx, betId);
  if (!raw) throw new ApiError('NOT_FOUND', `bet ${betId}`);
  const draft = raw['draft'] as Raw | undefined;
  const program = isProgram(raw['program']) ? raw['program'] : isProgram(draft?.['program']) ? (draft!['program'] as Program) : null;
  if (!program) throw new ApiError('INTERNAL', `bet ${betId} has no program`);

  const participants: BetParticipant[] = program.participants.map((wallet, index) => {
    const u = userByWallet(ctx, wallet);
    return { index, wallet, user_id: u?.id ?? null, display_name: u?.display_name ?? `Player ${index + 1}`, side: program.sides[index] ?? 0 };
  });

  const rawLabels = raw['labels'] ?? draft?.['labels'];
  const labels: Record<string, string> = {};
  if (rawLabels && typeof rawLabels === 'object') {
    for (const [k, v] of Object.entries(rawLabels as Raw)) if (typeof v === 'string') labels[k] = v;
  }
  const huddleId = str(raw['huddle_id']) ?? str(draft?.['huddle_id']);

  const candRaw = (raw['candidate_user_ids'] ?? raw['candidates']) as unknown;
  let candidates: string[] = [];
  if (Array.isArray(candRaw)) {
    candidates = candRaw
      .map((c) => (typeof c === 'string' ? c : str((c as Raw | null)?.['user_id'])))
      .filter((c): c is string => c !== null);
  } else {
    // §8.5 fallback: other enrolled confirmed huddle members, in join order.
    candidates = huddleMembers(ctx, huddleId).filter((uid) => {
      const u = userById(ctx, uid);
      return !!u && (u.enrolled.face || u.enrolled.voice);
    });
  }
  // Participants always come first, in participant order (§8.5).
  const pids = participants.map((p) => p.user_id ?? `wallet:${p.wallet}`);
  candidates = [...pids, ...candidates.filter((c) => !pids.includes(c))].slice(0, 10);

  return {
    id: betId,
    program,
    labels,
    title: str(raw['title']) ?? str(draft?.['title']) ?? 'Bet',
    creator_user_id: str(raw['creator_user_id']) ?? str(draft?.['creator_user_id']) ?? participants[0]?.user_id ?? null,
    huddle_id: huddleId,
    participants,
    candidates,
  };
}

/** Participant index of a user (by wallet), or -1. */
export function participantIndex(info: BetInfo, user: Pick<UserRecord, 'wallet'>): number {
  return info.participants.findIndex((p) => p.wallet === user.wallet);
}

/** Participant or confirmed huddle member (bystander witnesses, §7.1). */
export function isBetMember(ctx: AppContext, info: BetInfo, user: UserRecord): boolean {
  if (participantIndex(info, user) >= 0) return true;
  if (!info.huddle_id) return false;
  const h = ctx.store.collection<Raw>(COLLECTIONS.huddles).get(info.huddle_id);
  const members = h?.['members'];
  if (!Array.isArray(members)) return false;
  return members.some((m) => {
    const r = m as Raw;
    const uid = str(r['user_id']) ?? str((r['user'] as Raw | undefined)?.['id']);
    return uid === user.id && r['confirmed'] !== false;
  });
}

export function requireMember(ctx: AppContext, info: BetInfo, user: UserRecord): void {
  if (!isBetMember(ctx, info, user)) throw new ApiError('NOT_FOUND', `bet ${info.id} (not a member)`);
}

export function ixEnv(ctx: AppContext): IxEnv {
  return { programId: ctx.chain.programId, mint: ctx.chain.mint, feePayer: ctx.chain.feePayer, oracle: ctx.chain.oracle };
}

export async function chainBet(ctx: AppContext, betId: string): Promise<BetAccount> {
  const b = await ctx.chain.getBet(betId);
  if (!b) throw new ApiError('NOT_FOUND', `bet account ${betId}`);
  return b;
}

export const STATE_NAME: Record<number, string> = {
  [BET_STATE.Proposed]: 'proposed',
  [BET_STATE.Funded]: 'funded',
  [BET_STATE.Live]: 'live',
  [BET_STATE.Perceiving]: 'perceiving',
  [BET_STATE.PreRuled]: 'preruled',
  [BET_STATE.Disputed]: 'disputed',
  [BET_STATE.Settled]: 'settled',
  [BET_STATE.Refunded]: 'refunded',
};

export function requireState(bet: BetAccount, ...states: number[]): void {
  if (!states.includes(bet.state)) throw new ApiError('WRONG_STATE', `bet state ${STATE_NAME[bet.state] ?? bet.state}`);
}

/** Wallet → user id for participants (null if the wallet has no user). */
export function participantUserIds(info: BetInfo): (string | null)[] {
  return info.participants.map((p) => p.user_id);
}
