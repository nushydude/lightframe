export interface ContactSheetSelectionState {
  selectedPaths: string[];
  lastSelectedIndex: number | null;
}

export function toggleSelectionPath(selectedPaths: string[], path: string): string[] {
  return selectedPaths.includes(path)
    ? selectedPaths.filter((value) => value !== path)
    : [...selectedPaths, path];
}

export function selectRangePaths(
  images: { path: string }[],
  anchorIndex: number,
  targetIndex: number,
  selectedPaths: string[]
): string[] {
  if (images.length === 0) {
    return selectedPaths;
  }

  const start = Math.max(0, Math.min(anchorIndex, targetIndex));
  const end = Math.min(images.length - 1, Math.max(anchorIndex, targetIndex));
  const rangePaths = images.slice(start, end + 1).map((image) => image.path);
  return Array.from(new Set([...selectedPaths, ...rangePaths]));
}

