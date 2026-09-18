import { useCurationStore } from '../state/curationStore';
import { useToastStore } from '../state/toastStore';
import { useViewerStore } from '../state/viewerStore';

let latestFavoriteSuccessToastId: string | null = null;
let latestMarkSuccessToastId: string | null = null;

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase();
}

function getImageSnapshot(path: string) {
  const key = normalizePath(path);
  return useViewerStore.getState().images.find((image) => normalizePath(image.path) === key);
}

function filenameForPath(path: string, fileName?: string): string {
  if (fileName) return fileName;
  const image = getImageSnapshot(path);
  return image?.file_name || path.replace(/\\/g, '/').split('/').pop() || path;
}

function pushLatestSuccess(category: 'favorite' | 'mark', title: string): void {
  const toastStore = useToastStore.getState();
  const previousId =
    category === 'favorite' ? latestFavoriteSuccessToastId : latestMarkSuccessToastId;
  if (previousId) toastStore.dismissToast(previousId);
  const id = toastStore.pushToast({ kind: 'success', title, message: '', duration: 2000 });
  if (category === 'favorite') latestFavoriteSuccessToastId = id;
  else latestMarkSuccessToastId = id;
}

/** A direct viewer/keyboard/palette favourite action with slideshow-only feedback. */
export function toggleFavoriteFromUi(
  path: string,
  fileName?: string,
  toggleFavorite: (targetPath: string) => Promise<unknown> = (targetPath) =>
    useCurationStore.getState().toggleFavorite(targetPath)
): Promise<void> {
  const image = getImageSnapshot(path);
  if (!image) return Promise.resolve();

  const captured = {
    path: image.path,
    fileName: filenameForPath(image.path, fileName),
    slideshow: useViewerStore.getState().isSlideshowActive,
  };
  let operation: Promise<unknown>;
  try {
    // Invoke the curation store immediately. Its existing mutation queue owns ordering between
    // favourite, rating, and other metadata writes; this UI wrapper only observes completion.
    operation = Promise.resolve(toggleFavorite(captured.path));
  } catch {
    operation = Promise.reject(new Error('Favourite toggle failed'));
  }

  return operation.then(
    () => {
      if (!captured.slideshow) return;

      const favorite = Boolean(useCurationStore.getState().curationByPath[captured.path]?.favorite);
      pushLatestSuccess('favorite', favorite ? 'Favourited' : 'Removed from favourites');
    },
    () => {
      if (captured.slideshow) {
        useToastStore.getState().pushToast({
          kind: 'error',
          title: 'Could not update favourite',
          message: captured.fileName,
        });
      }
      // The curation store retains its persistence error and retry state. UI actions must not
      // create an unhandled rejection when invoked by a keyboard shortcut or click handler.
    }
  );
}

/** A direct mark action is synchronous, so its feedback reflects the completed toggle immediately. */
export function toggleMarkFromUi(path: string): void {
  const image = getImageSnapshot(path);
  if (!image) return;
  const captured = {
    path: image.path,
    slideshow: useViewerStore.getState().isSlideshowActive,
  };

  useViewerStore.getState().toggleMarkedPath(captured.path);
  if (!captured.slideshow) return;

  const state = useViewerStore.getState();
  const marked = state.markedPaths.some(
    (markedPath) => normalizePath(markedPath) === normalizePath(captured.path)
  );
  pushLatestSuccess('mark', marked ? 'Marked' : 'Unmarked');
}

export function resetDirectCurationActionStateForTests(): void {
  latestFavoriteSuccessToastId = null;
  latestMarkSuccessToastId = null;
}
