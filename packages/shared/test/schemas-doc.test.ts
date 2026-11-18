// Doc drift guard: SCHEMAS §10.1 (docs/planning/SCHEMAS.md) names every unsequenced WS control
// frame the shared wire contract carries (api.ts WsServerControlFrame) beyond the connection ones,
// with each field. Someone working from SCHEMAS as the source of truth must not be able to
// tighten the union and silently drop the stage's voice frames (stage.voice, stage.cue.audio_url).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WsServerControlFrame } from '../src/api';

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const SCHEMAS = readFileSync(repo('docs/planning/SCHEMAS.md'), 'utf8');
const SECTION = SCHEMAS.slice(
  SCHEMAS.indexOf('### 10.1 Envelope'),
  SCHEMAS.indexOf('### 10.2 Chain event payloads'),
);

/** The connection frames API-CONTRACT §3.1 owns (welcome, subscribed, ping, error). */
const CONNECTION_OPS = new Set(['welcome', 'subscribed', 'ping', 'error']);

describe('SCHEMAS §10.1 lists the control frames of WsServerControlFrame', () => {
  it('found the section', () => {
    expect(SECTION.length).toBeGreaterThan(100);
  });

  for (const frame of WsServerControlFrame.options) {
    const op = frame.shape.op.value;
    if (CONNECTION_OPS.has(op)) continue;
    it(`${op}`, () => {
      expect(SECTION).toContain(`\`${op}`);
    });
    // The fields, for the stage frames the doc spells out (room.presence / stage.market are
    // named only, their payload types living elsewhere in SCHEMAS).
    if (op === 'stage.cue' || op === 'stage.voice') {
      const fields = Object.keys(frame.shape).filter((k) => k !== 'op');
      it(`${op} {${fields.join(', ')}}`, () => {
        const line = SECTION.split('\n').find((l) => l.includes(`\`${op} {`));
        expect(line, `a \`${op} {…}\` in §10.1`).toBeDefined();
        const shape = /`[a-z.]+ \{([^}]*)\}`/.exec(line!.slice(line!.indexOf(`\`${op} {`)));
        const named = shape![1]!.split(',').map((f) => f.trim().replace(/\?$/, ''));
        expect(named.sort()).toEqual([...fields].sort());
      });
    }
  }
});
