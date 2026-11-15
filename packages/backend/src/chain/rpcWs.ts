/**
 * §12.5 `CHAIN_EVENTS_SOURCE=rpc_ws`: Solana `logsSubscribe` (mentions =
 * VERDICT_PROGRAM_ID) feeding the same idempotent handler as QuickNode, so
 * devnet works without a QuickNode account. Failed transactions are skipped;
 * events are indexed per transaction in log order (as the QuickNode filter
 * does). The subscription is re-established with backoff if the RPC socket
 * drops (web3.js reconnects the socket; we re-subscribe if it throws).
 */
import { PublicKey, type Commitment, type Context, type Logs } from '@solana/web3.js';
import type { ChainEventHandler } from './events.js';
import { parseProgramLogs } from './devnet.js';
import type { ChainEventEnvelope } from './types.js';

/** The part of `@solana/web3.js` Connection this source uses (injectable for tests). */
export interface LogsConnection {
  onLogs(filter: PublicKey, callback: (logs: Logs, ctx: Context) => void, commitment?: Commitment): number;
  removeOnLogsListener(id: number): Promise<void>;
}

export interface RpcWsSourceOptions {
  connection: LogsConnection;
  programId: string;
  handler: Pick<ChainEventHandler, 'handleEnvelopes'>;
  commitment?: Commitment;
  log?: { warn: (o: unknown, msg?: string) => void; error: (o: unknown, msg?: string) => void };
  /** called after each observed Verdict transaction (e.g. re-read Bet accounts, §9.5) */
  onTransaction?: (signature: string, envelopes: ChainEventEnvelope[]) => void | Promise<void>;
}

export interface RpcWsSource {
  readonly subscriptionId: number | null;
  /** resolves when every delivered notification has been handled */
  idle(): Promise<void>;
  stop(): Promise<void>;
}

/** Converts one logs notification into handler envelopes (empty for failed txs / no events). */
export function envelopesFromLogs(logs: Logs, slot: number, programId: string): ChainEventEnvelope[] {
  if (logs.err) return [];
  return parseProgramLogs(logs.logs, programId).map((event, index) => ({
    signature: logs.signature,
    slot,
    block_time: null,
    index,
    event,
  }));
}

export function startRpcWsSource(o: RpcWsSourceOptions): RpcWsSource {
  let id: number | null = null;
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();
  const commitment = o.commitment ?? 'confirmed';

  const onLogs = (logs: Logs, ctx: Context) => {
    const envs = envelopesFromLogs(logs, ctx.slot, o.programId);
    if (envs.length === 0) return;
    chain = chain
      .then(async () => {
        await o.handler.handleEnvelopes(envs);
        await o.onTransaction?.(logs.signature, envs);
      })
      .catch((e: unknown) => o.log?.error({ err: e, signature: logs.signature }, 'rpc_ws: event handling failed'));
  };

  const subscribe = (attempt: number) => {
    if (stopped) return;
    try {
      id = o.connection.onLogs(new PublicKey(o.programId), onLogs, commitment);
    } catch (e) {
      o.log?.warn({ err: e, attempt }, 'rpc_ws: logsSubscribe failed; retrying');
      const t = setTimeout(() => subscribe(attempt + 1), Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)));
      t.unref?.();
    }
  };
  subscribe(0);

  return {
    get subscriptionId() {
      return id;
    },
    idle: () => chain,
    async stop() {
      stopped = true;
      if (id !== null) {
        const x = id;
        id = null;
        try {
          await o.connection.removeOnLogsListener(x);
        } catch (e) {
          o.log?.warn({ err: e }, 'rpc_ws: unsubscribe failed');
        }
      }
      await chain;
    },
  };
}
