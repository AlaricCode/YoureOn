// ESCROW §9.2 E3 (TM-E1, TM-E4), §9.1 "filter + webhook suite on transaction JSON captured from
// LiteSVM": a REAL mimic program (programs/escrow/test-programs/mimic: the escrow's BetFinalized
// struct under its own program ID) emits BetFinalized once through `emit_cpi!` and once through
// `emit!`. Both transactions are captured from LiteSVM into getBlock `json` shape and run through
// the production QuickNode filter (infra/quicknode/filter.js): it must forward 0 events. A real
// escrow transaction captured the same way is the positive control (the capture is faithful).
//
//   bash packages/shared/scripts/build-mimic.sh   # builds mimic.so (test fixture, never deployed)
//   E3_WRITE_FIXTURE=1 npm run test:escrow -w packages/shared
//        also rewrites infra/quicknode/fixtures/block-mimic-e3.json (checked by apps/server)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  AccountRole,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Decoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
  type Address,
  type Instruction,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';

import {
  BET_FINALIZED_EVENT_DISCRIMINATOR,
  BetStatus,
  ESCROW_PROGRAM_ADDRESS,
  findEventAuthorityPda,
  getBetFinalizedEventEncoder,
  Outcome,
} from '@youre-on/shared/escrow-client';
import {
  betId,
  buildTx,
  expectOk,
  HAVE_MIMIC,
  HAVE_SO,
  MIMIC_ID,
  MIMIC_SO,
  newEnv,
  submit,
  type Sent,
} from './harness';

const FILTER_JS = fileURLToPath(new URL('../../../../infra/quicknode/filter.js', import.meta.url));
const FIXTURE = fileURLToPath(
  new URL('../../../../infra/quicknode/fixtures/block-mimic-e3.json', import.meta.url),
);
const EVENT_IX_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];

type FilterOut = { txs: { events: { name: string | null }[] }[] } | null;
type Filter = { main(stream: unknown): FilterOut };

/** filter.js in a sandbox without the globals QuickNode's engine may lack (as apps/server does). */
function loadFilter(): Filter {
  const module = { exports: {} as Filter };
  runInNewContext(readFileSync(FILTER_JS, 'utf8'), {
    module,
    BigInt: undefined,
    atob: undefined,
    btoa: undefined,
    Buffer: undefined,
    TextDecoder: undefined,
    TextEncoder: undefined,
    require: undefined,
  });
  return module.exports;
}

function anchorIxDisc(name: string): Uint8Array {
  return sha256(utf8ToBytes(`global:${name}`)).slice(0, 8);
}

/** A landed LiteSVM tx as a getBlock `encoding: json` transaction (what QuickNode delivers). */
function toBlockJsonTx(sent: Sent) {
  const b58 = getBase58Decoder();
  const msg = getCompiledTransactionMessageDecoder().decode(sent.tx.messageBytes);
  if (msg.version === 1) throw new Error('the harness builds v0 messages only');
  const keys = msg.staticAccounts.map(String);
  const groups = sent.meta
    .innerInstructions()
    .map((inners, index) => ({
      index,
      instructions: inners.map((inner) => {
        const ix = inner.instruction();
        return {
          programIdIndex: ix.programIdIndex(),
          accounts: Array.from(ix.accounts()),
          data: b58.decode(ix.data()),
          stackHeight: inner.stackHeight(),
        };
      }),
    }))
    .filter((g) => g.instructions.length > 0);
  return {
    meta: {
      err: null,
      innerInstructions: groups,
      loadedAddresses: { writable: [], readonly: [] },
      logMessages: sent.meta.logs(),
      computeUnitsConsumed: Number(sent.meta.computeUnitsConsumed()),
    },
    transaction: {
      message: {
        accountKeys: keys,
        header: msg.header,
        instructions: msg.instructions.map((ix) => ({
          programIdIndex: ix.programAddressIndex,
          accounts: Array.from(ix.accountIndices ?? []),
          data: b58.decode(ix.data ?? new Uint8Array()),
          stackHeight: 1,
        })),
        recentBlockhash: String(msg.lifetimeToken),
      },
      signatures: [b58.decode(sent.meta.signature())],
    },
    version: 0,
  };
}

function blockOf(transactions: unknown[]) {
  return {
    data: [
      {
        blockHeight: 400_118_300,
        blockTime: 1_795_284_500,
        blockhash: '9TmP9DSp8AL7hBi3U6XC3sXq1YJ5LPHZwcgbnS45i4G',
        parentSlot: 519_807_200,
        previousBlockhash: '9TmP9DSp8AL7hBi3U6XC3sXq1YJ5LPHZwcgbnS45i4G',
        transactions,
      },
    ],
    metadata: { network: 'solana-devnet', dataset: 'block' },
  };
}

describe.skipIf(!HAVE_SO || !HAVE_MIMIC)(
  'E3: mimic program events (ESCROW §9.2, TS LiteSVM)',
  () => {
    it('BetFinalized via emit_cpi! and emit! from a mimic program: the production filter forwards 0 events', async () => {
      const env = await newEnv();
      env.svm.addProgramFromFile(MIMIC_ID, MIMIC_SO);
      const filter = loadFilter();
      const [escrowEa] = await findEventAuthorityPda();
      const [mimicEa] = await getProgramDerivedAddress({
        programAddress: MIMIC_ID,
        seeds: [getUtf8Encoder().encode('__event_authority')],
      });

      // A plausible payout for a bet that exists nowhere: exactly what a forger would want applied.
      const payload = getBetFinalizedEventEncoder().encode({
        betId: betId(7),
        finalStatus: BetStatus.Settled,
        outcome: Outcome.PartyA,
        mint: env.mint,
        partyA: env.a.address,
        partyB: env.b.address,
        partyAToken: env.aToken,
        partyBToken: env.bToken,
        toA: 10_000_000n,
        toB: 0n,
        ts: 1_800_000_000n,
        caller: env.s.address,
      });
      expect(Array.from(payload.slice(0, 8))).toEqual(
        Array.from(BET_FINALIZED_EVENT_DISCRIMINATOR),
      );

      const listed = [
        { address: ESCROW_PROGRAM_ADDRESS as Address, role: AccountRole.READONLY },
        { address: escrowEa, role: AccountRole.READONLY },
      ];
      // Args = borsh(BetFinalized) = the event bytes after the 8-byte event discriminator.
      const args = payload.slice(8);
      const viaCpi: Instruction = {
        programAddress: MIMIC_ID,
        accounts: [
          ...listed,
          { address: mimicEa, role: AccountRole.READONLY },
          { address: MIMIC_ID, role: AccountRole.READONLY },
        ],
        data: new Uint8Array([...anchorIxDisc('emit_via_cpi'), ...args]),
      };
      const viaLog: Instruction = {
        programAddress: MIMIC_ID,
        accounts: listed,
        data: new Uint8Array([...anchorIxDisc('emit_via_log'), ...args]),
      };

      const cpiTx = expectOk(submit(env.svm, await buildTx(env.svm, env.s, [viaCpi])));
      const logTx = expectOk(submit(env.svm, await buildTx(env.svm, env.s, [viaLog])));
      const bothTx = expectOk(submit(env.svm, await buildTx(env.svm, env.s, [viaCpi, viaLog])));

      // The capture really carries the forgery: an inner self-CPI with EVENT_IX_TAG ‖ BetFinalized
      // from the mimic, and a "Program data:" log line with the same bytes.
      const cpiJson = toBlockJsonTx(cpiTx);
      const inner = cpiJson.meta.innerInstructions[0]!.instructions[0]!;
      expect(cpiJson.transaction.message.accountKeys[inner.programIdIndex]).toBe(MIMIC_ID);
      expect(cpiJson.transaction.message.accountKeys).toContain(ESCROW_PROGRAM_ADDRESS);
      expect(cpiJson.transaction.message.accountKeys).toContain(escrowEa);
      expect(Array.from(getBase58Encoder().encode(inner.data))).toEqual([
        ...EVENT_IX_TAG,
        ...Array.from(payload),
      ]);
      const logJson = toBlockJsonTx(logTx);
      const programData = `Program data: ${getBase64Decoder().decode(payload)}`;
      expect(logJson.meta.logMessages).toContain(programData);
      expect(logJson.meta.innerInstructions).toEqual([]);
      const bothJson = toBlockJsonTx(bothTx);
      expect(bothJson.meta.logMessages).toContain(programData);

      const mimicBlock = blockOf([cpiJson, logJson, bothJson]);
      expect(filter.main(mimicBlock)).toBeNull();
      for (const tx of [cpiJson, logJson, bothJson]) expect(filter.main(blockOf([tx]))).toBeNull();

      // Positive control: the real escrow's initialize_config captured the same way IS forwarded,
      // and next to the mimic txs it is the only one.
      if (!env.init) throw new Error('newEnv did not initialize Config');
      const realJson = toBlockJsonTx(env.init);
      const out = filter.main(blockOf([cpiJson, realJson, logJson]));
      expect(out?.txs).toHaveLength(1);
      expect(out?.txs[0]?.events.map((e) => e.name)).toEqual(['ConfigInitialized']);

      if (process.env['E3_WRITE_FIXTURE'] === '1') {
        writeFileSync(FIXTURE, `${JSON.stringify(mimicBlock, null, 2)}\n`);
      }
    });
  },
);
