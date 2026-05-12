import { convertFileSrc as tauriConvertFileSrc, invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
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

/** Check if a path is a directory */
export async function isDirectory(path: string): Promise<boolean> {
  return invoke<boolean>('is_dir', { path });
}

/** Scan a folder for supported image files, returned in natural sort order */
export async function scanFolder(folderPath: string): Promise<ImageFile[]> {
  return invoke<ImageFile[]>('scan_folder', { folderPath });
}

/** Get metadata (dimensions, format, file size) for an image */
export async function getImageMetadata(filePath: string): Promise<ImageMetadata> {
  return invoke<ImageMetadata>('get_image_metadata', { filePath });
}

/** Generate a downscaled preview image and return it as a data URL */
export async function getPreviewImage(filePath: string, maxDimension: number): Promise<string> {
  return invoke<string>('get_preview_image', { filePath, maxDimension });
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

/** Remove curation metadata for a single image path */
export async function clearImageCuration(filePath: string): Promise<void> {
  return invoke('clear_image_curation', { filePath });
}

/** Move a file to the OS trash / recycle bin */
export async function moveToTrash(filePath: string): Promise<void> {
  return invoke('move_to_trash', { filePath });
}

/** Copy an image file into a destination folder */
export async function copyImageToFolder(
  filePath: string,
  destinationFolder: string
): Promise<string> {
  return invoke<string>('copy_image_to_folder', { filePath, destinationFolder });
}

/** Move an image file into a destination folder */
export async function moveImageToFolder(
  filePath: string,
  destinationFolder: string
): Promise<string> {
  return invoke<string>('move_image_to_folder', { filePath, destinationFolder });
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

/** Overwrite an image with a cropped version after explicit confirmation */
export async function overwriteWithCrop(
  filePath: string,
  cropRect: CropRect,
  rotationDegrees?: number
): Promise<void> {
  return invoke('overwrite_with_crop', { filePath, cropRect, rotationDegrees });
}

/** Get a small base64 thumbnail for an image */
export async function getThumbnail(
  filePath: string,
  sizeBytes?: number,
  modifiedAt?: string
): Promise<string> {
  return invoke<string>('get_thumbnail', { filePath, sizeBytes, modifiedAt });
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
      title: 'LightFrame - Projector',
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

/** Emit a sync event to update secondary windows */
export async function emitStateSync(imagePath: string | null): Promise<void> {
  return emit('state-sync', { imagePath });
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

/** Extract the parent directory from a file path */
export function getParentFolder(filePath: string): string {
  // Handle both forward and backslash separators
  const normalized = filePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash === -1) return '.';
  return filePath.substring(0, lastSlash);
}

/** Get just the filename from a full path */
export function getFileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash === -1 ? filePath : filePath.substring(lastSlash + 1);
}
