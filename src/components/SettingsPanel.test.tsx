import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { SettingsPanel } from './SettingsPanel';
import { useSettingsStore } from '../state/settingsStore';
import { useViewerStore } from '../state/viewerStore';
import { DEFAULT_SETTINGS } from '../types/settings';
import { initializeRuntime } from '../services/runtime/runtime';
import { createTestRuntimeAdapter } from '../services/runtime/testAdapter';

describe('SettingsPanel', () => {
  beforeEach(() => {
    useSettingsStore.setState((state) => ({
      ...state,
      settings: DEFAULT_SETTINGS,
      isLoaded: true,
      saveStatus: 'idle',
      saveError: null,
      loadError: null,
    }));
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

  it('preserves application and JSON filters through the runtime dialog boundary', async () => {
    const openFileOrFolder = vi.fn().mockResolvedValue(null);
    const saveFile = vi.fn().mockResolvedValue(null);
    initializeRuntime(createTestRuntimeAdapter({ openFileOrFolder, saveFile }));
    render(<SettingsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Choose app' }));
    expect(openFileOrFolder).toHaveBeenCalledWith({
      directory: false,
      multiple: false,
      filters: [{ name: 'Applications', extensions: ['exe', 'bat', 'cmd', 'com'] }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save JSON' }));
    await waitFor(() => {
      expect(saveFile).toHaveBeenCalledWith(
        expect.stringMatching(/^lightframe-diagnostics-.*\.json$/),
        {
          filters: [{ name: 'JSON', extensions: ['json'] }],
        }
      );
    });
  });

  it('renders the update channel setting', async () => {
    render(<SettingsPanel />);

    expect(screen.getByLabelText('Update channel')).toHaveValue('stable');
    expect(screen.getByText('Preview / beta releases')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Format Support')).toBeInTheDocument();
    });
  });

  it('updates the slideshow direction setting', async () => {
    render(<SettingsPanel />);

    const select = screen.getByLabelText('Slideshow direction');
    expect(select).toHaveValue('forward');

    fireEvent.change(select, { target: { value: 'reverse' } });

    await waitFor(() => {
      expect(useSettingsStore.getState().settings.slideshowDirection).toBe('reverse');
    });
  });

  it('persists the image caption visibility setting', async () => {
    render(<SettingsPanel />);

    const toggle = screen.getByLabelText('Show image captions');
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(useSettingsStore.getState().settings.showImageCaptions).toBe(false);
    });
  });

  it('shows saving state and a retryable save error', async () => {
    const retrySaveSettings = vi.fn().mockResolvedValue(true);
    useSettingsStore.setState({
      saveStatus: 'saving',
      saveError: null,
      loadError: null,
      retrySaveSettings,
    });

    render(<SettingsPanel />);
    expect(screen.getByRole('status')).toHaveTextContent('Saving settings…');

    useSettingsStore.setState({ saveStatus: 'error', saveError: 'disk full' });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Settings could not be saved. disk full'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retrySaveSettings).toHaveBeenCalledTimes(1);
  });

  it('shows load errors separately without a save retry action', () => {
    useSettingsStore.setState({
      saveStatus: 'idle',
      saveError: null,
      loadError: 'settings file unavailable',
    });

    render(<SettingsPanel />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Saved settings could not be loaded. Defaults are in use. settings file unavailable'
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});
