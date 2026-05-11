import { useCallback, useEffect, useRef, useState } from 'react';

export function useThumbnailRefreshSignal() {
  const [, setThumbnailVersion] = useState(0);
  const batchRafRef = useRef<number | null>(null);
  const hasPendingThumbnailUpdatesRef = useRef(false);
  const isMountedRef = useRef(true);

  const flushThumbnailBatch = useCallback(() => {
    batchRafRef.current = null;
    if (!hasPendingThumbnailUpdatesRef.current) return;

    hasPendingThumbnailUpdatesRef.current = false;
    setThumbnailVersion((version) => version + 1);
  }, []);

  const scheduleThumbnailFlush = useCallback(() => {
    if (batchRafRef.current !== null) return;
    batchRafRef.current = window.requestAnimationFrame(flushThumbnailBatch);
  }, [flushThumbnailBatch]);

  const handleThumbnailLoaded = useCallback(() => {
    if (!isMountedRef.current) return;

    hasPendingThumbnailUpdatesRef.current = true;
    scheduleThumbnailFlush();
  }, [scheduleThumbnailFlush]);

  const isThumbnailConsumerActive = useCallback(() => isMountedRef.current, []);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (batchRafRef.current !== null) {
        window.cancelAnimationFrame(batchRafRef.current);
      }
    };
  }, []);

  return { handleThumbnailLoaded, isThumbnailConsumerActive };
}
