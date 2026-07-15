import { useEffect, useState, type RefObject } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { getFileName, getImageMetadata, saveScaledCopy } from '../services/tauriCommands';
import { useEditQueueStore } from '../state/editQueueStore';
import { useToastStore } from '../state/toastStore';
import { useViewerStore } from '../state/viewerStore';

const MAX_DIMENSION = 65_535;
const MAX_PIXELS = 50_000_000;
const MAX_MEGAPIXELS = MAX_PIXELS / 1_000_000;
const PREVIEW_DEBOUNCE_MS = 120;
const SOURCE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'tiff',
  'tif',
  'avif',
]);
const OUTPUT_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif']);
const SOURCE_MESSAGE = 'Scaled export supports JPEG, PNG, GIF, WebP, BMP, TIFF, and AVIF sources.';
const OUTPUT_MESSAGE = 'Scaled export can save JPEG, PNG, GIF, WebP, BMP, or TIFF files.';
const SAVE_FILTERS = [
  { name: 'JPEG image', extensions: ['jpg', 'jpeg'] },
  { name: 'PNG image', extensions: ['png'] },
  { name: 'WebP image', extensions: ['webp'] },
  { name: 'TIFF image', extensions: ['tif', 'tiff'] },
  { name: 'BMP image', extensions: ['bmp'] },
  { name: 'GIF image', extensions: ['gif'] },
];

interface PreparedScaledCopy {
  outputPath: string;
  width: number;
  height: number;
}

function parseDimension(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function validationMessage(width: number | null, height: number | null): string | null {
  if (width == null && height == null) return null;
  if (!width || !height) return 'Width and height must be greater than zero.';
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    return `Maximum side length is ${MAX_DIMENSION}px.`;
  }
  if (width * height > MAX_PIXELS) return `Maximum export size is ${MAX_MEGAPIXELS} MP.`;
  return null;
}

function pathExtension(path: string | null): string {
  const fileName = path ? getFileName(path) : '';
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex + 1).toLowerCase() : '';
}

function sourceBlockingMessage(path: string | null): string | null {
  const extension = pathExtension(path);
  return extension && !SOURCE_EXTENSIONS.has(extension) ? SOURCE_MESSAGE : null;
}

function activeCanvasDimensions(): { width: number; height: number } | null {
  const image = document.querySelector('.image-canvas img') as HTMLImageElement | null;
  const width = image?.naturalWidth ?? 0;
  const height = image?.naturalHeight ?? 0;
  return width > 0 && height > 0 ? { width, height } : null;
}

async function sourceDimensions(path: string): Promise<{ width: number; height: number } | null> {
  try {
    const metadata = await getImageMetadata(path);
    if (metadata?.width && metadata.height)
      return { width: metadata.width, height: metadata.height };
  } catch (error) {
    console.warn('Failed to read source dimensions for scaled export:', error);
  }
  return activeCanvasDimensions();
}

function defaultOutputPath(path: string, width: number, height: number): string {
  const originalName = getFileName(path);
  const dotIndex = originalName.lastIndexOf('.');
  const baseName = dotIndex >= 0 ? originalName.slice(0, dotIndex) : originalName;
  const originalExtension = pathExtension(path);
  const extension = OUTPUT_EXTENSIONS.has(originalExtension) ? `.${originalExtension}` : '.jpg';
  return path.replace(originalName, `${baseName}-scaled-${width}x${height}${extension}`);
}

function previewFilter(smoothing: number, sharpening: number): string | undefined {
  const filters: string[] = [];
  if (smoothing > 0) filters.push(`blur(${(smoothing / 100) * 1.25}px)`);
  if (sharpening > 0) {
    filters.push(
      `contrast(${1 + (sharpening / 100) * 0.35}) saturate(${1 + (sharpening / 100) * 0.12})`
    );
  }
  return filters.length > 0 ? filters.join(' ') : undefined;
}

function QualityPreview({
  currentImagePath,
  smoothing,
  sharpening,
}: {
  currentImagePath: string | null;
  smoothing: number;
  sharpening: number;
}) {
  const [source, setSource] = useState('');
  const [previewSmoothing, setPreviewSmoothing] = useState(smoothing);
  const [previewSharpening, setPreviewSharpening] = useState(sharpening);

  useEffect(() => {
    const image = document.querySelector('.image-canvas img') as HTMLImageElement | null;
    const refreshSource = () => {
      const currentImage = document.querySelector('.image-canvas img') as HTMLImageElement | null;
      setSource(currentImage?.currentSrc || currentImage?.src || '');
    };
    refreshSource();
    image?.addEventListener('load', refreshSource);
    const timer = window.setTimeout(refreshSource, 0);
    return () => {
      image?.removeEventListener('load', refreshSource);
      window.clearTimeout(timer);
    };
  }, [currentImagePath]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPreviewSmoothing(smoothing);
      setPreviewSharpening(sharpening);
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [sharpening, smoothing]);

  if (!source) return null;
  const filter = previewFilter(previewSmoothing, previewSharpening);
  return (
    <div
      className="quality-preview"
      role="img"
      aria-label="Approximate scaled export preview sample"
    >
      <img src={source} alt="" draggable={false} style={filter ? { filter } : undefined} />
    </div>
  );
}

export function QualityExportMenu({
  currentImagePath,
  onQueueOpened,
  menuRef,
}: {
  currentImagePath: string | null;
  onQueueOpened: () => void;
  menuRef: RefObject<HTMLDetailsElement | null>;
}) {
  const smoothing = useViewerStore((state) => state.imageSmoothing);
  const sharpening = useViewerStore((state) => state.imageSharpening);
  const setSmoothing = useViewerStore((state) => state.setImageSmoothing);
  const setSharpening = useViewerStore((state) => state.setImageSharpening);
  const resetAdjustments = useViewerStore((state) => state.resetImageAdjustments);
  const enqueueEditJob = useEditQueueStore((state) => state.enqueueJob);
  const pushToast = useToastStore((state) => state.pushToast);
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    setWidth('');
    setHeight('');
    setAspectRatio(null);
  }, [currentImagePath]);

  const syncDimensions = async () => {
    if (!currentImagePath) return null;
    const dimensions = await sourceDimensions(currentImagePath);
    if (!dimensions) return null;
    setAspectRatio(dimensions.width / dimensions.height);
    setWidth(String(dimensions.width));
    setHeight(String(dimensions.height));
    return dimensions;
  };

  const updateWidth = (value: string) => {
    setWidth(value);
    const parsed = parseDimension(value);
    const fallback = activeCanvasDimensions();
    const ratio = aspectRatio ?? (fallback ? fallback.width / fallback.height : null);
    if (parsed && ratio) {
      setAspectRatio(ratio);
      setHeight(String(Math.max(1, Math.round(parsed / ratio))));
    }
  };

  const updateHeight = (value: string) => {
    setHeight(value);
    const parsed = parseDimension(value);
    const fallback = activeCanvasDimensions();
    const ratio = aspectRatio ?? (fallback ? fallback.width / fallback.height : null);
    if (parsed && ratio) {
      setAspectRatio(ratio);
      setWidth(String(Math.max(1, Math.round(parsed * ratio))));
    }
  };

  const prepareCopy = async (): Promise<PreparedScaledCopy | null> => {
    if (!currentImagePath) return null;
    if (sourceBlockingMessage(currentImagePath)) {
      pushToast({ title: 'Scale Copy', kind: 'error', message: SOURCE_MESSAGE });
      return null;
    }

    const fallback = await sourceDimensions(currentImagePath);
    const parsedWidth = parseDimension(width) ?? fallback?.width ?? null;
    const parsedHeight = parseDimension(height) ?? fallback?.height ?? null;
    const error = validationMessage(parsedWidth, parsedHeight);
    if (error) {
      pushToast({ title: 'Scale Copy', kind: 'error', message: error });
      return null;
    }
    if (!parsedWidth || !parsedHeight) {
      pushToast({
        title: 'Scale Copy',
        kind: 'error',
        message: 'Unable to determine dimensions for scaled export.',
      });
      return null;
    }

    const outputPath = await save({
      filters: SAVE_FILTERS,
      defaultPath: defaultOutputPath(currentImagePath, parsedWidth, parsedHeight),
    });
    if (!outputPath) return null;
    if (!OUTPUT_EXTENSIONS.has(pathExtension(outputPath))) {
      pushToast({ title: 'Scale Copy', kind: 'error', message: OUTPUT_MESSAGE });
      return null;
    }
    return { outputPath, width: parsedWidth, height: parsedHeight };
  };

  const queueCopy = async () => {
    const prepared = await prepareCopy();
    if (!prepared || !currentImagePath) return;
    const result = enqueueEditJob({
      kind: 'scaled-copy',
      sourcePath: currentImagePath,
      outputPath: prepared.outputPath,
      width: prepared.width,
      height: prepared.height,
      smoothing,
      sharpening,
    });
    if (!result.ok) {
      pushToast({ title: 'Editing Queue', kind: 'error', message: result.error });
      return;
    }
    onQueueOpened();
  };

  const saveCopy = async () => {
    const prepared = await prepareCopy();
    if (!prepared || !currentImagePath) return;
    try {
      await saveScaledCopy(
        currentImagePath,
        prepared.outputPath,
        prepared.width,
        prepared.height,
        smoothing,
        sharpening
      );
      pushToast({
        title: 'Scaled Copy Saved',
        kind: 'success',
        message: `Saved scaled copy to ${prepared.outputPath}`,
      });
    } catch (error) {
      console.error('Failed to save scaled copy:', error);
      pushToast({
        title: 'Scaled Copy Failed',
        kind: 'error',
        message: `Failed to save scaled copy: ${error}`,
      });
    }
  };

  const blockingMessage =
    sourceBlockingMessage(currentImagePath) ??
    validationMessage(parseDimension(width), parseDimension(height));

  return (
    <details
      ref={menuRef}
      className="quality-menu"
      onToggle={(event) => {
        const open = event.currentTarget.open;
        setIsOpen(open);
        if (open && (!width || !height)) void syncDimensions();
      }}
    >
      <summary
        className={`control-btn control-btn--text has-tooltip ${smoothing > 0 || sharpening > 0 ? 'active' : ''}`}
        onClick={(event) => {
          const details = event.currentTarget.parentElement as HTMLDetailsElement | null;
          setIsOpen(!details?.open);
        }}
        data-tooltip="Scaled export quality"
        title="Scaled export quality"
        aria-label="Scaled export quality"
        id="btn-quality-panel"
      >
        HQ
      </summary>
      <div className="quality-panel">
        {isOpen && (
          <QualityPreview
            currentImagePath={currentImagePath}
            smoothing={smoothing}
            sharpening={sharpening}
          />
        )}
        <label className="quality-field">
          <span>Export smooth</span>
          <input
            type="range"
            min="0"
            max="100"
            value={smoothing}
            onChange={(event) => setSmoothing(Number(event.target.value))}
            aria-label="Export smoothing"
          />
        </label>
        <label className="quality-field">
          <span>Export sharpen</span>
          <input
            type="range"
            min="0"
            max="100"
            value={sharpening}
            onChange={(event) => setSharpening(Number(event.target.value))}
            aria-label="Export sharpening"
          />
        </label>
        <div className="quality-dimensions">
          <label className="quality-number-field">
            <span>W</span>
            <input
              type="number"
              min="1"
              max={MAX_DIMENSION}
              value={width}
              onChange={(event) => updateWidth(event.target.value)}
              aria-label="Scaled copy width"
            />
          </label>
          <label className="quality-number-field">
            <span>H</span>
            <input
              type="number"
              min="1"
              max={MAX_DIMENSION}
              value={height}
              onChange={(event) => updateHeight(event.target.value)}
              aria-label="Scaled copy height"
            />
          </label>
        </div>
        <div className={`quality-limit ${blockingMessage ? 'warning' : ''}`} aria-live="polite">
          {blockingMessage ?? `Maximum export size is ${MAX_MEGAPIXELS} MP.`}
        </div>
        <div className="quality-actions">
          <button
            className="setting-button-secondary"
            type="button"
            onClick={() => void syncDimensions()}
          >
            1:1
          </button>
          <button className="setting-button-secondary" type="button" onClick={resetAdjustments}>
            Reset
          </button>
          <button
            className="setting-button-secondary"
            type="button"
            onClick={() => void queueCopy()}
            disabled={Boolean(blockingMessage)}
          >
            Queue
          </button>
          <button
            className="setting-button-primary"
            type="button"
            onClick={() => void saveCopy()}
            disabled={Boolean(blockingMessage)}
          >
            Save
          </button>
        </div>
      </div>
    </details>
  );
}
