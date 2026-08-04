pub mod curation_commands;
pub mod settings_commands;

pub use curation_commands::*;
pub use settings_commands::*;

use crate::atomic_file::build_unique_sibling_path;
#[cfg(test)]
use crate::atomic_file::replace_file_safely;
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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub struct StartupSessionState {
    consumed: AtomicBool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum StartupSessionSelection {
    Empty,
    Folder { session: crate::authority::FolderSessionSnapshot },
    Image { session: crate::authority::FileSessionSnapshot },
}

fn startup_target_from_args<I>(args: I) -> (Option<PathBuf>, Option<PathBuf>)
where
    I: IntoIterator<Item = String>,
{
    let mut file = None;
    let mut folder = None;
    let mut args = args.into_iter().skip(1).peekable();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--folder" | "-f" => folder = args.next().map(PathBuf::from),
            "--file" => file = args.next().map(PathBuf::from),
            value if !value.starts_with('-') && file.is_none() => {
                file = Some(PathBuf::from(value));
            }
            _ => {}
        }
    }
    (folder, file)
}

#[tauri::command]
pub fn consume_startup_session(
    app: AppHandle,
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    startup_state: tauri::State<'_, StartupSessionState>,
) -> Result<StartupSessionSelection, String> {
    enforce_main_window(&window)?;
    if startup_state.consumed.swap(true, Ordering::AcqRel) {
        return Ok(StartupSessionSelection::Empty);
    }

    let (folder, file) = startup_target_from_args(std::env::args());
    if let Some(folder) = folder {
        let session = session_manager.open_folder_session(&folder, Some(window.label()))?;
        settings_commands::record_trusted_recent_folder(
            &app,
            Path::new(&session.canonical_folder),
        )?;
        return Ok(StartupSessionSelection::Folder { session });
    }
    if let Some(file) = file {
        let session = session_manager.open_file_session(&file, Some(window.label()))?;
        settings_commands::record_trusted_recent_folder(
            &app,
            Path::new(&session.canonical_folder),
        )?;
        return Ok(StartupSessionSelection::Image { session });
    }
    Ok(StartupSessionSelection::Empty)
}

#[tauri::command]
pub fn open_recent_folder_session(
    app: AppHandle,
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    folder_path: String,
) -> Result<crate::authority::FolderSessionSnapshot, String> {
    enforce_main_window(&window)?;
    let requested = PathBuf::from(&folder_path);
    let canonical_requested =
        crate::authority::SessionManager::canonicalize_existing_file(&requested)?;
    let authorized = settings_commands::is_trusted_recent_folder(&app, &canonical_requested)?;
    if !authorized {
        return Err("Folder is not present in the backend-owned recent-folder list".to_string());
    }
    session_manager.open_folder_session(&canonical_requested, Some(window.label()))
}

/// Supported image extensions for the viewer
pub(crate) const SUPPORTED_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "tif", "heic", "heif", "avif", "svg",
    "dng", "cr2", "cr3", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "pef", "srw",
];

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct ImageFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
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

#[cfg(test)]
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

#[cfg(test)]
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

fn get_image_caption_from_authorized_sidecars(
    folder: &Path,
    sidecars: Vec<crate::authority::SidecarAuthorityLease>,
) -> Result<Option<ImageCaption>, String> {
    use std::io::Read;
    for sidecar in sidecars {
        let file_name = sidecar.file_name().to_string();
        let extension = Path::new(&file_name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let mut file = sidecar.into_file();
        let length = file
            .metadata()
            .map_err(|error| format!("Failed to inspect authorized caption: {error}"))?
            .len();
        if length > MAX_IMAGE_CAPTION_BYTES {
            return Err(format!("Image caption '{file_name}' is larger than the 1 MB limit"));
        }
        let mut bytes = Vec::with_capacity(length as usize);
        file.by_ref()
            .take(MAX_IMAGE_CAPTION_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Failed to read authorized caption: {error}"))?;
        if bytes.len() as u64 > MAX_IMAGE_CAPTION_BYTES {
            return Err(format!("Image caption '{file_name}' grew beyond the 1 MB limit"));
        }
        let text = decode_image_caption(&bytes).trim().to_string();
        if !text.is_empty() {
            return Ok(Some(ImageCaption {
                text,
                sidecar_path: folder.join(&file_name).to_string_lossy().to_string(),
                extension,
            }));
        }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    pub source_removed: bool,
    pub committed: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DestinationOperationError {
    pub message: String,
    pub destination_grant_consumed: bool,
}

impl DestinationOperationError {
    fn new(message: impl Into<String>, destination_grant_consumed: bool) -> Self {
        Self { message: message.into(), destination_grant_consumed }
    }
}

fn destination_operation_error(
    message: impl Into<String>,
    grant_consumed: &AtomicBool,
) -> DestinationOperationError {
    const CONSUMED: &str = "DESTINATION_GRANT_CONSUMED:";
    const NOT_CONSUMED: &str = "DESTINATION_GRANT_NOT_CONSUMED:";
    let message = message.into();
    if let Some(message) = message.strip_prefix(CONSUMED) {
        return DestinationOperationError::new(message.trim(), true);
    }
    if let Some(message) = message.strip_prefix(NOT_CONSUMED) {
        return DestinationOperationError::new(message.trim(), false);
    }
    DestinationOperationError::new(message, grant_consumed.load(Ordering::SeqCst))
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImageTransferFailure {
    pub source_path: String,
    pub error: String,
    pub committed: bool,
    pub source_removed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

impl ImageTransferFailure {
    fn not_committed(source_path: String, error: String) -> Self {
        Self { source_path, error, committed: false, source_removed: false, warning: None }
    }
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

    Some(ImageFile {
        id: None,
        session_id: None,
        path,
        file_name,
        extension,
        size_bytes,
        modified_at,
        created_at,
    })
}

fn filesystem_timestamp_token(timestamp: SystemTime) -> String {
    timestamp.duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos().to_string()
}

/// Check if a path is a directory
#[allow(dead_code)]
pub fn is_dir(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[allow(dead_code)]
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
#[allow(dead_code)]
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
#[allow(dead_code)]
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

#[allow(dead_code)]
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
#[allow(dead_code)]
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
pub async fn get_codec_health(
    window: tauri::Window,
    app: AppHandle,
) -> Result<CodecHealthReport, String> {
    enforce_main_window(&window)?;
    let app_cache_dir =
        app.path().app_cache_dir().map_err(|e| format!("Failed to get app cache dir: {}", e))?;
    tauri::async_runtime::spawn_blocking(move || codec_health_report_blocking(app_cache_dir))
        .await
        .map_err(|err| format!("Codec health worker failed: {}", err))
}

#[tauri::command]
pub async fn clear_generated_image_cache(
    window: tauri::Window,
    app: AppHandle,
    scope: GeneratedCacheCommandScope,
) -> Result<thumbnails::GeneratedCacheSummary, String> {
    enforce_main_window(&window)?;
    let app_cache_dir =
        app.path().app_cache_dir().map_err(|e| format!("Failed to get app cache dir: {}", e))?;
    tauri::async_runtime::spawn_blocking(move || {
        thumbnails::clear_generated_cache(&app_cache_dir, scope.into())
    })
    .await
    .map_err(|err| format!("Generated cache cleanup worker failed: {}", err))?
}

#[tauri::command]
pub async fn retry_native_codecs(window: tauri::Window) -> Result<usize, String> {
    enforce_main_window(&window)?;
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

fn write_dynamic_image_to_file(
    image: &image::DynamicImage,
    output_file: &mut fs::File,
    output_path: &Path,
    error_prefix: &str,
) -> Result<(), String> {
    let extension = output_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_default();

    let format = image::ImageFormat::from_extension(&extension).unwrap_or(image::ImageFormat::Png);

    let write_result = if matches!(extension.as_str(), "jpg" | "jpeg") {
        let rgb = image::DynamicImage::ImageRgb8(image.to_rgb8());
        rgb.write_to(output_file, format)
    } else {
        image.write_to(output_file, format)
    };

    write_result.map_err(|e| format!("{}: {}", error_prefix, e))
}

fn write_high_quality_image_to_file(
    image: &image::DynamicImage,
    output_file: &mut fs::File,
    output_path: &Path,
    error_prefix: &str,
) -> Result<(), String> {
    let extension = output_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_default();

    if !matches!(extension.as_str(), "jpg" | "jpeg") {
        return write_dynamic_image_to_file(image, output_file, output_path, error_prefix);
    }

    let rgb_image = image::DynamicImage::ImageRgb8(image.to_rgb8());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(output_file, 95);
    encoder.encode_image(&rgb_image).map_err(|e| format!("{}: {}", error_prefix, e))
}

#[allow(dead_code)]
fn write_high_quality_image(
    image: &image::DynamicImage,
    output_path: &Path,
    error_prefix: &str,
) -> Result<(), String> {
    let mut output_file =
        fs::File::create(output_path).map_err(|e| format!("{}: {}", error_prefix, e))?;
    write_high_quality_image_to_file(image, &mut output_file, output_path, error_prefix)
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

    if source_path != output_path && !output_path.exists() {
        fs::copy(source_path, output_path)
            .map_err(|e| format!("Failed to copy output file after {}: {}", context, e))?;
    }

    if let Ok(mut metadata) = Metadata::new_from_path(output_path) {
        metadata.set_tag(ExifTag::Orientation(vec![1]));
        let _ = metadata.write_to_file(output_path);
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

/// Test-only raw-path caption helper. Production IPC resolves sidecars from a session directory
/// handle in `get_image_caption_by_id` below.
#[cfg(test)]
#[allow(dead_code)]
async fn get_image_caption(file_path: String) -> Result<Option<ImageCaption>, String> {
    tauri::async_runtime::spawn_blocking(move || get_image_caption_blocking(file_path))
        .await
        .map_err(|err| format!("Image caption worker failed: {}", err))?
}

fn get_preview_image_blocking(
    file_path: String,
    cache_identity_path: String,
    metadata: thumbnails::SourceMetadata,
    max_dimension: u32,
    invalidation_bust: Option<u64>,
    app_cache_dir: PathBuf,
    cancel_tok: Option<&crate::media_executor::CancellationToken>,
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

    let preview_cache_dir = app_cache_dir.join("previews");
    thumbnails::get_or_create_preview_with_cancellation(
        path,
        Path::new(&cache_identity_path),
        &metadata,
        &preview_cache_dir,
        max_dimension,
        invalidation_bust,
        cancel_tok,
    )
}

fn source_metadata_from_lease(
    lease: &crate::authority::ImageAuthorityLease,
) -> Result<thumbnails::SourceMetadata, String> {
    let metadata = lease
        .try_clone_file()?
        .metadata()
        .map_err(|error| format!("Failed to inspect authorized image handle: {error}"))?;
    let modified_epoch_nanos = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    Ok(thumbnails::SourceMetadata { size_bytes: metadata.len(), modified_epoch_nanos })
}

#[tauri::command]
pub async fn select_folder_session(
    app: AppHandle,
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
) -> Result<Option<crate::authority::FolderSessionSnapshot>, String> {
    enforce_main_window(&window)?;
    let dialog_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_app.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|error| format!("Native folder selection failed: {error}"))?;
    let Some(selected) = selected else { return Ok(None) };
    let path = selected.into_path().map_err(|error| format!("Invalid selected folder: {error}"))?;
    let session = session_manager.open_folder_session(&path, Some(window.label()))?;
    settings_commands::record_trusted_recent_folder(&app, Path::new(&session.canonical_folder))?;
    Ok(Some(session))
}

#[tauri::command]
pub async fn select_file_session(
    app: AppHandle,
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
) -> Result<Option<crate::authority::FileSessionSnapshot>, String> {
    enforce_main_window(&window)?;
    let dialog_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_app.dialog().file().add_filter("Images", SUPPORTED_EXTENSIONS).blocking_pick_file()
    })
    .await
    .map_err(|error| format!("Native file selection failed: {error}"))?;
    let Some(selected) = selected else { return Ok(None) };
    let path = selected.into_path().map_err(|error| format!("Invalid selected file: {error}"))?;
    let session = session_manager.open_file_session(&path, Some(window.label()))?;
    settings_commands::record_trusted_recent_folder(&app, Path::new(&session.canonical_folder))?;
    Ok(Some(session))
}

pub fn enforce_main_window_label(label: &str) -> Result<(), String> {
    if label != "main" {
        return Err(format!(
            "Window '{}' is not authorized to execute privileged or destructive commands",
            label
        ));
    }
    Ok(())
}

pub fn enforce_secondary_window_label(label: &str) -> Result<(), String> {
    if label == "secondary" {
        Ok(())
    } else {
        Err(format!("Command is restricted to the secondary window (got '{label}')"))
    }
}

pub fn enforce_projector_participant_label(label: &str) -> Result<(), String> {
    if matches!(label, "main" | "secondary") {
        Ok(())
    } else {
        Err(format!("Command is restricted to projector participant windows (got '{label}')"))
    }
}

pub fn enforce_main_window<R: tauri::Runtime>(window: &tauri::Window<R>) -> Result<(), String> {
    enforce_main_window_label(window.label())
}

pub fn create_secured_staging_file(path: &Path) -> Result<fs::File, String> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT (0x02000000) prevents following reparse points / symlinks
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .access_mode(0x8000_0000 | 0x4000_0000 | 0x0001_0000)
            // The unguessable create-new path prevents pre-creation. Delete sharing lets the
            // publisher rename the object while the producer handle remains open and available
            // for an exact-identity check.
            .share_mode(0x0000_0001 | 0x0000_0002 | 0x0000_0004)
            .custom_flags(0x02000000)
            .open(path)
            .map_err(|e| format!("Failed to create secured staging file: {}", e))
    }
    #[cfg(not(windows))]
    {
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|e| format!("Failed to create secured staging file: {}", e))
    }
}

fn prepare_staging_for_publication(file: &mut fs::File) -> Result<(), String> {
    prepare_staging_for_publication_with_failure(file, None)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StagingPreparationFailure {
    Sync,
    Seek,
    Read,
}

fn prepare_staging_for_publication_with_failure(
    file: &mut fs::File,
    failure: Option<StagingPreparationFailure>,
) -> Result<(), String> {
    use std::io::{Read, Seek, Write};
    file.flush().map_err(|error| format!("Failed to flush prepared image: {error}"))?;
    if failure == Some(StagingPreparationFailure::Sync) {
        return Err("Injected prepared-image sync failure".into());
    }
    file.sync_all().map_err(|error| format!("Failed to sync prepared image: {error}"))?;
    if failure == Some(StagingPreparationFailure::Seek) {
        return Err("Injected prepared-image seek failure".into());
    }
    file.seek(std::io::SeekFrom::Start(0))
        .map_err(|error| format!("Failed to rewind prepared image: {error}"))?;
    if failure == Some(StagingPreparationFailure::Read) {
        return Err("Injected prepared-image read failure".into());
    }
    let mut probe = [0_u8; 1];
    if file
        .read(&mut probe)
        .map_err(|error| format!("Failed to validate readable prepared image: {error}"))?
        == 0
    {
        return Err("Prepared image is empty".into());
    }
    file.seek(std::io::SeekFrom::Start(0))
        .map_err(|error| format!("Failed to rewind validated prepared image: {error}"))?;
    Ok(())
}

fn create_destination_staging_file(
    lease: &crate::authority::DestinationAuthorityLease,
    temp_name: &str,
    temp_path: &Path,
) -> Result<fs::File, String> {
    #[cfg(target_os = "linux")]
    let _ = temp_path;
    #[cfg(target_os = "linux")]
    {
        use std::ffi::CString;
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::ffi::OsStrExt;
        let directory = lease.try_clone_directory()?;
        let name = CString::new(std::ffi::OsStr::new(temp_name).as_bytes())
            .map_err(|_| "Staging file name contains a NUL byte".to_string())?;
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(format!(
                "Failed to create named handle-relative staging file: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(unsafe { fs::File::from_raw_fd(fd) })
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        let _ = (lease, temp_name, temp_path);
        Err("Identity-bound destination publication is not supported on this Unix platform".into())
    }
    #[cfg(windows)]
    {
        let _ = (lease, temp_name);
        create_secured_staging_file(temp_path)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DestinationPublicationMode {
    Replace,
    NoReplace,
}

struct DestinationPublicationTransaction<R>
where
    R: FnMut(String) -> Result<(), String>,
{
    rollback: R,
    armed: bool,
}

impl<R> DestinationPublicationTransaction<R>
where
    R: FnMut(String) -> Result<(), String>,
{
    fn new(rollback: R) -> Self {
        Self { rollback, armed: false }
    }

    fn fail(&mut self, reason: String) -> Result<(), String> {
        match (self.rollback)(reason.clone()) {
            Ok(()) => {
                self.armed = false;
                Err(format!("{reason}; prior destination state restored and synchronized"))
            }
            Err(rollback_error) => Err(format!("{reason}; rollback incomplete: {rollback_error}")),
        }
    }

    fn mutate<T>(
        &mut self,
        context: &str,
        mutation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.armed = true;
        match mutation() {
            Ok(value) => Ok(value),
            Err(error) => {
                self.fail(format!("{context}: {error}"))?;
                unreachable!("transaction.fail always returns an error")
            }
        }
    }

    fn commit(&mut self) {
        self.armed = false;
    }
}

impl<R> Drop for DestinationPublicationTransaction<R>
where
    R: FnMut(String) -> Result<(), String>,
{
    fn drop(&mut self) {
        if self.armed {
            if let Err(error) =
                (self.rollback)("Destination publication unwound before commit".into())
            {
                eprintln!("Destination publication unwind recovery failed: {error}");
            }
        }
    }
}

fn publish_destination_staging_file(
    lease: &crate::authority::DestinationAuthorityLease,
    staging_file: &fs::File,
    temp_name: &str,
    target_name: &std::ffi::OsStr,
    temp_path: &Path,
    target_path: &Path,
    mode: DestinationPublicationMode,
) -> Result<(), String> {
    lease.revalidate()?;
    #[cfg(target_os = "linux")]
    let _ = (temp_path, target_path);
    #[cfg(target_os = "linux")]
    {
        use std::ffi::CString;
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::MetadataExt;

        let directory = lease.try_clone_directory()?;
        let from = CString::new(temp_name.as_bytes())
            .map_err(|_| "Staging file name contains a NUL byte".to_string())?;
        let to = CString::new(target_name.as_bytes())
            .map_err(|_| "Destination file name contains a NUL byte".to_string())?;
        let verify_named_identity = |name: &CString| -> Result<(), String> {
            let fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(format!(
                    "Failed to reopen named staging through pinned directory: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let named = unsafe { fs::File::from_raw_fd(fd) };
            let expected = staging_file
                .metadata()
                .map_err(|error| format!("Failed to inspect staging handle: {error}"))?;
            let actual = named
                .metadata()
                .map_err(|error| format!("Failed to inspect named staging: {error}"))?;
            if expected.dev() != actual.dev() || expected.ino() != actual.ino() {
                return Err("Named staging identity changed before publication".into());
            }
            Ok(())
        };
        verify_named_identity(&from)?;
        let rename_noreplace = |source: &CString, destination: &CString| -> std::io::Result<()> {
            let result = unsafe {
                libc::syscall(
                    libc::SYS_renameat2,
                    directory.as_raw_fd(),
                    source.as_ptr(),
                    directory.as_raw_fd(),
                    destination.as_ptr(),
                    libc::RENAME_NOREPLACE,
                )
            };
            if result == 0 {
                return Ok(());
            }
            let error = std::io::Error::last_os_error();
            if !matches!(
                error.raw_os_error(),
                Some(libc::ENOSYS) | Some(libc::EINVAL) | Some(libc::EOPNOTSUPP)
            ) {
                return Err(error);
            }
            let linked = unsafe {
                libc::linkat(
                    directory.as_raw_fd(),
                    source.as_ptr(),
                    directory.as_raw_fd(),
                    destination.as_ptr(),
                    0,
                )
            };
            if linked != 0 {
                return Err(std::io::Error::last_os_error());
            }
            let unlinked = unsafe { libc::unlinkat(directory.as_raw_fd(), source.as_ptr(), 0) };
            if unlinked == 0 {
                Ok(())
            } else {
                let unlink_error = std::io::Error::last_os_error();
                // linkat already published the exact staging inode. If removing the old name
                // fails, undo that partial publication before reporting failure.
                let cleanup =
                    unsafe { libc::unlinkat(directory.as_raw_fd(), destination.as_ptr(), 0) };
                if cleanup == 0 {
                    Err(unlink_error)
                } else {
                    Err(std::io::Error::other(format!(
                        "staging unlink failed ({unlink_error}) and partial publication cleanup failed ({})",
                        std::io::Error::last_os_error()
                    )))
                }
            }
        };
        let backup =
            CString::new(format!(".lightframe-destination-recovery-{}", uuid::Uuid::new_v4()))
                .expect("generated destination recovery name contains NUL");
        let open_named = |name: &CString| -> std::io::Result<fs::File> {
            let fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(unsafe { fs::File::from_raw_fd(fd) })
            }
        };
        let find_name_for_identity = |identity: &fs::File| -> Result<CString, String> {
            let expected = identity.metadata().map_err(|error| error.to_string())?;
            let entries = fs::read_dir(format!("/proc/self/fd/{}", directory.as_raw_fd()))
                .map_err(|error| format!("Failed to scan pinned destination directory: {error}"))?;
            for entry in entries.flatten() {
                let name = CString::new(entry.file_name().as_bytes())
                    .map_err(|_| "Destination recovery name contains NUL".to_string())?;
                let Ok(candidate) = open_named(&name) else { continue };
                let actual = candidate.metadata().map_err(|error| error.to_string())?;
                if expected.dev() == actual.dev() && expected.ino() == actual.ino() {
                    return Ok(name);
                }
            }
            Err("Pinned prior destination has no recoverable directory entry".into())
        };
        let prior_handle = if mode == DestinationPublicationMode::Replace {
            match open_named(&to) {
                Ok(handle) => Some(handle),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(format!("Failed to pin existing destination: {error}")),
            }
        } else {
            None
        };
        let has_backup = std::cell::Cell::new(false);
        let rollback = |reason: String| -> Result<(), String> {
            let mut rejected_cleanup: Option<CString> = None;
            let current = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    to.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if current >= 0 {
                let current = unsafe { fs::File::from_raw_fd(current) };
                let expected = staging_file.metadata().map_err(|error| error.to_string())?;
                let actual = current.metadata().map_err(|error| error.to_string())?;
                if expected.dev() == actual.dev() && expected.ino() == actual.ino() {
                    let removed = unsafe { libc::unlinkat(directory.as_raw_fd(), to.as_ptr(), 0) };
                    if removed != 0 {
                        return Err(format!(
                            "{reason}; exact published destination could not be removed: {}",
                            std::io::Error::last_os_error()
                        ));
                    }
                } else if has_backup.get() {
                    let rejected = CString::new(format!(
                        ".lightframe-rejected-destination-{}",
                        uuid::Uuid::new_v4()
                    ))
                    .unwrap();
                    rename_noreplace(&to, &rejected).map_err(|error| {
                        format!("{reason}; changed destination could not be quarantined: {error}")
                    })?;
                    rejected_cleanup = Some(rejected);
                } else {
                    return Err(format!(
                        "{reason}; destination is occupied by a different filesystem object"
                    ));
                }
            }
            if has_backup.get() {
                let prior = prior_handle
                    .as_ref()
                    .ok_or_else(|| format!("{reason}; pinned prior destination is missing"))?;
                let exact_name = find_name_for_identity(prior)?;
                rename_noreplace(&exact_name, &to).map_err(|error| {
                    format!("{reason}; exact prior destination restore failed: {error}")
                })?;
                let restored = open_named(&to).map_err(|error| {
                    format!("{reason}; restored destination could not be reopened: {error}")
                })?;
                let expected = prior.metadata().map_err(|error| error.to_string())?;
                let actual = restored.metadata().map_err(|error| error.to_string())?;
                if expected.dev() != actual.dev() || expected.ino() != actual.ino() {
                    return Err(format!(
                        "{reason}; canonical destination is not the pinned prior object"
                    ));
                }
            }
            if let Some(rejected) = rejected_cleanup {
                let removed =
                    unsafe { libc::unlinkat(directory.as_raw_fd(), rejected.as_ptr(), 0) };
                if removed != 0 {
                    return Err(format!(
                        "{reason}; exact prior restored but rejected artifact '{}' was retained: {}",
                        rejected.to_string_lossy(),
                        std::io::Error::last_os_error()
                    ));
                }
            }
            directory.sync_all().map_err(|error| {
                format!("{reason}; destination state restored but sync failed: {error}")
            })?;
            Ok(())
        };
        let mut transaction = DestinationPublicationTransaction::new(rollback);

        if let Some(prior) = prior_handle.as_ref() {
            has_backup.set(true);
            transaction.mutate("Failed to quarantine existing destination", || {
                rename_noreplace(&to, &backup).map_err(|error| error.to_string())?;
                let backup_named = open_named(&backup).map_err(|error| {
                    format!("Failed to reopen quarantined destination: {error}")
                })?;
                let expected = prior.metadata().map_err(|error| error.to_string())?;
                let actual = backup_named.metadata().map_err(|error| error.to_string())?;
                if expected.dev() != actual.dev() || expected.ino() != actual.ino() {
                    return Err("Quarantined destination identity changed".into());
                }
                directory
                    .sync_all()
                    .map_err(|error| format!("Failed to sync quarantined destination: {error}"))
            })?;
        }

        transaction.mutate("Failed to publish named handle-relative staged file", || {
            rename_noreplace(&from, &to).map_err(|error| error.to_string())
        })?;
        if let Err(error) = verify_named_identity(&to) {
            return transaction.fail(format!(
                "Published destination identity does not match prepared staging: {error}"
            ));
        }
        if let Err(error) = directory.sync_all() {
            return transaction.fail(format!("Failed to sync destination directory: {error}"));
        }
        if let Err(error) = lease.revalidate() {
            return transaction
                .fail(format!("Destination authority changed before commit: {error}"));
        }
        if has_backup.get() {
            let removed = unsafe { libc::unlinkat(directory.as_raw_fd(), backup.as_ptr(), 0) };
            if removed != 0 {
                return transaction.fail(format!(
                    "Failed to remove destination recovery before commit: {}",
                    std::io::Error::last_os_error()
                ));
            }
            transaction.commit();
            // Recovery unlink is the commit point; never report failure after exact rollback is
            // impossible. Publication itself was durably synced above.
            if let Err(error) = directory.sync_all() {
                eprintln!("Destination committed; recovery-unlink sync failed: {error}");
            }
        } else {
            transaction.commit();
        }
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        let _ = (lease, staging_file, temp_name, target_name, temp_path, target_path, mode);
        Err("Identity-bound destination publication is not supported on this Unix platform".into())
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::{
            FileDispositionInfoEx, FileRenameInfo, GetFileInformationByHandle,
            SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_DISPOSITION_FLAG_DELETE,
            FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO_EX,
            FILE_DISPOSITION_INFO_EX_FLAGS, FILE_RENAME_INFO,
        };
        let _ = (lease, temp_name, target_name, temp_path);
        let rename_handle = |file: &fs::File, destination: &Path| -> Result<(), String> {
            let target_display = destination.to_string_lossy();
            let target_nt = if let Some(path) = target_display.strip_prefix(r"\\?\UNC\") {
                format!(r"\??\UNC\{path}")
            } else if let Some(path) = target_display.strip_prefix(r"\\?\") {
                format!(r"\??\{path}")
            } else if let Some(path) = target_display.strip_prefix(r"\\") {
                format!(r"\??\UNC\{path}")
            } else {
                format!(r"\??\{target_display}")
            };
            let target: Vec<u16> = std::ffi::OsStr::new(&target_nt).encode_wide().collect();
            let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
            let mut buffer = vec![0_u8; offset + (target.len() + 1) * std::mem::size_of::<u16>()];
            let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
            unsafe {
                (*info).Anonymous.ReplaceIfExists = false;
                (*info).RootDirectory = HANDLE(std::ptr::null_mut());
                (*info).FileNameLength = (target.len() * std::mem::size_of::<u16>()) as u32;
                std::ptr::copy_nonoverlapping(
                    target.as_ptr(),
                    (*info).FileName.as_mut_ptr(),
                    target.len(),
                );
                SetFileInformationByHandle(
                    HANDLE(file.as_raw_handle()),
                    FileRenameInfo,
                    buffer.as_ptr().cast(),
                    buffer.len() as u32,
                )
            }
            .map_err(|error| {
                format!("Handle rename to '{}' failed: {error}", destination.display())
            })
        };
        let mark_delete = |file: &fs::File| -> Result<(), String> {
            let disposition = FILE_DISPOSITION_INFO_EX {
                Flags: FILE_DISPOSITION_INFO_EX_FLAGS(
                    FILE_DISPOSITION_FLAG_DELETE.0 | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS.0,
                ),
            };
            unsafe {
                SetFileInformationByHandle(
                    HANDLE(file.as_raw_handle()),
                    FileDispositionInfoEx,
                    (&disposition as *const FILE_DISPOSITION_INFO_EX).cast(),
                    std::mem::size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
                )
            }
            .map_err(|error| format!("Failed to delete destination transaction handle: {error}"))
        };
        let file_identity = |file: &fs::File| -> Result<(u32, u64), String> {
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
                .map_err(|error| format!("Failed to inspect destination identity: {error}"))?;
            Ok((
                info.dwVolumeSerialNumber,
                ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
            ))
        };

        let backup_path = target_path
            .with_file_name(format!(".lightframe-destination-recovery-{}", uuid::Uuid::new_v4()));
        let prior_handle = if mode == DestinationPublicationMode::Replace
            && fs::symlink_metadata(target_path).is_ok()
        {
            let existing = fs::OpenOptions::new()
                .read(true)
                .access_mode(0x8000_0000 | 0x0001_0000)
                .share_mode(0x0000_0001 | 0x0000_0002 | 0x0000_0004)
                .custom_flags(0x0020_0000)
                .open(target_path)
                .map_err(|error| format!("Failed to pin existing destination: {error}"))?;
            if existing
                .metadata()
                .map_err(|error| format!("Failed to inspect existing destination: {error}"))?
                .file_type()
                .is_symlink()
            {
                return Err("Existing destination became a link before publication".into());
            }
            Some(existing)
        } else {
            None
        };
        let prior_identity = prior_handle.as_ref().map(&file_identity).transpose()?;
        let staging_identity = file_identity(staging_file)?;
        let abandoned_path = target_path
            .with_file_name(format!(".lightframe-aborted-destination-{}", uuid::Uuid::new_v4()));
        let open_target = || {
            fs::OpenOptions::new()
                .read(true)
                .access_mode(0x8000_0000 | 0x0001_0000)
                .share_mode(0x0000_0001 | 0x0000_0002 | 0x0000_0004)
                .custom_flags(0x0020_0000)
                .open(target_path)
                .map_err(|error| error.to_string())
        };
        let rollback_published = |reason: String| -> Result<(), String> {
            let current = open_target().ok();
            if let (Some(expected), Some(current)) = (prior_identity, current.as_ref()) {
                if file_identity(current)? == expected {
                    return Ok(());
                }
            }
            if prior_identity.is_none()
                && current
                    .as_ref()
                    .is_some_and(|current| file_identity(current).ok() != Some(staging_identity))
            {
                return Err(
                    "destination is occupied by a different filesystem object; it was preserved"
                        .into(),
                );
            }

            let displaced = if let Some(current) = current {
                rename_handle(&current, &abandoned_path)?;
                Some(current)
            } else {
                None
            };
            if let Some(prior) = prior_handle.as_ref() {
                rename_handle(prior, target_path)?;
                let restored = open_target().map_err(|error| {
                    format!("restored destination could not be reopened: {error}")
                })?;
                if file_identity(&restored)? != file_identity(prior)? {
                    return Err("canonical destination is not the pinned prior object".into());
                }
            }
            if let Some(displaced) = displaced {
                mark_delete(&displaced).map_err(|error| {
                    format!(
                        "{reason}; exact prior restored but rejected artifact '{}' was retained: {error}",
                        abandoned_path.display()
                    )
                })?;
            }
            Ok(())
        };
        let mut transaction = DestinationPublicationTransaction::new(rollback_published);

        if let Some(prior) = prior_handle.as_ref() {
            transaction.mutate("Failed to quarantine existing destination", || {
                rename_handle(prior, &backup_path)?;
                let named = fs::OpenOptions::new()
                    .read(true)
                    .share_mode(0x0000_0001 | 0x0000_0002 | 0x0000_0004)
                    .custom_flags(0x0020_0000)
                    .open(&backup_path)
                    .map_err(|error| error.to_string())?;
                if file_identity(&named)? != file_identity(prior)? {
                    return Err("quarantined destination identity mismatch".into());
                }
                Ok(())
            })?;
        }

        transaction.mutate("Failed to publish staged file handle", || {
            rename_handle(staging_file, target_path)
        })?;

        let published = fs::OpenOptions::new()
            .read(true)
            .share_mode(0x0000_0001 | 0x0000_0002 | 0x0000_0004)
            .custom_flags(0x0020_0000)
            .open(target_path);
        let publication_error = match published {
            Ok(handle) => match (file_identity(&handle), file_identity(staging_file)) {
                (Ok(actual), Ok(expected)) if actual == expected => None,
                (Ok(_), Ok(_)) => Some("Published destination identity changed".to_string()),
                (actual, expected) => Some(format!(
                    "Published destination identity query failed: actual={actual:?}; expected={expected:?}"
                )),
            },
            Err(error) => Some(format!("Failed to reopen published destination: {error}")),
        };
        if let Some(reason) = publication_error {
            return transaction.fail(reason);
        }
        if let Err(error) = lease.revalidate() {
            return transaction
                .fail(format!("Destination authority changed before commit: {error}"));
        }
        if let Some(backup) = prior_handle.as_ref() {
            // The exact prior destination remains recoverable until the new handle identity is
            // verified. Deleting this pinned backup is the explicit commit point on Windows.
            if let Err(reason) = mark_delete(backup) {
                return transaction.fail(reason);
            }
        }
        transaction.commit();
        Ok(())
    }
}

fn remove_destination_staging_file(
    lease: &crate::authority::DestinationAuthorityLease,
    temp_name: &str,
    temp_path: &Path,
) {
    #[cfg(unix)]
    let _ = temp_path;
    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::fd::AsRawFd;
        use std::os::unix::ffi::OsStrExt;
        if let (Ok(directory), Ok(name)) =
            (lease.try_clone_directory(), CString::new(std::ffi::OsStr::new(temp_name).as_bytes()))
        {
            unsafe {
                libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0);
            }
        }
    }
    #[cfg(windows)]
    {
        let _ = (lease, temp_name);
        let _ = fs::remove_file(temp_path);
    }
}

struct DestinationStagingCleanup<'a> {
    lease: &'a crate::authority::DestinationAuthorityLease,
    temp_name: String,
    temp_path: PathBuf,
    armed: bool,
}

impl DestinationStagingCleanup<'_> {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for DestinationStagingCleanup<'_> {
    fn drop(&mut self) {
        if self.armed {
            remove_destination_staging_file(self.lease, &self.temp_name, &self.temp_path);
        }
    }
}

pub fn stage_and_publish_destination_file<F>(
    session_manager: &crate::authority::SessionManager,
    destination_grant_id: &str,
    relative_file_name: &str,
    operation: &str,
    window_label: Option<&str>,
    write_fn: F,
) -> Result<PathBuf, String>
where
    F: FnOnce(&mut fs::File, &Path) -> Result<(), String>,
{
    stage_and_publish_destination_file_with_cancellation(
        session_manager,
        destination_grant_id,
        relative_file_name,
        operation,
        window_label,
        None,
        None,
        write_fn,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn stage_and_publish_destination_file_with_cancellation<F>(
    session_manager: &crate::authority::SessionManager,
    destination_grant_id: &str,
    relative_file_name: &str,
    operation: &str,
    window_label: Option<&str>,
    cancel_tok: Option<&crate::media_executor::CancellationToken>,
    grant_consumed: Option<&AtomicBool>,
    write_fn: F,
) -> Result<PathBuf, String>
where
    F: FnOnce(&mut fs::File, &Path) -> Result<(), String>,
{
    let ensure_active = || {
        if cancel_tok.is_some_and(|token| token.is_canceled()) {
            Err("Operation canceled before destination publication".to_string())
        } else {
            Ok(())
        }
    };
    ensure_active().map_err(|error| format!("DESTINATION_GRANT_NOT_CONSUMED: {error}"))?;
    let destination_lease = session_manager
        .consume_exact_destination_grant(
            destination_grant_id,
            relative_file_name,
            operation,
            window_label,
        )
        .map_err(|error| error.tagged_message())?;
    if let Some(consumed) = grant_consumed {
        consumed.store(true, Ordering::SeqCst);
    }
    let consumed_result = (|| -> Result<PathBuf, String> {
        let dest_folder = destination_lease.path().to_path_buf();
        // The lease verifies and pins the original directory identity. Do not
        // canonicalize this path again: doing so would redefine authority if the path were replaced.
        let dest_canonical = dest_folder.clone();

        let name_trimmed = relative_file_name.trim();
        if name_trimmed.is_empty() {
            return Err("Output relative_file_name must not be empty".to_string());
        }
        let name_path = Path::new(name_trimmed);
        if name_path.is_absolute()
            || name_trimmed.contains('/')
            || name_trimmed.contains('\\')
            || name_trimmed.contains("..")
        {
            return Err(
            "Output relative_file_name must be a simple file name without path separators or '..'"
                .to_string(),
        );
        }
        let target_path = dest_folder.join(name_path);

        if let Ok(symlink_meta) = fs::symlink_metadata(&target_path) {
            if symlink_meta.file_type().is_symlink() {
                return Err("Target file path is an existing symlink or junction point".to_string());
            }
            if let Ok(canonical_target) = fs::canonicalize(&target_path) {
                if !crate::authority::is_path_contained_in_with_semantics(
                    &canonical_target,
                    &dest_canonical,
                    destination_lease.path_case_semantics(),
                ) {
                    return Err("Target file path resolves outside granted destination boundary"
                        .to_string());
                }
            }
        }

        let ext = name_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| format!(".{}", e))
            .unwrap_or_default();

        let temp_name = format!(".staging_{}_{}{}", std::process::id(), uuid::Uuid::new_v4(), ext);
        let temp_path = dest_folder.join(&temp_name);

        let mut staging_file =
            create_destination_staging_file(&destination_lease, &temp_name, &temp_path)?;
        let mut staging_cleanup = DestinationStagingCleanup {
            lease: &destination_lease,
            temp_name: temp_name.clone(),
            temp_path: temp_path.clone(),
            armed: true,
        };

        if let Err(err) = write_fn(&mut staging_file, &temp_path) {
            drop(staging_file);
            return Err(err);
        }

        if let Err(err) = ensure_active() {
            drop(staging_file);
            return Err(err);
        }

        if let Err(err) = staging_file.sync_all() {
            drop(staging_file);
            return Err(format!("Failed to flush staging file to disk: {}", err));
        }

        let staging_meta = match staging_file.metadata() {
            Ok(meta) => meta,
            Err(err) => {
                drop(staging_file);
                return Err(format!("Failed to query staging file handle metadata: {}", err));
            }
        };
        #[cfg(not(windows))]
        let _ = &staging_meta;

        let publish_res = (|| -> Result<(), String> {
            ensure_active()?;
            destination_lease.revalidate()?;
            #[cfg(windows)]
            {
                let temp_symlink_meta = fs::symlink_metadata(&temp_path)
                    .map_err(|e| format!("Staging temp file metadata check failed: {}", e))?;
                if temp_symlink_meta.file_type().is_symlink() {
                    return Err("Staging temp file is a symlink or junction point".to_string());
                }
                if temp_symlink_meta.len() != staging_meta.len() {
                    return Err(
                        "Staging temp file size mismatch; path was modified or swapped".to_string()
                    );
                }
                use std::os::windows::fs::MetadataExt;
                if temp_symlink_meta.file_attributes() != staging_meta.file_attributes()
                    || temp_symlink_meta.creation_time() != staging_meta.creation_time()
                    || temp_symlink_meta.last_write_time() != staging_meta.last_write_time()
                {
                    return Err(
                        "Staging temp file identity mismatch; file handle attributes differ"
                            .to_string(),
                    );
                }
            }

            #[cfg(windows)]
            {
                let canonical_temp = fs::canonicalize(&temp_path)
                    .map_err(|e| format!("Failed to canonicalize staging temp file: {}", e))?;
                if !crate::authority::is_path_contained_in_with_semantics(
                    &canonical_temp,
                    &dest_canonical,
                    destination_lease.path_case_semantics(),
                ) {
                    return Err(
                        "Staging temp file escapes granted destination folder boundary".to_string()
                    );
                }
            }

            if let Ok(symlink_meta) = fs::symlink_metadata(&target_path) {
                if symlink_meta.file_type().is_symlink() {
                    return Err("Target file path is a symlink or junction point".to_string());
                }
                if let Ok(canonical_target) = fs::canonicalize(&target_path) {
                    if !crate::authority::is_path_contained_in_with_semantics(
                        &canonical_target,
                        &dest_canonical,
                        destination_lease.path_case_semantics(),
                    ) {
                        return Err(
                            "Target file path resolves outside granted destination boundary"
                                .to_string(),
                        );
                    }
                }
            }

            ensure_active()?;
            destination_lease.revalidate()?;
            if cancel_tok.is_some_and(|token| !token.try_commit()) {
                return Err("Operation canceled before destination publication".to_string());
            }
            publish_destination_staging_file(
                &destination_lease,
                &staging_file,
                &temp_name,
                name_path.as_os_str(),
                &temp_path,
                &target_path,
                DestinationPublicationMode::Replace,
            )?;

            Ok(())
        })();

        drop(staging_file);

        publish_res?;

        staging_cleanup.disarm();
        Ok(target_path)
    })();
    consumed_result.map_err(|error| format!("DESTINATION_GRANT_CONSUMED: {error}"))
}

#[tauri::command]
pub async fn close_folder_session(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    session_id: String,
    session_instance_id: String,
) -> Result<bool, String> {
    enforce_main_window(&window)?;
    session_manager.close_session_instance(&session_id, &session_instance_id, Some(window.label()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDestinationSelection {
    pub destination_grant_id: String,
    pub relative_file_name: String,
    pub selected_path: String,
    pub path_case_semantics: crate::path_normalization::PathCaseSemantics,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDestinationFolderSelection {
    pub destination_grant_id: String,
    pub selected_path: String,
    pub path_case_semantics: crate::path_normalization::PathCaseSemantics,
}

#[tauri::command]
pub async fn select_destination_folder(
    app: AppHandle,
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
) -> Result<Option<NativeDestinationFolderSelection>, String> {
    enforce_main_window(&window)?;
    let selected =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
            .await
            .map_err(|error| format!("Native destination folder selection failed: {error}"))?;
    let Some(selected) = selected else { return Ok(None) };
    let path = selected.into_path().map_err(|error| format!("Invalid destination: {error}"))?;
    let destination_grant_id = session_manager.grant_destination(&path, Some(window.label()))?;
    let path_case_semantics = session_manager
        .destination_grant_case_semantics(&destination_grant_id, Some(window.label()))?;
    Ok(Some(NativeDestinationFolderSelection {
        destination_grant_id,
        selected_path: path.to_string_lossy().to_string(),
        path_case_semantics,
    }))
}

#[tauri::command]
pub async fn select_destination(
    app: AppHandle,
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    suggested_file_name: Option<String>,
    operation: String,
) -> Result<Option<NativeDestinationSelection>, String> {
    enforce_main_window(&window)?;
    let selected = tauri::async_runtime::spawn_blocking(move || {
        let builder = app.dialog().file();
        let builder = if let Some(name) = suggested_file_name {
            builder.set_file_name(name)
        } else {
            builder
        };
        builder.blocking_save_file()
    })
    .await
    .map_err(|error| format!("Native destination selection failed: {error}"))?;
    let Some(selected) = selected else { return Ok(None) };
    let path = selected.into_path().map_err(|error| format!("Invalid destination: {error}"))?;
    let (destination_grant_id, relative_file_name) =
        session_manager.grant_exact_destination(&path, &operation, Some(window.label()))?;
    let path_case_semantics = session_manager
        .destination_grant_case_semantics(&destination_grant_id, Some(window.label()))?;
    Ok(Some(NativeDestinationSelection {
        destination_grant_id,
        relative_file_name,
        selected_path: path.to_string_lossy().to_string(),
        path_case_semantics,
    }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeExternalEditorSelection {
    pub editor_grant_id: String,
    pub selected_path: String,
    pub path_case_semantics: crate::path_normalization::PathCaseSemantics,
}

#[tauri::command]
pub async fn select_external_editor(
    app: AppHandle,
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
) -> Result<Option<NativeExternalEditorSelection>, String> {
    enforce_main_window(&window)?;
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Applications", &["exe", "cmd", "bat", "com", "ps1"])
            .blocking_pick_file()
    })
    .await
    .map_err(|error| format!("Native application selection failed: {error}"))?;
    let Some(selected) = selected else { return Ok(None) };
    let path = selected.into_path().map_err(|error| format!("Invalid application: {error}"))?;
    let editor_grant_id = session_manager.grant_external_editor(&path, Some(window.label()))?;
    let path_case_semantics = session_manager
        .external_editor_grant_case_semantics(&editor_grant_id, Some(window.label()))?;
    Ok(Some(NativeExternalEditorSelection {
        editor_grant_id,
        selected_path: path.to_string_lossy().to_string(),
        path_case_semantics,
    }))
}

fn get_thumbnail_blocking(
    file_path: String,
    cache_identity_path: String,
    metadata: thumbnails::SourceMetadata,
    app_cache_dir: PathBuf,
    cancel_tok: Option<&crate::media_executor::CancellationToken>,
) -> Result<thumbnails::GeneratedImageAsset, String> {
    let path = Path::new(&file_path);
    if !path.is_file() {
        return Err(format!("'{}' is not a valid file", file_path));
    }

    let thumb_cache_dir = app_cache_dir.join("thumbnails");
    thumbnails::get_or_create_thumbnail_with_cancellation(
        path,
        Path::new(&cache_identity_path),
        &metadata,
        &thumb_cache_dir,
        cancel_tok,
    )
}

#[tauri::command]
pub async fn cancel_media_request(
    window: tauri::Window,
    executor: tauri::State<'_, crate::media_executor::MediaExecutor>,
    request_id: String,
) -> Result<bool, String> {
    enforce_projector_participant_label(window.label())?;
    Ok(executor.cancel_consumer_request(&request_id, Some(window.label())))
}

#[tauri::command]
pub async fn get_media_executor_telemetry(
    window: tauri::Window,
    executor: tauri::State<'_, crate::media_executor::MediaExecutor>,
) -> Result<crate::media_executor::ExecutorTelemetry, String> {
    enforce_main_window(&window)?;
    Ok(executor.telemetry())
}

#[tauri::command]
pub async fn get_image_metadata_by_id(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    executor: tauri::State<'_, crate::media_executor::MediaExecutor>,
    session_id: String,
    image_id: String,
    request_id: Option<String>,
) -> Result<ImageMetadata, String> {
    let source_lease = session_manager.lease_image(&session_id, &image_id, Some(window.label()))?;
    let consumer_id = request_id.unwrap_or_else(|| format!("meta_{}", image_id));
    let job_key = format!("meta_{}_{}", session_id, image_id);

    let (_token, rx) = executor.spawn_with_channel_owner(
        consumer_id,
        crate::media_executor::PriorityClass::InteractiveMetadata,
        job_key,
        Some(window.label().to_string()),
        move |cancel_tok| {
            if cancel_tok.is_canceled() {
                return Err("Request canceled before execution".to_string());
            }
            source_lease.revalidate()?;
            let snapshot = source_lease.snapshot_for_path_consumer(
                crate::image_resource_policy::OperationClass::MetadataOnly,
            )?;
            let result = get_image_metadata_blocking(snapshot.path().to_string_lossy().to_string());
            source_lease.revalidate()?;
            if cancel_tok.is_canceled() {
                return Err("Request canceled after metadata decode".to_string());
            }
            result
        },
    );

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|_| "Media executor worker dropped".to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn get_preview_image_by_id(
    app: AppHandle,
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    executor: tauri::State<'_, crate::media_executor::MediaExecutor>,
    session_id: String,
    image_id: String,
    max_dimension: u32,
    invalidation_bust: Option<u64>,
    request_id: Option<String>,
) -> Result<thumbnails::GeneratedImageAsset, String> {
    let source_lease = session_manager.lease_image(&session_id, &image_id, Some(window.label()))?;
    let app_cache_dir =
        app.path().app_cache_dir().map_err(|e| format!("Failed to get app cache dir: {}", e))?;
    let path_str = source_lease.path().to_string_lossy().to_string();
    let source_metadata = source_metadata_from_lease(&source_lease)?;
    let req_id = request_id.unwrap_or_else(|| format!("preview_{}_{}", image_id, max_dimension));
    let dedup_key = format!("preview_{}_{}_{:?}", path_str, max_dimension, invalidation_bust);
    let consumer_id = req_id.clone();

    let (_token, rx) = executor.spawn_with_channel_owner(
        consumer_id,
        crate::media_executor::PriorityClass::InteractivePreview,
        dedup_key,
        Some(window.label().to_string()),
        move |cancel_tok| {
            if cancel_tok.is_canceled() {
                return Err("Request canceled before execution".to_string());
            }
            source_lease.revalidate()?;
            let snapshot = source_lease.snapshot_for_path_consumer(
                crate::image_resource_policy::OperationClass::Preview,
            )?;
            let result = get_preview_image_blocking(
                snapshot.path().to_string_lossy().to_string(),
                path_str,
                source_metadata,
                max_dimension,
                invalidation_bust,
                app_cache_dir,
                Some(cancel_tok),
            );
            source_lease.revalidate()?;
            if cancel_tok.is_canceled() {
                return Err("Request canceled after preview decode".to_string());
            }
            result
        },
    );

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|_| "Media executor worker dropped".to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn get_thumbnail_by_id(
    app: AppHandle,
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    executor: tauri::State<'_, crate::media_executor::MediaExecutor>,
    session_id: String,
    image_id: String,
    size_bytes: Option<u64>,
    modified_at: Option<String>,
    request_id: Option<String>,
) -> Result<thumbnails::GeneratedImageAsset, String> {
    let source_lease = session_manager.lease_image(&session_id, &image_id, Some(window.label()))?;
    let app_cache_dir =
        app.path().app_cache_dir().map_err(|e| format!("Failed to get app cache dir: {}", e))?;
    let path_str = source_lease.path().to_string_lossy().to_string();
    let source_metadata = source_metadata_from_lease(&source_lease)?;
    let req_id = request_id.unwrap_or_else(|| format!("thumb_{}", image_id));
    let consumer_id = req_id.clone();

    let dedup_key = format!("thumb_{}_{}_{:?}_{:?}", session_id, image_id, size_bytes, modified_at);

    let (_token, rx) = executor.spawn_with_channel_owner(
        consumer_id,
        crate::media_executor::PriorityClass::VisibleThumbnail,
        dedup_key,
        Some(window.label().to_string()),
        move |cancel_tok| {
            if cancel_tok.is_canceled() {
                return Err("Request canceled before execution".to_string());
            }
            source_lease.revalidate()?;
            let snapshot = source_lease.snapshot_for_path_consumer(
                crate::image_resource_policy::OperationClass::Thumbnail,
            )?;
            let result = get_thumbnail_blocking(
                snapshot.path().to_string_lossy().to_string(),
                path_str,
                source_metadata,
                app_cache_dir,
                Some(cancel_tok),
            );
            source_lease.revalidate()?;
            if cancel_tok.is_canceled() {
                return Err("Request canceled after thumbnail decode".to_string());
            }
            result
        },
    );

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|_| "Media executor worker dropped".to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??
}

#[allow(clippy::too_many_arguments)]
fn get_image_tile_blocking(
    file_path: String,
    cache_identity_path: String,
    metadata: thumbnails::SourceMetadata,
    source_width: u32,
    source_height: u32,
    tile_size: u32,
    tile_x: u32,
    tile_y: u32,
    app_cache_dir: PathBuf,
    cancel_tok: Option<&crate::media_executor::CancellationToken>,
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

    let tile_cache_dir = app_cache_dir.join("tiles");
    thumbnails::get_or_create_tile_with_cancellation(
        path,
        Path::new(&cache_identity_path),
        &metadata,
        &tile_cache_dir,
        thumbnails::TileRequest { source_width, source_height, tile_size, tile_x, tile_y },
        cancel_tok,
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn get_image_tile_by_id(
    app: AppHandle,
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    executor: tauri::State<'_, crate::media_executor::MediaExecutor>,
    session_id: String,
    image_id: String,
    source_width: u32,
    source_height: u32,
    tile_size: u32,
    tile_x: u32,
    tile_y: u32,
    request_id: Option<String>,
) -> Result<thumbnails::GeneratedImageAsset, String> {
    let source_lease = session_manager.lease_image(&session_id, &image_id, Some(window.label()))?;
    let app_cache_dir =
        app.path().app_cache_dir().map_err(|e| format!("Failed to get app cache dir: {}", e))?;
    let path_str = source_lease.path().to_string_lossy().to_string();
    let source_metadata = source_metadata_from_lease(&source_lease)?;
    let req_id = request_id
        .unwrap_or_else(|| format!("tile_{}_{}_{}_{}", image_id, tile_size, tile_x, tile_y));
    let consumer_id = req_id.clone();

    let dedup_key = format!(
        "tile_{}_{}_{}_{}_{}_{}_{}",
        session_id, image_id, source_width, source_height, tile_size, tile_x, tile_y
    );

    let (_token, rx) = executor.spawn_with_channel_owner(
        consumer_id,
        crate::media_executor::PriorityClass::InteractiveTile,
        dedup_key,
        Some(window.label().to_string()),
        move |cancel_tok| {
            if cancel_tok.is_canceled() {
                return Err("Request canceled before execution".to_string());
            }
            source_lease.revalidate()?;
            let snapshot = source_lease
                .snapshot_for_path_consumer(crate::image_resource_policy::OperationClass::Tile)?;
            let result = get_image_tile_blocking(
                snapshot.path().to_string_lossy().to_string(),
                path_str,
                source_metadata,
                source_width,
                source_height,
                tile_size,
                tile_x,
                tile_y,
                app_cache_dir,
                Some(cancel_tok),
            );
            source_lease.revalidate()?;
            if cancel_tok.is_canceled() {
                return Err("Request canceled after tile decode".to_string());
            }
            result
        },
    );

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|_| "Media executor worker dropped".to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??
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
pub async fn save_diagnostics_snapshot(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    destination_grant_id: String,
    relative_file_name: String,
    content: String,
) -> Result<(), String> {
    enforce_main_window(&window)?;

    if !relative_file_name.starts_with("lightframe-diagnostics-")
        || !relative_file_name.ends_with(".json")
    {
        return Err(
            "Diagnostics export must use a lightframe-diagnostics-*.json file name".to_string()
        );
    }
    if content.len() > 4 * 1024 * 1024 {
        return Err("Diagnostics export is unexpectedly large".to_string());
    }

    let mgr = session_manager.inner().clone();
    let label = window.label().to_string();

    tauri::async_runtime::spawn_blocking(move || {
        stage_and_publish_destination_file(
            &mgr,
            &destination_grant_id,
            &relative_file_name,
            "diagnostics",
            Some(&label),
            |staging_file, _staging_path| {
                use std::io::Write;
                staging_file
                    .write_all(content.as_bytes())
                    .map_err(|e| format!("Failed to write diagnostics to staging file: {}", e))
            },
        )?;
        Ok(())
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

#[cfg(test)]
fn paths_match(left: &Path, right: &Path) -> bool {
    left == right
}

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
enum ExclusiveWriteError {
    AlreadyExists,
    Other(String),
}

#[cfg(test)]
fn copy_file_exclusive(
    source_path: &Path,
    destination_path: &Path,
) -> Result<(), ExclusiveWriteError> {
    let source_file = fs::File::open(source_path).map_err(|error| {
        ExclusiveWriteError::Other(format!("Failed to open source file for copy: {}", error))
    })?;
    copy_file_handle_exclusive(source_file, destination_path)
}

#[cfg(test)]
fn copy_file_handle_exclusive(
    mut source_file: fs::File,
    destination_path: &Path,
) -> Result<(), ExclusiveWriteError> {
    use std::io::Seek;
    source_file.seek(std::io::SeekFrom::Start(0)).map_err(|error| {
        ExclusiveWriteError::Other(format!("Failed to seek authorized source file: {error}"))
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

fn copy_authorized_image_to_folder_blocking(
    source_path: &Path,
    source_file: fs::File,
    destination: &crate::authority::DestinationAuthorityLease,
) -> Result<String, String> {
    copy_authorized_image_to_folder_blocking_with_hook(
        source_path,
        source_file,
        destination,
        |_| Ok(()),
        CopyFailurePoint::None,
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
enum CopyFailurePoint {
    None,
    DuringCopy,
    DuringFlush,
    DuringPublication,
}

fn copy_authorized_image_to_folder_blocking_with_hook<F>(
    source_path: &Path,
    mut source_file: fs::File,
    destination: &crate::authority::DestinationAuthorityLease,
    mut before_publish: F,
    failure: CopyFailurePoint,
) -> Result<String, String>
where
    F: FnMut(&Path) -> Result<(), String>,
{
    use std::io::{Read, Seek, Write};
    destination.revalidate()?;
    let destination_folder = destination.path();
    for _ in 0..10_000 {
        let target = next_destination_candidate(source_path, destination_folder)?;
        let target_name =
            target.file_name().ok_or_else(|| "Copy destination name is missing".to_string())?;
        let extension = target
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!(".{value}"))
            .unwrap_or_default();
        let temp_name = format!(".copy_{}{}", uuid::Uuid::new_v4(), extension);
        let temp_path = destination_folder.join(&temp_name);
        let mut staging = create_destination_staging_file(destination, &temp_name, &temp_path)?;
        let mut staging_cleanup = DestinationStagingCleanup {
            lease: destination,
            temp_name: temp_name.clone(),
            temp_path: temp_path.clone(),
            armed: true,
        };
        if failure == CopyFailurePoint::DuringCopy {
            return Err("Injected authorized copy failure".into());
        }
        source_file
            .seek(std::io::SeekFrom::Start(0))
            .map_err(|error| format!("Failed to seek authorized source handle: {error}"))?;
        let expected = source_file.metadata().map_err(|error| error.to_string())?.len();
        let copied = std::io::copy(
            &mut std::io::Read::by_ref(&mut source_file).take(expected + 1),
            &mut staging,
        )
        .map_err(|error| format!("Failed to copy authorized source handle: {error}"))?;
        if copied != expected {
            return Err("Authorized source length changed during copy".into());
        }
        if failure == CopyFailurePoint::DuringFlush {
            return Err("Injected authorized copy flush failure".into());
        }
        staging
            .flush()
            .and_then(|_| staging.sync_all())
            .map_err(|error| format!("Failed to durably stage authorized copy: {error}"))?;
        before_publish(&target)?;
        if failure == CopyFailurePoint::DuringPublication {
            return Err("Injected authorized copy publication failure".into());
        }
        match publish_destination_staging_file(
            destination,
            &staging,
            &temp_name,
            target_name,
            &temp_path,
            &target,
            DestinationPublicationMode::NoReplace,
        ) {
            Ok(()) => {
                staging_cleanup.disarm();
                return Ok(target.to_string_lossy().to_string());
            }
            Err(error) if error.contains("exist") || error.contains("collision") => continue,
            Err(error) => return Err(error),
        }
    }
    Err("Unable to resolve a unique destination file name".to_string())
}

#[cfg(test)]
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

#[cfg(test)]
fn is_cross_device_rename_error(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(17 | 18))
}

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
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
            Ok(target_path) => successes.push(ImageTransferSuccess {
                source_path,
                target_path,
                warning: None,
                source_removed: matches!(mode, ImageTransferMode::Move),
                committed: true,
            }),
            Err(error) => failures.push(ImageTransferFailure::not_committed(source_path, error)),
        }
    }

    ImageTransferResult { successes, failures }
}

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

#[cfg(test)]
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

    std::process::Command::new(editor_path)
        .arg(image_path)
        .spawn()
        .map_err(|err| format!("Failed to launch external application: {}", err))?;

    Ok(())
}

#[cfg(test)]
fn save_rotated_image_blocking(file_path: String, rotation_degrees: i32) -> Result<(), String> {
    save_rotated_image_blocking_with_commit_guard(file_path, rotation_degrees, &mut || Ok(()))
}

#[cfg(test)]
fn save_rotated_image_blocking_with_commit_guard(
    file_path: String,
    rotation_degrees: i32,
    commit_guard: &mut dyn FnMut() -> Result<(), String>,
) -> Result<(), String> {
    save_rotated_image_from_source_with_commit_guard(
        file_path.clone(),
        file_path,
        rotation_degrees,
        commit_guard,
    )
}

#[cfg(test)]
fn save_rotated_image_from_source_with_commit_guard(
    source_file_path: String,
    target_file_path: String,
    rotation_degrees: i32,
    commit_guard: &mut dyn FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let target = PathBuf::from(&target_file_path);
    save_rotated_image_from_source_with_publisher(
        source_file_path,
        target_file_path,
        rotation_degrees,
        &mut |temporary, prepared_handle| {
            commit_guard()?;
            drop(prepared_handle);
            replace_file_safely(temporary, &target)
        },
    )
}

fn save_rotated_image_from_source_with_publisher(
    source_file_path: String,
    target_file_path: String,
    rotation_degrees: i32,
    publisher: &mut dyn FnMut(&Path, fs::File) -> Result<(), String>,
) -> Result<(), String> {
    let path = Path::new(&source_file_path);
    let target_path = Path::new(&target_file_path);
    if !path.is_file() {
        return Err(format!("'{}' is not a valid file", source_file_path));
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

    let extension = target_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    match rotation_save_strategy(&extension, rotation_degrees) {
        None => Ok(()),
        Some(RotationSaveStrategy::Unsupported) => {
            Err(format!("Saving rotation is not supported for {} files", extension.to_uppercase()))
        }
        Some(RotationSaveStrategy::Reencode) => save_rotated_image_by_reencoding(
            path,
            target_path,
            rotation_degrees,
            "rotation",
            publisher,
        ),
        Some(RotationSaveStrategy::LosslessJpegThenFallback) => {
            if let Err(lossless_error) =
                save_lossless_jpeg_rotation(path, target_path, rotation_degrees, publisher)
            {
                eprintln!(
                    "Lossless JPEG rotation failed for '{}': {}. Falling back to pixel re-encode.",
                    target_file_path, lossless_error
                );
                save_rotated_image_by_reencoding(
                    path,
                    target_path,
                    rotation_degrees,
                    "rotation",
                    publisher,
                )
            } else {
                Ok(())
            }
        }
    }
}

fn save_lossless_jpeg_rotation(
    source_path: &Path,
    target_path: &Path,
    rotation_degrees: i32,
    publisher: &mut dyn FnMut(&Path, fs::File) -> Result<(), String>,
) -> Result<(), String> {
    let jpeg_bytes =
        fs::read(source_path).map_err(|e| format!("Failed to read JPEG for rotation: {}", e))?;
    let rotated_bytes = try_lossless_jpeg_rotation_bytes(&jpeg_bytes, rotation_degrees)?;
    let temp_path = build_unique_sibling_path(target_path, "lightframe-rotate")?;
    let mut temp_file = create_secured_staging_file(&temp_path)?;
    use std::io::Write;
    temp_file
        .write_all(&rotated_bytes)
        .and_then(|_| temp_file.flush())
        .map_err(|e| format!("Failed to write temporary rotated JPEG: {}", e))?;

    if let Err(err) = restore_normal_orientation(source_path, &temp_path, "lossless rotation") {
        drop(temp_file);
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }

    prepare_staging_for_publication(&mut temp_file)?;

    if let Err(err) = publisher(&temp_path, temp_file) {
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }
    let _ = fs::remove_file(&temp_path);

    Ok(())
}

fn save_rotated_image_by_reencoding(
    source_path: &Path,
    target_path: &Path,
    rotation_degrees: i32,
    context_label: &str,
    publisher: &mut dyn FnMut(&Path, fs::File) -> Result<(), String>,
) -> Result<(), String> {
    let img =
        image::open(source_path).map_err(|e| format!("Failed to open image for saving: {}", e))?;
    let rotated = apply_rotation(img, rotation_degrees)?;
    let temp_path = build_unique_sibling_path(target_path, "lightframe-rotate")?;
    let mut temp_file = create_secured_staging_file(&temp_path)?;
    write_dynamic_image_to_file(
        &rotated,
        &mut temp_file,
        &temp_path,
        "Failed to save rotated image",
    )?;

    if let Err(err) = restore_normal_orientation(source_path, &temp_path, context_label) {
        drop(temp_file);
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }

    prepare_staging_for_publication(&mut temp_file)?;

    if let Err(err) = publisher(&temp_path, temp_file) {
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }
    let _ = fs::remove_file(&temp_path);

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

fn write_cropped_image_to_file(
    cropped: &image::RgbaImage,
    output_file: &mut fs::File,
    output_path: &Path,
    error_prefix: &str,
) -> Result<(), String> {
    write_dynamic_image_to_file(
        &image::DynamicImage::ImageRgba8(cropped.clone()),
        output_file,
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

fn preflight_scaled_export_source(input_path: &Path) -> Result<(u32, u32), String> {
    let limits = crate::image_resource_policy::PolicyLimits::for_operation(
        crate::image_resource_policy::OperationClass::ScaledExport,
    );
    let file_size = input_path
        .metadata()
        .map_err(|error| format!("Failed to inspect scaled-export source: {error}"))?
        .len();
    crate::image_resource_policy::validate_file_size_bytes(file_size, &limits)
        .map_err(|error| format!("Scaled-export source rejected: {error}"))?;
    let (width, height) = read_scale_source_dimensions(input_path)?;
    crate::image_resource_policy::validate_dimensions(width, height, &limits)
        .map_err(|error| format!("Scaled-export source rejected: {error}"))?;
    Ok((width, height))
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

fn save_scaled_copy_to_file_blocking(
    file_path: String,
    output_file: &mut fs::File,
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
    let (source_width, source_height) = preflight_scaled_export_source(input_path)?;
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

    write_high_quality_image_to_file(
        &scaled,
        output_file,
        output_path_ref,
        "Failed to save scaled copy",
    )
}

#[allow(dead_code)]
fn save_scaled_copy_blocking(
    file_path: String,
    output_path: String,
    width: u32,
    height: u32,
    smoothing: f32,
    sharpening: f32,
) -> Result<(), String> {
    let input_path = Path::new(&file_path);
    let output_path_ref = Path::new(&output_path);
    validate_copy_output_path(input_path, output_path_ref, true)?;

    let mut file = fs::File::create(&output_path)
        .map_err(|e| format!("Failed to create output file: {}", e))?;
    let res = save_scaled_copy_to_file_blocking(
        file_path,
        &mut file,
        output_path.clone(),
        width,
        height,
        smoothing,
        sharpening,
    );
    if res.is_err() {
        drop(file);
        let _ = fs::remove_file(&output_path);
    }
    res
}

fn save_cropped_copy_to_file_blocking(
    file_path: String,
    crop_rect: CropRect,
    output_file: &mut fs::File,
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

    write_dynamic_image_to_file(
        &image::DynamicImage::ImageRgba8(cropped),
        output_file,
        output_path_ref,
        "Failed to save cropped copy",
    )?;

    Ok(())
}

#[allow(dead_code)]
fn save_cropped_copy_blocking(
    file_path: String,
    crop_rect: CropRect,
    output_path: String,
    rotation_degrees: Option<i32>,
) -> Result<(), String> {
    let input_path = Path::new(&file_path);
    let output_path_ref = Path::new(&output_path);
    validate_copy_output_path(input_path, output_path_ref, false)?;

    let mut file = fs::File::create(&output_path)
        .map_err(|e| format!("Failed to create output file: {}", e))?;
    let res = save_cropped_copy_to_file_blocking(
        file_path,
        crop_rect,
        &mut file,
        output_path.clone(),
        rotation_degrees,
    );
    if res.is_err() {
        drop(file);
        let _ = fs::remove_file(&output_path);
    }
    res
}

fn build_crop_temp_path(source_path: &Path) -> Result<PathBuf, String> {
    build_unique_sibling_path(source_path, "lightframe-crop")
}

#[cfg(test)]
fn overwrite_with_crop_blocking(
    file_path: String,
    crop_rect: CropRect,
    rotation_degrees: Option<i32>,
) -> Result<(), String> {
    overwrite_with_crop_blocking_with_commit_guard(
        file_path,
        crop_rect,
        rotation_degrees,
        &mut || Ok(()),
    )
}

#[cfg(test)]
fn overwrite_with_crop_blocking_with_commit_guard(
    file_path: String,
    crop_rect: CropRect,
    rotation_degrees: Option<i32>,
    commit_guard: &mut dyn FnMut() -> Result<(), String>,
) -> Result<(), String> {
    overwrite_with_crop_from_source_with_commit_guard(
        file_path.clone(),
        file_path,
        crop_rect,
        rotation_degrees,
        commit_guard,
    )
}

#[cfg(test)]
fn overwrite_with_crop_from_source_with_commit_guard(
    source_file_path: String,
    target_file_path: String,
    crop_rect: CropRect,
    rotation_degrees: Option<i32>,
    commit_guard: &mut dyn FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let target = PathBuf::from(&target_file_path);
    overwrite_with_crop_from_source_with_publisher(
        source_file_path,
        target_file_path,
        crop_rect,
        rotation_degrees,
        &mut |temporary, prepared_handle| {
            commit_guard()?;
            drop(prepared_handle);
            replace_file_safely(temporary, &target)
        },
    )
}

fn overwrite_with_crop_from_source_with_publisher(
    source_file_path: String,
    target_file_path: String,
    crop_rect: CropRect,
    rotation_degrees: Option<i32>,
    publisher: &mut dyn FnMut(&Path, fs::File) -> Result<(), String>,
) -> Result<(), String> {
    let input_path = Path::new(&source_file_path);
    let target_path = Path::new(&target_file_path);
    if !input_path.is_file() {
        return Err(format!("'{}' is not a valid file", source_file_path));
    }

    let extension = target_path
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

    let temp_path = build_crop_temp_path(target_path)?;
    let metadata = Metadata::new_from_path(input_path).ok();
    let mut temp_file = create_secured_staging_file(&temp_path)?;

    if let Err(err) = write_cropped_image_to_file(
        &cropped,
        &mut temp_file,
        &temp_path,
        "Failed to write temporary cropped image",
    ) {
        drop(temp_file);
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

    prepare_staging_for_publication(&mut temp_file)?;

    if let Err(err) = publisher(&temp_path, temp_file) {
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }
    let _ = fs::remove_file(&temp_path);

    Ok(())
}

#[allow(dead_code)]
fn resolve_and_contain_destination_file(
    session_manager: &crate::authority::SessionManager,
    destination_grant_id: &str,
    relative_file_name: &str,
    window_label: Option<&str>,
) -> Result<PathBuf, String> {
    let dest_folder =
        session_manager.resolve_destination_grant(destination_grant_id, window_label)?;
    let path_case_semantics =
        session_manager.destination_grant_case_semantics(destination_grant_id, window_label)?;
    let dest_canonical = fs::canonicalize(&dest_folder)
        .map_err(|e| format!("Destination directory is invalid or inaccessible: {}", e))?;

    let name_trimmed = relative_file_name.trim();
    if name_trimmed.is_empty() {
        return Err("Output relative_file_name must not be empty".to_string());
    }
    let name_path = Path::new(name_trimmed);
    if name_path.is_absolute()
        || name_trimmed.contains('/')
        || name_trimmed.contains('\\')
        || name_trimmed.contains("..")
    {
        return Err(
            "Output relative_file_name must be a simple file name without path separators or '..' traversal"
                .to_string(),
        );
    }
    let target_path = dest_folder.join(name_path);

    let parent =
        target_path.parent().ok_or_else(|| "Target path missing parent directory".to_string())?;
    let parent_canonical = fs::canonicalize(parent)
        .map_err(|e| format!("Destination parent directory must exist: {}", e))?;
    if !crate::authority::is_path_contained_in_with_semantics(
        &parent_canonical,
        &dest_canonical,
        path_case_semantics,
    ) {
        return Err(
            "Target parent directory escapes granted destination folder boundary".to_string()
        );
    }

    if let Ok(symlink_meta) = fs::symlink_metadata(&target_path) {
        if symlink_meta.file_type().is_symlink() {
            return Err("Target file path is an existing symlink or junction point".to_string());
        }
        if let Ok(canonical_target) = fs::canonicalize(&target_path) {
            if !crate::authority::is_path_contained_in_with_semantics(
                &canonical_target,
                &dest_canonical,
                path_case_semantics,
            ) {
                return Err(
                    "Target file path resolves outside granted destination boundary".to_string()
                );
            }
        }
    }
    if !crate::authority::is_path_contained_in_with_semantics(
        &target_path,
        &dest_canonical,
        path_case_semantics,
    ) {
        return Err("Output path escapes granted destination folder boundary".to_string());
    }
    Ok(target_path)
}

#[allow(dead_code)]
pub fn revalidate_created_file_containment(
    target_path: &Path,
    dest_folder: &Path,
) -> Result<(), String> {
    if let Ok(symlink_meta) = fs::symlink_metadata(target_path) {
        if symlink_meta.file_type().is_symlink() {
            return Err("Target file path is a symlink or junction point".to_string());
        }
    }
    let canonical_target = fs::canonicalize(target_path)
        .map_err(|e| format!("Failed to canonicalize target file: {}", e))?;
    let dest_canonical =
        fs::canonicalize(dest_folder).unwrap_or_else(|_| dest_folder.to_path_buf());
    let path_case_semantics =
        crate::path_normalization::directory_path_case_semantics_for_path(dest_folder)?;
    if !crate::authority::is_path_contained_in_with_semantics(
        &canonical_target,
        &dest_canonical,
        path_case_semantics,
    ) {
        return Err("Target file path resolves outside granted destination boundary".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn trash_image_by_id(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    session_id: String,
    image_id: String,
) -> Result<crate::authority::TrashCommitOutcome, String> {
    enforce_main_window(&window)?;
    let source_lease = session_manager.lease_image(&session_id, &image_id, Some(window.label()))?;
    tauri::async_runtime::spawn_blocking(move || source_lease.trash_with_recovery())
        .await
        .map_err(|error| format!("Trash worker failed: {error}"))?
}

#[tauri::command]
pub async fn copy_image_by_id(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    session_id: String,
    image_id: String,
    destination_grant_id: String,
) -> Result<String, String> {
    enforce_main_window(&window)?;
    let source_lease = session_manager.lease_image(&session_id, &image_id, Some(window.label()))?;
    let destination_lease =
        session_manager.lease_destination_grant(&destination_grant_id, Some(window.label()))?;
    let source_path = source_lease.path().to_path_buf();
    let source_file = source_lease.try_clone_file()?;
    tauri::async_runtime::spawn_blocking(move || {
        source_lease.revalidate()?;
        destination_lease.revalidate()?;
        copy_authorized_image_to_folder_blocking(&source_path, source_file, &destination_lease)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn move_image_by_id(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    session_id: String,
    image_id: String,
    destination_grant_id: String,
) -> Result<ImageTransferSuccess, String> {
    enforce_main_window(&window)?;
    let source_lease = session_manager.lease_image(&session_id, &image_id, Some(window.label()))?;
    let destination_lease =
        session_manager.lease_destination_grant(&destination_grant_id, Some(window.label()))?;
    let source_path = source_lease.path().to_path_buf();
    let destination_path = destination_lease.path().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        source_lease.revalidate()?;
        destination_lease.revalidate()?;
        for _ in 0..10_000 {
            let target = next_destination_candidate(&source_path, &destination_path)?;
            let target_name = target
                .file_name()
                .ok_or_else(|| "Move destination file name is missing".to_string())?;
            match source_lease.move_to_destination(&destination_lease, target_name) {
                Ok(outcome) => {
                    return Ok(ImageTransferSuccess {
                        source_path: source_path.to_string_lossy().to_string(),
                        target_path: outcome.target_path().to_string_lossy().to_string(),
                        warning: outcome.durability_warning().map(str::to_owned),
                        source_removed: outcome.source_removed(),
                        committed: true,
                    });
                }
                Err(error) if error.contains("exist") || error.contains("collision") => continue,
                Err(error) => return Err(error),
            }
        }
        Err("Unable to resolve a unique destination file name".to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn transfer_images_by_id(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    session_id: String,
    image_ids: Vec<String>,
    destination_grant_id: String,
    mode: ImageTransferMode,
) -> Result<ImageTransferResult, String> {
    enforce_main_window(&window)?;
    let destination_lease =
        session_manager.lease_destination_grant(&destination_grant_id, Some(window.label()))?;
    let dest_str = destination_lease.path().to_string_lossy().to_string();
    let mut resolved_paths = Vec::new();
    let mut source_leases = Vec::new();
    let mut source_files = Vec::new();
    for id in &image_ids {
        let lease = session_manager.lease_image(&session_id, id, Some(window.label()))?;
        resolved_paths.push(lease.path().to_string_lossy().to_string());
        source_files.push(lease.try_clone_file()?);
        source_leases.push(lease);
    }
    tauri::async_runtime::spawn_blocking(move || {
        destination_lease.revalidate()?;
        for lease in &source_leases {
            lease.revalidate()?;
        }
        if matches!(mode, ImageTransferMode::Copy) {
            let mut successes = Vec::new();
            let mut failures = Vec::new();
            for ((source_path, source_file), lease) in
                resolved_paths.into_iter().zip(source_files).zip(source_leases)
            {
                let result = lease.revalidate().and_then(|_| {
                    copy_authorized_image_to_folder_blocking(
                        Path::new(&source_path),
                        source_file,
                        &destination_lease,
                    )
                });
                match result {
                    Ok(target_path) => successes.push(ImageTransferSuccess {
                        source_path,
                        target_path,
                        warning: None,
                        source_removed: false,
                        committed: true,
                    }),
                    Err(error) => {
                        failures.push(ImageTransferFailure::not_committed(source_path, error))
                    }
                }
            }
            return Ok(ImageTransferResult { successes, failures });
        }
        drop(source_files);
        let mut successes = Vec::new();
        let mut failures = Vec::new();
        for (source_path, lease) in resolved_paths.into_iter().zip(source_leases) {
            let result = (|| -> Result<ImageTransferSuccess, String> {
                lease.revalidate()?;
                for _ in 0..10_000 {
                    let target =
                        next_destination_candidate(Path::new(&source_path), Path::new(&dest_str))?;
                    let target_name = target
                        .file_name()
                        .ok_or_else(|| "Move destination file name is missing".to_string())?;
                    match lease.move_to_destination(&destination_lease, target_name) {
                        Ok(outcome) => {
                            return Ok(ImageTransferSuccess {
                                source_path: source_path.clone(),
                                target_path: outcome.target_path().to_string_lossy().to_string(),
                                warning: outcome.durability_warning().map(str::to_owned),
                                source_removed: outcome.source_removed(),
                                committed: true,
                            });
                        }
                        Err(error) if error.contains("exist") || error.contains("collision") => {
                            continue
                        }
                        Err(error) => return Err(error),
                    }
                }
                Err("Unable to resolve a unique destination file name".to_string())
            })();
            match result {
                Ok(success) => successes.push(success),
                Err(error) => {
                    failures.push(ImageTransferFailure::not_committed(source_path, error))
                }
            }
        }
        Ok(ImageTransferResult { successes, failures })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn copy_image_by_id_to_clipboard(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    executor: tauri::State<'_, crate::media_executor::MediaExecutor>,
    session_id: String,
    image_id: String,
) -> Result<(), String> {
    enforce_main_window(&window)?;
    let source_lease = session_manager.lease_image(&session_id, &image_id, Some(window.label()))?;
    let job_key = format!("clip_{}", image_id);
    let consumer_id = format!("consumer_{}_{:?}", job_key, std::time::Instant::now());

    let (_token, rx) = executor.spawn_uncoalesced_with_channel_owner(
        consumer_id,
        crate::media_executor::PriorityClass::UserEdit,
        job_key,
        Some(window.label().to_string()),
        move |cancel_tok| {
            if cancel_tok.is_canceled() {
                return Err("Clipboard copy canceled before decode".into());
            }
            source_lease.revalidate()?;
            let snapshot = source_lease.snapshot_for_path_consumer(
                crate::image_resource_policy::OperationClass::Clipboard,
            )?;
            let result =
                copy_image_to_clipboard_blocking(snapshot.path().to_string_lossy().to_string());
            source_lease.revalidate()?;
            result
        },
    );

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|_| "Media executor worker dropped".to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??
}

#[tauri::command]
pub async fn reveal_image_by_id(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    session_id: String,
    image_id: String,
) -> Result<(), String> {
    enforce_main_window(&window)?;
    let lease = session_manager.lease_image(&session_id, &image_id, Some(window.label()))?;
    lease.revalidate()?;
    tauri_plugin_opener::reveal_item_in_dir(lease.path())
        .map_err(|error| format!("Failed to reveal authorized image: {error}"))
}

#[tauri::command]
pub async fn launch_external_editor_by_id(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    session_id: String,
    image_id: String,
    editor_grant_id: String,
) -> Result<(), String> {
    enforce_main_window(&window)?;
    let source_lease = session_manager.lease_image(&session_id, &image_id, Some(window.label()))?;
    let editor_lease =
        session_manager.lease_external_editor_grant(&editor_grant_id, Some(window.label()))?;
    source_lease.revalidate()?;
    let source_blocking_pin = source_lease.blocking_path_pin()?;
    editor_lease.revalidate()?;
    #[cfg(windows)]
    {
        let application_path = editor_lease.path().to_path_buf();
        let image_path = source_lease.path().to_path_buf();
        let extension = application_path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        const ALLOWED_EXECUTABLE_EXTENSIONS: &[&str] = &["exe", "cmd", "bat", "com", "ps1"];
        if !ALLOWED_EXECUTABLE_EXTENSIONS.contains(&extension.as_str()) {
            return Err("External editor grant is not a recognized executable".to_string());
        }
        let mut child = std::process::Command::new(&application_path)
            .arg(&image_path)
            .spawn()
            .map_err(|error| format!("Failed to launch external application: {error}"))?;
        // Keep both identity pins alive until the editor exits. This prevents the executable or
        // image argument from being replaced between process creation and the editor's delayed
        // open of its command-line input.
        std::thread::spawn(move || {
            let _source_authority = source_lease;
            let _source_blocking_pin = source_blocking_pin;
            let _editor_authority = editor_lease;
            let _ = child.wait();
        });
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (source_lease, source_blocking_pin, editor_lease);
        Err("Identity-bound external editor launch is unavailable on this platform".to_string())
    }
}

#[tauri::command]
pub async fn get_exif_metadata_by_id(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    executor: tauri::State<'_, crate::media_executor::MediaExecutor>,
    session_id: String,
    image_id: String,
) -> Result<ExifData, String> {
    enforce_main_window(&window)?;
    let source_lease = session_manager.lease_image(&session_id, &image_id, Some(window.label()))?;
    let image_file = source_lease.try_clone_file()?;
    let sidecar = session_manager
        .lease_xmp_sidecar(&session_id, &image_id, Some(window.label()))?
        .map(|lease| (lease.file_name().to_string(), lease.into_file()));
    let job_key = format!("exif_{}_{}", session_id, image_id);
    let consumer_id = format!("consumer_{}_{:?}", job_key, std::time::Instant::now());

    let (_token, rx) = executor.spawn_with_channel_owner(
        consumer_id,
        crate::media_executor::PriorityClass::InteractiveMetadata,
        job_key,
        Some(window.label().to_string()),
        move |cancel_tok| {
            if cancel_tok.is_canceled() {
                return Err("EXIF request canceled before decode".into());
            }
            source_lease.revalidate()?;
            let result =
                crate::image_metadata::get_exif_metadata_from_authorized_files(image_file, sidecar);
            source_lease.revalidate()?;
            result
        },
    );

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|_| "Media executor worker dropped".to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??
}

#[tauri::command]
pub async fn rotate_image_by_id(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    executor: tauri::State<'_, crate::media_executor::MediaExecutor>,
    session_id: String,
    image_id: String,
    rotation_degrees: i32,
    request_id: Option<String>,
) -> Result<(), String> {
    enforce_main_window(&window)?;
    let source_lease = session_manager.lease_image(&session_id, &image_id, Some(window.label()))?;
    let path_str = source_lease.path().to_string_lossy().to_string();
    let job_key = format!("rotate_{}_{}", image_id, rotation_degrees);
    let consumer_id = request_id
        .unwrap_or_else(|| format!("consumer_{}_{:?}", job_key, std::time::Instant::now()));

    let (_token, rx) = executor.spawn_uncoalesced_with_channel_owner(
        consumer_id,
        crate::media_executor::PriorityClass::UserEdit,
        job_key,
        Some(window.label().to_string()),
        move |cancel_tok| {
            let mut source_lease = Some(source_lease);
            let snapshot = source_lease
                .as_ref()
                .expect("rotation source lease missing")
                .snapshot_for_path_consumer(crate::image_resource_policy::OperationClass::Rotate)?;
            save_rotated_image_from_source_with_publisher(
                snapshot.path().to_string_lossy().to_string(),
                path_str,
                rotation_degrees,
                &mut |temporary, prepared_handle| {
                    let lease = source_lease.take().ok_or_else(|| {
                        "Rotation publisher was invoked more than once".to_string()
                    })?;
                    lease.revalidate()?;
                    if !cancel_tok.try_commit() {
                        return Err("Rotation canceled before source replacement".into());
                    }
                    lease.replace_contents_from_pinned(temporary, prepared_handle)
                },
            )
        },
    );

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|_| "Media executor worker dropped".to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn save_cropped_copy_by_id(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    executor: tauri::State<'_, crate::media_executor::MediaExecutor>,
    session_id: String,
    image_id: String,
    crop_rect: CropRect,
    destination_grant_id: String,
    relative_file_name: String,
    rotation_degrees: Option<i32>,
    request_id: Option<String>,
) -> Result<(), DestinationOperationError> {
    enforce_main_window(&window).map_err(|error| DestinationOperationError::new(error, false))?;
    let source_lease = session_manager
        .lease_image(&session_id, &image_id, Some(window.label()))
        .map_err(|error| DestinationOperationError::new(error, false))?;
    let mgr = session_manager.inner().clone();
    let label = window.label().to_string();
    let job_key = format!("crop_copy_{}", image_id);
    let consumer_id = request_id
        .unwrap_or_else(|| format!("consumer_{}_{:?}", job_key, std::time::Instant::now()));
    let grant_consumed = Arc::new(AtomicBool::new(false));
    let worker_grant_consumed = grant_consumed.clone();

    let (_token, rx) = executor.spawn_uncoalesced_with_channel_owner(
        consumer_id,
        crate::media_executor::PriorityClass::UserEdit,
        job_key,
        Some(window.label().to_string()),
        move |cancel_tok| {
            stage_and_publish_destination_file_with_cancellation(
                &mgr,
                &destination_grant_id,
                &relative_file_name,
                "crop-copy",
                Some(&label),
                Some(cancel_tok),
                Some(worker_grant_consumed.as_ref()),
                |staging_file, staging_path| {
                    if cancel_tok.is_canceled() {
                        return Err("Crop canceled before decode".into());
                    }
                    source_lease.revalidate()?;
                    let snapshot = source_lease.snapshot_for_path_consumer(
                        crate::image_resource_policy::OperationClass::Crop,
                    )?;
                    let output_str = staging_path.to_string_lossy().to_string();
                    let result = save_cropped_copy_to_file_blocking(
                        snapshot.path().to_string_lossy().to_string(),
                        crop_rect,
                        staging_file,
                        output_str,
                        rotation_degrees,
                    );
                    source_lease.revalidate()?;
                    if cancel_tok.is_canceled() {
                        return Err("Crop canceled after decode".into());
                    }
                    result
                },
            )?;
            Ok(())
        },
    );

    match tauri::async_runtime::spawn_blocking(move || rx.recv()).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(error))) => Err(destination_operation_error(error, &grant_consumed)),
        Ok(Err(_)) => Err(destination_operation_error(
            "Media executor worker dropped before returning a result",
            &grant_consumed,
        )),
        Err(error) => {
            Err(destination_operation_error(format!("Task join error: {error}"), &grant_consumed))
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn save_scaled_copy_by_id(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    executor: tauri::State<'_, crate::media_executor::MediaExecutor>,
    session_id: String,
    image_id: String,
    destination_grant_id: String,
    relative_file_name: String,
    width: u32,
    height: u32,
    smoothing: f32,
    sharpening: f32,
    request_id: Option<String>,
) -> Result<(), DestinationOperationError> {
    enforce_main_window(&window).map_err(|error| DestinationOperationError::new(error, false))?;
    let source_lease = session_manager
        .lease_image(&session_id, &image_id, Some(window.label()))
        .map_err(|error| DestinationOperationError::new(error, false))?;
    let mgr = session_manager.inner().clone();
    let label = window.label().to_string();
    let job_key = format!("scale_copy_{}_{}_{}", image_id, width, height);
    let consumer_id = request_id
        .unwrap_or_else(|| format!("consumer_{}_{:?}", job_key, std::time::Instant::now()));
    let grant_consumed = Arc::new(AtomicBool::new(false));
    let worker_grant_consumed = grant_consumed.clone();

    let (_token, rx) = executor.spawn_uncoalesced_with_channel_owner(
        consumer_id,
        crate::media_executor::PriorityClass::UserEdit,
        job_key,
        Some(window.label().to_string()),
        move |cancel_tok| {
            stage_and_publish_destination_file_with_cancellation(
                &mgr,
                &destination_grant_id,
                &relative_file_name,
                "scale-copy",
                Some(&label),
                Some(cancel_tok),
                Some(worker_grant_consumed.as_ref()),
                |staging_file, staging_path| {
                    if cancel_tok.is_canceled() {
                        return Err("Scale canceled before decode".into());
                    }
                    source_lease.revalidate()?;
                    let snapshot = source_lease.snapshot_for_path_consumer(
                        crate::image_resource_policy::OperationClass::ScaledExport,
                    )?;
                    let output_str = staging_path.to_string_lossy().to_string();
                    let result = save_scaled_copy_to_file_blocking(
                        snapshot.path().to_string_lossy().to_string(),
                        staging_file,
                        output_str,
                        width,
                        height,
                        smoothing,
                        sharpening,
                    );
                    source_lease.revalidate()?;
                    if cancel_tok.is_canceled() {
                        return Err("Scale canceled after decode".into());
                    }
                    result
                },
            )?;
            Ok(())
        },
    );

    match tauri::async_runtime::spawn_blocking(move || rx.recv()).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(error))) => Err(destination_operation_error(error, &grant_consumed)),
        Ok(Err(_)) => Err(destination_operation_error(
            "Media executor worker dropped before returning a result",
            &grant_consumed,
        )),
        Err(error) => {
            Err(destination_operation_error(format!("Task join error: {error}"), &grant_consumed))
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn overwrite_with_crop_by_id(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    executor: tauri::State<'_, crate::media_executor::MediaExecutor>,
    session_id: String,
    image_id: String,
    crop_rect: CropRect,
    rotation_degrees: Option<i32>,
    request_id: Option<String>,
) -> Result<(), String> {
    enforce_main_window(&window)?;
    let source_lease = session_manager.lease_image(&session_id, &image_id, Some(window.label()))?;
    let path_str = source_lease.path().to_string_lossy().to_string();
    let job_key = format!("overwrite_crop_{}", image_id);
    let consumer_id = request_id
        .unwrap_or_else(|| format!("consumer_{}_{:?}", job_key, std::time::Instant::now()));

    let (_token, rx) = executor.spawn_uncoalesced_with_channel_owner(
        consumer_id,
        crate::media_executor::PriorityClass::UserEdit,
        job_key,
        Some(window.label().to_string()),
        move |cancel_tok| {
            let mut source_lease = Some(source_lease);
            let snapshot = source_lease
                .as_ref()
                .expect("crop source lease missing")
                .snapshot_for_path_consumer(
                    crate::image_resource_policy::OperationClass::Overwrite,
                )?;
            overwrite_with_crop_from_source_with_publisher(
                snapshot.path().to_string_lossy().to_string(),
                path_str,
                crop_rect,
                rotation_degrees,
                &mut |temporary, prepared_handle| {
                    let lease = source_lease.take().ok_or_else(|| {
                        "Crop overwrite publisher was invoked more than once".to_string()
                    })?;
                    lease.revalidate()?;
                    if !cancel_tok.try_commit() {
                        return Err("Crop overwrite canceled before source replacement".into());
                    }
                    lease.replace_contents_from_pinned(temporary, prepared_handle)
                },
            )
        },
    );

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|_| "Media executor worker dropped".to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??
}

#[tauri::command]
pub async fn emit_projector_sync_by_id(
    app: tauri::AppHandle,
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    session_id: String,
    image_id: String,
) -> Result<(), String> {
    enforce_projector_participant_label(window.label())?;
    let _ = session_manager.resolve_image_path(&session_id, &image_id, Some(window.label()))?;
    if window.label() == "main" {
        session_manager.authorize_projector_read(&session_id, &image_id, "secondary");
    }

    use tauri::Emitter;
    app.emit(
        "state-sync",
        serde_json::json!({
            "sessionId": session_id,
            "imageId": image_id,
            "source": window.label(),
        }),
    )
    .map_err(|e| format!("Failed to emit projector state sync: {}", e))
}

#[tauri::command]
pub async fn clear_projector_sync(
    app: tauri::AppHandle,
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
) -> Result<(), String> {
    enforce_main_window(&window)?;
    session_manager.revoke_projector_grant("secondary");
    use tauri::Emitter;
    app.emit("state-sync", serde_json::json!({ "source": "main" }))
        .map_err(|error| format!("Failed to emit empty projector state: {error}"))
}

#[tauri::command]
pub async fn request_projector_sync(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<(), String> {
    enforce_secondary_window_label(window.label())?;
    use tauri::Emitter;
    app.emit("state-sync-request", serde_json::json!({}))
        .map_err(|e| format!("Failed to emit projector state sync request: {}", e))
}

pub use crate::authority::ProjectorDisplayRecord;

#[tauri::command]
pub async fn read_projector_display_record(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
) -> Result<ProjectorDisplayRecord, String> {
    enforce_secondary_window_label(window.label())?;
    session_manager.get_projector_display_record(window.label())
}

#[tauri::command]
pub async fn navigate_projector_image(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    image_id: String,
    grant_epoch: u64,
    navigation_generation: u64,
) -> Result<ProjectorDisplayRecord, String> {
    enforce_secondary_window_label(window.label())?;
    session_manager.navigate_projector_image(
        window.label(),
        &image_id,
        grant_epoch,
        navigation_generation,
    )
}

#[tauri::command]
pub async fn close_projector_grant(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
) -> Result<(), String> {
    enforce_secondary_window_label(window.label())?;
    session_manager.revoke_projector_grant("secondary");
    Ok(())
}

#[tauri::command]
pub async fn read_folder_index_by_session(
    _app: tauri::AppHandle,
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    session_id: String,
) -> Result<Vec<ImageFile>, String> {
    enforce_main_window(&window)?;
    let manager = session_manager.inner().clone();
    let refresh_session_id = session_id.clone();
    let label = window.label().to_string();
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        manager.refresh_folder_session(&refresh_session_id, Some(&label))
    })
    .await
    .map_err(|err| format!("Folder session refresh worker failed: {err}"))??;
    Ok(snapshot
        .images
        .into_iter()
        .map(|authorized| ImageFile {
            id: Some(authorized.id),
            session_id: Some(session_id.clone()),
            path: authorized.path,
            file_name: authorized.file_name,
            extension: authorized.extension,
            size_bytes: authorized.size_bytes,
            modified_at: authorized.modified_at,
            created_at: authorized.created_at,
        })
        .collect())
}

#[tauri::command]
pub async fn get_image_caption_by_id(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    session_id: String,
    image_id: String,
) -> Result<Option<ImageCaption>, String> {
    enforce_main_window(&window)?;
    let source_lease = session_manager.lease_image(&session_id, &image_id, Some(window.label()))?;
    let folder = source_lease
        .path()
        .parent()
        .ok_or_else(|| "Authorized caption source has no parent folder".to_string())?
        .to_path_buf();
    let sidecars =
        session_manager.lease_caption_sidecars(&session_id, &image_id, Some(window.label()))?;
    tauri::async_runtime::spawn_blocking(move || {
        source_lease.revalidate()?;
        let result = get_image_caption_from_authorized_sidecars(&folder, sidecars);
        source_lease.revalidate()?;
        result
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn is_dir_by_grant(
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    grant_id: String,
) -> Result<bool, String> {
    enforce_main_window(&window)?;
    let lease = session_manager.lease_destination_grant(&grant_id, Some(window.label()))?;
    lease.revalidate()?;
    Ok(lease.path().is_dir())
}

/// Extract EXIF metadata from an image.
#[cfg(test)]
pub use crate::image_metadata::get_exif_metadata_blocking;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destination_transaction_retries_failed_rollback_on_drop_and_runs_on_unwind() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let attempts = Arc::new(AtomicUsize::new(0));
        {
            let attempts_for_rollback = Arc::clone(&attempts);
            let mut transaction = DestinationPublicationTransaction::new(move |_| {
                if attempts_for_rollback.fetch_add(1, Ordering::SeqCst) == 0 {
                    Err("injected rollback failure".into())
                } else {
                    Ok(())
                }
            });
            assert!(transaction
                .mutate::<()>("injected mutation", || Err("failure".into()))
                .is_err());
            assert_eq!(attempts.load(Ordering::SeqCst), 1);
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 2);

        let unwind_attempts = Arc::new(AtomicUsize::new(0));
        let captured = Arc::clone(&unwind_attempts);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let mut transaction = DestinationPublicationTransaction::new(move |_| {
                captured.fetch_add(1, Ordering::SeqCst);
                Ok(())
            });
            transaction.mutate("armed mutation", || Ok(())).unwrap();
            panic!("injected unwind");
        }));
        assert!(result.is_err());
        assert_eq!(unwind_attempts.load(Ordering::SeqCst), 1);
    }
    use image::GenericImageView;
    use libjpeg_turbo_rs::{compress, PixelFormat, Subsampling};
    use std::fs::File;
    use tempfile::tempdir;

    fn test_source_metadata(path: &Path) -> thumbnails::SourceMetadata {
        thumbnails::resolve_source_metadata(path, None, None).unwrap()
    }

    #[cfg(windows)]
    fn create_test_escape_link(target: &Path, link: &Path) -> Result<(), String> {
        let output = std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target)
            .output()
            .map_err(|error| format!("failed to invoke mklink: {error}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "failed to create test junction: {}",
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    }

    #[cfg(not(windows))]
    fn create_test_escape_link(target: &Path, link: &Path) -> Result<(), String> {
        std::os::unix::fs::symlink(target, link).map_err(|error| error.to_string())
    }

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
    fn authorized_folder_copy_never_overwrites_raced_destination_collision() {
        let root = tempdir().unwrap();
        let source_dir = root.path().join("source");
        let destination_dir = root.path().join("destination");
        fs::create_dir(&source_dir).unwrap();
        fs::create_dir(&destination_dir).unwrap();
        let source_path = source_dir.join("photo.jpg");
        fs::write(&source_path, b"authorized-source").unwrap();
        let manager = crate::authority::SessionManager::new();
        let session = manager.open_folder_session(&source_dir, Some("main")).unwrap();
        let source =
            manager.lease_image(&session.session_id, &session.images[0].id, Some("main")).unwrap();
        let grant = manager.grant_destination(&destination_dir, Some("main")).unwrap();
        let destination = manager.lease_destination_grant(&grant, Some("main")).unwrap();
        let inserted = std::cell::Cell::new(false);

        let copied = copy_authorized_image_to_folder_blocking_with_hook(
            &source_path,
            source.try_clone_file().unwrap(),
            &destination,
            |candidate| {
                if !inserted.replace(true) {
                    fs::write(candidate, b"raced-sentinel").map_err(|error| error.to_string())?;
                }
                Ok(())
            },
            CopyFailurePoint::None,
        )
        .unwrap();

        assert_eq!(fs::read(destination_dir.join("photo.jpg")).unwrap(), b"raced-sentinel");
        assert_eq!(fs::read(copied).unwrap(), b"authorized-source");
        assert!(fs::read_dir(&destination_dir)
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry.file_name().to_string_lossy().starts_with(".copy_")));
    }

    #[test]
    fn authorized_folder_copy_failures_leave_no_staging_residue() {
        for failure in [
            CopyFailurePoint::DuringCopy,
            CopyFailurePoint::DuringFlush,
            CopyFailurePoint::DuringPublication,
        ] {
            let root = tempdir().unwrap();
            let source_dir = root.path().join("source");
            let destination_dir = root.path().join("destination");
            fs::create_dir(&source_dir).unwrap();
            fs::create_dir(&destination_dir).unwrap();
            let source_path = source_dir.join("photo.jpg");
            fs::write(&source_path, b"authorized-source").unwrap();
            fs::write(destination_dir.join("existing.jpg"), b"existing-destination").unwrap();
            let manager = crate::authority::SessionManager::new();
            let session = manager.open_folder_session(&source_dir, Some("main")).unwrap();
            let source = manager
                .lease_image(&session.session_id, &session.images[0].id, Some("main"))
                .unwrap();
            let grant = manager.grant_destination(&destination_dir, Some("main")).unwrap();
            let destination = manager.lease_destination_grant(&grant, Some("main")).unwrap();

            copy_authorized_image_to_folder_blocking_with_hook(
                &source_path,
                source.try_clone_file().unwrap(),
                &destination,
                |_| Ok(()),
                failure,
            )
            .unwrap_err();
            assert_eq!(
                fs::read(destination_dir.join("existing.jpg")).unwrap(),
                b"existing-destination"
            );
            assert!(fs::read_dir(&destination_dir)
                .unwrap()
                .filter_map(Result::ok)
                .all(|entry| !entry.file_name().to_string_lossy().starts_with(".copy_")));
        }
    }

    #[test]
    fn authorized_folder_copy_hook_failure_leaves_no_staging_residue() {
        let root = tempdir().unwrap();
        let source_dir = root.path().join("source");
        let destination_dir = root.path().join("destination");
        fs::create_dir(&source_dir).unwrap();
        fs::create_dir(&destination_dir).unwrap();
        let source_path = source_dir.join("photo.jpg");
        fs::write(&source_path, b"authorized-source").unwrap();
        let manager = crate::authority::SessionManager::new();
        let session = manager.open_folder_session(&source_dir, Some("main")).unwrap();
        let source =
            manager.lease_image(&session.session_id, &session.images[0].id, Some("main")).unwrap();
        let grant = manager.grant_destination(&destination_dir, Some("main")).unwrap();
        let destination = manager.lease_destination_grant(&grant, Some("main")).unwrap();

        copy_authorized_image_to_folder_blocking_with_hook(
            &source_path,
            source.try_clone_file().unwrap(),
            &destination,
            |_| Err("injected copy hook failure".into()),
            CopyFailurePoint::None,
        )
        .unwrap_err();
        assert!(fs::read_dir(&destination_dir)
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry.file_name().to_string_lossy().starts_with(".copy_")));
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
                    id: None,
                    session_id: None,
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
                    id: None,
                    session_id: None,
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
    fn rotation_cancellation_at_post_decode_barrier_never_replaces_source() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("cancel-rotate.png");
        image::RgbaImage::from_pixel(40, 20, image::Rgba([10, 20, 30, 255]))
            .save(&image_path)
            .unwrap();
        let before = fs::read(&image_path).unwrap();
        let mut reached_commit = false;

        let error = save_rotated_image_blocking_with_commit_guard(
            image_path.to_string_lossy().to_string(),
            90,
            &mut || {
                reached_commit = true;
                Err("canceled at commit barrier".into())
            },
        )
        .unwrap_err();

        assert!(reached_commit);
        assert!(error.contains("canceled at commit barrier"));
        assert_eq!(fs::read(&image_path).unwrap(), before);
    }

    #[test]
    fn production_rotation_publishes_from_the_readable_rewound_exact_handle() {
        use std::io::{Read, Seek};
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("rotate.png");
        let snapshot_path = dir.path().join("rotate-source.png");
        image::RgbaImage::from_pixel(40, 20, image::Rgba([10, 20, 30, 255]))
            .save(&image_path)
            .unwrap();
        fs::copy(&image_path, &snapshot_path).unwrap();
        let manager = crate::authority::SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let record =
            session.images.iter().find(|image| image.path.ends_with("rotate.png")).unwrap();
        let mut lease =
            Some(manager.lease_image(&session.session_id, &record.id, Some("main")).unwrap());

        save_rotated_image_from_source_with_publisher(
            snapshot_path.to_string_lossy().to_string(),
            image_path.to_string_lossy().to_string(),
            90,
            &mut |path, mut prepared| {
                assert_eq!(prepared.stream_position().unwrap(), 0);
                let mut signature = [0_u8; 8];
                prepared.read_exact(&mut signature).unwrap();
                assert_eq!(&signature, b"\x89PNG\r\n\x1a\n");
                prepared.seek(std::io::SeekFrom::Start(0)).unwrap();
                lease.take().unwrap().replace_contents_from_pinned(path, prepared)
            },
        )
        .unwrap();
        assert_eq!(image::open(image_path).unwrap().dimensions(), (20, 40));
    }

    #[test]
    fn prepared_image_read_seek_and_sync_failures_leave_original_untouched() {
        use std::io::Write;
        let dir = tempdir().unwrap();
        let original = dir.path().join("original.png");
        fs::write(&original, b"original-sentinel").unwrap();
        for failure in [
            StagingPreparationFailure::Read,
            StagingPreparationFailure::Seek,
            StagingPreparationFailure::Sync,
        ] {
            let staging = dir.path().join(format!("prepared-{failure:?}.png"));
            let mut handle = create_secured_staging_file(&staging).unwrap();
            handle.write_all(b"prepared-image").unwrap();
            assert!(
                prepare_staging_for_publication_with_failure(&mut handle, Some(failure)).is_err()
            );
            assert_eq!(fs::read(&original).unwrap(), b"original-sentinel");
        }
    }

    #[test]
    fn production_rotation_publication_failure_keeps_original_bytes() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("rotate.png");
        let snapshot_path = dir.path().join("rotate-source.png");
        image::RgbaImage::from_pixel(40, 20, image::Rgba([10, 20, 30, 255]))
            .save(&image_path)
            .unwrap();
        fs::copy(&image_path, &snapshot_path).unwrap();
        let original = fs::read(&image_path).unwrap();

        let error = save_rotated_image_from_source_with_publisher(
            snapshot_path.to_string_lossy().to_string(),
            image_path.to_string_lossy().to_string(),
            90,
            &mut |_path, mut prepared| {
                use std::io::Read;
                let mut byte = [0_u8; 1];
                prepared.read_exact(&mut byte).unwrap();
                Err("injected exact-handle publication failure".into())
            },
        )
        .unwrap_err();
        assert!(error.contains("publication failure"));
        assert_eq!(fs::read(image_path).unwrap(), original);
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
            image_path.to_string_lossy().to_string(),
            test_source_metadata(&image_path),
            2048,
            None,
            cache_dir,
            None,
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
            image_path.to_string_lossy().to_string(),
            test_source_metadata(&image_path),
            2048,
            None,
            cache_dir,
            None,
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
            image_path.to_string_lossy().to_string(),
            test_source_metadata(&image_path),
            640,
            480,
            256,
            2,
            1,
            cache_dir,
            None,
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
            image_path.to_string_lossy().to_string(),
            test_source_metadata(&image_path),
            640,
            480,
            256,
            3,
            1,
            cache_dir,
            None,
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
            image_path.to_string_lossy().to_string(),
            test_source_metadata(&image_path),
            800,
            480,
            256,
            0,
            0,
            cache_dir,
            None,
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
    fn scaled_export_rejects_oversized_narrow_source_before_full_decode() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("too-wide.png");
        let limits = crate::image_resource_policy::PolicyLimits::for_operation(
            crate::image_resource_policy::OperationClass::ScaledExport,
        );
        image::RgbImage::new(limits.max_single_dimension + 1, 1).save(&source).unwrap();

        let error = preflight_scaled_export_source(&source).unwrap_err();
        assert!(error.contains("Scaled-export source rejected"));
        assert!(error.contains("Dimension"));
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
    fn crop_overwrite_cancellation_at_post_decode_barrier_never_replaces_source() {
        let dir = tempdir().unwrap();
        let input_path = dir.path().join("cancel-crop.png");
        image::RgbaImage::from_pixel(120, 90, image::Rgba([10, 20, 30, 255]))
            .save(&input_path)
            .unwrap();
        let before = fs::read(&input_path).unwrap();
        let mut reached_commit = false;

        let error = overwrite_with_crop_blocking_with_commit_guard(
            input_path.to_string_lossy().to_string(),
            CropRect { x: 10, y: 15, width: 50, height: 40 },
            None,
            &mut || {
                reached_commit = true;
                Err("canceled at commit barrier".into())
            },
        )
        .unwrap_err();

        assert!(reached_commit);
        assert!(error.contains("canceled at commit barrier"));
        assert_eq!(fs::read(&input_path).unwrap(), before);
    }

    #[test]
    fn production_crop_publishes_from_the_readable_rewound_exact_handle() {
        use std::io::{Read, Seek};
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("crop.png");
        let snapshot_path = dir.path().join("crop-source.png");
        image::RgbaImage::from_pixel(120, 90, image::Rgba([10, 20, 30, 255]))
            .save(&image_path)
            .unwrap();
        fs::copy(&image_path, &snapshot_path).unwrap();
        let manager = crate::authority::SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let record = session.images.iter().find(|image| image.path.ends_with("crop.png")).unwrap();
        let mut lease =
            Some(manager.lease_image(&session.session_id, &record.id, Some("main")).unwrap());

        overwrite_with_crop_from_source_with_publisher(
            snapshot_path.to_string_lossy().to_string(),
            image_path.to_string_lossy().to_string(),
            CropRect { x: 10, y: 15, width: 50, height: 40 },
            None,
            &mut |path, mut prepared| {
                assert_eq!(prepared.stream_position().unwrap(), 0);
                let mut signature = [0_u8; 8];
                prepared.read_exact(&mut signature).unwrap();
                assert_eq!(&signature, b"\x89PNG\r\n\x1a\n");
                prepared.seek(std::io::SeekFrom::Start(0)).unwrap();
                lease.take().unwrap().replace_contents_from_pinned(path, prepared)
            },
        )
        .unwrap();
        assert_eq!(image::open(image_path).unwrap().dimensions(), (50, 40));
    }

    #[test]
    fn production_crop_publication_failure_keeps_original_bytes() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("crop.png");
        let snapshot_path = dir.path().join("crop-source.png");
        image::RgbaImage::from_pixel(120, 90, image::Rgba([10, 20, 30, 255]))
            .save(&image_path)
            .unwrap();
        fs::copy(&image_path, &snapshot_path).unwrap();
        let original = fs::read(&image_path).unwrap();

        let error = overwrite_with_crop_from_source_with_publisher(
            snapshot_path.to_string_lossy().to_string(),
            image_path.to_string_lossy().to_string(),
            CropRect { x: 10, y: 15, width: 50, height: 40 },
            None,
            &mut |_path, mut prepared| {
                use std::io::Read;
                let mut byte = [0_u8; 1];
                prepared.read_exact(&mut byte).unwrap();
                Err("injected exact-handle publication failure".into())
            },
        )
        .unwrap_err();
        assert!(error.contains("publication failure"));
        assert_eq!(fs::read(image_path).unwrap(), original);
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
        assert!(res.is_ok(), "Normal exact destination publication failed: {:?}", res.err());
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

        // 3. Truncated XMP returns an error from remove_exif_from_xmp
        let truncated_xmp =
            b"<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF><rdf:Description attr=\"unclosed";
        assert!(little_exif::xmp::remove_exif_from_xmp(truncated_xmp).is_err());

        // 4. Malformed XML attribute tag returns an error
        let malformed_attr_xmp =
            b"<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF><rdf:Description attr=malformed></rdf:RDF></x:xmpmeta>";
        assert!(little_exif::xmp::remove_exif_from_xmp(malformed_attr_xmp).is_err());

        // 5. Valid EXIF orientation 3 + XMP packet - assert EXIF orientation is rewritten to 1 and XMP is preserved
        let valid_xmp = b"<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description custom:Title=\"TestImage\"/></rdf:RDF></x:xmpmeta>";
        let png_bytes = create_dummy_png_with_itxt_xmp(valid_xmp);
        let png_valid = dir.path().join("valid_exif_xmp.png");
        fs::write(&png_valid, &png_bytes).unwrap();
        let mut meta_in = Metadata::new();
        meta_in.set_tag(ExifTag::Orientation(vec![3]));
        let _ = meta_in.write_to_file(&png_valid);

        let out_valid = dir.path().join("out_valid.png");
        let res_valid = restore_normal_orientation(&png_valid, &out_valid, "test");
        assert!(res_valid.is_ok());
        assert!(out_valid.exists());

        let out_meta = Metadata::new_from_path(&out_valid).unwrap();
        let orientation_tag = out_meta.get_tag(&ExifTag::Orientation(vec![])).next();
        assert!(orientation_tag.is_some(), "EXIF orientation tag must exist in output");
        if let ExifTag::Orientation(values) = orientation_tag.unwrap() {
            assert_eq!(values[0], 1, "EXIF orientation must be rewritten to 1");
        } else {
            panic!("Expected ExifTag::Orientation tag in output");
        }

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
            image_path.to_string_lossy().to_string(),
            test_source_metadata(&image_path),
            0,
            None,
            dir.path().to_path_buf(),
            None,
        )
        .unwrap_err();
        assert!(err_zero.contains("greater than zero"));

        // 2. Excessive max_dimension (> 8192)
        let err_huge = get_preview_image_blocking(
            image_path.to_string_lossy().to_string(),
            image_path.to_string_lossy().to_string(),
            test_source_metadata(&image_path),
            65_535,
            None,
            dir.path().to_path_buf(),
            None,
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

        // IDAT chunk (1x1 red pixel zlib stream)
        let idat_data = [0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00];
        append_png_chunk(&mut png, b"IDAT", &idat_data);

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

    #[test]
    fn test_destination_containment_revalidates_and_rejects_symlink_swaps() {
        let dir = tempfile::tempdir().unwrap();
        let target_file = dir.path().join("normal_output.jpg");
        fs::write(&target_file, b"data").unwrap();

        revalidate_created_file_containment(&target_file, dir.path()).unwrap();

        let outside_dir = tempfile::tempdir().unwrap();
        let outside_file = outside_dir.path().join("outside.jpg");
        fs::write(&outside_file, b"outside").unwrap();

        assert!(revalidate_created_file_containment(&target_file, outside_dir.path()).is_err());
    }

    #[test]
    fn test_resolve_and_contain_destination_file_pre_creation_and_traversal() {
        let mgr = crate::authority::SessionManager::new();
        let dir = tempfile::tempdir().unwrap();
        let grant_id = mgr.grant_destination(dir.path(), Some("main")).unwrap();

        // 1. Non-existent file pre-creation passes validation
        let res =
            resolve_and_contain_destination_file(&mgr, &grant_id, "new_export.jpg", Some("main"));
        assert!(res.is_ok());
        assert_eq!(res.unwrap(), dir.path().join("new_export.jpg"));

        // 2. Traversal attempts with '..' or path separators are rejected
        assert!(resolve_and_contain_destination_file(
            &mgr,
            &grant_id,
            "../escape.jpg",
            Some("main")
        )
        .is_err());
        assert!(resolve_and_contain_destination_file(&mgr, &grant_id, "sub/dir.jpg", Some("main"))
            .is_err());
        assert!(resolve_and_contain_destination_file(
            &mgr,
            &grant_id,
            "sub\\dir.jpg",
            Some("main")
        )
        .is_err());
        drop(mgr);
    }

    #[test]
    fn test_destination_containment_detects_real_toctou_symlink_swap_and_preserves_sentinel() {
        let mgr = crate::authority::SessionManager::new();
        let dir = tempfile::tempdir().unwrap();
        let outside_dir = tempfile::tempdir().unwrap();
        let rel_name = "lightframe-diagnostics-export.json";
        let (grant_id, _) = mgr
            .grant_exact_destination(&dir.path().join(rel_name), "test-export", Some("main"))
            .unwrap();
        let outside_sentinel = outside_dir.path().join("secret.txt");
        let initial_secret = b"ORIGINAL_OUTSIDE_SECRET_DATA_UNCHANGED";
        fs::write(&outside_sentinel, initial_secret).unwrap();

        let target_path = dir.path().join(rel_name);
        create_test_escape_link(outside_dir.path(), &target_path).unwrap();
        {
            let res = stage_and_publish_destination_file(
                &mgr,
                &grant_id,
                rel_name,
                "test-export",
                Some("main"),
                |_staging_file, staging_path| {
                    fs::write(staging_path, b"MALICIOUS_OVERWRITE_PAYLOAD")
                        .map_err(|e| format!("Write failed: {}", e))
                },
            );

            assert!(
                res.is_err(),
                "Staging publish MUST fail when target path is a symlink/junction!"
            );
            let current_sentinel = fs::read(&outside_sentinel).unwrap();
            assert_eq!(
                current_sentinel, initial_secret,
                "Outside sentinel file MUST remain 100% UNCHANGED by export attempt!"
            );
        }
        fs::remove_dir(&target_path).unwrap();
        drop(mgr);
    }

    #[test]
    fn test_stage_and_publish_destination_file_jpeg_png_crop_scale_and_replacement() {
        let mgr = crate::authority::SessionManager::new();
        let dir = tempfile::tempdir().unwrap();
        // 1. JPEG crop export with real image encoder
        let source_jpeg_bytes = make_test_jpeg(100, 100, Subsampling::S420);
        let src_jpg = dir.path().join("source.jpg");
        fs::write(&src_jpg, &source_jpeg_bytes).unwrap();

        let crop = CropRect { x: 10, y: 10, width: 50, height: 50 };

        let (crop_grant, _) = mgr
            .grant_exact_destination(&dir.path().join("cropped.jpg"), "test-crop", Some("main"))
            .unwrap();
        let cropped_jpg = stage_and_publish_destination_file(
            &mgr,
            &crop_grant,
            "cropped.jpg",
            "test-crop",
            Some("main"),
            |staging_file, staging_path| {
                save_cropped_copy_to_file_blocking(
                    src_jpg.to_string_lossy().to_string(),
                    crop,
                    staging_file,
                    staging_path.to_string_lossy().to_string(),
                    None,
                )
            },
        );
        assert!(
            cropped_jpg.is_ok(),
            "JPEG crop with atomic staging failed: {:?}",
            cropped_jpg.err()
        );
        assert!(dir.path().join("cropped.jpg").is_file());

        // 2. Existing output file replacement test
        let (replace_grant, _) = mgr
            .grant_exact_destination(&dir.path().join("cropped.jpg"), "test-crop", Some("main"))
            .unwrap();
        let replaced_jpg = stage_and_publish_destination_file(
            &mgr,
            &replace_grant,
            "cropped.jpg",
            "test-crop",
            Some("main"),
            |staging_file, staging_path| {
                save_cropped_copy_to_file_blocking(
                    src_jpg.to_string_lossy().to_string(),
                    crop,
                    staging_file,
                    staging_path.to_string_lossy().to_string(),
                    None,
                )
            },
        );
        assert!(
            replaced_jpg.is_ok(),
            "Replacing existing output file failed: {:?}",
            replaced_jpg.err()
        );

        // 3. PNG scale export with real image encoder
        let png_img = image::DynamicImage::ImageRgb8(image::RgbImage::new(100, 100));
        let src_png = dir.path().join("source.png");
        png_img.save_with_format(&src_png, image::ImageFormat::Png).unwrap();

        let (scale_grant, _) = mgr
            .grant_exact_destination(&dir.path().join("scaled.png"), "test-scale", Some("main"))
            .unwrap();
        let scaled_png = stage_and_publish_destination_file(
            &mgr,
            &scale_grant,
            "scaled.png",
            "test-scale",
            Some("main"),
            |staging_file, staging_path| {
                save_scaled_copy_to_file_blocking(
                    src_png.to_string_lossy().to_string(),
                    staging_file,
                    staging_path.to_string_lossy().to_string(),
                    40,
                    40,
                    0.0,
                    0.0,
                )
            },
        );
        assert!(scaled_png.is_ok(), "PNG scale with atomic staging failed: {:?}", scaled_png.err());
        assert!(dir.path().join("scaled.png").is_file());

        // 4. Staging file cleanup test on failure
        let (failed_grant, _) = mgr
            .grant_exact_destination(&dir.path().join("failed.jpg"), "test-failure", Some("main"))
            .unwrap();
        let failed_res = stage_and_publish_destination_file(
            &mgr,
            &failed_grant,
            "failed.jpg",
            "test-failure",
            Some("main"),
            |_staging_file, _staging_path| Err("Simulated write failure".to_string()),
        );
        assert!(failed_res.is_err());
        let staging_leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(".staging_"))
            .collect();
        assert!(staging_leftovers.is_empty(), "Staging temp files must be cleaned up on failure");
        drop(mgr);
    }

    #[test]
    fn test_stage_and_publish_destination_file_rejects_precreated_staging_symlink_or_file() {
        let mgr = crate::authority::SessionManager::new();
        let dir = tempfile::tempdir().unwrap();
        let outside_dir = tempfile::tempdir().unwrap();
        let rel_name = "test_race.jpg";
        let outside_sentinel = outside_dir.path().join("sentinel.txt");
        let initial_secret = b"OUTSIDE_SECRET_MUST_NOT_BE_MUTATED";
        fs::write(&outside_sentinel, initial_secret).unwrap();

        // 1. Normal publication writes output file and leaves sentinel untouched
        let (grant_id, _) = mgr
            .grant_exact_destination(&dir.path().join(rel_name), "test-export", Some("main"))
            .unwrap();
        let res = stage_and_publish_destination_file(
            &mgr,
            &grant_id,
            rel_name,
            "test-export",
            Some("main"),
            |file, _path| {
                use std::io::Write;
                file.write_all(b"VALID_IMAGE_DATA").map_err(|e| e.to_string())
            },
        );
        assert!(res.is_ok(), "Normal exact destination publication failed: {:?}", res.err());
        assert_eq!(fs::read(&outside_sentinel).unwrap(), initial_secret);

        // 2. Pre-created symlink target path is rejected before creation
        let symlink_rel = "symlink_target.jpg";
        let symlink_path = dir.path().join(symlink_rel);
        create_test_escape_link(outside_dir.path(), &symlink_path).unwrap();
        {
            let (symlink_grant, _) = mgr
                .grant_exact_destination(&dir.path().join(symlink_rel), "test-export", Some("main"))
                .unwrap();
            let res_sym = stage_and_publish_destination_file(
                &mgr,
                &symlink_grant,
                symlink_rel,
                "test-export",
                Some("main"),
                |file, _path| {
                    use std::io::Write;
                    file.write_all(b"MALICIOUS_OVERWRITE").map_err(|e| e.to_string())
                },
            );
            assert!(res_sym.is_err());
            assert_eq!(fs::read(&outside_sentinel).unwrap(), initial_secret);
        }
        fs::remove_dir(&symlink_path).unwrap();
        drop(mgr);
    }

    #[test]
    fn exact_destination_panic_reports_consumed_and_cleans_staging_while_precancel_retains_grant() {
        let manager = crate::authority::SessionManager::new();
        let directory = tempfile::tempdir().unwrap();
        let (panic_grant, _) = manager
            .grant_exact_destination(
                &directory.path().join("panic.jpg"),
                "test-export",
                Some("main"),
            )
            .unwrap();
        let consumed = AtomicBool::new(false);
        let panic_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = stage_and_publish_destination_file_with_cancellation(
                &manager,
                &panic_grant,
                "panic.jpg",
                "test-export",
                Some("main"),
                None,
                Some(&consumed),
                |_file, _path| panic!("injected encoder panic after grant consumption"),
            );
        }));
        assert!(panic_result.is_err());
        assert!(consumed.load(Ordering::SeqCst));
        assert!(fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry.file_name().to_string_lossy().starts_with(".staging_")));
        assert!(
            manager
                .consume_exact_destination_grant(
                    &panic_grant,
                    "panic.jpg",
                    "test-export",
                    Some("main"),
                )
                .is_err()
        );

        let (cancel_grant, _) = manager
            .grant_exact_destination(
                &directory.path().join("canceled.jpg"),
                "test-export",
                Some("main"),
            )
            .unwrap();
        let token = crate::media_executor::CancellationToken::new();
        assert!(token.cancel());
        let canceled_consumed = AtomicBool::new(false);
        let canceled = stage_and_publish_destination_file_with_cancellation(
            &manager,
            &cancel_grant,
            "canceled.jpg",
            "test-export",
            Some("main"),
            Some(&token),
            Some(&canceled_consumed),
            |_file, _path| Ok(()),
        )
        .unwrap_err();
        assert!(canceled.starts_with("DESTINATION_GRANT_NOT_CONSUMED:"));
        assert!(!canceled_consumed.load(Ordering::SeqCst));
        assert!(manager
            .consume_exact_destination_grant(
                &cancel_grant,
                "canceled.jpg",
                "test-export",
                Some("main"),
            )
            .is_ok());
    }

    #[test]
    fn test_secondary_window_command_isolation_matrix() {
        assert!(enforce_main_window_label("main").is_ok());
        assert!(enforce_main_window_label("secondary").is_err());
        assert!(enforce_main_window_label("projector").is_err());
        assert!(enforce_main_window_label("unknown").is_err());
        let mgr = crate::authority::SessionManager::new();
        let dir = tempfile::tempdir().unwrap();
        let test_img_path = dir.path().join("test.jpg");
        fs::write(&test_img_path, make_test_jpeg(50, 50, Subsampling::S420)).unwrap();

        let session = mgr.open_folder_session(dir.path(), Some("main")).unwrap();

        // 1. Secondary window cannot resolve main-only session folder or image paths
        assert!(mgr.resolve_session_folder(&session.session_id, Some("secondary")).is_err());
        assert!(mgr
            .resolve_image_path(&session.session_id, &session.images[0].id, Some("secondary"))
            .is_err());

        // 2. Stale session ID is denied for main and secondary windows
        assert!(mgr.resolve_session_folder("stale_session_123", Some("main")).is_err());
        assert!(mgr.resolve_session_folder("stale_session_123", Some("secondary")).is_err());

        // 3. Projector grant permits single-image resolution & display record retrieval for secondary window
        mgr.authorize_projector_read(&session.session_id, &session.images[0].id, "secondary");
        assert_eq!(
            mgr.get_projector_grant("secondary"),
            Some((session.session_id.clone(), session.images[0].id.clone()))
        );
        assert!(mgr
            .resolve_image_path(&session.session_id, &session.images[0].id, Some("secondary"))
            .is_ok());

        let proj_rec = mgr.get_projector_display_record("secondary");
        assert!(proj_rec.is_ok());
        let record = proj_rec.unwrap();
        assert_eq!(record.session_id, session.session_id);
        assert_eq!(record.image.id, session.images[0].id);

        // Revoking projector grant clears secondary access
        mgr.revoke_projector_grant("secondary");
        assert_eq!(mgr.get_projector_grant("secondary"), None);
        assert!(mgr
            .resolve_image_path(&session.session_id, &session.images[0].id, Some("secondary"))
            .is_err());
        assert!(mgr.get_projector_display_record("secondary").is_err());
    }
}
