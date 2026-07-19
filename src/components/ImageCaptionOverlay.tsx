import { useEffect, useState } from 'react';
import type { ImageCaption } from '../services/tauriCommands';

interface ImageCaptionOverlayProps {
  caption: ImageCaption;
  hasThumbnails: boolean;
  onCopy: () => void;
}

export function ImageCaptionOverlay({ caption, hasThumbnails, onCopy }: ImageCaptionOverlayProps) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [caption.sidecar_path]);

  return (
    <section
      className={`image-caption-overlay ${expanded ? 'image-caption-overlay--expanded' : ''} ${
        hasThumbnails ? 'image-caption-overlay--with-thumbnails' : ''
      }`}
      aria-label="Image caption"
    >
      <button
        className="image-caption-toggle"
        type="button"
        aria-expanded={expanded}
        aria-controls="image-caption-text"
        aria-label={expanded ? 'Collapse image caption' : 'Expand image caption'}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="image-caption-label">Caption</span>
        <span className="image-caption-text" id="image-caption-text">
          {caption.text}
        </span>
        <span className="image-caption-disclosure" aria-hidden="true">
          {expanded ? '⌃' : '⌄'}
        </span>
      </button>
      <button
        className="image-caption-copy"
        type="button"
        aria-label="Copy image caption"
        title="Copy caption"
        onClick={onCopy}
      >
        Copy
      </button>
    </section>
  );
}
