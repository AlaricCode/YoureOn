import { afterEach, describe, expect, it } from 'vitest';
import {
  acceptanceAudioHash,
  acceptSigMessage,
  bytesToHex,
  concatBytes,
  programHash,
  sha256,
} from '@verdict/engine';
import { identityHuddleServices } from '../src/huddles/services.js';
import type { CompileRequest, CompileResult, CompilerProvider } from '../src/providers/types.js';
import { MockCompiler } from '../src/providers/mock/compiler.js';
import { fromBase64, toBase64 } from '../src/util/bytes.js';
import { auth, type TestApp, type TestUser } from './appHelpers.js';
import { b64, crew, fakeWav, get, makeAppWith, post, submitSign } from './identityHelpers.js';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.app.close();
  t = null;
});

/** The persisted UserRecord of a test user. */
const rec = (u: TestUser) => t!.ctx.auth.requireUser(u.user.id);

const PAPER = "I bet Bob can't get a paper ball in the trash can from behind that line. Three tries. $5";

async function compile(u: TestUser, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const r = await post(t!.app, u, '/v1/bets/compile', body, headers);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

/** Bob's spoken + signed acceptance. */
async function accept(u: TestUser, draftId: string, programHashHex: string, headers: Record<string, string> = {}, wav = fakeWav()) {
  const ch = (await get(t!.app, u, `/v1/drafts/${draftId}/accept/challenge`)).json();
  const sig = u.wallet.sign(acceptSigMessage(programHashHex, wav));
  const r = await post(t!.app, u, `/v1/drafts/${draftId}/accept`, { challenge_id: ch.challenge_id, audio_b64: b64(wav), accept_sig_b64: toBase64(sig) }, headers);
  return { r, ch, wav, sig };
}

describe('compile (§2.7, §12.3, §13 mock compiler)', () => {
  it('compiles the paper-ball bet into a ready, canonical draft with read-back', async () => {
    t = await makeAppWith();
    const { users, huddleId } = await crew(t, ['Alice', 'Bob']);
    const [alice, bob] = users as [TestUser, TestUser];
    const d = await compile(alice, { huddle_id: huddleId, transcript: PAPER });
    expect(d.status).toBe('ready');
    expect(d.kind).toBe('rules');
    expect(d.title).toBe('Paper ball shot');
    expect(d.program.participants).toEqual([alice.wallet.publicKey, bob.wallet.publicKey]);
    expect(d.program.legs[0].rule).toEqual({ kind: 'count', cmp: '>=', k: 1, attempts: 3 });
    expect(d.program.stake_each).toBe(5_000_000);
    expect(d.program_hash).toBe(programHash(d.program));
    expect(d.yaml).toContain('version: 2');
    expect(d.readback).toContain('$5.00 each');
    expect(d.readback.some((l: string) => l.includes('Bob'))).toBe(true);
    expect(d.labels).toMatchObject({ shooter: 'Bob', can: 'Trash Can', line: 'Line' });
    expect(d.questions.map((q: { id: string }) => q.id)).toEqual(['line']); // region questions never block
    expect(d.questions[0].audio_url).toMatch(/\/v1\/drafts\/.+\/questions\/line\/audio$/);
    expect(d.participants).toEqual([
      { user_id: alice.user.id, display_name: 'Alice', side: 0, accepted: true, is_creator: true },
      { user_id: bob.user.id, display_name: 'Bob', side: 1, accepted: false, is_creator: false },
    ]);
    expect(d.frozen).toBe(false);
    expect(d.readback_audio_url).toMatch(/readback\.mp3$/);

    // every member sees it
    const seen = (await get(t.app, bob, `/v1/drafts/${d.draft_id}`)).json();
    expect(seen.program_hash).toBe(d.program_hash);
    // read-back + question audio (mock TTS → WAV)
    const audio = await get(t.app, bob, `/v1/drafts/${d.draft_id}/readback.mp3`);
    expect(audio.statusCode).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/wav');
    expect(audio.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    expect((await get(t.app, bob, `/v1/drafts/${d.draft_id}/questions/line/audio`)).statusCode).toBe(200);
  });

  it('asks clarifying questions and resolves them with answers', async () => {
    t = await makeAppWith();
    const { users, huddleId } = await crew(t, ['Alice', 'Bob']);
    const alice = users[0]!;
    const d1 = await compile(alice, { huddle_id: huddleId, transcript: 'I bet Bob cannot hit the trash can with a paper ball' });
    expect(d1.status).toBe('needs_clarification');
    expect(d1.questions.map((q: { id: string }) => q.id).sort()).toEqual(['attempts', 'line', 'stake']);
    expect(d1.program).toBeUndefined();
    const d2 = await compile(alice, { huddle_id: huddleId, draft_id: d1.draft_id, answers: [{ question_id: 'stake', answer: '$10' }, { question_id: 'attempts', answer: '5' }] });
    expect(d2.status).toBe('ready');
    expect(d2.draft_id).toBe(d1.draft_id);
    expect(d2.program.stake_each).toBe(10_000_000);
    expect(d2.program.legs[0].rule.attempts).toBe(5);
  });

  it('asks "Who\'s in?" in a bigger huddle and builds explicit participants and sides', async () => {
    t = await makeAppWith();
    const { users, huddleId } = await crew(t, ['Alice', 'Bob', 'Cara']);
    const [alice, , cara] = users as [TestUser, TestUser, TestUser];
    const d1 = await compile(alice, { huddle_id: huddleId, transcript: 'I bet the cup tower survives the fan for ten seconds, $2' });
    expect(d1.status).toBe('needs_clarification');
    expect(d1.questions.find((q: { id: string }) => q.id === 'who')).toMatchObject({ kind: 'multi', chips: ['Bob', 'Cara'] });
    const d2 = await compile(alice, { huddle_id: huddleId, draft_id: d1.draft_id, answers: [{ question_id: 'who', answer: 'Cara' }] });
    expect(d2.status).toBe('ready');
    expect(d2.program.participants).toEqual([alice.wallet.publicKey, cara.wallet.publicKey]);
    expect(d2.program.legs[0].rule).toEqual({ kind: 'holds', frames: 100 });
  });

  it('falls back to ai_judged for anything else', async () => {
    t = await makeAppWith();
    const { users, huddleId } = await crew(t, ['Alice', 'Bob']);
    const d = await compile(users[0]!, { huddle_id: huddleId, transcript: 'Sam finishes the hot sauce wing without drinking anything, $3' });
    expect(d.status).toBe('ready');
    expect(d.kind).toBe('ai_judged');
    expect(d.title).toBe('Sam finishes the hot sauce');
    expect(d.readback[0]).toMatch(/^Question: /);
  });

  it('transcribes dictation audio (mock STT header) and records the dictation hash', async () => {
    t = await makeAppWith();
    const { users, huddleId } = await crew(t, ['Alice', 'Bob']);
    const wav = fakeWav();
    const d = await compile(users[0]!, { huddle_id: huddleId, audio_b64: b64(wav) }, { 'x-mock-transcript': PAPER });
    expect(d.status).toBe('ready');
    const rec = identityHuddleServices(t.ctx).drafts.drafts.get(d.draft_id)!;
    expect(rec.dictation_sha256).toBe(bytesToHex(sha256(wav)));
    expect(rec.transcript).toBe(PAPER);
  });

  it('refuses non-members, unconfirmed members and empty input', async () => {
    t = await makeAppWith();
    const c = await crew(t, ['Alice', 'Bob'], false);
    const [alice, bob] = c.users as [TestUser, TestUser];
    expect((await post(t.app, bob, '/v1/bets/compile', { huddle_id: c.huddleId, transcript: PAPER })).json().error.code).toBe('WRONG_STATE');
    expect((await post(t.app, alice, '/v1/bets/compile', { huddle_id: c.huddleId })).json().error.code).toBe('DRAFT_INVALID');
    expect((await post(t.app, alice, '/v1/bets/compile', { huddle_id: 'nope', transcript: PAPER })).statusCode).toBe(404);
  });

  it('recompiles once with engine errors when the compiler emits invalid YAML', async () => {
    const seen: CompileRequest[] = [];
    const mock = new MockCompiler();
    const flaky: CompilerProvider = {
      name: 'flaky',
      async compile(req: CompileRequest): Promise<CompileResult> {
        seen.push(req);
        const r = await mock.compile(req);
        if (seen.length === 1) return { ...r, yaml: r.yaml!.replace('rule: count(success) >= 1 within attempts 3', 'rule: count(success) >= 1') };
        return r;
      },
    };
    t = await makeAppWith({}, { providers: { compiler: flaky } });
    const { users, huddleId } = await crew(t, ['Alice', 'Bob']);
    const d = await compile(users[0]!, { huddle_id: huddleId, transcript: PAPER });
    expect(d.status).toBe('ready');
    expect(seen).toHaveLength(2);
    expect(seen[1]!.errors?.[0]?.code).toBe('BAD_RULE');
    expect(seen[1]!.rejected_yaml).toContain('rule: count(success) >= 1\n');
  });

  it('marks a draft invalid when recompiling does not fix it', async () => {
    const broken: CompilerProvider = {
      name: 'broken',
      async compile(): Promise<CompileResult> {
        return { kind: 'rules', title: 'Broken', yaml: 'version: 2\nentities:\n  x: object("ball")\n', questions: [], labels: {}, source: 'test' };
      },
    };
    t = await makeAppWith({}, { providers: { compiler: broken } });
    const { users, huddleId } = await crew(t, ['Alice', 'Bob']);
    const d = await compile(users[0]!, { huddle_id: huddleId, transcript: 'whatever' });
    expect(d.status).toBe('invalid');
    expect(d.errors.length).toBeGreaterThan(0);
  });
});

describe('PATCH /drafts/:id (deterministic re-canonicalization)', () => {
  it('changes stake, limit and sides through the engine and clears acceptances', async () => {
    t = await makeAppWith();
    const { users, huddleId } = await crew(t, ['Alice', 'Bob']);
    const [alice, bob] = users as [TestUser, TestUser];
    const d = await compile(alice, { huddle_id: huddleId, transcript: PAPER });
    expect((await accept(bob, d.draft_id, d.program_hash)).r.statusCode).toBe(200);

    const patch = (u: TestUser, payload: Record<string, unknown>) =>
      t!.app.inject({ method: 'PATCH', url: `/v1/drafts/${d.draft_id}`, headers: auth(u), payload });
    const p1 = (await patch(alice, { stake_each_units: 1_000_000, time_limit_s: 200 })).json();
    expect(p1.program.stake_each).toBe(1_000_000);
    expect(p1.program.time_limit_s).toBe(200);
    expect(p1.program_hash).toBe(programHash(p1.program));
    expect(p1.program_hash).not.toBe(d.program_hash);
    expect(p1.readback).toContain('$1.00 each');
    expect(p1.frozen).toBe(false);
    expect(p1.participants[1].accepted).toBe(false);

    expect((await patch(alice, { stake_each_units: 5 })).json().error.code).toBe('BAD_STAKE');
    expect((await patch(bob, { stake_each_units: 2_000_000 })).json().error.code).toBe('WRONG_STATE');
    // Bob is the shooter: he cannot be dropped from the participants
    const p2 = (await patch(alice, { participants: [alice.user.id] })).json();
    expect(p2.status).toBe('invalid');
  });

  it('remembers chips set before a program exists', async () => {
    t = await makeAppWith();
    const { users, huddleId } = await crew(t, ['Alice', 'Bob']);
    const alice = users[0]!;
    const d1 = await compile(alice, { huddle_id: huddleId, transcript: 'I bet Bob cannot do it with a paper ball in three tries' });
    expect(d1.status).toBe('needs_clarification');
    const p = await t.app.inject({ method: 'PATCH', url: `/v1/drafts/${d1.draft_id}`, headers: auth(alice), payload: { time_limit_s: 300 } });
    expect(p.json().status).toBe('needs_clarification');
    const d2 = await compile(alice, { huddle_id: huddleId, draft_id: d1.draft_id, answers: [{ question_id: 'stake', answer: '$1' }] });
    expect(d2.status).toBe('ready');
    expect(d2.program.time_limit_s).toBe(300);
  });
});

describe('"I accept" (§4.2, §8.3, §12.3)', () => {
  it('accepts with the spoken phrase, the matching voice and a device signature', async () => {
    t = await makeAppWith();
    const { users, huddleId } = await crew(t, ['Alice', 'Bob']);
    const [alice, bob] = users as [TestUser, TestUser];
    const d = await compile(alice, { huddle_id: huddleId, transcript: PAPER });

    // the creator does not accept
    expect((await get(t.app, alice, `/v1/drafts/${d.draft_id}/accept/challenge`)).json().error.code).toBe('WRONG_STATE');
    const { r, ch } = await accept(bob, d.draft_id, d.program_hash);
    expect(ch.phrase).toMatch(/^I accept [a-z]+ [a-z]+$/);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ accepted: true, participant_index: 1 });
    expect(r.json().cos_bps).toBeGreaterThanOrEqual(5000);
    const view = (await get(t.app, alice, `/v1/drafts/${d.draft_id}`)).json();
    expect(view.frozen).toBe(true);
    expect(view.participants[1].accepted).toBe(true);

    // a recompile clears acceptances
    const re = await compile(alice, { huddle_id: huddleId, draft_id: d.draft_id, transcript: 'make it 5 tries' });
    expect(re.frozen).toBe(false);
    expect(re.participants[1].accepted).toBe(false);
  });

  it('rejects the wrong voice, an unheard phrase, a bad signature and stale challenges', async () => {
    t = await makeAppWith();
    const { users, huddleId } = await crew(t, ['Alice', 'Bob']);
    const [alice, bob] = users as [TestUser, TestUser];
    const d = await compile(alice, { huddle_id: huddleId, transcript: PAPER });

    const impostor = await accept(bob, d.draft_id, d.program_hash, { 'x-mock-subject': alice.user.id });
    expect(impostor.r.json().error.code).toBe('VOICE_NOT_MATCHED');
    const unheard = await accept(bob, d.draft_id, d.program_hash, { 'x-mock-transcript': 'i accept nothing' });
    expect(unheard.r.json().error.code).toBe('PHRASE_NOT_HEARD');

    const ch = (await get(t.app, bob, `/v1/drafts/${d.draft_id}/accept/challenge`)).json();
    const wav = fakeWav();
    const wrongSig = alice.wallet.sign(acceptSigMessage(d.program_hash, wav));
    const bad = await post(t.app, bob, `/v1/drafts/${d.draft_id}/accept`, { challenge_id: ch.challenge_id, audio_b64: b64(wav), accept_sig_b64: toBase64(wrongSig) });
    expect(bad.statusCode).toBe(400);

    // terms changed after the challenge was issued → CHALLENGE_EXPIRED
    await t.app.inject({ method: 'PATCH', url: `/v1/drafts/${d.draft_id}`, headers: auth(alice), payload: { stake_each_units: 2_000_000 } });
    const newHash = (await get(t.app, bob, `/v1/drafts/${d.draft_id}`)).json().program_hash;
    const goodSig = bob.wallet.sign(acceptSigMessage(newHash, wav));
    const stale = await post(t.app, bob, `/v1/drafts/${d.draft_id}/accept`, { challenge_id: ch.challenge_id, audio_b64: b64(wav), accept_sig_b64: toBase64(goodSig) });
    expect(stale.json().error.code).toBe('CHALLENGE_EXPIRED');
  });

  it('diarizes: picks the speaker who said the phrase', async () => {
    t = await makeAppWith();
    const { users, huddleId } = await crew(t, ['Alice', 'Bob']);
    const [alice, bob] = users as [TestUser, TestUser];
    const d = await compile(alice, { huddle_id: huddleId, transcript: PAPER });
    const ch = (await get(t.app, bob, `/v1/drafts/${d.draft_id}/accept/challenge`)).json();
    const words = ch.phrase.split(' ').slice(2);
    // a two-speaker transcript: only speaker_1 says the phrase
    const stt = t.ctx.providers.stt;
    const orig = stt.transcribe.bind(stt);
    stt.transcribe = async () => ({
      text: `come on ${ch.phrase}`,
      segments: [
        { start_ms: 0, end_ms: 400, speaker: 'speaker_0', text: 'come on' },
        { start_ms: 500, end_ms: 1400, speaker: 'speaker_1', text: `I accept ${words[0]} ${words[1]}` },
      ],
      audio_events: [{ t_ms: 450, label: 'laughter' }],
    });
    try {
      const wav = fakeWav();
      const r = await post(t.app, bob, `/v1/drafts/${d.draft_id}/accept`, {
        challenge_id: ch.challenge_id,
        audio_b64: b64(wav),
        accept_sig_b64: toBase64(bob.wallet.sign(acceptSigMessage(d.program_hash, wav))),
      });
      expect(r.json().accepted).toBe(true);
    } finally {
      stt.transcribe = orig;
    }
  });
});

describe('create_bet (§4.2, §9.4 #2)', () => {
  it('needs every counterparty, then creates the bet with the acceptance hash (creator + oracle sign)', async () => {
    t = await makeAppWith();
    const { users, huddleId } = await crew(t, ['Alice', 'Bob']);
    const [alice, bob] = users as [TestUser, TestUser];
    const dictation = fakeWav();
    const d = await compile(alice, { huddle_id: huddleId, audio_b64: b64(dictation) }, { 'x-mock-transcript': PAPER });
    const svc = identityHuddleServices(t.ctx);

    await expect(svc.createBet(rec(alice), d.draft_id)).rejects.toMatchObject({ code: 'NOT_ACCEPTED' });
    const { wav, sig } = await accept(bob, d.draft_id, d.program_hash);
    await expect(svc.createBet(rec(bob), d.draft_id)).rejects.toMatchObject({ code: 'WRONG_STATE' });

    const prepared = await svc.createBet(rec(alice), d.draft_id);
    const expectedAah = acceptanceAudioHash([sha256(dictation), sha256(concatBytes(sha256(wav), sig))]);
    expect(prepared.acceptance_audio_hash).toBe(bytesToHex(expectedAah));
    expect(prepared.sign.summary).toBe('Create bet $5.00 each');
    const res = await submitSign(t.app, alice, prepared.sign);
    expect(res.status).toBe('confirmed');

    const bet = await t.ctx.chain.getBet(prepared.bet);
    expect(bet).not.toBeNull();
    expect(bet!.participants.slice(0, 2)).toEqual([alice.wallet.publicKey, bob.wallet.publicKey]);
    expect(bet!.program_hash).toBe(d.program_hash);
    expect(bet!.acceptance_audio_hash).toBe(prepared.acceptance_audio_hash);
    expect(bet!.flags).toBe(1);
    expect(bet!.side_b_mask).toBe(2);
    expect(bet!.oracle).toBe(t.ctx.chain.oracle);

    const stored = svc.drafts.drafts.get(d.draft_id)!;
    expect(stored.bet).toMatchObject({ address: prepared.bet, status: 'confirmed' });
    // the draft is now locked
    expect((await post(t.app, alice, '/v1/bets/compile', { huddle_id: huddleId, draft_id: d.draft_id, transcript: 'x' })).json().error.code).toBe('WRONG_STATE');
    await expect(svc.createBet(rec(alice), d.draft_id)).rejects.toMatchObject({ code: 'WRONG_STATE' });
  });

  it('uses a zero h_0 for typed bets and flags ai_judged', async () => {
    t = await makeAppWith();
    const { users, huddleId } = await crew(t, ['Alice', 'Bob']);
    const [alice, bob] = users as [TestUser, TestUser];
    const d = await compile(alice, { huddle_id: huddleId, transcript: 'Sam finishes the wing, $3' });
    const { wav, sig } = await accept(bob, d.draft_id, d.program_hash);
    const svc = identityHuddleServices(t.ctx);
    const prepared = await svc.createBet(rec(alice), d.draft_id);
    expect(prepared.acceptance_audio_hash).toBe(bytesToHex(acceptanceAudioHash([new Uint8Array(32), sha256(concatBytes(sha256(wav), sig))])));
    expect((await submitSign(t.app, alice, prepared.sign)).status).toBe('confirmed');
    expect((await t.ctx.chain.getBet(prepared.bet))!.flags).toBe(2);
    void fromBase64;
  });
});

describe('agent + webhook tool', () => {
  it('returns a mock agent session and compiles through the ElevenLabs tool webhook', async () => {
    t = await makeAppWith();
    const { users, huddleId } = await crew(t, ['Alice', 'Bob']);
    const s = await post(t.app, users[0]!, '/v1/agent/session', { huddle_id: huddleId });
    expect(s.json()).toEqual({ mode: 'mock', signed_url: null });
    const r = await t.app.inject({
      method: 'POST',
      url: '/v1/webhooks/elevenlabs/tool',
      headers: { 'x-verdict-tool-secret': 'tool-secret' },
      payload: { huddle_id: huddleId, transcript: PAPER },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: 'ready', huddle_id: huddleId, title: 'Paper ball shot' });
  });
});
