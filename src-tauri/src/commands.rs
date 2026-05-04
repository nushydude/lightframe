use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Supported image extensions for the viewer
const SUPPORTED_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "tif",
    "heic", "heif", "avif", "svg",
];

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

        let file_name = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        let metadata = entry.metadata().ok();
        let size_bytes = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified_at = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .map(|t| {
                let duration = t
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default();
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

    let file_metadata = fs::metadata(path).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    let file_size_bytes = file_metadata.len();

    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

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
    })
}

/// Get the settings file path
fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
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

    let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read settings: {}", e))?;
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

