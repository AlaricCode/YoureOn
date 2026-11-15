// Placeholder stage ticker (TASKS K-06 E3; D1-J5 builds the real one): connect to a room as a
// stage session and list every event the server fans out, with devnet Explorer links.
import { useEffect, useReducer, useRef, useState, type FormEvent } from 'react';
import { applyFrame, initialTicker, type TickerState } from './ticker';
import { fetchStageToken, StageConnection, wsUrlFor, type StageConfig } from './connection';

const STORE_KEY = 'yo-stage-config';

function loadConfig(): StageConfig {
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (raw) return { serverUrl: '', roomId: '', ...(JSON.parse(raw) as Partial<StageConfig>) };
  } catch {
    // storage unavailable: start empty
  }
  return { serverUrl: 'http://localhost:8080', roomId: '' };
}

export function Ticker({ state }: { state: TickerState }) {
  return (
    <section aria-label="ticker">
      <p>
        <strong>{state.status}</strong>
        {state.closeCode !== null ? ` (close ${state.closeCode})` : ''}
        {state.presence ? ` · ${state.presence.online}/${state.presence.members} online` : ''}
        {state.lastCue ? ` · cue: ${state.lastCue.kind}` : ''}
        {state.dropped ? ` · ${state.dropped} dropped` : ''}
      </p>
      {state.errors.length > 0 && (
        <ul className="errors">
          {state.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {state.events.length === 0 ? (
        <p>No events yet.</p>
      ) : (
        <ol className="events">
          {[...state.events].reverse().map((e) => (
            <li key={`${e.bet_id}:${e.seq}`}>
              <code>{e.type}</code> bet {e.bet_id.slice(0, 8)} #{e.seq}{' '}
              {e.explorer && (
                <a href={e.explorer} target="_blank" rel="noreferrer">
                  Explorer
                </a>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function App() {
  const [cfg, setCfg] = useState<StageConfig>(loadConfig);
  const [state, dispatch] = useReducer(applyFrame, initialTicker);
  const conn = useRef<StageConnection | null>(null);

  useEffect(() => () => conn.current?.stop(), []);

  async function connect(e: FormEvent) {
    e.preventDefault();
    conn.current?.stop();
    try {
      globalThis.localStorage?.setItem(
        STORE_KEY,
        JSON.stringify({ serverUrl: cfg.serverUrl, roomId: cfg.roomId }),
      );
    } catch {
      // ignore
    }
    try {
      dispatch({ kind: 'status', status: 'authorizing' });
      const token = cfg.token || (await fetchStageToken(cfg));
      conn.current = new StageConnection({
        wsUrl: wsUrlFor(cfg.serverUrl),
        token,
        roomId: cfg.roomId,
        onAction: dispatch,
      });
      conn.current.start();
    } catch (err) {
      dispatch({ kind: 'status', status: 'closed' });
      dispatch({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  const field = (k: keyof StageConfig, label: string, type = 'text') => (
    <label>
      {label}{' '}
      <input
        type={type}
        value={cfg[k] ?? ''}
        onChange={(ev) => setCfg({ ...cfg, [k]: ev.target.value })}
      />
    </label>
  );

  return (
    <main>
      <h1>You&apos;re On</h1>
      <form onSubmit={connect}>
        {field('serverUrl', 'Server')}
        {field('roomId', 'Room id')}
        {field('stageKey', 'Stage key', 'password')}
        {field('token', 'or stage token', 'password')}
        <button type="submit">Connect</button>
      </form>
      <Ticker state={state} />
    </main>
  );
}
