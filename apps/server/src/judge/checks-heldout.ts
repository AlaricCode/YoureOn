// HELD-OUT bets for the compile_checks eval (scripts/checks-compile-eval.ts). None of these may
// appear in FEW_SHOTS (checks-fewshots.ts): same id or same claim is rejected by the tests, so the
// eval measures generalization, not recall. Expectations are deliberately loose (what must and
// must not be there), because several specs can be right for one bet.
//
// `mock_output` is only the canned answer the eval's --mock mode returns (wiring check, no
// network); it is never shown to the model.
import type { CompileInput, CompiledChecksValid } from '@youre-on/shared/checks/compile';
import type { PredicateName } from '@youre-on/shared/checks/spec';

export interface HeldOutExpect {
  decision: 'checks' | 'judge_only';
  /** Every one of these predicates must appear (any role). */
  must_include: PredicateName[];
  /** None of these predicates may appear. */
  must_not_include: PredicateName[];
  /** Synonym groups: every entity prompt in the output must be in one of the groups. */
  prompts: string[][];
  /** Prompts (any synonym listed) that must never carry a gate, in any window: movers. */
  must_not_gate: string[];
  /**
   * Prompts that may be gated at `start` but never at `end` / `landing`: targets that are knocked
   * away and may legitimately leave the shot (a late gate would REDO a real win).
   */
  must_not_gate_late: string[];
  /** 0 when the compiler must answer without a model call (multi-attempt, real_world). */
  model_calls: 0 | 1;
}

export interface HeldOutBet {
  id: string;
  input: CompileInput;
  expect: HeldOutExpect;
  notes: string;
  mock_output: CompiledChecksValid;
}

const single = { count: 1, rule: 'single' } as const;
const judge = 'judge' as const;
const judgeOnly = (why: string): CompiledChecksValid => ({
  decision: 'judge_only',
  why,
  spec: null,
});

export const HELD_OUT: readonly HeldOutBet[] = [
  {
    id: 'frisbee_lands_on_table',
    input: {
      type: 'skill',
      claim: 'Zoe throws a frisbee from the doorway and it lands and stays on the table.',
      success_criteria: ['The frisbee ends resting on the table top.'],
      failure_criteria: ['The frisbee misses the table or slides off it.'],
      edge_cases: [],
      attempts: single,
    },
    expect: {
      decision: 'checks',
      must_include: ['on_top'],
      must_not_include: ['upright', 'stacked', 'switched_sides'],
      prompts: [
        ['frisbee', 'disc', 'flying disc'],
        ['table', 'desk'],
      ],
      must_not_gate: ['frisbee', 'disc', 'flying disc'],
      must_not_gate_late: [],
      model_calls: 1,
    },
    notes:
      'Design example 10: gate the table, on_top (+ at_rest ref table is fine). Flying off is the normal miss, so never gate the frisbee.',
    mock_output: {
      decision: 'checks',
      why: 'The frisbee must end on the table and still.',
      spec: {
        predicates: 'p1',
        entities: [
          { key: 'frisbee', prompt: 'frisbee', count: 1 },
          { key: 'table', prompt: 'table', count: 1 },
        ],
        assertions: [
          { role: 'gate', test: { p: 'visible', e: 'table', window: 'end' } },
          { role: 'need', test: { p: 'at_rest', e: 'frisbee', ref: 'table' } },
          { role: 'need', test: { p: 'on_top', a: 'frisbee', b: 'table' } },
        ],
      },
    },
  },
  {
    id: 'ping_pong_ball_in_cup',
    input: {
      type: 'skill',
      claim: 'Raj bounces a ping pong ball off the table into a red cup.',
      success_criteria: ['The ball ends inside the cup after at least one bounce on the table.'],
      failure_criteria: ['The ball misses the cup or bounces out of it.'],
      edge_cases: [
        {
          question: 'Does it count if it goes in without bouncing?',
          answer: 'No, it must bounce on the table first.',
          asked_by: judge,
        },
      ],
      attempts: single,
    },
    expect: {
      decision: 'checks',
      must_include: ['ends_at'],
      must_not_include: ['upright', 'on_top', 'stacked', 'at_rest'],
      prompts: [
        ['ping pong ball', 'ball', 'table tennis ball'],
        ['cup', 'red cup', 'plastic cup'],
        ['table'],
      ],
      must_not_gate: ['ping pong ball', 'ball', 'table tennis ball'],
      must_not_gate_late: [],
      model_calls: 1,
    },
    notes:
      'Throw-into: gate the cup, ends_at(ball, cup). The bounce is momentary (judge). at_rest on a ball that vanished into the cup would be unknown and block a legitimate make.',
    mock_output: {
      decision: 'checks',
      why: 'The cup is the static target; a ball seen lying away from it contradicts a make.',
      spec: {
        predicates: 'p1',
        entities: [
          { key: 'ball', prompt: 'ping pong ball', count: 1 },
          { key: 'cup', prompt: 'cup', count: 1 },
        ],
        assertions: [
          { role: 'gate', test: { p: 'visible', e: 'cup', window: 'end' } },
          { role: 'need', test: { p: 'ends_at', a: 'ball', b: 'cup' } },
        ],
      },
    },
  },
  {
    id: 'can_off_fence',
    input: {
      type: 'skill',
      claim: 'Eli knocks the can off the fence post with a single throw of a baseball.',
      success_criteria: ['The can falls off the fence post.'],
      failure_criteria: ['The can is still on the post after the throw.'],
      edge_cases: [],
      attempts: single,
    },
    expect: {
      decision: 'checks',
      must_include: ['moved_from_start'],
      must_not_include: ['ends_at', 'upright', 'stacked', 'switched_sides', 'on_top'],
      prompts: [
        ['can', 'tin can', 'soda can'],
        ['fence post', 'fence', 'post'],
        ['baseball', 'ball'],
      ],
      must_not_gate: [],
      must_not_gate_late: ['can', 'tin can', 'soda can'],
      model_calls: 1,
    },
    notes:
      'Knock-over: moved_from_start(can, of all, ref fence post), can gated at start, post at end. The ball is not needed (one throw is a count).',
    mock_output: {
      decision: 'checks',
      why: 'The can must leave its start spot on the post.',
      spec: {
        predicates: 'p1',
        entities: [
          { key: 'can', prompt: 'can', count: 1 },
          { key: 'post', prompt: 'fence post', count: 1 },
        ],
        assertions: [
          { role: 'gate', test: { p: 'visible', e: 'can', window: 'start' } },
          { role: 'gate', test: { p: 'visible', e: 'post', window: 'end' } },
          { role: 'need', test: { p: 'moved_from_start', e: 'can', of: 'all', ref: 'post' } },
        ],
      },
    },
  },
  {
    id: 'pencil_on_eraser',
    input: {
      type: 'skill',
      claim: 'Lena stands a pencil upright on its eraser end on the desk and it stays standing.',
      success_criteria: ['The pencil stands on its eraser end by itself until the clip ends.'],
      failure_criteria: ['The pencil falls over.', 'Lena is still touching the pencil at the end.'],
      edge_cases: [],
      attempts: single,
    },
    expect: {
      decision: 'checks',
      must_include: ['upright'],
      must_not_include: ['ends_at', 'switched_sides', 'stacked', 'moved_from_start'],
      prompts: [['pencil'], ['desk', 'table']],
      must_not_gate: [],
      must_not_gate_late: [],
      model_calls: 1,
    },
    notes:
      'Like the bottle flip: the resting pose is the claim (gate pencil at end is fine), upright + at_rest. Eraser end vs tip is a small part: judge.',
    mock_output: {
      decision: 'checks',
      why: 'The pencil must be in shot, still and upright at the end.',
      spec: {
        predicates: 'p1',
        entities: [{ key: 'pencil', prompt: 'pencil', count: 1 }],
        assertions: [
          { role: 'gate', test: { p: 'visible', e: 'pencil', window: 'end' } },
          { role: 'need', test: { p: 'at_rest', e: 'pencil', ref: null } },
          { role: 'need', test: { p: 'upright', e: 'pencil' } },
        ],
      },
    },
  },
  {
    id: 'pancake_flip_into_pan',
    input: {
      type: 'skill',
      claim: 'Tom flips a pancake in the air and catches it back in the frying pan.',
      success_criteria: ['The pancake flips over and lands back in the pan.'],
      failure_criteria: ['The pancake lands on the stove, the floor, or hangs off the pan.'],
      edge_cases: [
        {
          question: 'Does it need to flip all the way over?',
          answer: 'Yes, it must turn over at least once.',
          asked_by: judge,
        },
      ],
      attempts: single,
    },
    expect: {
      decision: 'checks',
      must_include: ['ends_at'],
      must_not_include: ['at_rest', 'upright', 'stacked', 'switched_sides'],
      prompts: [['pancake'], ['frying pan', 'pan', 'skillet']],
      must_not_gate: ['pancake'],
      must_not_gate_late: [],
      model_calls: 1,
    },
    notes:
      'The pan is hand-held and moving, so at_rest would veto real wins; ends_at(pancake, pan) is the only safe need. Whether it turned over is momentary / a face: judge.',
    mock_output: {
      decision: 'checks',
      why: 'A pancake seen lying away from the pan at the end contradicts a catch.',
      spec: {
        predicates: 'p1',
        entities: [
          { key: 'pan', prompt: 'frying pan', count: 1 },
          { key: 'pancake', prompt: 'pancake', count: 1 },
        ],
        assertions: [
          { role: 'gate', test: { p: 'visible', e: 'pan', window: 'end' } },
          { role: 'need', test: { p: 'ends_at', a: 'pancake', b: 'pan' } },
        ],
      },
    },
  },
  {
    id: 'juggle_three_ten_catches',
    input: {
      type: 'skill',
      claim: 'Ivy juggles 3 balls for 10 catches in a row without a drop.',
      success_criteria: ['10 consecutive catches with 3 balls.'],
      failure_criteria: ['Any ball is dropped before 10 catches.'],
      edge_cases: [],
      attempts: single,
    },
    expect: {
      decision: 'judge_only',
      must_include: [],
      must_not_include: [],
      prompts: [],
      must_not_gate: [],
      must_not_gate_late: [],
      model_calls: 1,
    },
    notes: 'A count of catches: always judge_only.',
    mock_output: judgeOnly('Success is a count of catches, which sparse frames cannot verify.'),
  },
  {
    id: 'card_trick_guess',
    input: {
      type: 'skill',
      claim: 'Max names the card Mia secretly picked from the deck.',
      success_criteria: ['Max names the exact card Mia picked, then Mia shows it to the camera.'],
      failure_criteria: ['Max names a different card.'],
      edge_cases: [],
      attempts: single,
    },
    expect: {
      decision: 'judge_only',
      must_include: [],
      must_not_include: [],
      prompts: [],
      must_not_gate: [],
      must_not_gate_late: [],
      model_calls: 1,
    },
    notes: 'Card faces and speech: judge_only.',
    mock_output: judgeOnly('A card face and what was said decide it.'),
  },
  {
    id: 'free_throws_best_of_3',
    input: {
      type: 'skill',
      claim: 'Dev makes at least 2 of 3 free throws.',
      success_criteria: ['At least 2 of the 3 shots go through the hoop.'],
      failure_criteria: ['2 or more shots miss.'],
      edge_cases: [],
      attempts: { count: 3, rule: 'best_of' },
    },
    expect: {
      decision: 'judge_only',
      must_include: [],
      must_not_include: [],
      prompts: [],
      must_not_gate: [],
      must_not_gate_late: [],
      model_calls: 0,
    },
    notes: 'Multi-attempt: judge_only without a model call.',
    mock_output: judgeOnly('Multi-attempt.'),
  },
  {
    id: 'book_on_head_walk',
    input: {
      type: 'skill',
      claim: 'Ana walks across the room balancing a book on her head for 5 seconds.',
      success_criteria: [
        'The book stays on her head, hands free, for at least 5 seconds while she walks.',
      ],
      failure_criteria: ['The book falls.', 'She holds the book with her hands.'],
      edge_cases: [
        {
          question: 'When does the clip stop?',
          answer: 'Stop filming while she is still walking with the book on her head.',
          asked_by: judge,
        },
      ],
      attempts: single,
    },
    expect: {
      decision: 'checks',
      must_include: ['touching'],
      must_not_include: ['at_rest', 'switched_sides', 'stacked', 'upright', 'ends_at'],
      prompts: [['book'], ['head', 'person', 'woman']],
      must_not_gate: ['book'],
      must_not_gate_late: [],
      model_calls: 1,
    },
    notes:
      'Hold that continues at clip end: touching(book, head, last_5s). She walks, so at_rest would veto; "across the room" is distance (judge). "face" is wrong: a book on top of the head sits above the face box, so touching would be unknown on a real win.',
    mock_output: {
      decision: 'checks',
      why: 'The clip ends during the hold, so the book must touch her head for the last 5 seconds.',
      spec: {
        predicates: 'p1',
        entities: [
          { key: 'book', prompt: 'book', count: 1 },
          { key: 'head', prompt: 'head', count: 1 },
        ],
        assertions: [
          { role: 'gate', test: { p: 'visible', e: 'head', window: 'landing' } },
          { role: 'need', test: { p: 'touching', a: 'book', b: 'head', window: 'last_5s' } },
        ],
      },
    },
  },
  {
    id: 'sock_into_laundry_basket',
    input: {
      type: 'skill',
      claim: 'Finn throws a balled-up sock into the laundry basket from the bed.',
      success_criteria: ['The sock ends inside the laundry basket.'],
      failure_criteria: ['The sock lands outside the basket.'],
      edge_cases: [],
      attempts: single,
    },
    expect: {
      decision: 'checks',
      must_include: ['ends_at'],
      must_not_include: ['on_top', 'upright', 'stacked', 'at_rest'],
      prompts: [['sock', 'socks'], ['laundry basket', 'basket', 'hamper'], ['bed']],
      must_not_gate: ['sock', 'socks'],
      must_not_gate_late: [],
      model_calls: 1,
    },
    notes: 'Throw-into: gate the basket, ends_at(sock, basket).',
    mock_output: {
      decision: 'checks',
      why: 'The basket is the static target; a sock seen lying away from it contradicts a make.',
      spec: {
        predicates: 'p1',
        entities: [
          { key: 'basket', prompt: 'laundry basket', count: 1 },
          { key: 'sock', prompt: 'sock', count: 1 },
        ],
        assertions: [
          { role: 'gate', test: { p: 'visible', e: 'basket', window: 'end' } },
          { role: 'need', test: { p: 'ends_at', a: 'sock', b: 'basket' } },
        ],
      },
    },
  },
];

export interface ExpectationResult {
  name: string;
  pass: boolean;
  detail: string;
}

/** Scores one compiler result against a held-out bet's expectations. */
export function scoreHeldOut(
  bet: HeldOutBet,
  got: {
    decision: 'checks' | 'judge_only';
    spec: {
      entities: { key: string; prompt: string }[];
      assertions: { role: string; test: { p: string; e?: string; window?: string } }[];
    } | null;
    attempts: number;
  },
): ExpectationResult[] {
  const x = bet.expect;
  const preds = new Set(got.spec?.assertions.map((a) => a.test.p) ?? []);
  const prompts = got.spec?.entities.map((e) => e.prompt) ?? [];
  const allowed = new Set(x.prompts.flat());
  const promptOf = new Map(got.spec?.entities.map((e) => [e.key, e.prompt]) ?? []);
  const gates = (got.spec?.assertions ?? []).filter(
    (a) => a.role === 'gate' && a.test.e !== undefined,
  );
  const gateOf = (a: (typeof gates)[number]) => promptOf.get(a.test.e!) ?? '';
  const missing = x.must_include.filter((p) => !preds.has(p));
  const banned = x.must_not_include.filter((p) => preds.has(p));
  const strange = prompts.filter((p) => !allowed.has(p));
  const badGates = [
    ...gates.map(gateOf).filter((p) => x.must_not_gate.includes(p)),
    ...gates
      .filter((a) => a.test.window !== 'start')
      .map(gateOf)
      .filter((p) => x.must_not_gate_late.includes(p))
      .map((p) => `${p}@late`),
  ];
  const calls = x.model_calls === 0 ? got.attempts === 0 : got.attempts >= 1;
  return [
    {
      name: 'decision',
      pass: got.decision === x.decision,
      detail: `${x.decision}/${got.decision}`,
    },
    { name: 'must_include', pass: missing.length === 0, detail: missing.join(',') },
    { name: 'must_not_include', pass: banned.length === 0, detail: banned.join(',') },
    {
      name: 'prompts',
      pass: x.decision === 'judge_only' || strange.length === 0,
      detail: strange.join(','),
    },
    { name: 'gates', pass: badGates.length === 0, detail: badGates.join(',') },
    { name: 'calls', pass: calls, detail: `${got.attempts}` },
  ];
}
