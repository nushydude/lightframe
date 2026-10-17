use crate::generated_cache_maintenance::{
    ensure_cache_root, record_cache_write, MAX_CACHE_BYTES, MAX_CACHE_ENTRIES,
};
use crate::image_resource_policy::{self, OperationClass};
use crate::native_codecs;
use crate::path_normalization::normalize_path_for_key;
use image::metadata::Orientation;
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageReader};
use libjpeg_turbo_rs::{CropRegion, Subsampling};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
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
static JPEG_REDUCED_THUMBNAIL_COUNT: AtomicUsize = AtomicUsize::new(0);
static JPEG_REDUCED_PREVIEW_COUNT: AtomicUsize = AtomicUsize::new(0);
static JPEG_FULL_DECODE_COUNT: AtomicUsize = AtomicUsize::new(0);
static JPEG_FALLBACK_COUNT: AtomicUsize = AtomicUsize::new(0);
static JPEG_REDUCED_MAX_WIDTH: AtomicUsize = AtomicUsize::new(0);
static JPEG_REDUCED_MAX_HEIGHT: AtomicUsize = AtomicUsize::new(0);
static JPEG_FULL_MAX_WIDTH: AtomicUsize = AtomicUsize::new(0);
static JPEG_FULL_MAX_HEIGHT: AtomicUsize = AtomicUsize::new(0);
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
static JPEG_TILE_SOURCE_CACHE: OnceLock<Mutex<JpegSourceCache>> = OnceLock::new();
static CACHE_GENERATIONS: OnceLock<Mutex<HashMap<String, Arc<Mutex<CacheRootState>>>>> =
    OnceLock::new();

#[derive(Default)]
struct CacheRootState {
    epoch: u64,
    retiring: bool,
}

pub(crate) struct CacheGeneration {
    state: Arc<Mutex<CacheRootState>>,
    epoch: u64,
    source: Option<(PathBuf, SourceMetadata)>,
}

fn cache_root_state(root: &Path) -> Arc<Mutex<CacheRootState>> {
    // Canonical Windows paths gain //?/ only after creation. Normalize that prefix
    // before registry lookup so the first producer and a later clear share an epoch.
    // Filesystem canonicalization is deliberately outside the registry mutex.
    let normalized = normalize_path_for_key(root);
    let key = normalized.strip_prefix("//?/").unwrap_or(&normalized).to_owned();
    let mut roots = CACHE_GENERATIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    Arc::clone(roots.entry(key).or_default())
}

/// Namespace identity is included in queued read-only work keys, so post-clear
/// consumers cannot attach to a retiring producer from the previous namespace.
impl CacheGeneration {
    pub(crate) fn capture(root: &Path) -> Result<Self, String> {
        crate::media_executor::checkpoint()?;
        let state = cache_root_state(root);
        let epoch = {
            let guard = state.lock().unwrap_or_else(|error| error.into_inner());
            if guard.retiring {
                return Err("Generated cache is being cleared".into());
            }
            guard.epoch
        };
        Ok(Self { state, epoch, source: None })
    }

    #[cfg(test)]
    fn for_source(root: &Path, path: &Path, metadata: &SourceMetadata) -> Result<Self, String> {
        Self::capture(root)?.with_source(path, metadata)
    }

    fn with_source(mut self, path: &Path, metadata: &SourceMetadata) -> Result<Self, String> {
        self.checkpoint()?;
        self.source = Some((path.to_path_buf(), metadata.clone()));
        Ok(self)
    }

    pub(crate) fn epoch(&self) -> u64 {
        self.epoch
    }

    fn validate_source(&self) -> Result<(), String> {
        if let Some((path, expected)) = &self.source {
            let actual = resolve_source_metadata(path, None, None)?;
            if actual.size_bytes != expected.size_bytes
                || actual.modified_epoch_nanos != expected.modified_epoch_nanos
            {
                return Err("Generated image source changed during processing".into());
            }
        }
        Ok(())
    }

    fn validate(&self, state: &CacheRootState) -> Result<(), String> {
        crate::media_executor::checkpoint()?;
        if state.retiring || state.epoch != self.epoch {
            return Err("Generated cache generation is stale".into());
        }
        Ok(())
    }

    fn checkpoint(&self) -> Result<(), String> {
        self.validate(&self.state.lock().unwrap_or_else(|error| error.into_inner()))
    }
}
static RAW_NATIVE_DECODE_FAILURE_CACHE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
#[derive(Debug, Clone)]
struct CachedJpegSource {
    key: String,
    bytes: Arc<Vec<u8>>,
}

#[derive(Default)]
struct JpegSourceCache {
    epoch: u64,
    entry: Option<CachedJpegSource>,
}

impl JpegSourceCache {
    fn invalidate(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.entry = None;
    }

    fn publish(
        &mut self,
        epoch: u64,
        key: String,
        bytes: &Arc<Vec<u8>>,
        limit: u64,
    ) -> Result<(), String> {
        crate::media_executor::checkpoint()?;
        if self.epoch != epoch {
            return Err("JPEG tile source generation is stale".into());
        }
        self.entry = if bytes.len() as u64 <= limit {
            Some(CachedJpegSource { key, bytes: Arc::clone(bytes) })
        } else {
            None
        };
        Ok(())
    }
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
    pub jpeg_reduced_thumbnail_decodes: usize,
    pub jpeg_reduced_preview_decodes: usize,
    pub jpeg_full_decodes: usize,
    pub jpeg_fallback_decodes: usize,
    pub jpeg_reduced_max_output_width: usize,
    pub jpeg_reduced_max_output_height: usize,
    pub jpeg_full_max_output_width: usize,
    pub jpeg_full_max_output_height: usize,
    pub placeholder_thumbnail_generations: usize,
    pub placeholder_preview_generations: usize,
    pub tile_generations: usize,
    pub resource_policy_rejections: usize,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JpegDecodeScale {
    Full,
    Reduced(u32),
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JpegTelemetryEvent {
    Reduced { operation: OperationClass, width: u32, height: u32 },
    Fallback,
    Full { width: u32, height: u32 },
}

#[cfg(test)]
thread_local! {
    static JPEG_TEST_TELEMETRY: RefCell<Option<Vec<JpegTelemetryEvent>>> = RefCell::new(None);
}

#[cfg(test)]
struct ScopedJpegTelemetryRecorder;

#[cfg(test)]
impl ScopedJpegTelemetryRecorder {
    fn capture<R>(operation: impl FnOnce() -> R) -> (R, Vec<JpegTelemetryEvent>) {
        JPEG_TEST_TELEMETRY.with(|events| {
            assert!(events.borrow().is_none(), "nested JPEG telemetry recorder");
            *events.borrow_mut() = Some(Vec::new());
        });
        let result = operation();
        let events = JPEG_TEST_TELEMETRY.with(|slot| {
            slot.borrow_mut().take().expect("JPEG telemetry recorder was not initialized")
        });
        (result, events)
    }
}

#[cfg(test)]
fn record_test_jpeg_event(event: JpegTelemetryEvent) {
    JPEG_TEST_TELEMETRY.with(|slot| {
        if let Some(events) = slot.borrow_mut().as_mut() {
            events.push(event);
        }
    });
}

/// Pick the largest native JPEG reduction that still leaves at least one requested bound of
/// source detail. JPEG's decoder-supported factors are powers of two; the post-decode resize
/// retains the existing aspect-ratio and thumbnail filtering semantics.
fn select_jpeg_decode_scale(
    source_width: u32,
    source_height: u32,
    requested_max_dimension: u32,
) -> JpegDecodeScale {
    let source_max = u64::from(source_width.max(source_height));
    let requested = u64::from(requested_max_dimension.max(1));
    for factor in [8_u64, 4, 2] {
        let scaled_max = source_max.div_ceil(factor);
        if scaled_max >= requested {
            return JpegDecodeScale::Reduced(factor as u32);
        }
    }
    JpegDecodeScale::Full
}

fn update_max_dimension(counter: &AtomicUsize, value: usize) {
    let mut observed = counter.load(Ordering::Relaxed);
    while value > observed {
        match counter.compare_exchange(observed, value, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(current) => observed = current,
        }
    }
}

fn record_jpeg_reduced_output(width: u32, height: u32) {
    update_max_dimension(&JPEG_REDUCED_MAX_WIDTH, width as usize);
    update_max_dimension(&JPEG_REDUCED_MAX_HEIGHT, height as usize);
}

fn record_jpeg_full_output(width: u32, height: u32) {
    update_max_dimension(&JPEG_FULL_MAX_WIDTH, width as usize);
    update_max_dimension(&JPEG_FULL_MAX_HEIGHT, height as usize);
}

fn record_jpeg_reduced_decode(operation: OperationClass, width: u32, height: u32) {
    match operation {
        OperationClass::Thumbnail => {
            JPEG_REDUCED_THUMBNAIL_COUNT.fetch_add(1, Ordering::Relaxed);
        }
        OperationClass::Preview => {
            JPEG_REDUCED_PREVIEW_COUNT.fetch_add(1, Ordering::Relaxed);
        }
        _ => {}
    }
    record_jpeg_reduced_output(width, height);
    #[cfg(test)]
    record_test_jpeg_event(JpegTelemetryEvent::Reduced { operation, width, height });
}

fn record_jpeg_fallback() {
    JPEG_FALLBACK_COUNT.fetch_add(1, Ordering::Relaxed);
    #[cfg(test)]
    record_test_jpeg_event(JpegTelemetryEvent::Fallback);
}

fn record_jpeg_full_decode(width: u32, height: u32) {
    JPEG_FULL_DECODE_COUNT.fetch_add(1, Ordering::Relaxed);
    record_jpeg_full_output(width, height);
    #[cfg(test)]
    record_test_jpeg_event(JpegTelemetryEvent::Full { width, height });
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

fn policy_error(
    operation: OperationClass,
    error: image_resource_policy::ResourcePolicyError,
) -> String {
    image_resource_policy::record_rejection(operation);
    error.to_string()
}

fn source_lease_if_present(
    path: &Path,
    operation: OperationClass,
) -> Result<Option<image_resource_policy::ImageSource>, String> {
    if !path.exists() {
        return Ok(None);
    }
    image_resource_policy::ImageSource::open(path, operation)
        .map(Some)
        .map_err(|error| policy_error(operation, error))
}

fn validate_generated_source(file_path: &Path, operation: OperationClass) -> Result<(), String> {
    if let Err(error) = image_resource_policy::validate_file_size(file_path, operation) {
        // Missing files and inaccessible paths must continue through the established generator
        // error path so callers retain the existing diagnostic and no placeholder masks I/O.
        if error == image_resource_policy::ResourcePolicyError::FileMetadataUnavailable {
            return Ok(());
        }
        return Err(policy_error(operation, error));
    }

    Ok(())
}

#[cfg(test)]
pub fn get_or_create_thumbnail(
    file_path: &Path,
    metadata: &SourceMetadata,
    cache_root: &Path,
) -> Result<GeneratedImageAsset, String> {
    let generation = CacheGeneration::capture(cache_root)?;
    get_or_create_thumbnail_with_generation(file_path, metadata, cache_root, generation)
}

pub(crate) fn get_or_create_thumbnail_with_generation(
    file_path: &Path,
    metadata: &SourceMetadata,
    cache_root: &Path,
    generation: CacheGeneration,
) -> Result<GeneratedImageAsset, String> {
    let generation = generation.with_source(file_path, metadata)?;
    validate_generated_source(file_path, OperationClass::Thumbnail)?;
    let _source_lease = source_lease_if_present(file_path, OperationClass::Thumbnail)?;
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
            generation.checkpoint()?;
            THUMBNAIL_CACHE_HIT_COUNT.fetch_add(1, Ordering::Relaxed);
            return Ok(asset);
        }
    }

    generation.checkpoint()?;
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
                &generation,
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
                    &generation,
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

#[cfg(test)]
pub fn get_or_create_preview(
    file_path: &Path,
    metadata: &SourceMetadata,
    cache_root: &Path,
    max_dimension: u32,
    invalidation_bust: Option<u64>,
) -> Result<GeneratedImageAsset, String> {
    let generation = CacheGeneration::capture(cache_root)?;
    get_or_create_preview_with_generation(
        file_path,
        metadata,
        cache_root,
        max_dimension,
        invalidation_bust,
        generation,
    )
}

pub(crate) fn get_or_create_preview_with_generation(
    file_path: &Path,
    metadata: &SourceMetadata,
    cache_root: &Path,
    max_dimension: u32,
    invalidation_bust: Option<u64>,
    generation: CacheGeneration,
) -> Result<GeneratedImageAsset, String> {
    let generation = generation.with_source(file_path, metadata)?;
    image_resource_policy::validate_requested_dimension(max_dimension, OperationClass::Preview)
        .map_err(|error| policy_error(OperationClass::Preview, error))?;
    validate_generated_source(file_path, OperationClass::Preview)?;
    let _source_lease = source_lease_if_present(file_path, OperationClass::Preview)?;

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
            generation.checkpoint()?;
            PREVIEW_CACHE_HIT_COUNT.fetch_add(1, Ordering::Relaxed);
            return Ok(asset);
        }
    }

    generation.checkpoint()?;
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
                    &generation,
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
            Err(native_codecs::NativeError::Policy(error)) => return Err(error.to_string()),
            Err(error) => {
                eprintln!(
                    "Windows native preview decode failed for '{}': {}. Falling back to Rust preview path.",
                    file_path.display(),
                    error
                );
            }
        }
    }

    generation.checkpoint()?;
    let img = match decode_image_with_orientation_for_preview(file_path, max_dimension) {
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
                    &generation,
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
    generation.checkpoint()?;
    let (width, height) = img.dimensions();
    let preview = if width > max_dimension || height > max_dimension {
        let (output_width, output_height) =
            image_resource_policy::preview_resize_dimensions(width, height, max_dimension);
        image_resource_policy::validate_preview_resize_memory(
            (width, height),
            (output_width, output_height),
            u64::from(img.color().bytes_per_pixel()),
            0,
            0,
        )
        .map_err(|error| policy_error(OperationClass::Preview, error))?;
        img.resize(max_dimension, max_dimension, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    generation.checkpoint()?;
    let preview_dimensions = preview.dimensions();
    image_resource_policy::validate_output_dimensions(
        preview_dimensions.0,
        preview_dimensions.1,
        &image_resource_policy::PolicyLimits::for_operation(OperationClass::Preview),
    )
    .map_err(|error| policy_error(OperationClass::Preview, error))?;
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
        &generation,
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

#[cfg(test)]
pub fn get_or_create_tile(
    file_path: &Path,
    metadata: &SourceMetadata,
    cache_root: &Path,
    request: TileRequest,
) -> Result<GeneratedImageAsset, String> {
    let generation = CacheGeneration::capture(cache_root)?;
    get_or_create_tile_with_generation(file_path, metadata, cache_root, request, generation)
}

pub(crate) fn get_or_create_tile_with_generation(
    file_path: &Path,
    metadata: &SourceMetadata,
    cache_root: &Path,
    request: TileRequest,
    generation: CacheGeneration,
) -> Result<GeneratedImageAsset, String> {
    let generation = generation.with_source(file_path, metadata)?;
    if !tile_decode_supported_for_path(file_path) {
        return Err("Tiled rendering currently supports JPEG images only".to_string());
    }

    let bounds = validate_tile_request(request)?;
    image_resource_policy::validate_file_size(file_path, OperationClass::Tile)
        .map_err(|error| policy_error(OperationClass::Tile, error))?;
    let limits = image_resource_policy::PolicyLimits::for_operation(OperationClass::Tile);
    image_resource_policy::validate_dimensions(
        request.source_width,
        request.source_height,
        &limits,
    )
    .map_err(|error| policy_error(OperationClass::Tile, error))?;
    image_resource_policy::validate_output_dimensions(bounds.width, bounds.height, &limits)
        .map_err(|error| policy_error(OperationClass::Tile, error))?;
    image_resource_policy::validate_working_memory(bounds.width, bounds.height, 3, 2, &limits)
        .map_err(|error| policy_error(OperationClass::Tile, error))?;
    let cache_key = build_tile_cache_key(file_path, metadata, request)?;
    let cache_hash = hash_cache_key(&cache_key);
    let cache_available = ensure_cache_root(cache_root, cleanup_cache_best_effort);

    if cache_available {
        if let Some(asset) =
            cached_asset_from_disk(cache_root, &cache_hash, &[GeneratedImageFormat::Jpeg], None)
        {
            generation.checkpoint()?;
            TILE_CACHE_HIT_COUNT.fetch_add(1, Ordering::Relaxed);
            return Ok(asset);
        }
    }

    generation.checkpoint()?;
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
        )
        .map_err(|error| error.to_string())?;
        (jpeg_bytes, TileGenerationBackend::Native)
    } else {
        let source = get_cached_jpeg_tile_source(&generation, file_path, metadata)?;
        generation.checkpoint()?;
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
        &generation,
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
    let img = decode_image_with_orientation_with_preview_limit(
        file_path,
        OperationClass::Thumbnail,
        Some(THUMBNAIL_SIZE),
    )?;
    image_checkpoint()?;
    let thumb = img.thumbnail(THUMBNAIL_SIZE, THUMBNAIL_SIZE);
    image_checkpoint()?;
    image_resource_policy::validate_output_dimensions(
        thumb.width(),
        thumb.height(),
        &image_resource_policy::PolicyLimits::for_operation(OperationClass::Thumbnail),
    )
    .map_err(|error| reduced_jpeg_policy_error(OperationClass::Thumbnail, error))?;

    let mut buffer = std::io::Cursor::new(Vec::new());
    thumb.write_to(&mut buffer, image::ImageFormat::Jpeg)?;
    Ok(buffer.into_inner())
}

fn generate_best_thumbnail_jpeg(
    file_path: &Path,
) -> Result<(Vec<u8>, ThumbnailGenerationBackend), image::ImageError> {
    image_checkpoint()?;
    if native_codecs::should_prefer_native_thumbnail(file_path) {
        match native_codecs::generate_thumbnail_jpeg(file_path, THUMBNAIL_SIZE) {
            Ok(bytes) => return Ok((bytes, ThumbnailGenerationBackend::Native)),
            Err(native_codecs::NativeError::Policy(error)) => {
                return Err(image::ImageError::IoError(std::io::Error::other(error)))
            }
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
    generation: &CacheGeneration,
    file_path: &Path,
    metadata: &SourceMetadata,
) -> Result<Arc<Vec<u8>>, String> {
    generation.checkpoint()?;
    let source_key = hash_cache_key(&build_versioned_cache_key(
        TILE_SOURCE_CACHE_VERSION,
        file_path,
        metadata,
        None,
        None,
    ));
    let cache = JPEG_TILE_SOURCE_CACHE.get_or_init(|| Mutex::new(JpegSourceCache::default()));
    let guard = cache.lock().map_err(|_| "JPEG tile source cache lock is poisoned".to_string())?;
    let epoch = guard.epoch;

    if let Some(entry) = guard.entry.as_ref() {
        if entry.key == source_key {
            return Ok(Arc::clone(&entry.bytes));
        }
    }
    drop(guard);
    crate::media_executor::checkpoint()?;

    let source = image_resource_policy::ImageSource::open(file_path, OperationClass::Tile)
        .map_err(|error| policy_error(OperationClass::Tile, error))?;
    let limits = image_resource_policy::PolicyLimits::for_operation(OperationClass::Tile);
    let encoded_reserve = source.encoded_len().checked_mul(4).ok_or_else(|| {
        policy_error(
            OperationClass::Tile,
            image_resource_policy::ResourcePolicyError::AllocationOverflow,
        )
    })?;
    if encoded_reserve > limits.max_working_bytes {
        return Err(policy_error(
            OperationClass::Tile,
            image_resource_policy::ResourcePolicyError::WorkingBytesExceedLimit {
                bytes: encoded_reserve,
                max: limits.max_working_bytes,
            },
        ));
    }
    let source_bytes =
        source.read_bytes().map_err(|error| policy_error(OperationClass::Tile, error))?;
    let bytes = Arc::new(source_bytes);
    crate::media_executor::checkpoint()?;
    generation.validate_source()?;
    let root_state = generation.state.lock().unwrap_or_else(|error| error.into_inner());
    generation.validate(&root_state)?;
    let mut guard =
        cache.lock().map_err(|_| "JPEG tile source cache lock is poisoned".to_string())?;
    let max_cache_bytes = CUSTOM_MAX_TILE_SOURCE_CACHE_BYTES.load(Ordering::Relaxed);
    guard.publish(epoch, source_key, &bytes, max_cache_bytes)?;

    Ok(bytes)
}

fn invalidate_tile_source_cache() {
    let cache = JPEG_TILE_SOURCE_CACHE.get_or_init(|| Mutex::new(JpegSourceCache::default()));
    let mut guard = cache.lock().unwrap_or_else(|error| error.into_inner());
    guard.invalidate();
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
    oriented_image_dimensions_for_operation(file_path, OperationClass::MetadataOnly)
}

pub(crate) fn oriented_image_dimensions_for_operation(
    file_path: &Path,
    operation: OperationClass,
) -> Result<(u32, u32), String> {
    oriented_decoder_resource_for_operation(file_path, operation)
        .map(|(width, height, _)| (width, height))
}

fn oriented_decoder_resource_for_operation(
    file_path: &Path,
    operation: OperationClass,
) -> Result<(u32, u32, u64), String> {
    let source = image_resource_policy::ImageSource::open(file_path, operation)
        .map_err(|error| policy_error(operation, error))?;
    let mut decoder = image_resource_policy::decoder_for_source(&source, operation)
        .map_err(|error| format!("Failed to decode image dimensions: {error}"))?;
    let (width, height) = decoder.dimensions();
    let orientation = decoder
        .orientation()
        .map_err(|error| format!("Failed to read image orientation: {}", error))?;
    let decoder_bytes = decoder.total_bytes();
    // This helper only inspects the codec header and orientation. Constructor/input admission
    // already ran in `decoder_for_source`; apply dimension/pixel ceilings here, while leaving
    // full-frame working-memory admission to paths that actually call `from_decoder`.
    let limits = image_resource_policy::PolicyLimits::for_operation(operation);
    image_resource_policy::validate_dimensions(width, height, &limits)
        .map_err(|error| policy_error(operation, error))?;
    let (width, height) = oriented_dimensions(width, height, orientation);
    Ok((width, height, decoder_bytes))
}

#[cfg(test)]
fn decode_image_with_orientation(file_path: &Path) -> Result<DynamicImage, image::ImageError> {
    decode_image_with_orientation_for_operation(file_path, OperationClass::Preview)
}

#[derive(Debug)]
enum ReducedJpegDecode {
    NotApplicable,
    Reduced(DynamicImage),
    Fallback,
}

fn is_jpeg_path(file_path: &Path) -> bool {
    matches!(normalized_extension(file_path).as_deref(), Some("jpg" | "jpeg"))
}

fn reduced_jpeg_policy_error(
    operation: OperationClass,
    error: image_resource_policy::ResourcePolicyError,
) -> image::ImageError {
    image_resource_policy::record_rejection(operation);
    image::ImageError::IoError(std::io::Error::other(error))
}

/// Decode a JPEG with libjpeg-turbo's native 1/2/4/8 IDCT scale. This intentionally handles
/// sequential 8-bit RGB/YCbCr and grayscale JPEGs; progressive, lossless, non-8-bit, CMYK/YCCK,
/// and codec failures use the existing full decoder so their established colour and error
/// semantics remain intact.
fn try_decode_reduced_jpeg(
    file_path: &Path,
    operation: OperationClass,
    requested_max_dimension: u32,
) -> Result<ReducedJpegDecode, image::ImageError> {
    if !is_jpeg_path(file_path) {
        return Ok(ReducedJpegDecode::NotApplicable);
    }

    let source = match image_resource_policy::ImageSource::open(file_path, operation) {
        Ok(source) => source,
        Err(_) => return Ok(ReducedJpegDecode::Fallback),
    };
    let encoded_len = source.encoded_len();
    let source_bytes = match source.read_bytes() {
        Ok(bytes) => bytes,
        Err(_) => return Ok(ReducedJpegDecode::Fallback),
    };
    image_resource_policy::validate_decoder_input_reservation(encoded_len, operation)
        .map_err(|error| reduced_jpeg_policy_error(operation, error))?;
    let (orientation_width, orientation_height, orientation) = match jpeg_orientation(&source_bytes)
    {
        Ok(value) => value,
        Err(_) => return Ok(ReducedJpegDecode::Fallback),
    };
    image_resource_policy::validate_dimensions(
        orientation_width,
        orientation_height,
        &image_resource_policy::PolicyLimits::for_operation(operation),
    )
    .map_err(|error| reduced_jpeg_policy_error(operation, error))?;
    let mut decoder = match libjpeg_turbo_rs::Decoder::new(&source_bytes) {
        Ok(decoder) => decoder,
        Err(_) => return Ok(ReducedJpegDecode::Fallback),
    };
    let header = decoder.header();
    let source_width = u32::from(header.width);
    let source_height = u32::from(header.height);
    if source_width != orientation_width || source_height != orientation_height {
        return Ok(ReducedJpegDecode::Fallback);
    }
    // Progressive JPEG retains one 64-coefficient i16 block per component block until all
    // scans are complete (roughly 3-6 source bytes per pixel depending on subsampling). The
    // reduced path's estimate intentionally covers sequential JPEG only; progressive, lossless,
    // and non-8-bit streams use the existing bounded full decoder/fallback semantics.
    if header.is_progressive || header.is_lossless || header.precision != 8 {
        return Ok(ReducedJpegDecode::Fallback);
    }
    let scale = select_jpeg_decode_scale(source_width, source_height, requested_max_dimension);
    let JpegDecodeScale::Reduced(factor) = scale else {
        return Ok(ReducedJpegDecode::NotApplicable);
    };

    let color_space = decoder.jpeg_color_space();
    let (pixel_format, bytes_per_pixel) = match color_space {
        libjpeg_turbo_rs::ColorSpace::Grayscale => (libjpeg_turbo_rs::PixelFormat::Grayscale, 1),
        libjpeg_turbo_rs::ColorSpace::Rgb | libjpeg_turbo_rs::ColorSpace::YCbCr => {
            (libjpeg_turbo_rs::PixelFormat::Rgb, 3)
        }
        libjpeg_turbo_rs::ColorSpace::Cmyk
        | libjpeg_turbo_rs::ColorSpace::Ycck
        | libjpeg_turbo_rs::ColorSpace::Unknown => return Ok(ReducedJpegDecode::Fallback),
    };
    let decoded_width = source_width.div_ceil(factor);
    let decoded_height = source_height.div_ceil(factor);
    let component_sampling = header
        .components
        .iter()
        .map(|component| image_resource_policy::JpegComponentSampling {
            horizontal: component.horizontal_sampling,
            vertical: component.vertical_sampling,
        })
        .collect::<Vec<_>>();
    image_resource_policy::validate_scaled_decoder_memory(
        (source_width, source_height),
        (decoded_width, decoded_height),
        encoded_len,
        bytes_per_pixel,
        factor,
        &component_sampling,
        operation,
    )
    .map_err(|error| reduced_jpeg_policy_error(operation, error))?;

    decoder.set_scale(libjpeg_turbo_rs::ScalingFactor::new(1, factor));
    decoder.set_output_format(pixel_format);
    let decoded = match decoder.decode_image() {
        Ok(decoded) => decoded,
        Err(_) => return Ok(ReducedJpegDecode::Fallback),
    };
    // DynamicImage's JPEG encoder cannot carry an embedded ICC profile. Preserve the existing
    // profile-aware full path rather than publishing a reduced asset with changed colour intent.
    if decoded.icc_profile.is_some() {
        return Ok(ReducedJpegDecode::Fallback);
    }
    let decoded_width = u32::try_from(decoded.width).map_err(|_| {
        reduced_jpeg_policy_error(
            operation,
            image_resource_policy::ResourcePolicyError::AllocationTooLargeForPlatform,
        )
    })?;
    let decoded_height = u32::try_from(decoded.height).map_err(|_| {
        reduced_jpeg_policy_error(
            operation,
            image_resource_policy::ResourcePolicyError::AllocationTooLargeForPlatform,
        )
    })?;
    let mut image = match decoded.pixel_format {
        libjpeg_turbo_rs::PixelFormat::Grayscale => {
            image::GrayImage::from_raw(decoded_width, decoded_height, decoded.data)
                .map(DynamicImage::ImageLuma8)
        }
        libjpeg_turbo_rs::PixelFormat::Rgb => {
            image::RgbImage::from_raw(decoded_width, decoded_height, decoded.data)
                .map(DynamicImage::ImageRgb8)
        }
        _ => None,
    };
    let Some(mut image) = image.take() else {
        return Ok(ReducedJpegDecode::Fallback);
    };
    image.apply_orientation(orientation);
    Ok(ReducedJpegDecode::Reduced(image))
}

#[cfg(test)]
fn decode_image_with_orientation_for_operation(
    file_path: &Path,
    operation: OperationClass,
) -> Result<DynamicImage, image::ImageError> {
    decode_image_with_orientation_with_preview_limit(file_path, operation, None)
}

fn decode_image_with_orientation_for_preview(
    file_path: &Path,
    max_dimension: u32,
) -> Result<DynamicImage, image::ImageError> {
    decode_image_with_orientation_with_preview_limit(
        file_path,
        OperationClass::Preview,
        Some(max_dimension),
    )
}

fn decode_image_with_orientation_with_preview_limit(
    file_path: &Path,
    operation: OperationClass,
    preview_max_dimension: Option<u32>,
) -> Result<DynamicImage, image::ImageError> {
    image_checkpoint()?;

    if let Some(max_dimension) = preview_max_dimension {
        match try_decode_reduced_jpeg(file_path, operation, max_dimension)? {
            ReducedJpegDecode::Reduced(image) => {
                record_jpeg_reduced_decode(operation, image.width(), image.height());
                return Ok(image);
            }
            ReducedJpegDecode::Fallback => {
                record_jpeg_fallback();
            }
            ReducedJpegDecode::NotApplicable => {}
        }
    }
    let source =
        image_resource_policy::ImageSource::open(file_path, operation).map_err(|error| {
            image_resource_policy::record_rejection(operation);
            image::ImageError::IoError(std::io::Error::other(error))
        })?;
    let mut decoder = image_resource_policy::decoder_for_source(&source, operation)?;
    let (width, height) = decoder.dimensions();
    let decoder_bytes = decoder.total_bytes();
    image_resource_policy::validate_decoder_memory_with_source(
        width,
        height,
        decoder_bytes,
        source.encoded_len(),
        operation,
    )
    .map_err(|error| {
        image_resource_policy::record_rejection(operation);
        image::ImageError::IoError(std::io::Error::other(error))
    })?;
    let orientation = decoder.orientation()?;
    if let Some(max_dimension) = preview_max_dimension {
        let (oriented_width, oriented_height) = oriented_dimensions(width, height, orientation);
        if oriented_width > max_dimension || oriented_height > max_dimension {
            let output_dimensions = image_resource_policy::preview_resize_dimensions(
                oriented_width,
                oriented_height,
                max_dimension,
            );
            image_resource_policy::validate_preview_resize_memory(
                (oriented_width, oriented_height),
                output_dimensions,
                u64::from(decoder.color_type().bytes_per_pixel()),
                source.encoded_len(),
                decoder_bytes,
            )
            .map_err(|error| {
                image_resource_policy::record_rejection(operation);
                image::ImageError::IoError(std::io::Error::other(error))
            })?;
        }
    }
    image_checkpoint()?;
    let mut image = DynamicImage::from_decoder(decoder)?;
    image_checkpoint()?;
    image.apply_orientation(orientation);
    if is_jpeg_path(file_path) {
        record_jpeg_full_decode(image.width(), image.height());
    }
    Ok(image)
}

fn image_checkpoint() -> Result<(), image::ImageError> {
    crate::media_executor::checkpoint()
        .map_err(|error| image::ImageError::IoError(std::io::Error::other(error)))
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
    crate::media_executor::checkpoint()?;
    let limits = image_resource_policy::PolicyLimits::for_operation(OperationClass::Tile);
    image_resource_policy::validate_input_bytes(source.len() as u64, &limits)
        .map_err(|error| policy_error(OperationClass::Tile, error))?;
    let (raw_width, raw_height, orientation) = jpeg_orientation(source)?;
    image_resource_policy::validate_dimensions(raw_width, raw_height, &limits)
        .map_err(|error| policy_error(OperationClass::Tile, error))?;
    let raw_bounds = raw_tile_bounds(bounds, raw_width, raw_height, orientation);
    validate_jpeg_tile_scratch(source, raw_bounds)?;
    image_resource_policy::validate_output_dimensions(raw_bounds.width, raw_bounds.height, &limits)
        .map_err(|error| policy_error(OperationClass::Tile, error))?;
    image_resource_policy::validate_working_memory(
        raw_bounds.width,
        raw_bounds.height,
        3,
        2,
        &limits,
    )
    .map_err(|error| policy_error(OperationClass::Tile, error))?;
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

    crate::media_executor::checkpoint()?;
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

    crate::media_executor::checkpoint()?;
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

fn validate_jpeg_tile_scratch(source: &[u8], bounds: TileBounds) -> Result<(), String> {
    // libjpeg-turbo-rs 0.6 allocates full MCU-aligned component planes even for cropped
    // decoding. Progressive/lossless modes also retain coefficients or full output. A small
    // requested tile alone is therefore insufficient admission evidence.
    let decoder = libjpeg_turbo_rs::Decoder::new(source)
        .map_err(|error| format!("Failed to inspect JPEG tile: {error}"))?;
    let header = decoder.header();
    let max_h = header
        .components
        .iter()
        .map(|c| u64::from(c.horizontal_sampling))
        .max()
        .unwrap_or(1)
        .max(1);
    let max_v =
        header.components.iter().map(|c| u64::from(c.vertical_sampling)).max().unwrap_or(1).max(1);
    let mcus_x = u64::from(header.width).div_ceil(max_h * 8);
    let mcus_y = u64::from(header.height).div_ceil(max_v * 8);
    let estimate = || -> Result<u64, image_resource_policy::ResourcePolicyError> {
        use image_resource_policy::ResourcePolicyError;
        let mut planes = 0u64;
        for component in &header.components {
            let bytes = image_resource_policy::checked_allocation_bytes(
                mcus_x * u64::from(component.horizontal_sampling) * 8,
                mcus_y * u64::from(component.vertical_sampling) * 8,
                1,
                1,
            )?;
            planes = planes.checked_add(bytes).ok_or(ResourcePolicyError::AllocationOverflow)?;
        }
        let plane_count =
            if header.is_progressive || header.is_lossless || header.precision > 8 { 8 } else { 3 };
        let output = image_resource_policy::checked_allocation_bytes(
            u64::from(bounds.width) + 32,
            u64::from(header.height),
            8,
            1,
        )?;
        let tile = image_resource_policy::checked_allocation_bytes(
            u64::from(bounds.width) + 32,
            u64::from(bounds.height) + 32,
            16,
            1,
        )?;
        planes
            .checked_mul(plane_count)
            .and_then(|n| n.checked_add((source.len() as u64).checked_mul(4)?))
            .and_then(|n| n.checked_add(output))
            .and_then(|n| n.checked_add(tile))
            .ok_or(ResourcePolicyError::AllocationOverflow)
    };
    let bytes = estimate().map_err(|error| policy_error(OperationClass::Tile, error))?;
    let max =
        image_resource_policy::PolicyLimits::for_operation(OperationClass::Tile).max_working_bytes;
    if bytes > max {
        return Err(policy_error(
            OperationClass::Tile,
            image_resource_policy::ResourcePolicyError::WorkingBytesExceedLimit { bytes, max },
        ));
    }
    Ok(())
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
    generation: &CacheGeneration,
    root: &Path,
    cache_hash: &str,
    format: GeneratedImageFormat,
    bytes: &[u8],
    dimensions: Option<(u32, u32)>,
) -> Result<GeneratedImageAsset, String> {
    generation.checkpoint()?;
    let asset_path = generated_asset_path(root, cache_hash, format);
    if asset_path.is_file() {
        return Ok(build_generated_image_asset(&asset_path, cache_hash, format, dimensions));
    }

    write_cache_file(generation, &asset_path, bytes).map_err(|error| {
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
    generation: &CacheGeneration,
    cache_root: &Path,
    cache_available: bool,
    cache_hash: &str,
    format: GeneratedImageFormat,
    bytes: &[u8],
    dimensions: Option<(u32, u32)>,
) -> Result<GeneratedImageAsset, String> {
    generation.checkpoint()?;
    if cache_available {
        match store_generated_asset(generation, cache_root, cache_hash, format, bytes, dimensions) {
            Ok(asset) => return Ok(asset),
            Err(error) => {
                generation.checkpoint()?;
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

    store_generated_asset(generation, &temp_root, cache_hash, format, bytes, dimensions)
}

fn cache_asset_text(
    generation: &CacheGeneration,
    cache_root: &Path,
    cache_available: bool,
    cache_hash: &str,
    format: GeneratedImageFormat,
    content: &str,
    dimensions: Option<(u32, u32)>,
) -> Result<GeneratedImageAsset, String> {
    cache_asset_bytes(
        generation,
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
        jpeg_reduced_thumbnail_decodes: JPEG_REDUCED_THUMBNAIL_COUNT.load(Ordering::Relaxed),
        jpeg_reduced_preview_decodes: JPEG_REDUCED_PREVIEW_COUNT.load(Ordering::Relaxed),
        jpeg_full_decodes: JPEG_FULL_DECODE_COUNT.load(Ordering::Relaxed),
        jpeg_fallback_decodes: JPEG_FALLBACK_COUNT.load(Ordering::Relaxed),
        jpeg_reduced_max_output_width: JPEG_REDUCED_MAX_WIDTH.load(Ordering::Relaxed),
        jpeg_reduced_max_output_height: JPEG_REDUCED_MAX_HEIGHT.load(Ordering::Relaxed),
        jpeg_full_max_output_width: JPEG_FULL_MAX_WIDTH.load(Ordering::Relaxed),
        jpeg_full_max_output_height: JPEG_FULL_MAX_HEIGHT.load(Ordering::Relaxed),
        placeholder_thumbnail_generations: PLACEHOLDER_THUMBNAIL_COUNT.load(Ordering::Relaxed),
        placeholder_preview_generations,
        tile_generations: TILE_GENERATED_COUNT.load(Ordering::Relaxed),
        resource_policy_rejections: image_resource_policy::rejection_count(),
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

fn write_cache_file(
    generation: &CacheGeneration,
    cache_file: &Path,
    bytes: &[u8],
) -> Result<(), std::io::Error> {
    let Some(parent) = cache_file.parent() else {
        return Err(std::io::Error::other("Generated cache file needs a parent directory"));
    };

    fs::create_dir_all(parent)?;

    let tmp_suffix = CACHE_TMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_path = parent.join(format!(
        "{}.{}.tmp",
        cache_file.file_name().and_then(|value| value.to_str()).unwrap_or("generated-image"),
        tmp_suffix
    ));
    let result = (|| {
        fs::write(&tmp_path, bytes)?;
        generation.validate_source().map_err(std::io::Error::other)?;
        // Only the atomic publication is serialized with retirement; encoding and writes
        // happen outside the lock. Never delete a valid destination on rename failure.
        let state = generation.state.lock().unwrap_or_else(|error| error.into_inner());
        generation.validate(&state).map_err(std::io::Error::other)?;
        if cache_file.is_file() {
            return Ok(());
        }
        fs::rename(&tmp_path, cache_file)
    })();
    let _ = fs::remove_file(&tmp_path);
    result
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
    let state = cache_root_state(cache_root);
    {
        let mut guard = state.lock().unwrap_or_else(|error| error.into_inner());
        if guard.retiring {
            return Err("Generated cache is already being cleared".into());
        }
        guard.epoch = guard.epoch.wrapping_add(1);
        guard.retiring = true;
    }
    // Retire the namespace before scanning. New publishers cannot enter it until removal
    // finishes, and pre-clear jobs retain the old epoch forever. Preserve unrelated files.
    if cache_root.file_name().is_some_and(|name| name == "tiles") {
        invalidate_tile_source_cache();
    }
    let result = (|| {
        for (path, _) in generated_cache_entries(cache_root)? {
            fs::remove_file(&path)
                .map_err(|error| format!("Failed to remove '{}': {}", path.display(), error))?;
        }
        Ok(())
    })();
    state.lock().unwrap_or_else(|error| error.into_inner()).retiring = false;
    result
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
    let Ok(generation) = CacheGeneration::capture(cache_root) else {
        return;
    };
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
        let state = generation.state.lock().unwrap_or_else(|error| error.into_inner());
        if generation.validate(&state).is_err() {
            return;
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

    #[test]
    fn reduced_decode_scale_uses_safe_power_of_two_boundaries() {
        assert_eq!(select_jpeg_decode_scale(159, 80, 160), JpegDecodeScale::Full);
        assert_eq!(select_jpeg_decode_scale(320, 160, 160), JpegDecodeScale::Reduced(2));
        assert_eq!(select_jpeg_decode_scale(640, 320, 160), JpegDecodeScale::Reduced(4));
        assert_eq!(select_jpeg_decode_scale(1_280, 640, 160), JpegDecodeScale::Reduced(8));
        assert_eq!(select_jpeg_decode_scale(1_281, 640, 160), JpegDecodeScale::Reduced(8));
    }

    #[test]
    fn reduced_decode_wide_jpeg_public_assets_resize_intermediate_frames() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("wide.jpg");
        image::RgbImage::from_pixel(20_000, 64, image::Rgb([40, 80, 120])).save(&source).unwrap();
        let metadata = resolve_source_metadata(&source, None, None).unwrap();

        let (thumbnail, events) = ScopedJpegTelemetryRecorder::capture(|| {
            get_or_create_thumbnail(&source, &metadata, &dir.path().join("thumbnails"))
        });
        let thumbnail = thumbnail.unwrap();
        let dimensions = image::image_dimensions(&thumbnail.file_path).unwrap();
        assert_eq!(dimensions, (THUMBNAIL_SIZE, 1));
        assert_eq!(
            events,
            vec![JpegTelemetryEvent::Reduced {
                operation: OperationClass::Thumbnail,
                width: 2_500,
                height: 8,
            }]
        );

        let (preview, events) = ScopedJpegTelemetryRecorder::capture(|| {
            get_or_create_preview(&source, &metadata, &dir.path().join("previews"), 8_192, None)
        });
        let preview = preview.unwrap();
        let dimensions = image::image_dimensions(&preview.file_path).unwrap();
        assert_eq!(dimensions, image_resource_policy::preview_resize_dimensions(10_000, 32, 8_192));
        assert_eq!(
            events,
            vec![JpegTelemetryEvent::Reduced {
                operation: OperationClass::Preview,
                width: 10_000,
                height: 32,
            }]
        );

        let rejected_cache = dir.path().join("oversized-preview");
        let (rejected, events) = ScopedJpegTelemetryRecorder::capture(|| {
            get_or_create_preview(&source, &metadata, &rejected_cache, 8_193, None)
        });
        assert!(rejected.unwrap_err().contains("8193"));
        assert!(events.is_empty(), "oversized requests must fail before decoding");
        assert!(!rejected_cache.exists());
    }

    #[test]
    fn reduced_decode_preserves_orientation_and_bound_detail() {
        let dir = tempfile::tempdir().unwrap();
        let image_path = dir.path().join("reduced-oriented.jpg");
        image::RgbImage::from_fn(1_280, 640, |x, y| image::Rgb([x as u8, y as u8, 17]))
            .save(&image_path)
            .unwrap();
        write_orientation(&image_path, 6);

        let decoded = try_decode_reduced_jpeg(&image_path, OperationClass::Preview, 160).unwrap();
        let ReducedJpegDecode::Reduced(decoded) = decoded else {
            panic!("expected reduced JPEG decode");
        };
        // 1/8 native decode is 160x80 in source space, then EXIF 90-degree rotation swaps it.
        assert_eq!(decoded.dimensions(), (80, 160));
    }

    #[test]
    fn reduced_decode_preserves_grayscale_output_semantics() {
        let dir = tempfile::tempdir().unwrap();
        let image_path = dir.path().join("reduced-gray.jpg");
        image::GrayImage::from_fn(1_280, 640, |x, y| image::Luma([(x ^ y) as u8]))
            .save(&image_path)
            .unwrap();

        let decoded = try_decode_reduced_jpeg(&image_path, OperationClass::Preview, 160).unwrap();
        let ReducedJpegDecode::Reduced(decoded) = decoded else {
            panic!("expected reduced grayscale JPEG decode");
        };
        assert_eq!(decoded.dimensions(), (160, 80));
        assert!(matches!(decoded, DynamicImage::ImageLuma8(_)));
    }

    #[test]
    fn reduced_decode_falls_back_for_cmyk_jpeg() {
        let dir = tempfile::tempdir().unwrap();
        let image_path = dir.path().join("cmyk.jpg");
        let pixels = (0..(320 * 160)).flat_map(|_| [32_u8, 64, 96, 128]).collect::<Vec<_>>();
        let bytes = libjpeg_turbo_rs::compress(
            &pixels,
            320,
            160,
            libjpeg_turbo_rs::PixelFormat::Cmyk,
            85,
            libjpeg_turbo_rs::Subsampling::S444,
        )
        .unwrap();
        fs::write(&image_path, bytes).unwrap();

        assert!(matches!(
            try_decode_reduced_jpeg(&image_path, OperationClass::Preview, 160).unwrap(),
            ReducedJpegDecode::Fallback
        ));
    }

    #[test]
    fn reduced_decode_falls_back_for_genuine_ycck_jpeg() {
        let dir = tempfile::tempdir().unwrap();
        let image_path = dir.path().join("ycck.jpg");
        let bytes = test_ycck_jpeg();
        let decoder = libjpeg_turbo_rs::Decoder::new(&bytes).unwrap();
        assert_eq!(decoder.jpeg_color_space(), libjpeg_turbo_rs::ColorSpace::Ycck);
        fs::write(&image_path, bytes).unwrap();

        let (result, events) = ScopedJpegTelemetryRecorder::capture(|| {
            decode_image_with_orientation_with_preview_limit(
                &image_path,
                OperationClass::Preview,
                Some(8),
            )
        });
        match result {
            Ok(image) => assert_eq!(
                events,
                vec![
                    JpegTelemetryEvent::Fallback,
                    JpegTelemetryEvent::Full { width: image.width(), height: image.height() },
                ],
                "YCCK must use bounded fallback telemetry before full decode"
            ),
            Err(_) => assert_eq!(
                events,
                vec![JpegTelemetryEvent::Fallback],
                "YCCK rejection must report only the bounded fallback attempt"
            ),
        }
    }

    #[test]
    fn jpeg_telemetry_records_reduced_fallback_full_and_oriented_dimensions() {
        let dir = tempfile::tempdir().unwrap();
        let reduced_path = dir.path().join("telemetry-reduced.jpg");
        fs::write(
            &reduced_path,
            libjpeg_turbo_rs::compress(
                &test_rgb_pixels(128, 96),
                128,
                96,
                libjpeg_turbo_rs::PixelFormat::Rgb,
                90,
                libjpeg_turbo_rs::Subsampling::S444,
            )
            .unwrap(),
        )
        .unwrap();
        write_orientation(&reduced_path, 6);
        let (reduced, reduced_events) = ScopedJpegTelemetryRecorder::capture(|| {
            decode_image_with_orientation_with_preview_limit(
                &reduced_path,
                OperationClass::Preview,
                Some(16),
            )
        });
        let reduced = reduced.unwrap();
        assert_eq!(reduced.dimensions(), (12, 16));
        assert_eq!(
            reduced_events,
            vec![JpegTelemetryEvent::Reduced {
                operation: OperationClass::Preview,
                width: 12,
                height: 16,
            }]
        );

        let fallback_path = dir.path().join("telemetry-fallback.jpg");
        let progressive = libjpeg_turbo_rs::compress_progressive(
            &test_rgb_pixels(64, 32),
            64,
            32,
            libjpeg_turbo_rs::PixelFormat::Rgb,
            90,
            libjpeg_turbo_rs::Subsampling::S444,
        )
        .unwrap();
        fs::write(&fallback_path, progressive).unwrap();
        let (full, full_events) = ScopedJpegTelemetryRecorder::capture(|| {
            decode_image_with_orientation_with_preview_limit(
                &fallback_path,
                OperationClass::Preview,
                Some(16),
            )
        });
        let full = full.unwrap();
        assert_eq!(full.dimensions(), (64, 32));
        assert_eq!(
            full_events,
            vec![JpegTelemetryEvent::Fallback, JpegTelemetryEvent::Full { width: 64, height: 32 },]
        );
    }

    #[test]
    fn reduced_decode_falls_back_for_progressive_jpeg() {
        let dir = tempfile::tempdir().unwrap();
        let image_path = dir.path().join("progressive.jpg");
        let pixels = (0..(320 * 160)).flat_map(|index| [index as u8, 64, 128]).collect::<Vec<_>>();
        let bytes = libjpeg_turbo_rs::compress_progressive(
            &pixels,
            320,
            160,
            libjpeg_turbo_rs::PixelFormat::Rgb,
            85,
            libjpeg_turbo_rs::Subsampling::S444,
        )
        .unwrap();
        fs::write(&image_path, bytes).unwrap();

        assert!(matches!(
            try_decode_reduced_jpeg(&image_path, OperationClass::Preview, 160).unwrap(),
            ReducedJpegDecode::Fallback
        ));
    }

    #[test]
    fn reduced_decode_falls_back_when_icc_profile_cannot_be_republished() {
        let dir = tempfile::tempdir().unwrap();
        let image_path = dir.path().join("profiled.jpg");
        let pixels = vec![128_u8; 320 * 160 * 3];
        let bytes = libjpeg_turbo_rs::compress_with_metadata(
            &pixels,
            320,
            160,
            libjpeg_turbo_rs::PixelFormat::Rgb,
            85,
            libjpeg_turbo_rs::Subsampling::S444,
            Some(&[1_u8, 2, 3, 4]),
            None,
        )
        .unwrap();
        fs::write(&image_path, bytes).unwrap();

        assert!(matches!(
            try_decode_reduced_jpeg(&image_path, OperationClass::Preview, 160).unwrap(),
            ReducedJpegDecode::Fallback
        ));
    }

    #[test]
    fn reduced_decode_falls_back_for_truncated_jpeg() {
        let dir = tempfile::tempdir().unwrap();
        let image_path = dir.path().join("truncated.jpg");
        image::RgbImage::from_pixel(640, 320, image::Rgb([12, 34, 56])).save(&image_path).unwrap();
        let mut bytes = fs::read(&image_path).unwrap();
        bytes.truncate(bytes.len().saturating_sub(32));
        fs::write(&image_path, bytes).unwrap();

        assert!(matches!(
            try_decode_reduced_jpeg(&image_path, OperationClass::Preview, 160).unwrap(),
            ReducedJpegDecode::Fallback
        ));
    }

    #[test]
    fn reduced_decode_rejects_source_before_codec_allocation() {
        let dir = tempfile::tempdir().unwrap();
        let image_path = dir.path().join("oversized-header.jpg");
        image::RgbImage::new(16, 16).save(&image_path).unwrap();
        let mut bytes = fs::read(&image_path).unwrap();
        let sof = bytes
            .windows(2)
            .position(|marker| marker == [0xff, 0xc0])
            .expect("test JPEG must contain a baseline SOF marker");
        bytes[sof + 5..sof + 7].copy_from_slice(&20_000_u16.to_be_bytes());
        bytes[sof + 7..sof + 9].copy_from_slice(&20_000_u16.to_be_bytes());
        fs::write(&image_path, bytes).unwrap();

        let error = try_decode_reduced_jpeg(&image_path, OperationClass::Preview, 160)
            .expect_err("oversized source must be rejected before native decode");
        assert!(format!("{error}").contains("pixel count"));
    }

    #[test]
    fn reduced_decode_matches_full_decode_for_rgb_ycbcr_scales() {
        let dir = tempfile::tempdir().unwrap();
        for subsampling in
            [libjpeg_turbo_rs::Subsampling::S444, libjpeg_turbo_rs::Subsampling::S420]
        {
            let image_path = dir.path().join(format!("rgb-{:?}.jpg", subsampling));
            let pixels = test_rgb_pixels(128, 96);
            let bytes = libjpeg_turbo_rs::compress(
                &pixels,
                128,
                96,
                libjpeg_turbo_rs::PixelFormat::Rgb,
                90,
                subsampling,
            )
            .unwrap();
            let decoder = libjpeg_turbo_rs::Decoder::new(&bytes).unwrap();
            assert!(matches!(
                decoder.jpeg_color_space(),
                libjpeg_turbo_rs::ColorSpace::Rgb | libjpeg_turbo_rs::ColorSpace::YCbCr
            ));
            fs::write(&image_path, bytes).unwrap();

            for requested_max_dimension in [128, 64, 32, 16] {
                let reduced = bounded_test_decode(&image_path, requested_max_dimension);
                let full = bounded_full_test_decode(&image_path, requested_max_dimension);
                // Native IDCT scaling and full-resolution Triangle resize use different
                // rounding. Require a bounded 8-bit channel delta and a much tighter mean.
                assert_images_within_tolerance(&reduced, &full, 64, 8.0);
            }
        }
    }

    #[test]
    fn reduced_decode_matches_full_decode_for_grayscale_and_exif_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let grayscale_path = dir.path().join("gray-scale.jpg");
        let grayscale = test_gray_pixels(128, 96);
        fs::write(
            &grayscale_path,
            libjpeg_turbo_rs::compress(
                &grayscale,
                128,
                96,
                libjpeg_turbo_rs::PixelFormat::Grayscale,
                90,
                libjpeg_turbo_rs::Subsampling::S444,
            )
            .unwrap(),
        )
        .unwrap();
        for requested_max_dimension in [128, 64, 32, 16] {
            let reduced = bounded_test_decode(&grayscale_path, requested_max_dimension);
            let full = bounded_full_test_decode(&grayscale_path, requested_max_dimension);
            assert_images_within_tolerance(&reduced, &full, 64, 6.0);
        }

        let rotated_path = dir.path().join("rotated-scale.jpg");
        fs::write(
            &rotated_path,
            libjpeg_turbo_rs::compress(
                &test_rgb_pixels(128, 96),
                128,
                96,
                libjpeg_turbo_rs::PixelFormat::Rgb,
                90,
                libjpeg_turbo_rs::Subsampling::S444,
            )
            .unwrap(),
        )
        .unwrap();
        write_orientation(&rotated_path, 6);
        for requested_max_dimension in [128, 64, 32, 16] {
            let reduced = bounded_test_decode(&rotated_path, requested_max_dimension);
            let full = bounded_full_test_decode(&rotated_path, requested_max_dimension);
            assert_images_within_tolerance(&reduced, &full, 64, 8.0);
        }
    }

    #[test]
    fn cache_epoch_survives_first_directory_creation_and_changes_on_clear() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("previews");
        let first = CacheGeneration::capture(&root).unwrap();
        fs::create_dir_all(&root).unwrap();
        let created = CacheGeneration::capture(&root).unwrap();
        assert!(Arc::ptr_eq(&first.state, &created.state));
        clear_generated_cache_root(&root).unwrap();
        assert!(first.checkpoint().is_err());
        assert_ne!(CacheGeneration::capture(&root).unwrap().epoch(), first.epoch);
    }

    fn assert_queued_before_clear_rejected<F, G>(
        priority: crate::media_executor::Priority,
        root: &Path,
        stale_work: F,
        replacement_work: G,
    ) where
        F: FnOnce() -> Result<GeneratedImageAsset, String> + Send + 'static,
        G: FnOnce() -> Result<GeneratedImageAsset, String>,
    {
        use crate::media_executor::{MediaExecutor, Priority};
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        let executor = MediaExecutor::new(2);
        let (started_tx, started_rx) = mpsc::channel();
        let mut blockers = Vec::new();
        for _ in 0..2 {
            let worker = executor.clone();
            let started = started_tx.clone();
            let (release_tx, release_rx) = mpsc::channel();
            let handle = std::thread::spawn(move || {
                tokio::runtime::Runtime::new().unwrap().block_on(worker.execute(
                    None,
                    Priority::CurrentPreview,
                    None,
                    move || {
                        started.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(())
                    },
                ))
            });
            blockers.push((release_tx, handle));
        }
        for _ in 0..2 {
            started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        }

        let worker = executor.clone();
        let queued = std::thread::spawn(move || {
            tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(worker.execute(None, priority, None, stale_work))
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while executor.stats().queue_depth == 0 && Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(executor.stats().queue_depth, 1);
        clear_generated_cache_root(root).unwrap();
        for (release, _) in &blockers {
            release.send(()).unwrap();
        }
        for (_, handle) in blockers {
            handle.join().unwrap().unwrap();
        }
        let error = queued.join().unwrap().unwrap_err();
        assert!(error.contains("stale"), "unexpected error: {error}");
        assert!(!root.exists() || fs::read_dir(root).unwrap().next().is_none());
        let replacement = replacement_work().unwrap();
        assert!(Path::new(&replacement.file_path).exists());
        executor.shutdown();
    }

    #[test]
    fn queued_generated_assets_keep_admission_generation_across_clear() {
        use crate::media_executor::Priority;
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("photo.jpg");
        image::RgbImage::from_pixel(256, 256, image::Rgb([40, 80, 120])).save(&source).unwrap();
        let metadata = resolve_source_metadata(&source, None, None).unwrap();

        let thumbnail_root = dir.path().join("thumbnails");
        let generation = CacheGeneration::capture(&thumbnail_root).unwrap();
        let stale_source = source.clone();
        let stale_metadata = metadata.clone();
        let stale_root = thumbnail_root.clone();
        assert_queued_before_clear_rejected(
            Priority::VisibleThumbnail,
            &thumbnail_root,
            move || {
                get_or_create_thumbnail_with_generation(
                    &stale_source,
                    &stale_metadata,
                    &stale_root,
                    generation,
                )
            },
            || get_or_create_thumbnail(&source, &metadata, &thumbnail_root),
        );

        let preview_root = dir.path().join("previews");
        let generation = CacheGeneration::capture(&preview_root).unwrap();
        let stale_source = source.clone();
        let stale_metadata = metadata.clone();
        let stale_root = preview_root.clone();
        assert_queued_before_clear_rejected(
            Priority::CurrentPreview,
            &preview_root,
            move || {
                get_or_create_preview_with_generation(
                    &stale_source,
                    &stale_metadata,
                    &stale_root,
                    64,
                    None,
                    generation,
                )
            },
            || get_or_create_preview(&source, &metadata, &preview_root, 64, None),
        );

        let tile_root = dir.path().join("tiles");
        let generation = CacheGeneration::capture(&tile_root).unwrap();
        let stale_source = source.clone();
        let stale_metadata = metadata.clone();
        let stale_root = tile_root.clone();
        let request = TileRequest {
            source_width: 256,
            source_height: 256,
            tile_size: 128,
            tile_x: 0,
            tile_y: 0,
        };
        assert_queued_before_clear_rejected(
            Priority::CurrentFull,
            &tile_root,
            move || {
                get_or_create_tile_with_generation(
                    &stale_source,
                    &stale_metadata,
                    &stale_root,
                    request,
                    generation,
                )
            },
            || get_or_create_tile(&source, &metadata, &tile_root, request),
        );
    }

    #[test]
    fn canceled_running_producer_removes_staged_output() {
        use crate::media_executor::{MediaExecutor, MediaRequest, Priority};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("previews");
        let path = root.join(cache_file_name_for_index(1, "jpg"));
        let executor = MediaExecutor::new(2);
        let worker_executor = executor.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let output = path.clone();
        let producer = std::thread::spawn(move || {
            tokio::runtime::Runtime::new().unwrap().block_on(worker_executor.execute(
                Some(MediaRequest {
                    request_id: "canceled-cache-publication".into(),
                    generation_token: None,
                    priority: Priority::CurrentPreview,
                }),
                Priority::CurrentPreview,
                None,
                move || {
                    let generation = CacheGeneration::capture(output.parent().unwrap())?;
                    ready_tx.send(()).unwrap();
                    resume_rx.recv().unwrap();
                    let result = write_cache_file(&generation, &output, b"stale")
                        .map_err(|error| error.to_string());
                    done_tx.send(result.is_err()).unwrap();
                    result
                },
            ))
        });
        ready_rx.recv().unwrap();
        assert!(executor.cancel("canceled-cache-publication"));
        resume_tx.send(()).unwrap();
        assert!(done_rx.recv().unwrap());
        assert!(producer.join().unwrap().is_err());
        assert!(!path.exists());
        assert_eq!(fs::read_dir(root).unwrap().count(), 0);
        executor.shutdown();
    }

    #[test]
    fn clear_rejects_suspended_publication_and_preserves_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("previews");
        fs::create_dir_all(&root).unwrap();
        let path = root.join(cache_file_name_for_index(1, "jpg"));
        fs::write(&path, b"old").unwrap();
        let generation = CacheGeneration::capture(&root).unwrap();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        let stale_path = path.clone();
        let producer = std::thread::spawn(move || {
            ready_tx.send(()).unwrap();
            resume_rx.recv().unwrap();
            write_cache_file(&generation, &stale_path, b"stale")
        });
        ready_rx.recv().unwrap();
        clear_generated_cache_root(&root).unwrap();
        let replacement = CacheGeneration::capture(&root).unwrap();
        write_cache_file(&replacement, &path, b"replacement").unwrap();
        resume_tx.send(()).unwrap();
        assert!(producer.join().unwrap().is_err());
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    }

    #[test]
    fn source_replacement_rejects_suspended_publication() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("photo.jpg");
        fs::write(&source, b"before").unwrap();
        let metadata = resolve_source_metadata(&source, None, None).unwrap();
        let root = dir.path().join("previews");
        let generation = CacheGeneration::for_source(&root, &source, &metadata).unwrap();
        let path = root.join(cache_file_name_for_index(1, "jpg"));
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        let output = path.clone();
        let producer = std::thread::spawn(move || {
            ready_tx.send(()).unwrap();
            resume_rx.recv().unwrap();
            write_cache_file(&generation, &output, b"stale")
        });
        ready_rx.recv().unwrap();
        fs::write(source, b"replacement source").unwrap();
        resume_tx.send(()).unwrap();
        assert!(producer.join().unwrap().is_err());
        assert!(!path.exists());
        assert_eq!(fs::read_dir(root).unwrap().count(), 0);
    }

    #[test]
    fn tile_source_retirement_rejects_suspended_memory_insertion() {
        let cache = Arc::new(Mutex::new(JpegSourceCache::default()));
        let old_cache = Arc::clone(&cache);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        let producer = std::thread::spawn(move || {
            let epoch = old_cache.lock().unwrap().epoch;
            ready_tx.send(()).unwrap();
            resume_rx.recv().unwrap();
            old_cache.lock().unwrap().publish(epoch, "old".into(), &Arc::new(vec![1]), 100)
        });
        ready_rx.recv().unwrap();
        {
            let mut guard = cache.lock().unwrap();
            guard.invalidate();
            let epoch = guard.epoch;
            guard.publish(epoch, "new".into(), &Arc::new(vec![2]), 100).unwrap();
        }
        resume_tx.send(()).unwrap();
        assert!(producer.join().unwrap().is_err());
        assert_eq!(cache.lock().unwrap().entry.as_ref().unwrap().key, "new");
    }

    #[test]
    fn jpeg_above_full_decode_budget_still_decodes_small_cropped_tile() {
        // Valid constant-color baseline JPEG: each component block has zero DC difference
        // and EOB, represented by two one-bit Huffman codes. No giant pixel fixture is needed.
        fn segment(bytes: &mut Vec<u8>, marker: u8, payload: &[u8]) {
            bytes.extend_from_slice(&[0xff, marker]);
            bytes.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
            bytes.extend_from_slice(payload);
        }
        let mut jpeg = vec![0xff, 0xd8];
        let mut quant = vec![0];
        quant.extend([1; 64]);
        segment(&mut jpeg, 0xdb, &quant);
        let mut frame = vec![8];
        frame.extend_from_slice(&8000u16.to_be_bytes());
        frame.extend_from_slice(&10000u16.to_be_bytes());
        frame.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 0, 3, 0x11, 0]);
        segment(&mut jpeg, 0xc0, &frame);
        for class in [0, 0x10] {
            let mut table = vec![class, 1];
            table.extend([0; 15]);
            table.push(0);
            segment(&mut jpeg, 0xc4, &table);
        }
        segment(&mut jpeg, 0xda, &[3, 1, 0, 2, 0, 3, 0, 0, 63, 0]);
        jpeg.resize(jpeg.len() + 468_750, 0); // 625 x 500 MCUs, 12 bits each (4:2:0).
        jpeg.extend_from_slice(&[0xff, 0xd9]);
        assert!(image_resource_policy::validate_decoder_memory(
            10000,
            8000,
            240_000_000,
            OperationClass::Preview
        )
        .is_err());
        let tile =
            generate_jpeg_tile(&jpeg, TileBounds { x: 0, y: 0, width: 16, height: 16 }).unwrap();
        assert_eq!(image::load_from_memory(&tile).unwrap().dimensions(), (16, 16));
    }

    #[cfg(windows)]
    #[test]
    fn native_thumbnail_input_growth_is_terminal_without_rust_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("growing.dng");
        fs::write(&path, b"small input").unwrap();
        image_resource_policy::before_next_source_open(|path| {
            fs::OpenOptions::new()
                .write(true)
                .open(path)
                .unwrap()
                .set_len(512 * 1024 * 1024 + 1)
                .unwrap();
        });
        let decoders = image_resource_policy::DECODER_STARTS.with(|count| count.get());
        let rejections = image_resource_policy::rejection_count();
        let error = generate_best_thumbnail_jpeg(&path).unwrap_err().to_string();
        assert!(error.contains("Encoded image size"));
        assert!(!error.contains(&path.to_string_lossy().to_string()));
        assert!(image_resource_policy::rejection_count() > rejections);
        assert_eq!(image_resource_policy::DECODER_STARTS.with(|count| count.get()), decoders);
    }

    #[test]
    fn bounded_cached_assets_survive_full_source_admission_rejection() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.jpg");
        image::RgbImage::new(16, 16).save(&path).unwrap();
        let mut bytes = fs::read(&path).unwrap();
        let sof = bytes.windows(2).position(|value| value == [0xff, 0xc0]).unwrap();
        bytes[sof + 5..sof + 7].copy_from_slice(&20000u16.to_be_bytes());
        bytes[sof + 7..sof + 9].copy_from_slice(&20000u16.to_be_bytes());
        fs::write(&path, bytes).unwrap();
        let metadata = resolve_source_metadata(&path, None, None).unwrap();
        let cache = dir.path().join("cache");
        fs::create_dir(&cache).unwrap();
        for key in [
            build_cache_key(&path, &metadata),
            build_preview_cache_key(&path, &metadata, 2048, None),
        ] {
            image::RgbImage::new(32, 24)
                .save(cache.join(format!("{}.jpg", hash_cache_key(&key))))
                .unwrap();
        }
        let count = image_resource_policy::DECODER_STARTS.with(|count| count.get());
        assert!(get_or_create_thumbnail(&path, &metadata, &cache).is_ok());
        assert!(get_or_create_preview(&path, &metadata, &cache, 2048, None).is_ok());
        assert_eq!(image_resource_policy::DECODER_STARTS.with(|count| count.get()), count);
        assert!(decode_image_with_orientation(&path).is_err());
    }
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

    fn test_rgb_pixels(width: usize, height: usize) -> Vec<u8> {
        (0..height)
            .flat_map(|y| {
                (0..width).flat_map(move |x| {
                    [
                        ((x * 2 + y) % 256) as u8,
                        ((y * 2 + x * 3 + 29) % 256) as u8,
                        ((x + y * 3 + 61) % 256) as u8,
                    ]
                })
            })
            .collect()
    }

    fn test_gray_pixels(width: usize, height: usize) -> Vec<u8> {
        (0..height)
            .flat_map(|y| (0..width).map(move |x| ((x * 2 + y * 3 + 17) % 256) as u8))
            .collect()
    }

    fn test_ycck_jpeg() -> Vec<u8> {
        let mut ycck = Vec::with_capacity(16 * 16 * 4);
        for y in 0..16_u32 {
            for x in 0..16_u32 {
                let red = (x * 13 + y * 5 + 17) as f64;
                let green = (x * 7 + y * 11 + 29) as f64;
                let blue = (x * 3 + y * 19 + 43) as f64;
                let luma = (0.299 * red + 0.587 * green + 0.114 * blue).round().clamp(0.0, 255.0);
                let cb = (128.0 - 0.168_736 * red - 0.331_264 * green + 0.5 * blue)
                    .round()
                    .clamp(0.0, 255.0);
                let cr = (128.0 + 0.5 * red - 0.418_688 * green - 0.081_312 * blue)
                    .round()
                    .clamp(0.0, 255.0);
                ycck.extend([luma as u8, cb as u8, cr as u8, ((x + y) * 7) as u8]);
            }
        }
        let mut jpeg = libjpeg_turbo_rs::compress(
            &ycck,
            16,
            16,
            libjpeg_turbo_rs::PixelFormat::Cmyk,
            90,
            libjpeg_turbo_rs::Subsampling::S444,
        )
        .unwrap();
        let adobe = jpeg
            .windows(5)
            .position(|marker| marker == b"Adobe")
            .expect("CMYK JPEG must contain an Adobe APP14 marker");
        // APP14 stores Adobe, version, flags0, flags1, then the transform byte; transform 2 is
        // the YCCK declaration. The source channels above are already YCbCr plus K.
        jpeg[adobe + 11] = 2;
        jpeg
    }

    fn bounded_test_decode(path: &Path, max_dimension: u32) -> DynamicImage {
        let reduced =
            try_decode_reduced_jpeg(path, OperationClass::Preview, max_dimension).unwrap();
        let image = match reduced {
            ReducedJpegDecode::Reduced(image) => image,
            ReducedJpegDecode::NotApplicable => {
                decode_image_with_orientation_for_operation(path, OperationClass::Preview).unwrap()
            }
            ReducedJpegDecode::Fallback => panic!("test fixture should decode successfully"),
        };
        if image.width() > max_dimension || image.height() > max_dimension {
            image.resize(max_dimension, max_dimension, image::imageops::FilterType::Triangle)
        } else {
            image
        }
    }

    fn bounded_full_test_decode(path: &Path, max_dimension: u32) -> DynamicImage {
        let image =
            decode_image_with_orientation_for_operation(path, OperationClass::Preview).unwrap();
        if image.width() > max_dimension || image.height() > max_dimension {
            image.resize(max_dimension, max_dimension, image::imageops::FilterType::Triangle)
        } else {
            image
        }
    }

    fn assert_images_within_tolerance(
        actual: &DynamicImage,
        expected: &DynamicImage,
        max_channel_delta: u8,
        max_mean_delta: f64,
    ) {
        assert_eq!(actual.dimensions(), expected.dimensions());
        let actual = actual.to_rgb8();
        let expected = expected.to_rgb8();
        let mut max_delta = 0_u8;
        let mut total_delta = 0_u64;
        let mut sample_count = 0_u64;
        for (actual, expected) in actual.pixels().zip(expected.pixels()) {
            for (actual, expected) in actual.0.iter().zip(expected.0.iter()) {
                let delta = actual.abs_diff(*expected);
                max_delta = max_delta.max(delta);
                total_delta += u64::from(delta);
                sample_count += 1;
            }
        }
        let mean_delta = total_delta as f64 / sample_count.max(1) as f64;
        assert!(
            max_delta <= max_channel_delta && mean_delta <= max_mean_delta,
            "reduced JPEG differs from full decode: max delta {max_delta}, mean delta {mean_delta:.2}"
        );
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
        drop(file);
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
