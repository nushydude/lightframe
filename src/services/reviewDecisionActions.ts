import { useCurationStore } from '../state/curationStore';
import { useSettingsStore } from '../state/settingsStore';
import { useViewerStore } from '../state/viewerStore';
import type { ReviewStatus } from '../types/curation';

let latestSingleViewerDecision = 0;

function stillInOriginalViewerContext(
  before: ReturnType<typeof useViewerStore.getState>,
  targetPath: string
): boolean {
  const after = useViewerStore.getState();
  return (
    after.viewMode === 'viewer' &&
    after.viewMode === before.viewMode &&
    after.currentImagePath === targetPath &&
    after.currentIndex === before.currentIndex &&
    after.curationFilter === before.curationFilter &&
    after.folderPath === before.folderPath &&
    after.images === before.images &&
    after.allImages === before.allImages
  );
}

export async function setReviewDecisionForCurrentImage(status: ReviewStatus): Promise<void> {
  const viewerBefore = useViewerStore.getState();
  const targetPath = viewerBefore.currentImagePath;
  if (!targetPath) return;

  const decisionGeneration = ++latestSingleViewerDecision;
  const beforeImages = viewerBefore.images;
  const beforeIndex = viewerBefore.currentIndex;
  const shouldAutoAdvance =
    viewerBefore.viewMode === 'viewer' &&
    useSettingsStore.getState().settings.autoAdvanceAfterReviewDecision;

  const changed = await useCurationStore.getState().setReviewStatus(targetPath, status);

  if (
    !changed ||
    !shouldAutoAdvance ||
    decisionGeneration !== latestSingleViewerDecision ||
    !stillInOriginalViewerContext(viewerBefore, targetPath)
  ) {
    return;
  }

  const curationState = useCurationStore.getState();
  const viewerAfter = useViewerStore.getState();
  viewerAfter.syncFavoriteFilter(curationState.curationByPath, curationState.favoritePaths);

  const syncedViewer = useViewerStore.getState();
  const successorPaths = beforeImages
    .slice(Math.max(0, beforeIndex + 1))
    .map((image) => image.path);
  const nextPath = successorPaths.find((path) =>
    syncedViewer.images.some((image) => image.path === path)
  );
  if (!nextPath) {
    return;
  }

  const nextIndex = useViewerStore.getState().images.findIndex((image) => image.path === nextPath);
  if (nextIndex >= 0) {
    useViewerStore.getState().setCurrentIndex(nextIndex);
  }
}
