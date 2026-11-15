// The wallet refuses to sign a message that fails the device signing policy (ESCROW §5.0.2,
// API-CONTRACT §6.3). The messages come from the shared policy's own Kit-built fixtures, with this
// wallet's key in party A's seat; the noble derivations are cross-checked against Kit's.
import { beforeAll, describe, expect, it } from 'vitest';

import {
  SKILL_BET,
  authorizeRequest,
  compile,
  createWorld,
  lockParts,
  standardLock,
  type World,
} from '../../../../../packages/shared/test/device-policy.fixtures';
import { base58Decode } from '../bytes';
import {
  base64ToBytes,
  createNobleDerivations,
  messageBytesOf,
  runDevicePolicy,
} from '../devicePolicy';
import { ed } from '../noble';
import { createWallet, WalletError } from '../wallet';
import { createFakePlatform, type FakePlatform } from './fakes';

const PROMPT = { promptMessage: 'Lock in $5 vs Jake', fallbackLabel: 'Use Passcode' };

let W: World;
let platform: FakePlatform;
let wallet: ReturnType<typeof createWallet>;
let publicKey: string;

beforeAll(async () => {
  platform = createFakePlatform();
  wallet = createWallet(platform);
  publicKey = (await wallet.ensureWallet()).publicKey;
  W = await createWorld({ partyA: publicKey });
  platform.clock.ms = W.NOW * 1000;
  // The fixture world's own fee payer / mint, through the test-only platform channel.
  platform.policyPinsForTests = W.pins;
});

const terms = (request: unknown) =>
  ({ screen: 'terms_card', lockMode: 'atomic', request }) as const;

describe('noble derivations', () => {
  it('match Kit for Bet / vault / Config / event authority / ATA', () => {
    const d = createNobleDerivations(W.pins);
    expect(d.betPdas(SKILL_BET)).toEqual(W.derive.betPdas(SKILL_BET));
    expect(d.eventAuthority()).toBe(W.derive.eventAuthority());
    expect(d.associatedTokenAddress(W.B.address, W.pins.mint)).toBe(
      W.derive.associatedTokenAddress(W.B.address, W.pins.mint),
    );
  });

  it('base64ToBytes matches Node and rejects malformed input', () => {
    for (const n of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
      const b64 = Buffer.from(bytes).toString('base64');
      expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes));
    }
    expect(() => base64ToBytes('abc')).toThrow();
    expect(() => base64ToBytes('ab$=')).toThrow();
    expect(() => messageBytesOf({})).toThrow();
  });
});

describe('wallet.authorizeTransaction (device policy wired into authorize)', () => {
  it('signs the clean lock as party A, after one Face ID prompt, over the exact message_b64 bytes', async () => {
    const p = lockParts(W);
    const message = compile(standardLock(p), W.fee.address);
    const request = authorizeRequest(W.skill, message, p.deadline);
    expect(
      runDevicePolicy(message, terms(request), {
        devicePubkey: publicKey,
        nowMs: platform.clock.ms,
        pinsForTests: W.pins,
      }),
    ).toMatchObject({
      ok: true,
      party: 'A',
    });
    platform.events.length = 0;
    const result = await wallet.authorizeTransaction(terms(request), PROMPT);
    expect(result.policy).toMatchObject({
      ok: true,
      kind: 'atomic_lock',
      party: 'A',
      terms_hash: W.skill.terms_hash,
    });
    expect(result.messageSha256).toBe(request.message_sha256);
    expect(ed.verify(result.signature, message, base58Decode(publicKey))).toBe(true);
    expect(platform.events.filter((e) => e.kind === 'auth')).toHaveLength(1);
  });

  it('refuses a non-conforming lock before any prompt and reports {bet_id, kind, rule}', async () => {
    const p = lockParts(W);
    const message = compile([p.limit, p.nonce, p.price, p.create, p.accept], W.fee.address);
    const request = authorizeRequest(W.skill, message, p.deadline);
    platform.events.length = 0;
    const err = await wallet.authorizeTransaction(terms(request), PROMPT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WalletError);
    expect(err).toMatchObject({
      code: 'POLICY_REJECTED',
      policyRule: 'L1',
      policyReport: { bet_id: SKILL_BET, kind: 'atomic_lock', rule: 'L1' },
    });
    expect(platform.events.some((e) => e.kind === 'auth')).toBe(false);
    expect(platform.events.some((e) => e.kind === 'get' && e.key.includes('seed'))).toBe(false);
  });

  it('checks with the stored key: the same lock on a wallet that is not a party is refused (G2)', async () => {
    const other = createWallet({ ...createFakePlatform(), policyPinsForTests: W.pins });
    await other.ensureWallet();
    const p = lockParts(W);
    const message = compile(standardLock(p), W.fee.address);
    const request = authorizeRequest(W.skill, message, p.deadline);
    await expect(other.authorizeTransaction(terms(request), PROMPT)).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
      policyRule: 'G2',
    });
  });

  it('uses the wallet clock: a lock past accept_deadline is refused (L3)', async () => {
    const p = lockParts(W);
    const message = compile(standardLock(p), W.fee.address);
    const request = authorizeRequest(W.skill, message, p.deadline);
    const saved = platform.clock.ms;
    platform.clock.ms = (p.deadline + 1) * 1000;
    try {
      await expect(wallet.authorizeTransaction(terms(request), PROMPT)).rejects.toMatchObject({
        code: 'POLICY_REJECTED',
        policyRule: 'L3',
      });
    } finally {
      platform.clock.ms = saved;
    }
  });

  it('authorize(bytes, prompt, {devicePolicy}) refuses bytes that are not the request message (G3)', async () => {
    const p = lockParts(W);
    const message = compile(standardLock(p), W.fee.address);
    const request = authorizeRequest(W.skill, message, p.deadline);
    const tampered = Uint8Array.from(message);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    await expect(
      wallet.authorize(tampered, PROMPT, { devicePolicy: terms(request) }),
    ).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
      policyRule: 'G3',
    });
  });

  it('a request cannot override the G1 pins: runtime `pins` are ignored, DEVICE_POLICY_PINS win', async () => {
    const p = lockParts(W);
    const message = compile(standardLock(p), W.fee.address);
    const request = authorizeRequest(W.skill, message, p.deadline);
    // A wallet without the test channel uses the compiled-in pins, whatever the screen passes.
    const prod = createFakePlatform();
    prod.clock.ms = platform.clock.ms;
    const pinned = createWallet(prod);
    // Reuse this wallet's seed so the only difference is the pins.
    for (const [k, v] of platform.items) prod.items.set(k, v);
    const smuggled = { ...terms(request), pins: W.pins } as unknown as Parameters<
      typeof wallet.authorizeTransaction
    >[0];
    const err = await pinned.authorizeTransaction(smuggled, PROMPT).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'POLICY_REJECTED' });
    expect(prod.events.some((e) => e.kind === 'auth')).toBe(false);
    // The advisory screen check behaves the same way.
    expect(
      runDevicePolicy(message, smuggled, { devicePubkey: publicKey, nowMs: platform.clock.ms }),
    ).toMatchObject({ ok: false });
  });

  it('a request with no message_b64 is BAD_MESSAGE, never signed', async () => {
    await expect(
      wallet.authorizeTransaction(terms({ bet_id: SKILL_BET }), PROMPT),
    ).rejects.toMatchObject({
      code: 'BAD_MESSAGE',
    });
  });
});
