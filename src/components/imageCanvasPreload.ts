export type NavigationDirection = 'forward' | 'backward' | 'idle';

type DirectionalWindow = {
  backwardCount: number;
  forwardCount: number;
};

export type AdjacentPreloadPlan = {
  keepIndices: number[];
  preloadIndices: number[];
  leadingIndices: Set<number>;
};

function getDirectionalWindow(
  direction: NavigationDirection,
  adjacentPreviousImages: number,
  adjacentNextImages: number
): DirectionalWindow {
  const totalWindow = adjacentPreviousImages + adjacentNextImages;

  if (direction === 'forward') {
    const backwardCount = 1;
    return { backwardCount, forwardCount: Math.max(1, totalWindow - backwardCount) };
  }

  if (direction === 'backward') {
    const forwardCount = 1;
    return { backwardCount: Math.max(1, totalWindow - forwardCount), forwardCount };
  }

  return { backwardCount: adjacentPreviousImages, forwardCount: adjacentNextImages };
}

function appendPreloadIndex(
  currentIndex: number,
  imageCount: number,
  preloadIndices: number[],
  leadingIndices: Set<number>,
  queued: Set<number>,
  index: number,
  isLeading: boolean
): void {
  if (index < 0 || index >= imageCount || index === currentIndex || queued.has(index)) return;

  queued.add(index);
  preloadIndices.push(index);
  if (isLeading) leadingIndices.add(index);
}

function collectDirectionalPreloads(
  currentIndex: number,
  imageCount: number,
  preloadIndices: number[],
  leadingIndices: Set<number>,
  queued: Set<number>,
  direction: NavigationDirection,
  window: DirectionalWindow
): void {
  const addRange = (start: number, end: number, step: number, isLeading: boolean) => {
    for (let offset = start; offset <= end; offset += 1) {
      appendPreloadIndex(
        currentIndex,
        imageCount,
        preloadIndices,
        leadingIndices,
        queued,
        currentIndex + step * offset,
        isLeading
      );
    }
  };

  if (direction === 'forward') {
    addRange(1, window.forwardCount, 1, true);
    addRange(1, window.backwardCount, -1, false);
    return;
  }

  if (direction === 'backward') {
    addRange(1, window.backwardCount, -1, true);
    addRange(1, window.forwardCount, 1, false);
    return;
  }

  const maxOffset = Math.max(window.backwardCount, window.forwardCount);
  for (let offset = 1; offset <= maxOffset; offset += 1) {
    if (offset <= window.forwardCount) {
      addRange(offset, offset, 1, false);
    }
    if (offset <= window.backwardCount) {
      addRange(offset, offset, -1, false);
    }
  }
}

/** Builds the bounded adjacent-image preload window for the current navigation direction. */
export function getAdjacentPreloadPlan(
  currentIndex: number,
  imageCount: number,
  direction: NavigationDirection,
  adjacentPreviousImages: number,
  adjacentNextImages: number
): AdjacentPreloadPlan {
  const window = getDirectionalWindow(direction, adjacentPreviousImages, adjacentNextImages);
  const preloadIndices: number[] = [];
  const leadingIndices = new Set<number>();
  const queued = new Set<number>();

  collectDirectionalPreloads(
    currentIndex,
    imageCount,
    preloadIndices,
    leadingIndices,
    queued,
    direction,
    window
  );

  return { keepIndices: [currentIndex, ...preloadIndices], preloadIndices, leadingIndices };
}
