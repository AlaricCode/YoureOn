/**
 * Receipt routes (§12.11) — owned by booth-world-events:
 *   GET /bets/:id/receipt    {rows: ReceiptRow[]}
 *   GET /bets/:id/terms.yaml the bet's YAML (Terms row `yaml_url`; canonical
 *                            engine.toYaml when the mirror has no surface YAML)
 * Also registers the per-bet chain event log the rows link to.
 */
import { decodeBuffer } from '../booth/exhibits.js';
import type { AppContext } from '../context.js';
import { ApiError } from '../errors.js';
import { betSources, nameOfWallet, userByWallet } from '../integration/sources.js';
import { EventLog } from '../receipt/eventLog.js';
import { buildReceipt, type ReceiptRow } from '../receipt/rows.js';
import { isPubkey } from '../util/bytes.js';
import { toYaml } from '@verdict/engine';
import { param, type RouteModule } from './util.js';

const logs = new WeakMap<AppContext, EventLog>();

export function eventLog(ctx: AppContext): EventLog {
  let l = logs.get(ctx);
  if (!l) {
    l = new EventLog(ctx);
    logs.set(ctx, l);
  }
  return l;
}

/** Solana explorer links (devnet); null in mock mode (§12.11). */
export function explorer(ctx: AppContext) {
  const on = ctx.config.solanaMode === 'devnet';
  return {
    tx: (sig: string | null | undefined): string | null => (on && sig ? `https://explorer.solana.com/tx/${sig}?cluster=devnet` : null),
    account: (a: string): string | null => (on ? `https://explorer.solana.com/address/${a}?cluster=devnet` : null),
  };
}

export async function receiptRows(ctx: AppContext, betId: string): Promise<ReceiptRow[]> {
  const bet = await ctx.chain.getBet(betId);
  if (!bet) throw new ApiError('NOT_FOUND');
  const src = betSources(ctx);
  const buffer = await ctx.chain.getTrackBuffer(betId);
  const ex = explorer(ctx);
  return buildReceipt({
    betId,
    bet,
    trackFlags: decodeBuffer(bet, buffer).flags,
    artifacts: await src.artifacts(betId, bet),
    witnesses: src.witnesses(betId),
    chunks: (k) => src.chunks(betId, k),
    perception: src.perception(betId),
    acceptances: src.acceptances(betId),
    events: eventLog(ctx).of(betId),
    nameOf: (w) => nameOfWallet(ctx, w),
    userIdOf: (w) => userByWallet(ctx, w)?.id ?? null,
    txUrl: ex.tx,
    accountUrl: ex.account,
    yamlUrl: `${ctx.config.publicUrl}/v1/bets/${betId}/terms.yaml`,
  });
}

export const receiptRoutes: RouteModule = (app, ctx) => {
  eventLog(ctx).register();

  app.get('/v1/bets/:id/receipt', async (req) => {
    const id = param(req, 'id');
    if (!isPubkey(id)) throw new ApiError('NOT_FOUND');
    return { rows: await receiptRows(ctx, id) };
  });

  app.get('/v1/bets/:id/terms.yaml', async (req, reply) => {
    const id = param(req, 'id');
    if (!isPubkey(id)) throw new ApiError('NOT_FOUND');
    const bet = await ctx.chain.getBet(id);
    if (!bet) throw new ApiError('NOT_FOUND');
    const a = await betSources(ctx).artifacts(id, bet);
    if (!a) throw new ApiError('NOT_FOUND', 'terms not available');
    return reply.header('content-type', 'text/yaml; charset=utf-8').send(a.yaml ?? toYaml(a.program));
  });
};
