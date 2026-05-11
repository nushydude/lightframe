use base64::Engine;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::UNIX_EPOCH;

const THUMBNAIL_SIZE: u32 = 160;
const CACHE_VERSION: &str = "v1";
const MAX_CACHE_ENTRIES: usize = 2_000;
const MAX_CACHE_BYTES: u64 = 256 * 1024 * 1024;
const CLEANUP_INTERVAL: usize = 32;
const FALLBACK_PLACEHOLDER_MIME_TYPE: &str = "image/svg+xml";

static THUMBNAIL_REQUEST_COUNT: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatSupport {
    pub browser_renderable: bool,
    pub rust_decode_supported: bool,
    pub metadata_supported: bool,
    pub thumbnail_supported: bool,
    pub support_note: Option<&'static str>,
}

#[derive(Debug, Clone)]
pub struct SourceMetadata {
    pub size_bytes: u64,
    pub modified_seconds: u64,
}

pub fn resolve_source_metadata(
    file_path: &Path,
    size_bytes: Option<u64>,
    modified_at: Option<&str>,
) -> Result<SourceMetadata, String> {
    if let Ok(metadata) = fs::metadata(file_path) {
        let computed_size = metadata.len();
        let computed_modified = metadata
            .modified()
            .ok()
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        return Ok(SourceMetadata {
            size_bytes: computed_size,
            modified_seconds: computed_modified,
        });
    }

    let parsed_modified = modified_at.and_then(parse_modified_seconds);

    if let (Some(size_bytes), Some(modified_seconds)) = (size_bytes, parsed_modified) {
        return Ok(SourceMetadata { size_bytes, modified_seconds });
    }

    Err("Failed to read source metadata and no usable metadata was provided".to_string())
}

pub fn build_cache_key(file_path: &Path, metadata: &SourceMetadata) -> String {
    let normalized = normalize_path_for_key(file_path);
    format!(
        "{}|{}|{}|{}",
        CACHE_VERSION, normalized, metadata.modified_seconds, metadata.size_bytes
    )
}

pub fn hash_cache_key(cache_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(cache_key.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn format_support_for_path(file_path: &Path) -> FormatSupport {
    match normalized_extension(file_path).as_deref() {
        Some("heic") => FormatSupport {
            browser_renderable: true,
            rust_decode_supported: false,
            metadata_supported: true,
            thumbnail_supported: true,
            support_note: Some(
                "HEIC files use a labeled placeholder thumbnail because LightFrame cannot decode HEIC thumbnails directly.",
            ),
        },
        Some("heif") => FormatSupport {
            browser_renderable: true,
            rust_decode_supported: false,
            metadata_supported: true,
            thumbnail_supported: true,
            support_note: Some(
                "HEIF files use a labeled placeholder thumbnail because LightFrame cannot decode HEIF thumbnails directly.",
            ),
        },
        Some("svg") => FormatSupport {
            browser_renderable: true,
            rust_decode_supported: false,
            metadata_supported: true,
            thumbnail_supported: true,
            support_note: Some(
                "SVG files use a labeled placeholder thumbnail because LightFrame does not rasterize SVG thumbnails in Rust yet.",
            ),
        },
        Some("avif") => FormatSupport {
            browser_renderable: true,
            rust_decode_supported: true,
            metadata_supported: true,
            thumbnail_supported: true,
            support_note: Some(
                "AVIF thumbnails fall back to a labeled placeholder when decoding fails.",
            ),
        },
        _ => FormatSupport {
            browser_renderable: true,
            rust_decode_supported: true,
            metadata_supported: true,
            thumbnail_supported: true,
            support_note: None,
        },
    }
}

pub fn get_or_create_thumbnail(
    file_path: &Path,
    metadata: &SourceMetadata,
    cache_root: &Path,
) -> Result<String, String> {
    let cache_available = match fs::create_dir_all(cache_root) {
        Ok(_) => {
            maybe_cleanup_cache(cache_root);
            true
        }
        Err(error) => {
            eprintln!(
                "Warning: thumbnail cache unavailable at '{}': {}",
                cache_root.display(),
                error
            );
            false
        }
    };

    let cache_key = build_cache_key(file_path, metadata);
    let cache_file = cache_root.join(format!("{}.jpg", hash_cache_key(&cache_key)));

    if cache_available {
        if let Ok(bytes) = fs::read(&cache_file) {
            return Ok(jpeg_data_url(&bytes));
        }
    }

    match generate_thumbnail_jpeg(file_path) {
        Ok(jpeg_bytes) => {
            if cache_available {
                if let Err(error) = write_cache_file(&cache_file, &jpeg_bytes) {
                    eprintln!(
                        "Warning: failed to write thumbnail cache file '{}': {}",
                        cache_file.display(),
                        error
                    );
                }
            }

            Ok(jpeg_data_url(&jpeg_bytes))
        }
        Err(error) => {
            if let Some(placeholder_data_url) = known_fallback_thumbnail_data_url(file_path, &error)
            {
                return Ok(placeholder_data_url);
            }

            Err(format!("Failed to generate thumbnail: {}", error))
        }
    }
}

fn normalize_path_for_key(path: &Path) -> String {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map(|cwd| cwd.join(path)).unwrap_or_else(|_| path.to_path_buf())
    };

    let canonical = fs::canonicalize(&absolute).unwrap_or(absolute);
    let normalized = canonical.to_string_lossy().replace('\\', "/");

    #[cfg(windows)]
    {
        normalized.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        normalized
    }
}

fn generate_thumbnail_jpeg(file_path: &Path) -> Result<Vec<u8>, image::ImageError> {
    let img = image::open(file_path)?;
    let thumb = img.thumbnail(THUMBNAIL_SIZE, THUMBNAIL_SIZE);

    let mut buffer = std::io::Cursor::new(Vec::new());
    thumb.write_to(&mut buffer, image::ImageFormat::Jpeg)?;
    Ok(buffer.into_inner())
}

fn jpeg_data_url(bytes: &[u8]) -> String {
    let base64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:image/jpeg;base64,{}", base64)
}

fn known_fallback_thumbnail_data_url(
    file_path: &Path,
    error: &image::ImageError,
) -> Option<String> {
    if matches!(error, image::ImageError::IoError(_)) {
        return None;
    }

    let extension = normalized_extension(file_path)?;
    if !matches!(extension.as_str(), "heic" | "heif" | "avif" | "svg") {
        return None;
    }

    Some(placeholder_thumbnail_data_url(&extension))
}

fn normalized_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
}

fn placeholder_thumbnail_data_url(extension: &str) -> String {
    let format_label = match extension {
        "heic" => "HEIC",
        "heif" => "HEIF",
        "avif" => "AVIF",
        "svg" => "SVG",
        _ => "IMAGE",
    };

    let canvas_size = THUMBNAIL_SIZE;
    let inner_size = THUMBNAIL_SIZE.saturating_sub(24);
    let svg = format!(
        concat!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{canvas}\" height=\"{canvas}\" ",
            "viewBox=\"0 0 {canvas} {canvas}\">",
            "<rect width=\"{canvas}\" height=\"{canvas}\" fill=\"#1f2933\"/>",
            "<rect x=\"12\" y=\"12\" width=\"{inner}\" height=\"{inner}\" rx=\"10\" fill=\"#2e3c4b\"/>",
            "<text x=\"50%\" y=\"47%\" fill=\"#e5edf5\" text-anchor=\"middle\" ",
            "font-family=\"Arial, sans-serif\" font-size=\"20\">{label}</text>",
            "<text x=\"50%\" y=\"66%\" fill=\"#9eb0c2\" text-anchor=\"middle\" ",
            "font-family=\"Arial, sans-serif\" font-size=\"11\">Preview unavailable</text>",
            "</svg>"
        ),
        canvas = canvas_size,
        inner = inner_size,
        label = format_label
    );

    let base64 = base64::engine::general_purpose::STANDARD.encode(svg.as_bytes());
    format!("data:{};base64,{}", FALLBACK_PLACEHOLDER_MIME_TYPE, base64)
}

fn parse_modified_seconds(value: &str) -> Option<u64> {
    value.parse::<u64>().ok()
}

fn maybe_cleanup_cache(cache_root: &Path) {
    let request_count = THUMBNAIL_REQUEST_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
    if !request_count.is_multiple_of(CLEANUP_INTERVAL) {
        return;
    }

    cleanup_cache_best_effort(cache_root);
}

fn write_cache_file(cache_file: &Path, jpeg_bytes: &[u8]) -> Result<(), std::io::Error> {
    let tmp_path = cache_file.with_extension("jpg.tmp");
    fs::write(&tmp_path, jpeg_bytes)?;
    fs::rename(&tmp_path, cache_file).or_else(|rename_error| {
        let _ = fs::remove_file(cache_file);
        fs::rename(&tmp_path, cache_file).map_err(|_| rename_error)
    })?;
    Ok(())
}

fn cleanup_cache_best_effort(cache_root: &Path) {
    if is_redirected_cache_root(cache_root) {
        return;
    }

    let root = match fs::canonicalize(cache_root) {
        Ok(path) => path,
        Err(_) => return,
    };

    let read_dir = match fs::read_dir(&root) {
        Ok(iter) => iter,
        Err(_) => return,
    };

    let mut entries: Vec<(PathBuf, std::time::SystemTime, u64)> = Vec::new();
    let mut total_bytes = 0_u64;

    for entry in read_dir.flatten() {
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        if !is_cache_thumbnail_filename(&file_name) {
            continue;
        }

        let entry_path = entry.path();
        let entry_metadata = match fs::symlink_metadata(&entry_path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if entry_metadata.file_type().is_symlink() || !entry_metadata.file_type().is_file() {
            continue;
        }

        let canonical = match fs::canonicalize(&entry_path) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if !canonical.starts_with(&root) {
            continue;
        }

        let metadata = match fs::metadata(&canonical) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size = metadata.len();
        total_bytes = total_bytes.saturating_add(size);
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        entries.push((canonical, modified, size));
    }

    if entries.len() <= MAX_CACHE_ENTRIES && total_bytes <= MAX_CACHE_BYTES {
        return;
    }

    entries.sort_by_key(|(_, modified, _)| *modified);
    let mut remaining_entries = entries.len();

    for (path, _, size) in entries {
        if total_bytes <= MAX_CACHE_BYTES && remaining_entries <= MAX_CACHE_ENTRIES {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total_bytes = total_bytes.saturating_sub(size);
            remaining_entries = remaining_entries.saturating_sub(1);
        }
    }
}

fn is_redirected_cache_root(cache_root: &Path) -> bool {
    let root_metadata = match fs::symlink_metadata(cache_root) {
        Ok(metadata) => metadata,
        Err(_) => return true,
    };
    let file_type = root_metadata.file_type();
    if file_type.is_symlink() {
        return true;
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if root_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }

    false
}

fn is_cache_thumbnail_filename(file_name: &str) -> bool {
    let Some(stem) = file_name.strip_suffix(".jpg") else {
        return false;
    };
    stem.len() == 64 && stem.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use tempfile::tempdir;

    fn cache_file_name_for_index(index: usize) -> String {
        format!("{index:064x}.jpg")
    }

    fn decode_data_url_payload(data_url: &str) -> Vec<u8> {
        let (_, payload) = data_url.split_once(',').unwrap();
        base64::engine::general_purpose::STANDARD.decode(payload).unwrap()
    }

    #[test]
    fn cache_key_is_stable_for_same_input() {
        let metadata = SourceMetadata { size_bytes: 42, modified_seconds: 123 };
        let path = Path::new("C:/images/photo.jpg");
        let key_a = build_cache_key(path, &metadata);
        let key_b = build_cache_key(path, &metadata);
        assert_eq!(key_a, key_b);
        assert_eq!(hash_cache_key(&key_a), hash_cache_key(&key_b));
    }

    #[test]
    fn cache_key_changes_when_metadata_changes() {
        let path = Path::new("C:/images/photo.jpg");
        let key_a =
            build_cache_key(path, &SourceMetadata { size_bytes: 42, modified_seconds: 123 });
        let key_b =
            build_cache_key(path, &SourceMetadata { size_bytes: 43, modified_seconds: 123 });
        let key_c =
            build_cache_key(path, &SourceMetadata { size_bytes: 42, modified_seconds: 124 });
        assert_ne!(key_a, key_b);
        assert_ne!(key_a, key_c);
    }

    #[test]
    fn thumbnail_requests_write_and_reuse_cache_file() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("sample.png");
        let cache_dir = dir.path().join("thumbs");

        let image = image::RgbaImage::from_fn(64, 64, |_, _| image::Rgba([255, 0, 0, 255]));
        image.save(&image_path).unwrap();

        let metadata = resolve_source_metadata(&image_path, None, None).unwrap();
        let first = get_or_create_thumbnail(&image_path, &metadata, &cache_dir).unwrap();
        let second = get_or_create_thumbnail(&image_path, &metadata, &cache_dir).unwrap();

        assert!(first.starts_with("data:image/jpeg;base64,"));
        assert!(second.starts_with("data:image/jpeg;base64,"));
        assert_eq!(first, second);

        let files: Vec<_> = fs::read_dir(&cache_dir).unwrap().flatten().collect();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path().extension().and_then(|ext| ext.to_str()), Some("jpg"));
    }

    #[test]
    fn provided_metadata_is_used_when_filesystem_metadata_is_unavailable() {
        let metadata =
            resolve_source_metadata(Path::new("missing-file.jpg"), Some(42), Some("123")).unwrap();

        assert_eq!(metadata.size_bytes, 42);
        assert_eq!(metadata.modified_seconds, 123);
    }

    #[test]
    fn thumbnail_generation_falls_back_when_cache_setup_fails() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("sample.png");
        let cache_root_file = dir.path().join("cache-root-is-file");
        let invalid_cache_dir = cache_root_file.join("thumbnails");

        let image = image::RgbaImage::from_fn(64, 64, |_, _| image::Rgba([0, 255, 0, 255]));
        image.save(&image_path).unwrap();
        fs::write(&cache_root_file, b"not-a-directory").unwrap();

        let metadata = resolve_source_metadata(&image_path, None, None).unwrap();
        let result = get_or_create_thumbnail(&image_path, &metadata, &invalid_cache_dir).unwrap();

        assert!(result.starts_with("data:image/jpeg;base64,"));
    }

    #[test]
    fn unsupported_formats_return_stable_placeholder_thumbnail_data_url() {
        let dir = tempdir().unwrap();
        let cache_dir = dir.path().join("thumbs");

        for (extension, expected_label) in
            [("heic", "HEIC"), ("heif", "HEIF"), ("avif", "AVIF"), ("svg", "SVG")]
        {
            let image_path = dir.path().join(format!("sample.{}", extension));
            fs::write(&image_path, b"not-a-decodable-image").unwrap();

            let metadata = resolve_source_metadata(&image_path, None, None).unwrap();
            let first = get_or_create_thumbnail(&image_path, &metadata, &cache_dir).unwrap();
            let second = get_or_create_thumbnail(&image_path, &metadata, &cache_dir).unwrap();

            assert!(first.starts_with("data:image/svg+xml;base64,"));
            assert_eq!(first, second);

            let decoded = String::from_utf8(decode_data_url_payload(&first)).unwrap();
            assert!(decoded.contains(&format!(">{}<", expected_label)));
        }

        let cached_jpg_files = fs::read_dir(&cache_dir)
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("jpg"))
            .count();
        assert_eq!(cached_jpg_files, 0);
    }

    #[test]
    fn fallback_formats_do_not_mask_io_errors() {
        let dir = tempdir().unwrap();
        let cache_dir = dir.path().join("thumbs");
        let missing = dir.path().join("missing.heic");
        let metadata = SourceMetadata { size_bytes: 1, modified_seconds: 1 };

        let error = get_or_create_thumbnail(&missing, &metadata, &cache_dir).unwrap_err();
        assert!(error.contains("Failed to generate thumbnail"));
    }

    #[test]
    fn supported_decode_formats_still_return_errors_when_corrupt() {
        let dir = tempdir().unwrap();
        let cache_dir = dir.path().join("thumbs");
        let broken_jpg = dir.path().join("broken.jpg");
        fs::write(&broken_jpg, b"not-a-real-jpeg").unwrap();
        let metadata = resolve_source_metadata(&broken_jpg, None, None).unwrap();

        let error = get_or_create_thumbnail(&broken_jpg, &metadata, &cache_dir).unwrap_err();
        assert!(error.contains("Failed to generate thumbnail"));
    }

    #[test]
    fn cleanup_preserves_non_cache_jpg_and_can_remove_hashed_cache_files() {
        let dir = tempdir().unwrap();
        let cache_dir = dir.path().join("thumbs");
        fs::create_dir_all(&cache_dir).unwrap();

        for i in 0..=MAX_CACHE_ENTRIES {
            let hashed_name = cache_file_name_for_index(i);
            fs::write(cache_dir.join(hashed_name), b"1").unwrap();
        }
        fs::write(cache_dir.join("family-photo.jpg"), b"do-not-delete").unwrap();

        cleanup_cache_best_effort(&cache_dir);

        let remaining_hashed = fs::read_dir(&cache_dir)
            .unwrap()
            .flatten()
            .filter(|entry| is_cache_thumbnail_filename(&entry.file_name().to_string_lossy()))
            .count();
        assert!(remaining_hashed <= MAX_CACHE_ENTRIES);
        assert!(cache_dir.join("family-photo.jpg").exists());
    }

    #[test]
    fn cleanup_refuses_symlinked_cache_root() {
        let dir = tempdir().unwrap();
        let target_dir = dir.path().join("real-photos");
        fs::create_dir_all(&target_dir).unwrap();

        for i in 0..=MAX_CACHE_ENTRIES {
            let hashed_name = cache_file_name_for_index(i);
            fs::write(target_dir.join(hashed_name), b"1").unwrap();
        }
        let victim = target_dir.join("vacation.jpg");
        fs::write(&victim, b"original").unwrap();

        let link_path = dir.path().join("thumbs-link");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target_dir, &link_path).unwrap();
        }
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_dir(&target_dir, &link_path).is_err() {
                return;
            }
        }

        cleanup_cache_best_effort(&link_path);

        assert!(victim.exists());
        let hashed_count = fs::read_dir(&target_dir)
            .unwrap()
            .flatten()
            .filter(|entry| is_cache_thumbnail_filename(&entry.file_name().to_string_lossy()))
            .count();
        assert_eq!(hashed_count, MAX_CACHE_ENTRIES + 1);
    }

    #[cfg(windows)]
    #[test]
    fn redirected_cache_root_guard_rejects_reparse_point_roots() {
        let dir = tempdir().unwrap();
        let target_dir = dir.path().join("target");
        fs::create_dir_all(&target_dir).unwrap();
        let link_path = dir.path().join("cache-link");

        if std::os::windows::fs::symlink_dir(&target_dir, &link_path).is_err() {
            return;
        }

        assert!(is_redirected_cache_root(&link_path));
    }
}
