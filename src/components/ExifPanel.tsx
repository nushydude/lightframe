import { useEffect, useRef, useState } from 'react';
import { getExifMetadata, getImageMetadata, type ExifData } from '../services/tauriCommands';
import type { ImageMetadata } from '../types/image';

interface ExifPanelProps {
  filePath: string;
  onClose: () => void;
}

interface ExifRow {
  label: string;
  value: string;
}

function formatFNumber(f: number): string {
  return `f/${f % 1 === 0 ? f.toFixed(0) : f.toFixed(1)}`;
}

export function ExifPanel({ filePath, onClose }: ExifPanelProps) {
  const [data, setData] = useState<ExifData | null>(null);
  const [imageMetadata, setImageMetadata] = useState<ImageMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAllTags, setShowAllTags] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setLoading(true);
    setData(null);
    setImageMetadata(null);
    setError(null);

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
        }
      });
  }, [filePath]);

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
      ].filter(Boolean) as ExifRow[])
    : [];

  return (
    <div className="exif-panel" role="complementary" aria-label="Image metadata">
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
        {loading && (
          <div className="exif-loading">
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

        {!loading && data && (
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
