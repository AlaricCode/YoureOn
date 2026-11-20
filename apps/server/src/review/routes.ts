// The spoken review request (./service.ts):
//   POST /el/tools/request_review          ElevenLabs webhook tool, secret header (./tool.ts)
//   POST /v1/bets/:bet_id/review/decline   (S, the loser) "Keep ruling" -> 200 {status:'closed'}
//                                          (idempotent; NOT_LOSER for anyone else)
//   POST /v1/demo/bets/:bet_id/review      (demo key) the laptop fallback: the same request with
//                                          source 'demo', no voice needed (stage / phones QA)
//                                          -> 200 {ok:true, say, review} | 409 {ok:false, fix, say}
// Confirming a review is the normal appeal: GET/POST /v1/bets/:bet_id/appeal (appeal/routes.ts),
// signed on the loser's phone (device policy 'appeal'). Nothing here spends the 3/h appeal bucket.
// Spec: docs/planning/API-CONTRACT.md §2.12a.
import type { RouteModule } from '../context';
import { appAuth, requireSignedRequest } from '../auth/middleware';
import { requireDemo } from '../demo/routes';
import { betIdParam } from '../lock/routes';
import { lifecycleOf } from '../lock/runtime';
import { ToolState } from '../voice/tools';
import { appealsLeftOf, requestReviewHandler, reviewReply } from './tool';

export function createReviewRoutes(o: { state?: ToolState } = {}): RouteModule {
  return {
    name: 'review',
    register(app) {
      app.post(
        '/el/tools/request_review',
        requestReviewHandler({ state: o.state ?? new ToolState() }),
      );

      app.post('/v1/bets/:bet_id/review/decline', requireSignedRequest, async (c) => {
        const me = appAuth(c);
        const res = await lifecycleOf(c.get('deps')).review.decline(
          betIdParam(c.req.param('bet_id')),
          me.user_id,
        );
        return c.json(res, 200);
      });

      app.post('/v1/demo/bets/:bet_id/review', requireDemo, async (c) => {
        const deps = c.get('deps');
        const r = await lifecycleOf(deps).review.request(betIdParam(c.req.param('bet_id')), {
          source: 'demo',
          heard: 'demo',
          requestId: c.get('requestId'),
          appealsLeft: appealsLeftOf(deps),
        });
        const body = reviewReply(r);
        return c.json(r.ok ? { ...body, review: r.review } : body, r.ok ? 200 : 409);
      });
    },
  };
}

export const reviewRoutes = createReviewRoutes();
