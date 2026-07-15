export interface StartupCliFileArg {
  value?: unknown;
}

export interface StartupDecision {
  filePath: string | null;
  folderPath: string | null;
  mode: 'open-image' | 'open-folder' | 'empty';
}

export function resolveStartupDecision(
  fileArg: StartupCliFileArg | null | undefined,
  folderArg?: StartupCliFileArg | null
): StartupDecision {
  if (folderArg && typeof folderArg.value === 'string') {
    const folderPath = folderArg.value.trim();
    if (folderPath.length > 0) {
      return { filePath: null, folderPath, mode: 'open-folder' };
    }
  }

  if (fileArg && typeof fileArg.value === 'string') {
    const filePath = fileArg.value.trim();
    if (filePath.length > 0) {
      return { filePath, folderPath: null, mode: 'open-image' };
    }
  }

  return { filePath: null, folderPath: null, mode: 'empty' };
}
