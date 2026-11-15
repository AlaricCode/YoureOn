#!/usr/bin/env -S npx tsx
// Generates the demo keypairs that do not exist yet (ESCROW §10.2; SETUP-CHECKLIST KP1-KP8):
// deployer (= upgrade authority = Config admin), server fee payer, judge, appeal, treasury and the
// two custodial demo party wallets. solana-keygen JSON format, one `<role>-keypair.json` per role.
//
//   npm run keys                          -> ~/.config/solana/youre-on/
//   npm run keys -- --dir /tmp/yo-keys    any directory (inside the repo it must be gitignored)
//
// Never overwrites (O_EXCL), files are chmod 600 and the directory 700. Prints ONLY pubkeys.
// Offline: no RPC is used.
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

import { createKeyPairSignerFromBytes } from '@solana/kit';

import { DEFAULT_KEYS_DIR, expandPath, parseCli, run } from './lib/cli';
import { assertNotCommittable, KEY_INFO, KEY_ROLES, keyPath, loadKeypairFile } from './lib/keys';

const USAGE = `usage: npm run keys -- [--dir <dir>]   (default ${DEFAULT_KEYS_DIR})
Generates any missing role keypair; existing files are kept and their pubkeys printed.`;

/** A fresh Ed25519 keypair as solana-keygen's 64 bytes (seed ‖ pubkey). */
function newKeypairBytes(): Uint8Array {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const d = privateKey.export({ format: 'jwk' }).d;
  const x = publicKey.export({ format: 'jwk' }).x;
  if (!d || !x) throw new Error('ed25519 JWK export failed');
  const seed = Buffer.from(d, 'base64url');
  const pub = Buffer.from(x, 'base64url');
  if (seed.length !== 32 || pub.length !== 32) throw new Error('unexpected ed25519 key length');
  const out = new Uint8Array(64);
  out.set(seed, 0);
  out.set(pub, 32);
  seed.fill(0);
  return out;
}

run(async () => {
  const { values } = parseCli(USAGE, { dir: { type: 'string' } });
  const dir = expandPath(values.dir ?? values['keys-dir'] ?? DEFAULT_KEYS_DIR);
  const paths = KEY_ROLES.map((r) => keyPath(dir, r));
  assertNotCommittable(paths);

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  console.log(`keys dir: ${dir}\n`);

  const rows: string[][] = [];
  for (const role of KEY_ROLES) {
    const path = keyPath(dir, role);
    let state = 'existing';
    if (!existsSync(path)) {
      const bytes = newKeypairBytes();
      // Validate before writing: kit re-derives the pubkey from the seed and compares.
      await createKeyPairSignerFromBytes(bytes);
      writeFileSync(path, `${JSON.stringify(Array.from(bytes))}\n`, { flag: 'wx', mode: 0o600 });
      bytes.fill(0);
      state = 'NEW';
    }
    chmodSync(path, 0o600);
    const signer = await loadKeypairFile(path);
    rows.push([role, signer.address, state, KEY_INFO[role].what]);
  }
  const w = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i]!.length)));
  for (const r of rows) {
    console.log(`${r[0]!.padEnd(w[0]!)}  ${r[1]!.padEnd(w[1]!)}  ${r[2]!.padEnd(w[2]!)}  ${r[3]}`);
  }
  console.log(
    `\nSecrets go to: ${KEY_ROLES.filter((r) => KEY_INFO[r].secret.startsWith('Fly'))
      .map((r) => `${r} -> ${KEY_INFO[r].secret}`)
      .join(', ')}.` +
      '\nNever paste a keypair file anywhere else; this script prints pubkeys only.',
  );
});
