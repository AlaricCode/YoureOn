// rpc_poll decoding (src/chain/streams.ts eventsFromRpcTransaction), no DB: the reconciler's
// getTransaction copy of a tx must yield EXACTLY the rows a Stream delivery of the same tx yields
// (same dedup key, name, payload, bet_id), so whichever source stores it first, the other is a
// no-op. Parity is checked against infra/quicknode/filter.js on the same fixtures, including
// every ESCROW §7.1 rejection (failed tx, foreign program, forged authority, untagged data,
// top-level instruction) and keys behind an address lookup table.
import { describe, expect, it } from 'vitest';
import { ESCROW_ID } from '@youre-on/shared/chain/constants';
import { eventAuthorityAddress } from '../src/chain/filter-config';
import { isTxVersionParamError, rpcChainClient } from '../src/chain/tx';
import {
  eventsFromRpcTransaction,
  parseStreamDelivery,
  type RpcTransaction,
} from '../src/chain/streams';
import {
  block,
  encodeEvent,
  jsonTx,
  loadQnFilter,
  randomPubkey,
  randomSig,
  samplePayload,
} from './chain-fixtures';

/** A getBlock (json) tx as getTransaction returns it (normalized like rpcChainClient does). */
function asRpc(tx: ReturnType<typeof jsonTx>, slot = 519_807_091): RpcTransaction {
  return {
    signature: tx.transaction.signatures[0]!,
    slot,
    blockTime: 1_795_284_425,
    err: tx.meta.err,
    accountKeys: [
      ...tx.transaction.message.accountKeys,
      ...tx.meta.loadedAddresses.writable,
      ...tx.meta.loadedAddresses.readonly,
    ],
    innerInstructions: tx.meta.innerInstructions.map((g) => ({
      index: g.index,
      instructions: g.instructions.map(({ programIdIndex, accounts, data }) => ({
        programIdIndex,
        accounts,
        data,
      })),
    })),
  };
}

const viaStream = (tx: ReturnType<typeof jsonTx>) =>
  parseStreamDelivery(loadQnFilter().main({ data: [block([tx])] })).events;
const strip = (e: { block_height: unknown; tx_index: unknown; slot: unknown }) => ({
  ...e,
  block_height: null,
  tx_index: null,
  slot: null,
});

describe('eventsFromRpcTransaction = filter.js + parseStreamDelivery', () => {
  it('an atomic lock: the same two rows, with the slot set and no block position', async () => {
    const ea = await eventAuthorityAddress();
    const tx = jsonTx({
      eventAuthority: ea,
      events: [
        { outer: 3, bytes: encodeEvent('BetCreated', samplePayload('BetCreated')) },
        { outer: 4, bytes: encodeEvent('BetAccepted', samplePayload('BetAccepted')) },
      ],
    });
    const rpc = eventsFromRpcTransaction(asRpc(tx), ea).events;
    expect(rpc.map((e) => [e.event_name, e.outer_ix, e.inner_ix, e.slot, e.block_height])).toEqual([
      ['BetCreated', 3, 0, 519_807_091, null],
      ['BetAccepted', 4, 0, 519_807_091, null],
    ]);
    expect(rpc.map(strip)).toEqual(viaStream(tx).map(strip));
    expect(rpc.every((e) => e.apply_error === null && e.program_id === ESCROW_ID)).toBe(true);
  });

  it('matches the filter on every acceptance / rejection rule (ESCROW §7.1)', async () => {
    const ea = await eventAuthorityAddress();
    const ev = (name: string) => ({ outer: 1, bytes: encodeEvent(name, samplePayload(name)) });
    const cases = {
      lookupTable: jsonTx({
        eventAuthority: ea,
        events: [ev('BetFinalized')],
        viaLookupTable: true,
      }),
      several: jsonTx({
        eventAuthority: ea,
        events: [ev('BetConceded'), { ...ev('BetClosed'), outer: 2 }],
      }),
      failed: jsonTx({
        eventAuthority: ea,
        events: [ev('BetFinalized')],
        err: { InstructionError: [1, { Custom: 6000 }] },
      }),
      foreignProgram: jsonTx({
        eventAuthority: ea,
        events: [{ ...ev('BetFinalized'), program: randomPubkey() }],
      }),
      forgedAuthority: jsonTx({
        eventAuthority: ea,
        events: [{ ...ev('BetFinalized'), firstAccount: randomPubkey() }],
      }),
      untagged: jsonTx({ eventAuthority: ea, events: [{ ...ev('BetFinalized'), noTag: true }] }),
      topLevelOnly: jsonTx({
        eventAuthority: ea,
        events: [],
        topLevel: encodeEvent('BetFinalized', samplePayload('BetFinalized')),
      }),
    };
    const counts: Record<string, number> = {};
    for (const [label, tx] of Object.entries(cases)) {
      const rpc = eventsFromRpcTransaction(asRpc(tx), ea).events;
      expect(rpc.map(strip), label).toEqual(viaStream(tx).map(strip));
      counts[label] = rpc.length;
    }
    expect(counts).toEqual({
      lookupTable: 1,
      several: 2,
      failed: 0,
      foreignProgram: 0,
      forgedAuthority: 0,
      untagged: 0,
      topLevelOnly: 0,
    });
  });

  it('rpcChainClient.transaction: normalizes getTransaction, falls back to version 0 once', async () => {
    const ea = await eventAuthorityAddress();
    const tx = jsonTx({
      eventAuthority: ea,
      events: [{ outer: 2, bytes: encodeEvent('BetResolved', samplePayload('BetResolved')) }],
      viaLookupTable: true,
    });
    const asked: unknown[] = [];
    let reject1 = true;
    const rpc = {
      getTransaction: (_sig: string, cfg: { maxSupportedTransactionVersion: number }) => ({
        send: async () => {
          asked.push(cfg.maxSupportedTransactionVersion);
          if (cfg.maxSupportedTransactionVersion === 1 && reject1)
            throw Object.assign(new Error('Invalid params: maxSupportedTransactionVersion'), {
              context: { __code: -32602 },
            });
          return {
            slot: 519_807_091n,
            blockTime: 1_795_284_425n,
            meta: tx.meta,
            transaction: tx.transaction,
          };
        },
      }),
      getBlock: (slot: bigint, cfg: { transactionDetails: string; rewards: boolean }) => ({
        send: async () => {
          expect([slot, cfg.transactionDetails, cfg.rewards]).toEqual([
            519_807_091n,
            'none',
            false,
          ]);
          if (blockGone) throw new Error('Block not available for slot');
          return { blockHeight: 400_118_207n, blockTime: 1_795_284_425n };
        },
      }),
    };
    let blockGone = false;
    const client = rpcChainClient('https://rpc.example', rpc as never);
    const got = (await client.transaction!(tx.transaction.signatures[0]!))!;
    expect(asked).toEqual([1, 0]);
    expect(got).toEqual({ ...asRpc(tx), blockHeight: 400_118_207 });
    // the rows carry the block height (attribution orders by it), not a tx index
    expect(
      eventsFromRpcTransaction(got, ea).events.map((e) => [
        e.event_name,
        e.block_height,
        e.tx_index,
        e.slot,
      ]),
    ).toEqual([['BetResolved', 400_118_207, null, 519_807_091]]);
    // no block (pruned / skipped): still usable, just without a height
    blockGone = true;
    expect((await client.transaction!(tx.transaction.signatures[0]!))!.blockHeight).toBeNull();
    blockGone = false;
    // a block without a height (the RPC type allows null) is unknown, never height 0
    const nullHeight = rpcChainClient('https://rpc.example', {
      ...rpc,
      getBlock: () => ({ send: async () => ({ blockHeight: null }) }),
    } as never);
    expect((await nullHeight.transaction!(tx.transaction.signatures[0]!))!.blockHeight).toBeNull();
    asked.splice(3); // forget that second client's calls (it has its own version memory)
    // remembered: the next call goes straight to 0
    reject1 = false;
    await client.transaction!(tx.transaction.signatures[0]!);
    expect(asked).toEqual([1, 0, 0, 0]);
    // any other RPC error is not swallowed
    const failing = rpcChainClient('https://rpc.example', {
      getTransaction: () => ({
        send: async () => {
          throw new Error('fetch failed');
        },
      }),
    } as never);
    await expect(failing.transaction!(randomSig())).rejects.toThrow(/fetch failed/);
    // only an invalid-params error about the version parameter downgrades the client
    expect(isTxVersionParamError(new Error('Invalid params: bad signature'))).toBe(false);
    expect(
      isTxVersionParamError(
        Object.assign(new Error('JSON-RPC error'), {
          context: { __code: -32602, __serverMessage: 'invalid maxSupportedTransactionVersion' },
        }),
      ),
    ).toBe(true);
    expect(isTxVersionParamError(new Error('429 Too Many Requests'))).toBe(false);
  });

  it('skips undecodable base58 data instead of throwing', async () => {
    const ea = await eventAuthorityAddress();
    const tx = asRpc(jsonTx({ eventAuthority: ea, events: [] }));
    const bad: RpcTransaction = {
      ...tx,
      signature: randomSig(),
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              programIdIndex: tx.accountKeys.indexOf(ESCROW_ID),
              accounts: [tx.accountKeys.indexOf(ea)],
              data: '0OIl', // not base58
            },
          ],
        },
      ],
    };
    expect(eventsFromRpcTransaction(bad, ea).events).toEqual([]);
  });
});
