import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { SettingsPanel } from './SettingsPanel';
import { useSettingsStore } from '../state/settingsStore';
import { useViewerStore } from '../state/viewerStore';

describe('SettingsPanel', () => {
  beforeEach(() => {
    useSettingsStore.setState((state) => ({ ...state, isLoaded: true }));
    useViewerStore.getState().reset();
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'get_codec_health') {
        return {
          platform: 'windows',
          entries: [],
          generatedCache: {
            buckets: [],
            totalFileCount: 0,
            totalSizeBytes: 0,
            rawNativeFailureCount: 0,
          },
          runtimeStats: {
            nativePreviewTiming: { sampleCount: 0, totalMs: 0, maxMs: 0 },
            rustPreviewTiming: { sampleCount: 0, totalMs: 0, maxMs: 0 },
            placeholderPreviewTiming: { sampleCount: 0, totalMs: 0, maxMs: 0 },
            nativeTileTiming: { sampleCount: 0, totalMs: 0, maxMs: 0 },
            rustTileTiming: { sampleCount: 0, totalMs: 0, maxMs: 0 },
            thumbnailCacheHits: 0,
            previewCacheHits: 0,
            tileCacheHits: 0,
            nativeThumbnailGenerations: 0,
            nativePreviewGenerations: 0,
            rustThumbnailGenerations: 0,
            rustPreviewGenerations: 0,
            placeholderThumbnailGenerations: 0,
            placeholderPreviewGenerations: 0,
            tileGenerations: 0,
          },
        };
      }

      return {};
    });
  });

  it('renders the diagnostics section without entering a render loop', async () => {
    render(<SettingsPanel />);

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('Diagnostics')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Format Support')).toBeInTheDocument();
    });
  });
});
