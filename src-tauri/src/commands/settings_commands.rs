use super::AppSettings;
use crate::atomic_file::write_text_file_atomically;
use crate::thumbnails;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::{AppHandle, Manager};

static SETTINGS_IO_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir =
        app.path().app_config_dir().map_err(|e| format!("Failed to get config dir: {}", e))?;
    fs::create_dir_all(&config_dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    Ok(config_dir.join("settings.json"))
}

fn lock_settings_io() -> Result<MutexGuard<'static, ()>, String> {
    SETTINGS_IO_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Settings I/O lock poisoned".to_string())
}

/// Read application settings
#[tauri::command]
pub async fn read_settings(app: AppHandle) -> Result<AppSettings, String> {
    let _lock = lock_settings_io()?;
    let path = settings_path(&app)?;
    let settings: AppSettings = if !path.exists() {
        AppSettings::default()
    } else {
        let content =
            fs::read_to_string(&path).map_err(|e| format!("Failed to read settings: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse settings: {}", e))?
    };

    thumbnails::set_tile_source_cache_limit(
        thumbnails::calculate_tile_cache_limit_for_performance_mode(&settings.performance_mode),
    );

    Ok(settings)
}

/// Write application settings
#[tauri::command]
pub async fn write_settings(
    window: tauri::Window,
    app: AppHandle,
    settings: AppSettings,
) -> Result<(), String> {
    super::enforce_main_window(&window)?;
    let _lock = lock_settings_io()?;
    thumbnails::set_tile_source_cache_limit(
        thumbnails::calculate_tile_cache_limit_for_performance_mode(&settings.performance_mode),
    );
    let path = settings_path(&app)?;
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    write_text_file_atomically(&path, &content, "settings")
}
