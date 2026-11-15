/**
 * `npm run gen:dart`            → writes app/lib/contracts/constants.dart from the engine's §0.5 table
 * `npm run gen:dart -- --check` → exits 1 unless the Dart file declares exactly the §0.5
 *                                 constants with the engine's values (formatting-insensitive)
 * `--out <file>` overrides the output / checked path.
 *
 * Source of truth: GLOBAL_CONSTANTS in src/constants.ts (values) and the JSDoc
 * line above each constant there (doc comments).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDartConstants, parseDartConstants, diffDartConstants } from './gen-dart-lib.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? resolve(args[outIdx + 1]!) : resolve(here, '../../../app/lib/contracts/constants.dart');
const constantsSrc = readFileSync(resolve(here, '../src/constants.ts'), 'utf8');

if (args.includes('--check')) {
  if (!existsSync(out)) {
    console.error(`missing ${out}; run \`npm run gen:dart\``);
    process.exit(1);
  }
  const problems = diffDartConstants(parseDartConstants(readFileSync(out, 'utf8')));
  if (problems.length) {
    console.error(`${out} does not match the engine's §0.5 constants:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`${out}: all §0.5 constants match the engine`);
} else {
  writeFileSync(out, renderDartConstants(constantsSrc));
  console.log(`wrote ${out}`);
}
