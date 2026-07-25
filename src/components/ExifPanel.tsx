import { useEffect, useRef, useState } from 'react';
import {
  getExifMetadata,
  getImageMetadata,
  type ExifData,
  type ImageCaption,
} from '../services/tauriCommands';
import type { ImageMetadata } from '../types/image';

interface ExifPanelProps {
  filePath: string;
  onClose: () => void;
  hasThumbnails?: boolean;
  refreshToken?: number;
  caption?: ImageCaption | null;
  onCopyCaption?: () => void;
}

interface ExifRow {
  label: string;
  value: string;
}

function formatFNumber(f: number): string {
  return `f/${f % 1 === 0 ? f.toFixed(0) : f.toFixed(1)}`;
}

// fallow-ignore-next-line complexity -- metadata formatting boundary
export function ExifPanel({
  filePath,
  onClose,
  hasThumbnails = false,
  refreshToken = 0,
  caption = null,
  onCopyCaption,
}: ExifPanelProps) {
  const [data, setData] = useState<ExifData | null>(null);
  const [imageMetadata, setImageMetadata] = useState<ImageMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false);
  const [showAllTags, setShowAllTags] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setLoading(true);
    setShowLoadingIndicator(false);
    setError(null);

    const loadingIndicatorTimer = window.setTimeout(() => {
      if (requestIdRef.current === requestId) {
        setShowLoadingIndicator(true);
      }
    }, 500);

    void Promise.allSettled([getExifMetadata(filePath), getImageMetadata(filePath)])
      .then(([exifResult, metadataResult]) => {
        if (requestIdRef.current !== requestId) return;

        if (metadataResult.status === 'fulfilled') {
          setImageMetadata(metadataResult.value);
        }

        if (exifResult.status === 'fulfilled') {
          setData(exifResult.value);
          return;
        }

        if (metadataResult.status === 'fulfilled') {
          setData({ raw: {} });
          return;
        }

        setError('No EXIF data found in this image.');
      })
      .finally(() => {
        if (requestIdRef.current === requestId) {
          setLoading(false);
          setShowLoadingIndicator(false);
        }
      });

    return () => {
      window.clearTimeout(loadingIndicatorTimer);
    };
  }, [filePath, refreshToken]);

  const primaryRows: ExifRow[] = data
    ? ([
        data.make && data.model
          ? { label: 'Camera', value: `${data.make} ${data.model}` }
          : data.make
            ? { label: 'Make', value: data.make }
            : null,
        data.date_time ? { label: 'Taken', value: formatDate(data.date_time) } : null,
        data.f_number != null ? { label: 'Aperture', value: formatFNumber(data.f_number) } : null,
        data.exposure_time ? { label: 'Shutter', value: data.exposure_time } : null,
        data.iso != null ? { label: 'ISO', value: String(data.iso) } : null,
        data.focal_length ? { label: 'Focal Length', value: data.focal_length } : null,
      ].filter(Boolean) as ExifRow[])
    : [];

  const fileRows: ExifRow[] = imageMetadata
    ? ([
        imageMetadata.width != null && imageMetadata.height != null
          ? { label: 'Dimensions', value: `${imageMetadata.width} x ${imageMetadata.height}` }
          : null,
        getFileExtension(filePath)
          ? { label: 'Extension', value: getFileExtension(filePath) }
          : imageMetadata.format
            ? { label: 'Extension', value: imageMetadata.format.toUpperCase() }
            : null,
        imageMetadata.format
          ? { label: 'Format', value: imageMetadata.format.toUpperCase() }
          : null,
        imageMetadata.file_size_bytes >= 0
          ? { label: 'File Size', value: formatFileSize(imageMetadata.file_size_bytes) }
          : null,
        imageMetadata.support_note ? { label: 'Support', value: imageMetadata.support_note } : null,
      ].filter(Boolean) as ExifRow[])
    : [];

  return (
    <div
      className={`exif-panel ${hasThumbnails ? 'exif-panel--with-thumbnails' : ''}`}
      role="complementary"
      aria-label="Image metadata"
    >
      <div className="exif-panel-header">
        <span className="exif-panel-title">Image Info</span>
        <button
          className="exif-panel-close"
          onClick={onClose}
          aria-label="Close info panel"
          id="btn-close-exif"
        >
          ✕
        </button>
      </div>

      <div className="exif-panel-body">
        {loading && showLoadingIndicator && (
          <div className={`exif-loading ${data || imageMetadata ? 'exif-loading--inline' : ''}`}>
            <div className="exif-spinner" />
            <span>Reading metadata…</span>
          </div>
        )}

        {!loading && error && (
          <div className="exif-empty">
            <span className="exif-empty-icon">📷</span>
            <p>{error}</p>
          </div>
        )}

        {caption && (
          <section className="exif-section exif-caption-section">
            <div className="exif-section-heading">
              <h3 className="exif-section-title">Caption</h3>
              {onCopyCaption && (
                <button
                  className="exif-caption-copy"
                  type="button"
                  onClick={onCopyCaption}
                  aria-label="Copy image caption"
                >
                  Copy
                </button>
              )}
            </div>
            <p className="exif-caption-text">{caption.text}</p>
            <p className="exif-caption-source" title={caption.sidecar_path}>
              {getFileName(caption.sidecar_path)}
            </p>
          </section>
        )}

        {data && (
          <>
            {fileRows.length > 0 && (
              <section className="exif-section">
                <h3 className="exif-section-title">File</h3>
                <dl className="exif-grid">
                  {fileRows.map((row) => (
                    <div className="exif-row" key={row.label}>
                      <dt className="exif-label">{row.label}</dt>
                      <dd className="exif-value">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            {primaryRows.length > 0 && (
              <section className="exif-section">
                <h3 className="exif-section-title">Camera</h3>
                <dl className="exif-grid">
                  {primaryRows.map((row) => (
                    <div className="exif-row" key={row.label}>
                      <dt className="exif-label">{row.label}</dt>
                      <dd className="exif-value">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            {Object.keys(data.raw).length > 0 && (
              <details
                className="exif-raw"
                open={showAllTags}
                onToggle={(event) => setShowAllTags(event.currentTarget.open)}
              >
                <summary className="exif-raw-summary">
                  All Tags ({Object.keys(data.raw).length})
                </summary>
                <dl className="exif-grid exif-grid--compact">
                  {Object.entries(data.raw)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([key, val]) => (
                      <div className="exif-row" key={key}>
                        <dt className="exif-label">{key}</dt>
                        <dd className="exif-value">{val}</dd>
                      </div>
                    ))}
                </dl>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function formatDate(raw: string): string {
  // EXIF format: "YYYY:MM:DD HH:MM:SS"
  try {
    const normalized = raw.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
    const d = new Date(normalized);
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return raw;
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const formatted = size >= 100 ? size.toFixed(0) : size >= 10 ? size.toFixed(1) : size.toFixed(2);
  return `${formatted} ${units[unitIndex]}`;
}

function getFileExtension(path: string): string | null {
  const fileName = path.replace(/\\/g, '/').split('/').pop();
  const extension = fileName?.split('.').pop()?.trim();
  return extension ? extension.toUpperCase() : null;
}

function getFileName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}
