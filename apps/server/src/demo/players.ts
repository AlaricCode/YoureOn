// Demo players: the team's two demo accounts, which the DEMO_MODE guards keep the live demo for
// (the demo room and its projector, the nonce pool, the voice judge, the admin device route).
//
// A demo player is a demo-claim user (users.is_demo) or whoever holds the demo-a / demo-b wallet:
// cp1-drive signs those wallets up through the ordinary signup, so is_demo alone is not enough.
// The wallets come from env DEMO_A / DEMO_B_SECRET_KEY and from the chain runtime's custodial keys
// (the same values in production; tests install a runtime with their own).
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { apiSessions, users, type Db } from '@youre-on/db';
import type { AppDeps } from '../context';
import { HttpError } from '../errors';
import type { LifecycleDeps } from '../lock/common';
import { lifecycleOf } from '../lock/runtime';
import { demoPartyKey } from './claim-tokens';

let envMemo: { key: string; wallets: string[] } | null = null;

function envWallets(env: AppDeps['env']): string[] {
  const key = `${env.DEMO_A_SECRET_KEY ?? ''}\n${env.DEMO_B_SECRET_KEY ?? ''}`;
  if (envMemo?.key === key) return envMemo.wallets;
  const wallets: string[] = [];
  for (const party of ['a', 'b'] as const) {
    try {
      const k = demoPartyKey(env, party);
      if (k) {
        k.seed.fill(0);
        wallets.push(k.pubkey);
      }
    } catch {
      // a malformed key: demo-claim and the chain runtime report it
    }
  }
  envMemo = { key, wallets };
  return wallets;
}

/** The demo-a / demo-b wallet pubkeys this server knows. */
export async function demoWallets(deps: LifecycleDeps): Promise<Set<string>> {
  const out = new Set(envWallets(deps.env));
  const rt = await lifecycleOf(deps)
    .runtime()
    .catch(() => null);
  for (const k of [rt?.keys.demoA, rt?.keys.demoB]) if (k) out.add(k.address);
  return out;
}

export function isDemoPlayer(
  u: { is_demo: boolean; wallet_pubkey: string | null },
  wallets: ReadonlySet<string>,
): boolean {
  return u.is_demo || (u.wallet_pubkey !== null && wallets.has(u.wallet_pubkey));
}

/** The ids among `userIds` that are not demo players (an unknown id counts as not one). */
export async function nonDemoPlayers(
  deps: LifecycleDeps,
  userIds: readonly string[],
  db: Pick<Db, 'select'> = deps.db,
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const [rows, wallets] = await Promise.all([
    db
      .select({ id: users.id, is_demo: users.is_demo, wallet_pubkey: users.wallet_pubkey })
      .from(users)
      .where(inArray(users.id, [...userIds])),
    demoWallets(deps),
  ]);
  const demo = new Set(rows.filter((u) => isDemoPlayer(u, wallets)).map((u) => u.id));
  return userIds.filter((id) => !demo.has(id));
}

/**
 * DEMO_MODE: is this the demo room, i.e. one a demo player created or one the projector shows (a
 * live stage session)? Only demo players may join it or bet in it (rooms/routes.ts, bets/routes.ts).
 * The projector shows every bet of its room and plays its cues, and the room code is on screen:
 * otherwise anyone at the venue could put their own bet, "judge" captions and sounds on it, or
 * challenge demo B and park B's phone on that bet.
 */
export async function isDemoRoom(
  deps: LifecycleDeps,
  room: { id: string; created_by: string | null },
): Promise<boolean> {
  if (!deps.env.DEMO_MODE) return false;
  const [stage] = await deps.db
    .select({ id: apiSessions.id })
    .from(apiSessions)
    .where(
      and(
        eq(apiSessions.room_id, room.id),
        sql`'stage' = ANY(${apiSessions.scopes})`,
        isNull(apiSessions.revoked_at),
        gt(apiSessions.expires_at, new Date(deps.now())),
      ),
    )
    .limit(1);
  if (stage) return true;
  return room.created_by !== null && (await nonDemoPlayers(deps, [room.created_by])).length === 0;
}

/** 403 NOT_IN_ROOM {reason: 'demo_room'}: the demo room is for the demo players. */
export const demoRoomError = (message: string, details: Record<string, unknown> = {}) =>
  new HttpError('NOT_IN_ROOM', message, { reason: 'demo_room', ...details });
