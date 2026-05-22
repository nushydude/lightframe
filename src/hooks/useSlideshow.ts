import { useCallback, useEffect, useRef } from 'react';
import { useViewerStore } from '../state/viewerStore';
import { useSettingsStore } from '../state/settingsStore';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** Hook for slideshow functionality */
export function useSlideshow() {
  const {
    isSlideshowActive,
    isSlideshowPaused,
    images,
    currentIndex,
    isFullscreen,
    startSlideshow,
    stopSlideshow,
    toggleSlideshowPause,
    navigateNext,
    setFullscreen,
    setCurrentIndex,
  } = useViewerStore();

  const settings = useSettingsStore((s) => s.settings);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shuffleOrderRef = useRef<number[]>([]);
  const shuffleIndexRef = useRef(0);

  const exitFullscreenForStop = useCallback(async () => {
    if (!useViewerStore.getState().isFullscreen) {
      return;
    }

    try {
      const appWindow = getCurrentWindow();
      await appWindow.setFullscreen(false);
      setFullscreen(false);
    } catch (err) {
      console.error('Failed to exit fullscreen after slideshow:', err);
    }
  }, [setFullscreen]);

  const stopAndRestoreWindow = useCallback(async () => {
    stopSlideshow();
    await exitFullscreenForStop();
  }, [exitFullscreenForStop, stopSlideshow]);

  /** Generate a shuffled order of indices */
  const generateShuffleOrder = useCallback(
    (startIdx: number) => {
      const indices = Array.from({ length: images.length }, (_, i) => i);
      // Fisher-Yates shuffle
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      // Move start index to front
      const startPos = indices.indexOf(startIdx);
      if (startPos > 0) {
        [indices[0], indices[startPos]] = [indices[startPos], indices[0]];
      }
      shuffleOrderRef.current = indices;
      shuffleIndexRef.current = 0;
    },
    [images.length]
  );

  /** Advance to the next slide */
  const advanceSlide = useCallback(() => {
    if (settings.shuffleSlideshow) {
      shuffleIndexRef.current++;
      if (shuffleIndexRef.current >= shuffleOrderRef.current.length) {
        if (settings.loopSlideshow) {
          shuffleIndexRef.current = 0;
        } else {
          void stopAndRestoreWindow();
          return;
        }
      }
      const nextIdx = shuffleOrderRef.current[shuffleIndexRef.current];
      setCurrentIndex(nextIdx);
    } else {
      const advanced = navigateNext(settings.loopSlideshow);
      if (!advanced) {
        void stopAndRestoreWindow();
      }
    }
  }, [
    settings.shuffleSlideshow,
    settings.loopSlideshow,
    navigateNext,
    setCurrentIndex,
    stopAndRestoreWindow,
  ]);

  // Timer management
  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (isSlideshowActive && !isSlideshowPaused && images.length > 1) {
      timerRef.current = setInterval(advanceSlide, settings.slideshowIntervalSeconds * 1000);
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [
    isSlideshowActive,
    isSlideshowPaused,
    advanceSlide,
    settings.slideshowIntervalSeconds,
    images.length,
    currentIndex,
  ]);

  /** Start the slideshow */
  const start = useCallback(async () => {
    if (images.length < 2) return;

    if (settings.shuffleSlideshow) {
      generateShuffleOrder(currentIndex);
    }

    startSlideshow();

    // Auto-fullscreen if setting is enabled
    if (settings.autoFullscreenOnSlideshow && !isFullscreen) {
      try {
        const appWindow = getCurrentWindow();
        await appWindow.setFullscreen(true);
        setFullscreen(true);
      } catch (err) {
        console.error('Failed to enter fullscreen:', err);
      }
    }
  }, [
    images.length,
    currentIndex,
    isFullscreen,
    settings.autoFullscreenOnSlideshow,
    settings.shuffleSlideshow,
    startSlideshow,
    setFullscreen,
    generateShuffleOrder,
  ]);

  /** Stop the slideshow */
  const stop = useCallback(async () => {
    await stopAndRestoreWindow();
  }, [stopAndRestoreWindow]);

  /** Toggle pause/resume */
  const togglePause = useCallback(() => {
    toggleSlideshowPause();
  }, [toggleSlideshowPause]);

  return {
    isSlideshowActive,
    isSlideshowPaused,
    start,
    stop,
    togglePause,
  };
}
