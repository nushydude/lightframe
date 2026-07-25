import { useState } from 'react';

type CurationPersistenceAlertProps = {
  message: string;
  onRetry: () => void | Promise<void>;
  onDismiss: () => void;
};

export function CurationPersistenceAlert({
  message,
  onRetry,
  onDismiss,
}: CurationPersistenceAlertProps) {
  const [isRetrying, setIsRetrying] = useState(false);

  const handleRetry = () => {
    setIsRetrying(true);
    void Promise.resolve(onRetry()).finally(() => setIsRetrying(false));
  };

  return (
    <div className="curation-persistence-alert" role="alert" aria-live="assertive">
      <span>{message}</span>
      <button type="button" onClick={handleRetry} disabled={isRetrying}>
        {isRetrying ? 'Retrying…' : 'Retry'}
      </button>
      <button type="button" onClick={onDismiss} aria-label="Dismiss curation error">
        Dismiss
      </button>
    </div>
  );
}
