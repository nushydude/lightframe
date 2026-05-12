import { useCallback, useEffect, useState } from 'react';
import { isSecondaryWindowOpen } from '../services/tauriCommands';

export function useProjectorState() {
  const [isProjectorOpen, setIsProjectorOpen] = useState(false);

  const refreshProjectorState = useCallback(async () => {
    try {
      setIsProjectorOpen(await isSecondaryWindowOpen());
    } catch (err) {
      console.error('Failed to read projector state:', err);
      setIsProjectorOpen(false);
    }
  }, []);

  useEffect(() => {
    void refreshProjectorState();

    const handleFocus = () => {
      void refreshProjectorState();
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [refreshProjectorState]);

  return { isProjectorOpen, refreshProjectorState };
}
