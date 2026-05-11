export interface ImageFile {
  path: string;
  file_name: string;
  extension: string;
  size_bytes: number;
  modified_at: string | null;
}

export interface ImageMetadata {
  width: number | null;
  height: number | null;
  file_size_bytes: number;
  format: string;
  browser_renderable?: boolean;
  rust_decode_supported?: boolean;
  metadata_supported?: boolean;
  thumbnail_supported?: boolean;
  support_note?: string | null;
}
