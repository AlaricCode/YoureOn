// Measurement sink for N1/N11/N12/CU1 (docs/measurements.md). vitest swallows console.log from
// passing tests, so lines go to stderr; with ESCROW_MEASURE_OUT=<file> each record is also appended
// as one JSON line for the docs.
import { appendFileSync } from 'node:fs';

export function measure(label: string, data: Record<string, unknown>): void {
  const json = JSON.stringify({ label, ...data }, (_k, v: unknown) =>
    typeof v === 'bigint' ? Number(v) : v,
  );
  process.stderr.write(`MEASURE ${json}\n`);
  const out = process.env['ESCROW_MEASURE_OUT'];
  if (out) appendFileSync(out, `${json}\n`);
}
