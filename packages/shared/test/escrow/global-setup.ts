// Runs once in the vitest main process (so the message is always visible): skip the escrow client
// suite with a clear reason when the program is not built, or fail when ESCROW_SO_REQUIRED=1 (CI).
import { ESCROW_SO, HAVE_MIMIC, HAVE_SO, MIMIC_SO, SO_REQUIRED } from './harness';

export default function setup(): void {
  if (HAVE_SO && !HAVE_MIMIC) {
    // E3 only: the mimic fixture program (packages/shared/scripts/build-mimic.sh).
    const msg = `escrow TS client suite: ${MIMIC_SO} not found; run \`bash packages/shared/scripts/build-mimic.sh\` for E3.`;
    if (SO_REQUIRED) throw new Error(`${msg} (ESCROW_SO_REQUIRED=1)`);
    console.warn(`\nSKIPPING E3: ${msg}\n`);
  }
  if (HAVE_SO) return;
  const msg = `escrow TS client suite: ${ESCROW_SO} not found; run \`anchor build\` in programs/escrow first.`;
  if (SO_REQUIRED) throw new Error(`${msg} (ESCROW_SO_REQUIRED=1)`);
  console.warn(`\nSKIPPING ${msg}\n`);
}
