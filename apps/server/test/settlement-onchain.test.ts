// markets/onchain.ts without a chain: the resolve args decoded from a real (built, signed)
// resolve transaction, and the RPC client's transactionBytes over a fake RPC. The Bet-account and
// closed-account paths against the real program are in gemini-e2e.test.ts (LiteSVM).
import { describe, expect, it } from 'vitest';
import {
  generateKeyPairSigner,
  getBase64Decoder,
  getTransactionEncoder,
  type Base64EncodedWireTransaction,
} from '@solana/kit';
import {
  ESCROW_PROGRAM_ADDRESS,
  findBetPda,
  getResolveInstructionAsync,
  Outcome,
} from '@youre-on/shared/escrow-client';
import { betIdToBytes } from '@youre-on/shared/primitives';
import { buildBlockhashTx, rpcChainClient, type ChainClient } from '../src/chain/tx';
import { resolveArgsOf } from '../src/markets/onchain';

const BET = '2f1c0b6e-6f43-4d0f-9b9b-1a1b2c3d4e5f';
const EVIDENCE = 'ab'.repeat(32);
const RULING = 'cd'.repeat(32);

const offline: ChainClient = {
  label: 'offline',
  assertSafeCluster: async () => 'localnet',
  latestBlockhash: async () => ({
    blockhash: 'SysvarC1ock11111111111111111111111111111111',
    lastValidBlockHeight: 100n,
  }),
  simulate: async () => ({ err: null, unitsConsumed: 5_000n, logs: [] }),
  send: async () => {},
  signatureStatus: async () => null,
  blockHeight: async () => 0n,
  getAccount: async () => null,
  tokenBalanceByOwner: async () => 0n,
  lamports: async () => 0n,
};

async function resolveWire(betId: string) {
  const payer = await generateKeyPairSigner();
  const judge = await generateKeyPairSigner();
  const [bet] = await findBetPda({ betId: betIdToBytes(betId) });
  const ix = await getResolveInstructionAsync({
    payer,
    judgeAuthority: judge,
    bet,
    outcome: Outcome.PartyB,
    evidenceHash: Buffer.from(EVIDENCE, 'hex'),
    rulingHash: Buffer.from(RULING, 'hex'),
  });
  // [SetComputeUnitLimit, resolve], signed by the fee payer and the judge: the server's own tx
  const built = await buildBlockhashTx(offline, payer.address, [ix], {
    signers: [payer, judge],
    label: 'resolve',
  });
  return { wire: new Uint8Array(getTransactionEncoder().encode(built.tx)), bet };
}

describe('resolveArgsOf (a closed Bet: read the resolve tx itself)', () => {
  it('decodes evidence_hash / ruling_hash of the escrow resolve ix for this bet', async () => {
    const { wire, bet } = await resolveWire(BET);
    expect(resolveArgsOf(wire, ESCROW_PROGRAM_ADDRESS, bet)).toEqual({
      evidence_hash: EVIDENCE,
      ruling_hash: RULING,
    });
  });

  it('is null for another bet, another program, or a tx without resolve', async () => {
    const { wire } = await resolveWire(BET);
    const [other] = await findBetPda({
      betId: betIdToBytes('7e3a1f00-0000-4000-8000-000000000001'),
    });
    expect(resolveArgsOf(wire, ESCROW_PROGRAM_ADDRESS, other)).toBeNull();
    const { wire: w2, bet } = await resolveWire(BET);
    expect(resolveArgsOf(w2, 'ComputeBudget111111111111111111111111111111', bet)).toBeNull();
    const payer = await generateKeyPairSigner();
    const plain = await buildBlockhashTx(offline, payer.address, [], {
      signers: [payer],
      label: 'empty',
    });
    expect(
      resolveArgsOf(
        new Uint8Array(getTransactionEncoder().encode(plain.tx)),
        ESCROW_PROGRAM_ADDRESS,
        bet,
      ),
    ).toBeNull();
  });
});

describe('rpcChainClient.transactionBytes', () => {
  const rpcWith = (res: unknown, seen: unknown[] = []) =>
    ({
      getTransaction: (sig: string, cfg: unknown) => {
        seen.push([sig, cfg]);
        return { send: async () => res };
      },
    }) as never;

  it('returns the wire bytes of a confirmed, successful tx (base64, v0)', async () => {
    const { wire } = await resolveWire(BET);
    const seen: unknown[] = [];
    const b64 = getBase64Decoder().decode(wire) as Base64EncodedWireTransaction;
    const c = rpcChainClient(
      'https://rpc.example',
      rpcWith({ transaction: [b64, 'base64'], meta: { err: null } }, seen),
    );
    expect(await c.transactionBytes!('sig1')).toEqual(wire);
    expect(seen).toEqual([
      ['sig1', { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
    ]);
  });

  it('is null for an unknown or a failed tx', async () => {
    expect(
      await rpcChainClient('https://rpc.example', rpcWith(null)).transactionBytes!('s'),
    ).toBeNull();
    const failed = rpcWith({
      transaction: ['AA==', 'base64'],
      meta: { err: { InstructionError: [1, { Custom: 6023 }] } },
    });
    expect(await rpcChainClient('https://rpc.example', failed).transactionBytes!('s')).toBeNull();
  });
});
