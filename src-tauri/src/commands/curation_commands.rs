use crate::curation::{self, ImageCuration, ImageCurationUpdate};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

static CURATION_METADATA_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(crate) fn curation_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir =
        app.path().app_config_dir().map_err(|e| format!("Failed to get config dir: {}", e))?;
    fs::create_dir_all(&config_dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    Ok(config_dir)
}

fn lock_curation_metadata() -> Result<MutexGuard<'static, ()>, String> {
    CURATION_METADATA_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Curation metadata lock poisoned".to_string())
}

fn unix_timestamp_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

#[tauri::command]
pub async fn read_curation_metadata(
    app: AppHandle,
) -> Result<HashMap<String, ImageCuration>, String> {
    let config_dir = curation_config_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || curation::read_curation_metadata(&config_dir))
        .await
        .map_err(|error| format!("Curation read worker failed: {error}"))?
}

#[tauri::command]
pub async fn read_curation_metadata_for_paths(
    app: AppHandle,
    file_paths: Vec<String>,
) -> Result<HashMap<String, ImageCuration>, String> {
    let config_dir = curation_config_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        curation::read_curation_metadata_for_paths(&config_dir, &file_paths)
    })
    .await
    .map_err(|error| format!("Curation read worker failed: {error}"))?
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

    let _lock = lock_curation_metadata()?;
    let config_dir = curation_config_dir(&app)?;
    curation::write_curation_updates(
        &config_dir,
        vec![ImageCurationUpdate { file_path: normalized_path, favorite, rating }],
        unix_timestamp_seconds(),
    )
}

#[tauri::command]
pub async fn write_image_curation_batch(
    app: AppHandle,
    updates: Vec<ImageCurationUpdate>,
) -> Result<(), String> {
    let _lock = lock_curation_metadata()?;
    let config_dir = curation_config_dir(&app)?;
    curation::write_curation_updates(&config_dir, updates, unix_timestamp_seconds())
}

#[tauri::command]
pub async fn clear_image_curation(app: AppHandle, file_path: String) -> Result<(), String> {
    let normalized_path = file_path.trim().to_string();
    if normalized_path.is_empty() {
        return Err("file_path must not be empty".to_string());
    }

    let _lock = lock_curation_metadata()?;
    let config_dir = curation_config_dir(&app)?;
    curation::write_curation_updates(
        &config_dir,
        vec![ImageCurationUpdate { file_path: normalized_path, favorite: false, rating: 0 }],
        unix_timestamp_seconds(),
    )
}
