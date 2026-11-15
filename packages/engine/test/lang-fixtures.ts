/** Shared fixtures for lang*.test.ts (worked examples, §15). */
import type { CompileContext } from '../src/types.js';

export const CREATOR = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
export const FRIEND = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
export const THIRD = 'HN7cABqLq46Es1jh92dQQisAq662SmxEGGGsHHe4YWrH';
export const FOURTH = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';

export const CTX2: CompileContext = {
  creator: CREATOR,
  huddle: [
    { wallet: CREATOR, display_name: 'Alex', enrolled: true },
    { wallet: FRIEND, display_name: 'Maya', enrolled: true },
  ],
};

export const CTX4: CompileContext = {
  creator: CREATOR,
  huddle: [
    { wallet: CREATOR, display_name: 'Alex', enrolled: true },
    { wallet: FRIEND, display_name: 'Maya', enrolled: true },
    { wallet: THIRD, display_name: 'Sam', enrolled: true },
    { wallet: FOURTH, display_name: 'Jo', enrolled: false },
  ],
};

export const NAMES: Record<string, string> = { [CREATOR]: 'Alex', [FRIEND]: 'Maya', [THIRD]: 'Sam', [FOURTH]: 'Jo' };

export const PAPER_BALL_YAML = `version: 2
entities:
  shooter: person(p1)
  ball:    object("crumpled paper ball")
  can:     object("trash can")
  line:    region(tap)
legs:
  - id: 1
    actor_bound: true
    valid_attempt: ball released_by shooter while shooter behind line
    success: ball disappears_into can.opening
             or (ball inside can and ball at_rest 1s)
    rule: count(success) >= 1 within attempts 3
outcome: side(shooter) wins iff leg 1 true; else side(creator)
stake_each: 5_000_000
time_limit_s: 180
`;

export const PAPER_BALL_AST = {
  version: 2,
  kind: 'rules',
  participants: [CREATOR, FRIEND],
  sides: [0, 1],
  entities: [
    { name: 'shooter', kind: 'person', participant: 1 },
    { name: 'ball', kind: 'object', phrase: 'crumpled paper ball' },
    { name: 'can', kind: 'object', phrase: 'trash can' },
    { name: 'line', kind: 'region', shape: 'line' },
  ],
  legs: [
    {
      id: 1,
      actor_bound: true,
      attempt_window_frames: 50,
      valid_attempt: {
        op: 'and',
        args: [
          { op: 'released_by', a: { e: 'ball' }, b: { e: 'shooter' } },
          { op: 'behind', a: { e: 'shooter' }, b: { e: 'line' } },
        ],
      },
      success: {
        op: 'or',
        args: [
          { op: 'disappears_into', a: { e: 'ball' }, b: { e: 'can', sub: 'opening' } },
          {
            op: 'and',
            args: [
              { op: 'inside', a: { e: 'ball' }, b: { e: 'can' } },
              { op: 'at_rest', a: { e: 'ball' }, frames: 10 },
            ],
          },
        ],
      },
      rule: { kind: 'count', cmp: '>=', k: 1, attempts: 3 },
    },
  ],
  outcome: { if_true: 1, condition: { op: 'leg', id: 1 }, else: 0 },
  stake_each: 5000000,
  time_limit_s: 180,
};

export const CUP_TOWER_YAML = `version: 2
entities:
  tower: object("cup tower")
  fan:   object("fan")
legs:
  - id: 1
    actor_bound: false
    success: tower intact
    rule: holds(success) for 10s
outcome: side(creator) wins iff leg 1 true; else side(other)
stake_each: 2_000_000
time_limit_s: 30
`;

export const CUP_TOWER_AST = {
  version: 2,
  kind: 'rules',
  participants: [CREATOR, FRIEND],
  sides: [0, 1],
  entities: [
    { name: 'tower', kind: 'object', phrase: 'cup tower' },
    { name: 'fan', kind: 'object', phrase: 'fan' },
  ],
  legs: [
    {
      id: 1,
      actor_bound: false,
      attempt_window_frames: 50,
      success: { op: 'intact', a: { e: 'tower' } },
      rule: { kind: 'holds', frames: 100 },
    },
  ],
  outcome: { if_true: 0, condition: { op: 'leg', id: 1 }, else: 1 },
  stake_each: 2000000,
  time_limit_s: 30,
};

export const PUSHUPS_YAML = `version: 2
entities:
  me: person(p0)
legs:
  - id: 1
    actor_bound: true
    success: rep_count(me) >= 20
    rule: success before 60s
outcome: side(me) wins iff leg 1 true; else side(other)
stake_each: 10_000_000
time_limit_s: 90
`;

export const PUSHUPS_AST = {
  version: 2,
  kind: 'rules',
  participants: [CREATOR, FRIEND],
  sides: [0, 1],
  entities: [{ name: 'me', kind: 'person', participant: 0 }],
  legs: [
    {
      id: 1,
      actor_bound: true,
      attempt_window_frames: 50,
      success: { op: 'rep_count', a: { e: 'me' }, cmp: '>=', value: 20 },
      rule: { kind: 'before', frames: 600 },
    },
  ],
  outcome: { if_true: 0, condition: { op: 'leg', id: 1 }, else: 1 },
  stake_each: 10000000,
  time_limit_s: 90,
};

export const AI_JUDGED_YAML = `version: 2
kind: ai_judged
question: "Does Sam finish the hot sauce wing without drinking anything?"
outcome: side(B) wins iff yes; else side(A)
stake_each: 3_000_000
time_limit_s: 120
`;

export const AI_JUDGED_AST = {
  version: 2,
  kind: 'ai_judged',
  participants: [CREATOR, FRIEND],
  sides: [0, 1],
  entities: [],
  legs: [],
  question: 'Does Sam finish the hot sauce wing without drinking anything?',
  outcome: { if_true: 1, condition: { op: 'yes' }, else: 0 },
  stake_each: 3000000,
  time_limit_s: 120,
};

/** A minimal rules program body with one leg; `success`/`rule`/extra leg lines are substituted. */
export function oneLeg(opts: {
  entities?: string;
  success: string;
  rule?: string;
  actorBound?: boolean;
  extraLeg?: string;
  outcome?: string;
  timeLimit?: number;
  top?: string;
}): string {
  return `version: 2
${opts.top ?? ''}entities:
${opts.entities ?? '  ball: object("ball")\n  can: object("can")\n  area: region(zone)\n  mark: region(line)\n  anyone: person(any)'}
legs:
  - id: 1
    actor_bound: ${opts.actorBound ?? false}
    success: ${opts.success}
    rule: ${opts.rule ?? 'success'}
${opts.extraLeg ?? ''}outcome: ${opts.outcome ?? 'side(A) wins iff leg 1; else side(B)'}
stake_each: 1000000
time_limit_s: ${opts.timeLimit ?? 120}
`;
}
