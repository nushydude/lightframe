import { useState, useEffect } from 'react';
import { getExifMetadata, type ExifData } from '../services/tauriCommands';

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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setData(null);
    setError(null);

    getExifMetadata(filePath)
      .then(setData)
      .catch(() => setError('No EXIF data found in this image.'))
      .finally(() => setLoading(false));
  }, [filePath]);

  const primaryRows: ExifRow[] = data
    ? [
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
      ].filter(Boolean) as ExifRow[]
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
              <details className="exif-raw">
                <summary className="exif-raw-summary">All Tags ({Object.keys(data.raw).length})</summary>
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
