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
  huddles.onChange((h) => {
    ctx.hub.publish(`huddle:${h.id}`, { type: 'huddle', huddle: huddles.view(h) });
    // Members confirmed since they subscribed now get the current draft (drafts are confirmed-only).
    const latest = drafts.draftsOf(h.id)[0];
    if (latest) {
      const msg = { type: 'draft' as const, huddle_id: h.id, draft: drafts.view(latest) };
      void ctx.hub.publishPerUser(`huddle:${h.id}`, (userId) => (h.members.some((m) => m.user_id === userId && m.confirmed) ? msg : null));
    }
  });
  // WS snapshot on subscribe to huddle:<id> (members only): the huddle, then — for
  // confirmed members only — its drafts.
  ctx.hub.setSnapshotProvider('huddle', (id, userId) => {
    const h = huddles.requireForMember(id, userId);
    const confirmed = h.members.some((m) => m.user_id === userId && m.confirmed);
    return [
      { type: 'huddle', huddle: huddles.view(h) },
      ...(confirmed ? drafts.draftsOf(h.id).map((d) => ({ type: 'draft' as const, huddle_id: h.id, draft: drafts.view(d) })) : []),
    ];
  });
  ctx.hooks.compileTool = (body) => drafts.compileTool(body);
  s = { huddles, identity, drafts, createBet: (user, draftId) => prepareCreateBet(ctx, drafts, user, draftId) };
  cache.set(ctx, s);
  return s;
}
