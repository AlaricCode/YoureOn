// No-DB tests: the built stage page served from the API origin (src/stage/static.ts): redirects,
// cache headers per file kind, the SPA fallback, precompressed bundles, byte ranges for the
// REPLAY clips, HEAD, traversal, and the "not built" 404.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { routeModules } from '../src/routes';
import { createDeps } from '../src/server';
import { STAGE_CACHE, STAGE_CSP, stageStatic, stageStaticRoutes } from '../src/stage/static';
import { testEnv } from './helpers';

// createDb is lazy (postgres.js connects on first query), so these deps never touch a DB.
const { deps } = createDeps({
  env: testEnv({ DATABASE_URL: 'postgres://unused@127.0.0.1:1/none' }),
  rateLimit: false,
});

const root = mkdtempSync(join(tmpdir(), 'yo-stage-static-'));
const dist = join(root, 'dist');
const INDEX =
  '<!doctype html><html><head><script type="module" src="/stage/assets/index-AbC123.js"></script></head><body><div id="root"></div></body></html>';
const JS = 'console.log("stage");'.repeat(50);
const CLIP = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
mkdirSync(join(dist, 'assets'), { recursive: true });
mkdirSync(join(dist, 'replay'), { recursive: true });
writeFileSync(join(dist, 'index.html'), INDEX);
writeFileSync(join(dist, 'assets', 'index-AbC123.js'), JS);
writeFileSync(join(dist, 'assets', 'index-AbC123.js.gz'), gzipSync(JS));
writeFileSync(join(dist, 'assets', 'index-Def456.css'), 'body{color:red}');
writeFileSync(join(dist, 'replay', 'beat1.mp4'), CLIP);
writeFileSync(join(root, 'secret.txt'), 'outside the stage dir');

const app = buildApp(deps, [
  ...routeModules.filter((m) => m.name !== 'stage-static'),
  stageStatic({ dir: dist }),
]);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('GET /stage (the built projector page)', () => {
  it('redirects / and /stage to /stage/, keeping the query', async () => {
    const top = await app.request('/');
    expect(top.status).toBe(302);
    expect(top.headers.get('Location')).toBe('/stage/');
    const bare = await app.request('/stage?preview=paid');
    expect(bare.status).toBe(308);
    expect(bare.headers.get('Location')).toBe('/stage/?preview=paid');
  });

  it('serves index.html at /stage/ and /stage/index.html: no-cache, CSP, nosniff, no referrer', async () => {
    for (const path of ['/stage/', '/stage/index.html', '/stage/?preview']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('Content-Type')).toMatch(/^text\/html/);
      expect(res.headers.get('Cache-Control')).toBe(STAGE_CACHE.html);
      expect(res.headers.get('Content-Security-Policy')).toBe(STAGE_CSP);
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(await res.text()).toBe(INDEX);
    }
  });

  it('hashed assets are immutable for a year; the .gz sibling is sent when accepted', async () => {
    const plain = await app.request('/stage/assets/index-AbC123.js');
    expect(plain.status).toBe(200);
    expect(plain.headers.get('Content-Type')).toMatch(/^text\/javascript/);
    expect(plain.headers.get('Cache-Control')).toBe(STAGE_CACHE.immutable);
    expect(plain.headers.get('Content-Encoding')).toBeNull();
    expect(plain.headers.get('Content-Security-Policy')).toBeNull(); // HTML only
    expect(await plain.text()).toBe(JS);

    const gz = await app.request('/stage/assets/index-AbC123.js', {
      headers: { 'Accept-Encoding': 'gzip, deflate, br' },
    });
    expect(gz.status).toBe(200);
    expect(gz.headers.get('Content-Encoding')).toBe('gzip');
    expect(gz.headers.get('Vary')).toMatch(/Accept-Encoding/);
    expect(Number(gz.headers.get('Content-Length'))).toBeLessThan(JS.length);
    expect(gz.headers.get('Cache-Control')).toBe(STAGE_CACHE.immutable);

    const css = await app.request('/stage/assets/index-Def456.css');
    expect(css.headers.get('Content-Type')).toMatch(/^text\/css/);
  });

  it('a missing asset or file is a 404 envelope that is never cached (no SPA fallback)', async () => {
    for (const path of [
      '/stage/assets/index-Gone99.js',
      '/stage/logo.png',
      '/stage/replay/beat9.mp4',
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('Cache-Control'), path).toBe(STAGE_CACHE.missing);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    }
  });

  it('extension-less paths fall back to index.html (SPA routes)', async () => {
    const res = await app.request('/stage/rooms/ABC234/live');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe(STAGE_CACHE.html);
    expect(await res.text()).toBe(INDEX);
  });

  it('REPLAY clips: video/mp4, 5 min cache, byte ranges (206 / 416)', async () => {
    const full = await app.request('/stage/replay/beat1.mp4');
    expect(full.status).toBe(200);
    expect(full.headers.get('Content-Type')).toBe('video/mp4');
    expect(full.headers.get('Cache-Control')).toBe(STAGE_CACHE.file);
    expect(Buffer.from(await full.arrayBuffer())).toEqual(CLIP);

    const part = await app.request('/stage/replay/beat1.mp4', {
      headers: { Range: 'bytes=100-199' },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('Content-Range')).toBe('bytes 100-199/1000');
    expect(part.headers.get('Accept-Ranges')).toBe('bytes');
    expect(Buffer.from(await part.arrayBuffer())).toEqual(CLIP.subarray(100, 200));

    const past = await app.request('/stage/replay/beat1.mp4', {
      headers: { Range: 'bytes=5000-' },
    });
    expect(past.status).toBe(416);
  });

  it('HEAD answers with headers only', async () => {
    const res = await app.request('/stage/', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe(String(INDEX.length));
    expect(await res.text()).toBe('');
  });

  it('never serves a file outside the stage dir', async () => {
    for (const path of [
      '/stage/../secret.txt',
      '/stage/%2e%2e/secret.txt',
      '/stage/..%2fsecret.txt',
      '/stage//etc/passwd',
      '/stage/assets/..%5c..%5csecret.txt',
    ]) {
      const res = await app.request(path);
      expect(await res.text(), path).not.toContain('outside the stage dir');
    }
  });

  it('other methods and the API are untouched', async () => {
    expect((await app.request('/stage/', { method: 'POST' })).status).toBe(404);
    const health = await app.request('/health');
    expect(health.status).toBe(200);
    expect(health.headers.get('Content-Security-Policy')).toBeNull();
    const api = await app.request('/v1/nope');
    expect(api.status).toBe(404);
    expect(api.headers.get('Content-Type')).toMatch(/json/);
  });

  it('a server without a built stage answers 404 with how to build it', async () => {
    const bare = buildApp(deps, [stageStatic({ dir: join(root, 'not-built') })]);
    const res = await bare.request('/stage/');
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe(STAGE_CACHE.missing);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
      /npm run build -w apps\/stage/,
    );
  });

  it('routes.ts mounts the module (default dir apps/stage/dist)', () => {
    expect(routeModules).toContain(stageStaticRoutes);
  });
});
