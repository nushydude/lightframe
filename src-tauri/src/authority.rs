use sha2::Digest;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct SessionId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct ImageId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct DestinationGrantId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct ExternalEditorGrantId(pub String);

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AuthorizedImageRecord {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub extension: String,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FolderSessionSnapshot {
    pub session_id: String,
    pub canonical_folder: String,
    pub images: Vec<AuthorizedImageRecord>,
}

#[derive(Debug, Clone)]
pub struct ImageRecordInternal {
    pub id: String,
    pub canonical_path: PathBuf,
    pub display_path: String,
    pub file_name: String,
    pub extension: String,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
    pub created_at: Option<String>,
}

pub struct SessionInternal {
    pub id: String,
    pub canonical_folder: PathBuf,
    pub images_by_id: HashMap<String, ImageRecordInternal>,
    pub created_at_epoch: u64,
}

pub struct DestinationGrantInternal {
    pub id: String,
    pub canonical_folder: PathBuf,
}

pub struct ExternalEditorGrantInternal {
    pub id: String,
    pub canonical_app_path: PathBuf,
}

#[derive(Default)]
pub struct SessionStore {
    pub sessions: HashMap<String, SessionInternal>,
    pub destination_grants: HashMap<String, DestinationGrantInternal>,
    pub external_editor_grants: HashMap<String, ExternalEditorGrantInternal>,
    pub next_counter: u64,
}

#[derive(Clone, Default)]
pub struct SessionManager {
    pub store: Arc<Mutex<SessionStore>>,
}

/// Threat model boundary note:
/// LightFrame's SessionManager encapsulates filesystem authority behind opaque identifiers
/// (SessionId, ImageId, DestinationGrantId, ExternalEditorGrantId).
/// Untrusted renderer IPC calls cannot supply arbitrary raw paths; all privileged image read,
/// edit, move, trash, and launch commands resolve target paths through authorized session state.
impl SessionManager {
    pub fn new() -> Self {
        Self { store: Arc::new(Mutex::new(SessionStore::default())) }
    }

    fn generate_opaque_id(&self, prefix: &str) -> String {
        let mut store = self.store.lock().unwrap();
        store.next_counter = store.next_counter.wrapping_add(1);
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let mut hasher = sha2::Sha256::new();
        hasher.update(prefix.as_bytes());
        hasher.update(nanos.to_le_bytes());
        hasher.update(store.next_counter.to_le_bytes());
        let hash = hasher.finalize();
        format!(
            "{}_{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            prefix, hash[0], hash[1], hash[2], hash[3], hash[4], hash[5], hash[6], hash[7]
        )
    }

    pub fn canonicalize_path(path: &Path) -> Result<PathBuf, String> {
        let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        Ok(normalize_path_buf(&canonical))
    }

    pub fn open_folder_session(&self, folder_path: &Path) -> Result<FolderSessionSnapshot, String> {
        let canonical_folder = Self::canonicalize_path(folder_path)?;
        if !canonical_folder.is_dir() {
            return Err(format!("'{}' is not a valid directory", folder_path.display()));
        }

        let session_id = self.generate_opaque_id("session");
        let mut images_by_id = HashMap::new();
        let mut snapshot_records = Vec::new();

        if let Ok(entries) = fs::read_dir(&canonical_folder) {
            for entry in entries.flatten() {
                let entry_path = entry.path();
                let canonical_entry = Self::canonicalize_path(&entry_path)?;

                // Ensure file is contained in canonical folder
                if !is_path_contained_in(&canonical_entry, &canonical_folder) {
                    continue;
                }

                if is_supported_image_file(&canonical_entry) {
                    let image_id = self.generate_opaque_id("img");
                    let file_name = canonical_entry
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or_default()
                        .to_string();
                    let extension = canonical_entry
                        .extension()
                        .and_then(|s| s.to_str())
                        .map(|s| s.to_lowercase())
                        .unwrap_or_default();

                    let metadata = fs::metadata(&canonical_entry).ok();
                    let size_bytes = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
                    let display_path = canonical_entry.to_string_lossy().to_string();

                    let record_internal = ImageRecordInternal {
                        id: image_id.clone(),
                        canonical_path: canonical_entry.clone(),
                        display_path: display_path.clone(),
                        file_name: file_name.clone(),
                        extension: extension.clone(),
                        size_bytes,
                        modified_at: None,
                        created_at: None,
                    };

                    images_by_id.insert(image_id.clone(), record_internal);

                    snapshot_records.push(AuthorizedImageRecord {
                        id: image_id,
                        path: display_path,
                        file_name,
                        extension,
                        size_bytes,
                        modified_at: None,
                        created_at: None,
                    });
                }
            }
        }

        let session_internal = SessionInternal {
            id: session_id.clone(),
            canonical_folder: canonical_folder.clone(),
            images_by_id,
            created_at_epoch: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        };

        let mut store = self.store.lock().unwrap();
        store.sessions.insert(session_id.clone(), session_internal);

        Ok(FolderSessionSnapshot {
            session_id,
            canonical_folder: canonical_folder.to_string_lossy().to_string(),
            images: snapshot_records,
        })
    }

    pub fn open_file_session(&self, file_path: &Path) -> Result<FolderSessionSnapshot, String> {
        let canonical_file = Self::canonicalize_path(file_path)?;
        if !canonical_file.is_file() {
            return Err(format!("'{}' is not a valid file", file_path.display()));
        }

        let parent_folder =
            canonical_file.parent().ok_or_else(|| "File has no parent directory".to_string())?;

        self.open_folder_session(parent_folder)
    }

    pub fn close_session(&self, session_id: &str) -> Result<(), String> {
        let mut store = self.store.lock().unwrap();
        if store.sessions.remove(session_id).is_some() {
            Ok(())
        } else {
            Err(format!("Session '{}' does not exist or is already closed", session_id))
        }
    }

    pub fn resolve_image_path(&self, session_id: &str, image_id: &str) -> Result<PathBuf, String> {
        let store = self.store.lock().unwrap();
        let session = store
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session '{}' is invalid or expired", session_id))?;

        let record = session
            .images_by_id
            .get(image_id)
            .ok_or_else(|| format!("ImageId '{}' is not authorized in session", image_id))?;

        Ok(record.canonical_path.clone())
    }

    pub fn grant_destination(&self, folder_path: &Path) -> Result<String, String> {
        let canonical = Self::canonicalize_path(folder_path)?;
        if !canonical.is_dir() {
            return Err(format!("'{}' is not a valid directory", folder_path.display()));
        }
        let grant_id = self.generate_opaque_id("dest");
        let grant = DestinationGrantInternal { id: grant_id.clone(), canonical_folder: canonical };
        let mut store = self.store.lock().unwrap();
        store.destination_grants.insert(grant_id.clone(), grant);
        Ok(grant_id)
    }

    pub fn resolve_destination_grant(&self, grant_id: &str) -> Result<PathBuf, String> {
        let store = self.store.lock().unwrap();
        let grant = store
            .destination_grants
            .get(grant_id)
            .ok_or_else(|| format!("Destination grant '{}' is invalid", grant_id))?;
        Ok(grant.canonical_folder.clone())
    }

    pub fn grant_external_editor(&self, app_path: &Path) -> Result<String, String> {
        let canonical = Self::canonicalize_path(app_path)?;
        if !canonical.is_file() {
            return Err(format!("'{}' is not a valid executable file", app_path.display()));
        }
        let grant_id = self.generate_opaque_id("editor");
        let grant =
            ExternalEditorGrantInternal { id: grant_id.clone(), canonical_app_path: canonical };
        let mut store = self.store.lock().unwrap();
        store.external_editor_grants.insert(grant_id.clone(), grant);
        Ok(grant_id)
    }

    pub fn resolve_external_editor_grant(&self, grant_id: &str) -> Result<PathBuf, String> {
        let store = self.store.lock().unwrap();
        let grant = store
            .external_editor_grants
            .get(grant_id)
            .ok_or_else(|| format!("External editor grant '{}' is invalid", grant_id))?;
        Ok(grant.canonical_app_path.clone())
    }
}

pub fn normalize_path_buf(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    let cleaned = s.strip_prefix(r"\\?\").unwrap_or(&s);
    PathBuf::from(cleaned)
}

pub fn is_path_contained_in(child: &Path, parent: &Path) -> bool {
    let norm_child = normalize_path_buf(child);
    let norm_parent = normalize_path_buf(parent);

    #[cfg(windows)]
    {
        let child_str = norm_child.to_string_lossy().to_lowercase();
        let parent_str = norm_parent.to_string_lossy().to_lowercase();
        child_str.starts_with(&parent_str)
    }

    #[cfg(not(windows))]
    {
        norm_child.starts_with(&norm_parent)
    }
}

fn is_supported_image_file(path: &Path) -> bool {
    const SUPPORTED_EXTENSIONS: &[&str] = &[
        "jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "tif", "heic", "heif", "avif", "svg",
        "dng", "cr2", "cr3", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "pef", "srw",
    ];

    path.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .map(|ext| SUPPORTED_EXTENSIONS.contains(&ext.as_str()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_manager_opens_and_resolves_image_id() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        fs::write(&image, b"dummy-image").unwrap();

        let manager = SessionManager::new();
        let snapshot = manager.open_folder_session(dir.path()).unwrap();
        assert_eq!(snapshot.images.len(), 1);

        let img_record = &snapshot.images[0];
        let resolved_path =
            manager.resolve_image_path(&snapshot.session_id, &img_record.id).unwrap();

        assert_eq!(SessionManager::canonicalize_path(&image).unwrap(), resolved_path);
    }

    #[test]
    fn test_session_manager_rejects_unauthorized_or_stale_ids() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        fs::write(&image, b"dummy-image").unwrap();

        let manager = SessionManager::new();
        let snapshot = manager.open_folder_session(dir.path()).unwrap();
        let session_id = snapshot.session_id.clone();
        let image_id = snapshot.images[0].id.clone();

        // 1. Invalid image ID
        assert!(manager.resolve_image_path(&session_id, "img_fake").is_err());

        // 2. Closed session
        manager.close_session(&session_id).unwrap();
        assert!(manager.resolve_image_path(&session_id, &image_id).is_err());
    }

    #[test]
    fn test_destination_and_editor_grants() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("editor.exe");
        fs::write(&app, b"dummy-exe").unwrap();

        let manager = SessionManager::new();
        let dest_grant = manager.grant_destination(dir.path()).unwrap();
        let editor_grant = manager.grant_external_editor(&app).unwrap();

        assert!(dest_grant.starts_with("dest_"));
        assert!(editor_grant.starts_with("editor_"));

        assert_eq!(
            manager.resolve_destination_grant(&dest_grant).unwrap(),
            SessionManager::canonicalize_path(dir.path()).unwrap()
        );
        assert_eq!(
            manager.resolve_external_editor_grant(&editor_grant).unwrap(),
            SessionManager::canonicalize_path(&app).unwrap()
        );
    }

    #[test]
    fn test_capabilities_and_asset_scope_isolation() {
        let tauri_conf_path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let content = fs::read_to_string(&tauri_conf_path).expect("Read tauri.conf.json");
        let json: serde_json::Value =
            serde_json::from_str(&content).expect("Parse tauri.conf.json");

        let scope = json["app"]["security"]["assetProtocol"]["scope"]
            .as_array()
            .expect("assetProtocol.scope array");

        let scope_strings: Vec<&str> = scope.iter().filter_map(|v| v.as_str()).collect();

        // 1. Ensure global wildcard "**" is completely removed
        assert!(
            !scope_strings.contains(&"**"),
            "assetProtocol.scope must not contain broad '**' wildcard"
        );

        // 2. Ensure permitted roots exist
        assert!(scope_strings.contains(&"$APPCACHE/**/*"));
        assert!(scope_strings.contains(&"$TEMP/**/*"));
        assert!(scope_strings.contains(&"$APPDATA/**/*"));

        // 3. Ensure capabilities main.json and projector.json exist
        let capabilities_dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        assert!(capabilities_dir.join("main.json").exists(), "main.json capability must exist");
        assert!(
            capabilities_dir.join("projector.json").exists(),
            "projector.json capability must exist"
        );
        assert!(!capabilities_dir.join("default.json").exists(), "default.json should be removed");
    }
}
