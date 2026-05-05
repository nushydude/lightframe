import { invoke } from '@tauri-apps/api/core';
import type { ImageFile, ImageMetadata } from '../types/image';
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

/** Read persisted application settings */
export async function readSettings(): Promise<AppSettings> {
  const raw = await invoke<Record<string, unknown>>('read_settings');
  return settingsFromRust(raw);
}

/** Write application settings to disk */
export async function writeSettings(settings: AppSettings): Promise<void> {
  return invoke('write_settings', { settings: settingsToRust(settings) });
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

import { revealItemInDir } from '@tauri-apps/plugin-opener';

/** Reveal a file in the OS file manager (Windows Explorer, Finder, etc.) */
export async function revealInExplorer(filePath: string): Promise<void> {
  return revealItemInDir(filePath);
}

import { convertFileSrc as tauriConvertFileSrc } from '@tauri-apps/api/core';

/** Convert a local file path to a Tauri asset protocol URL */
export async function convertFileSrc(path: string): Promise<string> {
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
