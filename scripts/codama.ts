#!/usr/bin/env -S npx tsx
// Codama client generator for the escrow program (ESCROW §10.3 step 5, TASKS §6 rule 6).
// Reads the committed Anchor IDL (packages/shared/idl/escrow.json) and renders a @solana/kit 8.6
// client into packages/shared/src/chain/generated/, exported as `@youre-on/shared/escrow-client`.
//
//   npm run codama                    regenerate from packages/shared/idl/escrow.json
//   npm run codama -- --from-target   first copy programs/escrow/target/idl/escrow.json (after
//                                     `anchor build`) into packages/shared/idl/, then regenerate
//   npm run codama -- --check         regenerate into a temp dir and fail if the committed IDL or
//                                     client differ (CI escrow job, after `anchor build`)
//
// Versions are pinned exactly in the root package.json (codama 1.11.0, @codama/nodes-from-anchor
// 1.5.6, @codama/renderers-js 2.8.0). The output is prettier-ignored and eslint-ignored;
// it is formatted by the renderer with the repo's .prettierrc.json, so a rerun is byte-identical.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rootNodeFromAnchor, type AnchorIdl } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';
import {
  addPdasVisitor,
  constantPdaSeedNodeFromString,
  createFromRoot,
  pdaValueNode,
  programIdValueNode,
  setInstructionAccountDefaultValuesVisitor,
} from 'codama';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHARED = join(ROOT, 'packages/shared');
const IDL_PATH = join(SHARED, 'idl/escrow.json');
const TARGET_IDL_PATH = join(ROOT, 'programs/escrow/target/idl/escrow.json');
const GENERATED = 'src/chain/generated';

const args = new Set(process.argv.slice(2));
for (const a of args) {
  if (!['--from-target', '--check'].includes(a)) {
    console.error(`unknown flag ${a} (expected --from-target or --check)`);
    process.exit(2);
  }
}

const prettierOptions = JSON.parse(readFileSync(join(ROOT, '.prettierrc.json'), 'utf8')) as Record<
  string,
  unknown
>;

async function render(packageFolder: string, idl: AnchorIdl): Promise<void> {
  const codama = createFromRoot(rootNodeFromAnchor(idl));
  // The Anchor 1.2.2 IDL lists the #[event_cpi] accounts (`event_authority`, `program`) without a
  // PDA or address, so Codama would make every caller pass them. Default them here instead:
  // event_authority = PDA ["__event_authority"] under the program (ESCROW §2), program = itself.
  codama.update(
    addPdasVisitor({
      escrow: [
        {
          name: 'eventAuthority',
          docs: ['Anchor event-cpi authority: PDA ["__event_authority"] (ESCROW §2, §7.1).'],
          seeds: [constantPdaSeedNodeFromString('utf8', '__event_authority')],
        },
      ],
    }),
  );
  codama.update(
    setInstructionAccountDefaultValuesVisitor([
      { account: 'eventAuthority', defaultValue: pdaValueNode('eventAuthority') },
      { account: 'program', defaultValue: programIdValueNode() },
    ]),
  );
  await codama.accept(
    renderVisitor(packageFolder, {
      generatedFolder: GENERATED,
      deleteFolderBeforeRendering: true,
      formatCode: true,
      prettierOptions,
      // Import only from @solana/kit (and its subpaths): it is the one Solana dep of packages/shared.
      kitImportStrategy: 'rootOnly',
      // packages/shared/package.json is hand-maintained (exact pins); never let the renderer edit it.
      syncPackageJson: false,
    }),
  );
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

function sameJson(a: string, b: string): boolean {
  return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
}

async function main(): Promise<void> {
  if (args.has('--from-target') && !args.has('--check')) {
    cpSync(TARGET_IDL_PATH, IDL_PATH);
    console.log(`copied ${relative(ROOT, TARGET_IDL_PATH)} -> ${relative(ROOT, IDL_PATH)}`);
  }
  const idlText = readFileSync(IDL_PATH, 'utf8');
  const idl = JSON.parse(idlText) as AnchorIdl;

  if (!args.has('--check')) {
    await render(SHARED, idl);
    console.log(
      `rendered ${relative(ROOT, join(SHARED, GENERATED))}/ from ${relative(ROOT, IDL_PATH)}`,
    );
    return;
  }

  const problems: string[] = [];
  try {
    if (!sameJson(readFileSync(TARGET_IDL_PATH, 'utf8'), idlText)) {
      problems.push(
        `${relative(ROOT, IDL_PATH)} differs from ${relative(ROOT, TARGET_IDL_PATH)} (run: npm run codama -- --from-target)`,
      );
    }
  } catch {
    console.log(`(no ${relative(ROOT, TARGET_IDL_PATH)}: IDL drift not checked; run anchor build)`);
  }

  const tmp = mkdtempSync(join(tmpdir(), 'codama-check-'));
  try {
    await render(tmp, idl);
    const fresh = join(tmp, GENERATED);
    const committed = join(SHARED, GENERATED);
    const a = listFiles(fresh);
    let b: string[] = [];
    try {
      b = listFiles(committed);
    } catch {
      problems.push(`${relative(ROOT, committed)}/ is missing`);
    }
    for (const f of new Set([...a, ...b])) {
      if (!a.includes(f) || !b.includes(f)) {
        problems.push(`generated file set differs: ${f}`);
      } else if (
        readFileSync(join(fresh, f), 'utf8') !== readFileSync(join(committed, f), 'utf8')
      ) {
        problems.push(`stale generated file: ${f}`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    console.error(
      ['escrow client is out of date (run: npm run codama):', ...problems].join('\n  '),
    );
    process.exit(1);
  }
  console.log('escrow IDL and generated client are up to date');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
