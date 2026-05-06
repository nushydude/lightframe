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

/// Check if a path is a directory
#[tauri::command]
pub fn is_dir(path: String) -> bool {
    Path::new(&path).is_dir()
}

/// Scan a folder for supported image files
#[tauri::command]
pub async fn scan_folder(folder_path: String) -> Result<Vec<ImageFile>, String> {
    let path = Path::new(&folder_path);
    if !path.is_dir() {
        return Err(format!("'{}' is not a valid directory", folder_path));
    }

    let entries = fs::read_dir(path).map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut images: Vec<ImageFile> = Vec::new();

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

        images.push(ImageFile {
            path: file_path.to_string_lossy().to_string(),
            file_name,
            extension,
            size_bytes,
            modified_at,
        });
    }

    // Natural sort by filename
    images.sort_by(|a, b| {
        let key_a = natural_sort_key(&a.file_name);
        let key_b = natural_sort_key(&b.file_name);
        key_a.cmp(&key_b)
    });

    Ok(images)
}

/// Get image metadata (dimensions, format, file size)
#[tauri::command]
pub async fn get_image_metadata(file_path: String) -> Result<ImageMetadata, String> {
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
#[tauri::command]
pub async fn copy_image_to_clipboard(file_path: String) -> Result<(), String> {
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

/// Rotate an image file on disk and save it
#[tauri::command]
pub async fn save_rotated_image(file_path: String, rotation_degrees: i32) -> Result<(), String> {
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

/// Generate a small base64 thumbnail for high-performance navigation
#[tauri::command]
pub async fn get_thumbnail(file_path: String) -> Result<String, String> {
    let path = Path::new(&file_path);

    // Load image and downscale to 160px max (standard thumbnail size)
    // We use thumbnail_exact for speed and specific sizing
    let img = image::open(path).map_err(|e| format!("Failed to open for thumbnail: {}", e))?;
    let thumb = img.thumbnail(160, 160);

    // Write to buffer as JPEG for small transfer size
    let mut buffer = std::io::Cursor::new(Vec::new());
    thumb
        .write_to(&mut buffer, image::ImageFormat::Jpeg)
        .map_err(|e| format!("Failed to encode thumbnail: {}", e))?;

    let base64_str =
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, buffer.into_inner());
    Ok(format!("data:image/jpeg;base64,{}", base64_str))
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
#[tauri::command]
pub async fn get_exif_metadata(file_path: String) -> Result<ExifData, String> {
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

#[cfg(test)]
mod tests {
    use super::*;
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

    #[tokio::test]
    async fn test_scan_folder() {
        let dir = tempdir().unwrap();
        let path = dir.path();

        File::create(path.join("img1.jpg")).unwrap();
        File::create(path.join("img2.png")).unwrap();
        File::create(path.join("not_an_image.txt")).unwrap();
        fs::create_dir(path.join("subdir")).unwrap();

        let results = scan_folder(path.to_string_lossy().to_string()).await.unwrap();

        assert_eq!(results.len(), 2);
        assert!(results.iter().any(|img| img.file_name == "img1.jpg"));
        assert!(results.iter().any(|img| img.file_name == "img2.png"));
    }
}
