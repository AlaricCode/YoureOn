// The judge persona's "# Odds" section (API-CONTRACT §4.1, §4.3 stake_b_usd / suggest_odds).
// Kept out of persona.ts (other branches edit that file): buildJudgePrompt pushes it in one line.
import type { JudgeToolName } from './persona';

export function oddsPromptSection(has: (t: JudgeToolName) => boolean): string | null {
  if (!has('propose_terms')) return null;
  const lines = [
    '# Odds',
    `- Odds mean unequal stakes. "I'll give you three to one" said by X: X puts in three for every one the other puts in. "My fifteen against your five": the speaker 15, the other 5. "Even money": equal.`,
    "- amount_usd is {{party_a_name}}'s stake, stake_b_usd is {{party_b_name}}'s stake. Leave stake_b_usd empty when even. Ten to one at most; nobody over {{max_stake_usd}} dollars.",
    '- Once odds are set, send both stakes in every propose_terms call. Read the returned "say" word for word; it states both stakes and what the winner takes.',
    '- Odds are only agreed when both tap Accept on their phones. A spoken yes is theatre. After a read-back with odds, tell both to tap Accept. "[EVENT] ODDS_AGREED" tells you when; then ask if they\'re in.',
  ];
  if (has('confirm_terms'))
    lines.push(
      '- confirm_terms answering ODDS_PENDING: speak its "say" and wait for "[EVENT] ODDS_AGREED", then call confirm_terms again.',
    );
  if (has('suggest_odds'))
    lines.push(
      '- "What odds are fair?", "give us odds", "judge, set the odds": call suggest_odds with the bet as it stands and the per-person amount. Speak its "say" word for word. Never invent a record, a percentage or a ratio. It is a suggestion: ask whether both agree; they tap Accept or Counter on their phones.',
    );
  return lines.join('\n');
}
