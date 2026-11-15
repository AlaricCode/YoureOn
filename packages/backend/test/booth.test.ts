import { afterEach, describe, expect, it } from 'vitest';
import {
  BET_STATE,
  PANEL_CONF_FLOOR_BPS,
  checkPanelInstruction,
  judgeCommitHex,
  parseEd25519PanelIxData,
  panelMessage,
  verifyExhibitChainProof,
  verifyPanelSignatures,
  hexToBytes,
  type Exhibit,
} from '@verdict/engine';
import { createHash } from 'node:crypto';
import { betWitnesses, exhibitSpans, mergeSpans } from '../src/booth/exhibits.js';
import { cutAudio, cutClip, encodeMjpeg, parseMjpeg, type LoadedChunk } from '../src/booth/media.js';
import { JudgeSeat, acceptedReveals, exhibitSlots, panelIxData, rule, validateBrief, validateVote } from '../src/booth/protocol.js';
import { generateKeypair } from '../src/crypto/keys.js';
import type { AdvocateBrief, BoothCase, JudgeProvider, JudgeVote } from '../src/providers/types.js';
import { boothService } from '../src/routes/replayBooth.js';
import { silentWav, decodeWav } from '../src/util/wav.js';
import { auth, login, makeApp, type TestApp } from './appHelpers.js';
import { disputedAiJudgedBet, fakeMjpeg, flush } from './bweHelpers.js';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.app.close();
  t = null;
});

const EX = (id: string, kind: Exhibit['kind'] = 'clip'): Exhibit => ({
  id,
  kind,
  witness: 'cam1',
  t_start_ms: 0,
  t_end_ms: 1,
  uri: '',
  sha256: '00'.repeat(32),
  chain_proofs: [],
});

describe('booth protocol (§10.2–§10.5)', () => {
  it('validates advocate briefs: slots, citation regex, known witnesses, claim length', () => {
    expect(exhibitSlots(false)).toBe(3);
    expect(exhibitSlots(true)).toBe(4);
    const b = validateBrief(
      {
        side: 1,
        claim: 'x'.repeat(700),
        citations: ['cam1@12.4s', 'cam1@12.4s', 'mic2@3s', 'cam9@1s', 'cam1@12.45s', 'bogus', 7],
        exhibits: ['E1', 'E2', 'E9', 'E1', 'E3', 'E4'],
      },
      0,
      3,
      [EX('E1'), EX('E2'), EX('E3'), EX('E4')],
      ['cam1', 'mic1'],
    );
    expect(b.side).toBe(0);
    expect(b.claim).toHaveLength(600);
    expect(b.exhibits).toEqual(['E1', 'E2', 'E3']);
    expect(b.citations).toEqual(['cam1@12.4s']);
    expect(validateBrief(null, 1, 3, [], [])).toEqual({ side: 1, claim: '', citations: [], exhibits: [] });
  });

  it('validates judge votes', () => {
    expect(validateVote({ outcome: 2, confidence_bps: 8000, rationale: 'r'.repeat(1200) })!.rationale).toHaveLength(1000);
    expect(validateVote({ outcome: 3, confidence_bps: 8000, rationale: '' })).toBeNull();
    expect(validateVote({ outcome: 1, confidence_bps: 10001, rationale: '' })).toBeNull();
    expect(validateVote({ outcome: 1, confidence_bps: 1.5, rationale: '' })).toBeNull();
    expect(validateVote('nope')).toBeNull();
  });

  it('commit–reveal: commits match the engine; tampered reveals are discarded; quorum with the confidence floor', () => {
    const bet = generateKeypair().publicKey;
    const seats = [
      new JudgeSeat(bet, 0, { outcome: 1, confidence_bps: 9000, rationale: 'a' }),
      new JudgeSeat(bet, 1, { outcome: 1, confidence_bps: PANEL_CONF_FLOOR_BPS - 1, rationale: 'b' }),
      new JudgeSeat(bet, 2, { outcome: 1, confidence_bps: 7000, rationale: 'c' }),
    ];
    const r0 = seats[0]!.reveal();
    expect(seats[0]!.commit).toBe(
      judgeCommitHex({ bet, judge: 0, outcome: 1, confidence_bps: 9000, rationale: 'a', nonce: hexToBytes(r0.nonce) }),
    );
    const commits = seats.map((s, j) => ({ judge: j, commit: s.commit, at_ms: 1 }));
    const reveals = seats.map((s) => s.reveal());
    const tampered = { ...reveals[2]!, outcome: 2 as const };
    const accepted = acceptedReveals(bet, commits, [reveals[0]!, reveals[1]!, tampered]);
    expect(accepted.map((r) => r.judge)).toEqual([0, 1]);
    // judge 1 is under the floor and judge 2's reveal was discarded ⇒ 1 vote ⇒ No contest, judges 0+1 sign
    expect(rule(accepted)).toEqual({ outcome: 0, votes: [0, 1, 0], signers: [0, 1] });
    expect(rule(acceptedReveals(bet, commits, reveals))).toEqual({ outcome: 1, votes: [0, 2, 0], signers: [0, 2] });
  });

  it('panel signatures produce the 367-byte §9.7 instruction the program accepts', () => {
    const judges = [generateKeypair(), generateKeypair(), generateKeypair()];
    const programId = generateKeypair().publicKey;
    const bet = generateKeypair().publicKey;
    const root = 'ab'.repeat(32);
    const ph = 'cd'.repeat(32);
    const { data, message } = panelIxData({
      programId,
      bet,
      outcome: 2,
      evidenceRoot: root,
      programHash: ph,
      betJudges: judges.map((j) => j.publicKey),
      keys: judges,
      signers: [0, 2],
    });
    expect(data).toHaveLength(367);
    expect(Buffer.from(message).equals(Buffer.from(panelMessage(programId, bet, 2, root, ph)))).toBe(true);
    const parsed = parseEd25519PanelIxData(data)!;
    expect(parsed.pk0).toBe(judges[0]!.publicKey);
    expect(parsed.pk1).toBe(judges[2]!.publicKey);
    expect(verifyPanelSignatures(parsed)).toBe(true);
    expect(checkPanelInstruction).toBeTypeOf('function');
    expect(() =>
      panelIxData({ programId, bet, outcome: 0, evidenceRoot: root, programHash: ph, betJudges: judges.map((j) => j.publicKey), keys: [judges[0]!], signers: [0, 1] }),
    ).toThrow(/not held/);
  });
});

describe('exhibit spans and media (§10.1)', () => {
  it('decisive spans ±2 s merged; no decisive frame ⇒ last 6 s; AI-judged ⇒ tail + up to 4 evenly spaced 4 s clips', () => {
    expect(exhibitSpans([30, 50, 200], 30_000, false)).toEqual([
      { t_start_ms: 1000, t_end_ms: 7000 },
      { t_start_ms: 18000, t_end_ms: 22000 },
    ]);
    expect(exhibitSpans([], 30_000, false)).toEqual([{ t_start_ms: 24000, t_end_ms: 30000 }]);
    const ai = exhibitSpans([], 30_000, true);
    expect(ai).toHaveLength(5);
    expect(ai.at(-1)).toEqual({ t_start_ms: 24000, t_end_ms: 30000 });
    for (const s of ai.slice(0, 4)) expect(s.t_end_ms - s.t_start_ms).toBe(4000);
    expect(ai[0]!.t_start_ms).toBe(0);
    expect(ai[3]!.t_end_ms).toBe(24000);
    expect(exhibitSpans([], 3000, true)).toEqual([{ t_start_ms: 0, t_end_ms: 3000 }]);
    expect(mergeSpans([{ t_start_ms: 5, t_end_ms: 9 }, { t_start_ms: 0, t_end_ms: 5 }])).toEqual([{ t_start_ms: 0, t_end_ms: 9 }]);
  });

  const meta = (index: number, format: string, start: number) => ({
    witness_key: 'w',
    index,
    kind: format === 'wav' ? 1 : 0,
    body_format: format,
    start_ms: start,
    duration_ms: 5000,
    body_sha256: '',
    chunk_hash: null,
    prev_hash: null,
    final: false,
    late: false,
  });

  it('cuts MJPEG by frame time and WAV by samples, reporting the chunks used', () => {
    const chunks: LoadedChunk[] = [0, 1].map((i) => ({ meta: meta(i, 'mjpeg', i * 5000), body: fakeMjpeg(i * 5000, 5000), session_start_ms: i * 5000 }));
    const clip = cutClip(chunks, { t_start_ms: 4000, t_end_ms: 6000 }, 0)!;
    expect(clip.used).toEqual([0, 1]);
    const frames = parseMjpeg(clip.bytes);
    expect(frames.map((f) => f.t_ms)).toEqual(Array.from({ length: 20 }, (_, i) => 4000 + i * 100));
    expect(encodeMjpeg(frames)).toEqual(clip.bytes);
    // device-local offset: session = local − offset
    expect(parseMjpeg(cutClip(chunks, { t_start_ms: 0, t_end_ms: 1000 }, 3000)!.bytes)[0]!.t_ms).toBe(3000);

    const wavs: LoadedChunk[] = [0, 1].map((i) => ({ meta: meta(i, 'wav', i * 5000), body: silentWav(5000), session_start_ms: i * 5000 }));
    const audio = cutAudio(wavs, { t_start_ms: 4500, t_end_ms: 5500 })!;
    expect(audio.used).toEqual([0, 1]);
    expect(decodeWav(audio.bytes).samples.length).toBe(16000);

    const mp4: LoadedChunk[] = [0, 1].map((i) => ({ meta: meta(i, 'mp4', i * 5000), body: new Uint8Array([i]), session_start_ms: i * 5000 }));
    expect(cutClip(mp4, { t_start_ms: 4000, t_end_ms: 9000 }, 0)).toMatchObject({ used: [1], mime: 'video/mp4' });
    expect(cutClip(mp4, { t_start_ms: 20000, t_end_ms: 21000 }, 0)).toBeNull();
  });
});

describe('replay booth end to end (mock chain, mock providers)', () => {
  it('Disputed (AI_JUDGED) → exhibits with chain proofs → briefs → commit–reveal → ruling → Ed25519 + settle_panel', async () => {
    t = await makeApp();
    const a = await login(t.app, 'alex@example.com');
    const b = await login(t.app, 'maya@example.com');
    const sent: string[] = [];
    const hub = t.ctx.hub;
    const origNotify = hub.notify.bind(hub);
    hub.notify = (userId, title, betId) => {
      sent.push(`${userId === a.user.id ? 'a' : 'b'}:${title}`);
      return origNotify(userId, title, betId);
    };
    const { bet } = await disputedAiJudgedBet(t.ctx, a.wallet, b.wallet, [
      { kind: 0, label: 'cam1', format: 'mjpeg', chunks: 2, user_id: a.user.id },
      { kind: 1, label: 'mic1', format: 'wav', chunks: 2, user_id: b.user.id },
    ]);
    expect((await t.ctx.chain.getBet(bet))!.state).toBe(BET_STATE.Disputed);

    const rec = (await boothService(t.ctx).ensure(bet))!;
    expect(rec.status).toBe('submitted');
    expect(rec.tx_signature).toBeTruthy();

    // Exhibits: AI-judged ⇒ one extra 4 s clip + the last 6 s, cam + mic each, then transcript/program/flags.
    const kinds = rec.exhibits.map((e) => `${e.kind}:${e.witness ?? ''}`);
    expect(kinds).toEqual(['clip:cam1', 'audio:mic1', 'clip:cam1', 'audio:mic1', 'transcript:mic1', 'program:', 'flags:']);
    expect(rec.exhibits.map((e) => e.id)).toEqual(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']);
    const account = (await t.ctx.chain.getBet(bet))!;
    const ws = betWitnesses(account);
    for (const e of rec.exhibits.filter((x) => x.kind === 'clip' || x.kind === 'audio')) {
      expect(e.chain_proofs).toHaveLength(1);
      const w = ws.find((x) => x.label === e.witness)!;
      const v = verifyExhibitChainProof(e.chain_proofs[0]!, {
        witness_key: w.key,
        evidence_root: account.evidence_root,
        n_witnesses: ws.length,
        genesis: { bet, beacon_slot: account.beacon_slot, beacon_hash: hexToBytes(account.beacon_hash) },
      });
      expect(v.ok).toBe(true);
      const bytes = t.ctx.blobs.getExhibit(bet, e.id)!;
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(e.sha256);
    }

    // Briefs (one per side), three commits recorded before the reveals, quorum for side 1 ("yes" ⇒ if_true = B).
    expect(rec.briefs.map((x) => x.side)).toEqual([0, 1]);
    expect(rec.commits.map((c) => c.judge)).toEqual([0, 1, 2]);
    expect(rec.reveals).toHaveLength(3);
    expect(rec.ruling).toEqual({ outcome: 2, votes: [0, 0, 3] });
    expect(account.state).toBe(BET_STATE.Settled);
    expect(account.final_winner_mask).toBe(0b10);
    expect(await t.ctx.chain.getUsdcBalance(b.wallet.publicKey)).toBe(50_000_000n + 3_000_000n);

    // Routes
    const res = await t.app.inject({ method: 'GET', url: `/v1/bets/${bet}/booth`, headers: auth(a) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'submitted', ruling: { outcome: 2 }, tx_signature: rec.tx_signature });
    expect(Object.keys(res.json()).sort()).toEqual(['briefs', 'commits', 'exhibits', 'reveals', 'ruling', 'status', 'tx_signature']);
    const e1 = await t.app.inject({ method: 'GET', url: `/v1/bets/${bet}/exhibits/E1`, headers: auth(a) });
    expect(e1.statusCode).toBe(200);
    expect(e1.headers['content-type']).toBe('video/x-motion-jpeg');
    expect(createHash('sha256').update(e1.rawPayload).digest('hex')).toBe(rec.exhibits[0]!.sha256);
    const e6 = await t.app.inject({ method: 'GET', url: `/v1/bets/${bet}/exhibits/E6`, headers: auth(a) });
    expect(e6.json()).toMatchObject({ program_hash: account.program_hash, preruling: { code: 3, reason: 11 } });
    expect((await t.app.inject({ method: 'GET', url: `/v1/bets/${bet}/exhibits/E99`, headers: auth(a) })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/v1/bets/${bet}/booth` })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: `/v1/bets/${generateKeypair().publicKey}/booth`, headers: auth(a) })).statusCode).toBe(404);

    // Notifications: Replay booth (Disputed), then won/lost (Settled).
    await flush(t.ctx);
    expect(sent).toEqual(expect.arrayContaining(['a:Replay booth', 'b:Replay booth', 'b:You won', 'a:You lost']));

    // Idempotent: a second run does nothing more.
    expect((await boothService(t.ctx).ensure(bet))!.tx_signature).toBe(rec.tx_signature);
  });

  it('absent / low-confidence judges ⇒ No contest signed by judges 0 and 1 ⇒ Refunded', async () => {
    t = await makeApp();
    const a = await login(t.app, 'alex@example.com');
    const b = await login(t.app, 'maya@example.com');
    const slow: JudgeProvider = { name: 'slow', videoNative: true, judge: () => new Promise<JudgeVote>(() => {}) };
    const unsure: JudgeProvider = { name: 'unsure', videoNative: false, judge: async () => ({ outcome: 1, confidence_bps: 5000, rationale: 'unsure' }) };
    const sure: JudgeProvider = { name: 'sure', videoNative: false, judge: async () => ({ outcome: 1, confidence_bps: 9000, rationale: 'sure' }) };
    t.ctx.providers.judges = [slow, unsure, sure];
    const seen: { c: BoothCase; briefs: AdvocateBrief[] }[] = [];
    const orig = sure.judge;
    sure.judge = async (c, briefs, j) => {
      seen.push({ c, briefs });
      return orig(c, briefs, j);
    };
    boothService(t.ctx).commitTimeoutMs = 50;
    const { bet } = await disputedAiJudgedBet(t.ctx, a.wallet, b.wallet);
    // The registered service may already be running from the Disputed trigger; wait for it, then compare.
    await boothService(t.ctx).ensure(bet);
    const rec = boothService(t.ctx).get(bet)!;
    expect(rec.commits.map((c) => c.judge)).not.toContain(0);
    expect(rec.ruling).toEqual({ outcome: 0, votes: [0, 1, 0] });
    expect(rec.status).toBe('submitted');
    const acct = (await t.ctx.chain.getBet(bet))!;
    expect(acct.state).toBe(BET_STATE.Refunded);
    expect(acct.refund_reason).toBe(2);
    // judges only see cited exhibits plus program/flags
    expect(seen[0]!.c.exhibits.every((e) => ['program', 'flags'].includes(e.kind) || seen[0]!.briefs.some((x) => x.exhibits.includes(e.id)))).toBe(true);
  }, 20_000);
});
