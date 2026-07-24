import type { ImageCaption } from '../services/tauriCommands';

interface ImageCaptionOverlayProps {
  caption: ImageCaption;
  expanded: boolean;
  hasThumbnails: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onCopy: () => void;
}

export function ImageCaptionOverlay({
  caption,
  expanded,
  hasThumbnails,
  onExpandedChange,
  onCopy,
}: ImageCaptionOverlayProps) {
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
        onClick={() => onExpandedChange(!expanded)}
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
