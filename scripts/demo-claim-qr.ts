#!/usr/bin/env -S npx tsx
// Prints a one-time demo-claim QR (API-CONTRACT §1.3, §2.17; decision D-A): phone A / B scans it
// on the "Demo account" screen and becomes custodial party demo-a / demo-b.
//
//   npm run demo-claim-qr -- --party a|b [--base-url http://127.0.0.1:8080]
//        [--admin-token <DEMO_ADMIN_TOKEN>] [--name Logan] [--invert] [--json]
//
// Calls POST /v1/demo/claim-tokens (needs DEMO_MODE=true and X-YO-Demo-Key on the server) and
// prints the youreon://<word>/<token> link plus an ASCII QR. The token is single use and lives
// 10 min. The admin token may come from env DEMO_ADMIN_TOKEN instead of the flag. The QR is the
// key to a wallet seed: do not paste it anywhere public.
import { DemoClaimTokenResponse, DemoParty } from '@youre-on/shared/api';

import { parseCli, run } from './lib/cli';

const USAGE = `usage: npm run demo-claim-qr -- --party a|b [--base-url <url>] [--admin-token <token>]
          [--name <display name>] [--invert] [--json]
--invert: for light-background terminals (the default suits a dark one).
Issues a one-time (10 min) demo-claim QR for phone A or B (server DEMO_MODE=true).`;

type QrModule = { toQR: (content: string) => Uint8Array };

/**
 * ASCII QR via `toqr` (already in the lockfile through @expo/cli). Not a declared dependency, so
 * it is loaded by name at run time; without it only the link is printed.
 */
async function asciiQr(text: string, invert: boolean): Promise<string | null> {
  const name = 'toqr';
  let mod: QrModule;
  try {
    mod = (await import(name)) as QrModule;
  } catch {
    return null;
  }
  const cells = mod.toQR(text);
  const size = Math.round(Math.sqrt(cells.length));
  if (size * size !== cells.length) return null;
  const quiet = 2;
  const dark = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < size && y < size && cells[y * size + x] !== 0;
  // Two rows per line with half blocks. Default: light modules print as blocks (a dark terminal);
  // --invert prints dark modules as blocks (a light terminal).
  const ink = (x: number, y: number) => dark(x, y) === invert;
  const lines: string[] = [];
  for (let y = -quiet; y < size + quiet; y += 2) {
    let line = '';
    for (let x = -quiet; x < size + quiet; x++) {
      const top = ink(x, y);
      const bottom = ink(x, y + 1);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

run(async () => {
  const { values } = parseCli(USAGE, {
    'base-url': { type: 'string' },
    'admin-token': { type: 'string' },
    party: { type: 'string' },
    name: { type: 'string' },
    json: { type: 'boolean' },
    invert: { type: 'boolean' },
  });
  const party = DemoParty.safeParse(values.party);
  if (!party.success) {
    console.error(`--party must be a or b\n\n${USAGE}`);
    process.exit(2);
  }
  const base = (values['base-url'] ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
  const admin = values['admin-token'] ?? process.env['DEMO_ADMIN_TOKEN'];
  if (!admin) {
    console.error(`no admin token: pass --admin-token or set DEMO_ADMIN_TOKEN\n\n${USAGE}`);
    process.exit(2);
  }

  const res = await fetch(`${base}/v1/demo/claim-tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-YO-Demo-Key': admin },
    body: JSON.stringify({
      party: party.data,
      ...(values.name ? { display_name: values.name } : {}),
    }),
  });
  const text = await res.text();
  if (res.status !== 201 && res.status !== 200) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (j.error) msg = `${j.error.code}: ${j.error.message}`;
    } catch {
      // not JSON
    }
    // 404 = DEMO_MODE off, or a wrong admin token (the route hides itself either way).
    console.error(`claim-tokens ${res.status}: ${msg}`);
    process.exit(1);
  }
  const t = DemoClaimTokenResponse.parse(JSON.parse(text));
  if (values.json) {
    console.log(JSON.stringify(t));
    return;
  }
  const qr = await asciiQr(t.qr, values.invert === true);
  if (qr) console.log(`\n${qr}\n`);
  console.log(`party:   ${t.party} (${t.pubkey})`);
  console.log(`word:    ${t.word}`);
  console.log(`expires: ${t.expires_at} (single use)`);
  console.log(`link:    ${t.qr}`);
});
