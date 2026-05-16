import { renderHook, act, waitFor } from '@testing-library/react';
import { useImageNavigation } from './useImageNavigation';
import { useViewerStore } from '../state/viewerStore';
import { useSettingsStore } from '../state/settingsStore';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  getParentFolder,
  readFolderIndex,
  refreshFolderIndex,
  scanFolder,
} from '../services/tauriCommands';
import { invalidateThumbnail } from '../services/thumbnailCache';
import { invalidateImageAsset } from '../services/imageAssetCache';

// Mock the services and Tauri APIs
vi.mock('../services/tauriCommands', () => ({
  scanFolder: vi.fn(),
  readFolderIndex: vi.fn(),
  refreshFolderIndex: vi.fn(),
  getParentFolder: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    setTitle: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../services/thumbnailCache', () => ({
  invalidateThumbnail: vi.fn(),
}));

vi.mock('../services/imageAssetCache', () => ({
  invalidateImageAsset: vi.fn(),
}));

// Mock audio for playBoundaryBeep
const mockAudioContext = {
  createOscillator: vi.fn(() => ({
    type: '',
    frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  })),
  createGain: vi.fn(() => ({
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  })),
  currentTime: 0,
  destination: {},
};
(window as any).AudioContext = vi.fn(() => mockAudioContext);

describe('useImageNavigation', () => {
  beforeEach(() => {
    useViewerStore.getState().reset();
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, sortOrder: 'name' },
    });
    vi.clearAllMocks();
  });

  it('should open an image and scan the folder', async () => {
    const mockImages = [
      {
        path: 'c:/test/img1.jpg',
        file_name: 'img1.jpg',
        extension: 'jpg',
        size_bytes: 100,
        modified_at: '1000',
      },
      {
        path: 'c:/test/img2.jpg',
        file_name: 'img2.jpg',
        extension: 'jpg',
        size_bytes: 200,
        modified_at: '2000',
      },
    ];
    (getParentFolder as any).mockReturnValue('c:/test');
    (scanFolder as any).mockResolvedValue(mockImages);

    const { result } = renderHook(() => useImageNavigation());

    await act(async () => {
      await result.current.openImage('c:/test/img1.jpg');
    });

    expect(getParentFolder).toHaveBeenCalledWith('c:/test/img1.jpg');
    expect(scanFolder).toHaveBeenCalledWith('c:/test');
    expect(useViewerStore.getState().images).toEqual(mockImages);
    expect(useViewerStore.getState().currentIndex).toBe(0);
    expect(useViewerStore.getState().currentImagePath).toBe('c:/test/img1.jpg');
  });

  it('returns to viewer mode when opening an image from grid mode', async () => {
    const mockImages = [
      {
        path: 'c:/test/img1.jpg',
        file_name: 'img1.jpg',
        extension: 'jpg',
        size_bytes: 100,
        modified_at: '1000',
      },
    ];
    (getParentFolder as any).mockReturnValue('c:/test');
    (scanFolder as any).mockResolvedValue(mockImages);

    act(() => {
      useViewerStore.getState().setViewMode('grid');
    });

    const { result } = renderHook(() => useImageNavigation());

    await act(async () => {
      await result.current.openImage('c:/test/img1.jpg');
    });

    expect(useViewerStore.getState().viewMode).toBe('viewer');
    expect(useViewerStore.getState().currentImagePath).toBe('c:/test/img1.jpg');
  });

  it('should resolve startup image open before folder scan finishes', async () => {
    const deferredImages = [
      {
        path: 'c:/test/img1.jpg',
        file_name: 'img1.jpg',
        extension: 'jpg',
        size_bytes: 100,
        modified_at: '1000',
      },
    ];
    (getParentFolder as any).mockReturnValue('c:/test');

    let resolveScan: ((images: typeof deferredImages) => void) | undefined;
    (scanFolder as any).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve;
        })
    );

    const { result } = renderHook(() => useImageNavigation());

    await act(async () => {
      await result.current.openImageForStartup('c:/test/img1.jpg');
    });

    expect(useViewerStore.getState().currentImagePath).toBe('c:/test/img1.jpg');
    expect(useViewerStore.getState().isFolderScanning).toBe(true);

    resolveScan?.(deferredImages);

    await waitFor(() => {
      expect(useViewerStore.getState().isFolderScanning).toBe(false);
      expect(useViewerStore.getState().images).toEqual(deferredImages);
    });
  });

  it('startup open honors current default zoom mode', async () => {
    const deferredImages = [
      {
        path: 'c:/test/img1.jpg',
        file_name: 'img1.jpg',
        extension: 'jpg',
        size_bytes: 100,
        modified_at: '1000',
      },
    ];
    (getParentFolder as any).mockReturnValue('c:/test');

    let resolveScan: ((images: typeof deferredImages) => void) | undefined;
    (scanFolder as any).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve;
        })
    );

    act(() => {
      useViewerStore.getState().setDefaultZoomMode('actual');
    });

    const { result } = renderHook(() => useImageNavigation());

    await act(async () => {
      await result.current.openImageForStartup('c:/test/img1.jpg');
    });

    expect(useViewerStore.getState().zoomMode).toBe('actual');

    resolveScan?.(deferredImages);
    await waitFor(() => {
      expect(useViewerStore.getState().isFolderScanning).toBe(false);
    });
  });

  it('returns to viewer mode when opening a folder from grid mode', async () => {
    const mockImages = [
      {
        path: 'c:/test/img1.jpg',
        file_name: 'img1.jpg',
        extension: 'jpg',
        size_bytes: 100,
        modified_at: '1000',
      },
    ];
    (readFolderIndex as any).mockResolvedValue([]);
    (refreshFolderIndex as any).mockResolvedValue(mockImages);

    act(() => {
      useViewerStore.getState().setViewMode('grid');
    });

    const { result } = renderHook(() => useImageNavigation());

    await act(async () => {
      await result.current.openFolder('c:/test');
    });

    expect(useViewerStore.getState().viewMode).toBe('viewer');
    expect(useViewerStore.getState().currentImagePath).toBe('c:/test/img1.jpg');
    expect(refreshFolderIndex).toHaveBeenCalledWith('c:/test');
  });

  it('shows cached folder entries before verified refresh finishes', async () => {
    const cachedImages = [
      {
        path: 'c:/test/a.jpg',
        file_name: 'a.jpg',
        extension: 'jpg',
        size_bytes: 100,
        modified_at: '1000',
      },
      {
        path: 'c:/test/b.jpg',
        file_name: 'b.jpg',
        extension: 'jpg',
        size_bytes: 200,
        modified_at: '2000',
      },
    ];
    const verifiedImages = [
      {
        path: 'c:/test/c.jpg',
        file_name: 'c.jpg',
        extension: 'jpg',
        size_bytes: 150,
        modified_at: '3000',
      },
      {
        path: 'c:/test/b.jpg',
        file_name: 'b.jpg',
        extension: 'jpg',
        size_bytes: 200,
        modified_at: '2000',
      },
    ];
    let resolveRefresh: ((images: typeof verifiedImages) => void) | undefined;
    (readFolderIndex as any).mockResolvedValue(cachedImages);
    (refreshFolderIndex as any).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );

    const { result } = renderHook(() => useImageNavigation());

    await act(async () => {
      await result.current.openFolder('c:/test');
    });

    expect(useViewerStore.getState().images).toEqual(cachedImages);
    expect(useViewerStore.getState().currentImagePath).toBe('c:/test/a.jpg');
    expect(useViewerStore.getState().isFolderScanning).toBe(true);

    act(() => {
      useViewerStore.getState().setCurrentIndex(1);
    });

    resolveRefresh?.(verifiedImages);

    await waitFor(() => {
      expect(useViewerStore.getState().isFolderScanning).toBe(false);
      expect(useViewerStore.getState().images).toEqual(verifiedImages);
      expect(useViewerStore.getState().currentImagePath).toBe('c:/test/b.jpg');
    });
  });

  it('should navigate next and previous', async () => {
    const mockImages = [
      {
        path: 'c:/test/img1.jpg',
        file_name: 'img1.jpg',
        extension: 'jpg',
        size_bytes: 100,
        modified_at: '1000',
      },
      {
        path: 'c:/test/img2.jpg',
        file_name: 'img2.jpg',
        extension: 'jpg',
        size_bytes: 200,
        modified_at: '2000',
      },
    ];

    act(() => {
      useViewerStore.getState().setImages(mockImages);
      useViewerStore.getState().setCurrentIndex(0);
    });

    const { result } = renderHook(() => useImageNavigation());

    act(() => {
      result.current.goNext();
    });
    expect(useViewerStore.getState().currentIndex).toBe(1);

    act(() => {
      result.current.goPrev();
    });
    expect(useViewerStore.getState().currentIndex).toBe(0);
  });

  it('should play beep when reaching boundary', async () => {
    const mockImages = [
      {
        path: 'c:/test/img1.jpg',
        file_name: 'img1.jpg',
        extension: 'jpg',
        size_bytes: 100,
        modified_at: '1000',
      },
      {
        path: 'c:/test/img2.jpg',
        file_name: 'img2.jpg',
        extension: 'jpg',
        size_bytes: 200,
        modified_at: '2000',
      },
    ];

    act(() => {
      useViewerStore.getState().setImages(mockImages);
      useViewerStore.getState().setCurrentIndex(1);
    });

    const { result } = renderHook(() => useImageNavigation());

    act(() => {
      result.current.goNext(false); // No loop
    });

    // Verify audio context was created (beep played)
    expect(window.AudioContext).toHaveBeenCalled();
  });

  it('should sort images when sort order changes', async () => {
    const mockImages = [
      {
        path: 'img1.jpg',
        file_name: 'img1.jpg',
        extension: 'jpg',
        size_bytes: 100,
        modified_at: '1000',
      },
      {
        path: 'img2.jpg',
        file_name: 'img2.jpg',
        extension: 'jpg',
        size_bytes: 200,
        modified_at: '2000',
      },
    ];

    act(() => {
      useViewerStore.getState().setImages(mockImages);
      useViewerStore.getState().setCurrentIndex(0);
    });

    renderHook(() => useImageNavigation());

    act(() => {
      useSettingsStore.setState({
        settings: { ...useSettingsStore.getState().settings, sortOrder: 'size' },
      });
    });

    // Wait for useEffect to run
    await waitFor(() => {
      expect(useViewerStore.getState().images[0].file_name).toBe('img2.jpg'); // Largest first
    });
  });

  it('refresh keeps current image when it still exists', async () => {
    const initialImages = [
      {
        path: 'c:/test/a.jpg',
        file_name: 'a.jpg',
        extension: 'jpg',
        size_bytes: 100,
        modified_at: '1000',
      },
      {
        path: 'c:/test/b.jpg',
        file_name: 'b.jpg',
        extension: 'jpg',
        size_bytes: 200,
        modified_at: '2000',
      },
    ];

    act(() => {
      useViewerStore.getState().setFolderPath('c:/test');
      useViewerStore.getState().setImages(initialImages);
      useViewerStore.getState().setCurrentIndex(1);
    });

    (refreshFolderIndex as any).mockResolvedValue([
      {
        path: 'c:/test/c.jpg',
        file_name: 'c.jpg',
        extension: 'jpg',
        size_bytes: 150,
        modified_at: '3000',
      },
      {
        path: 'c:/test/b.jpg',
        file_name: 'b.jpg',
        extension: 'jpg',
        size_bytes: 200,
        modified_at: '2000',
      },
    ]);

    const { result } = renderHook(() => useImageNavigation());

    await act(async () => {
      await result.current.refreshFolder();
    });

    expect(useViewerStore.getState().currentImagePath).toBe('c:/test/b.jpg');
  });

  it('refresh selects nearest valid index when current image is removed', async () => {
    const initialImages = [
      {
        path: 'c:/test/a.jpg',
        file_name: 'a.jpg',
        extension: 'jpg',
        size_bytes: 100,
        modified_at: '1000',
      },
      {
        path: 'c:/test/b.jpg',
        file_name: 'b.jpg',
        extension: 'jpg',
        size_bytes: 200,
        modified_at: '2000',
      },
      {
        path: 'c:/test/c.jpg',
        file_name: 'c.jpg',
        extension: 'jpg',
        size_bytes: 300,
        modified_at: '3000',
      },
    ];

    act(() => {
      useViewerStore.getState().setFolderPath('c:/test');
      useViewerStore.getState().setImages(initialImages);
      useViewerStore.getState().setCurrentIndex(2);
    });

    (refreshFolderIndex as any).mockResolvedValue([
      {
        path: 'c:/test/a.jpg',
        file_name: 'a.jpg',
        extension: 'jpg',
        size_bytes: 100,
        modified_at: '1000',
      },
      {
        path: 'c:/test/b.jpg',
        file_name: 'b.jpg',
        extension: 'jpg',
        size_bytes: 200,
        modified_at: '2000',
      },
    ]);

    const { result } = renderHook(() => useImageNavigation());

    await act(async () => {
      await result.current.refreshFolder();
    });

    expect(useViewerStore.getState().currentIndex).toBe(1);
    expect(useViewerStore.getState().currentImagePath).toBe('c:/test/b.jpg');
    expect(invalidateThumbnail).toHaveBeenCalledWith('c:/test/c.jpg');
    expect(invalidateImageAsset).toHaveBeenCalledWith('c:/test/c.jpg');
  });

  it('refresh handles an empty folder', async () => {
    act(() => {
      useViewerStore.getState().setFolderPath('c:/test');
      useViewerStore.getState().setImages([
        {
          path: 'c:/test/a.jpg',
          file_name: 'a.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1000',
        },
      ]);
      useViewerStore.getState().setCurrentIndex(0);
    });

    (refreshFolderIndex as any).mockResolvedValue([]);

    const { result } = renderHook(() => useImageNavigation());

    await act(async () => {
      await result.current.refreshFolder();
    });

    expect(useViewerStore.getState().images).toEqual([]);
    expect(useViewerStore.getState().currentImagePath).toBeNull();
    expect(useViewerStore.getState().currentIndex).toBe(-1);
    expect(useViewerStore.getState().errorMessage).toContain('No supported images');
  });

  it('refresh applies non-name sort order', async () => {
    act(() => {
      useSettingsStore.setState({
        settings: { ...useSettingsStore.getState().settings, sortOrder: 'size' },
      });
      useViewerStore.getState().setFolderPath('c:/test');
      useViewerStore.getState().setImages([
        {
          path: 'c:/test/a.jpg',
          file_name: 'a.jpg',
          extension: 'jpg',
          size_bytes: 100,
          modified_at: '1000',
        },
      ]);
      useViewerStore.getState().setCurrentIndex(0);
    });

    (refreshFolderIndex as any).mockResolvedValue([
      {
        path: 'c:/test/a.jpg',
        file_name: 'a.jpg',
        extension: 'jpg',
        size_bytes: 100,
        modified_at: '1000',
      },
      {
        path: 'c:/test/b.jpg',
        file_name: 'b.jpg',
        extension: 'jpg',
        size_bytes: 300,
        modified_at: '2000',
      },
    ]);

    const { result } = renderHook(() => useImageNavigation());

    await act(async () => {
      await result.current.refreshFolder();
    });

    expect(useViewerStore.getState().images.map((img) => img.file_name)).toEqual([
      'b.jpg',
      'a.jpg',
    ]);
  });
});
