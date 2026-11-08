/**
 * §12.3 auth routes (implemented):
 *   GET  /auth/nonce        → {nonce}
 *   POST /auth/email/start  {email} → {sent: true}   (mock code 000000)
 *   POST /auth/session      {provider, credential, email_code?, wallet, nonce, wallet_sig_b64} → {token, user}
 *   GET  /me                → UserView
 */
import { userView } from '../persistence/records.js';
import { bodyObject, currentUser, type RouteModule } from './util.js';

export const authRoutes: RouteModule = (app, ctx) => {
  app.get('/v1/auth/nonce', async () => ({ nonce: ctx.auth.issueNonce() }));

  app.post('/v1/auth/email/start', async (req) => ctx.auth.startEmail(bodyObject(req)['email']));

  app.post('/v1/auth/session', async (req) => {
    const { token, user } = await ctx.auth.createSession(bodyObject(req));
    return { token, user: userView(user) };
  });

  app.get('/v1/me', async (req) => userView(currentUser(ctx, req)));
};
