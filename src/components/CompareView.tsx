import { useEffect, useState } from 'react';
import { getPreviewAsset } from '../services/imageAssetCache';
import { useViewerStore } from '../state/viewerStore';

const PREVIEW_MAX_DIMENSION = 2048;

type ComparePaneProps = {
  roleLabel: 'Primary' | 'Candidate';
  isFocused: boolean;
  imagePath: string;
  index: number;
  imageCount: number;
};

function getFileName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

function useComparePreview(path: string): { src: string; hasError: boolean } {
  const [src, setSrc] = useState('');
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let isCancelled = false;
    setSrc('');
    setHasError(false);

    void getPreviewAsset(path, PREVIEW_MAX_DIMENSION)
      .then((previewSrc) => {
        if (!isCancelled) {
          setSrc(previewSrc);
        }
      })
      .catch((err) => {
        console.error('Failed to load compare preview:', err);
        if (!isCancelled) {
          setHasError(true);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [path]);

  return { src, hasError };
}

function ComparePane({ roleLabel, isFocused, imagePath, index, imageCount }: ComparePaneProps) {
  const { src, hasError } = useComparePreview(imagePath);
  const className = ['compare-pane', isFocused ? 'focused' : ''].filter(Boolean).join(' ');

  return (
    <section className={className} aria-label={`${roleLabel} image pane`}>
      <header className="compare-pane-header">
        <div className="compare-pane-title-group">
          <span className="compare-pane-role">{roleLabel}</span>
          {isFocused && <span className="compare-pane-focus">Focused</span>}
        </div>
        <span className="compare-pane-index">
          {index + 1} / {imageCount}
        </span>
      </header>
      <div className="compare-pane-filename" title={getFileName(imagePath)}>
        {getFileName(imagePath)}
      </div>
      <div className="compare-pane-canvas">
        {src ? (
          <img src={src} alt="" draggable={false} />
        ) : hasError ? (
          <div className="compare-pane-placeholder">Unable to load preview</div>
        ) : (
          <div className="compare-pane-placeholder">Loading preview...</div>
        )}
      </div>
    </section>
  );
}

export function CompareView() {
  const { images, comparePrimaryIndex, compareSecondaryIndex, compareFocusedPane } =
    useViewerStore();
  const primaryImage = images[comparePrimaryIndex];
  const secondaryImage = images[compareSecondaryIndex];

  if (!primaryImage || !secondaryImage) {
    return (
      <div className="compare-view compare-view-empty" role="status" aria-live="polite">
        Compare view needs at least two images.
      </div>
    );
  }

  return (
    <div className="compare-view" role="region" aria-label="Compare view">
      <ComparePane
        roleLabel="Primary"
        isFocused={compareFocusedPane === 'primary'}
        imagePath={primaryImage.path}
        index={comparePrimaryIndex}
        imageCount={images.length}
      />
      <ComparePane
        roleLabel="Candidate"
        isFocused={compareFocusedPane === 'secondary'}
        imagePath={secondaryImage.path}
        index={compareSecondaryIndex}
        imageCount={images.length}
      />
    </div>
  );
}
