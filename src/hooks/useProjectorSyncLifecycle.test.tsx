import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeWindow } from '../services/runtime/types';
import { useProjectorSyncLifecycle } from './useProjectorSyncLifecycle';

const mocks = vi.hoisted(() => ({
  eventHandlers: new Map<string, (payload: unknown) => void>(),
  order: [] as string[],
  setImages: vi.fn(),
  adoptProjectorGrant: vi.fn(),
  clearAdoptedProjectorGrant: vi.fn(),
  hydrateProjectorSelection: vi.fn(),
  registerProjectorNavigationHandler: vi.fn(),
  requestStateSync: vi.fn(async () => undefined),
  readProjectorDisplayRecord: vi.fn(),
  emitStateSync: vi.fn(async () => undefined),
  clearProjectorSync: vi.fn(async () => undefined),
  navigateProjectorImage: vi.fn(),
}));

vi.mock('../services/runtime/runtime', () => ({
  getRuntime: () => ({
    listen: vi.fn(async (event: string, handler: (payload: unknown) => void) => {
      mocks.order.push(`listen:${event}`);
      mocks.eventHandlers.set(event, handler);
      return () => mocks.eventHandlers.delete(event);
    }),
  }),
}));

vi.mock('../state/viewerStore', () => ({
  hydrateProjectorSelection: mocks.hydrateProjectorSelection,
  registerProjectorNavigationHandler: mocks.registerProjectorNavigationHandler,
  useViewerStore: {
    getState: () => ({ setImages: mocks.setImages, setCurrentIndex: vi.fn() }),
  },
}));

vi.mock('../services/tauriCommands', () => ({
  adoptProjectorGrant: mocks.adoptProjectorGrant,
  clearAdoptedProjectorGrant: mocks.clearAdoptedProjectorGrant,
  requestStateSync: async () => {
    mocks.order.push('request');
    return mocks.requestStateSync();
  },
  readProjectorDisplayRecord: mocks.readProjectorDisplayRecord,
  emitStateSync: mocks.emitStateSync,
  clearProjectorSync: mocks.clearProjectorSync,
  navigateProjectorImage: mocks.navigateProjectorImage,
}));

function Harness() {
  useProjectorSyncLifecycle({
    appWindow: { label: 'secondary' } as RuntimeWindow,
    currentImagePath: null,
    openImage: vi.fn(),
  });
  return null;
}

function MainHarness({ imageId }: { imageId: string }) {
  useProjectorSyncLifecycle({
    appWindow: { label: 'main' } as RuntimeWindow,
    currentImagePath: `C:/images/${imageId}.jpg`,
    activeSessionId: 'session-main',
    activeImageId: imageId,
    openImage: vi.fn(),
  });
  return null;
}

afterEach(() => {
  mocks.eventHandlers.clear();
  mocks.order.length = 0;
  vi.clearAllMocks();
});

describe('useProjectorSyncLifecycle', () => {
  it('serializes main sync commands so a slower prior request cannot finish last', async () => {
    let resolveFirst!: () => void;
    mocks.emitStateSync
      .mockReturnValueOnce(
        new Promise<undefined>((resolve) => {
          resolveFirst = () => resolve(undefined);
        })
      )
      .mockResolvedValueOnce(undefined);

    const rendered = render(<MainHarness imageId="image-1" />);
    await waitFor(() =>
      expect(mocks.emitStateSync).toHaveBeenCalledWith('session-main', 'image-1')
    );

    rendered.rerender(<MainHarness imageId="image-2" />);
    await Promise.resolve();
    expect(mocks.emitStateSync).toHaveBeenCalledTimes(1);

    resolveFirst();
    await waitFor(() =>
      expect(mocks.emitStateSync).toHaveBeenLastCalledWith('session-main', 'image-2')
    );
  });

  it('installs the listener before requesting sync and a clear invalidates pending hydration', async () => {
    let resolveRecord!: (record: {
      session_id: string;
      image: { id: string; path: string; file_name: string; extension: string; size_bytes: number };
      images: [];
      grant_epoch: number;
      navigation_generation: number;
    }) => void;
    mocks.readProjectorDisplayRecord.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRecord = resolve;
      })
    );

    render(<Harness />);

    await waitFor(() => expect(mocks.readProjectorDisplayRecord).toHaveBeenCalledOnce());
    expect(mocks.order.slice(0, 2)).toEqual(['listen:state-sync', 'request']);

    act(() => {
      mocks.eventHandlers.get('state-sync')?.({ source: 'main' });
    });
    expect(mocks.clearAdoptedProjectorGrant).toHaveBeenCalledOnce();
    expect(mocks.setImages).toHaveBeenCalledWith([]);

    await act(async () => {
      resolveRecord({
        session_id: 'stale-session',
        image: {
          id: 'stale-image',
          path: 'C:/stale.jpg',
          file_name: 'stale.jpg',
          extension: 'jpg',
          size_bytes: 1,
        },
        images: [],
        grant_epoch: 1,
        navigation_generation: 1,
      });
      await Promise.resolve();
    });

    expect(mocks.adoptProjectorGrant).not.toHaveBeenCalled();
    expect(mocks.setImages).toHaveBeenCalledTimes(1);
  });
});
