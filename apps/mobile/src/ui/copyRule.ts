// The copy rule as a reusable checker. Ported from Verdict app/test/support/copy_rule.dart
// (expectCopyRule) and verdict-spec.md §6.3-§6.4 / docs/CONTRACTS.md §12.12:
//   1. UI copy (labels, errors) is 1-3 words, never a sentence, no trailing period.
//   2. Nothing sits directly below a label in a smaller style (no subtitles, helper text, captions).
//   3. No emoji anywhere.
// Plus OUR crypto-copy audit (TASKS D5-M2): no "SOL", "lamports", "gas", "seed phrase",
// "wallet address", "transaction" or base58 string on a party screen. The terms code (8 hex chars)
// is the one allowed hash fragment (SCHEMAS §0).
//
// Our contracts win over Verdict's rule where they name exact copy: those strings are listed in
// CONTRACT_COPY and may only be used with role 'contract'. Data (names, claims, amounts, the terms
// code) uses role 'data': exempt from the word limit, still no emoji and no addresses.
//
// Pure TS: screens/tests pass plain strings or {text, role, fontSize, rect} items, so it runs in
// vitest without React Native.
import { copy } from './tokens';

/**
 * `body` is a step's one- or two-sentence explanation under its title ("Follow the prompts on
 * the camera. …"), from the enroll redesign. It may be a sentence and may sit under a label, but
 * it still gets the emoji, address and crypto-jargon checks.
 */
export type CopyRole = 'label' | 'error' | 'data' | 'contract' | 'body';

export type CopyViolationRule =
  | 'empty'
  | 'emoji'
  | 'too_many_words'
  | 'trailing_period'
  | 'sentence'
  | 'crypto_jargon'
  | 'address'
  | 'not_contract_copy'
  | 'helper_below_label';

export type CopyViolation = {
  readonly rule: CopyViolationRule;
  readonly text: string;
  readonly detail: string;
};

/**
 * Exact strings our specs mandate that break the 1-3 word / no-period rule. `{name}` is a display
 * name, `{amount}` a dollar amount, `{n}` an integer. Add a line here (with its source) instead of
 * loosening the rule for a screen.
 */
export const CONTRACT_COPY: readonly { readonly template: string; readonly source: string }[] = [
  { template: "Something's off. Not signing.", source: 'API-CONTRACT §6.3' },
  { template: "You're in. Waiting for {name}…", source: 'SCHEMAS §9.4, ARCHITECTURE §5.2' },
  { template: 'Nothing moves until you both lock in', source: 'ESCROW §5.0.3' },
  { template: 'Your {amount} is held until {name} locks in', source: 'ESCROW §5.0.3' },
  { template: "You're {n}-{n} against {name}", source: 'DATA-MODEL §7.1, TASKS D4-M2' },
  { template: "You're {n}-{n} against {name} ({signedAmount})", source: 'DATA-MODEL §7.1' },
  { template: '{name} challenged you', source: 'ARCHITECTURE §3.1' },
  { template: 'Challenge {name}?', source: 'TASKS D4-M1' },
  { template: '{name} is in', source: 'ARCHITECTURE §5.2' },
  { template: 'Hold to lock in {amount}', source: 'SCHEMAS §9.4' },
  { template: 'Declined. Nothing moved.', source: 'SCHEMAS §9.4' },
  { template: 'Expired. Nothing moved.', source: 'SCHEMAS §9.4' },
  { template: "Couldn't lock it. Nothing moved.", source: 'SCHEMAS §9.4' },
  { template: 'Terms changed, review again', source: 'TASKS D2-M4' },
];

// Verdict's ranges (pictographs, misc symbols + dingbats, mahjong..enclosed, VS16), plus keycaps,
// ZWJ sequences and the few emoji outside those blocks (watch, hourglass, media, stars, squares).
const EMOJI =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{FE0F}\u{20E3}\u{200D}\u{231A}\u{231B}\u{23E9}-\u{23FA}\u{2B05}-\u{2B07}\u{2B1B}\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}]/u;

/** TASKS D5-M2 crypto-copy audit, plus the chain/token names spec §6.2 keeps out of primary UI. */
export const CRYPTO_JARGON: readonly RegExp[] = [
  /\bSOL\b/,
  /\bUSDC\b/i,
  /\bSolana\b/i,
  /\blamports?\b/i,
  /\bgas\b/i,
  /\bseed phrase\b/i,
  /\bwallets?\b/i,
  /\btransactions?\b/i,
  /\bdevnet\b/i,
  /\bblockchain\b/i,
];

/** A base58 run long enough to be a key or signature (32-byte keys are 32-44 chars). */
const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]{32,}/;

const normalize = (s: string) => s.replace(/[‘’]/g, "'").trim();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const CONTRACT_RES: readonly RegExp[] = CONTRACT_COPY.map(({ template }) => {
  const re = template
    .split(/(\{name\}|\{amount\}|\{signedAmount\}|\{n\})/)
    .map((part) => {
      if (part === '{name}') return '\\S.{0,31}';
      if (part === '{amount}') return '\\$\\d{1,6}(?:\\.\\d{2})?';
      if (part === '{signedAmount}') return '[+−-]\\$\\d{1,6}(?:\\.\\d{2})?';
      if (part === '{n}') return '\\d{1,4}';
      return escapeRe(part.replace(/[\u2018\u2019]/g, "'"));
    })
    .join('');
  return new RegExp(`^${re}$`, 'u');
});

/** True if `text` is one of the CONTRACT_COPY templates filled in. */
export const isContractCopy = (text: string): boolean =>
  CONTRACT_RES.some((re) => re.test(normalize(text)));

export const countWords = (text: string): number => {
  const t = text.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
};

/** Checks one string for its role. Empty array = passes. */
export function checkCopy(text: string, role: CopyRole = 'label'): CopyViolation[] {
  const out: CopyViolation[] = [];
  const v = (rule: CopyViolationRule, detail: string) => out.push({ rule, text, detail });
  const t = normalize(text);

  if (t === '') {
    if (role !== 'data') v('empty', 'UI copy must not be blank');
    return out;
  }
  if (EMOJI.test(t)) v('emoji', 'no emoji anywhere (spec §6.4)');
  if (BASE58_RUN.test(t)) v('address', 'no addresses or signatures on a party screen');
  if (role !== 'data') {
    const hit = CRYPTO_JARGON.find((re) => re.test(t));
    if (hit) v('crypto_jargon', `chain jargon in copy: ${hit.source}`);
  }

  if (role === 'contract') {
    if (!isContractCopy(t))
      v('not_contract_copy', 'not one of CONTRACT_COPY; use a 1-3 word label');
    return out;
  }
  if (role === 'data' || role === 'body') return out;

  // label / error
  if (countWords(t) > copy.maxLabelWords)
    v('too_many_words', `labels are 1-${copy.maxLabelWords} words`);
  if (t.endsWith('.')) v('trailing_period', 'labels never end in a period');
  if (/[.!?]\s+\S/.test(t)) v('sentence', 'labels are not sentences (no helper text)');
  return out;
}

export function isCopyOk(text: string, role: CopyRole = 'label'): boolean {
  return checkCopy(text, role).length === 0;
}

/** Throws with every violation; for tests and dev-only asserts. */
export function assertCopy(text: string, role: CopyRole = 'label'): void {
  const violations = checkCopy(text, role);
  if (violations.length > 0) {
    throw new Error(
      `copy rule: ${violations.map((x) => `${x.rule} in "${x.text}" (${x.detail})`).join('; ')}`,
    );
  }
}

// ---------------------------------------------------------------------------------------
// Screen-level check (Verdict rule 2): no smaller text directly below a label
// ---------------------------------------------------------------------------------------

export type Rect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** One rendered text node, e.g. from onLayout or a test renderer. */
export type ScreenText = {
  readonly text: string;
  readonly role: CopyRole;
  readonly fontSize: number;
  readonly rect: Rect;
};

const hOverlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));

/** Every per-string violation, plus `helper_below_label` for a subtitle / caption under a label. */
export function checkScreenCopy(items: readonly ScreenText[]): CopyViolation[] {
  const out: CopyViolation[] = [];
  for (const item of items) out.push(...checkCopy(item.text, item.role));
  for (const a of items) {
    if (a.role === 'data' || a.role === 'body' || a.text.trim() === '') continue;
    const aBottom = a.rect.y + a.rect.height;
    for (const b of items) {
      // A step's explanation (`body`) may sit under its title.
      if (a === b || b.role === 'body' || b.text.trim() === '') continue;
      const below = b.rect.y >= aBottom - 1 && b.rect.y - aBottom <= copy.belowGapPt;
      const overlap = hOverlap(a.rect, b.rect) > 0.5 * Math.min(a.rect.width, b.rect.width);
      if (below && overlap && b.fontSize < a.fontSize) {
        out.push({
          rule: 'helper_below_label',
          text: b.text,
          detail: `smaller text directly below the label "${a.text}"`,
        });
      }
    }
  }
  return out;
}
