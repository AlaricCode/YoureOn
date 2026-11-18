// The appeals panel (src/appeal/panel.ts; API-CONTRACT §7.2, SCHEMAS §7) with fake vendors: no
// network, no key, no DB. Seat k = PANEL_SEATS[k]; each seat has its own budget; a missing key,
// a timeout, an error, a refusal or bad output abstains; the voters never see the ruling.
import { describe, expect, it } from 'vitest';
import { AppealVote, decideAppeal, PANEL_SEATS } from '@youre-on/shared/appeal';
import { Terms } from '@youre-on/shared/terms';
import { castVote, panelParts, runPanel, voteReason, type PanelInput } from '../src/appeal/panel';
import { LiveLlm } from '../src/providers/live/llm';
import { MockLlm, type MockReply } from '../src/providers/mock/llm';
import type { ChatRequest, LlmProvider } from '../src/providers/types';
import { skillTerms } from '../../../packages/shared/test/fixtures';

const terms = Terms.parse(skillTerms());
const APPEAL = 'e9f8a7b6-c5d4-4e3f-a2b1-c0d9e8f7a6b5';
const jpeg = (i: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, i, 0xff, 0xd9]);
const input = (over: Partial<PanelInput> = {}): PanelInput => ({
  appeal_id: APPEAL,
  bet_id: terms.bet_id,
  terms,
  performer_name: 'Jake',
  evidence: {
    kind: 'camera',
    frames: Array.from({ length: 8 }, (_, i) => ({ t_ms: 1200 + i * 250, bytes: jpeg(i) })),
  },
  ...over,
});
const verdict = (claim: 'MET' | 'NOT_MET' | 'UNCLEAR', confidence: number): MockReply => ({
  value: {
    claim_result: claim,
    confidence,
    reason: `It is ${claim} in frame 7.`,
    cited_frames: [7],
    contested: false,
  },
});
const now = () => Date.now();
/** A responder per vendor (seat order: anthropic, openai, google). */
const byVendor = (r: Record<string, MockReply | (() => Promise<MockReply>)>) =>
  new MockLlm((req: ChatRequest<unknown>) => {
    const v = r[req.vendor];
    if (!v) return { fail: 'error', message: 'unscripted' };
    return typeof v === 'function' ? v() : v;
  });

describe('appeal panel', () => {
  it('three vendors in parallel; 2-1 for the yes party flips a NOT_MET ruling', async () => {
    const llm = byVendor({
      anthropic: verdict('MET', 0.91),
      openai: verdict('MET', 0.71), // counts: the panel floor is 0.6, not the judge's 0.8
      google: verdict('NOT_MET', 0.88),
    });
    const votes = (await runPanel(llm, input(), { now })).map((c) => c.vote);
    expect(votes.map((v) => [v.seat, v.provider, v.status, v.outcome, v.counted_as])).toEqual([
      [0, 'anthropic', 'ok', 'B_WINS', 'B_WINS'], // yes_party B: MET -> B wins
      [1, 'openai', 'ok', 'B_WINS', 'B_WINS'],
      [2, 'google', 'ok', 'A_WINS', 'A_WINS'],
    ]);
    for (const v of votes) expect(AppealVote.safeParse(v).success).toBe(true);
    expect(votes[0]!.model).toBe('anthropic/mock/claude-opus-5-5');
    expect(decideAppeal('A_WINS', votes)).toMatchObject({
      final_outcome: 'B_WINS',
      decided_by: 'majority',
      flipped: true,
    });
    // every vendor got its own call, each with the panel's structured output
    expect(llm.calls.map((c) => c.vendor).sort()).toEqual([...PANEL_SEATS].sort());
    expect(new Set(llm.calls.map((c) => c.output.name))).toEqual(new Set(['appeal_vote']));
  });

  it('a missing key (not_configured) abstains; all abstain upholds the original', async () => {
    const llm = new LiveLlm({ keys: {} }); // no key at all: nothing is sent anywhere
    const votes = (await runPanel(llm, input(), { now })).map((c) => c.vote);
    expect(votes.map((v) => [v.status, v.outcome, v.confidence, v.reason, v.counted_as])).toEqual([
      ['error', 'REDO', 0, '', 'ABSTAIN'],
      ['error', 'REDO', 0, '', 'ABSTAIN'],
      ['error', 'REDO', 0, '', 'ABSTAIN'],
    ]);
    expect(decideAppeal('A_WINS', votes)).toMatchObject({
      final_outcome: 'A_WINS',
      decided_by: 'upheld_no_majority',
      flipped: false,
      tally: { A_WINS: 0, B_WINS: 0, ABSTAIN: 3 },
    });
    // no LLM provider at all (a bare deps bag) is the same
    const none = await castVote(null, 1, input(), { now });
    expect(none.vote).toMatchObject({ provider: 'openai', status: 'error', counted_as: 'ABSTAIN' });
  });

  it('a vendor that hangs times out at its own budget; the other two decide', async () => {
    const llm = byVendor({
      anthropic: verdict('NOT_MET', 0.9),
      openai: () => new Promise<MockReply>(() => undefined), // never answers
      google: verdict('NOT_MET', 0.83),
    });
    const t0 = Date.now();
    const votes = (await runPanel(llm, input(), { now, timeoutMs: 150 })).map((c) => c.vote);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(votes[1]).toMatchObject({
      provider: 'openai',
      status: 'timeout',
      outcome: 'REDO',
      counted_as: 'ABSTAIN',
    });
    expect(votes[1]!.latency_ms).toBeGreaterThanOrEqual(140);
    expect(decideAppeal('B_WINS', votes)).toMatchObject({
      final_outcome: 'A_WINS',
      tally: { A_WINS: 2, B_WINS: 0, ABSTAIN: 1 },
      flipped: true,
    });
  });

  it('errors, refusals, bad output, UNCLEAR and low confidence all abstain; a throwing provider too', async () => {
    const llm = byVendor({
      anthropic: { fail: 'refusal' },
      openai: { text: 'I think it landed, no JSON here' },
      google: verdict('UNCLEAR', 0.95),
    });
    const votes = (await runPanel(llm, input(), { now })).map((c) => c.vote);
    expect(votes.map((v) => [v.status, v.counted_as])).toEqual([
      ['error', 'ABSTAIN'],
      ['error', 'ABSTAIN'],
      ['ok', 'ABSTAIN'], // UNCLEAR -> REDO -> ABSTAIN
    ]);
    const low = await castVote(byVendor({ anthropic: verdict('MET', 0.55) }), 0, input(), { now });
    expect(low.vote).toMatchObject({ status: 'ok', outcome: 'B_WINS', counted_as: 'ABSTAIN' });
    const throwing: LlmProvider = {
      name: 'mock',
      chat: () => Promise.reject(new Error('MOCK_PROVIDER_IN_PRODUCTION')),
    };
    expect((await castVote(throwing, 2, input(), { now })).vote).toMatchObject({
      provider: 'google',
      status: 'error',
      counted_as: 'ABSTAIN',
    });
  });

  it('the voters see the terms and the frames, never the ruling; a market bet gets its record', () => {
    const parts = panelParts(input());
    const text = parts
      .filter((p) => p.kind === 'text')
      .map((p) => (p as { text: string }).text)
      .join('\n');
    expect(text).toContain(terms.claim);
    expect(parts.filter((p) => p.kind === 'image')).toHaveLength(8);
    expect(text).not.toMatch(/ruling|A_WINS|B_WINS|judge said|original/i);
    const market = panelParts(
      input({
        performer_name: null,
        evidence: { kind: 'gemini', record_canonical: '{"kind":"gemini_settlement"}' },
      }),
    );
    expect(market.filter((p) => p.kind === 'image')).toHaveLength(0);
    expect(JSON.stringify(market)).toContain('gemini_settlement');
  });

  it('voteReason: NText(280, 0): control chars out, single-spaced, cut on a code point', () => {
    expect(voteReason('  Lands\n\ton its\u0000 cap  ')).toBe('Lands on its cap');
    // zod's max counts UTF-16 units: 140 emoji fit, and no surrogate pair is split
    const cut = voteReason('😀'.repeat(300));
    expect(cut.length).toBe(280);
    expect(Array.from(cut)).toHaveLength(140);
    expect(voteReason(`a${'😀'.repeat(300)}`).length).toBe(279);
  });
});
