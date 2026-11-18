#!/usr/bin/env -S npx tsx
// Records ONE real Gemini BTC 5-minute round from Gemini's PUBLIC REST API (no key; read-only
// GETs, a few per minute) for the server's REPLAY feed (apps/server/src/markets/replay.ts) and
// for fixtures:
//
//   npm run gemini-record -- [--out <recording.json>] [--replay-data <path>] [--timeout 600]
//
// It takes the current BTC05M window (or waits for the next one when < 60 s are left): the
// discovery list (this window's event + the next one's), the event detail while it is active,
// /strike and the BTC/USD ticker; then from expiry it polls the event detail every 2 s until
// Gemini settles it (status settled + resolutionSide; ~6-9 s after expiry), up to --timeout.
//   --out          the recording (default ./gemini-round-<ticker>.json)
//   --replay-data  also write the replay module (e.g. apps/server/src/markets/replay-data.ts)
//                  from this round; then run the server tests (gemini-replay checks its shape)
// Bodies are kept verbatim (parsed JSON of exactly what Gemini sent).
import { writeFileSync } from 'node:fs';

import { expandPath, parseCli, run } from './lib/cli';

const USAGE = `usage: npm run gemini-record -- [--out <recording.json>] [--replay-data <path>] [--timeout 600]
Records one real Gemini BTC 5-minute round (public REST, read-only) for the REPLAY feed.`;

const API = 'https://api.gemini.com';
const LIST = '/v1/prediction-markets/events?status=active&category=Crypto&limit=200';

type Json = Record<string, unknown>;
type Contract = Json & {
  label?: string;
  status?: string;
  effectiveDate?: string;
  expiryDate?: string;
  resolutionSide?: string;
};
type Event = Json & { ticker: string; series?: string; contracts?: Contract[] };

async function get(path: string): Promise<unknown> {
  const res = await fetch(API + path, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const up = (e: Event): Contract | undefined =>
  e.contracts?.find((c) => /^up$/i.test(String(c.label))) ?? e.contracts?.[0];

/** The live BTC05M window with at least `minLeftMs` to go, and the one after it. */
function pick(list: Event[], now: number, minLeftMs: number) {
  const btc = list
    .filter((e) => e.series === 'BTC05M' && up(e))
    .sort((a, b) => Date.parse(up(a)!.expiryDate!) - Date.parse(up(b)!.expiryDate!));
  const i = btc.findIndex((e) => {
    const c = up(e)!;
    return Date.parse(c.effectiveDate!) <= now && now < Date.parse(c.expiryDate!) - minLeftMs;
  });
  return i < 0 ? null : { cur: btc[i]!, next: btc[i + 1] ?? null };
}

run(async () => {
  const { values } = parseCli(USAGE, {
    out: { type: 'string' },
    'replay-data': { type: 'string' },
    timeout: { type: 'string' },
  });
  const deadline = Date.now() + Number(values.timeout ?? 600) * 1000;

  // 1. a window with >= 60 s left (else wait for the next one)
  let picked: ReturnType<typeof pick> = null;
  let list: Event[] = [];
  while (!picked) {
    list = ((await get(LIST)) as { data: Event[] }).data;
    picked = pick(list, Date.now(), 60_000);
    if (picked) break;
    if (Date.now() > deadline) throw new Error('no BTC05M window with 60 s left before --timeout');
    console.log('no window with 60 s left yet; waiting 15 s');
    await sleep(15_000);
  }
  const { cur, next } = picked;
  const c = up(cur)!;
  const expiry = Date.parse(c.expiryDate!);
  console.log(`window ${cur.ticker}: ${c.effectiveDate} -> ${c.expiryDate}`);
  if (!next) throw new Error('the discovery list has no next window to record');

  // 2. while active: the detail, the strike, BTC/USD
  const active = (await get(`/v1/prediction-markets/events/${cur.ticker}`)) as Event;
  const strike = await get(`/v1/prediction-markets/events/${cur.ticker}/strike`);
  const btcusd = await get('/v1/pubticker/btcusd');
  console.log(
    `active: ${JSON.stringify(up(active)?.['prices'] ?? {})}, strike ${JSON.stringify(strike)}`,
  );

  // 3. from expiry: every 2 s until Gemini settles it
  await sleep(Math.max(0, expiry - Date.now()));
  let settled: Event | null = null;
  while (!settled) {
    if (Date.now() > deadline) throw new Error('Gemini did not settle before --timeout');
    await sleep(2_000);
    const e = (await get(`/v1/prediction-markets/events/${cur.ticker}`)) as Event;
    const s = up(e);
    console.log(`  ${new Date().toISOString()} ${s?.status} ${s?.resolutionSide ?? '-'}`);
    if (String(s?.status).toLowerCase() === 'settled' && s?.resolutionSide) settled = e;
  }
  const side = up(settled)!.resolutionSide;
  console.log(
    `settled ${String(side).toUpperCase()} at ${String(up(settled)!['settlementValue'])}`,
  );

  const recording = {
    window_start: new Date(Date.parse(c.effectiveDate!)).toISOString(),
    expiry: new Date(expiry).toISOString(),
    ticker: cur.ticker,
    listed: list.find((e) => e.ticker === cur.ticker)!,
    next_listed: next,
    active,
    settled,
    strike,
    btcusd,
  };
  const out = expandPath(values.out ?? `gemini-round-${cur.ticker}.json`);
  writeFileSync(out, `${JSON.stringify(recording, null, 2)}\n`);
  console.log(`wrote ${out}`);

  if (values['replay-data']) {
    const path = expandPath(values['replay-data']);
    writeFileSync(
      path,
      `// Recorded Gemini responses for the REPLAY feed (markets/replay.ts): real public REST bodies of
// one BTC 5-minute round, ${cur.ticker} (${recording.window_start} -> ${recording.expiry}),
// recorded by scripts/gemini-record.ts; Gemini settled it "${String(side)}". Kept in src/ because
// the server image ships src/ only. Generated, never edited (test/gemini-replay.test.ts checks it).
// prettier-ignore
export const REPLAY_RECORDING = ${JSON.stringify(recording)} as const;
`,
    );
    console.log(`wrote ${path}`);
  }
});
