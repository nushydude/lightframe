use crate::generated_cache_maintenance::{
    ensure_cache_root, record_cache_write, MAX_CACHE_BYTES, MAX_CACHE_ENTRIES,
};
use crate::native_codecs;
use crate::path_normalization::normalize_path_for_key;
use image::metadata::Orientation;
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageReader};
use libjpeg_turbo_rs::{CropRegion, Subsampling};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Instant, UNIX_EPOCH};

const THUMBNAIL_SIZE: u32 = 160;
const THUMBNAIL_CACHE_VERSION: &str = "thumb-v4";
const PREVIEW_CACHE_VERSION: &str = "preview-v2";
const TILE_CACHE_VERSION: &str = "tile-v2";
const MIN_TILE_SIZE: u32 = 128;
const MAX_TILE_SIZE: u32 = 2_048;
const TILE_SOURCE_CACHE_VERSION: &str = "tile-source-v1";
const DEFAULT_MAX_TILE_SOURCE_CACHE_BYTES: u64 = 256 * 1024 * 1024;
static CUSTOM_MAX_TILE_SOURCE_CACHE_BYTES: AtomicU64 =
    AtomicU64::new(DEFAULT_MAX_TILE_SOURCE_CACHE_BYTES);
const MAX_RAW_NATIVE_DECODE_FAILURES: usize = 4_096;
static CACHE_TMP_FILE_COUNTER: AtomicUsize = AtomicUsize::new(0);
static THUMBNAIL_CACHE_HIT_COUNT: AtomicUsize = AtomicUsize::new(0);
static PREVIEW_CACHE_HIT_COUNT: AtomicUsize = AtomicUsize::new(0);
static TILE_CACHE_HIT_COUNT: AtomicUsize = AtomicUsize::new(0);
static NATIVE_THUMBNAIL_COUNT: AtomicUsize = AtomicUsize::new(0);
static NATIVE_PREVIEW_COUNT: AtomicUsize = AtomicUsize::new(0);
static RUST_THUMBNAIL_COUNT: AtomicUsize = AtomicUsize::new(0);
static RUST_PREVIEW_COUNT: AtomicUsize = AtomicUsize::new(0);
static PLACEHOLDER_THUMBNAIL_COUNT: AtomicUsize = AtomicUsize::new(0);
static PLACEHOLDER_PREVIEW_COUNT: AtomicUsize = AtomicUsize::new(0);
static TILE_GENERATED_COUNT: AtomicUsize = AtomicUsize::new(0);
static NATIVE_PREVIEW_TOTAL_MS: AtomicU64 = AtomicU64::new(0);
static NATIVE_PREVIEW_MAX_MS: AtomicU64 = AtomicU64::new(0);
static RUST_PREVIEW_TOTAL_MS: AtomicU64 = AtomicU64::new(0);
static RUST_PREVIEW_MAX_MS: AtomicU64 = AtomicU64::new(0);
static PLACEHOLDER_PREVIEW_TOTAL_MS: AtomicU64 = AtomicU64::new(0);
static PLACEHOLDER_PREVIEW_MAX_MS: AtomicU64 = AtomicU64::new(0);
static NATIVE_TILE_COUNT: AtomicUsize = AtomicUsize::new(0);
static NATIVE_TILE_TOTAL_MS: AtomicU64 = AtomicU64::new(0);
static NATIVE_TILE_MAX_MS: AtomicU64 = AtomicU64::new(0);
static RUST_TILE_COUNT: AtomicUsize = AtomicUsize::new(0);
static RUST_TILE_TOTAL_MS: AtomicU64 = AtomicU64::new(0);
static RUST_TILE_MAX_MS: AtomicU64 = AtomicU64::new(0);
static JPEG_TILE_SOURCE_CACHE: OnceLock<Mutex<Option<CachedJpegSource>>> = OnceLock::new();
static RAW_NATIVE_DECODE_FAILURE_CACHE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedCacheBucket {
    pub scope: String,
    pub path: String,
    pub file_count: usize,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedCacheSummary {
    pub buckets: Vec<GeneratedCacheBucket>,
    pub total_file_count: usize,
    pub total_size_bytes: u64,
    pub raw_native_failure_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedAssetRuntimeTiming {
    pub sample_count: usize,
    pub total_ms: u64,
    pub max_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedAssetRuntimeStats {
    pub thumbnail_cache_hits: usize,
    pub preview_cache_hits: usize,
    pub tile_cache_hits: usize,
    pub native_thumbnail_generations: usize,
    pub native_preview_generations: usize,
    pub rust_thumbnail_generations: usize,
    pub rust_preview_generations: usize,
    pub placeholder_thumbnail_generations: usize,
    pub placeholder_preview_generations: usize,
    pub tile_generations: usize,
    pub native_preview_timing: GeneratedAssetRuntimeTiming,
    pub rust_preview_timing: GeneratedAssetRuntimeTiming,
    pub placeholder_preview_timing: GeneratedAssetRuntimeTiming,
    pub native_tile_timing: GeneratedAssetRuntimeTiming,
    pub rust_tile_timing: GeneratedAssetRuntimeTiming,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeneratedCacheClearScope {
    All,
    Thumbnails,
    Previews,
    Tiles,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ThumbnailGenerationBackend {
    Native,
    Rust,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TileGenerationBackend {
    Native,
    RustJpeg,
}

fn elapsed_millis(started_at: Instant) -> u64 {
    let elapsed = started_at.elapsed().as_millis();
    elapsed.min(u128::from(u64::MAX)) as u64
}

fn record_runtime_duration(total_ms: &AtomicU64, max_ms: &AtomicU64, duration_ms: u64) {
    total_ms.fetch_add(duration_ms, Ordering::Relaxed);

    let mut observed = max_ms.load(Ordering::Relaxed);
    while duration_ms > observed {
        match max_ms.compare_exchange(observed, duration_ms, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(current) => observed = current,
        }
    }
}

fn timing_snapshot(
    sample_count: usize,
    total_ms: &AtomicU64,
    max_ms: &AtomicU64,
) -> GeneratedAssetRuntimeTiming {
    GeneratedAssetRuntimeTiming {
        sample_count,
        total_ms: total_ms.load(Ordering::Relaxed),
        max_ms: max_ms.load(Ordering::Relaxed),
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
    let digest = hasher.finalize();
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(&mut output, "{:02x}", byte);
    }
    output
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
    let cache_available = ensure_cache_root(cache_root, cleanup_cache_best_effort);

    if cache_available {
        if let Some(asset) = cached_asset_from_disk(
            cache_root,
            &cache_hash,
            cached_thumbnail_formats(file_path, &cache_hash),
            Some((THUMBNAIL_SIZE, THUMBNAIL_SIZE)),
        ) {
            THUMBNAIL_CACHE_HIT_COUNT.fetch_add(1, Ordering::Relaxed);
            return Ok(asset);
        }
    }

    match generate_best_thumbnail_jpeg(file_path) {
        Ok((jpeg_bytes, backend)) => {
            match backend {
                ThumbnailGenerationBackend::Native => {
                    NATIVE_THUMBNAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                }
                ThumbnailGenerationBackend::Rust => {
                    RUST_THUMBNAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                }
            }
            cache_asset_bytes(
                cache_root,
                cache_available,
                &cache_hash,
                GeneratedImageFormat::Jpeg,
                &jpeg_bytes,
                None,
            )
        }
        Err(error) => {
            if let Some(placeholder_svg) = known_fallback_thumbnail_svg(file_path, &error) {
                remember_raw_native_decode_failure(file_path, &cache_hash);
                PLACEHOLDER_THUMBNAIL_COUNT.fetch_add(1, Ordering::Relaxed);
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
    let cache_available = ensure_cache_root(cache_root, cleanup_cache_best_effort);

    if cache_available {
        if let Some(asset) = cached_asset_from_disk(
            cache_root,
            &cache_hash,
            cached_preview_formats(file_path, &cache_hash),
            Some((PREVIEW_PLACEHOLDER_SIZE, PREVIEW_PLACEHOLDER_SIZE)),
        ) {
            PREVIEW_CACHE_HIT_COUNT.fetch_add(1, Ordering::Relaxed);
            return Ok(asset);
        }
    }

    let preview_started_at = Instant::now();
    if native_codecs::should_prefer_native_preview(file_path) {
        match native_codecs::generate_preview_jpeg(file_path, max_dimension) {
            Ok(jpeg_bytes) => {
                NATIVE_PREVIEW_COUNT.fetch_add(1, Ordering::Relaxed);
                record_runtime_duration(
                    &NATIVE_PREVIEW_TOTAL_MS,
                    &NATIVE_PREVIEW_MAX_MS,
                    elapsed_millis(preview_started_at),
                );
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

    let img = match decode_image_with_orientation(file_path) {
        Ok(img) => img,
        Err(error) => {
            if let Some(placeholder_svg) = known_fallback_preview_svg(file_path, &error) {
                remember_raw_native_decode_failure(file_path, &cache_hash);
                PLACEHOLDER_PREVIEW_COUNT.fetch_add(1, Ordering::Relaxed);
                record_runtime_duration(
                    &PLACEHOLDER_PREVIEW_TOTAL_MS,
                    &PLACEHOLDER_PREVIEW_MAX_MS,
                    elapsed_millis(preview_started_at),
                );
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

    RUST_PREVIEW_COUNT.fetch_add(1, Ordering::Relaxed);
    record_runtime_duration(
        &RUST_PREVIEW_TOTAL_MS,
        &RUST_PREVIEW_MAX_MS,
        elapsed_millis(preview_started_at),
    );
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
    let cache_available = ensure_cache_root(cache_root, cleanup_cache_best_effort);

    if cache_available {
        if let Some(asset) =
            cached_asset_from_disk(cache_root, &cache_hash, &[GeneratedImageFormat::Jpeg], None)
        {
            TILE_CACHE_HIT_COUNT.fetch_add(1, Ordering::Relaxed);
            return Ok(asset);
        }
    }

    let tile_started_at = Instant::now();
    let (jpeg_bytes, backend) = if native_codecs::should_prefer_native_detail(file_path) {
        let jpeg_bytes = native_codecs::generate_region_jpeg(
            file_path,
            native_codecs::NativeImageRegion {
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
            },
        )?;
        (jpeg_bytes, TileGenerationBackend::Native)
    } else {
        let source = get_cached_jpeg_tile_source(file_path, metadata)?;
        let jpeg_bytes = generate_jpeg_tile(source.as_ref().as_slice(), bounds)?;
        (jpeg_bytes, TileGenerationBackend::RustJpeg)
    };

    TILE_GENERATED_COUNT.fetch_add(1, Ordering::Relaxed);
    let tile_duration_ms = elapsed_millis(tile_started_at);
    match backend {
        TileGenerationBackend::Native => {
            NATIVE_TILE_COUNT.fetch_add(1, Ordering::Relaxed);
            record_runtime_duration(&NATIVE_TILE_TOTAL_MS, &NATIVE_TILE_MAX_MS, tile_duration_ms);
        }
        TileGenerationBackend::RustJpeg => {
            RUST_TILE_COUNT.fetch_add(1, Ordering::Relaxed);
            record_runtime_duration(&RUST_TILE_TOTAL_MS, &RUST_TILE_MAX_MS, tile_duration_ms);
        }
    }
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
    let limits = crate::image_resource_policy::PolicyLimits::for_operation(
        crate::image_resource_policy::OperationClass::Thumbnail,
    );
    if let Err(policy_err) = crate::image_resource_policy::validate_file_size(file_path, &limits) {
        return Err(image::ImageError::IoError(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            policy_err.to_string(),
        )));
    }

    let img = decode_image_with_orientation(file_path)?;
    let (width, height) = img.dimensions();
    if let Err(policy_err) =
        crate::image_resource_policy::validate_dimensions(width, height, &limits)
    {
        return Err(image::ImageError::IoError(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            policy_err.to_string(),
        )));
    }

    let thumb = img.thumbnail(THUMBNAIL_SIZE, THUMBNAIL_SIZE);

    let mut buffer = std::io::Cursor::new(Vec::new());
    thumb.write_to(&mut buffer, image::ImageFormat::Jpeg)?;
    Ok(buffer.into_inner())
}

fn generate_best_thumbnail_jpeg(
    file_path: &Path,
) -> Result<(Vec<u8>, ThumbnailGenerationBackend), image::ImageError> {
    if native_codecs::should_prefer_native_thumbnail(file_path) {
        match native_codecs::generate_thumbnail_jpeg(file_path, THUMBNAIL_SIZE) {
            Ok(bytes) => return Ok((bytes, ThumbnailGenerationBackend::Native)),
            Err(error) => {
                eprintln!(
                    "Windows native thumbnail decode failed for '{}': {}. Falling back to Rust thumbnail path.",
                    file_path.display(),
                    error
                );
            }
        }
    }

    generate_thumbnail_jpeg(file_path).map(|bytes| (bytes, ThumbnailGenerationBackend::Rust))
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
    let max_cache_bytes = CUSTOM_MAX_TILE_SOURCE_CACHE_BYTES.load(Ordering::Relaxed);
    if metadata.size_bytes <= max_cache_bytes {
        *guard = Some(CachedJpegSource { key: source_key, bytes: Arc::clone(&bytes) });
    } else {
        *guard = None;
    }

    Ok(bytes)
}

pub fn set_tile_source_cache_limit(limit_bytes: u64) {
    CUSTOM_MAX_TILE_SOURCE_CACHE_BYTES.store(limit_bytes, Ordering::Relaxed);
}

#[cfg(test)]
pub fn get_tile_source_cache_limit() -> u64 {
    CUSTOM_MAX_TILE_SOURCE_CACHE_BYTES.load(Ordering::Relaxed)
}

pub fn calculate_tile_cache_limit_for_performance_mode(performance_mode: &str) -> u64 {
    match performance_mode {
        "fast" => 512 * 1024 * 1024,
        "balanced" => 256 * 1024 * 1024,
        "lowMemory" => 128 * 1024 * 1024,
        _ => DEFAULT_MAX_TILE_SOURCE_CACHE_BYTES,
    }
}

pub fn oriented_image_dimensions(file_path: &Path) -> Result<(u32, u32), String> {
    let reader = ImageReader::open(file_path)
        .map_err(|error| format!("Failed to read image dimensions: {}", error))?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|error| format!("Failed to decode image dimensions: {}", error))?;
    let (width, height) = decoder.dimensions();
    let orientation = decoder
        .orientation()
        .map_err(|error| format!("Failed to read image orientation: {}", error))?;
    Ok(oriented_dimensions(width, height, orientation))
}

fn decode_image_with_orientation(file_path: &Path) -> Result<DynamicImage, image::ImageError> {
    let reader = ImageReader::open(file_path)?;
    let mut decoder = reader.into_decoder()?;
    let orientation = decoder.orientation()?;
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    Ok(image)
}

fn oriented_dimensions(width: u32, height: u32, orientation: Orientation) -> (u32, u32) {
    match orientation {
        Orientation::Rotate90
        | Orientation::Rotate270
        | Orientation::Rotate90FlipH
        | Orientation::Rotate270FlipH => (height, width),
        _ => (width, height),
    }
}

fn jpeg_orientation(source: &[u8]) -> Result<(u32, u32, Orientation), String> {
    let reader = ImageReader::new(std::io::Cursor::new(source))
        .with_guessed_format()
        .map_err(|error| format!("Failed to read JPEG orientation: {}", error))?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|error| format!("Failed to decode JPEG orientation: {}", error))?;
    let (width, height) = decoder.dimensions();
    let orientation = decoder
        .orientation()
        .map_err(|error| format!("Failed to decode JPEG orientation: {}", error))?;
    Ok((width, height, orientation))
}

fn inverse_oriented_pixel(
    x: u32,
    y: u32,
    raw_width: u32,
    raw_height: u32,
    orientation: Orientation,
) -> (u32, u32) {
    match orientation {
        Orientation::NoTransforms => (x, y),
        Orientation::Rotate90 => (y, raw_height - 1 - x),
        Orientation::Rotate180 => (raw_width - 1 - x, raw_height - 1 - y),
        Orientation::Rotate270 => (raw_width - 1 - y, x),
        Orientation::FlipHorizontal => (raw_width - 1 - x, y),
        Orientation::FlipVertical => (x, raw_height - 1 - y),
        Orientation::Rotate90FlipH => (y, x),
        Orientation::Rotate270FlipH => (raw_width - 1 - y, raw_height - 1 - x),
    }
}

fn raw_tile_bounds(
    displayed_bounds: TileBounds,
    raw_width: u32,
    raw_height: u32,
    orientation: Orientation,
) -> TileBounds {
    let right = displayed_bounds.x + displayed_bounds.width - 1;
    let bottom = displayed_bounds.y + displayed_bounds.height - 1;
    let corners = [
        inverse_oriented_pixel(
            displayed_bounds.x,
            displayed_bounds.y,
            raw_width,
            raw_height,
            orientation,
        ),
        inverse_oriented_pixel(right, displayed_bounds.y, raw_width, raw_height, orientation),
        inverse_oriented_pixel(displayed_bounds.x, bottom, raw_width, raw_height, orientation),
        inverse_oriented_pixel(right, bottom, raw_width, raw_height, orientation),
    ];
    let min_x = corners.iter().map(|(x, _)| *x).min().unwrap();
    let max_x = corners.iter().map(|(x, _)| *x).max().unwrap();
    let min_y = corners.iter().map(|(_, y)| *y).min().unwrap();
    let max_y = corners.iter().map(|(_, y)| *y).max().unwrap();
    TileBounds { x: min_x, y: min_y, width: max_x - min_x + 1, height: max_y - min_y + 1 }
}

fn generate_jpeg_tile(source: &[u8], bounds: TileBounds) -> Result<Vec<u8>, String> {
    let (raw_width, raw_height, orientation) = jpeg_orientation(source)?;
    let raw_bounds = raw_tile_bounds(bounds, raw_width, raw_height, orientation);
    let tile = libjpeg_turbo_rs::decompress_cropped(
        source,
        CropRegion {
            x: raw_bounds.x as usize,
            y: raw_bounds.y as usize,
            width: raw_bounds.width as usize,
            height: raw_bounds.height as usize,
        },
    )
    .map_err(|error| format!("Failed to decode JPEG tile: {}", error))?;

    if tile.width == 0 || tile.height == 0 {
        return Err("Decoded tile is empty".to_string());
    }

    let decoded_width = u32::try_from(tile.width)
        .map_err(|_| "Decoded JPEG tile width is too large".to_string())?;
    let decoded_height = u32::try_from(tile.height)
        .map_err(|_| "Decoded JPEG tile height is too large".to_string())?;
    if decoded_width < raw_bounds.width || decoded_height < raw_bounds.height {
        return Err("Decoded JPEG tile is smaller than the requested crop".to_string());
    }

    let decoded_tile = image::RgbImage::from_raw(decoded_width, decoded_height, tile.data)
        .ok_or_else(|| "Decoded JPEG tile has invalid pixel data".to_string())?;
    // libjpeg-turbo aligns the crop origin to an MCU boundary. The extra pixels
    // therefore precede the requested rectangle on the left/top edges.
    let extra_left = decoded_width - raw_bounds.width;
    let extra_top = decoded_height - raw_bounds.height;
    let exact_tile = image::imageops::crop_imm(
        &decoded_tile,
        extra_left,
        extra_top,
        raw_bounds.width,
        raw_bounds.height,
    )
    .to_image();
    let mut oriented_tile = image::DynamicImage::ImageRgb8(exact_tile);
    oriented_tile.apply_orientation(orientation);
    let oriented_tile = oriented_tile.to_rgb8();

    libjpeg_turbo_rs::compress(
        oriented_tile.as_raw(),
        oriented_tile.width() as usize,
        oriented_tile.height() as usize,
        libjpeg_turbo_rs::PixelFormat::Rgb,
        92,
        Subsampling::S444,
    )
    .map_err(|error| format!("Failed to encode JPEG tile: {}", error))
}

fn cached_thumbnail_formats(file_path: &Path, cache_hash: &str) -> &'static [GeneratedImageFormat] {
    if should_reuse_raw_native_placeholder(file_path, cache_hash) {
        return &[GeneratedImageFormat::Jpeg, GeneratedImageFormat::Svg];
    }

    if native_codecs::should_prefer_native_thumbnail(file_path) {
        &[GeneratedImageFormat::Jpeg]
    } else {
        &[GeneratedImageFormat::Jpeg, GeneratedImageFormat::Svg]
    }
}

fn cached_preview_formats(file_path: &Path, cache_hash: &str) -> &'static [GeneratedImageFormat] {
    if should_reuse_raw_native_placeholder(file_path, cache_hash) {
        return &[GeneratedImageFormat::Jpeg, GeneratedImageFormat::Png, GeneratedImageFormat::Svg];
    }

    if native_codecs::should_prefer_native_preview(file_path) {
        &[GeneratedImageFormat::Jpeg]
    } else if normalized_extension(file_path).as_deref().is_some_and(is_raw_extension) {
        &[GeneratedImageFormat::Jpeg, GeneratedImageFormat::Png, GeneratedImageFormat::Svg]
    } else {
        &[GeneratedImageFormat::Jpeg, GeneratedImageFormat::Png]
    }
}

fn should_reuse_raw_native_placeholder(file_path: &Path, cache_hash: &str) -> bool {
    is_raw_native_preferred(file_path) && raw_native_decode_failure_is_known(cache_hash)
}

fn remember_raw_native_decode_failure(file_path: &Path, cache_hash: &str) {
    if !is_raw_native_preferred(file_path) {
        return;
    }

    let cache = RAW_NATIVE_DECODE_FAILURE_CACHE.get_or_init(|| Mutex::new(HashSet::new()));
    let Ok(mut guard) = cache.lock() else {
        return;
    };

    if guard.len() >= MAX_RAW_NATIVE_DECODE_FAILURES {
        guard.clear();
    }
    guard.insert(cache_hash.to_string());
}

fn raw_native_decode_failure_is_known(cache_hash: &str) -> bool {
    RAW_NATIVE_DECODE_FAILURE_CACHE
        .get()
        .and_then(|cache| cache.lock().ok().map(|guard| guard.contains(cache_hash)))
        .unwrap_or(false)
}

pub fn raw_native_decode_failure_count() -> usize {
    RAW_NATIVE_DECODE_FAILURE_CACHE
        .get()
        .and_then(|cache| cache.lock().ok().map(|guard| guard.len()))
        .unwrap_or(0)
}

pub fn clear_raw_native_decode_failure_cache() -> usize {
    let Some(cache) = RAW_NATIVE_DECODE_FAILURE_CACHE.get() else {
        return 0;
    };
    let Ok(mut guard) = cache.lock() else {
        return 0;
    };
    let count = guard.len();
    guard.clear();
    count
}

fn is_raw_native_preferred(file_path: &Path) -> bool {
    normalized_extension(file_path).as_deref().is_some_and(is_raw_extension)
        && (native_codecs::should_prefer_native_thumbnail(file_path)
            || native_codecs::should_prefer_native_preview(file_path))
}

#[cfg(test)]
fn reset_raw_native_decode_failure_cache_for_test() {
    clear_raw_native_decode_failure_cache();
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
    const MIN_NANOSECOND_TIMESTAMP: u128 = 1_000_000_000_000_000;
    let timestamp = value.parse::<u128>().ok()?;
    Some(if timestamp >= MIN_NANOSECOND_TIMESTAMP {
        timestamp
    } else {
        timestamp.saturating_mul(1_000_000_000)
    })
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
    record_cache_write(root, bytes.len() as u64, cleanup_cache_best_effort);

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
    if !ensure_cache_root(&temp_root, cleanup_cache_best_effort) {
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

pub fn generated_asset_runtime_stats() -> GeneratedAssetRuntimeStats {
    let native_preview_generations = NATIVE_PREVIEW_COUNT.load(Ordering::Relaxed);
    let rust_preview_generations = RUST_PREVIEW_COUNT.load(Ordering::Relaxed);
    let placeholder_preview_generations = PLACEHOLDER_PREVIEW_COUNT.load(Ordering::Relaxed);
    let native_tile_generations = NATIVE_TILE_COUNT.load(Ordering::Relaxed);
    let rust_tile_generations = RUST_TILE_COUNT.load(Ordering::Relaxed);

    GeneratedAssetRuntimeStats {
        thumbnail_cache_hits: THUMBNAIL_CACHE_HIT_COUNT.load(Ordering::Relaxed),
        preview_cache_hits: PREVIEW_CACHE_HIT_COUNT.load(Ordering::Relaxed),
        tile_cache_hits: TILE_CACHE_HIT_COUNT.load(Ordering::Relaxed),
        native_thumbnail_generations: NATIVE_THUMBNAIL_COUNT.load(Ordering::Relaxed),
        native_preview_generations,
        rust_thumbnail_generations: RUST_THUMBNAIL_COUNT.load(Ordering::Relaxed),
        rust_preview_generations,
        placeholder_thumbnail_generations: PLACEHOLDER_THUMBNAIL_COUNT.load(Ordering::Relaxed),
        placeholder_preview_generations,
        tile_generations: TILE_GENERATED_COUNT.load(Ordering::Relaxed),
        native_preview_timing: timing_snapshot(
            native_preview_generations,
            &NATIVE_PREVIEW_TOTAL_MS,
            &NATIVE_PREVIEW_MAX_MS,
        ),
        rust_preview_timing: timing_snapshot(
            rust_preview_generations,
            &RUST_PREVIEW_TOTAL_MS,
            &RUST_PREVIEW_MAX_MS,
        ),
        placeholder_preview_timing: timing_snapshot(
            placeholder_preview_generations,
            &PLACEHOLDER_PREVIEW_TOTAL_MS,
            &PLACEHOLDER_PREVIEW_MAX_MS,
        ),
        native_tile_timing: timing_snapshot(
            native_tile_generations,
            &NATIVE_TILE_TOTAL_MS,
            &NATIVE_TILE_MAX_MS,
        ),
        rust_tile_timing: timing_snapshot(
            rust_tile_generations,
            &RUST_TILE_TOTAL_MS,
            &RUST_TILE_MAX_MS,
        ),
    }
}

pub fn generated_cache_summary(app_cache_dir: &Path) -> GeneratedCacheSummary {
    let buckets: Vec<GeneratedCacheBucket> = generated_cache_scope_roots(app_cache_dir)
        .into_iter()
        .map(|(scope, path)| generated_cache_bucket(scope, &path))
        .collect();
    let total_file_count = buckets.iter().map(|bucket| bucket.file_count).sum();
    let total_size_bytes = buckets.iter().map(|bucket| bucket.size_bytes).sum();

    GeneratedCacheSummary {
        buckets,
        total_file_count,
        total_size_bytes,
        raw_native_failure_count: raw_native_decode_failure_count(),
    }
}

pub fn clear_generated_cache(
    app_cache_dir: &Path,
    scope: GeneratedCacheClearScope,
) -> Result<GeneratedCacheSummary, String> {
    for (_, cache_root) in generated_cache_scope_roots(app_cache_dir)
        .into_iter()
        .filter(|(candidate, _)| cache_scope_matches(scope, *candidate))
    {
        clear_generated_cache_root(&cache_root)?;
    }

    Ok(generated_cache_summary(app_cache_dir))
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

fn generated_cache_scope_roots(app_cache_dir: &Path) -> Vec<(GeneratedCacheClearScope, PathBuf)> {
    vec![
        (GeneratedCacheClearScope::Thumbnails, app_cache_dir.join("thumbnails")),
        (GeneratedCacheClearScope::Previews, app_cache_dir.join("previews")),
        (GeneratedCacheClearScope::Tiles, app_cache_dir.join("tiles")),
    ]
}

fn cache_scope_matches(
    selected: GeneratedCacheClearScope,
    candidate: GeneratedCacheClearScope,
) -> bool {
    selected == GeneratedCacheClearScope::All || selected == candidate
}

fn generated_cache_bucket(
    scope: GeneratedCacheClearScope,
    cache_root: &Path,
) -> GeneratedCacheBucket {
    let (file_count, size_bytes) = generated_cache_entries(cache_root)
        .map(|entries| {
            entries.into_iter().fold((0_usize, 0_u64), |(count, bytes), (_, size)| {
                (count + 1, bytes.saturating_add(size))
            })
        })
        .unwrap_or((0, 0));

    GeneratedCacheBucket {
        scope: generated_cache_scope_label(scope).to_string(),
        path: cache_root.to_string_lossy().to_string(),
        file_count,
        size_bytes,
    }
}

fn clear_generated_cache_root(cache_root: &Path) -> Result<(), String> {
    for (path, _) in generated_cache_entries(cache_root)? {
        fs::remove_file(&path)
            .map_err(|error| format!("Failed to remove '{}': {}", path.display(), error))?;
    }

    Ok(())
}

fn generated_cache_entries(cache_root: &Path) -> Result<Vec<(PathBuf, u64)>, String> {
    if !cache_root.exists() {
        return Ok(Vec::new());
    }
    if is_redirected_cache_root(cache_root) {
        return Err(format!(
            "Refusing to inspect redirected generated cache root '{}'",
            cache_root.display()
        ));
    }

    let root = fs::canonicalize(cache_root)
        .map_err(|error| format!("Failed to resolve '{}': {}", cache_root.display(), error))?;
    let read_dir = fs::read_dir(&root)
        .map_err(|error| format!("Failed to read '{}': {}", root.display(), error))?;
    let mut entries = Vec::new();

    for entry in read_dir.flatten() {
        let file_name = entry.file_name();
        if !is_generated_cache_filename(&file_name.to_string_lossy()) {
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
            Ok(path) => path,
            Err(_) => continue,
        };
        if !canonical.starts_with(&root) {
            continue;
        }

        let size = match fs::metadata(&canonical) {
            Ok(metadata) => metadata.len(),
            Err(_) => continue,
        };
        entries.push((canonical, size));
    }

    Ok(entries)
}

fn generated_cache_scope_label(scope: GeneratedCacheClearScope) -> &'static str {
    match scope {
        GeneratedCacheClearScope::All => "all",
        GeneratedCacheClearScope::Thumbnails => "thumbnails",
        GeneratedCacheClearScope::Previews => "previews",
        GeneratedCacheClearScope::Tiles => "tiles",
    }
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

    fn write_orientation(path: &Path, orientation: u16) {
        let mut image = fs::read(path).unwrap();
        let mut exif = b"Exif\0\0II*\0\x08\0\0\0\x01\0".to_vec();
        exif.extend_from_slice(&0x0112_u16.to_le_bytes());
        exif.extend_from_slice(&3_u16.to_le_bytes());
        exif.extend_from_slice(&1_u32.to_le_bytes());
        exif.extend_from_slice(&orientation.to_le_bytes());
        exif.extend_from_slice(&0_u16.to_le_bytes());

        let segment_length = u16::try_from(exif.len() + 2).unwrap();
        let mut segment = vec![0xff, 0xe1];
        segment.extend_from_slice(&segment_length.to_be_bytes());
        segment.extend_from_slice(&exif);
        image.splice(2..2, segment);
        fs::write(path, image).unwrap();
    }

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
    fn modified_timestamp_parser_accepts_legacy_seconds_and_nanoseconds() {
        assert_eq!(parse_modified_epoch_nanos("1700000000"), Some(1_700_000_000_000_000_000));
        assert_eq!(
            parse_modified_epoch_nanos("1700000000123456789"),
            Some(1_700_000_000_123_456_789)
        );
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
    fn oriented_decode_applies_exif_rotation_and_preserves_source() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("oriented.jpg");
        image::RgbImage::from_fn(320, 160, |x, y| image::Rgb([x as u8, y as u8, 0]))
            .save(&image_path)
            .unwrap();
        write_orientation(&image_path, 6);
        let source_bytes = fs::read(&image_path).unwrap();

        let decoded = decode_image_with_orientation(&image_path).unwrap();
        let metadata = resolve_source_metadata(&image_path, None, None).unwrap();
        let thumbnail =
            get_or_create_thumbnail(&image_path, &metadata, &dir.path().join("thumbs")).unwrap();
        let preview =
            get_or_create_preview(&image_path, &metadata, &dir.path().join("previews"), 160, None)
                .unwrap();

        assert_eq!(decoded.dimensions(), (160, 320));
        assert_eq!(oriented_image_dimensions(&image_path).unwrap(), (160, 320));
        assert_eq!(image::open(&thumbnail.file_path).unwrap().dimensions(), (80, 160));
        assert_eq!(preview.width, Some(80));
        assert_eq!(preview.height, Some(160));
        assert_eq!(fs::read(&image_path).unwrap(), source_bytes);
    }

    #[test]
    fn no_orientation_and_non_exif_formats_keep_dimensions() {
        let dir = tempdir().unwrap();
        let jpeg_path = dir.path().join("plain.jpg");
        let png_path = dir.path().join("plain.png");
        image::RgbImage::from_pixel(80, 40, image::Rgb([1, 2, 3])).save(&jpeg_path).unwrap();
        image::RgbImage::from_pixel(80, 40, image::Rgb([1, 2, 3])).save(&png_path).unwrap();

        assert_eq!(decode_image_with_orientation(&jpeg_path).unwrap().dimensions(), (80, 40));
        assert_eq!(oriented_image_dimensions(&png_path).unwrap(), (80, 40));
    }

    #[test]
    fn oriented_jpeg_tiles_use_displayed_dimensions_and_coordinates() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("oriented-large.jpg");
        let cache_dir = dir.path().join("tiles");
        image::RgbImage::from_pixel(640, 480, image::Rgb([12, 34, 56])).save(&image_path).unwrap();
        write_orientation(&image_path, 6);

        let metadata = resolve_source_metadata(&image_path, None, None).unwrap();
        let asset = get_or_create_tile(
            &image_path,
            &metadata,
            &cache_dir,
            TileRequest {
                source_width: 480,
                source_height: 640,
                tile_size: 256,
                tile_x: 0,
                tile_y: 0,
            },
        )
        .unwrap();
        let tile = image::open(&asset.file_path).unwrap();

        assert_eq!(tile.dimensions(), (256, 256));
        assert_eq!(asset.width, Some(256));
        assert_eq!(asset.height, Some(256));
    }

    #[test]
    fn oriented_jpeg_tiles_match_full_decode_for_mcu_unaligned_crop() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("oriented-odd.jpg");
        let raw_width = 321;
        let raw_height = 257;
        let source_image = image::RgbImage::from_fn(raw_width, raw_height, |x, y| {
            let block_x = x / 16;
            let block_y = y / 16;
            image::Rgb([
                (block_x * 35) as u8,
                (block_y * 53) as u8,
                ((block_x + block_y) * 17) as u8,
            ])
        });
        let mut file = fs::File::create(&image_path).unwrap();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, 100)
            .encode_image(&image::DynamicImage::ImageRgb8(source_image))
            .unwrap();
        write_orientation(&image_path, 8);

        let source = fs::read(&image_path).unwrap();
        let bounds = validate_tile_request(TileRequest {
            source_width: raw_height,
            source_height: raw_width,
            tile_size: 128,
            tile_x: 1,
            tile_y: 1,
        })
        .unwrap();
        let tile_bytes = generate_jpeg_tile(&source, bounds).unwrap();
        let tile = image::load_from_memory(&tile_bytes).unwrap().to_rgb8();
        let full = decode_image_with_orientation(&image_path).unwrap().to_rgb8();
        let expected =
            image::imageops::crop_imm(&full, bounds.x, bounds.y, bounds.width, bounds.height)
                .to_image();

        assert_eq!(tile.dimensions(), expected.dimensions());
        for y in 0..tile.height() {
            for x in 0..tile.width() {
                let actual = tile.get_pixel(x, y).0;
                let expected = expected.get_pixel(x, y).0;
                for channel in 0..3 {
                    let difference =
                        (i16::from(actual[channel]) - i16::from(expected[channel])).abs();
                    assert!(
                        difference <= 20,
                        "pixel mismatch at ({x}, {y}), channel {channel}: actual={}, expected={}",
                        actual[channel],
                        expected[channel]
                    );
                }
            }
        }
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
        let formats = cached_thumbnail_formats(Path::new("sample.heic"), "cache-key");

        assert_eq!(formats, &[GeneratedImageFormat::Jpeg]);
    }

    #[test]
    fn cached_thumbnail_lookup_allows_svg_fallbacks_for_non_native_formats() {
        let formats = cached_thumbnail_formats(Path::new("sample.svg"), "cache-key");

        assert_eq!(formats, &[GeneratedImageFormat::Jpeg, GeneratedImageFormat::Svg]);
    }

    #[cfg(windows)]
    #[test]
    fn cached_preview_lookup_skips_svg_fallbacks_for_native_raw_formats() {
        reset_raw_native_decode_failure_cache_for_test();
        let formats = cached_preview_formats(Path::new("sample.cr2"), "cache-key");

        assert_eq!(formats, &[GeneratedImageFormat::Jpeg]);
    }

    #[cfg(windows)]
    #[test]
    fn cached_raw_fallbacks_are_reused_after_native_failure() {
        reset_raw_native_decode_failure_cache_for_test();

        let path = Path::new("sample.cr2");
        remember_raw_native_decode_failure(path, "failed-cache-key");

        assert_eq!(
            cached_thumbnail_formats(path, "failed-cache-key"),
            &[GeneratedImageFormat::Jpeg, GeneratedImageFormat::Svg]
        );
        assert_eq!(
            cached_preview_formats(path, "failed-cache-key"),
            &[GeneratedImageFormat::Jpeg, GeneratedImageFormat::Png, GeneratedImageFormat::Svg]
        );
        assert_eq!(cached_preview_formats(path, "other-cache-key"), &[GeneratedImageFormat::Jpeg]);
    }

    #[cfg(not(windows))]
    #[test]
    fn cached_preview_lookup_allows_svg_fallbacks_for_raw_formats_without_native_codecs() {
        let formats = cached_preview_formats(Path::new("sample.cr2"), "cache-key");

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
    fn generated_cache_summary_counts_and_clears_scoped_cache_files() {
        let dir = tempdir().unwrap();
        let cache_root = dir.path();
        let thumbnails_dir = cache_root.join("thumbnails");
        let previews_dir = cache_root.join("previews");
        fs::create_dir_all(&thumbnails_dir).unwrap();
        fs::create_dir_all(&previews_dir).unwrap();

        fs::write(thumbnails_dir.join(cache_file_name_for_index(1, "jpg")), b"thumb").unwrap();
        fs::write(previews_dir.join(cache_file_name_for_index(2, "png")), b"preview").unwrap();
        fs::write(previews_dir.join("family-photo.jpg"), b"do-not-delete").unwrap();

        let summary = generated_cache_summary(cache_root);
        assert_eq!(summary.total_file_count, 2);
        assert_eq!(summary.total_size_bytes, 12);

        let summary =
            clear_generated_cache(cache_root, GeneratedCacheClearScope::Previews).unwrap();
        assert_eq!(summary.total_file_count, 1);
        assert!(thumbnails_dir.join(cache_file_name_for_index(1, "jpg")).exists());
        assert!(!previews_dir.join(cache_file_name_for_index(2, "png")).exists());
        assert!(previews_dir.join("family-photo.jpg").exists());
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

    #[test]
    fn test_dynamic_tile_source_cache_limit() {
        let default_limit = get_tile_source_cache_limit();
        set_tile_source_cache_limit(calculate_tile_cache_limit_for_performance_mode("fast"));
        assert_eq!(get_tile_source_cache_limit(), 512 * 1024 * 1024);

        set_tile_source_cache_limit(calculate_tile_cache_limit_for_performance_mode("balanced"));
        assert_eq!(get_tile_source_cache_limit(), 256 * 1024 * 1024);

        set_tile_source_cache_limit(calculate_tile_cache_limit_for_performance_mode("lowMemory"));
        assert_eq!(get_tile_source_cache_limit(), 128 * 1024 * 1024);

        set_tile_source_cache_limit(default_limit);
    }
}
