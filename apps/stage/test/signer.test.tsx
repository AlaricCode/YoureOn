// With LOCK_SIGNER=server (the production demo config) the server signs the lock as demo-a /
// demo-b right after the build and records the method as faceid_hold (lock/service.ts), so the
// projector must not claim that A and B each signed behind Face ID. The stage session says who
// signs (lock_signer); the slots, the party cards, the caption and the ticker word it as custodial
// demo signing. Unknown (null) keeps the phones wording.
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { openStageSession } from '../src/connection';
import { eventLabel } from '../src/format';
import { previewAt, PREVIEW_STEPS } from '../src/preview';
import { normalizeSigner, StageView, type LockSigner } from '../src/view';

const START = Date.parse('2026-11-20T15:00:00.000Z');
const text = (html: string) => html.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'");
const render = (step: keyof typeof PREVIEW_STEPS, lockSigner: LockSigner) => {
  const f = previewAt(START, START, step);
  return text(renderToString(<StageView state={f.state} now={f.now} lockSigner={lockSigner} />));
};

describe('lock signer wording', () => {
  it("LOCK_SIGNER=server: 'demo key', never Face ID, during the lock", () => {
    const lock = render('lock', 'server');
    expect(lock).toContain('✓ demo key');
    expect(lock).toContain('1 of 2 signed');
    expect(lock).toContain('demo keys sign for both players');
    expect(lock).not.toContain('Face ID');
    expect(lock).not.toContain('one signature per phone');
    expect(lock).toContain('signed · demo key'); // the ticker row

    const locked = render('locked', 'server');
    expect(locked).toContain('✓ demo key');
    expect(locked).not.toContain('Face ID');
    expect(locked).toContain('Fee payer');
  });

  it('phones (or unknown): the Face ID wording stays', () => {
    for (const signer of ['phones', null] as const) {
      const lock = render('lock', signer);
      expect(lock).toContain('✓ Face ID');
      expect(lock).toContain('1 of 2 authorized');
      expect(lock).toContain('one signature per phone');
      expect(lock).toContain('authorized · Face ID');
    }
  });

  it('before anyone signed: A confirms the terms, B already accepted (server)', () => {
    const terms = render('terms', 'server');
    expect(terms).toContain('confirming terms…');
    expect(terms).toContain('✓ accepted');
    expect(terms).not.toContain('waiting for Face ID');
    expect(render('terms', null)).toContain('waiting for Face ID…');
  });

  it('ticker label and the session field', () => {
    const p = { party: 'B', method: 'faceid_hold' };
    expect(eventLabel('terms.authorized', p, { A: 'Logan', B: 'Jake' }, true)).toBe(
      'Jake signed · demo key',
    );
    expect(eventLabel('terms.authorized', p, { A: 'Logan', B: 'Jake' })).toBe(
      'Jake authorized · Face ID',
    );
    expect(normalizeSigner('server')).toBe('server');
    expect(normalizeSigner('phones')).toBe('phones');
    expect(normalizeSigner(undefined)).toBeNull();
    expect(normalizeSigner('custodial')).toBeNull();
  });

  it('openStageSession reads lock_signer (null from an older server)', async () => {
    const reply = (body: unknown) =>
      (async () =>
        new Response(JSON.stringify(body), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch;
    const base = {
      token: 'yo_s_x',
      room_id: '00000000-0000-4000-8000-000000000001',
      scopes: ['stage'],
      expires_at: '2026-11-21T03:00:00.000Z',
    };
    const cfg = { serverUrl: 'https://h.dev', roomId: 'ABC234', stageKey: 'k' };
    expect(
      (await openStageSession(cfg, reply({ ...base, lock_signer: 'server' }))).lock_signer,
    ).toBe('server');
    expect((await openStageSession(cfg, reply(base))).lock_signer).toBeNull();
    expect(
      (await openStageSession(cfg, reply({ ...base, lock_signer: 'other' }))).lock_signer,
    ).toBeNull();
  });
});
