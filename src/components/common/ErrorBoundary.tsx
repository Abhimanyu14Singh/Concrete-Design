/**
 * ErrorBoundary — catches render/runtime errors in the subtree and shows a
 * recovery UI instead of a blank white screen, so a bad input (e.g. an
 * out-of-range value) can't take down the whole app. The user can dismiss the
 * error and keep working; "Reload" is offered as a last resort.
 */
import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { FONT, STATUS } from '../../theme';

interface Props {
  children: ReactNode;
  /** Optional label for which area is wrapped (shown in the message). */
  area?: string;
}
interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep a record in the console for debugging; never crash the app.
    console.error('Caught render error:', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div style={{
        margin: 24, padding: 24, borderRadius: 12,
        background: STATUS.failBg, border: `1px solid ${STATUS.failBorder}`, color: '#7f1d1d',
        maxWidth: 640,
      }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>
          Something went wrong{this.props.area ? ` in ${this.props.area}` : ''}
        </div>
        <p style={{ fontSize: 13, lineHeight: 1.5, margin: '0 0 12px' }}>
          The app caught an error and stopped this view from crashing the whole
          window. Your other work is safe. Try dismissing the error — if it keeps
          happening, check the most recent input you changed (an out-of-range
          value can trigger this).
        </p>
        <pre style={{
          fontSize: 11, fontFamily: FONT.mono, background: 'white',
          border: `1px solid ${STATUS.failBorder}`, borderRadius: 6, padding: '8px 10px',
          overflowX: 'auto', margin: '0 0 12px', color: STATUS.fail,
        }}>{error.message}</pre>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={this.reset}
            style={{ padding: '7px 14px', background: STATUS.fail, color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
            Dismiss & continue
          </button>
          <button onClick={() => window.location.reload()}
            style={{ padding: '7px 14px', background: 'white', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
            Reload app
          </button>
        </div>
      </div>
    );
  }
}
