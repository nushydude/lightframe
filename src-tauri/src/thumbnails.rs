use crate::native_codecs;
use crate::path_normalization::normalize_path_for_key;
use image::GenericImageView;
use libjpeg_turbo_rs::{CropRegion, Subsampling};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

const THUMBNAIL_SIZE: u32 = 160;
const THUMBNAIL_CACHE_VERSION: &str = "thumb-v3";
const PREVIEW_CACHE_VERSION: &str = "preview-v1";
const TILE_CACHE_VERSION: &str = "tile-v1";
const MAX_CACHE_ENTRIES: usize = 2_000;
const MAX_CACHE_BYTES: u64 = 256 * 1024 * 1024;
const CLEANUP_INTERVAL: usize = 32;
const MIN_TILE_SIZE: u32 = 128;
const MAX_TILE_SIZE: u32 = 2_048;
const TILE_SOURCE_CACHE_VERSION: &str = "tile-source-v1";
const MAX_TILE_SOURCE_CACHE_BYTES: u64 = 512 * 1024 * 1024;
static CACHE_REQUEST_COUNT: AtomicUsize = AtomicUsize::new(0);
static CACHE_TMP_FILE_COUNTER: AtomicUsize = AtomicUsize::new(0);
static JPEG_TILE_SOURCE_CACHE: OnceLock<Mutex<Option<CachedJpegSource>>> = OnceLock::new();

#[derive(Debug, Clone)]
struct CachedJpegSource {
    key: String,
    bytes: Arc<Vec<u8>>,
}

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
    pub modified_epoch_nanos: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TileRequest {
    pub source_width: u32,
    pub source_height: u32,
    pub tile_size: u32,
    pub tile_x: u32,
    pub tile_y: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TileBounds {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GeneratedImageAsset {
    pub file_path: String,
    pub cache_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GeneratedImageFormat {
    Jpeg,
    Png,
    Svg,
}

impl GeneratedImageFormat {
    fn extension(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::Svg => "svg",
        }
    }
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
            .map(|d| d.as_nanos())
            .unwrap_or(0);

        return Ok(SourceMetadata {
            size_bytes: computed_size,
            modified_epoch_nanos: computed_modified,
        });
    }

    let parsed_modified = modified_at.and_then(parse_modified_epoch_nanos);

    if let (Some(size_bytes), Some(modified_epoch_nanos)) = (size_bytes, parsed_modified) {
        return Ok(SourceMetadata { size_bytes, modified_epoch_nanos });
    }

    Err("Failed to read source metadata and no usable metadata was provided".to_string())
}

pub fn build_cache_key(file_path: &Path, metadata: &SourceMetadata) -> String {
    build_versioned_cache_key(THUMBNAIL_CACHE_VERSION, file_path, metadata, None, None)
}

pub fn build_preview_cache_key(
    file_path: &Path,
    metadata: &SourceMetadata,
    max_dimension: u32,
    invalidation_bust: Option<u64>,
) -> String {
    build_versioned_cache_key(
        PREVIEW_CACHE_VERSION,
        file_path,
        metadata,
        Some(max_dimension),
        invalidation_bust.filter(|value| *value > 0),
    )
}

pub fn build_tile_cache_key(
    file_path: &Path,
    metadata: &SourceMetadata,
    request: TileRequest,
) -> Result<String, String> {
    validate_tile_request(request)?;

    let normalized = normalize_path_for_key(file_path);
    Ok([
        TILE_CACHE_VERSION.to_string(),
        normalized,
        metadata.modified_epoch_nanos.to_string(),
        metadata.size_bytes.to_string(),
        request.source_width.to_string(),
        request.source_height.to_string(),
        request.tile_size.to_string(),
        request.tile_x.to_string(),
        request.tile_y.to_string(),
    ]
    .join("|"))
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
                "HEIC metadata, previews, thumbnails, and deep-zoom detail use Windows native codecs when available.",
            ),
        },
        Some("heif") => FormatSupport {
            browser_renderable: true,
            rust_decode_supported: false,
            metadata_supported: true,
            thumbnail_supported: true,
            support_note: Some(
                "HEIF metadata, previews, thumbnails, and deep-zoom detail use Windows native codecs when available.",
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
        Some(extension) if is_raw_extension(extension) => FormatSupport {
            browser_renderable: false,
            rust_decode_supported: false,
            metadata_supported: true,
            thumbnail_supported: true,
            support_note: Some(
                "On Windows, RAW thumbnails and previews use native codecs when available, then fall back to XMP sidecar metadata and placeholders.",
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
) -> Result<GeneratedImageAsset, String> {
    let cache_key = build_cache_key(file_path, metadata);
    let cache_hash = hash_cache_key(&cache_key);
    let cache_available = ensure_cache_root(cache_root);

    if cache_available {
        if let Some(asset) = cached_asset_from_disk(
            cache_root,
            &cache_hash,
            cached_thumbnail_formats(file_path),
            Some((THUMBNAIL_SIZE, THUMBNAIL_SIZE)),
        ) {
            return Ok(asset);
        }
    }

    match generate_best_thumbnail_jpeg(file_path) {
        Ok(jpeg_bytes) => cache_asset_bytes(
            cache_root,
            cache_available,
            &cache_hash,
            GeneratedImageFormat::Jpeg,
            &jpeg_bytes,
            None,
        ),
        Err(error) => {
            if let Some(placeholder_svg) = known_fallback_thumbnail_svg(file_path, &error) {
                return cache_asset_text(
                    cache_root,
                    cache_available,
                    &cache_hash,
                    GeneratedImageFormat::Svg,
                    &placeholder_svg,
                    Some((THUMBNAIL_SIZE, THUMBNAIL_SIZE)),
                );
            }

            Err(format!("Failed to generate thumbnail: {}", error))
        }
    }
    .map(|mut asset| {
        asset.cache_key = cache_hash;
        asset
    })
}

pub fn get_or_create_preview(
    file_path: &Path,
    metadata: &SourceMetadata,
    cache_root: &Path,
    max_dimension: u32,
    invalidation_bust: Option<u64>,
) -> Result<GeneratedImageAsset, String> {
    if max_dimension == 0 {
        return Err("max_dimension must be greater than zero".to_string());
    }

    let cache_key = build_preview_cache_key(file_path, metadata, max_dimension, invalidation_bust);
    let cache_hash = hash_cache_key(&cache_key);
    let cache_available = ensure_cache_root(cache_root);

    if cache_available {
        if let Some(asset) = cached_asset_from_disk(
            cache_root,
            &cache_hash,
            cached_preview_formats(file_path),
            Some((PREVIEW_PLACEHOLDER_SIZE, PREVIEW_PLACEHOLDER_SIZE)),
        ) {
            return Ok(asset);
        }
    }

    if native_codecs::should_prefer_native_preview(file_path) {
        match native_codecs::generate_preview_jpeg(file_path, max_dimension) {
            Ok(jpeg_bytes) => {
                return cache_asset_bytes(
                    cache_root,
                    cache_available,
                    &cache_hash,
                    GeneratedImageFormat::Jpeg,
                    &jpeg_bytes,
                    None,
                )
                .map(|mut asset| {
                    asset.cache_key = cache_hash;
                    asset
                });
            }
            Err(error) => {
                eprintln!(
                    "Windows native preview decode failed for '{}': {}. Falling back to Rust preview path.",
                    file_path.display(),
                    error
                );
            }
        }
    }

    let img = match image::open(file_path) {
        Ok(img) => img,
        Err(error) => {
            if let Some(placeholder_svg) = known_fallback_preview_svg(file_path, &error) {
                return cache_asset_text(
                    cache_root,
                    cache_available,
                    &cache_hash,
                    GeneratedImageFormat::Svg,
                    &placeholder_svg,
                    Some((PREVIEW_PLACEHOLDER_SIZE, PREVIEW_PLACEHOLDER_SIZE)),
                )
                .map(|mut asset| {
                    asset.cache_key = cache_hash;
                    asset
                });
            }

            return Err(format!("Failed to open image for preview: {}", error));
        }
    };
    let (width, height) = img.dimensions();
    let preview = if width > max_dimension || height > max_dimension {
        img.resize(max_dimension, max_dimension, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let preview_dimensions = preview.dimensions();
    let has_alpha = preview.color().has_alpha();

    let mut buffer = std::io::Cursor::new(Vec::new());
    let format = if has_alpha {
        preview
            .write_to(&mut buffer, image::ImageFormat::Png)
            .map_err(|e| format!("Failed to encode preview image: {}", e))?;
        GeneratedImageFormat::Png
    } else {
        image::DynamicImage::ImageRgb8(preview.to_rgb8())
            .write_to(&mut buffer, image::ImageFormat::Jpeg)
            .map_err(|e| format!("Failed to encode preview image: {}", e))?;
        GeneratedImageFormat::Jpeg
    };

    cache_asset_bytes(
        cache_root,
        cache_available,
        &cache_hash,
        format,
        &buffer.into_inner(),
        Some(preview_dimensions),
    )
    .map(|mut asset| {
        asset.cache_key = cache_hash;
        asset
    })
}

pub fn tile_decode_supported_for_path(file_path: &Path) -> bool {
    matches!(normalized_extension(file_path).as_deref(), Some("jpg" | "jpeg"))
        || native_codecs::should_prefer_native_detail(file_path)
}

pub fn validate_tile_request(request: TileRequest) -> Result<TileBounds, String> {
    if request.source_width == 0 || request.source_height == 0 {
        return Err("source dimensions must be greater than zero".to_string());
    }

    if !(MIN_TILE_SIZE..=MAX_TILE_SIZE).contains(&request.tile_size) {
        return Err(format!("tile_size must be between {} and {}", MIN_TILE_SIZE, MAX_TILE_SIZE));
    }

    let x = u64::from(request.tile_x)
        .checked_mul(u64::from(request.tile_size))
        .ok_or_else(|| "tile x coordinate overflowed".to_string())?;
    let y = u64::from(request.tile_y)
        .checked_mul(u64::from(request.tile_size))
        .ok_or_else(|| "tile y coordinate overflowed".to_string())?;

    if x >= u64::from(request.source_width) || y >= u64::from(request.source_height) {
        return Err("tile is outside the source image bounds".to_string());
    }

    let width = u64::from(request.tile_size).min(u64::from(request.source_width) - x);
    let height = u64::from(request.tile_size).min(u64::from(request.source_height) - y);

    Ok(TileBounds { x: x as u32, y: y as u32, width: width as u32, height: height as u32 })
}

pub fn get_or_create_tile(
    file_path: &Path,
    metadata: &SourceMetadata,
    cache_root: &Path,
    request: TileRequest,
) -> Result<GeneratedImageAsset, String> {
    if !tile_decode_supported_for_path(file_path) {
        return Err("Tiled rendering currently supports JPEG images only".to_string());
    }

    let bounds = validate_tile_request(request)?;
    let cache_key = build_tile_cache_key(file_path, metadata, request)?;
    let cache_hash = hash_cache_key(&cache_key);
    let cache_available = ensure_cache_root(cache_root);

    if cache_available {
        if let Some(asset) =
            cached_asset_from_disk(cache_root, &cache_hash, &[GeneratedImageFormat::Jpeg], None)
        {
            return Ok(asset);
        }
    }

    let jpeg_bytes = if native_codecs::should_prefer_native_detail(file_path) {
        native_codecs::generate_region_jpeg(
            file_path,
            native_codecs::NativeImageRegion {
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
            },
        )?
    } else {
        let source = get_cached_jpeg_tile_source(file_path, metadata)?;
        generate_jpeg_tile(source.as_ref().as_slice(), bounds)?
    };

    cache_asset_bytes(
        cache_root,
        cache_available,
        &cache_hash,
        GeneratedImageFormat::Jpeg,
        &jpeg_bytes,
        Some((bounds.width, bounds.height)),
    )
    .map(|mut asset| {
        asset.cache_key = cache_hash;
        asset
    })
}

fn build_versioned_cache_key(
    version: &str,
    file_path: &Path,
    metadata: &SourceMetadata,
    max_dimension: Option<u32>,
    invalidation_bust: Option<u64>,
) -> String {
    let normalized = normalize_path_for_key(file_path);
    let mut parts = vec![
        version.to_string(),
        normalized,
        metadata.modified_epoch_nanos.to_string(),
        metadata.size_bytes.to_string(),
    ];

    if let Some(max_dimension) = max_dimension {
        parts.push(max_dimension.to_string());
    }

    if let Some(invalidation_bust) = invalidation_bust {
        parts.push(invalidation_bust.to_string());
    }

    parts.join("|")
}

fn generate_thumbnail_jpeg(file_path: &Path) -> Result<Vec<u8>, image::ImageError> {
    let img = image::open(file_path)?;
    let thumb = img.thumbnail(THUMBNAIL_SIZE, THUMBNAIL_SIZE);

    let mut buffer = std::io::Cursor::new(Vec::new());
    thumb.write_to(&mut buffer, image::ImageFormat::Jpeg)?;
    Ok(buffer.into_inner())
}

fn generate_best_thumbnail_jpeg(file_path: &Path) -> Result<Vec<u8>, image::ImageError> {
    if native_codecs::should_prefer_native_thumbnail(file_path) {
        match native_codecs::generate_thumbnail_jpeg(file_path, THUMBNAIL_SIZE) {
            Ok(bytes) => return Ok(bytes),
            Err(error) => {
                eprintln!(
                    "Windows native thumbnail decode failed for '{}': {}. Falling back to Rust thumbnail path.",
                    file_path.display(),
                    error
                );
            }
        }
    }

    generate_thumbnail_jpeg(file_path)
}

fn get_cached_jpeg_tile_source(
    file_path: &Path,
    metadata: &SourceMetadata,
) -> Result<Arc<Vec<u8>>, String> {
    let source_key = hash_cache_key(&build_versioned_cache_key(
        TILE_SOURCE_CACHE_VERSION,
        file_path,
        metadata,
        None,
        None,
    ));
    let cache = JPEG_TILE_SOURCE_CACHE.get_or_init(|| Mutex::new(None));
    let mut guard =
        cache.lock().map_err(|_| "JPEG tile source cache lock is poisoned".to_string())?;

    if let Some(entry) = guard.as_ref() {
        if entry.key == source_key {
            return Ok(Arc::clone(&entry.bytes));
        }
    }

    let bytes = Arc::new(
        fs::read(file_path)
            .map_err(|error| format!("Failed to read JPEG source for tile: {}", error))?,
    );
    if metadata.size_bytes <= MAX_TILE_SOURCE_CACHE_BYTES {
        *guard = Some(CachedJpegSource { key: source_key, bytes: Arc::clone(&bytes) });
    } else {
        *guard = None;
    }

    Ok(bytes)
}

fn generate_jpeg_tile(source: &[u8], bounds: TileBounds) -> Result<Vec<u8>, String> {
    let tile = libjpeg_turbo_rs::decompress_cropped(
        source,
        CropRegion {
            x: bounds.x as usize,
            y: bounds.y as usize,
            width: bounds.width as usize,
            height: bounds.height as usize,
        },
    )
    .map_err(|error| format!("Failed to decode JPEG tile: {}", error))?;

    if tile.width == 0 || tile.height == 0 {
        return Err("Decoded tile is empty".to_string());
    }

    libjpeg_turbo_rs::compress(
        &tile.data,
        tile.width,
        tile.height,
        tile.pixel_format,
        92,
        Subsampling::S444,
    )
    .map_err(|error| format!("Failed to encode JPEG tile: {}", error))
}

fn cached_thumbnail_formats(file_path: &Path) -> &'static [GeneratedImageFormat] {
    if native_codecs::should_prefer_native_thumbnail(file_path) {
        &[GeneratedImageFormat::Jpeg]
    } else {
        &[GeneratedImageFormat::Jpeg, GeneratedImageFormat::Svg]
    }
}

fn cached_preview_formats(file_path: &Path) -> &'static [GeneratedImageFormat] {
    if native_codecs::should_prefer_native_preview(file_path) {
        &[GeneratedImageFormat::Jpeg]
    } else if normalized_extension(file_path).as_deref().is_some_and(is_raw_extension) {
        &[GeneratedImageFormat::Jpeg, GeneratedImageFormat::Png, GeneratedImageFormat::Svg]
    } else {
        &[GeneratedImageFormat::Jpeg, GeneratedImageFormat::Png]
    }
}

fn known_fallback_thumbnail_svg(file_path: &Path, error: &image::ImageError) -> Option<String> {
    if matches!(error, image::ImageError::IoError(_)) {
        return None;
    }

    let extension = normalized_extension(file_path)?;
    if !matches!(extension.as_str(), "heic" | "heif" | "avif" | "svg")
        && !is_raw_extension(&extension)
    {
        return None;
    }

    Some(placeholder_thumbnail_svg(&extension))
}

fn known_fallback_preview_svg(file_path: &Path, error: &image::ImageError) -> Option<String> {
    if matches!(error, image::ImageError::IoError(_)) {
        return None;
    }

    let extension = normalized_extension(file_path)?;
    if !is_raw_extension(&extension) {
        return None;
    }

    Some(placeholder_preview_svg(&extension))
}

fn normalized_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
}

fn is_raw_extension(extension: &str) -> bool {
    matches!(
        extension,
        "dng"
            | "cr2"
            | "cr3"
            | "nef"
            | "nrw"
            | "arw"
            | "srf"
            | "sr2"
            | "raf"
            | "orf"
            | "rw2"
            | "pef"
            | "srw"
    )
}

fn placeholder_thumbnail_svg(extension: &str) -> String {
    let format_label = match extension {
        "heic" => "HEIC".to_string(),
        "heif" => "HEIF".to_string(),
        "avif" => "AVIF".to_string(),
        "svg" => "SVG".to_string(),
        extension if is_raw_extension(extension) => extension.to_ascii_uppercase(),
        _ => "IMAGE".to_string(),
    };

    let canvas_size = THUMBNAIL_SIZE;
    let inner_size = THUMBNAIL_SIZE.saturating_sub(24);
    format!(
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
    )
}

const PREVIEW_PLACEHOLDER_SIZE: u32 = 1024;

fn placeholder_preview_svg(extension: &str) -> String {
    let format_label = extension.to_ascii_uppercase();
    format!(
        concat!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{size}\" height=\"{size}\" ",
            "viewBox=\"0 0 {size} {size}\">",
            "<rect width=\"{size}\" height=\"{size}\" fill=\"#111827\"/>",
            "<rect x=\"96\" y=\"96\" width=\"832\" height=\"832\" rx=\"36\" fill=\"#1f2937\"/>",
            "<text x=\"50%\" y=\"45%\" fill=\"#f8fafc\" text-anchor=\"middle\" ",
            "font-family=\"Arial, sans-serif\" font-size=\"104\">{label}</text>",
            "<text x=\"50%\" y=\"58%\" fill=\"#cbd5e1\" text-anchor=\"middle\" ",
            "font-family=\"Arial, sans-serif\" font-size=\"32\">RAW preview unavailable</text>",
            "<text x=\"50%\" y=\"66%\" fill=\"#94a3b8\" text-anchor=\"middle\" ",
            "font-family=\"Arial, sans-serif\" font-size=\"24\">Showing sidecar metadata when present</text>",
            "</svg>"
        ),
        size = PREVIEW_PLACEHOLDER_SIZE,
        label = format_label
    )
}

fn parse_modified_epoch_nanos(value: &str) -> Option<u128> {
    value
        .parse::<u128>()
        .ok()
        .map(|seconds_since_epoch| seconds_since_epoch.saturating_mul(1_000_000_000))
}

fn ensure_cache_root(cache_root: &Path) -> bool {
    match fs::create_dir_all(cache_root) {
        Ok(_) => {
            maybe_cleanup_cache(cache_root);
            true
        }
        Err(error) => {
            eprintln!(
                "Warning: generated image cache unavailable at '{}': {}",
                cache_root.display(),
                error
            );
            false
        }
    }
}

fn maybe_cleanup_cache(cache_root: &Path) {
    let request_count = CACHE_REQUEST_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
    if !request_count.is_multiple_of(CLEANUP_INTERVAL) {
        return;
    }

    cleanup_cache_best_effort(cache_root);
}

fn cached_asset_from_disk(
    cache_root: &Path,
    cache_hash: &str,
    formats: &[GeneratedImageFormat],
    svg_dimensions: Option<(u32, u32)>,
) -> Option<GeneratedImageAsset> {
    for format in formats {
        let path = cache_root.join(format!("{}.{}", cache_hash, format.extension()));
        if path.is_file() {
            let dimensions =
                if *format == GeneratedImageFormat::Svg { svg_dimensions } else { None };
            return Some(build_generated_image_asset(&path, cache_hash, *format, dimensions));
        }
    }

    None
}

fn generated_asset_path(root: &Path, cache_hash: &str, format: GeneratedImageFormat) -> PathBuf {
    root.join(format!("{}.{}", cache_hash, format.extension()))
}

fn store_generated_asset(
    root: &Path,
    cache_hash: &str,
    format: GeneratedImageFormat,
    bytes: &[u8],
    dimensions: Option<(u32, u32)>,
) -> Result<GeneratedImageAsset, String> {
    let asset_path = generated_asset_path(root, cache_hash, format);
    if asset_path.is_file() {
        return Ok(build_generated_image_asset(&asset_path, cache_hash, format, dimensions));
    }

    write_cache_file(&asset_path, bytes).map_err(|error| {
        format!("Failed to write generated cache file '{}': {}", asset_path.display(), error)
    })?;

    Ok(build_generated_image_asset(&asset_path, cache_hash, format, dimensions))
}

fn build_generated_image_asset(
    asset_path: &Path,
    cache_hash: &str,
    format: GeneratedImageFormat,
    dimensions: Option<(u32, u32)>,
) -> GeneratedImageAsset {
    let resolved_dimensions = dimensions.or_else(|| generated_asset_dimensions(asset_path, format));
    GeneratedImageAsset {
        file_path: asset_path.to_string_lossy().to_string(),
        cache_key: cache_hash.to_string(),
        width: resolved_dimensions.map(|(width, _)| width),
        height: resolved_dimensions.map(|(_, height)| height),
        file_size_bytes: fs::metadata(asset_path).ok().map(|metadata| metadata.len()),
    }
}

fn generated_asset_dimensions(
    asset_path: &Path,
    format: GeneratedImageFormat,
) -> Option<(u32, u32)> {
    if format == GeneratedImageFormat::Svg {
        return Some((THUMBNAIL_SIZE, THUMBNAIL_SIZE));
    }

    image::image_dimensions(asset_path).ok()
}

fn temp_generated_asset_root() -> PathBuf {
    std::env::temp_dir().join("lightframe-generated-assets")
}

fn cache_asset_bytes(
    cache_root: &Path,
    cache_available: bool,
    cache_hash: &str,
    format: GeneratedImageFormat,
    bytes: &[u8],
    dimensions: Option<(u32, u32)>,
) -> Result<GeneratedImageAsset, String> {
    if cache_available {
        match store_generated_asset(cache_root, cache_hash, format, bytes, dimensions) {
            Ok(asset) => return Ok(asset),
            Err(error) => {
                eprintln!("Warning: {}. Falling back to temporary generated asset storage.", error);
            }
        }
    } else {
        eprintln!("Warning: generated image cache unavailable. Falling back to temporary generated asset storage.");
    }

    let temp_root = temp_generated_asset_root();
    if !ensure_cache_root(&temp_root) {
        return Err(format!(
            "Generated image cache unavailable and temporary generated asset storage at '{}' could not be prepared",
            temp_root.display()
        ));
    }

    store_generated_asset(&temp_root, cache_hash, format, bytes, dimensions)
}

fn cache_asset_text(
    cache_root: &Path,
    cache_available: bool,
    cache_hash: &str,
    format: GeneratedImageFormat,
    content: &str,
    dimensions: Option<(u32, u32)>,
) -> Result<GeneratedImageAsset, String> {
    cache_asset_bytes(
        cache_root,
        cache_available,
        cache_hash,
        format,
        content.as_bytes(),
        dimensions,
    )
}

fn write_cache_file(cache_file: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    let Some(parent) = cache_file.parent() else {
        return fs::write(cache_file, bytes);
    };

    fs::create_dir_all(parent)?;

    let tmp_suffix = CACHE_TMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_path = parent.join(format!(
        "{}.{}.tmp",
        cache_file.file_name().and_then(|value| value.to_str()).unwrap_or("generated-image"),
        tmp_suffix
    ));
    fs::write(&tmp_path, bytes)?;
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
        if !is_generated_cache_filename(&file_name) {
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

fn is_generated_cache_filename(file_name: &str) -> bool {
    let Some((stem, extension)) = file_name.rsplit_once('.') else {
        return false;
    };

    matches!(extension, "jpg" | "png" | "svg")
        && stem.len() == 64
        && stem.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use tempfile::tempdir;

    fn cache_file_name_for_index(index: usize, extension: &str) -> String {
        format!("{index:064x}.{extension}")
    }

    #[test]
    fn cache_key_is_stable_for_same_input() {
        let metadata = SourceMetadata { size_bytes: 42, modified_epoch_nanos: 123 };
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
            build_cache_key(path, &SourceMetadata { size_bytes: 42, modified_epoch_nanos: 123 });
        let key_b =
            build_cache_key(path, &SourceMetadata { size_bytes: 43, modified_epoch_nanos: 123 });
        let key_c =
            build_cache_key(path, &SourceMetadata { size_bytes: 42, modified_epoch_nanos: 124 });
        assert_ne!(key_a, key_b);
        assert_ne!(key_a, key_c);
    }

    #[test]
    fn preview_cache_key_changes_with_max_dimension() {
        let metadata = SourceMetadata { size_bytes: 42, modified_epoch_nanos: 123 };
        let path = Path::new("C:/images/photo.jpg");

        let small = build_preview_cache_key(path, &metadata, 1024, None);
        let large = build_preview_cache_key(path, &metadata, 2048, None);

        assert_ne!(small, large);
    }

    #[test]
    fn preview_cache_key_changes_with_invalidation_bust() {
        let metadata = SourceMetadata { size_bytes: 42, modified_epoch_nanos: 123 };
        let path = Path::new("C:/images/photo.jpg");

        let base = build_preview_cache_key(path, &metadata, 2048, None);
        let busted = build_preview_cache_key(path, &metadata, 2048, Some(1_767_225_605_000));

        assert_ne!(base, busted);
    }

    #[test]
    fn tile_cache_key_changes_with_coordinates() {
        let metadata = SourceMetadata { size_bytes: 42, modified_epoch_nanos: 123 };
        let path = Path::new("C:/images/photo.jpg");
        let first = build_tile_cache_key(
            path,
            &metadata,
            TileRequest {
                source_width: 4_000,
                source_height: 3_000,
                tile_size: 512,
                tile_x: 0,
                tile_y: 1,
            },
        )
        .unwrap();
        let second = build_tile_cache_key(
            path,
            &metadata,
            TileRequest {
                source_width: 4_000,
                source_height: 3_000,
                tile_size: 512,
                tile_x: 1,
                tile_y: 1,
            },
        )
        .unwrap();

        assert_ne!(first, second);
    }

    #[test]
    fn tile_validation_clips_edge_tiles_to_source_bounds() {
        let bounds = validate_tile_request(TileRequest {
            source_width: 1_100,
            source_height: 900,
            tile_size: 512,
            tile_x: 2,
            tile_y: 1,
        })
        .unwrap();

        assert_eq!(bounds, TileBounds { x: 1_024, y: 512, width: 76, height: 388 });
    }

    #[test]
    fn tile_validation_rejects_out_of_bounds_requests() {
        let error = validate_tile_request(TileRequest {
            source_width: 1_100,
            source_height: 900,
            tile_size: 512,
            tile_x: 3,
            tile_y: 1,
        })
        .unwrap_err();

        assert!(error.contains("outside"));
    }

    #[test]
    fn tile_decode_support_includes_jpeg_and_native_detail_formats() {
        assert!(tile_decode_supported_for_path(Path::new("photo.jpg")));
        assert!(tile_decode_supported_for_path(Path::new("photo.jpeg")));
        #[cfg(windows)]
        assert!(tile_decode_supported_for_path(Path::new("photo.heic")));
        #[cfg(not(windows))]
        assert!(!tile_decode_supported_for_path(Path::new("photo.heic")));
        assert!(!tile_decode_supported_for_path(Path::new("photo.png")));
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

        assert!(first.file_path.ends_with(".jpg"));
        assert_eq!(first, second);
        assert!(Path::new(&first.file_path).exists());

        let files: Vec<_> = fs::read_dir(&cache_dir).unwrap().flatten().collect();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path().extension().and_then(|ext| ext.to_str()), Some("jpg"));
    }

    #[test]
    fn preview_requests_write_atomically_and_reuse_cache_file() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("sample.jpg");
        let cache_dir = dir.path().join("previews");

        image::RgbImage::from_pixel(3200, 1800, image::Rgb([12, 34, 56]))
            .save(&image_path)
            .unwrap();

        let metadata = resolve_source_metadata(&image_path, None, None).unwrap();
        let first = get_or_create_preview(&image_path, &metadata, &cache_dir, 2048, None).unwrap();
        let second = get_or_create_preview(&image_path, &metadata, &cache_dir, 2048, None).unwrap();

        assert!(first.file_path.ends_with(".jpg"));
        assert_eq!(first, second);
        assert!(Path::new(&first.file_path).exists());
        assert!(fs::read_dir(&cache_dir).unwrap().flatten().all(|entry| entry
            .path()
            .extension()
            .and_then(|ext| ext.to_str())
            != Some("tmp")));
    }

    #[test]
    fn raw_preview_requests_return_stable_placeholder_asset() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("sample.cr2");
        let cache_dir = dir.path().join("previews");
        fs::write(&image_path, b"not-a-decodable-raw").unwrap();

        let metadata = resolve_source_metadata(&image_path, None, None).unwrap();
        let first = get_or_create_preview(&image_path, &metadata, &cache_dir, 2048, None).unwrap();
        let second = get_or_create_preview(&image_path, &metadata, &cache_dir, 2048, None).unwrap();

        assert!(first.file_path.ends_with(".svg"));
        assert_eq!(first, second);
        assert_eq!(first.width, Some(PREVIEW_PLACEHOLDER_SIZE));
        assert_eq!(first.height, Some(PREVIEW_PLACEHOLDER_SIZE));

        let decoded = fs::read_to_string(&first.file_path).unwrap();
        assert!(decoded.contains(">CR2<"));
        assert!(decoded.contains("RAW preview unavailable"));
    }

    #[test]
    fn provided_metadata_is_used_when_filesystem_metadata_is_unavailable() {
        let metadata =
            resolve_source_metadata(Path::new("missing-file.jpg"), Some(42), Some("123")).unwrap();

        assert_eq!(metadata.size_bytes, 42);
        assert_eq!(metadata.modified_epoch_nanos, 123_000_000_000);
    }

    #[test]
    fn preview_invalidation_bust_creates_distinct_preview_asset() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("sample.jpg");
        let cache_dir = dir.path().join("previews");

        image::RgbImage::from_pixel(3200, 1800, image::Rgb([12, 34, 56]))
            .save(&image_path)
            .unwrap();

        let metadata = resolve_source_metadata(&image_path, None, None).unwrap();
        let first = get_or_create_preview(&image_path, &metadata, &cache_dir, 2048, None).unwrap();
        let second =
            get_or_create_preview(&image_path, &metadata, &cache_dir, 2048, Some(42)).unwrap();

        assert_ne!(first.cache_key, second.cache_key);
        assert_ne!(first.file_path, second.file_path);
        assert!(Path::new(&second.file_path).exists());
    }

    #[test]
    fn thumbnail_generation_falls_back_to_temp_storage_when_cache_setup_fails() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("sample.png");
        let cache_root_file = dir.path().join("cache-root-is-file");
        let invalid_cache_dir = cache_root_file.join("thumbnails");

        let image = image::RgbaImage::from_fn(64, 64, |_, _| image::Rgba([0, 255, 0, 255]));
        image.save(&image_path).unwrap();
        fs::write(&cache_root_file, b"not-a-directory").unwrap();

        let metadata = resolve_source_metadata(&image_path, None, None).unwrap();
        let asset = get_or_create_thumbnail(&image_path, &metadata, &invalid_cache_dir).unwrap();

        assert!(asset.file_path.ends_with(".jpg"));
        assert!(asset.file_path.contains("lightframe-generated-assets"));
        assert!(Path::new(&asset.file_path).exists());
    }

    #[test]
    fn preview_generation_falls_back_to_temp_storage_when_cache_setup_fails() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("sample.jpg");
        let cache_root_file = dir.path().join("cache-root-is-file");
        let invalid_cache_dir = cache_root_file.join("previews");

        image::RgbImage::from_pixel(1024, 768, image::Rgb([12, 34, 56])).save(&image_path).unwrap();
        fs::write(&cache_root_file, b"not-a-directory").unwrap();

        let metadata = resolve_source_metadata(&image_path, None, None).unwrap();
        let asset =
            get_or_create_preview(&image_path, &metadata, &invalid_cache_dir, 2048, None).unwrap();

        assert!(asset.file_path.ends_with(".jpg"));
        assert!(asset.file_path.contains("lightframe-generated-assets"));
        assert!(Path::new(&asset.file_path).exists());
    }

    #[test]
    fn unsupported_formats_return_stable_placeholder_thumbnail_asset() {
        let dir = tempdir().unwrap();
        let cache_dir = dir.path().join("thumbs");

        for (extension, expected_label) in
            [("heic", "HEIC"), ("heif", "HEIF"), ("avif", "AVIF"), ("svg", "SVG"), ("cr2", "CR2")]
        {
            let image_path = dir.path().join(format!("sample.{}", extension));
            fs::write(&image_path, b"not-a-decodable-image").unwrap();

            let metadata = resolve_source_metadata(&image_path, None, None).unwrap();
            let first = get_or_create_thumbnail(&image_path, &metadata, &cache_dir).unwrap();
            let second = get_or_create_thumbnail(&image_path, &metadata, &cache_dir).unwrap();

            assert!(first.file_path.ends_with(".svg"));
            assert_eq!(first, second);

            let decoded = fs::read_to_string(&first.file_path).unwrap();
            assert!(decoded.contains(&format!(">{}<", expected_label)));
        }

        let cached_jpg_files = fs::read_dir(&cache_dir)
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("jpg"))
            .count();
        assert_eq!(cached_jpg_files, 0);
    }

    #[cfg(windows)]
    #[test]
    fn cached_thumbnail_lookup_skips_svg_fallbacks_for_native_preferred_formats() {
        let formats = cached_thumbnail_formats(Path::new("sample.heic"));

        assert_eq!(formats, &[GeneratedImageFormat::Jpeg]);
    }

    #[test]
    fn cached_thumbnail_lookup_allows_svg_fallbacks_for_non_native_formats() {
        let formats = cached_thumbnail_formats(Path::new("sample.svg"));

        assert_eq!(formats, &[GeneratedImageFormat::Jpeg, GeneratedImageFormat::Svg]);
    }

    #[cfg(windows)]
    #[test]
    fn cached_preview_lookup_skips_svg_fallbacks_for_native_raw_formats() {
        let formats = cached_preview_formats(Path::new("sample.cr2"));

        assert_eq!(formats, &[GeneratedImageFormat::Jpeg]);
    }

    #[cfg(not(windows))]
    #[test]
    fn cached_preview_lookup_allows_svg_fallbacks_for_raw_formats_without_native_codecs() {
        let formats = cached_preview_formats(Path::new("sample.cr2"));

        assert_eq!(
            formats,
            &[GeneratedImageFormat::Jpeg, GeneratedImageFormat::Png, GeneratedImageFormat::Svg]
        );
    }

    #[test]
    fn fallback_formats_do_not_mask_io_errors() {
        let dir = tempdir().unwrap();
        let cache_dir = dir.path().join("thumbs");
        let missing = dir.path().join("missing.heic");
        let metadata = SourceMetadata { size_bytes: 1, modified_epoch_nanos: 1 };

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
            let hashed_name = cache_file_name_for_index(i, "jpg");
            fs::write(cache_dir.join(hashed_name), b"1").unwrap();
        }
        fs::write(cache_dir.join("family-photo.jpg"), b"do-not-delete").unwrap();

        cleanup_cache_best_effort(&cache_dir);

        let remaining_hashed = fs::read_dir(&cache_dir)
            .unwrap()
            .flatten()
            .filter(|entry| is_generated_cache_filename(&entry.file_name().to_string_lossy()))
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
            let hashed_name = cache_file_name_for_index(i, "jpg");
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
            .filter(|entry| is_generated_cache_filename(&entry.file_name().to_string_lossy()))
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

    #[test]
    fn placeholder_svg_stays_ascii_safe() {
        let svg = placeholder_thumbnail_svg("svg");
        assert!(svg.is_ascii());
        let encoded = base64::engine::general_purpose::STANDARD.encode(svg.as_bytes());
        assert!(!encoded.is_empty());
    }

    #[test]
    fn cache_key_changes_for_same_second_edits_with_subsecond_mtime() {
        let path = Path::new("C:/images/photo.jpg");
        let key_a = build_cache_key(
            path,
            &SourceMetadata { size_bytes: 42, modified_epoch_nanos: 1_700_000_000_000_000_100 },
        );
        let key_b = build_cache_key(
            path,
            &SourceMetadata { size_bytes: 42, modified_epoch_nanos: 1_700_000_000_000_000_900 },
        );
        let preview_key_a = build_preview_cache_key(
            path,
            &SourceMetadata { size_bytes: 42, modified_epoch_nanos: 1_700_000_000_000_000_100 },
            2048,
            None,
        );
        let preview_key_b = build_preview_cache_key(
            path,
            &SourceMetadata { size_bytes: 42, modified_epoch_nanos: 1_700_000_000_000_000_900 },
            2048,
            None,
        );

        assert_ne!(key_a, key_b);
        assert_ne!(preview_key_a, preview_key_b);
    }
}
