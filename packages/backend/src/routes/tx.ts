/**
 * §12.1 / §12.3 `POST /tx/:tx_id/submit {signature_b64}` (implemented).
 */
import { bodyObject, currentUser, param, type RouteModule } from './util.js';

export const txRoutes: RouteModule = (app, ctx) => {
  app.post('/v1/tx/:tx_id/submit', async (req) => {
    const user = currentUser(ctx, req);
    return ctx.txs.submit(param(req, 'tx_id'), user.id, bodyObject(req));
  });
};
