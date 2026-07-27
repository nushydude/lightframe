pub mod curation_commands;
pub mod settings_commands;

pub use curation_commands::*;
pub use settings_commands::*;

use crate::atomic_file::{build_unique_sibling_path, replace_file_safely};
pub use crate::image_metadata::ExifData;
use crate::{folder_index, native_codecs, thumbnails};
use image::GenericImageView;
use libjpeg_turbo_rs::{MarkerCopyMode, TransformOp, TransformOptions};
use little_exif::exif_tag::ExifTag;
use little_exif::metadata::Metadata;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// Supported image extensions for the viewer
pub(crate) const SUPPORTED_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "tif", "heic", "heif", "avif", "svg",
    "dng", "cr2", "cr3", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "pef", "srw",
];

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct ImageFile {
    pub path: String,
    pub file_name: String,
    pub extension: String,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImageMetadata {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub file_size_bytes: u64,
    pub format: String,
    pub codec_backend: String,
    pub native_decode_supported: bool,
    pub detail_backend: String,
    pub detail_supported: bool,
    pub browser_renderable: bool,
    pub rust_decode_supported: bool,
    pub metadata_supported: bool,
    pub thumbnail_supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support_note: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct ImageCaption {
    pub text: String,
    pub sidecar_path: String,
    pub extension: String,
}

const MAX_IMAGE_CAPTION_BYTES: u64 = 1024 * 1024;

fn decode_image_caption(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }

    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&units);
    }

    if bytes.starts_with(&[0xFE, 0xFF]) {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&units);
    }

    String::from_utf8_lossy(bytes).into_owned()
}

fn image_caption_candidates(image_path: &Path) -> Vec<(PathBuf, &'static str)> {
    ["txt", "caption", "TXT", "CAPTION"]
        .into_iter()
        .map(|extension| {
            let mut candidate = image_path.to_path_buf();
            candidate.set_extension(extension);
            (candidate, extension)
        })
        .collect()
}

fn get_image_caption_blocking(file_path: String) -> Result<Option<ImageCaption>, String> {
    let normalized_path = file_path.trim();
    if normalized_path.is_empty() {
        return Err("file_path must not be empty".to_string());
    }

    let image_path = Path::new(normalized_path);
    for (sidecar_path, extension) in image_caption_candidates(image_path) {
        let metadata = match fs::metadata(&sidecar_path) {
            Ok(metadata) if metadata.is_file() => metadata,
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to inspect image caption '{}': {}",
                    sidecar_path.display(),
                    error
                ));
            }
        };

        if metadata.len() > MAX_IMAGE_CAPTION_BYTES {
            return Err(format!(
                "Image caption '{}' is larger than the 1 MB limit",
                sidecar_path.display()
            ));
        }

        let bytes = fs::read(&sidecar_path).map_err(|error| {
            format!("Failed to read image caption '{}': {}", sidecar_path.display(), error)
        })?;
        let text = decode_image_caption(&bytes).trim().to_string();
        if text.is_empty() {
            continue;
        }

        return Ok(Some(ImageCaption {
            text,
            sidecar_path: sidecar_path.to_string_lossy().to_string(),
            extension: extension.to_ascii_lowercase(),
        }));
    }

    Ok(None)
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodecHealthEntry {
    pub label: String,
    pub extensions: Vec<String>,
    pub metadata_backend: String,
    pub thumbnail_backend: String,
    pub detail_backend: String,
    pub native_decoder_available: Option<bool>,
    pub native_decoder_names: Vec<String>,
    pub native_supported_extensions: Vec<String>,
    pub native_missing_extensions: Vec<String>,
    pub native_error: Option<String>,
    pub status: String,
    pub note: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodecHealthReport {
    pub platform: String,
    pub entries: Vec<CodecHealthEntry>,
    pub generated_cache: thumbnails::GeneratedCacheSummary,
    pub runtime_stats: thumbnails::GeneratedAssetRuntimeStats,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GeneratedCacheCommandScope {
    All,
    Thumbnails,
    Previews,
    Tiles,
}

impl From<GeneratedCacheCommandScope> for thumbnails::GeneratedCacheClearScope {
    fn from(value: GeneratedCacheCommandScope) -> Self {
        match value {
            GeneratedCacheCommandScope::All => Self::All,
            GeneratedCacheCommandScope::Thumbnails => Self::Thumbnails,
            GeneratedCacheCommandScope::Previews => Self::Previews,
            GeneratedCacheCommandScope::Tiles => Self::Tiles,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

const MAX_SCALE_DIMENSION: u32 = 65_535;
const MAX_SCALE_PIXELS: u64 = 50_000_000;
const SCALE_DECODED_BYTES_PER_PIXEL: u64 = 8;
const MAX_SCALE_WORKING_BYTES: u64 = 800 * 1024 * 1024;
const SCALE_EXPORT_INPUT_EXTENSIONS: &[&str] =
    &["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "avif"];
const SCALE_EXPORT_OUTPUT_EXTENSIONS: &[&str] =
    &["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RotationSaveStrategy {
    Unsupported,
    Reencode,
    LosslessJpegThenFallback,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    pub theme: String,
    pub slideshow_interval_seconds: u32,
    #[serde(default = "default_slideshow_direction")]
    pub slideshow_direction: String,
    pub loop_slideshow: bool,
    pub shuffle_slideshow: bool,
    pub auto_fullscreen_on_slideshow: bool,
    #[serde(default = "default_crop_save_mode")]
    pub crop_save_mode: String,
    pub mouse_wheel_behavior: String,
    pub default_fit_mode: String,
    pub remember_window_bounds: bool,
    #[serde(default)]
    pub window_x: Option<f64>,
    #[serde(default)]
    pub window_y: Option<f64>,
    #[serde(default)]
    pub window_width: Option<f64>,
    #[serde(default)]
    pub window_height: Option<f64>,
    #[serde(default)]
    pub last_window_display_key: Option<String>,
    #[serde(default)]
    pub window_bounds_by_display: HashMap<String, WindowBounds>,
    pub sort_order: String,
    #[serde(default)]
    pub sort_direction: Option<String>,
    #[serde(default = "default_show_thumbnails")]
    pub show_thumbnails: bool,
    #[serde(default = "default_show_image_captions")]
    pub show_image_captions: bool,
    #[serde(default = "default_prompt_projector_grid_on_open")]
    pub prompt_projector_grid_on_open: bool,
    #[serde(default)]
    pub open_projector_in_grid_view: bool,
    #[serde(default = "default_performance_mode")]
    pub performance_mode: String,
    #[serde(default = "default_auto_refresh_folder")]
    pub auto_refresh_folder: bool,
    #[serde(default = "default_update_channel")]
    pub update_channel: String,
    #[serde(default = "default_saved_view_presets")]
    pub saved_view_presets: Vec<String>,
    #[serde(default)]
    pub recent_folders: Vec<RecentFolder>,
    #[serde(default)]
    pub quick_destinations: Vec<QuickDestination>,
    #[serde(default)]
    pub pinned_toolbar_actions: Vec<String>,
    #[serde(default)]
    pub external_editor_path: Option<String>,
    #[serde(default)]
    pub external_editor_label: Option<String>,
    #[serde(default)]
    pub persisted_marked_folders: Vec<PersistedMarkedFolder>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct WindowBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct RecentFolder {
    pub path: String,
    pub label: String,
    pub opened_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct PersistedMarkedFolder {
    pub folder_path: String,
    pub marked_paths: Vec<String>,
    pub updated_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct QuickDestination {
    pub id: String,
    pub label: String,
    pub path: String,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImageTransferMode {
    Copy,
    Move,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImageTransferSuccess {
    pub source_path: String,
    pub target_path: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImageTransferFailure {
    pub source_path: String,
    pub error: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct ImageTransferResult {
    pub successes: Vec<ImageTransferSuccess>,
    pub failures: Vec<ImageTransferFailure>,
}

fn default_show_thumbnails() -> bool {
    true
}

fn default_show_image_captions() -> bool {
    true
}

fn default_prompt_projector_grid_on_open() -> bool {
    true
}

fn default_performance_mode() -> String {
    "balanced".to_string()
}

fn default_crop_save_mode() -> String {
    "copy".to_string()
}

fn default_slideshow_direction() -> String {
    "forward".to_string()
}

fn default_auto_refresh_folder() -> bool {
    true
}

fn default_update_channel() -> String {
    "stable".to_string()
}

fn default_saved_view_presets() -> Vec<String> {
    vec!["favorites".to_string(), "rated4".to_string(), "unreviewed".to_string()]
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            theme: "dark".to_string(),
            slideshow_interval_seconds: 4,
            slideshow_direction: default_slideshow_direction(),
            loop_slideshow: false,
            shuffle_slideshow: false,
            auto_fullscreen_on_slideshow: true,
            crop_save_mode: default_crop_save_mode(),
            mouse_wheel_behavior: "zoom".to_string(),
            default_fit_mode: "fit".to_string(),
            remember_window_bounds: true,
            window_x: None,
            window_y: None,
            window_width: None,
            window_height: None,
            last_window_display_key: None,
            window_bounds_by_display: HashMap::new(),
            sort_order: "name".to_string(),
            sort_direction: Some("ascending".to_string()),
            show_thumbnails: default_show_thumbnails(),
            show_image_captions: default_show_image_captions(),
            prompt_projector_grid_on_open: default_prompt_projector_grid_on_open(),
            open_projector_in_grid_view: false,
            performance_mode: default_performance_mode(),
            auto_refresh_folder: default_auto_refresh_folder(),
            update_channel: default_update_channel(),
            saved_view_presets: default_saved_view_presets(),
            recent_folders: Vec::new(),
            quick_destinations: Vec::new(),
            pinned_toolbar_actions: Vec::new(),
            external_editor_path: None,
            external_editor_label: None,
            persisted_marked_folders: Vec::new(),
        }
    }
}

/// Natural sort comparison for filenames
fn natural_sort_key(s: &str) -> Vec<NatSortPart> {
    let mut parts = Vec::new();
    let mut chars = s.chars().peekable();
    let mut current = String::new();
    let mut is_digit = false;

    while let Some(&c) = chars.peek() {
        let c_is_digit = c.is_ascii_digit();
        if current.is_empty() {
            is_digit = c_is_digit;
            current.push(c);
            chars.next();
        } else if c_is_digit == is_digit {
            current.push(c);
            chars.next();
        } else {
            if is_digit {
                parts.push(NatSortPart::Num(current.parse::<u64>().unwrap_or(0)));
            } else {
                parts.push(NatSortPart::Str(current.to_lowercase()));
            }
            current.clear();
            is_digit = c_is_digit;
            current.push(c);
            chars.next();
        }
    }

    if !current.is_empty() {
        if is_digit {
            parts.push(NatSortPart::Num(current.parse::<u64>().unwrap_or(0)));
        } else {
            parts.push(NatSortPart::Str(current.to_lowercase()));
        }
    }

    parts
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum NatSortPart {
    Str(String),
    Num(u64),
}

#[derive(Debug, Clone)]
struct ScannedImage {
    image: ImageFile,
    sort_key: Vec<NatSortPart>,
    lowercase_file_name: String,
}

fn sort_scanned_images(images: &mut [ScannedImage]) {
    images.sort_by(|a, b| {
        a.sort_key
            .cmp(&b.sort_key)
            .then_with(|| a.lowercase_file_name.cmp(&b.lowercase_file_name))
            .then_with(|| a.image.path.cmp(&b.image.path))
    });
}

pub(crate) fn sort_image_files_by_name(images: &mut [ImageFile]) {
    let mut sorted_images: Vec<ScannedImage> = images
        .iter()
        .cloned()
        .map(|image| ScannedImage {
            sort_key: natural_sort_key(&image.file_name),
            lowercase_file_name: image.file_name.to_lowercase(),
            image,
        })
        .collect();
    sort_scanned_images(&mut sorted_images);

    for (target, sorted) in images.iter_mut().zip(sorted_images) {
        *target = sorted.image;
    }
}

pub(crate) fn is_supported_image_path(file_path: &Path) -> bool {
    let extension = file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    SUPPORTED_EXTENSIONS.contains(&extension.as_str())
}

pub(crate) fn image_file_from_path(file_path: &Path) -> Option<ImageFile> {
    if !is_supported_image_path(file_path) {
        return None;
    }

    let metadata = fs::metadata(file_path).ok()?;
    image_file_from_metadata(file_path, &metadata)
}

pub(crate) fn image_file_from_metadata(
    file_path: &Path,
    metadata: &fs::Metadata,
) -> Option<ImageFile> {
    if !metadata.is_file() || !is_supported_image_path(file_path) {
        return None;
    }

    let file_name = file_path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let extension = file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    let size_bytes = metadata.len();
    let modified_at = metadata.modified().ok().map(filesystem_timestamp_token);
    let created_at = metadata.created().ok().map(filesystem_timestamp_token);
    let path = file_path.to_string_lossy().to_string();

    Some(ImageFile { path, file_name, extension, size_bytes, modified_at, created_at })
}

fn filesystem_timestamp_token(timestamp: SystemTime) -> String {
    timestamp.duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos().to_string()
}

/// Check if a path is a directory
#[tauri::command]
pub fn is_dir(path: String) -> bool {
    Path::new(&path).is_dir()
}

fn scan_folder_blocking(folder_path: String) -> Result<Vec<ImageFile>, String> {
    let path = Path::new(&folder_path);
    if !path.is_dir() {
        return Err(format!("'{}' is not a valid directory", folder_path));
    }

    let entries = fs::read_dir(path).map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut images: Vec<ScannedImage> = Vec::new();

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let file_path = entry.path();
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };

        let Some(image) = image_file_from_metadata(&file_path, &metadata) else {
            continue;
        };

        let sort_key = natural_sort_key(&image.file_name);
        let lowercase_file_name = image.file_name.to_lowercase();

        images.push(ScannedImage { sort_key, lowercase_file_name, image });
    }

    sort_scanned_images(&mut images);

    Ok(images.into_iter().map(|scanned| scanned.image).collect())
}

fn resolve_folder_index_path(app: &AppHandle) -> Option<PathBuf> {
    match app.path().app_cache_dir() {
        Ok(cache_dir) => Some(folder_index::index_root(&cache_dir)),
        Err(err) => {
            eprintln!(
                "Failed to resolve app cache directory for folder index: {}. Proceeding without persistent folder cache.",
                err
            );
            None
        }
    }
}

/// Scan a folder for supported image files
#[tauri::command]
pub async fn scan_folder(folder_path: String) -> Result<Vec<ImageFile>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_folder_blocking(folder_path))
        .await
        .map_err(|err| format!("Scan folder worker failed: {}", err))?
}

fn read_folder_index_blocking(
    folder_path: String,
    index_path: Option<PathBuf>,
) -> Result<Vec<ImageFile>, String> {
    let path = Path::new(&folder_path);
    if !path.is_dir() {
        return Err(format!("'{}' is not a valid directory", folder_path));
    }

    let Some(index_path) = index_path else {
        return Ok(Vec::new());
    };

    Ok(folder_index::read_folder_images(&index_path, path))
}

/// Read cached folder contents from the persistent folder index, if available
#[tauri::command]
pub async fn read_folder_index(
    app: AppHandle,
    folder_path: String,
) -> Result<Vec<ImageFile>, String> {
    let index_path = resolve_folder_index_path(&app);
    tauri::async_runtime::spawn_blocking(move || {
        read_folder_index_blocking(folder_path, index_path)
    })
    .await
    .map_err(|err| format!("Read folder index worker failed: {}", err))?
}

fn refresh_folder_index_blocking(
    folder_path: String,
    index_path: Option<PathBuf>,
) -> Result<Vec<ImageFile>, String> {
    let scanned_images = scan_folder_blocking(folder_path.clone())?;

    if let Some(index_path) = index_path {
        let folder_path_buf = PathBuf::from(&folder_path);
        if let Err(err) =
            folder_index::write_folder_images(&index_path, &folder_path_buf, &scanned_images)
        {
            eprintln!(
                "Failed to update persistent folder index for '{}': {}. Returning live scan results anyway.",
                folder_path, err
            );
        }
    }

    Ok(scanned_images)
}

/// Refresh folder contents from disk and update the persistent folder index
#[tauri::command]
pub async fn refresh_folder_index(
    app: AppHandle,
    folder_path: String,
) -> Result<Vec<ImageFile>, String> {
    let index_path = resolve_folder_index_path(&app);
    tauri::async_runtime::spawn_blocking(move || {
        refresh_folder_index_blocking(folder_path, index_path)
    })
    .await
    .map_err(|err| format!("Refresh folder index worker failed: {}", err))?
}

/// Get image metadata (dimensions, format, file size)
fn get_image_metadata_blocking(file_path: String) -> Result<ImageMetadata, String> {
    let path = Path::new(&file_path);
    if !path.is_file() {
        return Err(format!("'{}' is not a valid file", file_path));
    }

    let file_metadata =
        fs::metadata(path).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    let file_size_bytes = file_metadata.len();

    let extension =
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();
    let format_support = thumbnails::format_support_for_path(path);
    let codec_capability = native_codecs::codec_capability_for_path(path);

    let mut native_decode_supported = false;
    let mut codec_backend = native_codecs::CodecBackend::Unsupported;
    let mut format = format_label_for_extension(&extension);
    let mut support_note = format_support.support_note.map(str::to_string);

    let (width, height) = if codec_capability.metadata == native_codecs::CodecBackend::WindowsNative
    {
        match native_codecs::metadata_from_path(path) {
            Ok(native_metadata) => {
                native_decode_supported = true;
                codec_backend = native_codecs::CodecBackend::WindowsNative;
                if let Some(native_format) = native_metadata.format {
                    format = native_format.to_string();
                }
                support_note =
                    Some("Metadata is decoded through Windows Imaging Component.".to_string());
                (Some(native_metadata.width), Some(native_metadata.height))
            }
            Err(_) => rust_or_fallback_dimensions(
                path,
                codec_capability.metadata_fallback.unwrap_or(codec_capability.metadata),
                &mut codec_backend,
            ),
        }
    } else {
        rust_or_fallback_dimensions(path, codec_capability.metadata, &mut codec_backend)
    };

    Ok(ImageMetadata {
        width,
        height,
        file_size_bytes,
        format,
        codec_backend: codec_backend.as_str().to_string(),
        native_decode_supported,
        detail_backend: codec_capability.detail.as_str().to_string(),
        detail_supported: detail_supported_for_capability(
            codec_capability.detail,
            native_decode_supported,
            width,
            height,
        ),
        browser_renderable: format_support.browser_renderable,
        rust_decode_supported: format_support.rust_decode_supported,
        metadata_supported: format_support.metadata_supported,
        thumbnail_supported: format_support.thumbnail_supported,
        support_note,
    })
}

fn detail_supported_for_capability(
    detail_backend: native_codecs::CodecBackend,
    native_decode_supported: bool,
    width: Option<u32>,
    height: Option<u32>,
) -> bool {
    if width.unwrap_or_default() == 0 || height.unwrap_or_default() == 0 {
        return false;
    }

    match detail_backend {
        native_codecs::CodecBackend::RustImage => true,
        native_codecs::CodecBackend::WindowsNative => native_decode_supported,
        native_codecs::CodecBackend::BrowserRenderable
        | native_codecs::CodecBackend::Unsupported => false,
    }
}

fn rust_or_fallback_dimensions(
    path: &Path,
    fallback_backend: native_codecs::CodecBackend,
    codec_backend: &mut native_codecs::CodecBackend,
) -> (Option<u32>, Option<u32>) {
    match thumbnails::oriented_image_dimensions(path) {
        Ok((width, height)) => {
            *codec_backend = native_codecs::CodecBackend::RustImage;
            (Some(width), Some(height))
        }
        Err(_) => {
            *codec_backend = if fallback_backend == native_codecs::CodecBackend::BrowserRenderable {
                native_codecs::CodecBackend::BrowserRenderable
            } else {
                native_codecs::CodecBackend::Unsupported
            };
            (None, None)
        }
    }
}

fn format_label_for_extension(extension: &str) -> String {
    match extension {
        "jpg" | "jpeg" => "JPEG".to_string(),
        "png" => "PNG".to_string(),
        "webp" => "WebP".to_string(),
        "gif" => "GIF".to_string(),
        "bmp" => "BMP".to_string(),
        "tiff" | "tif" => "TIFF".to_string(),
        "heic" | "heif" => "HEIC".to_string(),
        "avif" => "AVIF".to_string(),
        "svg" => "SVG".to_string(),
        "dng" => "DNG".to_string(),
        "cr2" | "cr3" => "Canon RAW".to_string(),
        "nef" | "nrw" => "Nikon RAW".to_string(),
        "arw" | "srf" | "sr2" => "Sony RAW".to_string(),
        "raf" => "Fujifilm RAW".to_string(),
        "orf" => "Olympus RAW".to_string(),
        "rw2" => "Panasonic RAW".to_string(),
        "pef" => "Pentax RAW".to_string(),
        "srw" => "Samsung RAW".to_string(),
        other => other.to_uppercase(),
    }
}

fn codec_health_report_blocking(app_cache_dir: PathBuf) -> CodecHealthReport {
    CodecHealthReport {
        platform: std::env::consts::OS.to_string(),
        entries: codec_health_entries(),
        generated_cache: thumbnails::generated_cache_summary(&app_cache_dir),
        runtime_stats: thumbnails::generated_asset_runtime_stats(),
    }
}

fn codec_health_entries() -> Vec<CodecHealthEntry> {
    vec![
        codec_health_entry(
            "JPEG detail",
            &["jpg", "jpeg"],
            "Rust decoder with libjpeg-turbo regional tiles.",
        ),
        codec_health_entry(
            "Standard stills",
            &["png", "webp", "gif", "bmp", "tiff", "tif", "avif"],
            "Rust decoder path; very large non-JPEG files stay preview-first.",
        ),
        codec_health_entry(
            "HEIC / HEIF",
            &["heic", "heif"],
            "Windows native codec enables previews, thumbnails, metadata, and detail tiles.",
        ),
        codec_health_entry(
            "Camera RAW",
            &["dng", "cr2", "cr3", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "pef", "srw"],
            "Windows native codec is tried for thumbnails and previews; placeholders and XMP stay available.",
        ),
        codec_health_entry(
            "SVG",
            &["svg"],
            "Browser-renderable image with generated placeholder thumbnails.",
        ),
    ]
}

fn codec_health_entry(label: &str, extensions: &[&str], note: &str) -> CodecHealthEntry {
    let capability = native_codecs::codec_capability_for_extension(extensions[0]);
    let uses_native = [
        capability.metadata,
        capability.metadata_fallback.unwrap_or(native_codecs::CodecBackend::Unsupported),
        capability.thumbnail,
        capability.detail,
    ]
    .contains(&native_codecs::CodecBackend::WindowsNative);
    let native_health =
        uses_native.then(|| native_codecs::native_decoder_health_for_extensions(extensions));
    let status = codec_health_status(capability, native_health.as_ref());

    CodecHealthEntry {
        label: label.to_string(),
        extensions: extensions.iter().map(|extension| (*extension).to_string()).collect(),
        metadata_backend: capability.metadata.as_str().to_string(),
        thumbnail_backend: capability.thumbnail.as_str().to_string(),
        detail_backend: capability.detail.as_str().to_string(),
        native_decoder_available: native_health.as_ref().map(|health| health.available),
        native_decoder_names: native_health
            .as_ref()
            .map(|health| health.decoder_names.clone())
            .unwrap_or_default(),
        native_supported_extensions: native_health
            .as_ref()
            .map(|health| health.supported_extensions.clone())
            .unwrap_or_default(),
        native_missing_extensions: native_health
            .as_ref()
            .map(|health| health.missing_extensions.clone())
            .unwrap_or_default(),
        native_error: native_health.and_then(|health| health.error),
        status,
        note: note.to_string(),
    }
}

fn codec_health_status(
    capability: native_codecs::CodecCapability,
    native_health: Option<&native_codecs::NativeDecoderHealth>,
) -> String {
    if let Some(health) = native_health {
        if health.available {
            return "native-ready".to_string();
        }
        if !health.supported_extensions.is_empty() {
            return "partial".to_string();
        }
        return "fallback".to_string();
    }

    if capability.detail == native_codecs::CodecBackend::Unsupported {
        "preview-first".to_string()
    } else {
        "ready".to_string()
    }
}

#[tauri::command]
pub async fn get_codec_health(app: AppHandle) -> Result<CodecHealthReport, String> {
    let app_cache_dir =
        app.path().app_cache_dir().map_err(|e| format!("Failed to get app cache dir: {}", e))?;
    tauri::async_runtime::spawn_blocking(move || codec_health_report_blocking(app_cache_dir))
        .await
        .map_err(|err| format!("Codec health worker failed: {}", err))
}

#[tauri::command]
pub async fn clear_generated_image_cache(
    app: AppHandle,
    scope: GeneratedCacheCommandScope,
) -> Result<thumbnails::GeneratedCacheSummary, String> {
    let app_cache_dir =
        app.path().app_cache_dir().map_err(|e| format!("Failed to get app cache dir: {}", e))?;
    tauri::async_runtime::spawn_blocking(move || {
        thumbnails::clear_generated_cache(&app_cache_dir, scope.into())
    })
    .await
    .map_err(|err| format!("Generated cache cleanup worker failed: {}", err))?
}

#[tauri::command]
pub async fn retry_native_codecs() -> Result<usize, String> {
    Ok(thumbnails::clear_raw_native_decode_failure_cache())
}

fn rotation_save_strategy(extension: &str, rotation_degrees: i32) -> Option<RotationSaveStrategy> {
    let normalized = rotation_degrees.rem_euclid(360);
    if normalized == 0 {
        return None;
    }

    if !matches!(normalized, 90 | 180 | 270) {
        return None;
    }

    Some(match extension {
        "jpg" | "jpeg" => RotationSaveStrategy::LosslessJpegThenFallback,
        "bmp" | "png" | "webp" => RotationSaveStrategy::Reencode,
        _ => RotationSaveStrategy::Unsupported,
    })
}

fn rotation_transform_op(rotation_degrees: i32) -> Option<TransformOp> {
    match rotation_degrees.rem_euclid(360) {
        90 => Some(TransformOp::Rot90),
        180 => Some(TransformOp::Rot180),
        270 => Some(TransformOp::Rot270),
        _ => None,
    }
}

fn write_dynamic_image(
    image: &image::DynamicImage,
    output_path: &Path,
    error_prefix: &str,
) -> Result<(), String> {
    let extension = output_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_default();

    let write_result = if matches!(extension.as_str(), "jpg" | "jpeg") {
        image::DynamicImage::ImageRgb8(image.to_rgb8()).save(output_path)
    } else {
        image.save(output_path)
    };

    write_result.map_err(|e| format!("{}: {}", error_prefix, e))
}

fn write_high_quality_image(
    image: &image::DynamicImage,
    output_path: &Path,
    error_prefix: &str,
) -> Result<(), String> {
    let extension = output_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_default();

    if !matches!(extension.as_str(), "jpg" | "jpeg") {
        return write_dynamic_image(image, output_path, error_prefix);
    }

    let mut output_file =
        fs::File::create(output_path).map_err(|e| format!("{}: {}", error_prefix, e))?;
    let rgb_image = image::DynamicImage::ImageRgb8(image.to_rgb8());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output_file, 95);
    encoder.encode_image(&rgb_image).map_err(|e| format!("{}: {}", error_prefix, e))
}

fn restore_normal_orientation(
    source_path: &Path,
    output_path: &Path,
    context: &str,
) -> Result<(), String> {
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_default();

    if !matches!(extension.as_str(), "jpg" | "jpeg" | "png" | "webp") {
        if source_path != output_path && !output_path.exists() {
            let _ = fs::copy(source_path, output_path);
        }
        return Ok(());
    }

    if let Ok(mut metadata) = Metadata::new_from_path(source_path) {
        metadata.set_tag(ExifTag::Orientation(vec![1]));
        if let Err(e) = metadata.write_to_file(output_path) {
            if source_path != output_path && !output_path.exists() {
                fs::copy(source_path, output_path)
                    .map_err(|e| format!("Failed to copy output file after {}: {}", context, e))?;
            } else {
                return Err(format!("Failed to write image metadata after {}: {}", context, e));
            }
        }
    } else if source_path != output_path && !output_path.exists() {
        fs::copy(source_path, output_path)
            .map_err(|e| format!("Failed to copy output file after {}: {}", context, e))?;
    }

    Ok(())
}

fn try_lossless_jpeg_rotation_bytes(
    jpeg_bytes: &[u8],
    rotation_degrees: i32,
) -> Result<Vec<u8>, String> {
    let transform = rotation_transform_op(rotation_degrees)
        .ok_or_else(|| format!("Unsupported rotation degrees: {}", rotation_degrees))?;

    libjpeg_turbo_rs::transform_jpeg_with_options(
        jpeg_bytes,
        &TransformOptions {
            op: transform,
            perfect: true,
            copy_markers: MarkerCopyMode::All,
            ..Default::default()
        },
    )
    .map_err(|e| format!("Lossless JPEG transform failed: {}", e))
}

/// Get image metadata (dimensions, format, file size)
#[tauri::command]
pub async fn get_image_metadata(file_path: String) -> Result<ImageMetadata, String> {
    tauri::async_runtime::spawn_blocking(move || get_image_metadata_blocking(file_path))
        .await
        .map_err(|err| format!("Image metadata worker failed: {}", err))?
}

/// Read a same-basename LoRA caption sidecar (`.txt`, then `.caption`) when present.
#[tauri::command]
pub async fn get_image_caption(file_path: String) -> Result<Option<ImageCaption>, String> {
    tauri::async_runtime::spawn_blocking(move || get_image_caption_blocking(file_path))
        .await
        .map_err(|err| format!("Image caption worker failed: {}", err))?
}

fn get_preview_image_blocking(
    file_path: String,
    max_dimension: u32,
    invalidation_bust: Option<u64>,
    app_cache_dir: PathBuf,
) -> Result<thumbnails::GeneratedImageAsset, String> {
    let path = Path::new(&file_path);
    if !path.is_file() {
        return Err(format!("'{}' is not a valid file", file_path));
    }

    let limits = crate::image_resource_policy::PolicyLimits::for_operation(
        crate::image_resource_policy::OperationClass::Preview,
    );
    crate::image_resource_policy::validate_requested_output_dimension(max_dimension, &limits)
        .map_err(|e| e.to_string())?;
    crate::image_resource_policy::validate_file_size(path, &limits).map_err(|e| e.to_string())?;

    let metadata = thumbnails::resolve_source_metadata(path, None, None)?;
    let preview_cache_dir = app_cache_dir.join("previews");
    thumbnails::get_or_create_preview(
        path,
        &metadata,
        &preview_cache_dir,
        max_dimension,
        invalidation_bust,
    )
}

#[tauri::command]
pub async fn open_folder_session(
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    folder_path: String,
) -> Result<crate::authority::FolderSessionSnapshot, String> {
    let path = Path::new(&folder_path);
    session_manager.open_folder_session(path)
}

#[tauri::command]
pub async fn open_file_session(
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    file_path: String,
) -> Result<crate::authority::FolderSessionSnapshot, String> {
    let path = Path::new(&file_path);
    session_manager.open_file_session(path)
}

pub fn enforce_main_window(window: &tauri::Window) -> Result<(), String> {
    if window.label() != "main" {
        return Err(format!(
            "Window '{}' is not authorized to execute privileged or destructive commands",
            window.label()
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn close_folder_session(
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    session_id: String,
) -> Result<(), String> {
    session_manager.close_session(&session_id)
}

#[tauri::command]
pub async fn grant_destination(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    folder_path: String,
) -> Result<String, String> {
    enforce_main_window(&window)?;
    let path = Path::new(&folder_path);
    session_manager.grant_destination(path)
}

#[tauri::command]
pub async fn grant_external_editor(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    application_path: String,
) -> Result<String, String> {
    enforce_main_window(&window)?;
    let path = Path::new(&application_path);
    session_manager.grant_external_editor(path)
}

#[tauri::command]
pub async fn cancel_media_request(
    executor: tauri::State<'_, crate::media_executor::MediaExecutor>,
    request_id: String,
) -> Result<bool, String> {
    Ok(executor.cancel_request(&request_id))
}

#[tauri::command]
pub async fn get_media_executor_telemetry(
    executor: tauri::State<'_, crate::media_executor::MediaExecutor>,
) -> Result<crate::media_executor::ExecutorTelemetry, String> {
    Ok(executor.telemetry())
}

#[tauri::command]
pub async fn get_preview_image_by_id(
    app: AppHandle,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    executor: tauri::State<'_, crate::media_executor::MediaExecutor>,
    session_id: String,
    image_id: String,
    max_dimension: u32,
    invalidation_bust: Option<u64>,
) -> Result<thumbnails::GeneratedImageAsset, String> {
    let resolved_path = session_manager.resolve_image_path(&session_id, &image_id)?;
    let app_cache_dir =
        app.path().app_cache_dir().map_err(|e| format!("Failed to get app cache dir: {}", e))?;
    let path_str = resolved_path.to_string_lossy().to_string();
    let req_id = format!("preview_{}_{}", image_id, max_dimension);
    let dedup_key = format!("preview_{}_{}_{:?}", path_str, max_dimension, invalidation_bust);

    let (tx, rx) = std::sync::mpsc::channel();
    executor.spawn(
        req_id,
        crate::media_executor::PriorityClass::InteractivePreview,
        Some(dedup_key),
        move |_cancel_tok| {
            let res = get_preview_image_blocking(
                path_str,
                max_dimension,
                invalidation_bust,
                app_cache_dir,
            );
            let _ = tx.send(res);
            Ok::<(), String>(())
        },
    );

    rx.recv().map_err(|_| "Media executor worker dropped".to_string())?
}

#[tauri::command]
pub async fn get_preview_image(
    app: AppHandle,
    executor: tauri::State<'_, crate::media_executor::MediaExecutor>,
    file_path: String,
    max_dimension: u32,
    invalidation_bust: Option<u64>,
) -> Result<thumbnails::GeneratedImageAsset, String> {
    let app_cache_dir =
        app.path().app_cache_dir().map_err(|e| format!("Failed to get app cache dir: {}", e))?;
    let req_id = format!("preview_{}_{}", file_path, max_dimension);
    let dedup_key = format!("preview_{}_{}_{:?}", file_path, max_dimension, invalidation_bust);

    let (tx, rx) = std::sync::mpsc::channel();
    let path_clone = file_path.clone();
    executor.spawn(
        req_id,
        crate::media_executor::PriorityClass::InteractivePreview,
        Some(dedup_key),
        move |_cancel_tok| {
            let res = get_preview_image_blocking(
                path_clone,
                max_dimension,
                invalidation_bust,
                app_cache_dir,
            );
            let _ = tx.send(res);
            Ok::<(), String>(())
        },
    );

    rx.recv().map_err(|_| "Media executor worker dropped".to_string())?
}

fn get_image_tile_blocking(
    file_path: String,
    source_width: u32,
    source_height: u32,
    tile_size: u32,
    tile_x: u32,
    tile_y: u32,
    app_cache_dir: PathBuf,
) -> Result<thumbnails::GeneratedImageAsset, String> {
    let path = Path::new(&file_path);
    if !path.is_file() {
        return Err(format!("'{}' is not a valid file", file_path));
    }

    let (actual_width, actual_height) = tile_source_dimensions(path)?;
    if actual_width != source_width || actual_height != source_height {
        return Err(format!(
            "Tile source dimensions are stale: expected {}x{}, found {}x{}",
            source_width, source_height, actual_width, actual_height
        ));
    }

    let metadata = thumbnails::resolve_source_metadata(path, None, None)?;
    let tile_cache_dir = app_cache_dir.join("tiles");
    thumbnails::get_or_create_tile(
        path,
        &metadata,
        &tile_cache_dir,
        thumbnails::TileRequest { source_width, source_height, tile_size, tile_x, tile_y },
    )
}

fn tile_source_dimensions(path: &Path) -> Result<(u32, u32), String> {
    if native_codecs::should_prefer_native_detail(path) {
        return native_codecs::metadata_from_path(path)
            .map(|metadata| (metadata.width, metadata.height))
            .map_err(|e| format!("Failed to read native tile source dimensions: {}", e));
    }

    thumbnails::oriented_image_dimensions(path)
}

#[tauri::command]
pub async fn get_image_tile(
    app: AppHandle,
    file_path: String,
    source_width: u32,
    source_height: u32,
    tile_size: u32,
    tile_x: u32,
    tile_y: u32,
) -> Result<thumbnails::GeneratedImageAsset, String> {
    let app_cache_dir =
        app.path().app_cache_dir().map_err(|e| format!("Failed to get app cache dir: {}", e))?;
    tauri::async_runtime::spawn_blocking(move || {
        get_image_tile_blocking(
            file_path,
            source_width,
            source_height,
            tile_size,
            tile_x,
            tile_y,
            app_cache_dir,
        )
    })
    .await
    .map_err(|err| format!("Image tile worker failed: {}", err))?
}

fn diagnostics_export_path(path: &str) -> Result<PathBuf, String> {
    let normalized_path = path.trim();
    if normalized_path.is_empty() {
        return Err("path must not be empty".to_string());
    }

    let target_path = PathBuf::from(normalized_path);
    let file_name = target_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Diagnostics path must include a valid file name".to_string())?;

    if !file_name.starts_with("lightframe-diagnostics-") || !file_name.ends_with(".json") {
        return Err(
            "Diagnostics export must use a lightframe-diagnostics-*.json file name".to_string()
        );
    }

    let parent = target_path.parent().ok_or_else(|| {
        "Diagnostics export must target a file inside an existing folder".to_string()
    })?;
    if !parent.is_dir() {
        return Err("Diagnostics export folder does not exist".to_string());
    }

    Ok(target_path)
}

#[tauri::command]
pub async fn save_diagnostics_snapshot(path: String, content: String) -> Result<(), String> {
    let target_path = diagnostics_export_path(&path)?;
    if content.len() > 4 * 1024 * 1024 {
        return Err("Diagnostics export is unexpectedly large".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        fs::write(&target_path, content)
            .map_err(|e| format!("Failed to save diagnostics snapshot: {}", e))
    })
    .await
    .map_err(|err| format!("Diagnostics export worker failed: {}", err))?
}

fn build_copy_name(file_stem: &str, extension: &str, attempt: u32) -> String {
    let suffix = if attempt == 0 { " copy".to_string() } else { format!(" copy {}", attempt + 1) };

    if extension.is_empty() {
        format!("{}{}", file_stem, suffix)
    } else {
        format!("{}{}.{}", file_stem, suffix, extension)
    }
}

fn build_destination_candidate_path(
    source_path: &Path,
    destination_folder: &Path,
    attempt: Option<u32>,
) -> Result<PathBuf, String> {
    if attempt.is_none() {
        let file_name =
            source_path.file_name().ok_or_else(|| "Source file name is missing".to_string())?;
        return Ok(destination_folder.join(file_name));
    }

    let file_stem = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Source file stem is invalid".to_string())?;
    let extension = source_path.extension().and_then(|value| value.to_str()).unwrap_or_default();
    Ok(destination_folder.join(build_copy_name(file_stem, extension, attempt.unwrap_or(0))))
}

fn destination_entry_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => {
            Err(format!("Failed to inspect destination path '{}': {}", path.display(), error))
        }
    }
}

fn paths_match(left: &Path, right: &Path) -> bool {
    left == right
}

fn files_match_by_content(left: &Path, right: &Path) -> Result<bool, String> {
    let left_metadata = fs::metadata(left).map_err(|error| {
        format!("Failed to inspect source file '{}': {}", left.display(), error)
    })?;
    let right_metadata = fs::metadata(right).map_err(|error| {
        format!("Failed to inspect destination file '{}': {}", right.display(), error)
    })?;

    if left_metadata.len() != right_metadata.len() {
        return Ok(false);
    }

    let mut left_file = fs::File::open(left)
        .map_err(|error| format!("Failed to open source file '{}': {}", left.display(), error))?;
    let mut right_file = fs::File::open(right).map_err(|error| {
        format!("Failed to open destination file '{}': {}", right.display(), error)
    })?;

    let mut left_buffer = [0_u8; 8192];
    let mut right_buffer = [0_u8; 8192];
    loop {
        let left_read = io::Read::read(&mut left_file, &mut left_buffer).map_err(|error| {
            format!("Failed to read source file '{}': {}", left.display(), error)
        })?;
        let right_read = io::Read::read(&mut right_file, &mut right_buffer).map_err(|error| {
            format!("Failed to read destination file '{}': {}", right.display(), error)
        })?;

        if left_read != right_read {
            return Ok(false);
        }

        if left_read == 0 {
            return Ok(true);
        }

        if left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
    }
}

fn next_destination_candidate(
    source_path: &Path,
    destination_folder: &Path,
) -> Result<PathBuf, String> {
    let preferred_path = build_destination_candidate_path(source_path, destination_folder, None)?;
    if !destination_entry_exists(&preferred_path)? {
        return Ok(preferred_path);
    }

    for attempt in 0..10_000 {
        let candidate =
            build_destination_candidate_path(source_path, destination_folder, Some(attempt))?;
        if !destination_entry_exists(&candidate)? {
            return Ok(candidate);
        }
    }

    Err("Unable to resolve a unique destination file name".to_string())
}

fn existing_matching_destination(
    source_path: &Path,
    destination_folder: &Path,
) -> Result<Option<PathBuf>, String> {
    let preferred_path = build_destination_candidate_path(source_path, destination_folder, None)?;
    if !destination_entry_exists(&preferred_path)? {
        return Ok(None);
    }

    if paths_match(source_path, &preferred_path)
        || files_match_by_content(source_path, &preferred_path)?
    {
        return Ok(Some(preferred_path));
    }

    Ok(None)
}

enum ExclusiveWriteError {
    AlreadyExists,
    Other(String),
}

fn copy_file_exclusive(
    source_path: &Path,
    destination_path: &Path,
) -> Result<(), ExclusiveWriteError> {
    let mut source_file = fs::File::open(source_path).map_err(|error| {
        ExclusiveWriteError::Other(format!("Failed to open source file for copy: {}", error))
    })?;
    let mut destination_file =
        fs::OpenOptions::new().write(true).create_new(true).open(destination_path).map_err(
            |error| {
                if error.kind() == io::ErrorKind::AlreadyExists {
                    ExclusiveWriteError::AlreadyExists
                } else {
                    ExclusiveWriteError::Other(format!(
                        "Failed to create destination file '{}': {}",
                        destination_path.display(),
                        error
                    ))
                }
            },
        )?;

    io::copy(&mut source_file, &mut destination_file).map_err(|error| {
        let _ = fs::remove_file(destination_path);
        ExclusiveWriteError::Other(format!("Failed to copy image to destination: {}", error))
    })?;

    destination_file.sync_all().map_err(|error| {
        let _ = fs::remove_file(destination_path);
        ExclusiveWriteError::Other(format!(
            "Failed to flush destination file '{}': {}",
            destination_path.display(),
            error
        ))
    })?;

    Ok(())
}

fn copy_image_to_folder_blocking(
    file_path: String,
    destination_folder: String,
) -> Result<String, String> {
    let source_path = Path::new(&file_path);
    if !source_path.is_file() {
        return Err(format!("'{}' is not a valid file", file_path));
    }

    let destination_path = Path::new(&destination_folder);
    if !destination_path.is_dir() {
        return Err(format!("'{}' is not a valid destination folder", destination_folder));
    }

    if let Some(existing_path) = existing_matching_destination(source_path, destination_path)? {
        return Ok(existing_path.to_string_lossy().to_string());
    }

    for _ in 0..10_000 {
        let target_path = next_destination_candidate(source_path, destination_path)?;
        match copy_file_exclusive(source_path, &target_path) {
            Ok(()) => return Ok(target_path.to_string_lossy().to_string()),
            Err(ExclusiveWriteError::AlreadyExists) => continue,
            Err(ExclusiveWriteError::Other(error)) => return Err(error),
        }
    }

    Err("Unable to resolve a unique destination file name".to_string())
}

fn is_cross_device_rename_error(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(17 | 18))
}

fn move_file_no_overwrite(
    source_path: &Path,
    target_path: &Path,
) -> Result<(), ExclusiveWriteError> {
    match fs::hard_link(source_path, target_path) {
        Ok(()) => {
            if let Err(remove_error) = fs::remove_file(source_path) {
                let _ = fs::remove_file(target_path);
                return Err(ExclusiveWriteError::Other(format!(
                    "Failed to remove source file after move: {}",
                    remove_error
                )));
            }
            Ok(())
        }
        Err(link_error) if link_error.kind() == io::ErrorKind::AlreadyExists => {
            Err(ExclusiveWriteError::AlreadyExists)
        }
        Err(link_error) if is_cross_device_rename_error(&link_error) => {
            copy_file_exclusive(source_path, target_path)?;
            if let Err(remove_error) = fs::remove_file(source_path) {
                let _ = fs::remove_file(target_path);
                return Err(ExclusiveWriteError::Other(format!(
                    "Move fallback copied the file but could not remove the source: {}",
                    remove_error
                )));
            }
            Ok(())
        }
        Err(link_error) => {
            copy_file_exclusive(source_path, target_path).map_err(
                |copy_error| match copy_error {
                    ExclusiveWriteError::AlreadyExists => ExclusiveWriteError::AlreadyExists,
                    ExclusiveWriteError::Other(copy_message) => {
                        ExclusiveWriteError::Other(format!(
                            "Failed to move image to destination: {}. Fallback copy error: {}",
                            link_error, copy_message
                        ))
                    }
                },
            )?;

            if let Err(remove_error) = fs::remove_file(source_path) {
                let _ = fs::remove_file(target_path);
                return Err(ExclusiveWriteError::Other(format!(
                    "Move fallback copied the file but could not remove the source: {}",
                    remove_error
                )));
            }

            Ok(())
        }
    }
}

fn move_image_to_folder_blocking(
    file_path: String,
    destination_folder: String,
) -> Result<String, String> {
    let source_path = Path::new(&file_path);
    if !source_path.is_file() {
        return Err(format!("'{}' is not a valid file", file_path));
    }

    let destination_path = Path::new(&destination_folder);
    if !destination_path.is_dir() {
        return Err(format!("'{}' is not a valid destination folder", destination_folder));
    }

    if let Some(existing_path) = existing_matching_destination(source_path, destination_path)? {
        if !paths_match(source_path, &existing_path) {
            fs::remove_file(source_path).map_err(|error| {
                format!("Failed to remove source file after matched move: {}", error)
            })?;
        }
        return Ok(existing_path.to_string_lossy().to_string());
    }

    for _ in 0..10_000 {
        let target_path = next_destination_candidate(source_path, destination_path)?;
        match move_file_no_overwrite(source_path, &target_path) {
            Ok(()) => return Ok(target_path.to_string_lossy().to_string()),
            Err(ExclusiveWriteError::AlreadyExists) => continue,
            Err(ExclusiveWriteError::Other(error)) => return Err(error),
        }
    }

    Err("Unable to resolve a unique destination file name".to_string())
}

fn transfer_images_to_folder_blocking(
    file_paths: Vec<String>,
    destination_folder: String,
    mode: ImageTransferMode,
) -> ImageTransferResult {
    let mut successes = Vec::new();
    let mut failures = Vec::new();

    for source_path in file_paths {
        let result = match mode {
            ImageTransferMode::Copy => {
                copy_image_to_folder_blocking(source_path.clone(), destination_folder.clone())
            }
            ImageTransferMode::Move => {
                move_image_to_folder_blocking(source_path.clone(), destination_folder.clone())
            }
        };

        match result {
            Ok(target_path) => successes.push(ImageTransferSuccess { source_path, target_path }),
            Err(error) => failures.push(ImageTransferFailure { source_path, error }),
        }
    }

    ImageTransferResult { successes, failures }
}

/// Move a file to the OS trash / recycle bin
#[tauri::command]
pub async fn move_to_trash(file_path: String) -> Result<(), String> {
    trash::delete(&file_path).map_err(|e| format!("Failed to move file to trash: {}", e))
}

#[tauri::command]
pub async fn copy_image_to_folder(
    file_path: String,
    destination_folder: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        copy_image_to_folder_blocking(file_path, destination_folder)
    })
    .await
    .map_err(|err| format!("Copy image worker failed: {}", err))?
}

#[tauri::command]
pub async fn move_image_to_folder(
    file_path: String,
    destination_folder: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        move_image_to_folder_blocking(file_path, destination_folder)
    })
    .await
    .map_err(|err| format!("Move image worker failed: {}", err))?
}

#[tauri::command]
pub async fn transfer_images_to_folder(
    file_paths: Vec<String>,
    destination_folder: String,
    mode: ImageTransferMode,
) -> Result<ImageTransferResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        transfer_images_to_folder_blocking(file_paths, destination_folder, mode)
    })
    .await
    .map_err(|err| format!("Transfer images worker failed: {}", err))
}

/// Copy an image file to the OS clipboard
fn copy_image_to_clipboard_blocking(file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    if !path.is_file() {
        return Err(format!("'{}' is not a valid file", file_path));
    }

    let (width, height) = image::image_dimensions(path)
        .map_err(|e| format!("Failed to read image dimensions: {}", e))?;

    crate::image_resource_policy::validate_decode(
        path,
        width,
        height,
        crate::image_resource_policy::OperationClass::Clipboard,
    )
    .map_err(|e| e.to_string())?;

    let img = image::open(path).map_err(|e| format!("Failed to open image: {}", e))?;
    let rgba = img.into_rgba8();
    let (width, height) = rgba.dimensions();
    let image_data = arboard::ImageData {
        width: width as usize,
        height: height as usize,
        bytes: std::borrow::Cow::Owned(rgba.into_raw()),
    };
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("Failed to initialize clipboard: {}", e))?;
    clipboard
        .set_image(image_data)
        .map_err(|e| format!("Failed to copy image to clipboard: {}", e))?;
    Ok(())
}

/// Copy an image file to the OS clipboard
#[tauri::command]
pub async fn copy_image_to_clipboard(file_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || copy_image_to_clipboard_blocking(file_path))
        .await
        .map_err(|err| format!("Clipboard worker failed: {}", err))?
}

fn open_in_external_application_blocking(
    file_path: String,
    application_path: String,
) -> Result<(), String> {
    let image_path = Path::new(&file_path);
    if !image_path.is_file() {
        return Err(format!("'{}' is not a valid file", file_path));
    }

    let editor_path = Path::new(&application_path);
    if !editor_path.is_file() {
        return Err(format!("'{}' is not a valid application", application_path));
    }

    #[cfg(windows)]
    {
        let extension = editor_path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .unwrap_or_default();
        const ALLOWED_EXECUTABLE_EXTENSIONS: &[&str] = &["exe", "cmd", "bat", "com", "ps1"];
        if !ALLOWED_EXECUTABLE_EXTENSIONS.contains(&extension.as_str()) {
            return Err(format!(
                "'{}' does not have a recognized executable extension ({})",
                application_path,
                ALLOWED_EXECUTABLE_EXTENSIONS.join(", ")
            ));
        }
    }

    Command::new(editor_path)
        .arg(image_path)
        .spawn()
        .map_err(|err| format!("Failed to launch external application: {}", err))?;

    Ok(())
}

/// Open an image in a specific external application
#[tauri::command]
pub async fn open_in_external_application(
    file_path: String,
    application_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_in_external_application_blocking(file_path, application_path)
    })
    .await
    .map_err(|err| format!("Open external application worker failed: {}", err))?
}

/// Rotate an image file on disk and save it
fn save_rotated_image_blocking(file_path: String, rotation_degrees: i32) -> Result<(), String> {
    let path = Path::new(&file_path);
    if !path.is_file() {
        return Err(format!("'{}' is not a valid file", file_path));
    }

    let limits = crate::image_resource_policy::PolicyLimits::for_operation(
        crate::image_resource_policy::OperationClass::Rotate,
    );
    crate::image_resource_policy::validate_file_size(path, &limits).map_err(|e| e.to_string())?;

    let (width, height) = image::image_dimensions(path).map_err(|e| {
        format!("Failed to inspect image dimensions for rotation validation: {}", e)
    })?;

    crate::image_resource_policy::validate_decode(
        path,
        width,
        height,
        crate::image_resource_policy::OperationClass::Rotate,
    )
    .map_err(|e| e.to_string())?;

    let extension =
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();

    match rotation_save_strategy(&extension, rotation_degrees) {
        None => Ok(()),
        Some(RotationSaveStrategy::Unsupported) => {
            Err(format!("Saving rotation is not supported for {} files", extension.to_uppercase()))
        }
        Some(RotationSaveStrategy::Reencode) => {
            save_rotated_image_by_reencoding(path, rotation_degrees, "rotation")
        }
        Some(RotationSaveStrategy::LosslessJpegThenFallback) => {
            if let Err(lossless_error) = save_lossless_jpeg_rotation(path, rotation_degrees) {
                eprintln!(
                    "Lossless JPEG rotation failed for '{}': {}. Falling back to pixel re-encode.",
                    file_path, lossless_error
                );
                save_rotated_image_by_reencoding(path, rotation_degrees, "rotation")
            } else {
                Ok(())
            }
        }
    }
}

/// Rotate an image file on disk and save it
#[tauri::command]
pub async fn save_rotated_image(
    window: tauri::Window,
    file_path: String,
    rotation_degrees: i32,
) -> Result<(), String> {
    enforce_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        save_rotated_image_blocking(file_path, rotation_degrees)
    })
    .await
    .map_err(|err| format!("Rotation worker failed: {}", err))?
}

fn save_lossless_jpeg_rotation(path: &Path, rotation_degrees: i32) -> Result<(), String> {
    let jpeg_bytes =
        fs::read(path).map_err(|e| format!("Failed to read JPEG for rotation: {}", e))?;
    let rotated_bytes = try_lossless_jpeg_rotation_bytes(&jpeg_bytes, rotation_degrees)?;
    let temp_path = build_unique_sibling_path(path, "lightframe-rotate")?;

    fs::write(&temp_path, rotated_bytes)
        .map_err(|e| format!("Failed to write temporary rotated JPEG: {}", e))?;

    if let Err(err) = restore_normal_orientation(path, &temp_path, "lossless rotation") {
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }

    if let Err(err) = replace_file_safely(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }

    Ok(())
}

fn save_rotated_image_by_reencoding(
    path: &Path,
    rotation_degrees: i32,
    context_label: &str,
) -> Result<(), String> {
    let img = image::open(path).map_err(|e| format!("Failed to open image for saving: {}", e))?;
    let rotated = apply_rotation(img, rotation_degrees)?;
    let temp_path = build_unique_sibling_path(path, "lightframe-rotate")?;

    write_dynamic_image(&rotated, &temp_path, "Failed to save rotated image")?;

    if let Err(err) = restore_normal_orientation(path, &temp_path, context_label) {
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }

    if let Err(err) = replace_file_safely(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }

    Ok(())
}

fn validate_crop_rect(
    crop_rect: CropRect,
    image_width: u32,
    image_height: u32,
) -> Result<(), String> {
    if crop_rect.width == 0 || crop_rect.height == 0 {
        return Err("Crop rectangle must have non-zero width and height".to_string());
    }

    let right = crop_rect
        .x
        .checked_add(crop_rect.width)
        .ok_or_else(|| "Crop rectangle exceeds image bounds".to_string())?;
    let bottom = crop_rect
        .y
        .checked_add(crop_rect.height)
        .ok_or_else(|| "Crop rectangle exceeds image bounds".to_string())?;

    if right > image_width || bottom > image_height {
        return Err("Crop rectangle is outside the image bounds".to_string());
    }

    Ok(())
}

fn apply_rotation(
    img: image::DynamicImage,
    rotation_degrees: i32,
) -> Result<image::DynamicImage, String> {
    let normalized = rotation_degrees.rem_euclid(360);
    let rotated = match normalized {
        0 => img,
        90 => img.rotate90(),
        180 => img.rotate180(),
        270 => img.rotate270(),
        _ => return Err(format!("Unsupported rotation degrees: {}", rotation_degrees)),
    };

    Ok(rotated)
}

fn write_cropped_image(
    cropped: &image::RgbaImage,
    output_path: &Path,
    error_prefix: &str,
) -> Result<(), String> {
    write_dynamic_image(
        &image::DynamicImage::ImageRgba8(cropped.clone()),
        output_path,
        error_prefix,
    )
}

fn validate_scale_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("Scaled image dimensions must be greater than zero".to_string());
    }

    if width > MAX_SCALE_DIMENSION || height > MAX_SCALE_DIMENSION {
        return Err(format!(
            "Scaled image dimensions must be {} pixels or smaller",
            MAX_SCALE_DIMENSION
        ));
    }

    let pixel_count = scale_pixel_count(width, height)?;
    if pixel_count > MAX_SCALE_PIXELS {
        return Err(format!(
            "Scaled export is limited to {} megapixels",
            MAX_SCALE_PIXELS / 1_000_000
        ));
    }

    Ok(())
}

fn scale_pixel_count(width: u32, height: u32) -> Result<u64, String> {
    u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| "Scaled image dimensions are too large".to_string())
}

fn add_scale_working_bytes(
    total: &mut u64,
    pixel_count: u64,
    buffer_count: u64,
) -> Result<(), String> {
    let bytes = pixel_count
        .checked_mul(buffer_count)
        .and_then(|value| value.checked_mul(SCALE_DECODED_BYTES_PER_PIXEL))
        .ok_or_else(|| "Scaled export would require too much memory".to_string())?;
    *total = total
        .checked_add(bytes)
        .ok_or_else(|| "Scaled export would require too much memory".to_string())?;
    Ok(())
}

fn validate_scale_working_memory(
    source_width: u32,
    source_height: u32,
    width: u32,
    height: u32,
    smoothing: f32,
    sharpening: f32,
) -> Result<(), String> {
    let source_pixels = scale_pixel_count(source_width, source_height)?;
    let target_pixels = scale_pixel_count(width, height)?;
    let source_buffer_count = if normalized_adjustment(smoothing) > 0.0 { 2 } else { 1 };
    let target_buffer_count = if normalized_adjustment(sharpening) > 0.0 { 2 } else { 1 };

    let mut estimated_working_bytes = 0_u64;
    add_scale_working_bytes(&mut estimated_working_bytes, source_pixels, source_buffer_count)?;
    add_scale_working_bytes(&mut estimated_working_bytes, target_pixels, target_buffer_count)?;

    if estimated_working_bytes > MAX_SCALE_WORKING_BYTES {
        return Err(format!(
            "Scaled export would require about {} MB of working memory; limit is {} MB",
            estimated_working_bytes.div_ceil(1024 * 1024),
            MAX_SCALE_WORKING_BYTES / (1024 * 1024)
        ));
    }

    Ok(())
}

fn read_scale_source_dimensions(input_path: &Path) -> Result<(u32, u32), String> {
    image::image_dimensions(input_path)
        .map_err(|e| format!("Failed to read source image dimensions: {}", e))
}

fn path_extension_lowercase(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_default()
}

fn validate_scaled_export_input_path(input_path: &Path) -> Result<(), String> {
    let extension = path_extension_lowercase(input_path);
    if SCALE_EXPORT_INPUT_EXTENSIONS.contains(&extension.as_str()) {
        return Ok(());
    }

    Err("Scaled export supports JPEG, PNG, GIF, WebP, BMP, TIFF, and AVIF source images"
        .to_string())
}

fn validate_scaled_export_output_path(output_path: &Path) -> Result<(), String> {
    let extension = path_extension_lowercase(output_path);
    if SCALE_EXPORT_OUTPUT_EXTENSIONS.contains(&extension.as_str()) {
        return Ok(());
    }

    Err("Scaled export can save JPEG, PNG, GIF, WebP, BMP, or TIFF files".to_string())
}

fn validate_copy_output_path(
    input_path: &Path,
    output_path: &Path,
    allow_existing_output: bool,
) -> Result<(), String> {
    let parent_dir = output_path
        .parent()
        .ok_or_else(|| "Output path must include a parent directory".to_string())?;
    if !parent_dir.exists() {
        return Err("Output directory does not exist".to_string());
    }
    if output_path.exists() && !output_path.is_file() {
        return Err("Output path must be a file".to_string());
    }

    let input_canonical = fs::canonicalize(input_path)
        .map_err(|e| format!("Failed to resolve source path: {}", e))?;
    let output_candidate = if output_path.exists() {
        fs::canonicalize(output_path)
            .map_err(|e| format!("Failed to resolve output path: {}", e))?
    } else if output_path.is_absolute() {
        output_path.to_path_buf()
    } else {
        fs::canonicalize(parent_dir)
            .map_err(|e| format!("Failed to resolve output directory: {}", e))?
            .join(output_path.file_name().ok_or_else(|| "Output file name is missing".to_string())?)
    };

    if input_canonical == output_candidate {
        return Err("Output path must not match the original image".to_string());
    }
    if output_path.exists() && !allow_existing_output {
        return Err("Output path already exists; choose a new file name".to_string());
    }

    Ok(())
}

fn normalized_adjustment(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 100.0) / 100.0
    } else {
        0.0
    }
}

fn apply_resize_adjustments(
    img: image::DynamicImage,
    width: u32,
    height: u32,
    smoothing: f32,
    sharpening: f32,
) -> image::DynamicImage {
    let smooth_amount = normalized_adjustment(smoothing);
    let sharpen_amount = normalized_adjustment(sharpening);
    let smoothed = if smooth_amount > 0.0 { img.blur(smooth_amount * 2.0) } else { img };
    let resized = smoothed.resize_exact(width, height, image::imageops::FilterType::Lanczos3);

    if sharpen_amount > 0.0 {
        resized.unsharpen(0.65 + sharpen_amount * 1.85, 1)
    } else {
        resized
    }
}

fn save_scaled_copy_blocking(
    file_path: String,
    output_path: String,
    width: u32,
    height: u32,
    smoothing: f32,
    sharpening: f32,
) -> Result<(), String> {
    let input_path = Path::new(&file_path);
    if !input_path.is_file() {
        return Err(format!("'{}' is not a valid file", file_path));
    }

    validate_scaled_export_input_path(input_path)?;
    validate_scale_dimensions(width, height)?;

    let output_path_ref = Path::new(&output_path);
    validate_copy_output_path(input_path, output_path_ref, true)?;
    validate_scaled_export_output_path(output_path_ref)?;
    let (source_width, source_height) = read_scale_source_dimensions(input_path)?;
    validate_scale_working_memory(
        source_width,
        source_height,
        width,
        height,
        smoothing,
        sharpening,
    )?;

    let img =
        image::open(input_path).map_err(|e| format!("Failed to open image for scaling: {}", e))?;
    let scaled = apply_resize_adjustments(img, width, height, smoothing, sharpening);
    let temp_path = build_unique_sibling_path(output_path_ref, "lightframe-scale")?;

    if let Err(err) = write_high_quality_image(&scaled, &temp_path, "Failed to save scaled copy") {
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }

    let replace_result = if output_path_ref.exists() {
        replace_file_safely(&temp_path, output_path_ref)
    } else {
        fs::rename(&temp_path, output_path_ref)
            .map_err(|e| format!("Failed to write scaled copy: {}", e))
    };

    if let Err(err) = replace_result {
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }

    Ok(())
}

fn save_cropped_copy_blocking(
    file_path: String,
    crop_rect: CropRect,
    output_path: String,
    rotation_degrees: Option<i32>,
) -> Result<(), String> {
    let input_path = Path::new(&file_path);
    if !input_path.is_file() {
        return Err(format!("'{}' is not a valid file", file_path));
    }

    let output_path_ref = Path::new(&output_path);
    let parent_dir = output_path_ref
        .parent()
        .ok_or_else(|| "Output path must include a parent directory".to_string())?;
    if !parent_dir.exists() {
        return Err("Output directory does not exist".to_string());
    }

    let input_canonical = fs::canonicalize(input_path)
        .map_err(|e| format!("Failed to resolve source path: {}", e))?;
    let output_candidate = if output_path_ref.exists() {
        fs::canonicalize(output_path_ref)
            .map_err(|e| format!("Failed to resolve output path: {}", e))?
    } else if output_path_ref.is_absolute() {
        output_path_ref.to_path_buf()
    } else {
        fs::canonicalize(parent_dir)
            .map_err(|e| format!("Failed to resolve output directory: {}", e))?
            .join(
                output_path_ref
                    .file_name()
                    .ok_or_else(|| "Output file name is missing".to_string())?,
            )
    };

    if input_canonical == output_candidate {
        return Err("Output path must not match the original image".to_string());
    }
    if output_path_ref.exists() {
        return Err("Output path already exists; choose a new file name".to_string());
    }

    let (src_width, src_height) = image::image_dimensions(input_path)
        .map_err(|e| format!("Failed to read image dimensions: {}", e))?;
    crate::image_resource_policy::validate_decode(
        input_path,
        src_width,
        src_height,
        crate::image_resource_policy::OperationClass::Crop,
    )
    .map_err(|e| e.to_string())?;

    let img =
        image::open(input_path).map_err(|e| format!("Failed to open image for crop: {}", e))?;
    let rotated = apply_rotation(img, rotation_degrees.unwrap_or(0))?;
    let (image_width, image_height) = rotated.dimensions();

    validate_crop_rect(crop_rect, image_width, image_height)?;

    let cropped = image::imageops::crop_imm(
        &rotated,
        crop_rect.x,
        crop_rect.y,
        crop_rect.width,
        crop_rect.height,
    )
    .to_image();

    write_cropped_image(&cropped, output_path_ref, "Failed to save cropped copy")?;

    Ok(())
}

fn build_crop_temp_path(source_path: &Path) -> Result<PathBuf, String> {
    build_unique_sibling_path(source_path, "lightframe-crop")
}

fn overwrite_with_crop_blocking(
    file_path: String,
    crop_rect: CropRect,
    rotation_degrees: Option<i32>,
) -> Result<(), String> {
    let input_path = Path::new(&file_path);
    if !input_path.is_file() {
        return Err(format!("'{}' is not a valid file", file_path));
    }

    let extension = input_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_default();

    let (src_width, src_height) = image::image_dimensions(input_path)
        .map_err(|e| format!("Failed to read image dimensions: {}", e))?;
    crate::image_resource_policy::validate_decode(
        input_path,
        src_width,
        src_height,
        crate::image_resource_policy::OperationClass::Overwrite,
    )
    .map_err(|e| e.to_string())?;

    let img =
        image::open(input_path).map_err(|e| format!("Failed to open image for crop: {}", e))?;
    let rotated = apply_rotation(img, rotation_degrees.unwrap_or(0))?;
    let (image_width, image_height) = rotated.dimensions();
    validate_crop_rect(crop_rect, image_width, image_height)?;

    let cropped = image::imageops::crop_imm(
        &rotated,
        crop_rect.x,
        crop_rect.y,
        crop_rect.width,
        crop_rect.height,
    )
    .to_image();

    let temp_path = build_crop_temp_path(input_path)?;
    let metadata = Metadata::new_from_path(input_path).ok();

    if let Err(err) =
        write_cropped_image(&cropped, &temp_path, "Failed to write temporary cropped image")
    {
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }

    if matches!(extension.as_str(), "jpg" | "jpeg" | "png" | "webp") {
        if let Some(mut current_metadata) = metadata {
            current_metadata.set_tag(ExifTag::Orientation(vec![1]));
            if let Err(err) = current_metadata.write_to_file(&temp_path) {
                eprintln!("Failed to preserve metadata for cropped overwrite: {}", err);
            }
        }
    }

    if let Err(err) = replace_file_safely(&temp_path, input_path) {
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }

    Ok(())
}

#[tauri::command]
pub async fn save_cropped_copy(
    file_path: String,
    crop_rect: CropRect,
    output_path: String,
    rotation_degrees: Option<i32>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_cropped_copy_blocking(file_path, crop_rect, output_path, rotation_degrees)
    })
    .await
    .map_err(|err| format!("Crop copy worker failed: {}", err))?
}

#[tauri::command]
pub async fn save_scaled_copy(
    file_path: String,
    output_path: String,
    width: u32,
    height: u32,
    smoothing: f32,
    sharpening: f32,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_scaled_copy_blocking(file_path, output_path, width, height, smoothing, sharpening)
    })
    .await
    .map_err(|err| format!("Scale copy worker failed: {}", err))?
}

#[tauri::command]
pub async fn overwrite_with_crop(
    file_path: String,
    crop_rect: CropRect,
    rotation_degrees: Option<i32>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        overwrite_with_crop_blocking(file_path, crop_rect, rotation_degrees)
    })
    .await
    .map_err(|err| format!("Crop overwrite worker failed: {}", err))?
}

/// Generate a small cached thumbnail asset for high-performance navigation
fn get_thumbnail_blocking(
    file_path: String,
    size_bytes: Option<u64>,
    modified_at: Option<String>,
    app_cache_dir: PathBuf,
) -> Result<thumbnails::GeneratedImageAsset, String> {
    let path = Path::new(&file_path);
    let metadata = thumbnails::resolve_source_metadata(path, size_bytes, modified_at.as_deref())?;
    let thumbnail_cache_dir = app_cache_dir.join("thumbnails");
    thumbnails::get_or_create_thumbnail(path, &metadata, &thumbnail_cache_dir)
}

/// Generate a small cached thumbnail asset for high-performance navigation
#[tauri::command]
pub async fn get_thumbnail(
    app: AppHandle,
    file_path: String,
    size_bytes: Option<u64>,
    modified_at: Option<String>,
) -> Result<thumbnails::GeneratedImageAsset, String> {
    let app_cache_dir =
        app.path().app_cache_dir().map_err(|e| format!("Failed to get app cache dir: {}", e))?;
    tauri::async_runtime::spawn_blocking(move || {
        get_thumbnail_blocking(file_path, size_bytes, modified_at, app_cache_dir)
    })
    .await
    .map_err(|err| format!("Thumbnail worker failed: {}", err))?
}

/// Extract EXIF metadata from an image.
pub use crate::image_metadata::get_exif_metadata_blocking;

#[tauri::command]
pub async fn get_exif_metadata(file_path: String) -> Result<ExifData, String> {
    tauri::async_runtime::spawn_blocking(move || get_exif_metadata_blocking(file_path))
        .await
        .map_err(|error| format!("EXIF worker failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView;
    use libjpeg_turbo_rs::{compress, PixelFormat, Subsampling};
    use std::fs::File;
    use tempfile::tempdir;

    fn make_test_jpeg(width: usize, height: usize, subsampling: Subsampling) -> Vec<u8> {
        let mut pixels = vec![0_u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let offset = (y * width + x) * 3;
                pixels[offset] = (x % 256) as u8;
                pixels[offset + 1] = (y % 256) as u8;
                pixels[offset + 2] = ((x + y) % 256) as u8;
            }
        }

        compress(&pixels, width, height, PixelFormat::Rgb, 90, subsampling).unwrap()
    }

    fn add_exif_orientation(path: &Path, orientation: u16) {
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

    #[test]
    fn test_get_image_caption_reads_same_basename_txt() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("training.image.png");
        let caption_path = dir.path().join("training.image.txt");
        fs::write(&image_path, b"not needed for sidecar lookup").unwrap();
        fs::write(&caption_path, b"  subject token, portrait, soft light\n").unwrap();

        let caption =
            get_image_caption_blocking(image_path.to_string_lossy().to_string()).unwrap().unwrap();

        assert_eq!(caption.text, "subject token, portrait, soft light");
        assert_eq!(caption.sidecar_path, caption_path.to_string_lossy());
        assert_eq!(caption.extension, "txt");
    }

    #[test]
    fn test_get_image_caption_falls_back_to_caption_extension() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("sample.jpg");
        let caption_path = dir.path().join("sample.caption");
        fs::write(&caption_path, b"A natural language caption").unwrap();

        let caption =
            get_image_caption_blocking(image_path.to_string_lossy().to_string()).unwrap().unwrap();

        assert_eq!(caption.text, "A natural language caption");
        assert_eq!(caption.extension, "caption");
    }

    #[test]
    fn test_get_image_caption_prefers_non_empty_txt() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("sample.webp");
        fs::write(dir.path().join("sample.txt"), b"tag list").unwrap();
        fs::write(dir.path().join("sample.caption"), b"sentence").unwrap();

        let caption =
            get_image_caption_blocking(image_path.to_string_lossy().to_string()).unwrap().unwrap();

        assert_eq!(caption.text, "tag list");
        assert_eq!(caption.extension, "txt");
    }

    #[test]
    fn test_get_image_caption_decodes_utf16_little_endian() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("sample.png");
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "portrait, café".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        fs::write(dir.path().join("sample.txt"), bytes).unwrap();

        let caption =
            get_image_caption_blocking(image_path.to_string_lossy().to_string()).unwrap().unwrap();

        assert_eq!(caption.text, "portrait, café");
    }

    #[test]
    fn test_get_image_caption_returns_none_without_non_empty_sidecar() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("sample.png");
        fs::write(dir.path().join("sample.txt"), b" \n\t").unwrap();

        let caption = get_image_caption_blocking(image_path.to_string_lossy().to_string()).unwrap();

        assert_eq!(caption, None);
    }

    #[test]
    fn test_supported_extension_manifest_matches_scanner_and_file_associations() {
        let manifest: Vec<String> =
            serde_json::from_str(include_str!("../../../supported-image-extensions.json")).unwrap();
        let scanner: Vec<String> =
            SUPPORTED_EXTENSIONS.iter().map(|extension| (*extension).to_string()).collect();
        let tauri_config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let associations: Vec<String> = tauri_config["bundle"]["fileAssociations"][0]["ext"]
            .as_array()
            .unwrap()
            .iter()
            .map(|extension| extension.as_str().unwrap().to_string())
            .collect();

        assert_eq!(manifest, scanner, "Rust scanner drifted from the canonical manifest");
        assert_eq!(manifest, associations, "desktop file associations drifted from the manifest");
    }

    #[test]
    fn test_filesystem_timestamp_token_preserves_subsecond_precision() {
        let first = UNIX_EPOCH + std::time::Duration::new(1_700_000_000, 123_456_700);
        let second = UNIX_EPOCH + std::time::Duration::new(1_700_000_000, 123_456_800);

        assert_eq!(filesystem_timestamp_token(first), "1700000000123456700");
        assert_eq!(filesystem_timestamp_token(second), "1700000000123456800");
        assert_ne!(filesystem_timestamp_token(first), filesystem_timestamp_token(second));
    }

    #[test]
    fn test_next_destination_candidate_avoids_multiple_existing_names() {
        let dir = tempdir().unwrap();
        let source_path = dir.path().join("photo.jpg");
        let destination_dir = dir.path().join("destination");
        fs::create_dir(&destination_dir).unwrap();
        fs::write(&source_path, b"source").unwrap();
        fs::write(destination_dir.join("photo.jpg"), b"existing").unwrap();
        fs::write(destination_dir.join("photo copy.jpg"), b"existing copy").unwrap();

        let target_path = next_destination_candidate(&source_path, &destination_dir).unwrap();

        assert_eq!(
            target_path.file_name().and_then(|value| value.to_str()),
            Some("photo copy 2.jpg")
        );
    }

    #[test]
    fn test_copy_image_to_folder_blocking_copies_with_conflict_name() {
        let dir = tempdir().unwrap();
        let source_path = dir.path().join("photo.jpg");
        let destination_dir = dir.path().join("destination");
        fs::create_dir(&destination_dir).unwrap();
        fs::write(&source_path, b"source").unwrap();
        fs::write(destination_dir.join("photo.jpg"), b"existing").unwrap();

        let copied_path = copy_image_to_folder_blocking(
            source_path.to_string_lossy().to_string(),
            destination_dir.to_string_lossy().to_string(),
        )
        .unwrap();

        assert!(Path::new(&copied_path).exists());
        assert_eq!(fs::read(Path::new(&copied_path)).unwrap(), b"source");
        assert_eq!(fs::read(destination_dir.join("photo.jpg")).unwrap(), b"existing");
    }

    #[test]
    fn test_copy_image_to_folder_blocking_reuses_matching_existing_destination() {
        let dir = tempdir().unwrap();
        let source_path = dir.path().join("photo.jpg");
        let destination_dir = dir.path().join("destination");
        fs::create_dir(&destination_dir).unwrap();
        fs::write(&source_path, b"same-bytes").unwrap();
        fs::write(destination_dir.join("photo.jpg"), b"same-bytes").unwrap();

        let copied_path = copy_image_to_folder_blocking(
            source_path.to_string_lossy().to_string(),
            destination_dir.to_string_lossy().to_string(),
        )
        .unwrap();

        assert_eq!(Path::new(&copied_path), destination_dir.join("photo.jpg").as_path());
        assert!(!destination_dir.join("photo copy.jpg").exists());
    }

    #[test]
    fn test_move_image_to_folder_blocking_moves_file() {
        let dir = tempdir().unwrap();
        let source_path = dir.path().join("photo.jpg");
        let destination_dir = dir.path().join("destination");
        fs::create_dir(&destination_dir).unwrap();
        fs::write(&source_path, b"source").unwrap();

        let moved_path = move_image_to_folder_blocking(
            source_path.to_string_lossy().to_string(),
            destination_dir.to_string_lossy().to_string(),
        )
        .unwrap();

        assert!(!source_path.exists());
        assert_eq!(fs::read(Path::new(&moved_path)).unwrap(), b"source");
    }

    #[test]
    fn test_move_image_to_folder_blocking_reuses_matching_existing_destination() {
        let dir = tempdir().unwrap();
        let source_path = dir.path().join("photo.jpg");
        let destination_dir = dir.path().join("destination");
        fs::create_dir(&destination_dir).unwrap();
        fs::write(&source_path, b"same-bytes").unwrap();
        fs::write(destination_dir.join("photo.jpg"), b"same-bytes").unwrap();

        let moved_path = move_image_to_folder_blocking(
            source_path.to_string_lossy().to_string(),
            destination_dir.to_string_lossy().to_string(),
        )
        .unwrap();

        assert_eq!(Path::new(&moved_path), destination_dir.join("photo.jpg").as_path());
        assert!(!source_path.exists());
        assert!(!destination_dir.join("photo copy.jpg").exists());
    }

    #[test]
    fn test_transfer_images_to_folder_blocking_reports_successes_and_failures() {
        let dir = tempdir().unwrap();
        let source_path = dir.path().join("photo.jpg");
        let missing_path = dir.path().join("missing.jpg");
        let destination_dir = dir.path().join("destination");
        fs::create_dir(&destination_dir).unwrap();
        fs::write(&source_path, b"source").unwrap();

        let result = transfer_images_to_folder_blocking(
            vec![
                source_path.to_string_lossy().to_string(),
                missing_path.to_string_lossy().to_string(),
            ],
            destination_dir.to_string_lossy().to_string(),
            ImageTransferMode::Copy,
        );

        assert_eq!(result.successes.len(), 1);
        assert_eq!(result.successes[0].source_path, source_path.to_string_lossy());
        assert!(Path::new(&result.successes[0].target_path).exists());
        assert_eq!(result.failures.len(), 1);
        assert_eq!(result.failures[0].source_path, missing_path.to_string_lossy());
        assert!(result.failures[0].error.contains("valid file"));
    }

    #[test]
    fn test_copy_image_to_folder_blocking_rejects_missing_destination() {
        let dir = tempdir().unwrap();
        let source_path = dir.path().join("photo.jpg");
        fs::write(&source_path, b"source").unwrap();

        let error = copy_image_to_folder_blocking(
            source_path.to_string_lossy().to_string(),
            dir.path().join("missing").to_string_lossy().to_string(),
        )
        .unwrap_err();

        assert!(error.contains("valid destination folder"));
    }

    #[test]
    fn test_natural_sort_key() {
        let key_a = natural_sort_key("image10.jpg");
        let key_b = natural_sort_key("image2.jpg");
        let key_c = natural_sort_key("image1.jpg");

        // image1 < image2 < image10
        assert!(key_c < key_b);
        assert!(key_b < key_a);
    }

    #[test]
    fn test_natural_sort_mixed() {
        let key_a = natural_sort_key("a1b2");
        let key_b = natural_sort_key("a1b10");
        assert!(key_a < key_b);
    }

    #[test]
    fn test_scan_folder_blocking() {
        let dir = tempdir().unwrap();
        let path = dir.path();

        File::create(path.join("image10.jpg")).unwrap();
        File::create(path.join("image2.png")).unwrap();
        File::create(path.join("image1.webp")).unwrap();
        File::create(path.join("image3.cr2")).unwrap();
        File::create(path.join("no_extension")).unwrap();
        File::create(path.join("not_an_image.txt")).unwrap();
        fs::create_dir(path.join("subdir")).unwrap();

        let results = scan_folder_blocking(path.to_string_lossy().to_string()).unwrap();

        let sorted_names: Vec<&str> = results.iter().map(|img| img.file_name.as_str()).collect();
        assert_eq!(sorted_names, vec!["image1.webp", "image2.png", "image3.cr2", "image10.jpg"]);
        assert!(!results.iter().any(|img| img.file_name == "no_extension"));
    }

    #[test]
    fn test_sort_scanned_images_tie_breaks_on_lowercase_then_path() {
        let mut images = vec![
            ScannedImage {
                sort_key: natural_sort_key("img2.jpg"),
                lowercase_file_name: "img2.jpg".to_string(),
                image: ImageFile {
                    path: "/tmp/z/img2.jpg".to_string(),
                    file_name: "img2.jpg".to_string(),
                    extension: "jpg".to_string(),
                    size_bytes: 0,
                    modified_at: None,
                    created_at: None,
                },
            },
            ScannedImage {
                sort_key: natural_sort_key("IMG2.jpg"),
                lowercase_file_name: "img2.jpg".to_string(),
                image: ImageFile {
                    path: "/tmp/a/IMG2.jpg".to_string(),
                    file_name: "IMG2.jpg".to_string(),
                    extension: "jpg".to_string(),
                    size_bytes: 0,
                    modified_at: None,
                    created_at: None,
                },
            },
        ];

        sort_scanned_images(&mut images);

        let sorted_names: Vec<&str> =
            images.iter().map(|scanned| scanned.image.file_name.as_str()).collect();
        assert_eq!(sorted_names, vec!["IMG2.jpg", "img2.jpg"]);
    }

    #[test]
    fn test_get_image_metadata_blocking_png_dimensions_and_size() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("tiny.png");

        image::RgbaImage::new(2, 3).save(&image_path).unwrap();
        let expected_size = fs::metadata(&image_path).unwrap().len();

        let metadata =
            get_image_metadata_blocking(image_path.to_string_lossy().to_string()).unwrap();

        assert_eq!(metadata.width, Some(2));
        assert_eq!(metadata.height, Some(3));
        assert_eq!(metadata.format, "PNG");
        assert_eq!(metadata.codec_backend, "rust_image");
        assert!(!metadata.native_decode_supported);
        assert_eq!(metadata.detail_backend, "unsupported");
        assert!(!metadata.detail_supported);
        assert_eq!(metadata.file_size_bytes, expected_size);
        assert!(metadata.browser_renderable);
        assert!(metadata.rust_decode_supported);
        assert!(metadata.metadata_supported);
        assert!(metadata.thumbnail_supported);
        assert_eq!(metadata.support_note, None);
    }

    #[test]
    fn test_get_image_metadata_blocking_uses_exif_oriented_dimensions() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("oriented.jpg");

        image::RgbImage::new(320, 160).save(&image_path).unwrap();
        add_exif_orientation(&image_path, 6);

        let metadata =
            get_image_metadata_blocking(image_path.to_string_lossy().to_string()).unwrap();

        assert_eq!(metadata.width, Some(160));
        assert_eq!(metadata.height, Some(320));
    }

    #[test]
    fn test_get_image_metadata_blocking_reports_raw_placeholder_support() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("sample.cr2");
        fs::write(&image_path, b"not-a-decodable-raw").unwrap();
        let expected_size = fs::metadata(&image_path).unwrap().len();

        let metadata =
            get_image_metadata_blocking(image_path.to_string_lossy().to_string()).unwrap();

        assert_eq!(metadata.width, None);
        assert_eq!(metadata.height, None);
        assert_eq!(metadata.format, "Canon RAW");
        assert_eq!(metadata.codec_backend, "unsupported");
        assert!(!metadata.native_decode_supported);
        assert_eq!(metadata.detail_backend, "unsupported");
        assert!(!metadata.detail_supported);
        assert_eq!(metadata.file_size_bytes, expected_size);
        assert!(!metadata.browser_renderable);
        assert!(!metadata.rust_decode_supported);
        assert!(metadata.metadata_supported);
        assert!(metadata.thumbnail_supported);
        assert!(metadata.support_note.as_deref().unwrap_or_default().contains("RAW"));
    }

    #[test]
    fn test_get_image_metadata_blocking_falls_back_for_heic_files() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("sample.heic");
        fs::write(&image_path, b"not-a-real-heic").unwrap();
        let expected_size = fs::metadata(&image_path).unwrap().len();

        let metadata =
            get_image_metadata_blocking(image_path.to_string_lossy().to_string()).unwrap();

        assert_eq!(metadata.width, None);
        assert_eq!(metadata.height, None);
        assert_eq!(metadata.format, "HEIC");
        assert_eq!(metadata.codec_backend, "browser_renderable");
        assert!(!metadata.native_decode_supported);
        #[cfg(windows)]
        assert_eq!(metadata.detail_backend, "windows_native");
        #[cfg(not(windows))]
        assert_eq!(metadata.detail_backend, "unsupported");
        assert!(!metadata.detail_supported);
        assert_eq!(metadata.file_size_bytes, expected_size);
        assert!(metadata.browser_renderable);
        assert!(!metadata.rust_decode_supported);
        assert!(metadata.metadata_supported);
        assert!(metadata.thumbnail_supported);
        assert!(metadata.support_note.as_deref().unwrap_or_default().contains("previews"));
    }

    #[test]
    fn test_get_image_metadata_blocking_falls_back_for_decode_limited_formats() {
        let dir = tempdir().unwrap();

        for (file_name, expected_format) in [
            ("sample.heic", "HEIC"),
            ("sample.heif", "HEIC"),
            ("sample.avif", "AVIF"),
            ("sample.svg", "SVG"),
        ] {
            let file_path = dir.path().join(file_name);
            fs::write(&file_path, b"not-a-decodable-image").unwrap();
            let expected_size = fs::metadata(&file_path).unwrap().len();

            let metadata =
                get_image_metadata_blocking(file_path.to_string_lossy().to_string()).unwrap();

            assert_eq!(metadata.width, None, "unexpected width for {}", file_name);
            assert_eq!(metadata.height, None, "unexpected height for {}", file_name);
            assert_eq!(
                metadata.file_size_bytes, expected_size,
                "unexpected size for {}",
                file_name
            );
            assert_eq!(metadata.format, expected_format, "unexpected format for {}", file_name);
            assert!(!metadata.detail_supported, "unexpected detail support for {}", file_name);
        }
    }

    #[test]
    fn test_codec_health_report_includes_cache_and_core_formats() {
        let dir = tempdir().unwrap();
        let report = codec_health_report_blocking(dir.path().to_path_buf());

        assert_eq!(report.platform, std::env::consts::OS);
        assert!(report.entries.iter().any(|entry| entry.label == "JPEG detail"));
        assert!(report.entries.iter().any(|entry| entry.label == "HEIC / HEIF"));
        assert!(report.entries.iter().any(|entry| entry.label == "Camera RAW"));
        assert_eq!(report.generated_cache.total_file_count, 0);
    }

    #[test]
    fn test_codec_health_entry_reports_native_status_for_heif() {
        let entry = codec_health_entry(
            "HEIC / HEIF",
            &["heic", "heif"],
            "Windows native codec enables previews.",
        );

        #[cfg(windows)]
        {
            assert!(entry.native_decoder_available.is_some());
            assert!(matches!(entry.status.as_str(), "native-ready" | "fallback"));
        }

        #[cfg(not(windows))]
        {
            assert_eq!(entry.native_decoder_available, None);
            assert_eq!(entry.status, "preview-first");
        }
    }

    #[test]
    fn test_codec_health_status_distinguishes_partial_native_coverage() {
        let capability = native_codecs::codec_capability_for_extension("cr2");
        let health = native_codecs::NativeDecoderHealth {
            available: false,
            decoder_names: vec!["Sample RAW decoder".to_string()],
            supported_extensions: vec!["cr2".to_string()],
            missing_extensions: vec!["nef".to_string()],
            error: None,
        };

        assert_eq!(codec_health_status(capability, Some(&health)), "partial");
    }

    #[test]
    fn test_get_exif_metadata_blocking_reads_xmp_sidecar_for_raw() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("sample.cr2");
        let sidecar_path = dir.path().join("sample.xmp");
        fs::write(&image_path, b"not-a-decodable-raw").unwrap();
        fs::write(
            &sidecar_path,
            r#"
            <x:xmpmeta xmlns:x="adobe:ns:meta/">
              <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
                <rdf:Description
                  xmlns:tiff="http://ns.adobe.com/tiff/1.0/"
                  xmlns:xmp="http://ns.adobe.com/xap/1.0/"
                  xmlns:exif="http://ns.adobe.com/exif/1.0/"
                  tiff:Make="Canon"
                  tiff:Model="EOS R5"
                  xmp:CreatorTool="Lightroom"
                  xmp:CreateDate="2026-05-20T10:20:30+10:00"
                  exif:FNumber="28/10"
                  exif:ExposureTime="1/250"
                  exif:FocalLength="85/1">
                  <exif:ISOSpeedRatings>
                    <rdf:Seq><rdf:li>400</rdf:li></rdf:Seq>
                  </exif:ISOSpeedRatings>
                </rdf:Description>
              </rdf:RDF>
            </x:xmpmeta>
            "#,
        )
        .unwrap();

        let metadata =
            get_exif_metadata_blocking(image_path.to_string_lossy().to_string()).unwrap();

        assert_eq!(metadata.make.as_deref(), Some("Canon"));
        assert_eq!(metadata.model.as_deref(), Some("EOS R5"));
        assert_eq!(metadata.software.as_deref(), Some("Lightroom"));
        assert_eq!(metadata.date_time.as_deref(), Some("2026-05-20T10:20:30+10:00"));
        assert_eq!(metadata.f_number, Some(2.8));
        assert_eq!(metadata.exposure_time.as_deref(), Some("1/250"));
        assert_eq!(metadata.iso, Some(400));
        assert_eq!(metadata.focal_length.as_deref(), Some("85/1"));
        assert_eq!(metadata.raw.get("XMP Sidecar").map(String::as_str), Some("sample.xmp"));
    }

    #[test]
    fn test_rotation_save_strategy_uses_lossless_attempt_for_jpeg_right_angles() {
        assert_eq!(
            rotation_save_strategy("jpg", 90),
            Some(RotationSaveStrategy::LosslessJpegThenFallback)
        );
        assert_eq!(
            rotation_save_strategy("jpeg", 180),
            Some(RotationSaveStrategy::LosslessJpegThenFallback)
        );
        assert_eq!(
            rotation_save_strategy("jpeg", 270),
            Some(RotationSaveStrategy::LosslessJpegThenFallback)
        );
    }

    #[test]
    fn test_rotation_save_strategy_uses_reencode_for_png() {
        assert_eq!(rotation_save_strategy("png", 90), Some(RotationSaveStrategy::Reencode));
    }

    #[test]
    fn test_rotation_save_strategy_rejects_unsupported_extensions() {
        assert_eq!(rotation_save_strategy("gif", 90), Some(RotationSaveStrategy::Unsupported));
    }

    #[test]
    fn test_try_lossless_jpeg_rotation_bytes_succeeds_for_aligned_jpeg() {
        let jpeg_bytes = make_test_jpeg(64, 48, Subsampling::S420);
        let rotated = try_lossless_jpeg_rotation_bytes(&jpeg_bytes, 90).unwrap();
        let rotated_image = image::load_from_memory(&rotated).unwrap();

        assert_eq!(rotated_image.dimensions(), (48, 64));
    }

    #[test]
    fn test_try_lossless_jpeg_rotation_bytes_fails_for_partial_mcu_jpeg() {
        let jpeg_bytes = make_test_jpeg(30, 30, Subsampling::S420);
        let error = try_lossless_jpeg_rotation_bytes(&jpeg_bytes, 90).unwrap_err();

        assert!(error.contains("not iMCU-aligned"));
    }

    #[test]
    fn test_save_rotated_image_blocking_falls_back_for_partial_mcu_jpeg() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("partial.jpg");
        fs::write(&image_path, make_test_jpeg(30, 46, Subsampling::S420)).unwrap();

        save_rotated_image_blocking(image_path.to_string_lossy().to_string(), 90).unwrap();

        let rotated = image::open(&image_path).unwrap();
        assert_eq!(rotated.dimensions(), (46, 30));
    }

    #[test]
    fn test_get_preview_image_blocking_respects_max_dimension() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("large.jpg");
        let cache_dir = dir.path().join("cache");
        image::RgbImage::from_pixel(5000, 3000, image::Rgb([200, 50, 50]))
            .save(&image_path)
            .unwrap();

        let preview_asset = get_preview_image_blocking(
            image_path.to_string_lossy().to_string(),
            2048,
            None,
            cache_dir,
        )
        .unwrap();
        let bytes = fs::read(&preview_asset.file_path).unwrap();
        let preview = image::load_from_memory(&bytes).unwrap();
        let (width, height) = preview.dimensions();

        assert!(
            preview_asset.file_path.ends_with(".jpg") || preview_asset.file_path.ends_with(".png")
        );
        assert!(width <= 2048);
        assert!(height <= 2048);
        assert_eq!(preview_asset.width, Some(width));
        assert_eq!(preview_asset.height, Some(height));
    }

    #[test]
    fn test_get_preview_image_blocking_does_not_upscale_small_images() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("small.png");
        let cache_dir = dir.path().join("cache");
        image::RgbaImage::from_pixel(640, 360, image::Rgba([0, 120, 220, 255]))
            .save(&image_path)
            .unwrap();

        let preview_asset = get_preview_image_blocking(
            image_path.to_string_lossy().to_string(),
            2048,
            None,
            cache_dir,
        )
        .unwrap();
        let bytes = fs::read(&preview_asset.file_path).unwrap();
        let preview = image::load_from_memory(&bytes).unwrap();
        let (width, height) = preview.dimensions();

        assert!(preview_asset.file_path.ends_with(".png"));
        assert_eq!(width, 640);
        assert_eq!(height, 360);
        assert_eq!(preview_asset.width, Some(640));
        assert_eq!(preview_asset.height, Some(360));
    }

    #[test]
    fn test_get_image_tile_blocking_writes_expected_jpeg_tile() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("large.jpg");
        let cache_dir = dir.path().join("cache");
        fs::write(&image_path, make_test_jpeg(640, 480, Subsampling::S444)).unwrap();

        let tile_asset = get_image_tile_blocking(
            image_path.to_string_lossy().to_string(),
            640,
            480,
            256,
            2,
            1,
            cache_dir,
        )
        .unwrap();
        let tile = image::open(&tile_asset.file_path).unwrap();

        assert!(tile_asset.file_path.ends_with(".jpg"));
        assert_eq!(tile.dimensions(), (128, 224));
        assert_eq!(tile_asset.width, Some(128));
        assert_eq!(tile_asset.height, Some(224));
    }

    #[test]
    fn test_get_image_tile_blocking_rejects_out_of_bounds_tiles() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("large.jpg");
        let cache_dir = dir.path().join("cache");
        fs::write(&image_path, make_test_jpeg(640, 480, Subsampling::S444)).unwrap();

        let error = get_image_tile_blocking(
            image_path.to_string_lossy().to_string(),
            640,
            480,
            256,
            3,
            1,
            cache_dir,
        )
        .unwrap_err();

        assert!(error.contains("outside"));
    }

    #[test]
    fn test_get_image_tile_blocking_rejects_stale_source_dimensions() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("large.jpg");
        let cache_dir = dir.path().join("cache");
        fs::write(&image_path, make_test_jpeg(640, 480, Subsampling::S444)).unwrap();

        let error = get_image_tile_blocking(
            image_path.to_string_lossy().to_string(),
            800,
            480,
            256,
            0,
            0,
            cache_dir,
        )
        .unwrap_err();

        assert!(error.contains("stale"));
    }

    #[test]
    fn test_save_cropped_copy_blocking_writes_new_image_with_expected_dimensions() {
        let dir = tempdir().unwrap();
        let input_path = dir.path().join("source.png");
        let output_path = dir.path().join("source-cropped.png");

        image::RgbaImage::from_pixel(100, 80, image::Rgba([10, 20, 30, 255]))
            .save(&input_path)
            .unwrap();

        save_cropped_copy_blocking(
            input_path.to_string_lossy().to_string(),
            CropRect { x: 10, y: 5, width: 40, height: 30 },
            output_path.to_string_lossy().to_string(),
            None,
        )
        .unwrap();

        let cropped = image::open(&output_path).unwrap();
        let original = image::open(&input_path).unwrap();

        assert_eq!(cropped.dimensions(), (40, 30));
        assert_eq!(original.dimensions(), (100, 80));
    }

    #[test]
    fn test_save_scaled_copy_blocking_writes_new_image_with_expected_dimensions() {
        let dir = tempdir().unwrap();
        let input_path = dir.path().join("source.png");
        let output_path = dir.path().join("source-scaled.png");

        image::RgbaImage::from_pixel(100, 80, image::Rgba([10, 20, 30, 255]))
            .save(&input_path)
            .unwrap();

        save_scaled_copy_blocking(
            input_path.to_string_lossy().to_string(),
            output_path.to_string_lossy().to_string(),
            50,
            40,
            20.0,
            30.0,
        )
        .unwrap();

        let scaled = image::open(&output_path).unwrap();
        let original = image::open(&input_path).unwrap();

        assert_eq!(scaled.dimensions(), (50, 40));
        assert_eq!(original.dimensions(), (100, 80));
    }

    #[test]
    fn test_save_scaled_copy_blocking_rejects_invalid_dimensions() {
        let dir = tempdir().unwrap();
        let input_path = dir.path().join("source.png");
        let output_path = dir.path().join("source-scaled.png");

        image::RgbaImage::from_pixel(64, 64, image::Rgba([120, 10, 30, 255]))
            .save(&input_path)
            .unwrap();

        let error = save_scaled_copy_blocking(
            input_path.to_string_lossy().to_string(),
            output_path.to_string_lossy().to_string(),
            0,
            40,
            0.0,
            0.0,
        )
        .unwrap_err();

        assert!(error.contains("greater than zero"));
        assert!(!output_path.exists());
    }

    #[test]
    fn test_save_scaled_copy_blocking_rejects_excessive_pixel_count() {
        let dir = tempdir().unwrap();
        let input_path = dir.path().join("source.png");
        let output_path = dir.path().join("source-scaled.png");

        image::RgbaImage::from_pixel(64, 64, image::Rgba([120, 10, 30, 255]))
            .save(&input_path)
            .unwrap();

        let error = save_scaled_copy_blocking(
            input_path.to_string_lossy().to_string(),
            output_path.to_string_lossy().to_string(),
            65_535,
            65_535,
            0.0,
            0.0,
        )
        .unwrap_err();

        assert!(error.contains("limited to 50 megapixels"));
        assert!(!output_path.exists());
    }

    #[test]
    fn test_scaled_copy_preflight_rejects_huge_source_dimensions() {
        let error =
            validate_scale_working_memory(250_000, 1_000, 3840, 2160, 0.0, 0.0).unwrap_err();

        assert!(error.contains("working memory"));
    }

    #[test]
    fn test_save_scaled_copy_blocking_rejects_unsupported_source_format() {
        let dir = tempdir().unwrap();
        let input_path = dir.path().join("source.svg");
        let output_path = dir.path().join("source-scaled.jpg");
        fs::write(&input_path, "<svg xmlns=\"http://www.w3.org/2000/svg\" />").unwrap();

        let error = save_scaled_copy_blocking(
            input_path.to_string_lossy().to_string(),
            output_path.to_string_lossy().to_string(),
            50,
            40,
            0.0,
            0.0,
        )
        .unwrap_err();

        assert!(error.contains("source images"));
        assert!(!output_path.exists());
    }

    #[test]
    fn test_save_scaled_copy_blocking_rejects_unsupported_output_format() {
        let dir = tempdir().unwrap();
        let input_path = dir.path().join("source.png");
        let output_path = dir.path().join("source-scaled.heic");

        image::RgbaImage::from_pixel(100, 80, image::Rgba([10, 20, 30, 255]))
            .save(&input_path)
            .unwrap();

        let error = save_scaled_copy_blocking(
            input_path.to_string_lossy().to_string(),
            output_path.to_string_lossy().to_string(),
            50,
            40,
            0.0,
            0.0,
        )
        .unwrap_err();

        assert!(error.contains("can save"));
        assert!(!output_path.exists());
    }

    #[test]
    fn test_save_scaled_copy_blocking_can_replace_existing_output() {
        let dir = tempdir().unwrap();
        let input_path = dir.path().join("source.png");
        let output_path = dir.path().join("source-scaled.png");

        image::RgbaImage::from_pixel(100, 80, image::Rgba([10, 20, 30, 255]))
            .save(&input_path)
            .unwrap();
        image::RgbaImage::from_pixel(8, 8, image::Rgba([200, 10, 30, 255]))
            .save(&output_path)
            .unwrap();

        save_scaled_copy_blocking(
            input_path.to_string_lossy().to_string(),
            output_path.to_string_lossy().to_string(),
            50,
            40,
            0.0,
            0.0,
        )
        .unwrap();

        let scaled = image::open(&output_path).unwrap();
        assert_eq!(scaled.dimensions(), (50, 40));
    }

    #[test]
    fn test_save_cropped_copy_blocking_rejects_out_of_bounds_crop() {
        let dir = tempdir().unwrap();
        let input_path = dir.path().join("source.png");
        let output_path = dir.path().join("source-cropped.png");

        image::RgbaImage::from_pixel(64, 64, image::Rgba([120, 10, 30, 255]))
            .save(&input_path)
            .unwrap();

        let error = save_cropped_copy_blocking(
            input_path.to_string_lossy().to_string(),
            CropRect { x: 50, y: 50, width: 20, height: 20 },
            output_path.to_string_lossy().to_string(),
            None,
        )
        .unwrap_err();

        assert!(error.contains("outside the image bounds"));
        assert!(!output_path.exists());
    }

    #[test]
    fn test_save_cropped_copy_blocking_rejects_zero_sized_crop() {
        let dir = tempdir().unwrap();
        let input_path = dir.path().join("source.png");
        let output_path = dir.path().join("source-cropped.png");

        image::RgbaImage::from_pixel(64, 64, image::Rgba([120, 10, 30, 255]))
            .save(&input_path)
            .unwrap();

        let error = save_cropped_copy_blocking(
            input_path.to_string_lossy().to_string(),
            CropRect { x: 0, y: 0, width: 0, height: 20 },
            output_path.to_string_lossy().to_string(),
            None,
        )
        .unwrap_err();

        assert!(error.contains("non-zero width and height"));
        assert!(!output_path.exists());
    }

    #[test]
    fn test_save_cropped_copy_blocking_rejects_same_path_as_source() {
        let dir = tempdir().unwrap();
        let input_path = dir.path().join("source.png");

        image::RgbaImage::from_pixel(64, 64, image::Rgba([120, 10, 30, 255]))
            .save(&input_path)
            .unwrap();

        let original = image::open(&input_path).unwrap();
        let error = save_cropped_copy_blocking(
            input_path.to_string_lossy().to_string(),
            CropRect { x: 0, y: 0, width: 20, height: 20 },
            input_path.to_string_lossy().to_string(),
            None,
        )
        .unwrap_err();

        assert!(error.contains("must not match the original image"));
        assert_eq!(image::open(&input_path).unwrap().dimensions(), original.dimensions());
    }

    #[test]
    fn test_save_cropped_copy_blocking_rejects_existing_output_file() {
        let dir = tempdir().unwrap();
        let input_path = dir.path().join("source.png");
        let output_path = dir.path().join("existing.png");

        image::RgbaImage::from_pixel(64, 64, image::Rgba([120, 10, 30, 255]))
            .save(&input_path)
            .unwrap();
        image::RgbaImage::from_pixel(10, 10, image::Rgba([255, 0, 0, 255]))
            .save(&output_path)
            .unwrap();

        let existing = image::open(&output_path).unwrap();
        let error = save_cropped_copy_blocking(
            input_path.to_string_lossy().to_string(),
            CropRect { x: 0, y: 0, width: 20, height: 20 },
            output_path.to_string_lossy().to_string(),
            None,
        )
        .unwrap_err();

        assert!(error.contains("already exists"));
        assert_eq!(image::open(&output_path).unwrap().dimensions(), existing.dimensions());
    }

    #[test]
    fn test_overwrite_with_crop_blocking_replaces_original_dimensions() {
        let dir = tempdir().unwrap();
        let input_path = dir.path().join("source.png");

        image::RgbaImage::from_pixel(120, 90, image::Rgba([10, 20, 30, 255]))
            .save(&input_path)
            .unwrap();

        overwrite_with_crop_blocking(
            input_path.to_string_lossy().to_string(),
            CropRect { x: 10, y: 15, width: 50, height: 40 },
            None,
        )
        .unwrap();

        let overwritten = image::open(&input_path).unwrap();
        assert_eq!(overwritten.dimensions(), (50, 40));
    }

    #[test]
    fn test_overwrite_with_crop_blocking_invalid_crop_keeps_original_dimensions() {
        let dir = tempdir().unwrap();
        let input_path = dir.path().join("source.png");

        image::RgbaImage::from_pixel(120, 90, image::Rgba([10, 20, 30, 255]))
            .save(&input_path)
            .unwrap();

        let before = image::open(&input_path).unwrap();
        let error = overwrite_with_crop_blocking(
            input_path.to_string_lossy().to_string(),
            CropRect { x: 110, y: 80, width: 20, height: 20 },
            None,
        )
        .unwrap_err();

        assert!(error.contains("outside the image bounds"));
        assert_eq!(image::open(&input_path).unwrap().dimensions(), before.dimensions());
    }

    #[cfg(windows)]
    #[test]
    fn test_overwrite_with_crop_blocking_preserves_unrelated_backup_named_file() {
        let dir = tempdir().unwrap();
        let input_path = dir.path().join("photo.jpg");
        let unrelated_backup_path = dir.path().join("photo.lightframe-backup");
        let sentinel = b"keep-this-backup-file";

        image::RgbImage::from_pixel(120, 90, image::Rgb([10, 20, 30])).save(&input_path).unwrap();
        fs::write(&unrelated_backup_path, sentinel).unwrap();

        overwrite_with_crop_blocking(
            input_path.to_string_lossy().to_string(),
            CropRect { x: 10, y: 15, width: 50, height: 40 },
            None,
        )
        .unwrap();

        assert_eq!(image::open(&input_path).unwrap().dimensions(), (50, 40));
        assert_eq!(fs::read(&unrelated_backup_path).unwrap(), sentinel);
    }

    #[test]
    fn test_app_settings_deserialize_legacy_json_without_window_bounds() {
        let legacy_json = r#"{
            "theme":"dark",
            "slideshow_interval_seconds":4,
            "loop_slideshow":false,
            "shuffle_slideshow":false,
            "auto_fullscreen_on_slideshow":true,
            "mouse_wheel_behavior":"zoom",
            "default_fit_mode":"fit",
            "remember_window_bounds":true,
            "sort_order":"name",
            "show_thumbnails":true
        }"#;

        let settings: AppSettings = serde_json::from_str(legacy_json).unwrap();
        assert_eq!(settings.window_x, None);
        assert_eq!(settings.window_y, None);
        assert_eq!(settings.window_width, None);
        assert_eq!(settings.window_height, None);
        assert_eq!(settings.last_window_display_key, None);
        assert!(settings.window_bounds_by_display.is_empty());
        assert!(!settings.open_projector_in_grid_view);
        assert_eq!(settings.performance_mode, "balanced");
        assert!(settings.show_image_captions);
        assert_eq!(settings.slideshow_direction, "forward");
        assert!(settings.auto_refresh_folder);
        assert_eq!(settings.update_channel, "stable");
        assert_eq!(
            settings.saved_view_presets,
            vec!["favorites".to_string(), "rated4".to_string(), "unreviewed".to_string()]
        );
        assert!(settings.recent_folders.is_empty());
        assert_eq!(settings.external_editor_path, None);
        assert_eq!(settings.external_editor_label, None);
        assert!(settings.persisted_marked_folders.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn test_open_in_external_application_validates_executable_extensions() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        let txt_app = dir.path().join("script.txt");
        fs::write(&image, b"dummy-image").unwrap();
        fs::write(&txt_app, b"dummy-script").unwrap();

        let error = open_in_external_application_blocking(
            image.to_string_lossy().to_string(),
            txt_app.to_string_lossy().to_string(),
        )
        .unwrap_err();

        assert!(error.contains("does not have a recognized executable extension"));
    }

    #[test]
    fn test_metadata_xmp_resilience_crafted_payloads() {
        let dir = tempfile::tempdir().unwrap();

        // Create a base image with valid image data and EXIF payload
        let base_image_path = dir.path().join("base.png");
        image::RgbImage::from_pixel(10, 10, image::Rgb([255, 0, 0]))
            .save(&base_image_path)
            .unwrap();

        // 1. Start element with 500 unique attributes
        let mut many_attrs = String::from(
            "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description ",
        );
        for i in 0..500 {
            many_attrs.push_str(&format!("attr_{}=\"val_{}\" ", i, i));
        }
        many_attrs.push_str("/></rdf:RDF></x:xmpmeta>");

        let png_many_attrs = dir.path().join("many_attrs.png");
        fs::write(&png_many_attrs, create_dummy_png_with_itxt_xmp(many_attrs.as_bytes())).unwrap();
        let out_many_attrs = dir.path().join("out_many_attrs.png");
        let res = restore_normal_orientation(&png_many_attrs, &out_many_attrs, "test");
        assert!(res.is_ok());
        assert!(out_many_attrs.exists());

        // 2. Excessive namespace declarations
        let mut excessive_ns = String::from("<x:xmpmeta ");
        for i in 0..500 {
            excessive_ns.push_str(&format!("xmlns:ns{}=\"http://example.com/ns/{}\" ", i, i));
        }
        excessive_ns.push_str("><rdf:RDF></rdf:RDF></x:xmpmeta>");

        let png_ns = dir.path().join("excessive_ns.png");
        fs::write(&png_ns, create_dummy_png_with_itxt_xmp(excessive_ns.as_bytes())).unwrap();
        let out_ns = dir.path().join("out_ns.png");
        let res_ns = restore_normal_orientation(&png_ns, &out_ns, "test");
        assert!(res_ns.is_ok());
        assert!(out_ns.exists());

        // 3. Malformed/truncated XMP
        let truncated_xmp =
            b"<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF><rdf:Description attr=\"unclosed";
        let png_trunc = dir.path().join("truncated.png");
        fs::write(&png_trunc, create_dummy_png_with_itxt_xmp(truncated_xmp)).unwrap();
        let out_trunc = dir.path().join("out_trunc.png");
        let res_trunc = restore_normal_orientation(&png_trunc, &out_trunc, "test");
        assert!(res_trunc.is_ok());
        assert!(out_trunc.exists());

        // 4. Valid XMP packet with custom title - assert XMP is preserved in output
        let valid_xmp = b"<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description custom:Title=\"TestImage\"/></rdf:RDF></x:xmpmeta>";
        let png_valid = dir.path().join("valid.png");
        fs::write(&png_valid, create_dummy_png_with_itxt_xmp(valid_xmp)).unwrap();
        let out_valid = dir.path().join("out_valid.png");
        let res_valid = restore_normal_orientation(&png_valid, &out_valid, "test");
        assert!(res_valid.is_ok());
        assert!(out_valid.exists());
        let written_bytes = fs::read(&out_valid).unwrap();
        assert!(
            written_bytes.windows(b"TestImage".len()).any(|w| w == b"TestImage"),
            "XMP content 'TestImage' must be preserved in output image"
        );
    }

    #[test]
    fn test_get_preview_image_rejects_out_of_bounds_max_dimension() {
        let dir = tempfile::tempdir().unwrap();
        let image_path = dir.path().join("test.jpg");
        fs::write(&image_path, b"dummy").unwrap();

        // 1. Zero max_dimension
        let err_zero = get_preview_image_blocking(
            image_path.to_string_lossy().to_string(),
            0,
            None,
            dir.path().to_path_buf(),
        )
        .unwrap_err();
        assert!(err_zero.contains("greater than zero"));

        // 2. Excessive max_dimension (> 8192)
        let err_huge = get_preview_image_blocking(
            image_path.to_string_lossy().to_string(),
            65_535,
            None,
            dir.path().to_path_buf(),
        )
        .unwrap_err();
        assert!(err_huge.contains("exceeds limit"));
    }

    fn create_dummy_png_with_itxt_xmp(xmp_bytes: &[u8]) -> Vec<u8> {
        let mut png = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]; // PNG header

        // IHDR chunk
        let mut ihdr_data = Vec::new();
        ihdr_data.extend_from_slice(&1u32.to_be_bytes()); // width
        ihdr_data.extend_from_slice(&1u32.to_be_bytes()); // height
        ihdr_data.extend_from_slice(&[8, 2, 0, 0, 0]); // 8-bit truecolor
        append_png_chunk(&mut png, b"IHDR", &ihdr_data);

        // iTXt chunk with XML:com.adobe.xmp
        let mut itxt_data = Vec::new();
        itxt_data.extend_from_slice(b"XML:com.adobe.xmp\0\0\0\0\0");
        itxt_data.extend_from_slice(xmp_bytes);
        append_png_chunk(&mut png, b"iTXt", &itxt_data);

        // IEND chunk
        append_png_chunk(&mut png, b"IEND", &[]);
        png
    }

    fn append_png_chunk(out: &mut Vec<u8>, tag: &[u8; 4], data: &[u8]) {
        let len = data.len() as u32;
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(tag);
        out.extend_from_slice(data);

        let mut hasher = crc32fast::Hasher::new();
        hasher.update(tag);
        hasher.update(data);
        let checksum = hasher.finalize();
        out.extend_from_slice(&checksum.to_be_bytes());
    }
}
