// The one money formatter for results. Every settled or result amount (a payout, a loss, a
// refund, a history row, the delta under the balance) reads with two decimals and a sign:
// "+$5.00", "−$5.00" (U+2212 minus), "$0.00". Stakes and pots are terms, not results: they keep
// the shared formatUsd rule everywhere ("$5", "$2.48").
// Pure TS: tested in node.

/** "$12.50" from whole cents (a negative input is shown as its absolute value). */
export function centsToUsd(cents: number): string {
  const c = Math.abs(Math.trunc(cents));
  return `$${Math.floor(c / 100)}.${(c % 100).toString().padStart(2, '0')}`;
}

/** "+$12.50" / "−$3.00" / "$0.00" from signed whole cents. */
export function signedCentsToUsd(cents: number): string {
  const c = Math.trunc(cents);
  return c > 0 ? `+${centsToUsd(c)}` : c < 0 ? `−${centsToUsd(-c)}` : centsToUsd(0);
}

/** The same from a signed micro-USDC string, rounded toward zero to whole cents. */
export function signedMicroToUsd(signedMicro: string): string {
  return signedCentsToUsd(Number(BigInt(signedMicro) / 10_000n));
}
