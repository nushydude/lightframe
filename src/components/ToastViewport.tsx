import { useEffect, useRef } from 'react';
import { useToastStore, type Toast } from '../state/toastStore';

function getToastAriaProps(kind: Toast['kind']) {
  if (kind === 'error') {
    return {
      role: 'alert' as const,
      'aria-live': 'assertive' as const,
    };
  }

  return {
    role: 'status' as const,
    'aria-live': 'polite' as const,
  };
}

export function ToastViewport() {
  const toasts = useToastStore((state) => state.toasts);
  const dismissToast = useToastStore((state) => state.dismissToast);
  const timersRef = useRef(new Map<string, number>());

  useEffect(() => {
    for (const toast of toasts) {
      if (timersRef.current.has(toast.id)) {
        continue;
      }

      const timeoutId = window.setTimeout(() => {
        timersRef.current.delete(toast.id);
        dismissToast(toast.id);
      }, toast.duration);

      timersRef.current.set(toast.id, timeoutId);
    }

    for (const [id, timeoutId] of timersRef.current.entries()) {
      if (toasts.some((toast) => toast.id === id)) {
        continue;
      }

      window.clearTimeout(timeoutId);
      timersRef.current.delete(id);
    }
  }, [dismissToast, toasts]);

  useEffect(
    () => () => {
      for (const timeoutId of timersRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      timersRef.current.clear();
    },
    []
  );

  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="toast-viewport" aria-label="Notifications">
      {toasts.map((toast) => {
        const ariaProps = getToastAriaProps(toast.kind);

        return (
          <div
            key={toast.id}
            className={`toast toast--${toast.kind}`}
            data-kind={toast.kind}
            {...ariaProps}
          >
            <div className="toast__body">
              <div className="toast__header">
                <strong className="toast__title">{toast.title}</strong>
                <button
                  className="toast__dismiss"
                  type="button"
                  aria-label={`Dismiss ${toast.title}`}
                  onClick={() => dismissToast(toast.id)}
                >
                  x
                </button>
              </div>
              <div className="toast__message">{toast.message}</div>
              {toast.detail ? <div className="toast__detail">{toast.detail}</div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
