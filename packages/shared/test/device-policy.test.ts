// Device signing policy: ESCROW §9.2 rows A13 and DP1-DP16, plus one negative case per
// API-CONTRACT §6.3 rule (G1-G7, L1-L5, T1-T3). Pure TS, no validator: these are the phone-side
// checks on the exact message bytes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  address,
  createAddressWithSeed,
  getTransactionEncoder,
  signBytes,
  verifySignature,
  type SignatureBytes,
  type Transaction,
} from '@solana/kit';
import { bytesToHex } from '@noble/hashes/utils.js';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  ESCROW_ID,
  NONCE_SEED_PREFIX,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT_DEVNET,
} from '../src/chain/constants';
import {
  anchorDiscriminator,
  assertDevicePolicy,
  checkDevicePolicy,
  DEVICE_POLICY_PINS,
  DevicePolicyError,
  ESCROW_IX_ACCOUNTS,
  expectedKind,
  noncePoolAddresses,
  type DevicePolicyInput,
  type DevicePolicyRule,
  type LockPolicyInput,
  type SignPolicyInput,
} from '../src/device-policy';
import {
  acceptBetIx,
  advanceNonce,
  appealParts,
  ataCreate,
  authorizeRequest,
  cancelOpenBetIx,
  card,
  closeBetIx,
  compile,
  concedeParts,
  createWorld,
  cuLimit,
  cuPrice,
  heapFrame,
  lockParts,
  otherProgramIx,
  OTHER_BET,
  RULING_HASH,
  signRequest,
  SKILL_BET,
  splIx,
  standardLock,
  type World,
} from './device-policy.fixtures';
import { skillTerms } from './fixtures';

let W: World;
beforeAll(async () => {
  W = await createWorld();
});

const IDL = JSON.parse(
  readFileSync(fileURLToPath(new URL('../idl/escrow.json', import.meta.url)), 'utf8'),
) as { instructions: { name: string; discriminator: number[]; accounts: { name: string }[] }[] };

// ---- input helpers ----------------------------------------------------------------------

const lockInput = (
  request: unknown,
  me: 'A' | 'B',
  o: Partial<LockPolicyInput> = {},
): LockPolicyInput => ({
  screen: 'terms_card',
  lockMode: 'atomic',
  request,
  devicePubkey: me === 'A' ? W.A.address : W.B.address,
  nowSecs: W.NOW,
  derive: W.derive,
  pins: W.pins,
  ...o,
});

/** A lock message + its AuthorizeRequest for the given instruction list. */
const lock = (
  ixs: Parameters<typeof compile>[0],
  deadline: number,
  o: {
    env?: World['skill'];
    feePayer?: string;
    req?: Record<string, unknown>;
    lookups?: boolean;
  } = {},
) => {
  const message = compile(ixs, o.feePayer ?? W.fee.address, { lookups: o.lookups ?? false });
  return { message, request: authorizeRequest(o.env ?? W.skill, message, deadline, o.req) };
};

const cleanLock = () => {
  const p = lockParts(W);
  return lock(standardLock(p), p.deadline);
};

const signInput = (
  request: unknown,
  screen: 'gg' | 'appeal',
  o: Partial<SignPolicyInput> = {},
): SignPolicyInput => ({
  screen,
  request,
  devicePubkey: W.B.address,
  nowSecs: W.NOW,
  derive: W.derive,
  pins: W.pins,
  renderedCard: card(W),
  verifiedRulingHash: RULING_HASH,
  // By default the phone verified the same outcome the request carries; tests override it.
  verifiedRulingOutcome: String(
    (request as { ruling_ref?: { outcome?: unknown } } | null)?.ruling_ref?.outcome ?? '',
  ),
  ...o,
});

const concede = (
  ixs: Parameters<typeof compile>[0],
  o: { feePayer?: string; req?: Record<string, unknown>; lookups?: boolean } = {},
) => {
  const message = compile(ixs, o.feePayer ?? W.fee.address, { lookups: o.lookups ?? false });
  return { message, request: signRequest(W, 'concede', message, o.req) };
};
const cleanConcedeIxs = () => {
  const c = concedeParts(W);
  return [c.limit, c.ata, c.concede, c.close];
};

function expectPass(message: Uint8Array, input: DevicePolicyInput) {
  const v = checkDevicePolicy(message, input);
  expect(v, v.ok ? '' : `${v.rule}: ${v.reason}`).toMatchObject({ ok: true });
  return v;
}

function expectReject(message: Uint8Array, input: DevicePolicyInput, rule?: DevicePolicyRule) {
  const v = checkDevicePolicy(message, input);
  expect(v.ok, 'policy must refuse').toBe(false);
  if (!v.ok && rule) expect(`${v.rule}: ${v.reason}`).toMatch(new RegExp(`^${rule}:`));
  return v;
}

/** Both phones run the lock policy on the same bytes; both must refuse. */
function expectBothReject(
  m: { message: Uint8Array; request: unknown },
  rule?: DevicePolicyRule,
  o: Partial<LockPolicyInput> = {},
) {
  expectReject(m.message, lockInput(m.request, 'A', o), rule);
  expectReject(m.message, lockInput(m.request, 'B', o), rule);
}

// ---- layout / pins ----------------------------------------------------------------------

describe('layout pins', () => {
  it('create_bet / accept_bet discriminators and account order match idl/escrow.json', () => {
    for (const ix of IDL.instructions) {
      const layout = ESCROW_IX_ACCOUNTS[ix.name as keyof typeof ESCROW_IX_ACCOUNTS];
      if (!layout) continue;
      expect(bytesToHex(anchorDiscriminator(ix.name))).toBe(
        bytesToHex(Uint8Array.from(ix.discriminator)),
      );
      expect(ix.accounts.map((a) => a.name)).toEqual(layout);
    }
    const inIdl = IDL.instructions.map((i) => i.name);
    expect(inIdl).toEqual(expect.arrayContaining(['create_bet', 'accept_bet']));
  });

  it('nonce pool = Kit createAddressWithSeed(fee payer, "yo-nonce-<k>", System), k < 16', async () => {
    const pool = noncePoolAddresses(W.fee.address);
    expect(pool).toHaveLength(16);
    for (const k of [0, 7, 15]) {
      const kit = await createAddressWithSeed({
        baseAddress: address(W.fee.address),
        programAddress: address(SYSTEM_PROGRAM_ID),
        seed: `${NONCE_SEED_PREFIX}${k}`,
      });
      expect(pool[k]).toBe(kit);
    }
  });

  it('production pins are the compiled constants; an unpinned fee payer rejects everything (G1)', () => {
    expect(DEVICE_POLICY_PINS).toMatchObject({
      programId: ESCROW_ID,
      mint: USDC_MINT_DEVNET,
      tokenProgram: TOKEN_PROGRAM_ID,
      cluster: 'devnet',
    });
    const m = cleanLock();
    expectReject(
      m.message,
      lockInput(m.request, 'A', { pins: { ...W.pins, feePayer: null } }),
      'G1',
    );
  });

  it('expectedKind comes from the UI state', () => {
    expect(expectedKind('terms_card', 'atomic', 'A')).toBe('atomic_lock');
    expect(expectedKind('terms_card', 'sequential', 'A')).toBe('create_bet');
    expect(expectedKind('terms_card', 'sequential', 'B')).toBe('accept_bet');
    expect(expectedKind('gg', 'atomic', 'B')).toBe('concede');
    expect(expectedKind('appeal', 'atomic', 'B')).toBe('appeal');
  });
});

// ---- DP1-DP16: atomic lock --------------------------------------------------------------

describe('atomic_lock (DP1-DP16)', () => {
  it('DP1: the clean lock signs on both phones; both signatures verify over the same bytes; the wire carries them', async () => {
    const { message, request } = cleanLock();
    const va = expectPass(message, lockInput(request, 'A'));
    const vb = expectPass(message, lockInput(request, 'B'));
    expect(va).toMatchObject({ kind: 'atomic_lock', party: 'A', terms_hash: W.skill.terms_hash });
    expect(vb).toMatchObject({ kind: 'atomic_lock', party: 'B' });

    const sigA = await signBytes(W.A.kp.privateKey, message);
    const sigB = await signBytes(W.B.kp.privateKey, message);
    expect(await verifySignature(W.A.kp.publicKey, sigA, message)).toBe(true);
    expect(await verifySignature(W.B.kp.publicKey, sigB, message)).toBe(true);
    const sigFee = await signBytes(W.fee.kp.privateKey, message);
    const tx = {
      messageBytes: message,
      signatures: {
        [W.fee.address]: sigFee,
        [W.A.address]: sigA,
        [W.B.address]: sigB,
      } as Record<string, SignatureBytes>,
    } as unknown as Transaction;
    const wire = Uint8Array.from(getTransactionEncoder().encode(tx));
    expect(wire[0]).toBe(3);
    expect(bytesToHex(wire.subarray(1 + 3 * 64))).toBe(bytesToHex(message));
  });

  it('DP1: without SetComputeUnitPrice ([nonce, limit, create, accept]) also signs', () => {
    const p = lockParts(W);
    const m = lock([p.nonce, p.limit, p.create, p.accept], p.deadline);
    expectPass(m.message, lockInput(m.request, 'A'));
    expectPass(m.message, lockInput(m.request, 'B'));
  });

  it('DP1 (gemini): a lock at unix(quotedAt) + 60 signs', () => {
    const p = lockParts(W, W.gemini);
    const m = lock(standardLock(p), p.deadline, { env: W.gemini });
    expectPass(m.message, lockInput(m.request, 'A', { nowSecs: W.GEMINI_NOW }));
    expectPass(m.message, lockInput(m.request, 'B', { nowSecs: W.GEMINI_NOW }));
  });

  it('DP2: AdvanceNonceAccount not at ix 0, or missing', () => {
    const p = lockParts(W);
    expectBothReject(lock([p.limit, p.nonce, p.price, p.create, p.accept], p.deadline), 'L1');
    expectBothReject(lock([p.limit, p.price, p.create, p.accept], p.deadline), 'L1');
  });

  it('DP3: two AdvanceNonceAccount ixs', () => {
    const p = lockParts(W);
    const second = advanceNonce(W.pool[3]!, W.fee.address);
    expectBothReject(lock([p.nonce, second, p.limit, p.create, p.accept], p.deadline), 'L1');
  });

  it('DP4: nonce account outside the pool; k = 16; != nonce_index', () => {
    const outside = lockParts(W, W.skill, { nonce: W.other.address });
    expectBothReject(lock(standardLock(outside), outside.deadline), 'L2');
    const k16 = lockParts(W, W.skill, { nonce: W.pool[16]! });
    expectBothReject(lock(standardLock(k16), k16.deadline), 'L2');
    const otherIndex = lockParts(W, W.skill, { nonce: W.pool[5]! });
    expectBothReject(lock(standardLock(otherIndex), otherIndex.deadline), 'L2');
  });

  it("DP5: nonce authority != S; = the device key; = the other party's key", () => {
    for (const auth of [W.other.address, W.A.address, W.B.address]) {
      const p = lockParts(W, W.skill, { nonceAuthority: auth });
      expectBothReject(lock(standardLock(p), p.deadline));
    }
    const a = lockParts(W, W.skill, { nonceAuthority: W.A.address });
    expectBothReject(lock(standardLock(a), a.deadline), 'L2');
  });

  it('DP7: only create_bet; only accept_bet; [accept, create]; a third escrow ix; extra Transfer / Memo / ATA create', () => {
    const p = lockParts(W);
    const d = p.deadline;
    expectBothReject(lock([p.nonce, p.limit, p.create], d));
    expectBothReject(lock([p.nonce, p.limit, p.accept], d));
    expectBothReject(lock([p.nonce, p.limit, p.accept, p.create], d), 'L1');
    const cancel = cancelOpenBetIx(W.fee.address, p.createAccts.bet);
    expectBothReject(lock([...standardLock(p), cancel], d), 'L1');
    const close = closeBetIx({
      payer: W.fee.address,
      bet: p.createAccts.bet,
      vault: p.createAccts.vault,
      mint: USDC_MINT_DEVNET,
      party_a_token: W.atas[W.A.address]!,
      rent_payer: W.fee.address,
      token_program: TOKEN_PROGRAM_ID,
      event_authority: W.eventAuthority,
      program: ESCROW_ID,
    });
    expectBothReject(lock([...standardLock(p), close], d), 'L1');
    const transfer = splIx(3, W.atas[W.A.address]!, W.atas[W.other.address]!, W.A.address);
    expectBothReject(lock([...standardLock(p), transfer], d), 'L1');
    const memo = otherProgramIx(W.other.address);
    expectBothReject(lock([p.nonce, p.limit, memo, p.create, p.accept], d), 'L1');
    const ata = ataCreate(W.fee.address, W.atas[W.B.address]!, W.B.address);
    expectBothReject(lock([p.nonce, p.limit, ata, p.create, p.accept], d), 'L1');
  });

  it("DP8: A as accept_bet's party_b; A anywhere in accept_bet; B in create_bet; either key in the AdvanceNonce", () => {
    const asPartyB = lockParts(W, W.skill, { accept: { party_b: W.A.address } });
    expectBothReject(lock(standardLock(asPartyB), asPartyB.deadline));
    const asPayer = lockParts(W, W.skill, { accept: { payer: W.A.address } });
    expectBothReject(lock(standardLock(asPayer), asPayer.deadline));
    const aToken = lockParts(W, W.skill, { accept: { party_b_token: W.A.address } });
    expectBothReject(lock(standardLock(aToken), aToken.deadline), 'G5');
    const bInCreate = lockParts(W, W.skill, { create: { party_a_token: W.B.address } });
    expectBothReject(lock(standardLock(bInCreate), bInCreate.deadline), 'G5');
    for (const key of [W.A.address, W.B.address]) {
      const p = lockParts(W, W.skill, { nonceAuthority: key });
      expectBothReject(lock(standardLock(p), p.deadline), 'L2');
    }
    // A listed in a ComputeBudget ix.
    const p = lockParts(W);
    const cbWithKey = {
      ...cuLimit(120_000),
      accounts: [{ address: address(W.A.address), role: 0 as const }],
    };
    expectBothReject(lock([p.nonce, cbWithKey, p.create, p.accept], p.deadline));
  });

  it('DP9: a 4th required signer; fee payer = a device key; party_a / party_b != the displayed Terms', () => {
    const p = lockParts(W);
    const extra = acceptBetIx(
      { ...p.acceptAccts, party_b_token: W.other.address },
      p.acceptArgs,
      true,
    );
    expectBothReject(lock([p.nonce, p.limit, p.price, p.create, extra], p.deadline), 'G5');
    expectBothReject(lock(standardLock(p), p.deadline, { feePayer: W.A.address }), 'G4');
    const otherA = lockParts(W, W.skill, { create: { party_a: W.other.address } });
    expectBothReject(lock(standardLock(otherA), otherA.deadline), 'G5');
    const otherB = lockParts(W, W.skill, { accept: { party_b: W.other.address } });
    expectBothReject(lock(standardLock(otherB), otherB.deadline), 'G5');
  });

  it("DP10: accept_bet args != create_bet args; create_bet.party_b != B's displayed key", () => {
    const cases = [
      { acceptArgs: { expected_stake_a: 4_000_000n } },
      { acceptArgs: { expected_stake_b: 6_000_000n } },
      { acceptArgs: { expected_terms_hash: '11'.repeat(32) } },
      { acceptArgs: { expected_party_a: W.other.address } },
    ];
    for (const o of cases) {
      const p = lockParts(W, W.skill, o);
      expectBothReject(lock(standardLock(p), p.deadline), 'L4');
    }
    const p = lockParts(W, W.skill, { createArgs: { party_b: W.other.address } });
    expectBothReject(lock(standardLock(p), p.deadline), 'L3');
  });

  it('DP11: the two escrow ixs name different Bet / vault / Config / mint; either != the device-derived PDAs', () => {
    const other = W.bets[OTHER_BET]!;
    const variants = [
      { accept: { bet: other.bet } },
      { accept: { vault: other.vault } },
      { create: { config: W.other.address } },
      { create: { bet: other.bet }, accept: { bet: other.bet } },
      { create: { vault: other.vault }, accept: { vault: other.vault } },
      { create: { event_authority: W.other.address } },
    ];
    for (const o of variants) {
      const p = lockParts(W, W.skill, o);
      expectBothReject(lock(standardLock(p), p.deadline), 'G6');
    }
    const mint = lockParts(W, W.skill, { accept: { mint: W.other.address } });
    expectBothReject(lock(standardLock(mint), mint.deadline), 'G1');
  });

  it('DP12: accept_deadline = now; now + 601; one year out; gemini != quotedAt + 60', () => {
    for (const deadline of [W.NOW, W.NOW + 601, W.NOW + 365 * 86_400]) {
      const p = lockParts(W, W.skill, { deadline });
      expectBothReject(lock(standardLock(p), deadline), 'L3');
    }
    const g = lockParts(W, W.gemini, { deadline: W.GEMINI_NOW + 120 });
    const m = lock(standardLock(g), g.deadline, { env: W.gemini });
    expectBothReject(m, 'L3', { nowSecs: W.GEMINI_NOW });
    // != AuthorizeRequest.accept_deadline
    const p = lockParts(W);
    expectBothReject(lock(standardLock(p), p.deadline + 1), 'L3');
  });

  it('DP13: four cases that must be rejected, on both phones', () => {
    // 1. mint != pinned USDC (both escrow ixs).
    const mint = lockParts(W, W.skill, {
      create: { mint: W.other.address },
      accept: { mint: W.other.address },
    });
    expectBothReject(lock(standardLock(mint), mint.deadline), 'G1');
    // 2. create_bet.bet_id != the displayed one.
    const betId = lockParts(W, W.skill, { createArgs: { bet_id: OTHER_BET } });
    expectBothReject(lock(standardLock(betId), betId.deadline), 'L3');
    // 3. accept_deadline + 1 year.
    const year = W.NOW + 300 + 365 * 86_400;
    const late = lockParts(W, W.skill, { deadline: year });
    expectBothReject(lock(standardLock(late), year), 'L3');
    // 4. fee payer / nonce authority not pinned.
    const p = lockParts(W, W.skill, {
      create: { payer: W.other.address },
      accept: { payer: W.other.address },
      nonceAuthority: W.other.address,
    });
    expectBothReject(lock(standardLock(p), p.deadline, { feePayer: W.other.address }), 'G4');
    const auth = lockParts(W, W.skill, { nonceAuthority: W.other.address });
    expectBothReject(lock(standardLock(auth), auth.deadline));
  });

  it('DP14: terms_hash != sha256(JCS(displayed)); message_sha256 mismatch; Terms edited after A signed', async () => {
    const bad = lockParts(W, W.skill, {
      createArgs: { terms_hash: '22'.repeat(32) },
      acceptArgs: { expected_terms_hash: '22'.repeat(32) },
    });
    expectBothReject(lock(standardLock(bad), bad.deadline), 'L3');

    const clean = cleanLock();
    expectBothReject(
      { ...clean, request: { ...clean.request, message_sha256: '00'.repeat(32) } },
      'G3',
    );

    // A signs M1. The server edits the Terms and builds M2; the phone still shows T1.
    const sigA = await signBytes(W.A.kp.privateKey, clean.message);
    const edited = W.envelopeOf(
      W.parties({ ...skillTerms(), claim: 'Jake lands two bottle flips in a row.' }),
    );
    const p2 = lockParts(W, edited);
    const m2 = compile(standardLock(p2), W.fee.address);
    expectBothReject({ message: m2, request: authorizeRequest(W.skill, m2, p2.deadline) }, 'L3');
    expect(await verifySignature(W.A.kp.publicKey, sigA, m2)).toBe(false);
  });

  it('DP15: a lock request on the GG / appeal screen; a concede message on the terms card', () => {
    const { message, request } = cleanLock();
    for (const screen of ['gg', 'appeal'] as const)
      expectReject(message, signInput(request, screen), 'KIND');
    const c = concede(cleanConcedeIxs());
    const asLock = authorizeRequest(W.skill, c.message, W.NOW + 300);
    expectReject(c.message, lockInput(asLock, 'B'), 'KIND');
    // Server label disagrees with the phone's own UI state.
    expectReject(
      message,
      lockInput({ ...request, kind: 'create_bet', nonce_index: null }, 'A'),
      'KIND',
    );
  });

  it('DP16: an address lookup table in the lock message', () => {
    const p = lockParts(W);
    expectBothReject(lock(standardLock(p), p.deadline, { lookups: true }), 'G3');
  });
});

// ---- A13: single-party kinds ------------------------------------------------------------

describe('single-party kinds (A13)', () => {
  it('the clean concede, appeal and sequential create_bet / accept_bet sign', () => {
    const c = concede(cleanConcedeIxs());
    expect(expectPass(c.message, signInput(c.request, 'gg'))).toMatchObject({
      kind: 'concede',
      party: 'B',
    });

    const ap = appealParts(W);
    const am = compile([ap.limit, ap.appeal], W.fee.address);
    expectPass(am, signInput(signRequest(W, 'appeal', am), 'appeal'));

    const p = lockParts(W);
    const cm = compile([p.limit, p.create], W.fee.address);
    const creq = authorizeRequest(W.skill, cm, p.deadline, {
      kind: 'create_bet',
      nonce_index: null,
    });
    expectPass(cm, lockInput(creq, 'A', { lockMode: 'sequential' }));
    const accm = compile([p.limit, p.price, p.accept], W.fee.address);
    const areq = authorizeRequest(W.skill, accm, p.deadline, {
      kind: 'accept_bet',
      nonce_index: null,
    });
    expectPass(accm, lockInput(areq, 'B', { lockMode: 'sequential' }));
  });

  it("an extra SPL Transfer / Approve / SetAuthority / CloseAccount on the party's ATA", () => {
    const c = concedeParts(W);
    const bAta = W.atas[W.B.address]!;
    for (const tag of [3, 4, 6, 9]) {
      const spl = splIx(tag, bAta, W.atas[W.other.address]!, W.B.address);
      const m = concede([c.limit, spl, c.concede, c.close]);
      expectReject(m.message, signInput(m.request, 'gg'));
      const after = concede([c.limit, c.ata, c.concede, c.close, spl]);
      expectReject(after.message, signInput(after.request, 'gg'), 'T1');
    }
  });

  it('an instruction to any other program; an address lookup table; any AdvanceNonceAccount (DP6)', () => {
    const c = concedeParts(W);
    const other = concede([c.limit, otherProgramIx(W.other.address), c.concede, c.close]);
    expectReject(other.message, signInput(other.request, 'gg'), 'T1');
    const alt = concede(cleanConcedeIxs(), { lookups: true });
    expectReject(alt.message, signInput(alt.request, 'gg'), 'G3');

    // DP6: concede, appeal and sequential accept_bet starting with AdvanceNonceAccount.
    const nonce = advanceNonce(W.pool[0]!, W.fee.address);
    const cn = concede([nonce, ...cleanConcedeIxs()]);
    expectReject(cn.message, signInput(cn.request, 'gg'), 'T1');
    const ap = appealParts(W);
    const an = compile([nonce, ap.limit, ap.appeal], W.fee.address);
    expectReject(an, signInput(signRequest(W, 'appeal', an), 'appeal'), 'T1');
    const p = lockParts(W);
    const sn = compile([nonce, p.limit, p.accept], W.fee.address);
    const sreq = authorizeRequest(W.skill, sn, p.deadline, {
      kind: 'accept_bet',
      nonce_index: null,
    });
    expectReject(sn, lockInput(sreq, 'B', { lockMode: 'sequential' }), 'T1');
  });

  it('feePayer != S; the device key in a second ix; mint != USDC; Bet PDA != derived', () => {
    const c = concedeParts(W);
    const fee = concede(
      [c.limit, concedeParts(W, { concede: { payer: W.other.address } }).concede],
      { feePayer: W.other.address },
    );
    expectReject(fee.message, signInput(fee.request, 'gg'), 'G4');

    const second = concedeParts(W, { close: { payer: W.B.address } });
    const sm = concede([second.limit, second.ata, second.concede, second.close]);
    expectReject(sm.message, signInput(sm.request, 'gg'));

    const mint = concedeParts(W, { concede: { mint: W.other.address } });
    const mm = concede([mint.limit, mint.ata, mint.concede, mint.close]);
    expectReject(mm.message, signInput(mm.request, 'gg'), 'G1');

    const bet = concedeParts(W, { concede: { bet: W.bets[OTHER_BET]!.bet } });
    const bm = concede([bet.limit, bet.ata, bet.concede, bet.close]);
    expectReject(bm.message, signInput(bm.request, 'gg'), 'G6');
  });

  it('sequential create_bet: args != displayed; terms_hash wrong; gemini deadline != quotedAt + 60; skill > now + 600', () => {
    const run = (env: World['skill'], o: Parameters<typeof lockParts>[2], nowSecs = W.NOW) => {
      const p = lockParts(W, env, o);
      const m = compile([p.limit, p.create], W.fee.address);
      const req = authorizeRequest(env, m, p.deadline, { kind: 'create_bet', nonce_index: null });
      return expectReject(m, lockInput(req, 'A', { lockMode: 'sequential', nowSecs }), 'L3');
    };
    run(W.skill, { createArgs: { stake_a: 6_000_000n } });
    run(W.skill, { createArgs: { terms_hash: '33'.repeat(32) } });
    run(W.skill, { deadline: W.NOW + 601 });
    run(W.gemini, { deadline: W.GEMINI_NOW + 100 }, W.GEMINI_NOW);
  });

  it('sequential accept_bet with args != displayed (L4) and a foreign party_a slot', () => {
    const p = lockParts(W, W.skill, { acceptArgs: { expected_party_a: W.other.address } });
    const m = compile([p.limit, p.accept], W.fee.address);
    const req = authorizeRequest(W.skill, m, p.deadline, { kind: 'accept_bet', nonce_index: null });
    expectReject(m, lockInput(req, 'B', { lockMode: 'sequential' }), 'L4');
  });
});

// ---- One negative case per API-CONTRACT §6.3 rule ---------------------------------------

describe('API-CONTRACT §6.3 rules', () => {
  it('G1: terms.escrow not pinned; SignRequest.fee_payer not pinned', () => {
    const p = lockParts(W);
    const t = W.envelopeOf({
      ...W.parties(skillTerms()),
      escrow: { cluster: 'devnet', program_id: W.other.address, mint: USDC_MINT_DEVNET },
    });
    const m = compile(standardLock(lockParts(W, t)), W.fee.address);
    expectReject(m, lockInput(authorizeRequest(t, m, p.deadline), 'A'), 'G1');
    const c = concede(cleanConcedeIxs(), { req: { fee_payer: W.other.address } });
    expectReject(c.message, signInput(c.request, 'gg'), 'G1');
  });

  it('G2: envelope hash tampered; card != own rendering; wallet not a party; SignRequest for the other party', () => {
    const { message, request } = cleanLock();
    const tampered = { ...request, envelope: { ...W.skill, terms_hash: '44'.repeat(32) } };
    expectReject(message, lockInput(tampered, 'A'), 'G2');
    expectReject(message, lockInput(request, 'A', { devicePubkey: W.other.address }), 'G2');
    const c = concede(cleanConcedeIxs());
    expectReject(
      c.message,
      signInput(c.request, 'gg', { renderedCard: { ...card(W), pot_line: '$100' } }),
      'G2',
    );
    const forA = concede(cleanConcedeIxs(), { req: { for_parties: ['A'] } });
    expectReject(forA.message, signInput(forA.request, 'gg'), 'G2');
    expectReject(message, lockInput({ not: 'a request' }, 'A'), 'G2');
  });

  it('G3: trailing byte; bytes != message_b64; an offchain-message prefix; a v0 message is fine', () => {
    const { message, request } = cleanLock();
    const trailing = Uint8Array.from([...message, 0]);
    expectReject(
      trailing,
      lockInput(authorizeRequest(W.skill, trailing, request.accept_deadline), 'A'),
      'G3',
    );
    const flipped = Uint8Array.from(message);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    expectReject(flipped, lockInput(request, 'A'), 'G3');
    const offchain = Uint8Array.from([
      0xff,
      ...new TextEncoder().encode('solana offchain'),
      0,
      0,
      0,
    ]);
    expectReject(
      offchain,
      lockInput(authorizeRequest(W.skill, offchain, request.accept_deadline), 'A'),
      'G3',
    );
    const p = lockParts(W);
    const v0 = compile(standardLock(p), W.fee.address, { version: 0 });
    expectPass(v0, lockInput(authorizeRequest(W.skill, v0, p.deadline), 'B'));
  });

  it('G5: device key not among the signers (wrong phone)', () => {
    const ap = appealParts(W, W.A.address);
    const m = compile([ap.limit, ap.appeal], W.fee.address);
    // B's phone gets a message that A signs.
    expectReject(
      m,
      signInput(
        signRequest(W, 'appeal', m, { ruling_ref: { ruling_hash: RULING_HASH, outcome: 'VOID' } }),
        'appeal',
      ),
      'G5',
    );
  });

  it('G7: two SetComputeUnitLimit; CU limit > 400k; RequestHeapFrame', () => {
    const c = concedeParts(W);
    for (const cbs of [
      [cuLimit(1), cuLimit(2)],
      [cuLimit(400_001)],
      [heapFrame()],
      [cuPrice(1), cuPrice(2)],
    ]) {
      const m = concede([...cbs, c.ata, c.concede, c.close]);
      expectReject(m.message, signInput(m.request, 'gg'), 'G7');
    }
    const p = lockParts(W);
    expectBothReject(lock([p.nonce, cuLimit(400_001), p.create, p.accept], p.deadline), 'G7');
    expectBothReject(lock([p.nonce, p.price, p.limit, p.create, p.accept], p.deadline), 'L1');
  });

  it('T1: ATA create not for the winner, or funded by someone else; close_bet on appeal', () => {
    const toLoser = concedeParts(W, { ataWallet: W.other.address });
    const m = concede([toLoser.limit, toLoser.ata, toLoser.concede, toLoser.close]);
    expectReject(m.message, signInput(m.request, 'gg'), 'T1');
    const c = concedeParts(W);
    const ap = appealParts(W);
    const am = compile([ap.limit, ap.appeal, c.close], W.fee.address);
    expectReject(am, signInput(signRequest(W, 'appeal', am), 'appeal'), 'T1');
  });

  it('T2: ruling hash != the verified one; the winner tries to concede; concede on VOID; appeal on VOID by either party passes', () => {
    const c = concede(cleanConcedeIxs());
    expectReject(
      c.message,
      signInput(c.request, 'gg', { verifiedRulingHash: 'cd'.repeat(32) }),
      'T2',
    );
    const bWins = concede(cleanConcedeIxs(), {
      req: { ruling_ref: { ruling_hash: RULING_HASH, outcome: 'B_WINS' } },
    });
    expectReject(bWins.message, signInput(bWins.request, 'gg'), 'T2');
    const voided = concede(cleanConcedeIxs(), {
      req: { ruling_ref: { ruling_hash: RULING_HASH, outcome: 'VOID' } },
    });
    expectReject(voided.message, signInput(voided.request, 'gg'), 'T2');

    const ap = appealParts(W);
    const am = compile([ap.limit, ap.appeal], W.fee.address);
    const voidReq = signRequest(W, 'appeal', am, {
      ruling_ref: { ruling_hash: RULING_HASH, outcome: 'VOID' },
    });
    expectPass(am, signInput(voidReq, 'appeal'));
    const winnerReq = signRequest(W, 'appeal', am, {
      ruling_ref: { ruling_hash: RULING_HASH, outcome: 'B_WINS' },
    });
    expectReject(am, signInput(winnerReq, 'appeal'), 'T2');

    // A compromised server pairs the verified hash with a flipped outcome: the phone verified
    // B_WINS (B, this device, won), the request says A_WINS so the winner would pass the loser check.
    const flipped = concede(cleanConcedeIxs());
    expectReject(
      flipped.message,
      signInput(flipped.request, 'gg', { verifiedRulingOutcome: 'B_WINS' }),
      'T2',
    );
    expectReject(am, signInput(voidReq, 'appeal', { verifiedRulingOutcome: 'B_WINS' }), 'T2');
  });

  it("T3: close_bet.rent_payer != fee payer; party_a_token isn't A's ATA", () => {
    const rent = concedeParts(W, { close: { rent_payer: W.other.address } });
    const rm = concede([rent.limit, rent.ata, rent.concede, rent.close]);
    expectReject(rm.message, signInput(rm.request, 'gg'), 'T3');
    const tok = concedeParts(W, { close: { party_a_token: W.atas[W.other.address]! } });
    const tm = concede([tok.limit, tok.ata, tok.concede, tok.close]);
    expectReject(tm.message, signInput(tm.request, 'gg'), 'T3');
  });

  it('assertDevicePolicy throws a DevicePolicyError carrying {bet_id, kind, rule}', () => {
    const p = lockParts(W);
    const m = lock([p.limit, p.price, p.create, p.accept], p.deadline);
    try {
      assertDevicePolicy(m.message, lockInput(m.request, 'A'));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DevicePolicyError);
      expect((e as DevicePolicyError).verdict).toMatchObject({
        rule: 'L1',
        bet_id: SKILL_BET,
        kind: 'atomic_lock',
      });
    }
    const clean = cleanLock();
    expect(assertDevicePolicy(clean.message, lockInput(clean.request, 'B')).party).toBe('B');
  });
});
