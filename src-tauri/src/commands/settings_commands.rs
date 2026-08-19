use super::AppSettings;
use crate::atomic_file::write_text_file_atomically;
use crate::thumbnails;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::{AppHandle, Manager};

static SETTINGS_IO_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const TRUSTED_RECENT_AUTHORITY_FILE: &str = "trusted-recent-authority.json";

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
enum TrustedRecentAuthorityEntry {
    Legacy(String),
    Current { path: String, path_case_semantics: crate::path_normalization::PathCaseSemantics },
}

impl TrustedRecentAuthorityEntry {
    fn path(&self) -> &str {
        match self {
            Self::Legacy(path) | Self::Current { path, .. } => path,
        }
    }

    fn semantics(&self) -> crate::path_normalization::PathCaseSemantics {
        match self {
            Self::Legacy(_) => crate::path_normalization::runtime_path_case_semantics(),
            Self::Current { path_case_semantics, .. } => *path_case_semantics,
        }
    }
}

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

pub(crate) fn read_settings_from_disk(app: &AppHandle) -> Result<AppSettings, String> {
    let _lock = lock_settings_io()?;
    let path = settings_path(app)?;
    if !path.exists() {
        Ok(AppSettings::default())
    } else {
        let content =
            fs::read_to_string(&path).map_err(|e| format!("Failed to read settings: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse settings: {}", e))
    }
}

pub(crate) fn record_trusted_recent_folder(
    app: &AppHandle,
    folder: &std::path::Path,
) -> Result<(), String> {
    let canonical = crate::authority::SessionManager::canonicalize_existing_file(folder)?;
    if !canonical.is_dir() {
        return Err("Trusted recent authority target is not a directory".to_string());
    }
    let _lock = lock_settings_io()?;
    let path = settings_path(app)?.with_file_name(TRUSTED_RECENT_AUTHORITY_FILE);
    let semantics = crate::path_normalization::directory_path_case_semantics_for_path(&canonical)?;
    record_trusted_recent_folder_at_with_semantics(&path, &canonical, semantics)
}

#[cfg(test)]
fn record_trusted_recent_folder_at(
    path: &std::path::Path,
    canonical: &std::path::Path,
) -> Result<(), String> {
    record_trusted_recent_folder_at_with_semantics(
        path,
        canonical,
        crate::path_normalization::runtime_path_case_semantics(),
    )
}

fn record_trusted_recent_folder_at_with_semantics(
    path: &std::path::Path,
    canonical: &std::path::Path,
    semantics: crate::path_normalization::PathCaseSemantics,
) -> Result<(), String> {
    let mut entries: Vec<TrustedRecentAuthorityEntry> = if path.exists() {
        serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let value = canonical.to_string_lossy().to_string();
    let identity =
        crate::path_normalization::normalize_path_text_for_key_with_semantics(&value, semantics);
    entries.retain(|entry| {
        crate::path_normalization::normalize_path_text_for_key_with_semantics(
            entry.path(),
            semantics,
        ) != identity
    });
    entries.insert(
        0,
        TrustedRecentAuthorityEntry::Current { path: value, path_case_semantics: semantics },
    );
    entries.truncate(100);
    let content = serde_json::to_string(&entries).map_err(|error| error.to_string())?;
    write_text_file_atomically(path, &content, "trusted recent authority")
}

pub(crate) fn is_trusted_recent_folder(
    app: &AppHandle,
    folder: &std::path::Path,
) -> Result<bool, String> {
    let canonical = crate::authority::SessionManager::canonicalize_existing_file(folder)?;
    let _lock = lock_settings_io()?;
    let path = settings_path(app)?.with_file_name(TRUSTED_RECENT_AUTHORITY_FILE);
    is_trusted_recent_folder_at(&path, &canonical)
}

fn is_trusted_recent_folder_at(
    path: &std::path::Path,
    canonical: &std::path::Path,
) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let entries: Vec<TrustedRecentAuthorityEntry> =
        serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?)
            .unwrap_or_default();
    Ok(entries.into_iter().any(|entry| {
        crate::authority::SessionManager::canonicalize_existing_file(std::path::Path::new(
            entry.path(),
        ))
        .is_ok_and(|candidate| {
            crate::path_normalization::normalize_path_for_key_with_semantics(
                &candidate,
                entry.semantics(),
            ) == crate::path_normalization::normalize_path_for_key_with_semantics(
                canonical,
                entry.semantics(),
            )
        })
    }))
}

pub(crate) fn trusted_recent_folders(app: &AppHandle) -> Result<Vec<super::RecentFolder>, String> {
    let _lock = lock_settings_io()?;
    let path = settings_path(app)?.with_file_name(TRUSTED_RECENT_AUTHORITY_FILE);
    trusted_recent_folders_at(&path)
}

fn trusted_recent_folders_at(path: &std::path::Path) -> Result<Vec<super::RecentFolder>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let entries: Vec<TrustedRecentAuthorityEntry> =
        serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?)
            .unwrap_or_default();
    let mut trusted = Vec::new();
    for (index, entry) in entries.into_iter().enumerate() {
        let Ok(canonical) = crate::authority::SessionManager::canonicalize_existing_file(
            std::path::Path::new(entry.path()),
        ) else {
            continue;
        };
        if !canonical.is_dir() {
            continue;
        }
        let label = canonical
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| canonical.to_str().unwrap_or("Recent folder"))
            .to_string();
        trusted.push(super::RecentFolder {
            path: canonical.to_string_lossy().to_string(),
            label,
            opened_at: u64::MAX.saturating_sub(index as u64),
        });
    }
    Ok(trusted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_settings_injection_does_not_mint_recent_authority() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("photos");
        fs::create_dir(&folder).unwrap();
        let canonical =
            crate::authority::SessionManager::canonicalize_existing_file(&folder).unwrap();
        let settings = root.path().join("settings.json");
        let authority = root.path().join(TRUSTED_RECENT_AUTHORITY_FILE);
        fs::write(
            &settings,
            serde_json::json!({ "recent_folders": [{ "path": canonical }] }).to_string(),
        )
        .unwrap();

        assert!(!is_trusted_recent_folder_at(&authority, &canonical).unwrap());
        assert!(trusted_recent_folders_at(&authority).unwrap().is_empty());
        record_trusted_recent_folder_at(&authority, &canonical).unwrap();
        assert!(is_trusted_recent_folder_at(&authority, &canonical).unwrap());
        assert_eq!(
            trusted_recent_folders_at(&authority).unwrap()[0].path,
            canonical.to_string_lossy()
        );
        assert!(settings.exists());
    }

    #[test]
    fn recent_authority_dedup_obeys_runtime_path_case_semantics() {
        let root = tempfile::tempdir().unwrap();
        let authority = root.path().join(TRUSTED_RECENT_AUTHORITY_FILE);
        record_trusted_recent_folder_at(&authority, std::path::Path::new("/photos/A")).unwrap();
        record_trusted_recent_folder_at(&authority, std::path::Path::new("/photos/a")).unwrap();
        let entries: Vec<TrustedRecentAuthorityEntry> =
            serde_json::from_str(&fs::read_to_string(authority).unwrap()).unwrap();
        assert_eq!(entries.len(), if cfg!(windows) { 1 } else { 2 });
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectorSettings {
    pub theme: String,
    pub performance_mode: String,
}

/// Read application settings (main window only)
#[tauri::command]
pub async fn read_settings(window: tauri::Window, app: AppHandle) -> Result<AppSettings, String> {
    super::enforce_main_window(&window)?;
    let settings = tauri::async_runtime::spawn_blocking(move || read_settings_from_disk(&app))
        .await
        .map_err(|error| format!("Read settings worker failed: {error}"))??;

    thumbnails::set_tile_source_cache_limit(
        thumbnails::calculate_tile_cache_limit_for_performance_mode(&settings.performance_mode),
    );

    Ok(settings)
}

/// Read projector-safe settings subset (secondary window accessible)
#[tauri::command]
pub async fn read_projector_settings(
    window: tauri::Window,
    app: AppHandle,
) -> Result<ProjectorSettings, String> {
    super::enforce_secondary_window_label(window.label())?;
    let settings: AppSettings = tauri::async_runtime::spawn_blocking(move || {
        let _lock = lock_settings_io()?;
        let path = settings_path(&app)?;
        if !path.exists() {
            Ok::<AppSettings, String>(AppSettings::default())
        } else {
            let content =
                fs::read_to_string(&path).map_err(|e| format!("Failed to read settings: {}", e))?;
            Ok::<AppSettings, String>(serde_json::from_str(&content).unwrap_or_default())
        }
    })
    .await
    .map_err(|error| format!("Read projector settings worker failed: {error}"))??;
    Ok(ProjectorSettings { theme: settings.theme, performance_mode: settings.performance_mode })
}

/// Write application settings
#[tauri::command]
pub async fn write_settings(
    window: tauri::Window,
    app: AppHandle,
    settings: AppSettings,
) -> Result<(), String> {
    super::enforce_main_window(&window)?;
    thumbnails::set_tile_source_cache_limit(
        thumbnails::calculate_tile_cache_limit_for_performance_mode(&settings.performance_mode),
    );
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = lock_settings_io()?;
        let path = settings_path(&app)?;
        let content = serde_json::to_string_pretty(&settings)
            .map_err(|e| format!("Failed to serialize settings: {}", e))?;
        write_text_file_atomically(&path, &content, "settings")
    })
    .await
    .map_err(|error| format!("Write settings worker failed: {error}"))?
}
