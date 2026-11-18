// The stage's spoken lines (stage-voice.ts): one composer for the server's ElevenLabs clip and the
// projector's speechSynthesis fallback, the [EVENT] line parser the PAID / VOIDED lines read, and
// the stage.voice / stage.cue control frames (api.ts).
import { describe, expect, it } from 'vitest';
import { StageAudioResponse, WsServerControlFrame, WsStageCue } from '../src/api';
import { CACHED_RULING_MODEL, GEMINI_SETTLEMENT_MODEL, isCachedRulingModel } from '../src/ruling';
import {
  capLine,
  CLIP_ID_RE,
  hasPhoneJudge,
  leftToPhoneJudge,
  parseEventLine,
  PHONE_JUDGE_EVENT,
  STAGE_LINE_MAX,
  stageLineFor,
  stageTtsPath,
  VoicedEventType,
} from '../src/stage-voice';
import { rulingExample } from './fixtures';

const BET = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';
const names = { A: 'Logan', B: 'Jake' };
const ruling = (over: Record<string, unknown> = {}) => ({ ...rulingExample(), ...over });
const vote = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  appeal_id: '1e2d3c4b-5a69-4788-9a0b-c1d2e3f40516',
  bet_id: BET,
  seat: 1,
  provider: 'openai',
  model: 'openai/gpt-5.5',
  status: 'ok',
  outcome: 'A_WINS',
  confidence: 0.91,
  reason: 'The bottle rests on its cap in frame 7, not its base.',
  counted_as: 'A_WINS',
  latency_ms: 2100,
  created_at: '2026-11-21T18:08:00.000Z',
  ...over,
});

describe('parseEventLine (API-CONTRACT §4.5 grammar)', () => {
  it('reads the name, bare and quoted values, and the instruction', () => {
    expect(
      parseEventLine(
        '[EVENT] PAID winner=Jake amount=$10.00 to_a=$0.00 to_b=$10.00 :: Congratulate Jake in one line.',
      ),
    ).toEqual({
      name: 'PAID',
      kv: { winner: 'Jake', amount: '$10.00', to_a: '$0.00', to_b: '$10.00' },
      instruction: 'Congratulate Jake in one line.',
    });
    expect(
      parseEventLine('[EVENT] RULING winner="Mary Jo" reason="a :: b, c=d" :: Deliver it.'),
    ).toEqual({
      name: 'RULING',
      kv: { winner: 'Mary Jo', reason: 'a :: b, c=d' },
      instruction: 'Deliver it.',
    });
  });

  it('refuses what is not an [EVENT] line', () => {
    expect(parseEventLine('Jake wins')).toBeNull();
    expect(parseEventLine('[EVENT] PAID winner="Jake :: x')).toBeNull();
    expect(parseEventLine('[EVENT] PAID =x :: y')).toBeNull();
  });
});

describe('stageLineFor', () => {
  it('ruling.issued: the winner by name, then the reason, in the judge voice', () => {
    expect(
      stageLineFor(
        { type: 'ruling.issued', payload: { ruling: ruling(), ruling_hash: 'x' } },
        names,
      ),
    ).toEqual({
      voice: 'judge',
      text: 'Jake wins. Two full rotations, lands upright on its base in frame 7 and stays there. Jake never touches it.',
    });
    // names the stage does not know yet read as the projector's own labels
    expect(
      stageLineFor(
        { type: 'ruling.issued', payload: { ruling: ruling({ outcome: 'A_WINS' }) } },
        { A: null, B: null },
      )?.text,
    ).toMatch(/^Player A wins\. /);
  });

  it('REDO, VOID and a Gemini settlement', () => {
    const line = (over: Record<string, unknown>) =>
      stageLineFor({ type: 'ruling.issued', payload: { ruling: ruling(over) } }, names)?.text;
    expect(
      line({ outcome: 'REDO', redo_reason: 'unclear', reason: 'The bottle left the frame' }),
    ).toBe('Run it back. The bottle left the frame.');
    // The server's own REDO reasons already say it (judge/ruling.ts): said once, not twice.
    expect(
      line({
        outcome: 'REDO',
        redo_reason: 'unclear',
        claim_result: 'UNCLEAR',
        confidence: 0,
        reason: "The clerk couldn't make out that attempt. Run it back.",
      }),
    ).toBe("The clerk couldn't make out that attempt. Run it back.");
    expect(
      line({
        outcome: 'REDO',
        redo_reason: 'unclear',
        reason:
          'Checks disagree: the call says it landed, but the checks miss upright at rest. Run it back.',
      }),
    ).toBe(
      'Checks disagree: the call says it landed, but the checks miss upright at rest. Run it back.',
    );
    expect(
      line({
        outcome: 'REDO',
        redo_reason: 'low_confidence',
        reason: 'run it back, keep it in frame',
      }),
    ).toBe('run it back, keep it in frame.');
    expect(line({ outcome: 'VOID', void_reason: 'max_redos' })).toBe(
      "Three tries and no clean call. It's void: both stakes go back.",
    );
    expect(line({ outcome: 'VOID', void_reason: 'market_invalid' })).toMatch(/^Gemini voided/);
    expect(
      line({
        outcome: 'A_WINS',
        stage: 'settlement',
        model: GEMINI_SETTLEMENT_MODEL,
        reason: 'Bitcoin settled at $97,301.12, above the $97,250.03 line.',
      }),
    ).toBe(
      'Gemini settles it. Logan wins. Bitcoin settled at $97,301.12, above the $97,250.03 line.',
    );
  });

  it('appeal.vote: three seats, three voices; an abstention says so', () => {
    const v = (over: Record<string, unknown>) =>
      stageLineFor({ type: 'appeal.vote', payload: { vote: vote(over) } }, names);
    expect(v({ seat: 0, provider: 'anthropic' })).toEqual({
      voice: 'seat_1',
      text: 'Judge 1, Claude, votes Logan. The bottle rests on its cap in frame 7, not its base.',
    });
    expect(v({ seat: 1 })?.voice).toBe('seat_2');
    expect(v({ seat: 2, provider: 'google', outcome: 'B_WINS', counted_as: 'B_WINS' })).toEqual({
      voice: 'seat_3',
      text: 'Judge 3, Gemini, votes Jake. The bottle rests on its cap in frame 7, not its base.',
    });
    expect(
      v({ status: 'timeout', outcome: 'REDO', counted_as: 'ABSTAIN', reason: '', confidence: 0 })
        ?.text,
    ).toBe('Judge 2, GPT, abstains.');
    expect(new Set([0, 1, 2].map((seat) => v({ seat })?.voice)).size).toBe(3);
  });

  it('judge.cue: PAID and the payout VOIDED are voiced; the ruling-time VOIDED is not', () => {
    const cue = (cue: string, text: string) =>
      stageLineFor({ type: 'judge.cue', payload: { cue, text, speak: true } }, names);
    expect(
      cue(
        'PAID',
        '[EVENT] PAID winner=Jake amount=$10.00 to_a=$0.00 to_b=$10.00 :: Congratulate Jake in one line.',
      ),
    ).toEqual({ voice: 'judge', text: 'Paid. Jake takes $10.00.' });
    expect(
      cue('VOIDED', "[EVENT] VOIDED a=$5.00 b=$5.00 :: Say it's void: both got their stake back."),
    ).toEqual({ voice: 'judge', text: "It's void. Both stakes went back: $5.00 each." });
    expect(
      cue('VOIDED', "[EVENT] VOIDED a=$5.00 b=$2.00 :: Say it's void: both got their stake back.")
        ?.text,
    ).toBe("It's void. Both stakes went back: $5.00 and $2.00.");
    // the ruling's own VOIDED cue: ruling.issued (VOID) already says it
    expect(cue('VOIDED', '[EVENT] VOIDED reason=max_redos attempts=3 :: Say ...')).toBeNull();
    expect(cue('LOCKED', '[EVENT] LOCKED pot=$10 :: Announce.')).toBeNull();
    expect(cue('PAID', 'not an event line')).toBeNull();
  });

  it('other events, junk payloads: no line', () => {
    expect(stageLineFor({ type: 'bet.state', payload: {} }, names)).toBeNull();
    expect(stageLineFor({ type: 'ruling.issued', payload: { ruling: 1 } }, names)).toBeNull();
    expect(stageLineFor({ type: 'appeal.vote', payload: null }, names)).toBeNull();
  });

  it('a long reason is cut at a sentence, and never passes STAGE_LINE_MAX', () => {
    const long = `${'The bottle spins. '.repeat(30)}End`;
    const text = stageLineFor(
      { type: 'ruling.issued', payload: { ruling: ruling({ reason: long }) } },
      names,
    )!.text;
    expect(text.length).toBeLessThanOrEqual(STAGE_LINE_MAX);
    expect(text.endsWith('spins.')).toBe(true);
    expect(capLine('x'.repeat(400)).length).toBe(STAGE_LINE_MAX);
    expect(capLine('  a \n\t b  ')).toBe('a b');
  });
});

describe('one judge at a time: what the phone judge says itself', () => {
  it('a bet with a relayed judge.line has a phone judge; nothing else marks one', () => {
    expect(PHONE_JUDGE_EVENT).toBe('judge.line');
    expect(hasPhoneJudge([])).toBe(false);
    expect(
      hasPhoneJudge([{ type: 'bet.invited' }, { type: 'party.line' }, { type: 'judge.cue' }]),
    ).toBe(false);
    expect(hasPhoneJudge([{ type: 'bet.invited' }, { type: 'judge.line' }])).toBe(true);
  });

  it('with a phone judge the stage leaves it the rulings and payouts, never the appeal votes', () => {
    // every ruling.issued comes with a speak:true RULING / REDO / VOIDED / MARKET_SETTLED cue,
    // and the payout's PAID / VOIDED cue is speak:true: A's phone says all of them
    expect(leftToPhoneJudge('ruling.issued', true)).toBe(true);
    expect(leftToPhoneJudge('judge.cue', true)).toBe(true);
    // §4.5: appeal votes are voiced on the stage, not by the agent
    expect(leftToPhoneJudge('appeal.vote', true)).toBe(false);
    // no phone judge (no key, the agent never spoke, a laptop-driven bet): the stage says them
    for (const t of VoicedEventType.options) expect(leftToPhoneJudge(t, false)).toBe(false);
  });
});

describe('frames and the cached-ruling marker', () => {
  it('stage.voice is a control frame; stage.cue may carry the SFX clip', () => {
    const clip = 'a'.repeat(64);
    expect(CLIP_ID_RE.test(clip)).toBe(true);
    expect(stageTtsPath(clip)).toBe(`/v1/stage/tts/${clip}`);
    const f = WsServerControlFrame.parse({
      op: 'stage.voice',
      bet_id: BET,
      seq: 9,
      type: 'ruling.issued',
      voice: 'judge',
      text: 'Jake wins.',
      clip_id: clip,
      audio_url: stageTtsPath(clip),
    });
    expect(f.op).toBe('stage.voice');
    expect(WsStageCue.parse({ op: 'stage.cue', bet_id: BET, kind: 'gavel' })).not.toHaveProperty(
      'audio_url',
    );
    expect(
      WsStageCue.parse({
        op: 'stage.cue',
        bet_id: BET,
        kind: 'gavel',
        audio_url: '/v1/stage/sfx/gavel',
      }).audio_url,
    ).toBe('/v1/stage/sfx/gavel');
    expect(
      StageAudioResponse.parse({ tts: false, tts_off: 'no_key', model: null, sfx: null }).tts,
    ).toBe(false);
  });

  it('a CACHED_RULING ruling is recognisable from its model', () => {
    expect(isCachedRulingModel(CACHED_RULING_MODEL)).toBe(true);
    expect(isCachedRulingModel('anthropic/claude-sonnet-5-5')).toBe(false);
    expect(isCachedRulingModel(GEMINI_SETTLEMENT_MODEL)).toBe(false);
  });
});
