// The projector page never goes blank: a render or effect exception anywhere in the App shows
// this screen instead of unmounting everything. "Reload" keeps the saved session (the tab comes
// back to the same room and card); "Start over" forgets it and shows the connect form, for a
// saved session that itself is what keeps failing.
import { Component, Fragment, type ReactNode } from 'react';
import { SESSION_KEY, writeJson } from './config';

export function CrashScreen({
  message,
  onReload,
  onReset,
}: {
  message: string;
  onReload: () => void;
  onReset: () => void;
}) {
  return (
    <div className="stage connect crash" role="alert">
      <h1>
        You&apos;re <span className="on">On</span> <span className="muted">· stage</span>
      </h1>
      <p className="big">The stage page hit an error.</p>
      <p className="muted small mono">{message}</p>
      <div className="actions">
        <button type="button" className="primary" onClick={onReload}>
          Reload
        </button>
        <button type="button" onClick={onReset}>
          Start over (forget this session)
        </button>
      </div>
      <p className="muted small">
        Keys 1–6 still play the REPLAY clips after a reload: they never need the server.
      </p>
    </div>
  );
}

interface Props {
  children: ReactNode;
  /** Injected in tests. */
  reload?: () => void;
}

export class StageErrorBoundary extends Component<Props, { error: string | null; key: number }> {
  override state = { error: null as string | null, key: 0 };

  static getDerivedStateFromError(err: unknown): { error: string } {
    return { error: err instanceof Error ? err.message || err.name : String(err) };
  }

  override componentDidCatch(err: unknown) {
    console.error('stage crashed', err);
  }

  private reload = () => {
    if (this.props.reload) return this.props.reload();
    try {
      globalThis.location.reload();
    } catch {
      this.setState((s) => ({ error: null, key: s.key + 1 }));
    }
  };

  /** Forget the saved session and mount a fresh App (the connect form). */
  reset = () => {
    writeJson('session', SESSION_KEY, null);
    this.setState((s) => ({ error: null, key: s.key + 1 }));
  };

  override render() {
    if (this.state.error !== null)
      return <CrashScreen message={this.state.error} onReload={this.reload} onReset={this.reset} />;
    return <Fragment key={this.state.key}>{this.props.children}</Fragment>;
  }
}
