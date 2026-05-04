import { renderHook, act, waitFor } from '@testing-library/react';
import { useImageNavigation } from './useImageNavigation';
import { useViewerStore } from '../state/viewerStore';
import { useSettingsStore } from '../state/settingsStore';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { scanFolder, getParentFolder } from '../services/tauriCommands';

// Mock the services and Tauri APIs
vi.mock('../services/tauriCommands', () => ({
  scanFolder: vi.fn(),
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
    vi.clearAllMocks();
  });

  it('should open an image and scan the folder', async () => {
    const mockImages = [
      { path: 'c:/test/img1.jpg', name: 'img1.jpg', size_bytes: 100, modified_at: '1000' },
      { path: 'c:/test/img2.jpg', name: 'img2.jpg', size_bytes: 200, modified_at: '2000' },
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

  it('should navigate next and previous', async () => {
    const mockImages = [
      { path: 'c:/test/img1.jpg', name: 'img1.jpg', size_bytes: 100, modified_at: '1000' },
      { path: 'c:/test/img2.jpg', name: 'img2.jpg', size_bytes: 200, modified_at: '2000' },
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
      { path: 'c:/test/img1.jpg', name: 'img1.jpg', size_bytes: 100, modified_at: '1000' },
      { path: 'c:/test/img2.jpg', name: 'img2.jpg', size_bytes: 200, modified_at: '2000' },
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
      { path: 'img1.jpg', name: 'img1.jpg', size_bytes: 100, modified_at: '1000' },
      { path: 'img2.jpg', name: 'img2.jpg', size_bytes: 200, modified_at: '2000' },
    ];

    act(() => {
      useViewerStore.getState().setImages(mockImages);
      useViewerStore.getState().setCurrentIndex(0);
    });

    const { result } = renderHook(() => useImageNavigation());

    act(() => {
      useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, sortOrder: 'size' } });
    });

    // Wait for useEffect to run
    await waitFor(() => {
      expect(useViewerStore.getState().images[0].name).toBe('img2.jpg'); // Largest first
    });
  });
});
