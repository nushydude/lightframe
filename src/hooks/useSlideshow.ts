import { useCallback, useEffect, useRef } from 'react';
import { useViewerStore } from '../state/viewerStore';
import { useSettingsStore } from '../state/settingsStore';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** Hook for slideshow functionality */
export function useSlideshow() {
  const isSlideshowActive = useViewerStore((state) => state.isSlideshowActive);
  const isSlideshowPaused = useViewerStore((state) => state.isSlideshowPaused);
  const images = useViewerStore((state) => state.images);
  const currentIndex = useViewerStore((state) => state.currentIndex);
  const isFullscreen = useViewerStore((state) => state.isFullscreen);
  const startSlideshow = useViewerStore((state) => state.startSlideshow);
  const stopSlideshow = useViewerStore((state) => state.stopSlideshow);
  const toggleSlideshowPause = useViewerStore((state) => state.toggleSlideshowPause);
  const navigateNext = useViewerStore((state) => state.navigateNext);
  const navigatePrev = useViewerStore((state) => state.navigatePrev);
  const setFullscreen = useViewerStore((state) => state.setFullscreen);
  const setCurrentIndex = useViewerStore((state) => state.setCurrentIndex);

  const autoFullscreenOnSlideshow = useSettingsStore(
    (state) => state.settings.autoFullscreenOnSlideshow
  );
  const loopSlideshow = useSettingsStore((state) => state.settings.loopSlideshow);
  const shuffleSlideshow = useSettingsStore((state) => state.settings.shuffleSlideshow);
  const slideshowDirection = useSettingsStore((state) => state.settings.slideshowDirection);
  const slideshowIntervalSeconds = useSettingsStore(
    (state) => state.settings.slideshowIntervalSeconds
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shuffleOrderRef = useRef<number[]>([]);
  const shuffleIndexRef = useRef(0);
  const shuffleDirectionRef = useRef(slideshowDirection);
  const isShuffleOrderReadyRef = useRef(false);
  const currentIndexRef = useRef(currentIndex);
  const previousImagePathsRef = useRef(images.map((image) => image.path));

  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

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
    (startIdx: number, direction: typeof slideshowDirection = slideshowDirection) => {
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
      shuffleIndexRef.current = direction === 'reverse' ? indices.length : 0;
      shuffleDirectionRef.current = direction;
      isShuffleOrderReadyRef.current = true;
    },
    [images.length, slideshowDirection]
  );

  const shufflePaths = useCallback((paths: string[]) => {
    for (let i = paths.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [paths[i], paths[j]] = [paths[j], paths[i]];
    }
  }, []);

  /** Advance to the next slide */
  const advanceSlide = useCallback(() => {
    if (shuffleSlideshow) {
      const directionOffset = slideshowDirection === 'reverse' ? -1 : 1;
      shuffleIndexRef.current += directionOffset;
      if (
        shuffleIndexRef.current >= shuffleOrderRef.current.length ||
        shuffleIndexRef.current < 0 ||
        (slideshowDirection === 'reverse' && !loopSlideshow && shuffleIndexRef.current === 0)
      ) {
        if (loopSlideshow) {
          shuffleIndexRef.current =
            slideshowDirection === 'reverse' ? shuffleOrderRef.current.length - 1 : 0;
        } else {
          void stopAndRestoreWindow();
          return;
        }
      }
      const nextIdx = shuffleOrderRef.current[shuffleIndexRef.current];
      setCurrentIndex(nextIdx);
    } else {
      const navigate = slideshowDirection === 'reverse' ? navigatePrev : navigateNext;
      const advanced = navigate(loopSlideshow);
      if (!advanced) {
        void stopAndRestoreWindow();
      }
    }
  }, [
    shuffleSlideshow,
    slideshowDirection,
    loopSlideshow,
    navigateNext,
    navigatePrev,
    setCurrentIndex,
    stopAndRestoreWindow,
  ]);

  const reconcileShuffleOrder = useCallback(() => {
    const currentPath = images[currentIndexRef.current]?.path ?? null;
    if (!currentPath) {
      generateShuffleOrder(Math.max(0, currentIndexRef.current));
      previousImagePathsRef.current = images.map((image) => image.path);
      return;
    }

    const previousImagePaths = previousImagePathsRef.current;
    const nextImagePaths = images.map((image) => image.path);
    const nextPathSet = new Set(nextImagePaths);
    const previousDirection = shuffleDirectionRef.current;
    const previousOrderPaths = shuffleOrderRef.current
      .map((index) => previousImagePaths[index])
      .filter((path): path is string => typeof path === 'string' && path.length > 0);
    const seenOrderPaths =
      previousDirection === 'reverse'
        ? previousOrderPaths.slice(shuffleIndexRef.current)
        : previousOrderPaths.slice(0, shuffleIndexRef.current + 1);
    const seenPaths = new Set(seenOrderPaths.filter((path) => nextPathSet.has(path)));
    if (previousDirection === 'reverse') {
      const startingPath = previousOrderPaths[0];
      if (startingPath && nextPathSet.has(startingPath)) {
        seenPaths.add(startingPath);
      }
    }
    seenPaths.add(currentPath);
    const remainingPaths: string[] = [];
    const remainingOrderPaths =
      previousDirection === 'reverse'
        ? previousOrderPaths.slice(1, shuffleIndexRef.current)
        : previousOrderPaths.slice(shuffleIndexRef.current + 1);

    for (const path of remainingOrderPaths) {
      if (!nextPathSet.has(path) || seenPaths.has(path)) {
        continue;
      }

      seenPaths.add(path);
      remainingPaths.push(path);
    }

    const newPaths = nextImagePaths.filter((path) => !seenPaths.has(path));
    shufflePaths(newPaths);

    let nextOrderPaths =
      slideshowDirection === 'reverse'
        ? [currentPath, ...newPaths, ...remainingPaths]
        : [currentPath, ...remainingPaths, ...newPaths];
    if (loopSlideshow) {
      const cyclePaths = nextImagePaths.filter(
        (path) => path !== currentPath && !nextOrderPaths.includes(path)
      );
      if (nextOrderPaths.length < Math.min(2, nextImagePaths.length)) {
        shufflePaths(cyclePaths);
      }
      nextOrderPaths =
        slideshowDirection === 'reverse'
          ? [currentPath, ...cyclePaths, ...newPaths, ...remainingPaths]
          : [...nextOrderPaths, ...cyclePaths];
    }
    shuffleOrderRef.current = nextOrderPaths
      .map((path) => nextImagePaths.indexOf(path))
      .filter((index) => index >= 0);
    shuffleIndexRef.current = slideshowDirection === 'reverse' ? shuffleOrderRef.current.length : 0;
    shuffleDirectionRef.current = slideshowDirection;
    isShuffleOrderReadyRef.current = true;
    previousImagePathsRef.current = nextImagePaths;
  }, [generateShuffleOrder, images, loopSlideshow, shufflePaths, slideshowDirection]);

  useEffect(() => {
    if (!isSlideshowActive || !shuffleSlideshow || images.length < 2) {
      isShuffleOrderReadyRef.current = false;
      previousImagePathsRef.current = images.map((image) => image.path);
      return;
    }

    if (!isShuffleOrderReadyRef.current) {
      generateShuffleOrder(currentIndexRef.current, slideshowDirection);
      previousImagePathsRef.current = images.map((image) => image.path);
      return;
    }

    reconcileShuffleOrder();
  }, [
    generateShuffleOrder,
    images,
    images.length,
    isSlideshowActive,
    reconcileShuffleOrder,
    shuffleSlideshow,
    slideshowDirection,
  ]);

  // Timer management
  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (isSlideshowActive && !isSlideshowPaused && images.length > 1) {
      timerRef.current = setInterval(advanceSlide, slideshowIntervalSeconds * 1000);
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
    slideshowIntervalSeconds,
    images.length,
    currentIndex,
  ]);

  /** Start the slideshow */
  const start = useCallback(async () => {
    if (images.length < 2) return;

    if (shuffleSlideshow) {
      generateShuffleOrder(currentIndex, slideshowDirection);
      previousImagePathsRef.current = images.map((image) => image.path);
    }

    startSlideshow();

    // Auto-fullscreen if setting is enabled
    if (autoFullscreenOnSlideshow && !isFullscreen) {
      try {
        const appWindow = getCurrentWindow();
        await appWindow.setFullscreen(true);
        setFullscreen(true);
      } catch (err) {
        console.error('Failed to enter fullscreen:', err);
      }
    }
  }, [
    images,
    currentIndex,
    isFullscreen,
    autoFullscreenOnSlideshow,
    shuffleSlideshow,
    slideshowDirection,
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
