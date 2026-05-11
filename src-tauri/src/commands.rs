use crate::thumbnails;
use base64::Engine;
use image::GenericImageView;
use little_exif::exif_tag::ExifTag;
use little_exif::metadata::Metadata;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
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
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
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

    Ok(ImageMetadata { width, height, file_size_bytes, format })
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

/// Move a file to the OS trash / recycle bin
#[tauri::command]
pub async fn move_to_trash(file_path: String) -> Result<(), String> {
    trash::delete(&file_path).map_err(|e| format!("Failed to move file to trash: {}", e))
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

    if !matches!(extension.as_str(), "bmp" | "jpg" | "jpeg" | "png" | "webp") {
        return Err(format!(
            "Saving rotation is not supported for {} files",
            extension.to_uppercase()
        ));
    }

    // Load the image
    let img = image::open(path).map_err(|e| format!("Failed to open image for saving: {}", e))?;

    // Rotate based on degrees
    let rotated = match rotation_degrees % 360 {
        90 | -270 => img.rotate90(),
        180 | -180 => img.rotate180(),
        270 | -90 => img.rotate270(),
        _ => return Ok(()), // No rotation needed
    };

    // For JPEG, PNG, and WebP, try to preserve metadata
    if matches!(extension.as_str(), "jpg" | "jpeg" | "png" | "webp") {
        // Read metadata before overwriting
        let metadata = Metadata::new_from_path(path).ok();

        // Save rotated pixels
        rotated.save(path).map_err(|e| format!("Failed to save rotated image: {}", e))?;

        // Write metadata back if it was successfully read
        if let Some(mut m) = metadata {
            // We physically rotated the pixels, so we must reset orientation tag to 1 (Normal)
            // otherwise software will rotate it a second time.
            m.set_tag(ExifTag::Orientation(vec![1]));
            m.write_to_file(path)
                .map_err(|e| format!("Failed to write image metadata after rotation: {}", e))?;
        }
    } else {
        // For formats like BMP (no metadata), just save
        rotated.save(path).map_err(|e| format!("Failed to save rotated image: {}", e))?;
    }

    Ok(())
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

    cropped.save(output_path_ref).map_err(|e| format!("Failed to save cropped copy: {}", e))?;

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
    use std::fs::File;
    use tempfile::tempdir;

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
    }
}
