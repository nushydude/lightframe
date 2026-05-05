import { useEffect, useRef, useState } from 'react';
import { useViewerStore } from '../state/viewerStore';
import { getThumbnail } from '../services/tauriCommands';

/**
 * A high-performance horizontal strip of thumbnails for quick navigation.
 * Uses native Rust-generated thumbnails to minimize memory usage and maximize speed.
 */
export function ThumbnailStrip() {
  const { images, currentIndex, setCurrentIndex } = useViewerStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLDivElement>(null);

  // Map of image paths to their small base64 thumbnails
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});

  // Center the active thumbnail when it changes
  useEffect(() => {
    if (activeItemRef.current && scrollRef.current) {
      activeItemRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center',
      });
    }
  }, [currentIndex]);

  // Load thumbnails as needed (Virtualized-like approach)
  useEffect(() => {
    if (!images.length) {
      setThumbnailUrls({});
      return;
    }

    let cancelled = false;

    // Load thumbnails for a window around the current index
    const windowSize = 25;
    const start = Math.max(0, currentIndex - windowSize);
    const end = Math.min(images.length, currentIndex + windowSize);

    const loadWindow = async () => {
      // Check which images in the window need thumbnails
      const missingIndices = [];
      for (let i = start; i < end; i++) {
        if (!thumbnailUrls[images[i].path]) {
          missingIndices.push(i);
        }
      }

      if (missingIndices.length === 0) return;

      // Load missing thumbnails one by one (or in small batches)
      for (const idx of missingIndices) {
        if (cancelled) break;
        const path = images[idx].path;
        try {
          const base64 = await getThumbnail(path);
          if (!cancelled) {
            setThumbnailUrls(prev => ({ ...prev, [path]: base64 }));
          }
        } catch (err) {
          console.error('Thumbnail failed:', err);
        }
      }
    };

    loadWindow();

    // Cleanup: If the cache grows too large, purge distant entries
    if (Object.keys(thumbnailUrls).length > 100) {
      const currentPaths = new Set(
        images
          .slice(Math.max(0, currentIndex - 40), currentIndex + 40)
          .map((img) => img.path)
      );
      
      setThumbnailUrls(prev => {
        const next = { ...prev };
        let purged = false;
        Object.keys(next).forEach(key => {
          if (!currentPaths.has(key)) {
            delete next[key];
            purged = true;
          }
        });
        return purged ? next : prev;
      });
    }

    return () => { cancelled = true; };
  }, [currentIndex, images]);

  if (images.length <= 1) return null;

  return (
    <div className="thumbnail-strip-container" ref={scrollRef}>
      <div className="thumbnail-strip">
        {images.map((image, index) => {
          const isActive = index === currentIndex;
          const url = thumbnailUrls[image.path];

          return (
            <div
              key={image.path}
              ref={isActive ? activeItemRef : null}
              className={`thumbnail-item ${isActive ? 'active' : ''}`}
              onClick={() => setCurrentIndex(index)}
              title={image.file_name}
            >
              {url ? (
                <img
                  src={url}
                  alt=""
                  draggable={false}
                />
              ) : (
                <div className="thumbnail-placeholder" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
