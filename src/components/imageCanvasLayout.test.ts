import { describe, expect, it } from 'vitest';
import { getImageStyle } from './imageCanvasLayout';

describe('getImageStyle', () => {
  it('pins actual-size previews to metadata dimensions before full resolution is ready', () => {
    expect(
      getImageStyle({
        zoomMode: 'actual',
        panX: 4,
        panY: -2,
        rotation: 90,
        zoomLevel: 1,
        isFullResolutionReady: false,
        metadata: {
          width: 1200,
          height: 800,
          file_size_bytes: 1,
          format: 'jpeg',
          codec_backend: 'browser',
          native_decode_supported: true,
          detail_backend: 'browser',
          detail_supported: true,
          browser_renderable: true,
          rust_decode_supported: true,
          metadata_supported: true,
          thumbnail_supported: true,
        },
        pendingCropPreview: null,
        isCropMode: false,
      })
    ).toMatchObject({
      width: '1200px',
      height: '800px',
      transform: 'translate(4px, -2px) rotate(90deg)',
      maxWidth: 'none',
      maxHeight: 'none',
    });
  });

  it('adds a crop clip only while the crop editor is closed', () => {
    const options = {
      zoomMode: 'fit' as const,
      panX: 0,
      panY: 0,
      rotation: 0,
      zoomLevel: 1,
      isFullResolutionReady: true,
      metadata: null,
      pendingCropPreview: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
      isCropMode: false,
    };

    const style = getImageStyle(options);
    expect(style.clipPath).toContain('inset(20% 40%');
    expect(style.clipPath).toContain('10%');
    expect(style.transformOrigin).toBe('center center');
    expect(getImageStyle({ ...options, isCropMode: true })).not.toHaveProperty('clipPath');
  });
});
