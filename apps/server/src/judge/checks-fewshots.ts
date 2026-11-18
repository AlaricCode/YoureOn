// Few-shot examples for the compile_checks call (design final.md §1 "Compilation", §9 "Compiler
// guidance"). They are DATA, kept apart from the prompt code so they can be tuned without touching
// it: compile-checks-prompt.ts renders every selected example as an INPUT / OUTPUT pair plus its
// note, after the system prompt, inside the cached prefix.
//
// HOW TO TUNE
//  - Edit an example: change its input, output or note. The output must stay CORRECT under p1
//    (packages/shared/src/checks/spec.ts + evaluate.ts): `checks` with a canonical, CheckSpec-valid
//    spec, or `judge_only` with spec null. The tests (apps/server/test/checks-compile.test.ts)
//    parse every example, check canonical order, readback, tag/predicate coverage, and that the
//    wire JSON schema accepts it. Run them after every edit.
//  - Add an example: append an object to FEW_SHOTS with a new unique `id` (snake_case), the
//    `tags` it teaches (ChallengeTag), a realistic `input` (as the voice judge would phrase the
//    terms), the `output` you want, and a `note` that says WHY it is shaped this way (the model
//    reads it; write it as the rule the example demonstrates, one to three sentences).
//    Never reuse a bet from the held-out eval set (checks-heldout.ts); the tests enforce that.
//  - Order matters a little (later examples weigh more): keep the most typical cases first and
//    the judge_only cases last. The array order is the prompt order.
//  - Any change changes PROMPT_VERSION (a hash of the rendered stable prompt), which keys the
//    compile cache and is logged with every compile, so evals can tell prompt versions apart.
//  - Then run `npm run checks-eval -- --mock` (wiring) and, with a key, `npm run checks-eval`
//    (live, held-out bets) and compare against the previous PROMPT_VERSION.
//
// TAGS AND SELECTION
//  Each example carries ChallengeTags. Today selectFewShots() returns every example in array
//  order. When the set grows past what is worth sending per call, switch on per-tag selection by
//  passing `tags` (classify the bet first, e.g. from keywords or a cheap model call) and `max`:
//  examples sharing a tag come first, and `alwaysTags` (judge_only by default) keep the
//  "don't over-check" counterweight in every prompt.
import type { CompileInput, CompiledChecksValid } from '@youre-on/shared/checks/compile';

export const CHALLENGE_TAGS = [
  /** A thrown/flipped object must come to rest in a pose (bottle flip). */
  'landing',
  /** An object thrown into a container or target that may swallow it (bin, cup, mouth). */
  'throw_into',
  /** Several identical objects end stacked. */
  'stack',
  /** Something balanced and held for a duration while filming. */
  'balance_hold',
  /** Objects knocked over / off their start spots. */
  'knock_over',
  /** A person or object crosses from one side of an obstacle to the other. */
  'cross_over',
  /** An object must end resting on a surface. */
  'place_on',
  /** Not SAM-decidable: no checks. */
  'judge_only',
] as const;
export type ChallengeTag = (typeof CHALLENGE_TAGS)[number];

export interface FewShot {
  /** Unique, snake_case, stable (logged by evals; never reuse a removed id). */
  id: string;
  tags: readonly ChallengeTag[];
  input: CompileInput;
  output: CompiledChecksValid;
  /** Teaching rationale, rendered to the model right after the output. */
  note: string;
}

const single = { count: 1, rule: 'single' } as const;
const judge = 'judge' as const;

export const FEW_SHOTS: readonly FewShot[] = [
  {
    id: 'bottle_flip_upright',
    tags: ['landing'],
    input: {
      type: 'skill',
      claim: 'Jake flips a water bottle and it lands upright on the table.',
      success_criteria: [
        'The bottle rotates at least once in the air.',
        'The bottle comes to rest standing upright on its base.',
      ],
      failure_criteria: [
        'The bottle ends on its side or on its cap.',
        'Jake touches the bottle after letting go.',
      ],
      edge_cases: [
        {
          question: 'What if it lands on its cap?',
          answer: 'That is a miss: it must stand on its base with the taped cap at the top.',
          asked_by: judge,
        },
      ],
      attempts: single,
    },
    output: {
      decision: 'checks',
      why: 'The final resting state is the claim: the bottle must be in shot, still and upright at the end.',
      spec: {
        predicates: 'p1',
        entities: [{ key: 'bottle', prompt: 'bottle', count: 1 }],
        assertions: [
          { role: 'gate', test: { p: 'visible', e: 'bottle', window: 'end' } },
          { role: 'need', test: { p: 'at_rest', e: 'bottle', ref: null } },
          { role: 'need', test: { p: 'upright', e: 'bottle' } },
        ],
      },
    },
    note: 'A mover may be gated only when its final resting pose IS the claim and nothing in the terms makes leaving the shot a way to lose: here every miss still ends on the table, so an out-of-shot bottle is a filming failure. If the terms said falling off the table is a miss, the bottle would NOT be gated (see the phone slide). Cap-down vs base-down looks the same in silhouette, so the cap stays with the judge; no table entity is needed because nothing is asserted about it.',
  },
  {
    id: 'paper_ball_trash_can',
    tags: ['throw_into'],
    input: {
      type: 'skill',
      claim: 'Maya throws a paper ball into the trash can from across the room.',
      success_criteria: ['The paper ball ends up inside the trash can.'],
      failure_criteria: ['The paper ball misses or bounces out of the can.'],
      edge_cases: [
        {
          question: 'Does it count if it bounces off the wall and goes in?',
          answer: 'Yes, any path counts as long as it ends inside the can.',
          asked_by: judge,
        },
      ],
      attempts: single,
    },
    output: {
      decision: 'checks',
      why: 'The can is a static target to gate; a paper ball seen lying away from the can at the end contradicts a make.',
      spec: {
        predicates: 'p1',
        entities: [
          { key: 'can', prompt: 'trash can', count: 1 },
          { key: 'paper', prompt: 'paper ball', count: 1 },
        ],
        assertions: [
          { role: 'gate', test: { p: 'visible', e: 'can', window: 'end' } },
          { role: 'need', test: { p: 'ends_at', a: 'paper', b: 'can' } },
        ],
      },
    },
    note: 'Gate the static target, never the thrown object: vanishing into the can is what success looks like, so ends_at (which treats "gone" as fine) is the only check on the ball. Containment and "across the room" are depth, which the judge decides.',
  },
  {
    id: 'cup_stack_three',
    tags: ['stack'],
    input: {
      type: 'skill',
      claim: 'Sam stacks 3 plastic cups into a tower on the table with one hand.',
      success_criteria: [
        'All 3 cups end stacked one on top of another.',
        'The tower stays standing until the end of the clip.',
      ],
      failure_criteria: ['The tower falls over.', 'Sam uses both hands.'],
      edge_cases: [],
      attempts: single,
    },
    output: {
      decision: 'checks',
      why: 'Three identical cups must end stacked and still; the table is the static anchor.',
      spec: {
        predicates: 'p1',
        entities: [
          { key: 'cup', prompt: 'cup', count: 3 },
          { key: 'table', prompt: 'table', count: 1 },
        ],
        assertions: [
          { role: 'gate', test: { p: 'visible', e: 'table', window: 'end' } },
          { role: 'need', test: { p: 'at_rest', e: 'cup', ref: 'table' } },
          { role: 'need', test: { p: 'stacked', e: 'cup' } },
        ],
      },
    },
    note: 'Use the count the terms state ("3 cups" -> count 3) and one prompt for identical objects; never "top cup". The table is gated and used as ref so camera shake is not read as motion. "One hand" is a manner of doing it: judge only.',
  },
  {
    id: 'knock_over_three_cans',
    tags: ['knock_over'],
    input: {
      type: 'skill',
      claim: 'Leo knocks over all 3 cans on the table with one throw of a tennis ball.',
      success_criteria: ['All 3 cans are knocked over or off the table by the single throw.'],
      failure_criteria: ['Any can is still standing where it started.'],
      edge_cases: [
        {
          question: 'Does a can that wobbles but stays standing count?',
          answer: 'No, it has to fall over or off the table.',
          asked_by: judge,
        },
      ],
      attempts: single,
    },
    output: {
      decision: 'checks',
      why: 'Every can must leave its start spot; the cans must be in shot at the start and the table at the end.',
      spec: {
        predicates: 'p1',
        entities: [
          { key: 'can', prompt: 'can', count: 3 },
          { key: 'table', prompt: 'table', count: 1 },
        ],
        assertions: [
          { role: 'gate', test: { p: 'visible', e: 'can', window: 'start' } },
          { role: 'gate', test: { p: 'visible', e: 'table', window: 'end' } },
          { role: 'need', test: { p: 'moved_from_start', e: 'can', of: 'all', ref: 'table' } },
        ],
      },
    },
    note: 'Gate the targets at the START (they are where the evidence begins) and the anchor at the end; knocked-off cans may legitimately leave the shot, so they are never gated at the end. "One throw" is a count of events, so the ball is not an entity at all.',
  },
  {
    id: 'spoon_on_nose_3s',
    tags: ['balance_hold'],
    input: {
      type: 'skill',
      claim: 'Priya balances a spoon on her nose for 3 seconds without using her hands.',
      success_criteria: ['The spoon stays on her nose for at least 3 seconds with no hands.'],
      failure_criteria: ['The spoon falls before 3 seconds.', 'She touches the spoon.'],
      edge_cases: [
        {
          question: 'When should the recording stop?',
          answer: 'Stop filming while the spoon is still balanced, after at least 3 seconds.',
          asked_by: judge,
        },
      ],
      attempts: single,
    },
    output: {
      decision: 'checks',
      why: 'The clip ends during the hold, so the spoon must touch her face in every frame of the last 3 seconds.',
      spec: {
        predicates: 'p1',
        entities: [
          { key: 'face', prompt: 'face', count: 1 },
          { key: 'spoon', prompt: 'spoon', count: 1 },
        ],
        assertions: [
          { role: 'gate', test: { p: 'visible', e: 'face', window: 'landing' } },
          { role: 'need', test: { p: 'touching', a: 'spoon', b: 'face', window: 'last_3s' } },
        ],
      },
    },
    note: 'Use touching with a last_Ns window only when the clip ends while the hold continues (here the edge case says so); N is the largest window not longer than the stated duration. The anchor is the body part the object actually rests on (a spoon on the nose touches the face; something on top of the head touches the head, not the face). The anchor is gated at landing so it stays in shot through the hold; the spoon is not gated, so a drop is the judge\'s NOT_MET, not a free re-do. "No hands" is the judge\'s call.',
  },
  {
    id: 'jump_over_chair',
    tags: ['cross_over'],
    input: {
      type: 'skill',
      claim: 'Omar jumps over a chair without touching it.',
      success_criteria: ['Omar clears the chair and lands on the other side.'],
      failure_criteria: ['Omar touches or knocks over the chair.', 'Omar goes around the chair.'],
      edge_cases: [],
      attempts: single,
    },
    output: {
      decision: 'checks',
      why: 'He must start on one side of the chair and end on the other; the chair is the static anchor.',
      spec: {
        predicates: 'p1',
        entities: [
          { key: 'chair', prompt: 'chair', count: 1 },
          { key: 'person', prompt: 'person', count: 1 },
        ],
        assertions: [
          { role: 'gate', test: { p: 'visible', e: 'chair', window: 'end' } },
          { role: 'need', test: { p: 'switched_sides', a: 'person', b: 'chair' } },
        ],
      },
    },
    note: 'The jump apex and "without touching" are momentary, so they stay with the judge; only the start-vs-end sides are checked. The person is not gated: running out of shot after a miss must not force a re-do.',
  },
  {
    id: 'phone_slide_stays_on_table',
    tags: ['place_on'],
    input: {
      type: 'skill',
      claim: 'Nina slides her phone down the table and it stops before falling off the end.',
      success_criteria: ['The phone comes to a stop still on the table.'],
      failure_criteria: ['The phone falls off the table.'],
      edge_cases: [
        {
          question: 'What if the phone stops hanging over the edge?',
          answer: 'It counts if it stays on the table without falling.',
          asked_by: judge,
        },
      ],
      attempts: single,
    },
    output: {
      decision: 'checks',
      why: 'The phone must end on the table and still; the table is the gated anchor.',
      spec: {
        predicates: 'p1',
        entities: [
          { key: 'phone', prompt: 'phone', count: 1 },
          { key: 'table', prompt: 'table', count: 1 },
        ],
        assertions: [
          { role: 'gate', test: { p: 'visible', e: 'table', window: 'end' } },
          { role: 'need', test: { p: 'on_top', a: 'phone', b: 'table' } },
          { role: 'need', test: { p: 'at_rest', e: 'phone', ref: 'table' } },
        ],
      },
    },
    note: 'on_top is for "ends on a surface"; pair it with at_rest (ref = the surface) when the object must also stop. Falling off is the normal way to lose, so the phone is not gated: an off-table phone is the judge\'s NOT_MET.',
  },
  {
    id: 'coin_flip_heads',
    tags: ['judge_only'],
    input: {
      type: 'skill',
      claim: 'Ava flips a coin and it lands heads.',
      success_criteria: ['The coin lands showing heads.'],
      failure_criteria: ['The coin lands showing tails.'],
      edge_cases: [
        {
          question: 'What if the coin rolls off the table?',
          answer: 'Then it is flipped again.',
          asked_by: judge,
        },
      ],
      attempts: single,
    },
    output: {
      decision: 'judge_only',
      why: 'Heads vs tails is a marking on a tiny object; nothing a silhouette shows is necessary for a win.',
      spec: null,
    },
    note: 'Outcomes decided by faces, markings, text or small parts are never checkable. Do not add a gate just to have something: gating a tiny coin would only cause re-do loops.',
  },
  {
    id: 'catch_behind_back',
    tags: ['judge_only'],
    input: {
      type: 'skill',
      claim: 'Ben throws a tennis ball up and catches it behind his back.',
      success_criteria: ['Ben catches the ball behind his back before it touches the ground.'],
      failure_criteria: ['The ball touches the ground.', 'Ben catches it in front of his body.'],
      edge_cases: [],
      attempts: single,
    },
    output: {
      decision: 'judge_only',
      why: 'What decides it (behind the back vs in front, before the ground) is a momentary pose, and a caught ball ends in his hand either way.',
      spec: null,
    },
    note: 'judge_only because success turns on HOW the catch happened (behind the back, not in front), a momentary pose between samples, and the end state is the same for a front catch, a back catch or a dropped ball picked back up; there is no static target to gate. This is not "every catch is judge_only": when a catch or landing must leave the object in a distinctive place (a grape caught in the mouth, a ball caught in a bucket), a missed one is seen lying away from it, so ends_at(object, target) applies.',
  },
  {
    id: 'keepy_uppy_ten',
    tags: ['judge_only'],
    input: {
      type: 'skill',
      claim: 'Kai keeps a soccer ball in the air with his feet for 10 touches.',
      success_criteria: ['10 touches in a row without the ball hitting the ground.'],
      failure_criteria: ['The ball touches the ground before 10 touches.', 'Kai uses his hands.'],
      edge_cases: [
        {
          question: 'Do knee touches count?',
          answer: 'Yes, feet, knees and head all count; hands do not.',
          asked_by: judge,
        },
      ],
      attempts: single,
    },
    output: {
      decision: 'judge_only',
      why: 'Success is a count of touches, which sparse frames cannot verify.',
      spec: null,
    },
    note: 'Counts of touches, catches, throws or tries are always judge_only, even in a single recording: the frames are sparse, so no end state or window proves or disproves the count.',
  },
];

export interface SelectFewShotsOptions {
  /** Prefer examples sharing one of these tags (undefined = no preference: all, in order). */
  tags?: readonly ChallengeTag[];
  /** Cap on the number returned (undefined = no cap). */
  max?: number;
  /** Tags always kept when filtering (default ['judge_only']: the "don't over-check" examples). */
  alwaysTags?: readonly ChallengeTag[];
}

/**
 * The examples to put in the prompt, in a stable order. Today (no options) every example in array
 * order. With `tags`: the examples sharing a tag, plus those carrying an `alwaysTags` tag, in array
 * order; `max` caps the total by dropping tag matches first, so always-kept ones stay.
 */
export function selectFewShots(
  _input: CompileInput,
  opts: SelectFewShotsOptions = {},
  pool: readonly FewShot[] = FEW_SHOTS,
): FewShot[] {
  let picked = [...pool];
  if (opts.tags !== undefined) {
    const want = new Set(opts.tags);
    const always = new Set(opts.alwaysTags ?? ['judge_only']);
    const hit = (f: FewShot) => f.tags.some((t) => want.has(t));
    const keep = (f: FewShot) => f.tags.some((t) => always.has(t));
    const hits = pool.filter(hit);
    const kept = pool.filter((f) => !hit(f) && keep(f));
    // `max` trims the tag matches first, so the always-kept examples survive any cap that can
    // hold them (a cap smaller than the always-kept set trims those too).
    picked =
      opts.max === undefined
        ? [...hits, ...kept]
        : [...hits.slice(0, Math.max(0, opts.max - kept.length)), ...kept.slice(0, opts.max)];
    // Back to array order so the rendered prompt is stable for a given selection.
    const order = new Map(pool.map((f, i) => [f.id, i]));
    picked.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  } else if (opts.max !== undefined) {
    picked = picked.slice(0, opts.max);
  }
  return picked;
}
