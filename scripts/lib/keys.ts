// Demo keypairs (ESCROW §10.2, SETUP-CHECKLIST KP1-KP8). One solana-keygen JSON file per role
// (`[64 bytes: seed ‖ pubkey]`), so the same files work with the `solana` / `anchor` CLIs.
// File names end in `-keypair.json`, which the repo .gitignore already ignores everywhere.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { createKeyPairSignerFromBytes, type KeyPairSigner } from '@solana/kit';

export const KEY_ROLES = [
  'deployer',
  'fee-payer',
  'judge',
  'appeal',
  'treasury',
  'demo-a',
  'demo-b',
] as const;
export type KeyRole = (typeof KEY_ROLES)[number];

export const KEY_INFO: Record<KeyRole, { what: string; secret: string }> = {
  deployer: {
    what: 'deployer = upgrade authority = Config admin (human-held; never on the server)',
    secret: 'password manager only',
  },
  'fee-payer': {
    what: 'server fee payer = rent payer = nonce authority (pin in packages/shared FEE_PAYER_PUBKEY)',
    secret: 'Fly FEE_PAYER_SECRET_KEY',
  },
  judge: { what: 'judge_authority (0 SOL)', secret: 'Fly JUDGE_AUTHORITY_SECRET_KEY' },
  appeal: { what: 'appeal_authority (0 SOL)', secret: 'Fly APPEAL_AUTHORITY_SECRET_KEY' },
  treasury: { what: 'devnet USDC float (0 SOL)', secret: 'Fly TREASURY_SECRET_KEY' },
  'demo-a': { what: 'custodial demo party A (USDC only, 0 SOL)', secret: 'smoke/demo only' },
  'demo-b': { what: 'custodial demo party B (USDC only, 0 SOL)', secret: 'smoke/demo only' },
};

export function keyPath(dir: string, role: KeyRole): string {
  return join(dir, `${role}-keypair.json`);
}

/** Loads a solana-keygen JSON keypair; kit checks the pubkey half against the seed. */
export async function loadKeypairFile(path: string): Promise<KeyPairSigner> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`missing keypair ${path} (run: npm run keys -- --dir ${dirname(path)})`);
  }
  const mode = statSync(path).mode & 0o077;
  if (mode !== 0) console.warn(`WARN: ${path} is readable by group/others (chmod 600 it)`);
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    !parsed.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
  ) {
    throw new Error(`${path} is not a 64-byte solana-keygen JSON keypair`);
  }
  return createKeyPairSignerFromBytes(Uint8Array.from(parsed as number[]));
}

export function loadRole(dir: string, role: KeyRole): Promise<KeyPairSigner> {
  return loadKeypairFile(keyPath(dir, role));
}

export async function loadRoles<const R extends readonly KeyRole[]>(
  dir: string,
  roles: R,
): Promise<{ [K in R[number]]: KeyPairSigner }> {
  const out: Partial<Record<KeyRole, KeyPairSigner>> = {};
  for (const role of roles) out[role] = await loadRole(dir, role);
  return out as { [K in R[number]]: KeyPairSigner };
}

/** The repo root (git toplevel of the cwd), or null outside a git checkout. */
export function repoRoot(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Throws unless every path is outside the repo or git-ignored. A keypair file must never be
 * committable (TASKS §3.2; gitleaks only catches it after the fact).
 */
export function assertNotCommittable(paths: readonly string[]): void {
  const root = repoRoot();
  if (!root) return;
  for (const p of paths) {
    const rel = relative(root, p);
    if (rel.startsWith('..') || rel === '') continue;
    try {
      execFileSync('git', ['-C', root, 'check-ignore', '-q', '--no-index', rel], {
        stdio: 'ignore',
      });
    } catch {
      throw new Error(
        `${rel} is inside the repo and NOT gitignored; use a directory outside the repo or under .keys/`,
      );
    }
  }
}
