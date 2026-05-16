use crate::{commands::ImageFile, path_normalization::normalize_path_for_key};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const FOLDER_INDEX_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct PersistedFolderIndex {
    schema_version: u32,
    folder_key: String,
    folder_path: String,
    last_refreshed_at: u64,
    #[serde(default)]
    images: Vec<PersistedImageRecord>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct PersistedImageRecord {
    path: String,
    folder_path: String,
    canonical_path: String,
    file_name: String,
    extension: String,
    size_bytes: u64,
    modified_at: Option<String>,
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    format: Option<String>,
    last_seen_at: u64,
}

impl PersistedImageRecord {
    fn from_image_file(
        image: &ImageFile,
        folder_path: &str,
        last_seen_at: u64,
        previous: Option<&PersistedImageRecord>,
    ) -> Self {
        let preserve_metadata = previous
            .map(|record| {
                record.size_bytes == image.size_bytes && record.modified_at == image.modified_at
            })
            .unwrap_or(false);

        Self {
            path: image.path.clone(),
            folder_path: folder_path.to_string(),
            canonical_path: previous
                .map(|record| record.canonical_path.clone())
                .filter(|path| !path.is_empty())
                .unwrap_or_else(|| normalize_path_for_key(Path::new(&image.path))),
            file_name: image.file_name.clone(),
            extension: image.extension.clone(),
            size_bytes: image.size_bytes,
            modified_at: image.modified_at.clone(),
            width: previous.filter(|_| preserve_metadata).and_then(|record| record.width),
            height: previous.filter(|_| preserve_metadata).and_then(|record| record.height),
            format: previous.filter(|_| preserve_metadata).and_then(|record| record.format.clone()),
            last_seen_at,
        }
    }

    fn to_image_file(&self) -> ImageFile {
        ImageFile {
            path: self.path.clone(),
            file_name: self.file_name.clone(),
            extension: self.extension.clone(),
            size_bytes: self.size_bytes,
            modified_at: self.modified_at.clone(),
        }
    }
}

pub fn index_root(cache_root: &Path) -> PathBuf {
    cache_root.join("folder-index").join(format!("v{}", FOLDER_INDEX_SCHEMA_VERSION))
}

pub fn read_folder_images(index_root: &Path, folder_path: &Path) -> Vec<ImageFile> {
    let _guard = lock_index_io();
    let folder_key = folder_key(folder_path);
    let shard_path = shard_path(index_root, &folder_key);

    read_shard(&shard_path, &folder_key)
        .map(|index| index.images.iter().map(PersistedImageRecord::to_image_file).collect())
        .unwrap_or_default()
}

pub fn write_folder_images(
    index_root: &Path,
    folder_path: &Path,
    images: &[ImageFile],
) -> Result<(), String> {
    let _guard = lock_index_io();
    let folder_key = folder_key(folder_path);
    let shard_path = shard_path(index_root, &folder_key);

    if images.is_empty() {
        remove_shard(&shard_path)?;
        return Ok(());
    }

    let previous_records = read_shard(&shard_path, &folder_key)
        .map(|entry| {
            entry
                .images
                .into_iter()
                .map(|record| (record.path.clone(), record))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();
    let refreshed_at = unix_timestamp_seconds();
    let folder_path_string = folder_path.to_string_lossy().to_string();

    let persisted_images = images
        .iter()
        .map(|image| {
            PersistedImageRecord::from_image_file(
                image,
                &folder_path_string,
                refreshed_at,
                previous_records.get(&image.path),
            )
        })
        .collect();

    write_shard(
        &shard_path,
        &PersistedFolderIndex {
            schema_version: FOLDER_INDEX_SCHEMA_VERSION,
            folder_key,
            folder_path: folder_path_string,
            last_refreshed_at: refreshed_at,
            images: persisted_images,
        },
    )
}

fn folder_key(folder_path: &Path) -> String {
    normalize_path_for_key(folder_path)
}

fn shard_path(index_root: &Path, folder_key: &str) -> PathBuf {
    let digest = digest_hex(folder_key.as_bytes());
    index_root.join(&digest[0..2]).join(format!("{}.json", digest))
}

fn read_shard(shard_path: &Path, expected_folder_key: &str) -> Option<PersistedFolderIndex> {
    if !shard_path.exists() {
        return None;
    }

    let content = match fs::read_to_string(shard_path) {
        Ok(content) => content,
        Err(err) => {
            eprintln!(
                "Failed to read folder index shard from '{}': {}. Falling back to empty cache.",
                shard_path.display(),
                err
            );
            return None;
        }
    };

    let parsed = match serde_json::from_str::<PersistedFolderIndex>(&content) {
        Ok(parsed) => parsed,
        Err(err) => {
            eprintln!(
                "Failed to parse folder index shard from '{}': {}. Falling back to empty cache.",
                shard_path.display(),
                err
            );
            return None;
        }
    };

    if parsed.schema_version != FOLDER_INDEX_SCHEMA_VERSION {
        eprintln!(
            "Discarding folder index shard from '{}' due to schema version mismatch (found {}, expected {}).",
            shard_path.display(),
            parsed.schema_version,
            FOLDER_INDEX_SCHEMA_VERSION
        );
        return None;
    }

    if parsed.folder_key != expected_folder_key {
        eprintln!(
            "Discarding folder index shard from '{}' because the folder key did not match the requested folder.",
            shard_path.display()
        );
        return None;
    }

    Some(parsed)
}

fn write_shard(shard_path: &Path, index: &PersistedFolderIndex) -> Result<(), String> {
    let parent = shard_path
        .parent()
        .ok_or_else(|| "Folder index shard path is missing a parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("Failed to create folder index shard directory: {}", err))?;

    let content = serde_json::to_vec(index)
        .map_err(|err| format!("Failed to serialize folder index shard: {}", err))?;
    let temp_path = unique_temp_path(shard_path);
    fs::write(&temp_path, content)
        .map_err(|err| format!("Failed to write temporary folder index shard: {}", err))?;

    let backup_path = if shard_path.exists() {
        let backup_path = unique_backup_path(shard_path);
        fs::rename(shard_path, &backup_path).map_err(|err| {
            format!("Failed to prepare existing folder index shard for replacement: {}", err)
        })?;
        Some(backup_path)
    } else {
        None
    };

    match fs::rename(&temp_path, shard_path) {
        Ok(()) => {
            if let Some(backup_path) = backup_path {
                let _ = fs::remove_file(backup_path);
            }
            Ok(())
        }
        Err(err) => {
            let _ = fs::remove_file(&temp_path);
            if let Some(backup_path) = backup_path {
                let _ = fs::rename(&backup_path, shard_path);
            }
            Err(format!("Failed to finalize folder index shard write: {}", err))
        }
    }
}

fn remove_shard(shard_path: &Path) -> Result<(), String> {
    if !shard_path.exists() {
        return Ok(());
    }

    fs::remove_file(shard_path)
        .map_err(|err| format!("Failed to remove folder index shard: {}", err))
}

fn unique_temp_path(shard_path: &Path) -> PathBuf {
    static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

    let temp_id = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = process::id();
    let file_name = shard_path.file_name().and_then(|value| value.to_str()).unwrap_or("index");
    shard_path.with_file_name(format!(".{}.{}.{}.tmp", file_name, pid, temp_id))
}

fn unique_backup_path(shard_path: &Path) -> PathBuf {
    static BACKUP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

    let backup_id = BACKUP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = process::id();
    let file_name = shard_path.file_name().and_then(|value| value.to_str()).unwrap_or("index");
    shard_path.with_file_name(format!(".{}.{}.{}.bak", file_name, pid, backup_id))
}

fn digest_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(&mut output, "{:02x}", byte);
    }
    output
}

fn lock_index_io() -> std::sync::MutexGuard<'static, ()> {
    static INDEX_IO_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    INDEX_IO_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap_or_else(|err| err.into_inner())
}

fn unix_timestamp_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use tempfile::tempdir;

    fn make_image(folder: &Path, file_name: &str, size_bytes: u64, modified_at: &str) -> ImageFile {
        let path = folder.join(file_name);
        fs::write(&path, vec![0_u8; size_bytes as usize]).unwrap();

        ImageFile {
            path: path.to_string_lossy().to_string(),
            file_name: file_name.to_string(),
            extension: path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string(),
            size_bytes,
            modified_at: Some(modified_at.to_string()),
        }
    }

    #[test]
    fn read_folder_images_returns_empty_for_missing_or_corrupt_index() {
        let dir = tempdir().unwrap();
        let folder = dir.path().join("images");
        fs::create_dir_all(&folder).unwrap();
        let index_root = index_root(dir.path());

        assert!(read_folder_images(&index_root, &folder).is_empty());

        let folder_key = folder_key(&folder);
        let corrupt_shard = shard_path(&index_root, &folder_key);
        fs::create_dir_all(corrupt_shard.parent().unwrap()).unwrap();
        fs::write(&corrupt_shard, "{not-valid-json").unwrap();

        assert!(read_folder_images(&index_root, &folder).is_empty());
    }

    #[test]
    fn folder_images_round_trip_through_versioned_index() {
        let dir = tempdir().unwrap();
        let folder = dir.path().join("images");
        fs::create_dir_all(&folder).unwrap();
        let index_root = index_root(dir.path());
        let images = vec![
            make_image(&folder, "one.jpg", 1, "100"),
            make_image(&folder, "two.png", 2, "200"),
        ];

        write_folder_images(&index_root, &folder, &images).unwrap();

        assert_eq!(read_folder_images(&index_root, &folder), images);
    }

    #[test]
    fn read_folder_images_discards_incompatible_schema_versions() {
        let dir = tempdir().unwrap();
        let folder = dir.path().join("images");
        fs::create_dir_all(&folder).unwrap();
        let index_root = index_root(dir.path());
        let folder_key = folder_key(&folder);
        let shard_file = shard_path(&index_root, &folder_key);

        fs::create_dir_all(shard_file.parent().unwrap()).unwrap();
        fs::write(
            &shard_file,
            format!(
                r#"{{"schema_version":999,"folder_key":"{}","folder_path":"{}","last_refreshed_at":0,"images":[]}}"#,
                folder_key,
                folder.to_string_lossy()
            ),
        )
        .unwrap();

        assert!(read_folder_images(&index_root, &folder).is_empty());
    }

    #[test]
    fn write_folder_images_reconciles_added_removed_and_modified_records() {
        let dir = tempdir().unwrap();
        let folder = dir.path().join("images");
        fs::create_dir_all(&folder).unwrap();
        let index_root = index_root(dir.path());
        let initial_images =
            vec![make_image(&folder, "a.jpg", 1, "100"), make_image(&folder, "b.jpg", 2, "200")];

        write_folder_images(&index_root, &folder, &initial_images).unwrap();

        let refreshed_images =
            vec![make_image(&folder, "b.jpg", 5, "500"), make_image(&folder, "c.jpg", 3, "300")];
        write_folder_images(&index_root, &folder, &refreshed_images).unwrap();

        assert_eq!(read_folder_images(&index_root, &folder), refreshed_images);
    }

    #[test]
    fn folder_lookup_uses_canonical_folder_keys() {
        let dir = tempdir().unwrap();
        let folder = dir.path().join("images");
        fs::create_dir_all(&folder).unwrap();
        let index_root = index_root(dir.path());
        let images = vec![make_image(&folder, "one.jpg", 1, "100")];

        write_folder_images(&index_root, &folder, &images).unwrap();

        let alternate_folder_path = folder.join(".");
        assert_eq!(read_folder_images(&index_root, &alternate_folder_path), images);
    }

    #[test]
    fn unrelated_corrupt_shard_does_not_block_valid_folder_reads() {
        let dir = tempdir().unwrap();
        let first_folder = dir.path().join("first");
        let second_folder = dir.path().join("second");
        fs::create_dir_all(&first_folder).unwrap();
        fs::create_dir_all(&second_folder).unwrap();
        let index_root = index_root(dir.path());
        let images = vec![make_image(&first_folder, "one.jpg", 1, "100")];

        write_folder_images(&index_root, &first_folder, &images).unwrap();

        let second_folder_key = folder_key(&second_folder);
        let corrupt_shard = shard_path(&index_root, &second_folder_key);
        fs::create_dir_all(corrupt_shard.parent().unwrap()).unwrap();
        fs::write(&corrupt_shard, "{not-valid-json").unwrap();

        assert_eq!(read_folder_images(&index_root, &first_folder), images);
    }
}
