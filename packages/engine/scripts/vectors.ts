/**
 * `npm run vectors`            → writes testvectors/*.json and testvectors/fuzz.jsonl (deterministic)
 * `npm run vectors -- --check` → exits 1 if the committed files differ from a fresh generation
 *
 * The output directory defaults to <repo>/testvectors; override with `--out <dir>`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFiles } from './vectors/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const check = args.includes('--check');
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? resolve(args[outIdx + 1]!) : resolve(here, '../../../testvectors');

/** Files in the directory that the generator owns (everything it would write or delete). */
function ownedFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json') || f.endsWith('.jsonl'));
}

const files = buildFiles();
const existing = ownedFiles(outDir);

if (check) {
  const problems: string[] = [];
  for (const [name, content] of files) {
    const path = join(outDir, name);
    if (!existsSync(path)) problems.push(`missing: ${name}`);
    else if (readFileSync(path, 'utf8') !== content) problems.push(`out of date: ${name}`);
  }
  for (const name of existing) if (!files.has(name)) problems.push(`stale (not generated): ${name}`);
  if (problems.length) {
    console.error(`testvectors are not up to date (${problems.length} problems); run \`npm run vectors\`:`);
    for (const p of problems.slice(0, 50)) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`testvectors up to date: ${files.size} files in ${outDir}`);
} else {
  mkdirSync(outDir, { recursive: true });
  let written = 0;
  for (const [name, content] of files) {
    const path = join(outDir, name);
    if (existsSync(path) && readFileSync(path, 'utf8') === content) continue;
    writeFileSync(path, content);
    written++;
  }
  let removed = 0;
  for (const name of existing) {
    if (!files.has(name)) {
      rmSync(join(outDir, name));
      removed++;
    }
  }
  console.log(`testvectors: ${files.size} files in ${outDir} (${written} written, ${removed} removed)`);
}
