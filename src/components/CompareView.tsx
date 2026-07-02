import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { getPreviewAsset } from '../services/imageAssetCache';
import { useZoomPan } from '../hooks/useZoomPan';
import { useViewerStore } from '../state/viewerStore';

const PREVIEW_MAX_DIMENSION = 2048;

type ComparePaneProps = {
  roleLabel: 'Primary' | 'Candidate';
  isFocused: boolean;
  imagePath: string;
  index: number;
  imageCount: number;
  imageStyle: CSSProperties;
  onWheelNext: () => void;
  onWheelPrev: () => void;
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

function ComparePane({
  roleLabel,
  isFocused,
  imagePath,
  index,
  imageCount,
  imageStyle,
  onWheelNext,
  onWheelPrev,
}: ComparePaneProps) {
  const { src, hasError } = useComparePreview(imagePath);
  const className = ['compare-pane', isFocused ? 'focused' : ''].filter(Boolean).join(' ');
  const containerRef = useRef<HTMLDivElement>(null);
  const { zoomMode, isDragging, handleMouseDown, handleMouseMove, handleMouseUp } = useZoomPan(
    containerRef,
    { onWheelNext, onWheelPrev }
  );
  const canvasClassName = [
    'compare-pane-canvas',
    isDragging ? 'dragging' : '',
    zoomMode === 'actual' || zoomMode === 'custom' ? 'zoomable' : '',
  ]
    .filter(Boolean)
    .join(' ');

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
      <div
        className={canvasClassName}
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {src ? (
          <img src={src} alt="" draggable={false} style={imageStyle} />
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
  const {
    images,
    comparePrimaryIndex,
    compareSecondaryIndex,
    compareFocusedPane,
    zoomMode,
    zoomLevel,
    panX,
    panY,
    moveCompareFocusedCandidate,
  } = useViewerStore();
  const primaryImage = images[comparePrimaryIndex];
  const secondaryImage = images[compareSecondaryIndex];
  const imageStyle = useMemo<CSSProperties>(() => {
    if (zoomMode === 'actual') {
      return {
        transform: `translate(${panX}px, ${panY}px)`,
        maxWidth: 'none',
        maxHeight: 'none',
      };
    }

    if (zoomMode === 'custom') {
      return {
        transform: `translate(${panX}px, ${panY}px) scale(${zoomLevel})`,
        maxWidth: 'none',
        maxHeight: 'none',
      };
    }

    return {};
  }, [panX, panY, zoomLevel, zoomMode]);

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
        imageStyle={imageStyle}
        onWheelNext={() => void moveCompareFocusedCandidate(1)}
        onWheelPrev={() => void moveCompareFocusedCandidate(-1)}
      />
      <ComparePane
        roleLabel="Candidate"
        isFocused={compareFocusedPane === 'secondary'}
        imagePath={secondaryImage.path}
        index={compareSecondaryIndex}
        imageCount={images.length}
        imageStyle={imageStyle}
        onWheelNext={() => void moveCompareFocusedCandidate(1)}
        onWheelPrev={() => void moveCompareFocusedCandidate(-1)}
      />
    </div>
  );
}
