// Pure helpers of the stage: formatting, the phase rail, the QR encoder wrapper, launch params
// (URL query + secret fragment), the demo health strip and the REPLAY clip cache.
import { describe, expect, it } from 'vitest';
import {
  clock,
  eventLabel,
  groupedCode,
  hueOf,
  initials,
  lagLabel,
  shortSig,
  usd,
  usdPrice,
} from '../src/format';
import { endedEarly, phaseOf, phaseSteps } from '../src/phase';
import { qrMatrix, qrPath, qrSvg, QR_EC, QR_QUIET } from '../src/qr';
import {
  isUuid,
  loadSession,
  parseLaunch,
  resolveServer,
  roomLabelOf,
  scrubbedHref,
  SESSION_KEY,
  writeJson,
} from '../src/config';
import { DemoHealth, fetchDemoHealth, healthItems, DEMO_KEY_HEADER } from '../src/health';
import {
  initialReplays,
  preloadReplays,
  presentCount,
  readyCount,
  replaySrc,
  replayUrl,
  type ClipState,
} from '../src/replays';
import { emptyBet, explorerTx, type BetView } from '../src/ticker';

const SIG =
  'VeaRKoEn9T7U9x9LEzWQwNBejcL6L48nPdsSQMRmQQ1rceGPFUY4oTQ3gxaaMvXWXRJShQ1pdoW3aLj7EeBqu5Ax';
const BET = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';

describe('format', () => {
  it('clock, signatures, dollars, prices, the grouped terms code', () => {
    expect(clock(61_000)).toBe('1:01');
    expect(clock(999)).toBe('0:01');
    expect(clock(-5)).toBe('0:00');
    expect(shortSig(SIG)).toBe('VeaR…u5Ax');
    expect(shortSig('short')).toBe('short');
    expect(usd('5000000')).toBe('$5');
    expect(usd('6100000')).toBe('$6.10');
    expect(usd('not money')).toBe('not money');
    expect(usdPrice('64389.6')).toBe('$64,389.60');
    expect(usdPrice(null)).toBe('—');
    expect(groupedCode('05860f0a')).toBe('0586·0f0a');
    expect(groupedCode('abc')).toBe('abc');
  });

  it('initials and a stable hue per name', () => {
    expect(initials('Logan Staples')).toBe('LS');
    expect(initials('jake')).toBe('J');
    expect(initials('  Ana  María  López ')).toBe('AL');
    expect(initials('')).toBe('?');
    expect(initials(null)).toBe('?');
    expect(hueOf('Logan')).toBe(hueOf('Logan'));
    expect(hueOf('Logan')).toBeGreaterThanOrEqual(0);
    expect(hueOf('Logan')).toBeLessThan(360);
  });

  it('lag between two event times (the Streams proof)', () => {
    expect(lagLabel('2026-11-21T18:05:01.000Z', '2026-11-21T18:05:03.800Z')).toBe('+2.8 s');
    expect(lagLabel('2026-11-21T18:05:03.000Z', '2026-11-21T18:05:01.000Z')).toBeNull();
    expect(lagLabel(null, '2026-11-21T18:05:01.000Z')).toBeNull();
  });

  it('ticker labels in words, with player names', () => {
    const names = { A: 'Logan', B: 'Jake' };
    expect(eventLabel('chain.BetCreated', {})).toBe('BetCreated');
    expect(eventLabel('tx.submitted', { kind: 'atomic_lock' })).toBe('Lock tx sent');
    expect(eventLabel('tx.confirmed', { kind: 'finalize' })).toBe('Payout tx confirmed');
    expect(eventLabel('tx.failed', { kind: 'resolve' })).toBe('Ruling tx failed');
    expect(eventLabel('terms.authorized', { party: 'B', method: 'passcode_hold' }, names)).toBe(
      'Jake authorized · Passcode',
    );
    expect(eventLabel('terms.authorized', { party: 'A' })).toBe('Party A authorized');
    expect(eventLabel('ruling.issued', { ruling: { outcome: 'B_WINS' } }, names)).toBe(
      'Ruling: Jake wins',
    );
    expect(eventLabel('ruling.issued', { ruling: { outcome: 'REDO' } }, names)).toBe(
      'Ruling: redo',
    );
    expect(eventLabel('bet.state', { state: 'AWAITING_MARKET' })).toBe('State AWAITING MARKET');
    expect(eventLabel('something.new', null)).toBe('something.new');
  });
});

describe('phase rail', () => {
  const bet = (over: Partial<BetView>): BetView => ({ ...emptyBet(BET), ...over });
  const env = { terms: { market: null } } as unknown as BetView['envelope'];

  it('follows the server state', () => {
    const cases: Array<[string, string]> = [
      ['DRAFTING', 'challenge'],
      ['TERMS_PROPOSED', 'terms'],
      ['AWAITING_AUTHORIZATIONS', 'lock'],
      ['AWAITING_LOCK', 'lock'],
      ['LOCKED', 'play'],
      ['ATTEMPT', 'play'],
      ['JUDGING', 'play'],
      ['AWAITING_MARKET', 'play'],
      ['HEARING', 'ruling'],
      ['RULED', 'ruling'],
      ['APPEALED', 'ruling'],
      ['PAID', 'paid'],
      ['VOIDED', 'paid'],
    ];
    for (const [state, phase] of cases) expect(phaseOf(bet({ state })), state).toBe(phase);
  });

  it('events move it forward even when bet.state lags; never backwards', () => {
    expect(phaseOf(bet({ state: 'DRAFTING', envelope: env }))).toBe('terms');
    expect(phaseOf(bet({ invite: 'accepted' }))).toBe('terms');
    expect(phaseOf(bet({ state: 'TERMS_PROPOSED', auth_count: 1 }))).toBe('lock');
    const lock = {
      kind: 'atomic_lock',
      signature: SIG,
      signers: 3,
      status: 'confirmed' as const,
      onchain: false,
      slot: 1,
      error: null,
      sent_at: null,
      onchain_at: null,
    };
    expect(phaseOf(bet({ state: 'AWAITING_LOCK', lock }))).toBe('play');
    expect(phaseOf(bet({ state: 'AWAITING_LOCK', lock: { ...lock, status: 'submitted' } }))).toBe(
      'lock',
    );
    // a REDO is still the attempt; a decisive ruling is the ruling
    const ruling = {
      outcome: 'REDO',
      reason: 'r',
      confidence: 0.4,
      cited_frames: [],
      model: 'm',
      stage: 'attempt',
      void_reason: null,
      ruling_hash: 'ab'.repeat(32),
      attempt_no: 1,
      redo_reason: 'unclear',
    };
    expect(phaseOf(bet({ state: 'JUDGING', lock, ruling }))).toBe('play');
    expect(phaseOf(bet({ state: 'JUDGING', lock, ruling: { ...ruling, outcome: 'B_WINS' } }))).toBe(
      'ruling',
    );
    const payout = { to_a: '0', to_b: '10000000', event: 'BetFinalized', signature: SIG };
    expect(phaseOf(bet({ state: 'RULED', payout }))).toBe('paid');
    // a stale state never pulls it back
    expect(phaseOf(bet({ state: 'LOCKED', payout }))).toBe('paid');
  });

  it('steps: labels, done / current / todo, Market for a Gemini bet, Refund, Cancelled', () => {
    expect(phaseSteps(null).map((s) => s.status)).toEqual(Array(6).fill('todo'));
    const steps = phaseSteps(bet({ state: 'AWAITING_AUTHORIZATIONS' }));
    expect(steps.map((s) => s.label)).toEqual([
      'Challenge',
      'Terms',
      'Lock',
      'Attempt',
      'Ruling',
      'Paid',
    ]);
    expect(steps.map((s) => s.status)).toEqual(['done', 'done', 'current', 'todo', 'todo', 'todo']);
    const market = { terms: { market: { side: 'YES' } } } as unknown as BetView['envelope'];
    expect(phaseSteps(bet({ state: 'AWAITING_MARKET', envelope: market }))[3]).toEqual({
      key: 'play',
      label: 'Market',
      status: 'current',
    });
    const refund = { to_a: '5000000', to_b: '5000000', event: 'BetRefunded', signature: SIG };
    const paid = phaseSteps(bet({ state: 'VOIDED', payout: refund }));
    expect(paid[5]).toEqual({ key: 'paid', label: 'Refund', status: 'done' });
    const cancelled = bet({ state: 'CANCELLED', auth_count: 1 });
    expect(endedEarly(cancelled)).toBe('cancelled');
    expect(phaseSteps(cancelled)[2]).toEqual({ key: 'lock', label: 'Cancelled', status: 'failed' });
    expect(endedEarly(bet({ state: 'EXPIRED' }))).toBe('expired');
  });
});

describe('QR', () => {
  /** Reads the path back into a grid (each subpath is one horizontal run). */
  function paint(path: string, side: number): boolean[][] {
    const g = Array.from({ length: side }, () => Array<boolean>(side).fill(false));
    for (const m of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
      for (let i = 0; i < w; i++) g[y]![x + i] = true;
    }
    return g;
  }

  it('an Explorer link fits version 6 at EC L; finder patterns in three corners', () => {
    const url = explorerTx(SIG);
    expect(url.length).toBeGreaterThan(120);
    const m = qrMatrix(url, QR_EC.L);
    expect(m.size).toBe(41);
    expect(qrSvg(url).version).toBe(6);
    // 7x7 finder: dark ring, light ring, dark 3x3 core
    const finder = (ox: number, oy: number) => {
      for (let y = 0; y < 7; y++)
        for (let x = 0; x < 7; x++) {
          const ring = x === 0 || y === 0 || x === 6 || y === 6;
          const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
          expect(m.dark(ox + x, oy + y), `${ox + x},${oy + y}`).toBe(ring || core);
        }
    };
    finder(0, 0);
    finder(m.size - 7, 0);
    finder(0, m.size - 7);
    expect(m.dark(-1, 0)).toBe(false);
    expect(m.dark(0, m.size)).toBe(false);
  });

  it('the SVG path paints exactly the dark modules, inside the quiet zone', () => {
    const m = qrMatrix('youreon://room/ABC234');
    const q = qrSvg('youreon://room/ABC234');
    expect(q.side).toBe(m.size + 2 * QR_QUIET);
    const g = paint(qrPath(m), q.side);
    for (let y = 0; y < q.side; y++)
      for (let x = 0; x < q.side; x++)
        expect(g[y]![x], `${x},${y}`).toBe(m.dark(x - QR_QUIET, y - QR_QUIET));
  });

  it('higher error correction needs a bigger symbol', () => {
    const url = explorerTx(SIG);
    expect(qrMatrix(url, QR_EC.H).size).toBeGreaterThan(qrMatrix(url, QR_EC.L).size);
  });
});

describe('launch params', () => {
  it('query: room, bet, server, preview; fragment: the secrets (fragment wins)', () => {
    const p = parseLaunch(
      '?room=abc234&preview=Paid&bet=b1&nopreload',
      '#key=sk&demo=dk&token=tk&room=XYZ789',
    );
    expect(p).toEqual({
      preview: 'paid',
      room: 'XYZ789',
      bet: 'b1',
      server: null,
      key: 'sk',
      token: 'tk',
      demo: 'dk',
      noPreload: true,
    });
    expect(parseLaunch('?preview', '').preview).toBe('');
    expect(parseLaunch('', '').preview).toBeNull();
    expect(parseLaunch('?room=%20', '#key=').room).toBeNull();
    expect(parseLaunch('?server=https://youre-on.fly.dev', '').server).toBe(
      'https://youre-on.fly.dev',
    );
  });

  it('scrubs secrets from the address bar, keeps everything else', () => {
    expect(scrubbedHref('https://youre-on.fly.dev/stage/?room=ABC234#key=sk&demo=dk')).toBe(
      'https://youre-on.fly.dev/stage/?room=ABC234',
    );
    expect(scrubbedHref('https://h/stage/?room=A&key=leaked#x=1&token=t')).toBe(
      'https://h/stage/?room=A#x=1',
    );
    expect(scrubbedHref('https://h/stage/?room=ABC234')).toBeNull();
    expect(scrubbedHref('https://h/stage/#section')).toBeNull();
  });

  it('server defaults to this page origin', () => {
    expect(resolveServer('', 'https://youre-on.fly.dev')).toBe('https://youre-on.fly.dev');
    expect(resolveServer(null, 'http://localhost:5174')).toBe('http://localhost:5174');
    expect(resolveServer(' https://other.dev/ ', 'https://x')).toBe('https://other.dev');
    expect(isUuid(BET)).toBe(true);
    expect(isUuid('ABC234')).toBe(false);
    expect(roomLabelOf(' stg234 ')).toBe('STG234');
    expect(roomLabelOf('youreon://room/ABC234')).toBe('ABC234');
    expect(roomLabelOf(BET)).toBe('7f3c2a9e');
    expect(roomLabelOf('whatever')).toBe('whatever');
  });

  it('a saved session survives a reload of the tab until its token expires', () => {
    const store = new Map<string, string>();
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const g = globalThis as { sessionStorage?: unknown };
    const prev = g.sessionStorage;
    g.sessionStorage = fake;
    try {
      const now = Date.parse('2026-11-20T15:00:00.000Z');
      expect(loadSession(now)).toBeNull();
      const s = {
        serverUrl: '',
        roomId: BET,
        token: 'yo_s_x',
        demoKey: null,
        betId: null,
        expiresAt: '2026-11-21T03:00:00.000Z',
      };
      writeJson('session', SESSION_KEY, s);
      expect(loadSession(now)).toEqual(s);
      expect(loadSession(Date.parse('2026-11-21T02:59:30.000Z'))).toBeNull(); // within a minute
      writeJson('session', SESSION_KEY, null);
      expect(loadSession(now)).toBeNull();
      store.set(SESSION_KEY, '{not json');
      expect(loadSession(now)).toBeNull();
    } finally {
      g.sessionStorage = prev;
    }
  });
});

describe('demo health strip', () => {
  const healthy = {
    chain_configured: true,
    lock_signer: 'server',
    rpc: 'quicknode',
    fee_payer: 'B1Qtn1Zk68Sqx2rFDNdqGbMv5m5t4pCKU2P1MDjZ7NWi',
    fee_payer_pinned: true,
    fee_payer_sol: 4.82,
    judge: null,
    custodial: { a: null, b: null },
    nonce_pool: { size: 8, free: 7, leased: 1, advancing: 0, retired: 0 },
    last_tx: { kind: 'finalize', status: 'confirmed', signature: SIG, bet_id: BET, err: null },
    rpc_ms: 142,
    rpc_error: null,
    db_ms: 9,
  };

  it('levels: ok when healthy; warn / bad on low SOL, few nonces, slow or failing RPC', () => {
    const ok = healthItems(DemoHealth.parse(healthy));
    expect(ok.map((i) => [i.key, i.level])).toEqual([
      ['sol', 'ok'],
      ['nonces', 'ok'],
      ['rpc', 'ok'],
      ['db', 'ok'],
      ['last', 'ok'],
      ['signer', 'idle'],
    ]);
    expect(ok[0]!.value).toBe('4.820 SOL');
    expect(ok[1]!.value).toBe('7 free / 8');
    const bad = healthItems(
      DemoHealth.parse({
        ...healthy,
        fee_payer_sol: 0.01,
        nonce_pool: { ...healthy.nonce_pool, free: 0 },
        rpc_error: 'fetch failed',
        db_ms: 900,
        last_tx: { ...healthy.last_tx, status: 'failed' },
      }),
    );
    expect(Object.fromEntries(bad.map((i) => [i.key, i.level]))).toMatchObject({
      sol: 'bad',
      nonces: 'bad',
      rpc: 'bad',
      db: 'warn',
      last: 'warn',
    });
    const warn = healthItems(
      DemoHealth.parse({
        ...healthy,
        fee_payer_sol: 0.3,
        nonce_pool: { ...healthy.nonce_pool, free: 2 },
        rpc_ms: 1200,
      }),
    );
    expect(warn.slice(0, 3).map((i) => i.level)).toEqual(['warn', 'warn', 'warn']);
    const noChain = healthItems(
      DemoHealth.parse({ ...healthy, chain_configured: false, fee_payer_sol: null, rpc_ms: null }),
    );
    expect(noChain[0]).toMatchObject({ value: 'no chain', level: 'bad' });
    expect(noChain[2]).toMatchObject({ value: '—', level: 'idle' });
  });

  it('tolerant parse: missing or odd fields do not break the strip', () => {
    const h = DemoHealth.parse({ db_ms: 'slow', nonce_pool: 'x' });
    expect(h.fee_payer_sol).toBeNull();
    expect(h.nonce_pool.free).toBe(0);
    expect(h.db_ms).toBeNull();
    expect(healthItems(h).length).toBeGreaterThan(0);
  });

  it('fetchDemoHealth sends the admin key header; 404 explains itself', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const ok = (async (u: string, i?: RequestInit) => {
      calls.push([u, i]);
      return new Response(JSON.stringify(healthy), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(fetchDemoHealth('https://h.dev', 'dk', ok)).resolves.toMatchObject({
      rpc_ms: 142,
    });
    expect(calls[0]![0]).toBe('https://h.dev/v1/demo/health');
    expect((calls[0]![1]!.headers as Record<string, string>)[DEMO_KEY_HEADER]).toBe('dk');
    const nf = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    await expect(fetchDemoHealth('https://h.dev', 'wrong', nf)).rejects.toThrow(
      /demo key or DEMO_MODE/,
    );
    const boom = (async () => new Response('{}', { status: 502 })) as unknown as typeof fetch;
    await expect(fetchDemoHealth('https://h.dev', 'dk', boom)).rejects.toThrow(/HTTP 502/);
  });
});

describe('REPLAY clips', () => {
  it('urls under the page base', () => {
    expect(replayUrl(1, '/stage/')).toBe('/stage/replay/beat1.mp4');
    expect(replayUrl(6, '/stage')).toBe('/stage/replay/beat6.mp4');
    expect(replayUrl(2)).toBe('/replay/beat2.mp4'); // vitest's BASE_URL is '/'
  });

  it('preloads each clip once, in order; skips missing ones (404, or an HTML fallback)', async () => {
    const fetched: string[] = [];
    const fake = (async (u: string) => {
      fetched.push(u);
      if (u.endsWith('beat1.mp4'))
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'video/mp4' },
        });
      if (u.endsWith('beat2.mp4'))
        return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
      if (u.endsWith('beat3.mp4')) throw new Error('offline');
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    let s = initialReplays();
    const states: Array<[number, ClipState]> = [];
    await preloadReplays({
      fetch: fake,
      createObjectURL: () => 'blob:beat1',
      cancelled: () => false,
      onChange: (beat, state, url) => {
        states.push([beat, state]);
        s = {
          clips: { ...s.clips, [beat]: state },
          urls: url ? { ...s.urls, [beat]: url } : s.urls,
        };
      },
    });
    expect(fetched).toEqual([1, 2, 3, 4, 5, 6].map((b) => replayUrl(b)));
    expect(s.clips).toEqual({
      1: 'ready',
      2: 'missing',
      3: 'error',
      4: 'missing',
      5: 'missing',
      6: 'missing',
    });
    expect(readyCount(s)).toBe(1);
    expect(presentCount(s)).toBe(2); // ready + error (it exists, the download failed)
    expect(replaySrc(s, 1)).toBe('blob:beat1');
    expect(replaySrc(s, 2)).toBe(replayUrl(2));
    expect(states[0]).toEqual([1, 'loading']);
  });

  it('stops when cancelled', async () => {
    let n = 0;
    await preloadReplays({
      fetch: (async () => {
        n++;
        return new Response('x', { headers: { 'content-type': 'video/mp4' } });
      }) as unknown as typeof fetch,
      createObjectURL: () => 'blob:x',
      cancelled: () => n >= 2,
      onChange: () => {},
    });
    expect(n).toBe(2);
  });
});
