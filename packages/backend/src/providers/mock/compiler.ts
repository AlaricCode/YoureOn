/**
 * Mock compiler (§13 "Mock compiler", keyword templates):
 *   "paper"/"trash"/"can"/"bin"  → Example 1 "Paper ball shot" (region question "line";
 *                                   "How many attempts?" if no number was given)
 *   "cup"/"tower"/"fan"          → Example 2 "Cup tower"
 *   "push-up"/"pushup"           → Example 3 "Push-ups" (number and seconds parsed)
 *   anything else                → ai_judged with the transcript as the question
 * Every template asks "Stake each?" if no amount was given and "Who's in?"
 * when participants are unresolved. Default limit 120 s. YAML is only
 * produced once no blocking (non-region) question is open.
 */
import { DEFAULT_TIME_LIMIT_S } from '@verdict/engine';
import type { CompileRequest, CompileResult, CompilerProvider, Question } from '../types.js';

type Template = 'paper' | 'cup' | 'pushup' | 'ai';

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, hundred: 100,
};

export function classify(text: string): Template {
  const t = text.toLowerCase();
  if (/\bpush-?ups?\b/.test(t)) return 'pushup';
  if (/\b(paper|trash|can|bin)\b/.test(t)) return 'paper';
  if (/\b(cup|cups|tower|fan)\b/.test(t)) return 'cup';
  return 'ai';
}

function num(tok: string): number | null {
  if (/^\d+$/.test(tok)) return Number(tok);
  return NUMBER_WORDS[tok.toLowerCase()] ?? null;
}

const NUM = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|hundred)';

/** "$5", "$2.50", "5 dollars", "five bucks" → USDC base units. */
export function parseAmountUnits(text: string): number | null {
  const m = /\$\s?(\d{1,7})(?:\.(\d{1,2}))?/.exec(text);
  if (m) return Number(m[1]) * 1_000_000 + Number((m[2] ?? '0').padEnd(2, '0')) * 10_000;
  const w = new RegExp(`\\b${NUM}\\s+(dollars?|bucks?|usdc)\\b`, 'i').exec(text);
  if (w) {
    const n = num(w[1]!);
    return n === null ? null : n * 1_000_000;
  }
  return null;
}

function parseAttempts(text: string): number | null {
  const m = new RegExp(`\\b${NUM}\\s+(tries|try|attempts?|shots?|goes|throws?)\\b`, 'i').exec(text);
  return m ? num(m[1]!) : null;
}

function parseSeconds(text: string, unitRe = '(seconds?|secs?|s|minutes?|mins?)'): number | null {
  const m = new RegExp(`\\b${NUM}\\s*${unitRe}\\b`, 'i').exec(text);
  if (!m) return null;
  const n = num(m[1]!);
  if (n === null) return null;
  return /^m/i.test(m[2]!) ? n * 60 : n;
}

function parseReps(text: string): number | null {
  const m = new RegExp(`\\b${NUM}\\s+push-?ups?\\b`, 'i').exec(text);
  return m ? num(m[1]!) : null;
}

const stakeQuestion = (): Question => ({ id: 'stake', text: 'Stake each?', kind: 'choice', chips: ['$1', '$5', '$10'], audio_url: null });
const attemptsQuestion = (): Question => ({ id: 'attempts', text: 'How many attempts?', kind: 'choice', chips: ['1', '3', '5'], audio_url: null });
const lineQuestion = (): Question => ({ id: 'line', text: 'Where is the throw line?', kind: 'region', chips: [], entity: 'line', audio_url: null });
const whoQuestion = (names: string[]): Question => ({ id: 'who', text: "Who's in?", kind: 'multi', chips: names, audio_url: null });

const fmtInt = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '_');

function firstWords(text: string, n: number, maxChars: number): string {
  const words = text.trim().replace(/[?.!]+$/, '').split(/\s+/).slice(0, n);
  let out = '';
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > maxChars) break;
    out = next;
  }
  return out || text.slice(0, maxChars);
}

export class MockCompiler implements CompilerProvider {
  readonly name = 'mock';

  async compile(req: CompileRequest): Promise<CompileResult> {
    const answers = new Map((req.answers ?? []).map((a) => [a.question_id, a.answer]));
    const transcript = [req.previous?.transcript, req.transcript].filter((x): x is string => !!x && x.trim() !== '').join(' ');
    const template = classify(transcript);
    const questions: Question[] = [];

    // --- participants ---
    const creator = req.members.find((m) => m.user_id === req.creator_user_id);
    const others = req.members.filter((m) => m.user_id !== req.creator_user_id);
    let chosen: typeof others = [];
    const who = answers.get('who');
    if (who !== undefined) {
      const picked = who.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      chosen = others.filter((m) => picked.includes(m.display_name.toLowerCase()) || picked.includes(m.user_id));
    } else if (others.length === 1) {
      chosen = others;
    }
    if (!creator || chosen.length === 0) questions.push(whoQuestion(others.map((m) => m.display_name)));

    // --- stake ---
    const stake = parseAmountUnits(answers.get('stake') ?? '') ?? parseAmountUnits(transcript);
    if (stake === null) questions.push(stakeQuestion());

    const labels: Record<string, string> = {};
    const lines: string[] = ['version: 2'];
    let kind: CompileResult['kind'] = 'rules';
    let title: string;
    let timeLimit = DEFAULT_TIME_LIMIT_S;
    const friend = chosen[0];
    const explicitParticipants = chosen.length > 0 && req.members.length > 2;
    const personOf = (m: { wallet: string } | undefined, huddleIdx: number) =>
      explicitParticipants && m ? `person(${m.wallet})` : `person(p${huddleIdx})`;

    switch (template) {
      case 'paper': {
        title = 'Paper ball shot';
        const attempts = num(answers.get('attempts') ?? '') ?? parseAttempts(transcript);
        if (attempts === null) questions.push(attemptsQuestion());
        questions.push(lineQuestion());
        labels['shooter'] = friend?.display_name ?? 'Shooter';
        labels['ball'] = 'Paper Ball';
        labels['can'] = 'Trash Can';
        labels['line'] = 'Line';
        lines.push(
          'entities:',
          `  shooter: ${personOf(friend, Math.max(1, req.members.indexOf(friend!)))}`,
          '  ball: object("crumpled paper ball")',
          '  can: object("trash can")',
          '  line: region(tap)',
          'legs:',
          '  - id: 1',
          '    actor_bound: true',
          '    valid_attempt: ball released_by shooter while shooter behind line',
          '    success: ball disappears_into can.opening or (ball inside can and ball at_rest 1s)',
          `    rule: count(success) >= 1 within attempts ${attempts ?? 3}`,
          'outcome: side(shooter) wins iff leg 1 true; else side(creator)',
        );
        break;
      }
      case 'cup': {
        title = 'Cup tower';
        const holdS = parseSeconds(transcript) ?? 10;
        labels['tower'] = 'Cup Tower';
        labels['fan'] = 'Fan';
        lines.push(
          'entities:',
          '  tower: object("cup tower")',
          '  fan: object("fan")',
          'legs:',
          '  - id: 1',
          '    actor_bound: false',
          '    success: tower intact',
          `    rule: holds(success) for ${holdS}s`,
          'outcome: side(creator) wins iff leg 1 true; else side(other)',
        );
        timeLimit = Math.max(DEFAULT_TIME_LIMIT_S, holdS + 20);
        break;
      }
      case 'pushup': {
        title = 'Push-ups';
        const reps = parseReps(transcript) ?? 20;
        const secs = parseSeconds(transcript) ?? 60;
        labels['me'] = creator?.display_name ?? 'Me';
        lines.push(
          'entities:',
          '  me: person(p0)',
          'legs:',
          '  - id: 1',
          '    actor_bound: true',
          `    success: rep_count(me) >= ${reps}`,
          `    rule: success before ${secs}s`,
          'outcome: side(me) wins iff leg 1 true; else side(other)',
        );
        timeLimit = Math.max(DEFAULT_TIME_LIMIT_S, secs + 30);
        break;
      }
      default: {
        kind = 'ai_judged';
        const q = transcript.trim().slice(0, 280) || 'Did it happen?';
        title = firstWords(q, 5, 40);
        lines.push('kind: ai_judged', `question: ${JSON.stringify(q)}`, 'outcome: side(A) wins iff yes; else side(B)');
      }
    }

    if (explicitParticipants && creator) {
      lines.splice(1, 0, `participants: [${[creator, ...chosen].map((m) => m.wallet).join(', ')}]`);
      lines.splice(2, 0, `sides: [${[0, ...chosen.map(() => 1)].join(', ')}]`);
    }
    if (stake !== null) lines.push(`stake_each: ${fmtInt(stake)}`);
    lines.push(`time_limit_s: ${timeLimit}`);

    const blocking = questions.some((q) => q.kind !== 'region');
    return {
      kind,
      title,
      yaml: blocking ? null : `${lines.join('\n')}\n`,
      questions,
      labels,
      source: `mock:${template}`,
    };
  }
}
