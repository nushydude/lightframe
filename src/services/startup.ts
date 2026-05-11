export interface StartupCliFileArg {
  value?: unknown;
}

export interface StartupDecision {
  filePath: string | null;
  mode: 'open-image' | 'empty';
}

export function resolveStartupDecision(
  fileArg: StartupCliFileArg | null | undefined
): StartupDecision {
  if (fileArg && typeof fileArg.value === 'string') {
    const filePath = fileArg.value.trim();
    if (filePath.length > 0) {
      return { filePath, mode: 'open-image' };
    }
  }

  return { filePath: null, mode: 'empty' };
}
