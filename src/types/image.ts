export interface ImageFile {
  id?: string;
  sessionId?: string;
  path: string;
  file_name: string;
  extension: string;
  size_bytes: number;
  modified_at: string | null;
  created_at?: string | null;
}

export interface ImageMetadata {
  width: number | null;
  height: number | null;
  file_size_bytes: number;
  format: string;
  codec_backend?: 'rust_image' | 'windows_native' | 'browser_renderable' | 'unsupported' | string;
  native_decode_supported?: boolean;
  detail_backend?: 'rust_image' | 'windows_native' | 'browser_renderable' | 'unsupported' | string;
  detail_supported?: boolean;
  browser_renderable?: boolean;
  rust_decode_supported?: boolean;
  metadata_supported?: boolean;
  thumbnail_supported?: boolean;
  support_note?: string | null;
}
