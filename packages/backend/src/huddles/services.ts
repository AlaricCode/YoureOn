/**
 * One instance per AppContext of the identity / huddle / drafts services,
 * shared by the route modules and by other services (bets: `prepareCreateBet`;
 * perception/booth: `identity.vault.template(...)` for proofs and fusion).
 */
import type { AppContext } from '../context.js';
import { prepareCreateBet, type PreparedCreateBet } from '../drafts/createBet.js';
import { DraftService } from '../drafts/service.js';
import { IdentityService } from '../identity/service.js';
import type { UserRecord } from '../persistence/records.js';
import { HuddleService } from './service.js';

export interface IdentityHuddleServices {
  huddles: HuddleService;
  identity: IdentityService;
  drafts: DraftService;
  /** create_bet sign payload for an accepted draft (used by POST /bets). */
  createBet(user: UserRecord, draftId: string): Promise<PreparedCreateBet>;
}

const cache = new WeakMap<AppContext, IdentityHuddleServices>();

export function identityHuddleServices(ctx: AppContext): IdentityHuddleServices {
  let s = cache.get(ctx);
  if (s) return s;
  const huddles = new HuddleService(ctx.store, ctx.clock);
  const identity = new IdentityService(ctx, huddles);
  const drafts = new DraftService(ctx, huddles, identity);
  huddles.onChange((h) => ctx.hub.publish(`huddle:${h.id}`, { type: 'huddle', huddle: huddles.view(h) }));
  // WS snapshot on subscribe to huddle:<id> (members only): the huddle, then its drafts.
  ctx.hub.setSnapshotProvider('huddle', (id, userId) => {
    const h = huddles.requireForMember(id, userId);
    return [
      { type: 'huddle', huddle: huddles.view(h) },
      ...drafts.draftsOf(h.id).map((d) => ({ type: 'draft' as const, huddle_id: h.id, draft: drafts.view(d) })),
    ];
  });
  ctx.hooks.compileTool = (body) => drafts.compileTool(body);
  s = { huddles, identity, drafts, createBet: (user, draftId) => prepareCreateBet(ctx, drafts, user, draftId) };
  cache.set(ctx, s);
  return s;
}
