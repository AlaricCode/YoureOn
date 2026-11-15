// Guardrail refusal rules (SCHEMAS §3 Refusals, BRIEF 5c, API-CONTRACT §4.3 / §7.1).
//
// BRIEF 5c: the judge "refuses unsafe, illegal or harmful challenges (anything dangerous,
// alcohol or drugs, self-harm, or involving minors) and says so with a joke". SCHEMAS §3 adds
// `illegal` and `other` (harassment, non-consensual dares, anything else unsafe).
//
// Two layers:
//  1. prefilterRefusal(): this file. A deterministic keyword prefilter run SYNCHRONOUSLY on every
//     propose_terms call. A hit returns the GuardrailRefusal inline as the tool result, so the
//     agent speaks the quip. It is deliberately narrow (obvious cases only, low false-positive
//     risk on the demo's bottle-flip / free-throw bets).
//  2. The async LLM guardrail (API-CONTRACT §7.1, `claude-haiku-5-5`), which fails closed before
//     the lock. Not built here (D1-J1/D2-J1; PENDING-KEY). GUARDRAIL_POLICY is its policy text.
//
// Over-cap stakes are NOT refusals (STAKE_ABOVE_MAX DraftIssue); 18+ is checked at signup.
import type { GuardrailRefusal, RefusalCategory, TermsProposal } from '../negotiation';

/** One line per category; shared by the agent prompt and the async LLM guardrail. */
export const GUARDRAIL_POLICY: Record<RefusalCategory, string> = {
  dangerous:
    'Physical danger to anyone: heights, roofs, traffic, fire, weapons, vehicles, choking or breath-holding games, eating non-food, fights, stunts that can injure.',
  alcohol_drugs:
    'Drinking alcohol, drinking games, chugging, getting drunk or high, drugs, vapes, pills, or anything consumed to intoxicate.',
  self_harm:
    'Hurting yourself on purpose: cutting, burning, starving, punching yourself, pain-endurance dares, or anything about suicide.',
  minors:
    'Any challenge that involves or targets a child, a minor or anyone under 18, as performer, subject or audience.',
  illegal:
    'Crimes: stealing, shoplifting, vandalism, graffiti, trespassing, breaking in, fraud, driving offences.',
  other:
    'Harassing or humiliating someone, involving strangers or anyone who did not agree, sexual dares, or anything else unsafe.',
};

/**
 * PG-13, one line, never preachy (SCHEMAS GuardrailRefusal.quip, NText(140)).
 * The judge speaks these verbatim, so each one also tells the players to pick something else.
 */
export const REFUSAL_QUIPS: Record<RefusalCategory, string> = {
  dangerous:
    "Hard pass. I judge bottle flips, not ER visits. Pick something that won't need stitches.",
  alcohol_drugs: 'Chugging contests? I judge bottle flips, not livers. Pick something else.',
  self_harm:
    'Nope. Nobody gets hurt on my docket, especially not by their own hand. Pick something else.',
  minors: 'Leave the kids out of it. Adults only in my courtroom. Pick something else.',
  illegal: "I'm a judge. I'm not presiding over a crime. Pick something legal.",
  other: 'Not on my docket. Keep it fair, keep it between you two. Pick something else.',
};

interface Rule {
  category: RefusalCategory;
  patterns: RegExp[];
}

// Priority order: the most protective category wins when several match
// (e.g. "kid chugs a beer" is `minors`).
const RULES: Rule[] = [
  {
    category: 'minors',
    patterns: [
      /\b(kids?|child|children|minors?|toddlers?|babies|infants?)\b/,
      /\b(little|baby|kid) (brother|sister|cousin)\b/,
      /\bmy (son|daughter|nephew|niece)\b/,
      /\b(under|younger than) (18|eighteen)\b/,
      /\b(1[0-7]|[1-9])[- ]?(year|yr)s?[- ]olds?\b/,
      // spoken ages come back from ASR as words: "a twelve-year-old", "he's twelve years old"
      /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)[- ](year|yr)s?[- ]olds?\b/,
      /\b(aged?|he's|she's|he is|she is) (1[0-7]|[1-9]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)( years old)?\b(?! (dollars|bucks|minutes|seconds|times|tries|feet|meters|points|for|of|in|out|up|down|ahead|behind))/,
      /\b(teen|teenager|preteen|tween)s?\b/,
      /\b(middle|high|elementary|grade) school(er)?s?\b/,
      /\bbabysit/,
    ],
  },
  {
    category: 'self_harm',
    patterns: [
      /\b(cut|cuts|cutting|burn|burns|burning|hurt|hurts|hurting|harm|harms|harming|punch|punches|punching|slap|slaps|slapping|starve|starves|starving|scratch(es|ing)?) (yourself|himself|herself|themselves|myself)\b/,
      /\bself[- ]harm/,
      /\bsuicid/,
      /\bkill (yourself|himself|herself|themselves|myself)\b/,
      /\b(no|without) (food|eating|water) for\b/,
      /\b(starve|starving|fasting) for\b/,
    ],
  },
  {
    category: 'alcohol_drugs',
    patterns: [
      /\b(beers?|vodka|tequila|whiske?y|rum|gin|wine|liquor|booze|alcohol|alcoholic|soju|sake|jager(bomb)?s?|cocktails?|hard seltzers?)\b/,
      /\b(chug|chugs|chugging|shotgun|shotguns|shotgunning|keg stand|beer pong|flip cup|drinking game)\b/,
      /\b(drunk|wasted|hammered|tipsy|stoned|(get|gets|getting) high)\b/,
      /\b(weed|cannabis|marijuana|edibles?|joints?|bongs?|vapes?|vaping|nicotine|cocaine|coke line|molly|mdma|ecstasy|lsd|acid tab|shrooms|ketamine|xanax|adderall|pills?|drugs?)\b/,
      /\b(smoke|smokes|smoking) (a|some|the)? ?(cigarette|cig|joint|blunt)s?\b/,
    ],
  },
  {
    category: 'dangerous',
    patterns: [
      /\b(jump|jumps|jumping|leap|leaps|leaping|backflip|backflips|flip|flips) (off|from) (a |the )?(roof|balcony|bridge|cliff|building|window|ledge|car|stairs)\b/,
      /\b(roof|rooftop|balcony railing|ledge)\b/,
      /\b(on fire|set fire|light (it|him|her|them|himself|herself|yourself) on fire|lighter fluid|gasoline|fireworks? (in|at)|flamethrower)\b/,
      /\b(knife|knives|blade|gun|guns|firearm|pistol|rifle|taser|machete|sword)\b/,
      /\b(traffic|highway|train tracks|railroad|in front of (a |the )?(car|bus|train))\b/,
      /\b((hold|holds|holding) (your|his|her|their) breath|choke|choking|strangle|pass out|blackout challenge)\b/,
      /\b(eat|eats|eating|swallow|swallows|swallowing|lick|licks|licking) (a |an |the )?(tide pod|laundry pod|detergent|bleach|battery|batteries|glass|soap|cinnamon spoon|spoonful of cinnamon)\b/,
      /\b(drive|drives|driving) (blindfolded|with (your|his|her) eyes closed)\b/,
      /\b(fight|fights|fighting|punch|punches|punching|slap|slaps|slapping|tackle|tackles|headbutt|headbutts) (a |the |that )?(stranger|guy|man|woman|person|bouncer|cop|him|her|them)\b/,
    ],
  },
  {
    category: 'illegal',
    patterns: [
      /\b(steal|steals|stealing|stole|shoplift|shoplifts|shoplifting|pickpocket|rob|robs|robbing|break into|breaks into|breaking into|burgl)/,
      /\b(vandali[sz]e|vandalism|graffiti|spray[- ]paint (a|the|his|her)|key (a|his|her|their) car|slash (the )?tires)\b/,
      /\b(trespass|sneak into|sneaks into|hop the fence)\b/,
      /\b(fake id|counterfeit|forge|forging)\b/,
      /\b(run|runs|running) (a |the )?red light\b/,
    ],
  },
  {
    category: 'other',
    patterns: [
      /\b(kiss|kisses|kissing|lick|licks|licking|touch|touches|touching|grab|grabs|grabbing|hug|hugs|hugging|follow|follows|following|flash|flashes|flashing|insult|insults|insulting|prank|pranks|pranking|film|films|filming|text|texts|texting) (a |some |random |that )?(strangers?|random (guy|girl|person|people)|passers?[- ]by|people on the street)\b/,
      /\b(strip|strips|stripping|naked|nude|streak|streaks|streaking)\b/,
      /\bprank call/,
    ],
  },
];

/** The text the prefilter scans: every judge-written string in the proposal. */
export function proposalText(
  p: Pick<TermsProposal, 'claim' | 'success_criteria' | 'failure_criteria' | 'edge_cases'>,
): string {
  return [
    p.claim,
    ...p.success_criteria,
    ...p.failure_criteria,
    ...p.edge_cases.flatMap((e) => [e.question, e.answer]),
  ].join(' \n ');
}

/** First matching category for free text, or null. Case-insensitive, ASCII-folded. */
export function matchRefusalCategory(text: string): RefusalCategory | null {
  const t = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, "'");
  for (const r of RULES) if (r.patterns.some((re) => re.test(t))) return r.category;
  return null;
}

/** The synchronous prefilter (API-CONTRACT §4.3): a GuardrailRefusal for an obvious case. */
export function prefilterRefusal(
  p: Pick<TermsProposal, 'claim' | 'success_criteria' | 'failure_criteria' | 'edge_cases'>,
): GuardrailRefusal | null {
  const category = matchRefusalCategory(proposalText(p));
  return category ? { refused: true, category, quip: REFUSAL_QUIPS[category] } : null;
}
