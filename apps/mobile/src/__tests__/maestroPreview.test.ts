// e2e/maestro/sim-preview.yaml is the simulator's only look at the screens a real bet would
// need money for (terms card, ruling, appeal, market). It must open every entry of the preview's
// Screens menu (src/preview/PreviewApp.tsx MENU), in menu order, so a new screen cannot be added
// without the smoke rendering it.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => readFileSync(resolve(APP_ROOT, p), 'utf8');

/** The MENU entries' keys, in order: `['launch', '0  App launch'],` */
function menuKeys(source: string): string[] {
  const menu = source.slice(source.indexOf('const MENU'));
  const body = menu.slice(0, menu.indexOf('\n];'));
  return [...body.matchAll(/\[\s*'([A-Za-z]+)',\s*'[^']*'\s*\]/g)].map((m) => m[1] as string);
}

describe('sim-preview.yaml covers the design preview', () => {
  const keys = menuKeys(read('src/preview/PreviewApp.tsx'));
  const flow = read('e2e/maestro/sim-preview.yaml');
  const opened = [...flow.matchAll(/^\s+KEY:\s*(\S+)\s*$/gm)].map((m) => m[1]);

  it('reads the menu (sanity check of the parser)', () => {
    expect(keys.slice(0, 2)).toEqual(['launch', 'launchFailed']);
    expect(keys).toEqual(expect.arrayContaining(['appeal', 'marketPanel', 'liveSelf', 'demo']));
  });

  it('opens every screen of the menu, in order', () => {
    expect(opened).toEqual(keys);
  });

  it('every entry goes through preview-screen.yaml and comes back to the menu', () => {
    expect(flow.match(/file: preview-screen\.yaml/g)?.length).toBe(keys.length);
    expect(flow.match(/id: preview-menu/g)?.length).toBe(keys.length);
    expect(read('e2e/maestro/preview-screen.yaml')).toContain('id: menu-${KEY}');
  });
});
