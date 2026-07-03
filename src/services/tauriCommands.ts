import { convertFileSrc as tauriConvertFileSrc, invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
  availableMonitors,
  currentMonitor,
  PhysicalPosition,
  PhysicalSize,
  type Monitor,
} from '@tauri-apps/api/window';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import type { ImageFile, ImageMetadata } from '../types/image';
import type { ImageCuration } from '../types/curation';
import type { AppSettings } from '../types/settings';
import { settingsFromRust, settingsToRust } from '../types/settings';
import { projectorWindowTitle } from './windowTitle';

export interface ExifData {
  make?: string;
  model?: string;
  software?: string;
  date_time?: string;
  f_number?: number;
  exposure_time?: string;
  iso?: number;
  focal_length?: string;
  raw: Record<string, string>;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GeneratedImageAsset {
  file_path: string;
  cache_key: string;
  width?: number | null;
  height?: number | null;
  file_size_bytes?: number | null;
}

interface GeneratedCacheBucket {
  scope: string;
  path: string;
  fileCount: number;
  sizeBytes: number;
}

interface GeneratedCacheSummary {
  buckets: GeneratedCacheBucket[];
  totalFileCount: number;
  totalSizeBytes: number;
  rawNativeFailureCount: number;
}

interface GeneratedAssetRuntimeStats {
  nativePreviewTiming: GeneratedAssetRuntimeTiming;
  rustPreviewTiming: GeneratedAssetRuntimeTiming;
  placeholderPreviewTiming: GeneratedAssetRuntimeTiming;
  nativeTileTiming: GeneratedAssetRuntimeTiming;
  rustTileTiming: GeneratedAssetRuntimeTiming;
  thumbnailCacheHits: number;
  previewCacheHits: number;
  tileCacheHits: number;
  nativeThumbnailGenerations: number;
  nativePreviewGenerations: number;
  rustThumbnailGenerations: number;
  rustPreviewGenerations: number;
  placeholderThumbnailGenerations: number;
  placeholderPreviewGenerations: number;
  tileGenerations: number;
}

interface GeneratedAssetRuntimeTiming {
  sampleCount: number;
  totalMs: number;
  maxMs: number;
}

interface CodecHealthEntry {
  label: string;
  extensions: string[];
  metadataBackend: string;
  thumbnailBackend: string;
  detailBackend: string;
  nativeDecoderAvailable: boolean | null;
  nativeDecoderNames: string[];
  nativeSupportedExtensions: string[];
  nativeMissingExtensions: string[];
  nativeError?: string | null;
  status: string;
  note: string;
}

export interface CodecHealthReport {
  platform: string;
  entries: CodecHealthEntry[];
  generatedCache: GeneratedCacheSummary;
  runtimeStats: GeneratedAssetRuntimeStats;
}

export type GeneratedCacheCommandScope = 'all' | 'thumbnails' | 'previews' | 'tiles';

export interface ImageCurationUpdate {
  filePath: string;
  favorite: boolean;
  rating: number;
}

interface ImageTransferSuccess {
  sourcePath: string;
  targetPath: string;
}

interface ImageTransferFailure {
  sourcePath: string;
  error: string;
}

interface ImageTransferResult {
  successes: ImageTransferSuccess[];
  failures: ImageTransferFailure[];
}

export type FolderWatcherChangeKind = 'added' | 'removed' | 'modified' | 'renamed';

export interface FolderWatcherChange {
  kind: FolderWatcherChangeKind;
  path: string;
  oldPath?: string | null;
  image?: ImageFile | null;
}

export interface FolderWatcherPayload {
  folderPath: string;
  changes: FolderWatcherChange[];
  requiresFullRefresh: boolean;
}

const FOLDER_WATCHER_EVENT = 'folder-watcher-changed';

/** Check if a path is a directory */
export async function isDirectory(path: string): Promise<boolean> {
  return invoke<boolean>('is_dir', { path });
}

/** Watch a folder and emit debounced change payloads */
export async function watchFolder(folderPath: string, watchId: string): Promise<void> {
  return invoke('watch_folder', { folderPath, watchId });
}

/** Stop watching the active folder */
export async function unwatchFolder(watchId?: string): Promise<void> {
  return invoke('unwatch_folder', { watchId });
}

/** Listen for debounced active-folder watcher updates */
export async function listenToFolderWatcherChanges(
  onChange: (payload: FolderWatcherPayload) => void
): Promise<UnlistenFn> {
  return listen<FolderWatcherPayload>(FOLDER_WATCHER_EVENT, (event) => onChange(event.payload));
}

/** Scan a folder for supported image files, returned in natural sort order */
export async function scanFolder(folderPath: string): Promise<ImageFile[]> {
  return invoke<ImageFile[]>('scan_folder', { folderPath });
}

/** Read cached folder contents from the persistent folder index */
export async function readFolderIndex(folderPath: string): Promise<ImageFile[]> {
  return invoke<ImageFile[]>('read_folder_index', { folderPath });
}

/** Refresh a folder from disk and update the persistent folder index */
export async function refreshFolderIndex(folderPath: string): Promise<ImageFile[]> {
  return invoke<ImageFile[]>('refresh_folder_index', { folderPath });
}

/** Get metadata (dimensions, format, file size) for an image */
export async function getImageMetadata(filePath: string): Promise<ImageMetadata> {
  return invoke<ImageMetadata>('get_image_metadata', { filePath });
}

/** Read codec and generated-cache diagnostics */
export async function getCodecHealth(): Promise<CodecHealthReport> {
  return invoke<CodecHealthReport>('get_codec_health');
}

/** Clear generated preview/thumbnail/tile cache files */
export async function clearGeneratedImageCache(
  scope: GeneratedCacheCommandScope
): Promise<GeneratedCacheSummary> {
  return invoke<GeneratedCacheSummary>('clear_generated_image_cache', { scope });
}

/** Clear native decode negative cache so codecs are retried */
export async function retryNativeCodecs(): Promise<number> {
  return invoke<number>('retry_native_codecs');
}

/** Generate a downscaled preview image and return a cached file-backed asset */
export async function getPreviewImage(
  filePath: string,
  maxDimension: number,
  invalidationBust?: number
): Promise<GeneratedImageAsset> {
  return invoke<GeneratedImageAsset>('get_preview_image', {
    filePath,
    maxDimension,
    invalidationBust,
  });
}

/** Generate a cached native-resolution viewport tile for a large image */
export async function getImageTile(
  filePath: string,
  sourceWidth: number,
  sourceHeight: number,
  tileSize: number,
  tileX: number,
  tileY: number
): Promise<GeneratedImageAsset> {
  return invoke<GeneratedImageAsset>('get_image_tile', {
    filePath,
    sourceWidth,
    sourceHeight,
    tileSize,
    tileX,
    tileY,
  });
}

/** Read persisted application settings */
export async function readSettings(): Promise<AppSettings> {
  const raw = await invoke<Record<string, unknown>>('read_settings');
  return settingsFromRust(raw);
}

/** Write application settings to disk */
export async function writeSettings(settings: AppSettings): Promise<void> {
  return invoke('write_settings', { settings: settingsToRust(settings) });
}

/** Save a diagnostics snapshot JSON file */
export async function saveDiagnosticsSnapshot(path: string, content: string): Promise<void> {
  return invoke('save_diagnostics_snapshot', { path, content });
}

/** Read persisted curation metadata (favorite + rating) for scanned images */
export async function readCurationMetadata(): Promise<Record<string, ImageCuration>> {
  return invoke<Record<string, ImageCuration>>('read_curation_metadata');
}

/** Write favorite/rating metadata for a single image path */
export async function writeImageCuration(
  filePath: string,
  favorite: boolean,
  rating: number
): Promise<void> {
  return invoke('write_image_curation', { filePath, favorite, rating });
}

/** Write favorite/rating metadata for multiple image paths in one backend pass */
export async function writeImageCurationBatch(updates: ImageCurationUpdate[]): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  return invoke('write_image_curation_batch', { updates });
}

/** Remove curation metadata for a single image path */
export async function clearImageCuration(filePath: string): Promise<void> {
  return invoke('clear_image_curation', { filePath });
}

/** Move a file to the OS trash / recycle bin */
export async function moveToTrash(filePath: string): Promise<void> {
  return invoke('move_to_trash', { filePath });
}

/** Copy or move multiple image files into a destination folder in one backend task */
export async function transferImagesToFolder(
  filePaths: string[],
  destinationFolder: string,
  mode: 'copy' | 'move'
): Promise<ImageTransferResult> {
  return invoke<ImageTransferResult>('transfer_images_to_folder', {
    filePaths,
    destinationFolder,
    mode,
  });
}

/** Copy an image file to the OS clipboard */
export async function copyImageToClipboard(filePath: string): Promise<void> {
  return invoke('copy_image_to_clipboard', { filePath });
}

/** Extract EXIF metadata from an image file */
export async function getExifMetadata(filePath: string): Promise<ExifData> {
  return invoke<ExifData>('get_exif_metadata', { filePath });
}

/** Rotate an image file on disk and save it */
export async function saveRotatedImage(filePath: string, rotationDegrees: number): Promise<void> {
  return invoke('save_rotated_image', { filePath, rotationDegrees });
}

/** Save a cropped copy of an image without overwriting the original */
export async function saveCroppedCopy(
  filePath: string,
  cropRect: CropRect,
  outputPath: string,
  rotationDegrees?: number
): Promise<void> {
  return invoke('save_cropped_copy', { filePath, cropRect, outputPath, rotationDegrees });
}

/** Save a high-quality scaled copy of an image without overwriting the original */
export async function saveScaledCopy(
  filePath: string,
  outputPath: string,
  width: number,
  height: number,
  smoothing: number,
  sharpening: number
): Promise<void> {
  return invoke('save_scaled_copy', {
    filePath,
    outputPath,
    width,
    height,
    smoothing,
    sharpening,
  });
}

/** Overwrite an image with a cropped version after explicit confirmation */
export async function overwriteWithCrop(
  filePath: string,
  cropRect: CropRect,
  rotationDegrees?: number
): Promise<void> {
  return invoke('overwrite_with_crop', { filePath, cropRect, rotationDegrees });
}

/** Get a small cached thumbnail asset for an image */
export async function getThumbnail(
  filePath: string,
  sizeBytes?: number,
  modifiedAt?: string
): Promise<GeneratedImageAsset> {
  return invoke<GeneratedImageAsset>('get_thumbnail', { filePath, sizeBytes, modifiedAt });
}

/** Reveal a file in the OS file manager (Windows Explorer, Finder, etc.) */
export async function revealInExplorer(filePath: string): Promise<void> {
  return revealItemInDir(filePath);
}

/** Open a file path in a specific external application */
export async function openInExternalApplication(
  filePath: string,
  applicationPath: string
): Promise<void> {
  return invoke('open_in_external_application', { filePath, applicationPath });
}

function isSameMonitor(a: Monitor | null, b: Monitor): boolean {
  return (
    a?.name === b.name &&
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.size.width === b.size.width &&
    a.size.height === b.size.height
  );
}

async function getProjectorMonitor(): Promise<Monitor | null> {
  const monitors = await availableMonitors();
  if (monitors.length === 0) {
    return null;
  }

  if (monitors.length === 1) {
    return monitors[0] ?? null;
  }

  const activeMonitor = await currentMonitor();
  return monitors.find((monitor) => !isSameMonitor(activeMonitor, monitor)) ?? monitors[0] ?? null;
}

async function positionProjectorWindow(webview: WebviewWindow): Promise<void> {
  const monitor = await getProjectorMonitor();
  if (monitor) {
    await webview.setPosition(new PhysicalPosition(monitor.position.x, monitor.position.y));
    await webview.setSize(new PhysicalSize(monitor.size.width, monitor.size.height));
  }

  await webview.show();
  await webview.setFocus();
  await webview.setFullscreen(true);
}

function waitForProjectorCreation(webview: WebviewWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    void webview.once('tauri://created', () => resolve());
    void webview.once('tauri://error', (event) => {
      reject(event.payload instanceof Error ? event.payload : new Error(String(event.payload)));
    });
  });
}

/** Open a secondary window for Projector Mode */
export async function openSecondaryWindow(): Promise<void> {
  const label = 'secondary';
  try {
    const existingWebview = await WebviewWindow.getByLabel(label);
    if (existingWebview) {
      await positionProjectorWindow(existingWebview);
      return;
    }

    const webview = new WebviewWindow(label, {
      title: projectorWindowTitle(),
      width: 800,
      height: 600,
      visible: false,
      focus: true,
    });

    await waitForProjectorCreation(webview);
    await positionProjectorWindow(webview);
  } catch (err) {
    console.error('Secondary window error:', err);
    throw err;
  }
}

export async function isSecondaryWindowOpen(): Promise<boolean> {
  return (await WebviewWindow.getByLabel('secondary')) !== null;
}

export async function closeSecondaryWindow(): Promise<void> {
  const webview = await WebviewWindow.getByLabel('secondary');
  if (!webview) {
    return;
  }

  try {
    await webview.setFullscreen(false);
  } catch (err) {
    console.warn('Failed to exit fullscreen before closing projector window:', err);
  }

  await webview.close();
}

export type StateSyncSource = 'main' | 'secondary';

/** Emit a sync event to update another window */
export async function emitStateSync(
  imagePath: string | null,
  source: StateSyncSource
): Promise<void> {
  return emit('state-sync', { imagePath, source });
}

/** Ask the main window to send its current state */
export async function requestStateSync(): Promise<void> {
  return emit('state-sync-request');
}

/** Open Windows Default Apps settings */
export async function openSettings(): Promise<void> {
  // On Windows, ms-settings:defaultapps is the most reliable way to let users change defaults
  return openUrl('ms-settings:defaultapps');
}

/** Open a URL in the system's default browser */
export async function openUrlExternal(url: string): Promise<void> {
  return openUrl(url);
}

/** Convert a local file path to a Tauri asset protocol URL */
export function convertFileSrc(path: string): string {
  return tauriConvertFileSrc(path);
}

/** Convert a generated cached image asset into a URL with a stable cache-busting token */
export function generatedImageAssetToUrl(asset: GeneratedImageAsset): string {
  const url = new URL(convertFileSrc(asset.file_path));
  url.searchParams.set('v', asset.cache_key);
  return url.toString();
}

/** Extract the parent directory from a file path */
export function getParentFolder(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const uncRootMatch = normalized.match(/^\/\/[^/]+\/[^/]+(?=\/|$)/);
  if (uncRootMatch) {
    if (normalized === uncRootMatch[0]) {
      return filePath;
    }

    const remainder = normalized.slice(uncRootMatch[0].length);
    const remainderSlash = remainder.lastIndexOf('/');
    if (remainderSlash <= 0) {
      return filePath.slice(0, uncRootMatch[0].length);
    }

    return filePath.slice(0, uncRootMatch[0].length + remainderSlash);
  }

  if (/^[A-Za-z]:\/$/.test(normalized) || normalized === '/') {
    return filePath;
  }

  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash === -1) return '.';
  if (lastSlash === 0) return filePath.slice(0, 1);
  if (lastSlash === 2 && normalized[1] === ':') {
    return filePath.slice(0, 3);
  }
  return filePath.slice(0, lastSlash);
}

/** Get just the filename from a full path */
export function getFileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash === -1 ? filePath : filePath.substring(lastSlash + 1);
}
