// What runs at app start. Metro executes a module the first time it is required, and every
// static import from index.ts down is required at launch; import() and React.lazy require only
// when called. The face natives (nitro-image, the ML Kit detector, fast-tflite and the bundled
// model) create native objects as their modules load, so if any of them is reachable through
// static imports, a native module that fails to start crashes the app at launch and takes the
// room list and Beats 2-4 down with it. They must only be reached through import().
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Packages that touch native code as soon as they load (and only face code needs). */
const FACE_NATIVE_PACKAGES = [
  'react-native-nitro-image',
  'react-native-vision-camera-face-detector',
  'react-native-fast-tflite',
];
/** App modules that pull those in. */
const FACE_NATIVE_MODULES = ['src/face/native.ts', 'src/face/loadModel.ts'];

// `import … from 'x'`, `import 'x'`, `export … from 'x'` at the start of a line (so comments
// do not count). `import type` / `export type` are erased by the compiler and skipped below;
// `import { type A } from 'x'` is kept (conservatively counted as an import).
const STATIC_IMPORT =
  /^[ \t]*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm;

function staticImports(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(STATIC_IMPORT)) {
    if (m[2]) continue; // type-only
    out.push(m[3] as string);
  }
  return out;
}

function resolveRelative(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

/** Every app file and package reached from `entry` through static imports only. */
function bootGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    if (!/\.(ts|tsx)$/.test(file)) continue; // an asset (e.g. the .tflite model)
    for (const spec of staticImports(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) {
        const target = resolveRelative(file, spec);
        if (!target) throw new Error(`${relative(APP_ROOT, file)}: cannot resolve ${spec}`);
        queue.push(target);
      } else {
        packages.add(spec);
      }
    }
  }
  return { files, packages };
}

describe('app start', () => {
  const graph = bootGraph(join(APP_ROOT, 'index.ts'));
  const files = [...graph.files].map((f) => relative(APP_ROOT, f));

  it('walks the real app (sanity check of the walker)', () => {
    expect(files).toEqual(
      expect.arrayContaining(['App.tsx', 'src/app/DemoApp.tsx', 'src/enroll/EnrollScreens.tsx']),
    );
    expect(graph.packages).toContain('react-native');
  });

  it('loads none of the face natives: they are reached only through import()', () => {
    expect(FACE_NATIVE_PACKAGES.filter((p) => graph.packages.has(p))).toEqual([]);
    expect(FACE_NATIVE_MODULES.filter((m) => files.includes(m))).toEqual([]);
    expect(files.filter((f) => f.endsWith('.tflite'))).toEqual([]);
  });

  it('the walker does see a static import of the face natives', () => {
    // The check above would catch DemoApp importing src/face/native directly.
    expect(
      staticImports(
        "import { x } from 'a';\nimport type { T } from 'b';\n// from 'c'\n" +
          "import {\n  getNativeEmbedder,\n} from '../face/native';\nexport { y } from './y';\n" +
          "const L = lazy(() => import('../voice/JudgeVoice'));\n",
      ),
    ).toEqual(['a', '../face/native', './y']);
  });
});
