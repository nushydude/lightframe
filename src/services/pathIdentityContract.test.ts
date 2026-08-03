import { describe, expect, it } from 'vitest';

const identityConsumers = import.meta.glob(
  [
    '../state/viewerStore.ts',
    '../hooks/useImageNavigation.ts',
    '../state/curationStore.ts',
    './imageSorting.ts',
    '../hooks/useFolderWatcherLifecycle.ts',
    './markedSelectionPersistence.ts',
    '../components/ImageCanvas.tsx',
    '../state/editQueueStore.ts',
    './pathMetadataCache.ts',
    './folderWatcherReconciliation.ts',
  ],
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>;

const backendIdentityConsumers = import.meta.glob(
  [
    '../../src-tauri/src/curation.rs',
    '../../src-tauri/src/commands/curation_commands.rs',
    '../../src-tauri/src/commands/settings_commands.rs',
  ],
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>;

describe('filesystem path identity source contract', () => {
  it('routes identity consumers through pathIdentityKey without ad-hoc case folding', () => {
    for (const [relativePath, source] of Object.entries(identityConsumers)) {
      expect(`${relativePath}\n${source}`).not.toMatch(
        /replace\(\/\\\\\/g,\s*['"]\/['"]\)[^\n]*toLowerCase\(\)/
      );
    }
  });

  it('keeps backend filesystem identity consumers free of ad-hoc case folding', () => {
    for (const [relativePath, source] of Object.entries(backendIdentityConsumers)) {
      expect(`${relativePath}\n${source}`).not.toMatch(/to_lowercase\(|eq_ignore_ascii_case\(/);
    }
  });
});
