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

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ImageCurationUpdateById {
    pub image_id: String,
    pub favorite: bool,
    pub rating: i32,
}

#[tauri::command]
pub async fn read_curation_metadata_by_id(
    app: AppHandle,
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    session_id: String,
    image_id: String,
) -> Result<Option<ImageCuration>, String> {
    super::enforce_main_window(&window)?;
    let lease = session_manager.lease_image(&session_id, &image_id, Some(window.label()))?;
    let resolved_path = lease.path().to_path_buf();
    let semantics = lease.path_case_semantics();
    let config_dir = curation_config_dir(&app)?;
    let path = resolved_path.to_string_lossy().to_string();
    let metadata_map = tauri::async_runtime::spawn_blocking(move || {
        curation::read_curation_metadata_for_paths_with_semantics(
            &config_dir,
            std::slice::from_ref(&path),
            semantics,
        )
    })
    .await
    .map_err(|error| format!("Curation read worker failed: {error}"))??;
    Ok(metadata_map.into_values().next())
}

#[tauri::command]
pub async fn read_curation_metadata_for_ids(
    app: AppHandle,
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    session_id: String,
    image_ids: Vec<String>,
) -> Result<HashMap<String, ImageCuration>, String> {
    super::enforce_main_window(&window)?;
    let mut resolved_paths = Vec::new();
    let mut semantics = None;
    for image_id in &image_ids {
        let lease = session_manager.lease_image(&session_id, image_id, Some(window.label()))?;
        semantics.get_or_insert(lease.path_case_semantics());
        resolved_paths.push(lease.path().to_string_lossy().to_string());
    }
    let semantics =
        semantics.unwrap_or_else(crate::path_normalization::runtime_path_case_semantics);
    let config_dir = curation_config_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        curation::read_curation_metadata_for_paths_with_semantics(
            &config_dir,
            &resolved_paths,
            semantics,
        )
    })
    .await
    .map_err(|error| format!("Curation read worker failed: {error}"))?
}

#[tauri::command]
pub async fn write_image_curation_by_id(
    app: AppHandle,
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    session_id: String,
    image_id: String,
    favorite: bool,
    rating: i32,
) -> Result<(), String> {
    super::enforce_main_window(&window)?;
    let lease = session_manager.lease_image(&session_id, &image_id, Some(window.label()))?;
    let path_str = lease.path().to_string_lossy().to_string();
    let semantics = lease.path_case_semantics();

    let _lock = lock_curation_metadata()?;
    let config_dir = curation_config_dir(&app)?;
    curation::write_curation_updates_with_semantics(
        &config_dir,
        vec![ImageCurationUpdate { file_path: path_str, favorite, rating }],
        unix_timestamp_seconds(),
        semantics,
    )
}

#[tauri::command]
pub async fn write_image_curation_batch_by_id(
    app: AppHandle,
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    session_id: String,
    updates: Vec<ImageCurationUpdateById>,
) -> Result<(), String> {
    super::enforce_main_window(&window)?;
    let mut path_updates = Vec::with_capacity(updates.len());
    let mut semantics = None;
    for update in updates {
        let lease =
            session_manager.lease_image(&session_id, &update.image_id, Some(window.label()))?;
        semantics.get_or_insert(lease.path_case_semantics());
        path_updates.push(ImageCurationUpdate {
            file_path: lease.path().to_string_lossy().to_string(),
            favorite: update.favorite,
            rating: update.rating,
        });
    }

    let _lock = lock_curation_metadata()?;
    let config_dir = curation_config_dir(&app)?;
    curation::write_curation_updates_with_semantics(
        &config_dir,
        path_updates,
        unix_timestamp_seconds(),
        semantics.unwrap_or_else(crate::path_normalization::runtime_path_case_semantics),
    )
}

#[tauri::command]
pub async fn clear_image_curation_by_id(
    app: AppHandle,
    window: tauri::Window,
    session_manager: tauri::State<'_, crate::authority::SessionManager>,
    session_id: String,
    image_id: String,
) -> Result<(), String> {
    super::enforce_main_window(&window)?;
    let lease = session_manager.lease_image(&session_id, &image_id, Some(window.label()))?;
    let path_str = lease.path().to_string_lossy().to_string();
    let semantics = lease.path_case_semantics();

    let _lock = lock_curation_metadata()?;
    let config_dir = curation_config_dir(&app)?;
    curation::write_curation_updates_with_semantics(
        &config_dir,
        vec![ImageCurationUpdate { file_path: path_str, favorite: false, rating: 0 }],
        unix_timestamp_seconds(),
        semantics,
    )
}
