import type { AppSettings, PersistedMarkedFolder } from '../types/settings';

const MAX_PERSISTED_MARKED_FOLDERS = 12;
const MAX_MARKED_PATHS_PER_FOLDER = 5000;

function normalizePathKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

function sanitizeMarkedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const sanitized: string[] = [];
  for (const path of paths) {
    const trimmedPath = path.trim();
    if (!trimmedPath) {
      continue;
    }

    const normalizedPath = normalizePathKey(trimmedPath);
    if (seen.has(normalizedPath)) {
      continue;
    }

    seen.add(normalizedPath);
    sanitized.push(trimmedPath);
    if (sanitized.length >= MAX_MARKED_PATHS_PER_FOLDER) {
      break;
    }
  }

  return sanitized;
}

function selectionsEqual(left: PersistedMarkedFolder[], right: PersistedMarkedFolder[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((folder, index) => {
    const other = right[index];
    return (
      folder.folderPath === other.folderPath &&
      folder.updatedAt === other.updatedAt &&
      folder.markedPaths.length === other.markedPaths.length &&
      folder.markedPaths.every((path, pathIndex) => path === other.markedPaths[pathIndex])
    );
  });
}

export function getPersistedMarkedPathsForFolder(
  settings: Pick<AppSettings, 'persistedMarkedFolders'>,
  folderPath: string | null
): string[] {
  const trimmedFolderPath = folderPath?.trim();
  if (!trimmedFolderPath) {
    return [];
  }

  const normalizedFolderPath = normalizePathKey(trimmedFolderPath);
  return (
    settings.persistedMarkedFolders.find(
      (folder) => normalizePathKey(folder.folderPath) === normalizedFolderPath
    )?.markedPaths ?? []
  );
}

export function updatePersistedMarkedFolders(
  settings: Pick<AppSettings, 'persistedMarkedFolders'>,
  folderPath: string | null,
  markedPaths: string[]
): PersistedMarkedFolder[] {
  const trimmedFolderPath = folderPath?.trim();
  if (!trimmedFolderPath) {
    return settings.persistedMarkedFolders;
  }

  const normalizedFolderPath = normalizePathKey(trimmedFolderPath);
  const sanitizedMarkedPaths = sanitizeMarkedPaths(markedPaths);
  const remainingFolders = settings.persistedMarkedFolders.filter(
    (folder) => normalizePathKey(folder.folderPath) !== normalizedFolderPath
  );

  const nextFolders =
    sanitizedMarkedPaths.length === 0
      ? remainingFolders
      : [
          {
            folderPath: trimmedFolderPath,
            markedPaths: sanitizedMarkedPaths,
            updatedAt: Date.now(),
          },
          ...remainingFolders,
        ].slice(0, MAX_PERSISTED_MARKED_FOLDERS);

  if (
    sanitizedMarkedPaths.length > 0 &&
    settings.persistedMarkedFolders.length > 0 &&
    normalizePathKey(settings.persistedMarkedFolders[0].folderPath) === normalizedFolderPath
  ) {
    const current = settings.persistedMarkedFolders[0];
    if (
      current.markedPaths.length === sanitizedMarkedPaths.length &&
      current.markedPaths.every((path, index) => path === sanitizedMarkedPaths[index])
    ) {
      return settings.persistedMarkedFolders;
    }
  }

  return selectionsEqual(settings.persistedMarkedFolders, nextFolders)
    ? settings.persistedMarkedFolders
    : nextFolders;
}
