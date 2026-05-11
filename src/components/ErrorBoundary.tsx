import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            background: '#121212',
            padding: '2rem',
            fontFamily: 'sans-serif',
          }}
        >
          <h1 style={{ color: '#ff5555' }}>Something went wrong.</h1>
          <p>We're sorry, but the application crashed.</p>
          <pre
            style={{
              background: 'rgba(255,255,255,0.1)',
              padding: '1rem',
              borderRadius: '4px',
              maxWidth: '80%',
              overflow: 'auto',
              marginTop: '1rem',
            }}
          >
            {this.state.error?.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: '2rem',
              padding: '0.8rem 1.5rem',
              background: '#333',
              color: 'white',
              border: '1px solid #555',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Reload Application
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
