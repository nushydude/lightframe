use crate::thumbnails;
use base64::Engine;
use image::GenericImageView;
use libjpeg_turbo_rs::{MarkerCopyMode, TransformOp, TransformOptions};
use little_exif::exif_tag::ExifTag;
use little_exif::metadata::Metadata;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// Supported image extensions for the viewer
const SUPPORTED_EXTENSIONS: &[&str] =
    &["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "tif", "heic", "heif", "avif", "svg"];

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImageFile {
    pub path: String,
    pub file_name: String,
    pub extension: String,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImageMetadata {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub file_size_bytes: u64,
    pub format: String,
    pub browser_renderable: bool,
    pub rust_decode_supported: bool,
    pub metadata_supported: bool,
    pub thumbnail_supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support_note: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

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
    pub loop_slideshow: bool,
    pub shuffle_slideshow: bool,
    pub auto_fullscreen_on_slideshow: bool,
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
    pub sort_order: String,
    #[serde(default = "default_show_thumbnails")]
    pub show_thumbnails: bool,
    #[serde(default)]
    pub quick_destinations: Vec<QuickDestination>,
    #[serde(default)]
    pub external_editor_path: Option<String>,
    #[serde(default)]
    pub external_editor_label: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImageCuration {
    pub path: String,
    pub favorite: bool,
    pub rating: u8,
    pub updated_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct QuickDestination {
    pub id: String,
    pub label: String,
    pub path: String,
}

fn default_show_thumbnails() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            theme: "dark".to_string(),
            slideshow_interval_seconds: 4,
            loop_slideshow: false,
            shuffle_slideshow: false,
            auto_fullscreen_on_slideshow: true,
            mouse_wheel_behavior: "zoom".to_string(),
            default_fit_mode: "fit".to_string(),
            remember_window_bounds: true,
            window_x: None,
            window_y: None,
            window_width: None,
            window_height: None,
            sort_order: "name".to_string(),
            show_thumbnails: default_show_thumbnails(),
            quick_destinations: Vec::new(),
            external_editor_path: None,
            external_editor_label: None,
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
        if !file_path.is_file() {
            continue;
        }

        let extension = file_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();

        if !SUPPORTED_EXTENSIONS.contains(&extension.as_str()) {
            continue;
        }

        let file_name = file_path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();

        let metadata = entry.metadata().ok();
        let size_bytes = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified_at = metadata.as_ref().and_then(|m| m.modified().ok()).map(|t| {
            let duration = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
            format!("{}", duration.as_secs())
        });

        let path = file_path.to_string_lossy().to_string();
        let sort_key = natural_sort_key(&file_name);
        let lowercase_file_name = file_name.to_lowercase();

        images.push(ScannedImage {
            sort_key,
            lowercase_file_name,
            image: ImageFile { path, file_name, extension, size_bytes, modified_at },
        });
    }

    sort_scanned_images(&mut images);

    Ok(images.into_iter().map(|scanned| scanned.image).collect())
}

/// Scan a folder for supported image files
#[tauri::command]
pub async fn scan_folder(folder_path: String) -> Result<Vec<ImageFile>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_folder_blocking(folder_path))
        .await
        .map_err(|err| format!("Scan folder worker failed: {}", err))?
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

    // Try to read image dimensions
    let (width, height) = match image::image_dimensions(path) {
        Ok((w, h)) => (Some(w), Some(h)),
        Err(_) => (None, None),
    };

    let format = match extension.as_str() {
        "jpg" | "jpeg" => "JPEG".to_string(),
        "png" => "PNG".to_string(),
        "webp" => "WebP".to_string(),
        "gif" => "GIF".to_string(),
        "bmp" => "BMP".to_string(),
        "tiff" | "tif" => "TIFF".to_string(),
        "heic" | "heif" => "HEIC".to_string(),
        "avif" => "AVIF".to_string(),
        "svg" => "SVG".to_string(),
        other => other.to_uppercase(),
    };

    Ok(ImageMetadata {
        width,
        height,
        file_size_bytes,
        format,
        browser_renderable: format_support.browser_renderable,
        rust_decode_supported: format_support.rust_decode_supported,
        metadata_supported: format_support.metadata_supported,
        thumbnail_supported: format_support.thumbnail_supported,
        support_note: format_support.support_note.map(str::to_string),
    })
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
        return Ok(());
    }

    if let Ok(mut metadata) = Metadata::new_from_path(source_path) {
        metadata.set_tag(ExifTag::Orientation(vec![1]));
        metadata
            .write_to_file(output_path)
            .map_err(|e| format!("Failed to write image metadata after {}: {}", context, e))?;
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

fn get_preview_image_blocking(file_path: String, max_dimension: u32) -> Result<String, String> {
    if max_dimension == 0 {
        return Err("max_dimension must be greater than zero".to_string());
    }

    let path = Path::new(&file_path);
    if !path.is_file() {
        return Err(format!("'{}' is not a valid file", file_path));
    }

    let img = image::open(path).map_err(|e| format!("Failed to open image for preview: {}", e))?;
    let (width, height) = img.dimensions();
    let preview = if width > max_dimension || height > max_dimension {
        img.resize(max_dimension, max_dimension, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let has_alpha = preview.color().has_alpha();
    let mime_type = if has_alpha { "image/png" } else { "image/jpeg" };

    let mut buffer = std::io::Cursor::new(Vec::new());
    if has_alpha {
        preview
            .write_to(&mut buffer, image::ImageFormat::Png)
            .map_err(|e| format!("Failed to encode preview image: {}", e))?;
    } else {
        image::DynamicImage::ImageRgb8(preview.to_rgb8())
            .write_to(&mut buffer, image::ImageFormat::Jpeg)
            .map_err(|e| format!("Failed to encode preview image: {}", e))?;
    }

    let bytes = buffer.into_inner();
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{};base64,{}", mime_type, encoded))
}

#[tauri::command]
pub async fn get_preview_image(file_path: String, max_dimension: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        get_preview_image_blocking(file_path, max_dimension)
    })
    .await
    .map_err(|err| format!("Preview image worker failed: {}", err))?
}

/// Get the settings file path
fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir =
        app.path().app_config_dir().map_err(|e| format!("Failed to get config dir: {}", e))?;
    fs::create_dir_all(&config_dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    Ok(config_dir.join("settings.json"))
}

fn curation_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir =
        app.path().app_config_dir().map_err(|e| format!("Failed to get config dir: {}", e))?;
    fs::create_dir_all(&config_dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    Ok(config_dir.join("curation.json"))
}

fn clamp_rating(rating: i32) -> u8 {
    rating.clamp(0, 5) as u8
}

fn unix_timestamp_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn normalize_curation_metadata(
    metadata: HashMap<String, ImageCuration>,
) -> HashMap<String, ImageCuration> {
    let mut normalized = HashMap::new();

    for (key, mut value) in metadata {
        let normalized_path = if value.path.trim().is_empty() {
            key.trim().to_string()
        } else {
            value.path.trim().to_string()
        };

        if normalized_path.is_empty() {
            continue;
        }

        value.path = normalized_path.clone();
        value.rating = value.rating.min(5);

        if !value.favorite && value.rating == 0 {
            continue;
        }

        normalized.insert(normalized_path, value);
    }

    normalized
}

fn read_curation_metadata_from_path(path: &Path) -> HashMap<String, ImageCuration> {
    if !path.exists() {
        return HashMap::new();
    }

    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(err) => {
            eprintln!(
                "Failed to read curation metadata from '{}': {}. Falling back to empty state.",
                path.display(),
                err
            );
            return HashMap::new();
        }
    };

    let parsed = match serde_json::from_str::<HashMap<String, ImageCuration>>(&content) {
        Ok(parsed) => parsed,
        Err(err) => {
            eprintln!(
                "Failed to parse curation metadata from '{}': {}. Falling back to empty state.",
                path.display(),
                err
            );
            return HashMap::new();
        }
    };

    normalize_curation_metadata(parsed)
}

fn write_curation_metadata_to_path(
    path: &Path,
    metadata: &HashMap<String, ImageCuration>,
) -> Result<(), String> {
    let content = serde_json::to_string_pretty(metadata)
        .map_err(|e| format!("Failed to serialize curation metadata: {}", e))?;
    fs::write(path, content).map_err(|e| format!("Failed to write curation metadata: {}", e))
}

fn apply_curation_update(
    metadata: &mut HashMap<String, ImageCuration>,
    file_path: String,
    favorite: bool,
    rating: i32,
    updated_at: u64,
) {
    let clamped_rating = clamp_rating(rating);
    if !favorite && clamped_rating == 0 {
        metadata.remove(&file_path);
        return;
    }

    metadata.insert(
        file_path.clone(),
        ImageCuration { path: file_path, favorite, rating: clamped_rating, updated_at },
    );
}

/// Read application settings
#[tauri::command]
pub async fn read_settings(app: AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }

    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read settings: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse settings: {}", e))
}

/// Write application settings
#[tauri::command]
pub async fn write_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let path = settings_path(&app)?;
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write settings: {}", e))
}

#[tauri::command]
pub async fn read_curation_metadata(
    app: AppHandle,
) -> Result<HashMap<String, ImageCuration>, String> {
    let path = curation_path(&app)?;
    Ok(read_curation_metadata_from_path(&path))
}

#[tauri::command]
pub async fn write_image_curation(
    app: AppHandle,
    file_path: String,
    favorite: bool,
    rating: i32,
) -> Result<(), String> {
    let normalized_path = file_path.trim().to_string();
    if normalized_path.is_empty() {
        return Err("file_path must not be empty".to_string());
    }

    let path = curation_path(&app)?;
    let mut metadata = read_curation_metadata_from_path(&path);
    apply_curation_update(
        &mut metadata,
        normalized_path,
        favorite,
        rating,
        unix_timestamp_seconds(),
    );
    write_curation_metadata_to_path(&path, &metadata)
}

#[tauri::command]
pub async fn clear_image_curation(app: AppHandle, file_path: String) -> Result<(), String> {
    let normalized_path = file_path.trim().to_string();
    if normalized_path.is_empty() {
        return Err("file_path must not be empty".to_string());
    }

    let path = curation_path(&app)?;
    let mut metadata = read_curation_metadata_from_path(&path);
    metadata.remove(&normalized_path);
    write_curation_metadata_to_path(&path, &metadata)
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

/// Copy an image file to the OS clipboard
fn copy_image_to_clipboard_blocking(file_path: String) -> Result<(), String> {
    let img = image::open(&file_path).map_err(|e| format!("Failed to open image: {}", e))?;
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

/// Rotate an image file on disk and save it
fn save_rotated_image_blocking(file_path: String, rotation_degrees: i32) -> Result<(), String> {
    let path = Path::new(&file_path);
    if !path.is_file() {
        return Err(format!("'{}' is not a valid file", file_path));
    }

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
pub async fn save_rotated_image(file_path: String, rotation_degrees: i32) -> Result<(), String> {
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

fn build_unique_sibling_path(source_path: &Path, label: &str) -> Result<PathBuf, String> {
    let parent_dir = source_path
        .parent()
        .ok_or_else(|| "Source path must include a parent directory".to_string())?;
    let stem = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Source file name is invalid".to_string())?;
    let extension = source_path.extension().and_then(|value| value.to_str()).unwrap_or("img");
    let unique_suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    let mut attempt = 0_u32;
    loop {
        let candidate = parent_dir
            .join(format!("{}.{}-{}-{}.{}", stem, label, unique_suffix, attempt, extension));
        if !candidate.exists() {
            return Ok(candidate);
        }
        attempt = attempt.saturating_add(1);
    }
}

fn replace_file_safely(temp_path: &Path, destination_path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let backup_path = build_unique_sibling_path(destination_path, "lightframe-backup")?;

        fs::rename(destination_path, &backup_path)
            .map_err(|e| format!("Failed to stage original file for replacement: {}", e))?;

        match fs::rename(temp_path, destination_path) {
            Ok(()) => {
                let _ = fs::remove_file(&backup_path);
                Ok(())
            }
            Err(err) => {
                let _ = fs::rename(&backup_path, destination_path);
                let _ = fs::remove_file(temp_path);
                Err(format!("Failed to replace original image: {}", err))
            }
        }
    }

    #[cfg(not(windows))]
    {
        fs::rename(temp_path, destination_path)
            .map_err(|e| format!("Failed to replace original image: {}", e))
    }
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

/// Generate a small base64 thumbnail for high-performance navigation
fn get_thumbnail_blocking(
    file_path: String,
    size_bytes: Option<u64>,
    modified_at: Option<String>,
    app_cache_dir: PathBuf,
) -> Result<String, String> {
    let path = Path::new(&file_path);
    let metadata = thumbnails::resolve_source_metadata(path, size_bytes, modified_at.as_deref())?;
    let thumbnail_cache_dir = app_cache_dir.join("thumbnails");
    thumbnails::get_or_create_thumbnail(path, &metadata, &thumbnail_cache_dir)
}

/// Generate a small base64 thumbnail for high-performance navigation
#[tauri::command]
pub async fn get_thumbnail(
    app: AppHandle,
    file_path: String,
    size_bytes: Option<u64>,
    modified_at: Option<String>,
) -> Result<String, String> {
    let app_cache_dir =
        app.path().app_cache_dir().map_err(|e| format!("Failed to get app cache dir: {}", e))?;
    tauri::async_runtime::spawn_blocking(move || {
        get_thumbnail_blocking(file_path, size_bytes, modified_at, app_cache_dir)
    })
    .await
    .map_err(|err| format!("Thumbnail worker failed: {}", err))?
}

#[derive(serde::Serialize)]
pub struct ExifData {
    pub make: Option<String>,
    pub model: Option<String>,
    pub software: Option<String>,
    pub date_time: Option<String>,
    pub f_number: Option<f64>,
    pub exposure_time: Option<String>,
    pub iso: Option<u32>,
    pub focal_length: Option<String>,
    pub raw: std::collections::HashMap<String, String>,
}

/// Extract EXIF metadata from an image
fn get_exif_metadata_blocking(file_path: String) -> Result<ExifData, String> {
    let file =
        std::fs::File::open(&file_path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut reader = std::io::BufReader::new(file);
    let exifreader = exif::Reader::new();
    let exif = match exifreader.read_from_container(&mut reader) {
        Ok(e) => e,
        Err(_) => return Err("No EXIF data found".to_string()),
    };

    let mut raw = std::collections::HashMap::new();
    let mut data = ExifData {
        make: None,
        model: None,
        software: None,
        date_time: None,
        f_number: None,
        exposure_time: None,
        iso: None,
        focal_length: None,
        raw: std::collections::HashMap::new(),
    };

    for f in exif.fields() {
        let tag = format!("{}", f.tag);
        let value = f.display_value().with_unit(&exif).to_string();
        raw.insert(tag.clone(), value.clone());

        match f.tag {
            exif::Tag::Make => data.make = Some(value.trim_matches('"').to_string()),
            exif::Tag::Model => data.model = Some(value.trim_matches('"').to_string()),
            exif::Tag::Software => data.software = Some(value.trim_matches('"').to_string()),
            exif::Tag::DateTimeOriginal | exif::Tag::DateTime if data.date_time.is_none() => {
                data.date_time = Some(value);
            }
            exif::Tag::FNumber => {
                if let exif::Value::Rational(ref r) = f.value {
                    if !r.is_empty() {
                        data.f_number = Some(r[0].to_f64());
                    }
                }
            }
            exif::Tag::ExposureTime => data.exposure_time = Some(value),
            exif::Tag::PhotographicSensitivity | exif::Tag::ISOSpeed => {
                if let exif::Value::Short(ref s) = f.value {
                    if !s.is_empty() {
                        data.iso = Some(s[0] as u32);
                    }
                }
            }
            exif::Tag::FocalLength => data.focal_length = Some(value),
            _ => {}
        }
    }

    data.raw = raw;
    Ok(data)
}

/// Extract EXIF metadata from an image
#[tauri::command]
pub async fn get_exif_metadata(file_path: String) -> Result<ExifData, String> {
    tauri::async_runtime::spawn_blocking(move || get_exif_metadata_blocking(file_path))
        .await
        .map_err(|err| format!("EXIF worker failed: {}", err))?
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

    #[test]
    fn test_apply_curation_update_clamps_rating_to_five() {
        let mut metadata = std::collections::HashMap::new();

        apply_curation_update(&mut metadata, "C:/images/photo.jpg".to_string(), true, 9, 42);

        let entry = metadata.get("C:/images/photo.jpg").unwrap();
        assert_eq!(entry.path, "C:/images/photo.jpg");
        assert!(entry.favorite);
        assert_eq!(entry.rating, 5);
        assert_eq!(entry.updated_at, 42);
    }

    #[test]
    fn test_apply_curation_update_removes_default_state_entries() {
        let mut metadata = std::collections::HashMap::new();
        metadata.insert(
            "C:/images/photo.jpg".to_string(),
            ImageCuration {
                path: "C:/images/photo.jpg".to_string(),
                favorite: true,
                rating: 3,
                updated_at: 10,
            },
        );

        apply_curation_update(&mut metadata, "C:/images/photo.jpg".to_string(), false, 0, 44);

        assert!(!metadata.contains_key("C:/images/photo.jpg"));
    }

    #[test]
    fn test_read_curation_metadata_from_path_returns_empty_for_corrupt_json() {
        let dir = tempdir().unwrap();
        let curation_path = dir.path().join("curation.json");
        fs::write(&curation_path, "{not-valid-json").unwrap();

        let metadata = read_curation_metadata_from_path(&curation_path);
        assert!(metadata.is_empty());
    }

    #[test]
    fn test_read_curation_metadata_from_path_normalizes_invalid_entries() {
        let dir = tempdir().unwrap();
        let curation_path = dir.path().join("curation.json");
        fs::write(
            &curation_path,
            r#"{
                "C:/images/one.jpg": {
                    "path": "",
                    "favorite": true,
                    "rating": 7,
                    "updated_at": 1
                },
                "C:/images/two.jpg": {
                    "path": "C:/images/two.jpg",
                    "favorite": false,
                    "rating": 0,
                    "updated_at": 2
                }
            }"#,
        )
        .unwrap();

        let metadata = read_curation_metadata_from_path(&curation_path);
        let one = metadata.get("C:/images/one.jpg").unwrap();
        assert_eq!(one.path, "C:/images/one.jpg");
        assert_eq!(one.rating, 5);
        assert_eq!(metadata.len(), 1);
    }

    #[test]
    fn test_write_curation_metadata_to_path_persists_entries() {
        let dir = tempdir().unwrap();
        let curation_path = dir.path().join("curation.json");
        let mut metadata = std::collections::HashMap::new();
        metadata.insert(
            "C:/images/photo.jpg".to_string(),
            ImageCuration {
                path: "C:/images/photo.jpg".to_string(),
                favorite: true,
                rating: 4,
                updated_at: 77,
            },
        );

        write_curation_metadata_to_path(&curation_path, &metadata).unwrap();

        let reloaded = read_curation_metadata_from_path(&curation_path);
        let entry = reloaded.get("C:/images/photo.jpg").unwrap();
        assert!(entry.favorite);
        assert_eq!(entry.rating, 4);
        assert_eq!(entry.updated_at, 77);
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
        File::create(path.join("no_extension")).unwrap();
        File::create(path.join("not_an_image.txt")).unwrap();
        fs::create_dir(path.join("subdir")).unwrap();

        let results = scan_folder_blocking(path.to_string_lossy().to_string()).unwrap();

        let sorted_names: Vec<&str> = results.iter().map(|img| img.file_name.as_str()).collect();
        assert_eq!(sorted_names, vec!["image1.webp", "image2.png", "image10.jpg"]);
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
        assert_eq!(metadata.file_size_bytes, expected_size);
        assert!(metadata.browser_renderable);
        assert!(metadata.rust_decode_supported);
        assert!(metadata.metadata_supported);
        assert!(metadata.thumbnail_supported);
        assert_eq!(metadata.support_note, None);
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
        assert_eq!(metadata.file_size_bytes, expected_size);
        assert!(metadata.browser_renderable);
        assert!(!metadata.rust_decode_supported);
        assert!(metadata.metadata_supported);
        assert!(metadata.thumbnail_supported);
        assert!(metadata
            .support_note
            .as_deref()
            .unwrap_or_default()
            .contains("placeholder thumbnail"));
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
        }
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

    fn decode_data_url(data_url: &str) -> Vec<u8> {
        let (_, payload) = data_url.split_once(',').unwrap();
        base64::engine::general_purpose::STANDARD.decode(payload).unwrap()
    }

    #[test]
    fn test_get_preview_image_blocking_respects_max_dimension() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("large.jpg");
        image::RgbImage::from_pixel(5000, 3000, image::Rgb([200, 50, 50]))
            .save(&image_path)
            .unwrap();

        let preview_data_url =
            get_preview_image_blocking(image_path.to_string_lossy().to_string(), 2048).unwrap();
        let bytes = decode_data_url(&preview_data_url);
        let preview = image::load_from_memory(&bytes).unwrap();
        let (width, height) = preview.dimensions();

        assert!(
            preview_data_url.starts_with("data:image/jpeg;base64,")
                || preview_data_url.starts_with("data:image/png;base64,")
        );
        assert!(width <= 2048);
        assert!(height <= 2048);
    }

    #[test]
    fn test_get_preview_image_blocking_does_not_upscale_small_images() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("small.png");
        image::RgbaImage::from_pixel(640, 360, image::Rgba([0, 120, 220, 255]))
            .save(&image_path)
            .unwrap();

        let preview_data_url =
            get_preview_image_blocking(image_path.to_string_lossy().to_string(), 2048).unwrap();
        let bytes = decode_data_url(&preview_data_url);
        let preview = image::load_from_memory(&bytes).unwrap();
        let (width, height) = preview.dimensions();

        assert_eq!(width, 640);
        assert_eq!(height, 360);
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
        assert_eq!(settings.external_editor_path, None);
        assert_eq!(settings.external_editor_label, None);
    }
}
