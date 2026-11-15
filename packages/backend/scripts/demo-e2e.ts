/**
 * `npm run demo:e2e` (CONTRACTS §17): a scripted full flow against all mocks
 * — two simulated users through the HTTP/WS API (signed requests): enroll,
 * huddle, paper-ball bet through consent settlement, a dispute → replay
 * booth → panel, an AI-judged bet and a World Mode market bet. Offline, no
 * keys, no money (ALLOW_SPEND is never set). Exit code 0 iff every check passed.
 */
import { runDemo } from './demo/run.js';

if (process.env['ALLOW_SPEND']) {
  console.error('demo:e2e refuses to run with ALLOW_SPEND set');
  process.exit(2);
}

const r = await runDemo({ echo: true });
if (!r.ok) {
  for (const f of r.failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
