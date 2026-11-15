/**
 * The committed Anchor IDL (`packages/backend/idl/verdict.json`, §9.1) is
 * normative for instruction account order. It is used by the transaction
 * builder (mock and devnet), and its `address` is the default
 * `VERDICT_PROGRAM_ID`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface IdlAccountItem {
  name: string;
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
  address?: string;
  pda?: unknown;
  relations?: string[];
}

export interface IdlInstruction {
  name: string;
  discriminator: number[];
  accounts: IdlAccountItem[];
  args: { name: string; type: unknown }[];
}

export interface VerdictIdl {
  address: string;
  metadata: { name: string; version: string; spec: string };
  instructions: IdlInstruction[];
  accounts?: unknown[];
  events?: { name: string; discriminator: number[] }[];
  errors?: { code: number; name: string; msg?: string }[];
  types?: unknown[];
}

export const IDL_PATH = fileURLToPath(new URL('../../idl/verdict.json', import.meta.url));

/** Program ID the Chain team committed (used when the IDL is absent). */
export const FALLBACK_PROGRAM_ID = 'dbqDmF6YtjPygXTvJD31CNADoLqiUG8pZgj1zpHaMye';

let cached: VerdictIdl | null | undefined;

/** Loads the committed IDL, or null if it does not exist (yet). */
export function loadIdl(path: string = IDL_PATH): VerdictIdl | null {
  if (path === IDL_PATH && cached !== undefined) return cached;
  let out: VerdictIdl | null = null;
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as VerdictIdl;
    if (!parsed || !Array.isArray(parsed.instructions)) throw new Error(`IDL at ${path} has no instructions`);
    out = parsed;
  }
  if (path === IDL_PATH) cached = out;
  return out;
}

export function requireIdl(path?: string): VerdictIdl {
  const idl = loadIdl(path);
  if (!idl) throw new Error(`Verdict IDL not found at ${path ?? IDL_PATH}`);
  return idl;
}

export function defaultProgramId(): string {
  return loadIdl()?.address ?? FALLBACK_PROGRAM_ID;
}

export function idlInstruction(idl: VerdictIdl, name: string): IdlInstruction {
  const ix = idl.instructions.find((i) => i.name === name);
  if (!ix) throw new Error(`IDL has no instruction ${name}`);
  return ix;
}
