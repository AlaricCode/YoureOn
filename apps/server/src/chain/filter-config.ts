// The CONFIG block of infra/quicknode/filter.js, generated from the compiled escrow IDL and the
// pinned ESCROW_ID. infra/quicknode/build-filter.ts writes it; test/chain-unit.test.ts fails on
// drift.
//
// Spec: docs/planning/ESCROW-PROGRAM.md §7.1.
import { getProgramDerivedAddress, type Address } from '@solana/kit';
import { ESCROW_ID, EVENT_AUTHORITY_SEED } from '@youre-on/shared/chain/constants';
import { EVENT_IX_TAG_LE, IDL_EVENTS } from './decoder';

export interface FilterConfig {
  /** ESCROW_ID. The filter matches inner instructions to exactly this program. */
  programId: string;
  /** Anchor event-cpi authority PDA ["__event_authority"]: first account of every emit_cpi! ix. */
  eventAuthority: string;
  /** Anchor EVENT_IX_TAG, little-endian bytes. */
  eventIxTag: number[];
  /** 8-byte event discriminator (hex) → IDL event name (a routing hint only). */
  events: Record<string, string>;
}

export const FILTER_CONFIG_START = '/*__CONFIG_START__*/';
export const FILTER_CONFIG_END = '/*__CONFIG_END__*/';

/** The event-authority PDA of ESCROW_ID (precomputed into the filter: no crypto in the sandbox). */
export async function eventAuthorityAddress(programId: string = ESCROW_ID): Promise<string> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId as Address,
    seeds: [EVENT_AUTHORITY_SEED],
  });
  return pda;
}

export async function buildFilterConfig(): Promise<FilterConfig> {
  const events: Record<string, string> = {};
  for (const e of IDL_EVENTS) events[Buffer.from(e.discriminator).toString('hex')] = e.name;
  return {
    programId: ESCROW_ID,
    eventAuthority: await eventAuthorityAddress(),
    eventIxTag: [...EVENT_IX_TAG_LE],
    events,
  };
}

/** Replaces the CONFIG block between the markers in filter.js source. */
export function renderFilterSource(src: string, config: FilterConfig): string {
  const a = src.indexOf(FILTER_CONFIG_START);
  const b = src.indexOf(FILTER_CONFIG_END);
  if (a < 0 || b < a) throw new Error('filter.js: CONFIG markers not found');
  const block = `${FILTER_CONFIG_START}\nvar CONFIG = ${JSON.stringify(config, null, 2)};\n`;
  return src.slice(0, a) + block + src.slice(b);
}
