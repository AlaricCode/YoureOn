// The projector's launch and session: secrets only from the URL fragment, ?server= only on a
// local page, a server typo fails at Connect (and never gets saved), a reloaded tab comes back to
// the bets it showed (snapshot first, then the socket subscription), and a crash shows a screen
// with Reload / Start over instead of a blank page.
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BetSnapshot } from '@youre-on/shared/api';
import { App } from '../src/App';
import { CrashScreen, StageErrorBoundary } from '../src/boundary';
import {
  foreignServer,
  loadSession,
  MAX_REMEMBERED_BETS,
  parseLaunch,
  readJson,
  rememberBets,
  rememberedBets,
  resolveServer,
  serverOverrideAllowed,
  SESSION_KEY,
  writeJson,
  type SavedSession,
} from '../src/config';
import { SEED_RETRY_MS, seedBet, type SeedDeps } from '../src/seed';
import type { TickerAction } from '../src/ticker';

const text = (html: string) => html.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'");
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** A Map-backed sessionStorage for the test's duration. */
function useFakeSessionStorage() {
  const g = globalThis as { sessionStorage?: unknown };
  const prev = g.sessionStorage;
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    g.sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  afterEach(() => {
    g.sessionStorage = prev;
  });
  return store;
}

describe('launch: secrets and the server', () => {
  it('secrets come from the fragment only; one in the query is ignored and flagged', () => {
    const q = parseLaunch('?room=ABC234&key=leaked&demo=dk', '');
    expect(q.key).toBeNull();
    expect(q.demo).toBeNull();
    expect(q.secretInQuery).toBe(true);
    expect(q.room).toBe('ABC234');
    const both = parseLaunch('?token=leaked', '#token=good');
    expect(both.token).toBe('good');
    expect(both.secretInQuery).toBe(true);
    const clean = parseLaunch('?room=ABC234', '#key=sk&demo=dk');
    expect(clean).toMatchObject({ key: 'sk', demo: 'dk', secretInQuery: false });
  });

  it('?server= (or #server=) is honoured only where allowed', () => {
    expect(parseLaunch('?server=https://evil.example', '')).toMatchObject({
      server: null,
      serverIgnored: true,
    });
    expect(parseLaunch('', '#server=https://evil.example').server).toBeNull();
    expect(parseLaunch('?server=http://localhost:8080', '', { allowServer: true })).toMatchObject({
      server: 'http://localhost:8080',
      serverIgnored: false,
    });
    for (const h of ['localhost', '127.0.0.1', '[::1]', 'stage.localhost', 'LOCALHOST'])
      expect(serverOverrideAllowed(h, false), h).toBe(true);
    for (const h of ['youre-on.fly.dev', 'localhost.evil.example', '10.0.0.5', ''])
      expect(serverOverrideAllowed(h, false), h).toBe(false);
    expect(serverOverrideAllowed('youre-on.fly.dev', true)).toBe(true); // Vite dev
  });

  it('resolveServer: this origin by default, a bare host gets a scheme, junk throws', () => {
    expect(resolveServer('', 'https://youre-on.fly.dev')).toBe('https://youre-on.fly.dev');
    expect(resolveServer('youre-on.fly.dev', 'https://x')).toBe('https://youre-on.fly.dev');
    expect(resolveServer('localhost:8080/', 'https://x')).toBe('http://localhost:8080');
    expect(resolveServer('127.0.0.1:8080', 'https://x')).toBe('http://127.0.0.1:8080');
    expect(() => resolveServer('ftp://files.example', 'https://x')).toThrow(/http\(s\)/);
    expect(() => resolveServer('https://exa mple', 'https://x')).toThrow(/not a URL/);
    expect(() => resolveServer('javascript:alert(1)', 'https://x')).toThrow();
  });

  it('a server other than this page shows on the form', () => {
    const here = 'https://youre-on.fly.dev';
    expect(foreignServer('', here)).toBeNull();
    expect(foreignServer('https://youre-on.fly.dev/', here)).toBeNull();
    expect(foreignServer('https://evil.example/x', here)).toBe('https://evil.example');
    expect(foreignServer('exa mple', here)).toBe('exa mple'); // shown as typed
  });
});

describe('App: the connect form', () => {
  const g = globalThis as { location?: unknown };
  const prev = g.location;
  afterEach(() => {
    g.location = prev;
  });
  const at = (href: string) => {
    const u = new URL(href);
    g.location = { search: u.search, hash: u.hash, origin: u.origin, hostname: u.hostname, href };
  };

  it('a key in the query is not used and the form says why', () => {
    at('https://youre-on.fly.dev/stage/?room=ABC234&key=leaked&nopreload');
    const html = text(renderToString(<App />));
    expect(html).toContain('value="ABC234"');
    expect(html).not.toContain('value="leaked"');
    expect(html).toContain('was ignored: it reaches the server');
  });

  it('a local page may point at another server, and the form shows it prominently', () => {
    at('http://localhost:5174/?server=https://youre-on.fly.dev&nopreload');
    const html = text(renderToString(<App />));
    expect(html).toContain('value="https://youre-on.fly.dev"');
    expect(html).toContain('Server: <code>https://youre-on.fly.dev</code>');
  });
});

describe('the saved session remembers the bets on screen', () => {
  const store = useFakeSessionStorage();
  const saved: SavedSession = {
    serverUrl: '',
    roomId: id(1),
    token: 'yo_s_x',
    demoKey: null,
    betId: null,
    expiresAt: '2026-11-21T03:00:00.000Z',
    roomLabel: 'ABC234',
  };
  const now = Date.parse('2026-11-20T15:00:00.000Z');

  it('focus first, then the newest others, capped', () => {
    expect(rememberedBets(id(3), [id(1), id(2), id(3)])).toEqual([id(3), id(2), id(1)]);
    expect(rememberedBets(null, [id(1), id(2)])).toEqual([id(2), id(1)]);
    const many = Array.from({ length: 20 }, (_, i) => id(i + 10));
    const r = rememberedBets(id(5), many);
    expect(r).toHaveLength(MAX_REMEMBERED_BETS);
    expect(r[0]).toBe(id(5));
    expect(r[1]).toBe(id(29));
  });

  it('rememberBets writes into the saved session; a reload reads it back', () => {
    rememberBets(id(2), [id(1), id(2)]);
    expect(store.size).toBe(0); // no session, nothing to write into
    writeJson('session', SESSION_KEY, saved);
    rememberBets(id(2), [id(1), id(2)]);
    expect(readJson<SavedSession>('session', SESSION_KEY)).toMatchObject({
      token: 'yo_s_x',
      focusBetId: id(2),
      bets: [id(2), id(1)],
    });
    expect(loadSession(now)).toMatchObject({ focusBetId: id(2), bets: [id(2), id(1)] });
  });

  it('loadSession tolerates junk in the remembered fields', () => {
    writeJson('session', SESSION_KEY, { ...saved, focusBetId: 7, bets: [id(1), 3, null] });
    expect(loadSession(now)).toMatchObject({ focusBetId: null, bets: [id(1)] });
    writeJson('session', SESSION_KEY, { ...saved, bets: 'nope' });
    expect(loadSession(now)!.bets).toEqual([]);
  });
});

describe('seedBet: a told-about bet loads its snapshot before the socket subscribes', () => {
  const BET = id(42);
  const snap = { bet_id: BET } as unknown as BetSnapshot;
  const harness = (fetchSnapshot: SeedDeps['fetchSnapshot'], current = () => true) => {
    const log: string[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const deps: SeedDeps = {
      fetchSnapshot,
      dispatch: (a: TickerAction) =>
        log.push(a.kind === 'error' ? `error:${a.message}` : `${a.kind}`),
      subscribe: (b) => log.push(`subscribe:${b}`),
      current,
      failed: (b) => log.push(`failed:${b}`),
      setTimer: (fn, ms) => void timers.push({ fn, ms }),
    };
    return { log, timers, deps };
  };

  it('snapshot, then subscribe', async () => {
    const h = harness(async () => snap);
    await seedBet(BET, h.deps);
    expect(h.log).toEqual(['snapshot', `subscribe:${BET}`]);
  });

  it('a 404 never subscribes (the hub would close the socket with 4403): unfocus, error', async () => {
    const gone = async () => {
      throw new Error(`GET /v1/bets/${BET}: HTTP 404 NOT_FOUND`);
    };
    const loud = harness(gone);
    await seedBet(BET, loud.deps);
    expect(loud.log).toEqual([
      'unfocus',
      `error:GET /v1/bets/${BET}: HTTP 404 NOT_FOUND`,
      `failed:${BET}`,
    ]);
    const quiet = harness(gone);
    await seedBet(BET, quiet.deps, { quiet: true });
    expect(quiet.log).toEqual(['unfocus', `failed:${BET}`]);
    expect(quiet.timers).toEqual([]);
  });

  it('a network failure is retried (2 s, 5 s, 10 s), then let go', async () => {
    let calls = 0;
    const h = harness(async () => {
      calls++;
      throw new TypeError('Failed to fetch');
    });
    await seedBet(BET, h.deps, { quiet: true });
    for (let i = 0; i < SEED_RETRY_MS.length; i++) {
      expect(h.timers[i]!.ms).toBe(SEED_RETRY_MS[i]);
      h.timers[i]!.fn();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(calls).toBe(SEED_RETRY_MS.length + 1);
    expect(h.log).toEqual(['unfocus', `failed:${BET}`]);
    // and a retry that succeeds subscribes
    let n = 0;
    const flaky = harness(async () => {
      if (n++ === 0) throw new TypeError('Failed to fetch');
      return snap;
    });
    await seedBet(BET, flaky.deps);
    flaky.timers[0]!.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(flaky.log).toEqual(['snapshot', `subscribe:${BET}`]);
  });

  it('answers for an older connection are dropped', async () => {
    const h = harness(
      async () => snap,
      () => false,
    );
    await seedBet(BET, h.deps);
    expect(h.log).toEqual([]);
  });
});

describe('the crash screen', () => {
  const store = useFakeSessionStorage();

  it('getDerivedStateFromError keeps the message; the screen offers Reload and Start over', () => {
    expect(StageErrorBoundary.getDerivedStateFromError(new TypeError('Invalid URL'))).toEqual({
      error: 'Invalid URL',
    });
    expect(StageErrorBoundary.getDerivedStateFromError('boom')).toEqual({ error: 'boom' });
    const html = text(
      renderToString(<CrashScreen message="Invalid URL" onReload={() => {}} onReset={() => {}} />),
    );
    expect(html).toContain('The stage page hit an error.');
    expect(html).toContain('Invalid URL');
    expect(html).toContain('Reload');
    expect(html).toContain('Start over (forget this session)');
  });

  it('Start over forgets the saved session; children render when nothing failed', () => {
    store.set(SESSION_KEY, '{"token":"yo_s_x","roomId":"r"}');
    const b = new StageErrorBoundary({ children: null });
    b.setState = (() => {}) as never; // not mounted: only the storage side effect matters here
    b.reset();
    expect(store.has(SESSION_KEY)).toBe(false);
    expect(
      renderToString(
        <StageErrorBoundary>
          <p>fine</p>
        </StageErrorBoundary>,
      ),
    ).toBe('<p>fine</p>');
  });
});
