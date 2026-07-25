import {
  Component,
  createElement,
  lazy,
  Suspense,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';

type SurfaceLoader<Props> = () => Promise<{ default: ComponentType<Props> }>;

type LazySurfaceProps<Props> = {
  label: string;
  loader: SurfaceLoader<Props>;
  props: Props;
  fallback?: ReactNode;
};

type ErrorBoundaryProps = {
  label: string;
  onRetry: () => void;
  children: ReactNode;
};

type ErrorBoundaryState = { error: Error | null };

class SurfaceErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="lazy-surface-error" role="alert">
          <span>Could not load {this.props.label}.</span>
          <button
            type="button"
            onClick={() => {
              this.setState({ error: null });
              this.props.onRetry();
            }}
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export function LazySurface<Props>({ label, loader, props, fallback }: LazySurfaceProps<Props>) {
  const [retryVersion, setRetryVersion] = useState(0);
  const Surface = useMemo(() => {
    const currentLoader = retryVersion === 0 ? loader : () => loader();
    return lazy(currentLoader);
  }, [loader, retryVersion]);
  const SurfaceComponent = Surface as unknown as ComponentType<Record<string, unknown>>;
  return (
    <SurfaceErrorBoundary label={label} onRetry={() => setRetryVersion((version) => version + 1)}>
      <SuspenseFallback fallback={fallback}>
        {createElement(SurfaceComponent, props as Record<string, unknown>)}
      </SuspenseFallback>
    </SurfaceErrorBoundary>
  );
}

function SuspenseFallback({ fallback, children }: { fallback?: ReactNode; children: ReactNode }) {
  // Keeping the boundary local prevents a secondary chunk from replacing the viewer shell.
  const fallbackContent = fallback ?? <div className="lazy-surface-loading" role="status" />;
  return <Suspense fallback={fallbackContent}>{children}</Suspense>;
}
