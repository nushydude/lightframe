import { invoke } from '@tauri-apps/api/core';
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

import { revealItemInDir, openUrl } from '@tauri-apps/plugin-opener';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emit } from '@tauri-apps/api/event';

/** Reveal a file in the OS file manager (Windows Explorer, Finder, etc.) */
export async function revealInExplorer(filePath: string): Promise<void> {
  return revealItemInDir(filePath);
}

/** Open a secondary window for Presentation Mode */
export async function openSecondaryWindow(): Promise<void> {
  const label = 'secondary';
  try {
    const webview = new WebviewWindow(label, {
      title: 'LightFrame — Projector',
      width: 800,
      height: 600,
      visible: true,
      center: true,
    });

    void webview.once('tauri://created', () => {});

    void webview.once('tauri://error', (e) => {
      console.error('Failed to create secondary window:', e);
    });
  } catch (err) {
    console.error('Secondary window error:', err);
  }
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

import { convertFileSrc as tauriConvertFileSrc } from '@tauri-apps/api/core';

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
