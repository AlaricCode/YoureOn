import { bottleFlipClaim, TypedTermsRequest } from '@youre-on/shared/judge/typed-terms';
import { describe, expect, it } from 'vitest';

import { applyBetEvent, fromSnapshot } from '../../bets/store';
import { ApiClientError } from '../../net/signedFetch';
import { COPY, t } from '../../screens/copy';
import { checkCopy } from '../../ui/copyRule';
import {
  canConfirm,
  canSubmit,
  confirmTypedTerms,
  DEFAULT_STAKE_USD,
  initialTyped,
  submitTypedTerms,
  TYPED_STAKES_USD,
  typedCardOf,
  typedReducer,
  waitingForAccept,
  type TypedEvent,
  type TypedState,
} from '../typedTerms';
import { btcCloser } from '../../preview/data';
import { BET, envelope, ev, snapshot } from './fixtures';

const HASH = 'ab'.repeat(32);
const run = (s: TypedState, ...events: TypedEvent[]) => events.reduce(typedReducer, s);
const typedOn = (betId = BET) =>
  run(initialTyped, { type: 'init', bet_id: betId, bName: 'Jake', typed: true });

describe('typed terms reducer', () => {
  it('init: voice by default, the form when voice is off; the claim is the bottle-flip template', () => {
    const v = run(initialTyped, { type: 'init', bet_id: BET, bName: 'Jake', typed: false });
    expect(v).toMatchObject({
      bet_id: BET,
      mode: 'voice',
      claim: 'Jake lands a water bottle flip upright on the table. One try.',
      stakeUsd: DEFAULT_STAKE_USD,
      phase: 'editing',
    });
    expect(canSubmit(v)).toBe(false); // the judge is running: no form
    expect(typedOn().mode).toBe('typed');
    expect(canSubmit(typedOn())).toBe(true);
  });

  it('init again for the same bet keeps the form; a new bet resets it', () => {
    const s = run(typedOn(), { type: 'stake', usd: 10 }, { type: 'claim', text: 'Jake juggles.' });
    expect(run(s, { type: 'init', bet_id: BET, bName: 'Jake', typed: true })).toBe(s);
    const other = run(s, {
      type: 'init',
      bet_id: '11111111-1111-4111-8111-111111111111',
      bName: 'Ava',
      typed: true,
    });
    expect(other).toMatchObject({ stakeUsd: DEFAULT_STAKE_USD, claim: bottleFlipClaim('Ava') });
    // The voice session failed after init: the same bet re-inits into the form.
    const voice = run(initialTyped, { type: 'init', bet_id: BET, bName: 'Jake', typed: false });
    expect(run(voice, { type: 'init', bet_id: BET, bName: 'Jake', typed: true }).mode).toBe(
      'typed',
    );
  });

  it('"Type it instead" opens the form; back to the judge closes it', () => {
    const v = run(initialTyped, { type: 'init', bet_id: BET, bName: 'Jake', typed: false });
    const open = run(v, { type: 'open' });
    expect(open.mode).toBe('typed');
    expect(run(open, { type: 'voice' }).mode).toBe('voice');
  });

  it('submit -> sending -> proposed -> sent; Lock it in only for the card this form sent', () => {
    const sending = run(typedOn(), { type: 'stake', usd: 5 }, { type: 'submit' });
    expect(sending.phase).toBe('sending');
    expect(canSubmit(sending)).toBe(false);
    // edits are ignored while sending
    expect(run(sending, { type: 'claim', text: 'x' })).toBe(sending);
    expect(run(sending, { type: 'stake', usd: 20 })).toBe(sending);
    const sent = run(sending, {
      type: 'submitted',
      outcome: { kind: 'proposed', terms_hash: HASH, code: 'abab·abab' },
    });
    expect(sent).toMatchObject({ phase: 'sent', proposedHash: HASH, note: null });
    expect(canConfirm(sent, null, 'accepted')).toBe(false); // the push has not arrived yet
    expect(canConfirm(sent, 'cd'.repeat(32), 'accepted')).toBe(false); // someone else's newer card
    expect(canConfirm(sent, HASH, 'accepted')).toBe(true);
    expect(waitingForAccept(sent, HASH, 'accepted')).toBe(false);
    const confirming = run(sent, { type: 'confirm' });
    expect(confirming.phase).toBe('confirming');
    expect(run(confirming, { type: 'confirmed' }).phase).toBe('confirmed');
    // A failed confirm returns to the card with a note.
    expect(run(confirming, { type: 'confirm_failed', note: 'Try again' })).toMatchObject({
      phase: 'sent',
      note: 'Try again',
    });
  });

  it('a draft or refusal goes back to editing with the judge line; an edit after sending re-arms Send', () => {
    const s = run(typedOn(), { type: 'submit' });
    const draft = run(s, { type: 'submitted', outcome: { kind: 'draft', note: 'Max is $20.' } });
    expect(draft).toMatchObject({ phase: 'editing', note: 'Max is $20.' });
    expect(canSubmit(draft)).toBe(true);
    const sent = run(typedOn(), { type: 'submit' }, {
      type: 'submitted',
      outcome: { kind: 'proposed', terms_hash: HASH, code: 'c' },
    } as TypedEvent);
    const edited = run(sent, { type: 'stake', usd: 20 });
    expect(edited.phase).toBe('editing');
    expect(canConfirm(edited, HASH, 'accepted')).toBe(false);
    expect(canSubmit(edited)).toBe(true);
  });

  it('confirm is ignored before a proposal, and in voice mode', () => {
    expect(run(typedOn(), { type: 'confirm' }).phase).toBe('editing');
    const v = run(initialTyped, { type: 'init', bet_id: BET, bName: 'Jake', typed: false });
    expect(run(v, { type: 'confirm' })).toBe(v);
    expect(run(v, { type: 'submit' })).toBe(v);
  });

  it('an empty claim cannot be sent', () => {
    const s = run(typedOn(), { type: 'claim', text: '   ' });
    expect(canSubmit(s)).toBe(false);
    expect(run(s, { type: 'submit' })).toBe(s);
  });

  it('offers the four stakes', () => {
    expect([...TYPED_STAKES_USD]).toEqual([1, 5, 10, 20]);
  });
});

describe('restart mid-bet: the form adopts the card already on screen', () => {
  // Seen on the simulator: A sent "$5 each", B accepted, A's app restarted. The bet came back
  // with the $5 card, but the form under it said $1 and "Send terms" (no "Lock it in"): the only
  // way on was to propose again, at the wrong stake.
  const env = envelope(); // the $5-each bottle flip
  const restored = (typed = true) =>
    run(initialTyped, {
      type: 'init',
      bet_id: BET,
      bName: 'Jake',
      typed,
      shown: typedCardOf(env),
    });

  it('the card on screen: its claim and stake, and "Lock it in" once B has accepted', () => {
    expect(typedCardOf(env)).toEqual({
      terms_hash: env.terms_hash,
      claim: env.terms.claim,
      stakeUsd: 5,
    });
    const s = restored();
    expect(s).toMatchObject({
      bet_id: BET,
      mode: 'typed',
      phase: 'sent',
      claim: env.terms.claim,
      stakeUsd: 5,
      proposedHash: env.terms_hash,
    });
    expect(canConfirm(s, env.terms_hash, 'accepted')).toBe(true);
    expect(waitingForAccept(s, env.terms_hash, null)).toBe(true);
    expect(canSubmit(s)).toBe(false);
    // A newer card (another proposal) needs a fresh look, as before.
    expect(canConfirm(s, HASH, 'accepted')).toBe(false);
    // Editing it makes a new proposal.
    const edited = run(s, { type: 'stake', usd: 10 });
    expect(edited.phase).toBe('editing');
    expect(canConfirm(edited, env.terms_hash, 'accepted')).toBe(false);
    expect(canSubmit(edited)).toBe(true);
  });

  it('only the typed form adopts it, and only when it opens on a bet', () => {
    expect(restored(false)).toMatchObject({ mode: 'voice', phase: 'editing', proposedHash: null });
    // A form already open on this bet keeps what it has (a re-init never resets it).
    const open = typedOn();
    expect(
      run(open, { type: 'init', bet_id: BET, bName: 'Jake', typed: true, shown: typedCardOf(env) }),
    ).toBe(open);
  });

  it('typedCardOf: nothing for no card, a market card, uneven or unoffered stakes', () => {
    expect(typedCardOf(null)).toBeNull();
    const btc = btcCloser('Logan');
    expect(typedCardOf({ terms: btc.terms, terms_hash: btc.termsHash })).toBeNull();
    const stakes = (a: string, b: string) => ({
      ...env,
      terms: { ...env.terms, stakes: { a, b, currency: 'USDC' as const } },
    });
    expect(typedCardOf(stakes('5000000', '1000000'))).toBeNull();
    expect(typedCardOf(stakes('3000000', '3000000'))).toBeNull();
    expect(typedCardOf(stakes('1000000', '1000000'))?.stakeUsd).toBe(1);
  });
});

describe('typed terms actions', () => {
  it('submit sends the template with bottle-flip criteria and the stake in dollars', async () => {
    const seen: unknown[] = [];
    const r = await submitTypedTerms(
      {
        api: {
          async proposeTypedTerms(betId, body) {
            seen.push({ betId, body });
            return {
              ok: true,
              kind: 'proposed',
              state: 'TERMS_PROPOSED',
              terms_hash: HASH,
              code: 'abab·abab',
              say: 'x',
            };
          },
        },
      },
      { betId: BET, claim: bottleFlipClaim('Jake'), stakeUsd: 5, bName: 'Jake' },
    );
    expect(r).toEqual({ kind: 'proposed', terms_hash: HASH, code: 'abab·abab' });
    const { body } = seen[0] as { betId: string; body: unknown };
    const parsed = TypedTermsRequest.parse(body);
    expect(parsed).toMatchObject({
      claim: 'Jake lands a water bottle flip upright on the table. One try.',
      amount_usd: '5',
      performer: 'B',
      yes_party: 'B',
      attempts: { count: 1, rule: 'single' },
    });
    expect(parsed.edge_cases?.[0]?.question).toBe('Does landing on the cap count?');
    expect(parsed.success_criteria).toHaveLength(2);
  });

  it('an edited claim becomes its own success condition', async () => {
    let body: TypedTermsRequest | null = null;
    await submitTypedTerms(
      {
        api: {
          async proposeTypedTerms(_id, b) {
            body = b;
            return { ok: false, kind: 'draft', fix: null, missing: [], say: 'x' };
          },
        },
      },
      { betId: BET, claim: '  Jake sinks   a free throw. ', stakeUsd: 1, bName: 'Jake' },
    );
    expect(body).toMatchObject({
      claim: 'Jake sinks a free throw.',
      success_criteria: ['Jake sinks a free throw.'],
    });
  });

  it('draft / refusal: the judge line when it passes the copy rule, else a short fallback', async () => {
    const api = (say: string, kind: 'draft' | 'refused') => ({
      async proposeTypedTerms() {
        return kind === 'draft'
          ? { ok: false as const, kind, fix: 'STAKE_ABOVE_MAX', missing: [], say }
          : { ok: false as const, kind, category: 'alcohol_drugs', say };
      },
    });
    const input = { betId: BET, claim: 'Jake chugs a beer.', stakeUsd: 20, bName: 'Jake' };
    expect(
      await submitTypedTerms({ api: api('Max is ten bucks. Say ten?', 'draft') }, input),
    ).toEqual({ kind: 'draft', note: 'Max is ten bucks. Say ten?' });
    expect(await submitTypedTerms({ api: api('No booze bets.', 'refused') }, input)).toEqual({
      kind: 'refused',
      note: 'No booze bets.',
    });
    // A server line with chain words never reaches the screen.
    expect(await submitTypedTerms({ api: api('Not enough SOL for gas.', 'draft') }, input)).toEqual(
      { kind: 'draft', note: t(COPY.app.failed) },
    );
  });

  it('network / server errors become a short error note', async () => {
    const r = await submitTypedTerms(
      {
        api: {
          async proposeTypedTerms() {
            throw new ApiClientError('INVALID_STATE', 409, 'set', true);
          },
        },
      },
      { betId: BET, claim: 'x', stakeUsd: 1, bName: 'Jake' },
    );
    expect(r).toEqual({ kind: 'error', note: t(COPY.app.failed) });
  });

  it('confirm posts the shown terms_hash with the pinned key; a stale card says review again', async () => {
    const seen: unknown[] = [];
    const ok = await confirmTypedTerms(
      {
        api: {
          async confirmTerms(betId, termsHash, key) {
            seen.push({ betId, termsHash, key });
            return { ok: true, code: 'c', state: 'AWAITING_AUTHORIZATIONS', say: 's' };
          },
        },
      },
      { betId: BET, termsHash: HASH, idempotencyKey: 'k-1' },
    );
    expect(ok).toEqual({ ok: true });
    expect(seen).toEqual([{ betId: BET, termsHash: HASH, key: 'k-1' }]);
    const stale = await confirmTypedTerms(
      {
        api: {
          async confirmTerms() {
            throw new ApiClientError('TERMS_HASH_MISMATCH', 409, 'changed', true);
          },
        },
      },
      { betId: BET, termsHash: HASH, idempotencyKey: 'k-2' },
    );
    expect(stale).toEqual({ ok: false, note: 'Terms changed, review again', freshKey: true });
    // B has not accepted: the server's 409 is replayed for k-3, so the next tap needs a new key.
    const pending = await confirmTypedTerms(
      {
        api: {
          async confirmTerms() {
            throw new ApiClientError('INVALID_STATE', 409, 'pending', false, {
              reason: 'invite_pending',
            });
          },
        },
      },
      { betId: BET, termsHash: HASH, idempotencyKey: 'k-3' },
    );
    expect(pending).toEqual({ ok: false, note: 'They have not accepted yet.', freshKey: true });
    // A lost response keeps the key: the resend is the same write.
    const lost = await confirmTypedTerms(
      {
        api: {
          async confirmTerms() {
            throw new ApiClientError('NETWORK', 0, 'offline', true);
          },
        },
      },
      { betId: BET, termsHash: HASH, idempotencyKey: 'k-4' },
    );
    expect(lost).toMatchObject({ ok: false, freshKey: false });
  });

  it('Lock it in waits for B to accept the challenge; until then the card says Waiting for B', () => {
    const sent = run(typedOn(), { type: 'submit' }, {
      type: 'submitted',
      outcome: { kind: 'proposed', terms_hash: HASH, code: 'c' },
    } as TypedEvent);
    // B's phone is still on the incoming screen.
    expect(canConfirm(sent, HASH, null)).toBe(false);
    expect(waitingForAccept(sent, HASH, null)).toBe(true);
    expect(canConfirm(sent, HASH, 'declined')).toBe(false);
    // bet.invite_answered accepted reaches A's store.
    const m = applyBetEvent(
      fromSnapshot(snapshot()),
      ev('bet.invite_answered', { party: 'B', answer: 'accepted' }, 2),
    );
    expect(m.inviteAnswer).toBe('accepted');
    expect(canConfirm(sent, HASH, m.inviteAnswer)).toBe(true);
    expect(waitingForAccept(sent, HASH, m.inviteAnswer)).toBe(false);
    // Before the card is on screen there is nothing to wait on: Send stays.
    expect(waitingForAccept(typedOn(), HASH, null)).toBe(false);
  });

  it('every note the form can show passes the copy rule', () => {
    for (const n of [
      'Terms changed, review again',
      'They have not accepted yet.',
      t(COPY.app.failed),
    ])
      expect(checkCopy(n, 'body')).toEqual([]);
  });

  it('the card a typed submit produces arrives by the normal terms.proposed push', () => {
    // The store folds terms.proposed into the envelope; canConfirm then matches its hash.
    const env = envelope();
    const m = applyBetEvent(fromSnapshot(snapshot()), ev('terms.proposed', { envelope: env }, 2));
    const sent = run(typedOn(), { type: 'submit' }, {
      type: 'submitted',
      outcome: { kind: 'proposed', terms_hash: env.terms_hash, code: 'c' },
    } as TypedEvent);
    expect(canConfirm(sent, m.envelope?.terms_hash ?? null, 'accepted')).toBe(true);
  });
});
