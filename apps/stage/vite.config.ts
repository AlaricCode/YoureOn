// Stage view (TASKS K-06 E3; ARCHITECTURE §8.2): the laptop on the projector.
//
// Production: `npm run build` emits dist/ with base /stage/; apps/server serves it from the API's
// own origin (src/stage/static.ts), so the page's REST + /v1/ws calls are same-origin. Every
// text asset also gets .br and .gz siblings that the server sends when the browser accepts them
// (the bundle goes over a phone hotspot on pitch day).
//
// Development: `npm run dev` serves the page at http://localhost:5174/ and proxies /v1 (and the
// /v1/ws WebSocket) plus /health to the local server, so the same-origin default works there too.
// STAGE_API=https://youre-on.fly.dev npm run dev points the proxy at another server.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Where the server mounts the built page (apps/server/src/stage/static.ts STAGE_PREFIX). */
export const STAGE_BASE = '/stage/';
const COMPRESSIBLE = /\.(?:js|mjs|css|html|svg|json|txt|map|webmanifest)$/;
/** Below this, a compressed sibling is not worth a second file. */
const MIN_BYTES = 1024;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Writes <file>.br and <file>.gz next to every compressible output file. */
export function precompress(): Plugin {
  let outDir = 'dist';
  return {
    name: 'yo-precompress',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      for (const file of walk(outDir)) {
        if (!COMPRESSIBLE.test(file)) continue;
        const raw = readFileSync(file);
        if (raw.length < MIN_BYTES) continue;
        writeFileSync(`${file}.gz`, gzipSync(raw, { level: 9 }));
        writeFileSync(
          `${file}.br`,
          brotliCompressSync(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11 } }),
        );
      }
    },
  };
}

const api = process.env.STAGE_API ?? 'http://localhost:8080';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? STAGE_BASE : '/',
  plugins: [react(), precompress()],
  build: { sourcemap: false, chunkSizeWarningLimit: 800 },
  server: {
    port: 5174,
    proxy: {
      '/v1': { target: api, changeOrigin: true, ws: true },
      '/health': { target: api, changeOrigin: true },
    },
  },
}));
