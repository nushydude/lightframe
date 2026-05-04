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
}
