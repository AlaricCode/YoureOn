// The real production build, served by the real server module: `vite build` (base /stage/, the
// precompress plugin) into a temp dir, then apps/server's stageStatic() serves it. Proves the
// base path and the server agree: every script / stylesheet index.html references loads from
// /stage/assets/ with the right type, immutable caching and a brotli sibling.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, createLogger, stageStatic, STAGE_CACHE, type AppDeps } from '@youre-on/server';
import { STAGE_BASE } from '../vite.config';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'yo-stage-build-'));
// Only the log is read outside route handlers; the static module touches nothing else.
const deps = { log: createLogger('silent') } as unknown as AppDeps;
const app = buildApp(deps, [stageStatic({ dir: out })]);

beforeAll(async () => {
  await build({
    root,
    configFile: join(root, 'vite.config.ts'),
    logLevel: 'silent',
    build: { outDir: out, emptyOutDir: true },
  });
}, 60_000);
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('the built stage, served from /stage', () => {
  it('the base path matches the server mount', () => {
    expect(STAGE_BASE).toBe('/stage/');
  });

  it('index.html loads every asset it references from /stage/assets/', async () => {
    const res = await app.request('/stage/');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(STAGE_CACHE.html);
    const html = await res.text();
    expect(html).toContain('<div id="root"></div>');
    const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]!);
    const assets = refs.filter((r) => r.startsWith('/stage/assets/'));
    expect(assets.some((a) => a.endsWith('.js'))).toBe(true);
    expect(assets.some((a) => a.endsWith('.css'))).toBe(true);
    // nothing points at the site root (it would 404 on the API server)
    expect(refs.filter((r) => !r.startsWith('/stage/'))).toEqual([]);
    for (const a of assets) {
      const r = await app.request(a, { headers: { 'Accept-Encoding': 'br, gzip' } });
      expect(r.status, a).toBe(200);
      expect(r.headers.get('Cache-Control'), a).toBe(STAGE_CACHE.immutable);
      expect(r.headers.get('Content-Type'), a).toMatch(
        a.endsWith('.js') ? /javascript/ : /text\/css/,
      );
      expect(r.headers.get('Content-Encoding'), a).toBe('br');
    }
  });

  it('the build wrote .br and .gz siblings for the bundles, and copied public/', () => {
    const files = readdirSync(join(out, 'assets'));
    const js = files.find((f) => f.endsWith('.js'))!;
    expect(files).toContain(`${js}.br`);
    expect(files).toContain(`${js}.gz`);
    expect(existsSync(join(out, 'replay', 'README.txt'))).toBe(true);
  });

  it('the SPA fallback and ?preview both get the page', async () => {
    for (const p of ['/stage/?preview=paid', '/stage/some/route']) {
      const r = await app.request(p);
      expect(r.status, p).toBe(200);
      expect(await r.text(), p).toContain('/stage/assets/');
    }
  });
});
