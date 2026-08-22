use crate::{
    commands::ImageFile,
    path_normalization::{normalize_path_for_key_with_semantics, PathCaseSemantics},
};
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

const FOLDER_INDEX_SCHEMA_VERSION: u32 = 4;
const BOOTSTRAP_INDEX_IMAGE_LIMIT: usize = 256;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct PersistedFolderIndex {
    schema_version: u32,
    folder_key: String,
    folder_path: String,
    path_case_semantics: PathCaseSemantics,
    last_refreshed_at: u64,
    #[serde(default)]
    catalog_revision: u64,
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
    created_at: Option<String>,
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
        semantics: PathCaseSemantics,
    ) -> Self {
        let preserve_metadata = previous
            .map(|record| {
                record.size_bytes == image.size_bytes
                    && record.modified_at == image.modified_at
                    && record.created_at == image.created_at
            })
            .unwrap_or(false);

        Self {
            path: image.path.clone(),
            folder_path: folder_path.to_string(),
            canonical_path: previous
                .map(|record| record.canonical_path.clone())
                .filter(|path| !path.is_empty())
                .unwrap_or_else(|| {
                    normalize_path_for_key_with_semantics(Path::new(&image.path), semantics)
                }),
            file_name: image.file_name.clone(),
            extension: image.extension.clone(),
            size_bytes: image.size_bytes,
            modified_at: image.modified_at.clone(),
            created_at: image.created_at.clone(),
            width: previous.filter(|_| preserve_metadata).and_then(|record| record.width),
            height: previous.filter(|_| preserve_metadata).and_then(|record| record.height),
            format: previous.filter(|_| preserve_metadata).and_then(|record| record.format.clone()),
            last_seen_at,
        }
    }

    fn to_image_file(&self) -> ImageFile {
        ImageFile {
            id: None,
            session_id: None,
            path: self.path.clone(),
            file_name: self.file_name.clone(),
            extension: self.extension.clone(),
            size_bytes: self.size_bytes,
            modified_at: self.modified_at.clone(),
            created_at: self.created_at.clone(),
        }
    }
}

pub fn index_root(cache_root: &Path) -> PathBuf {
    cache_root.join("folder-index").join(format!("v{}", FOLDER_INDEX_SCHEMA_VERSION))
}

pub fn read_folder_images(index_root: &Path, folder_path: &Path) -> Vec<ImageFile> {
    read_folder_images_with_semantics(
        index_root,
        folder_path,
        crate::path_normalization::runtime_path_case_semantics(),
    )
}

pub fn read_folder_images_with_semantics(
    index_root: &Path,
    folder_path: &Path,
    semantics: PathCaseSemantics,
) -> Vec<ImageFile> {
    let _guard = lock_index_io();
    let folder_key = folder_key_with_semantics(folder_path, semantics);
    let shard_path = shard_path(index_root, &folder_key);

    read_shard(&shard_path, &folder_key, semantics)
        .map(|index| index.images.iter().map(PersistedImageRecord::to_image_file).collect())
        .unwrap_or_default()
}

pub fn read_folder_images_bounded_with_semantics(
    index_root: &Path,
    folder_path: &Path,
    semantics: PathCaseSemantics,
    limit: usize,
) -> Vec<ImageFile> {
    let _guard = lock_index_io();
    let folder_key = folder_key_with_semantics(folder_path, semantics);
    let shard_path = bootstrap_shard_path(index_root, &folder_key);

    read_shard(&shard_path, &folder_key, semantics)
        .map(|index| {
            index.images.iter().take(limit).map(PersistedImageRecord::to_image_file).collect()
        })
        .unwrap_or_default()
}

pub fn write_folder_images(
    index_root: &Path,
    folder_path: &Path,
    images: &[ImageFile],
) -> Result<(), String> {
    write_folder_images_with_semantics(
        index_root,
        folder_path,
        images,
        crate::path_normalization::runtime_path_case_semantics(),
    )
}

pub fn write_folder_images_with_semantics(
    index_root: &Path,
    folder_path: &Path,
    images: &[ImageFile],
    semantics: PathCaseSemantics,
) -> Result<(), String> {
    write_folder_images_for_revision_with_semantics(index_root, folder_path, images, semantics, 0)
}

pub fn write_folder_images_for_revision_with_semantics(
    index_root: &Path,
    folder_path: &Path,
    images: &[ImageFile],
    semantics: PathCaseSemantics,
    catalog_revision: u64,
) -> Result<(), String> {
    let _guard = lock_index_io();
    let folder_key = folder_key_with_semantics(folder_path, semantics);
    let shard_path = shard_path(index_root, &folder_key);
    let bootstrap_path = bootstrap_shard_path(index_root, &folder_key);

    let previous_index = read_shard(&shard_path, &folder_key, semantics);
    if previous_index.as_ref().is_some_and(|entry| entry.catalog_revision > catalog_revision) {
        return Ok(());
    }

    if images.is_empty() {
        remove_shard(&shard_path)?;
        remove_shard(&bootstrap_path)?;
        return Ok(());
    }

    let previous_records = previous_index
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

    let persisted_images: Vec<PersistedImageRecord> = images
        .iter()
        .map(|image| {
            PersistedImageRecord::from_image_file(
                image,
                &folder_path_string,
                refreshed_at,
                previous_records.get(&image.path),
                semantics,
            )
        })
        .collect();

    let full_index = PersistedFolderIndex {
        schema_version: FOLDER_INDEX_SCHEMA_VERSION,
        folder_key: folder_key.clone(),
        folder_path: folder_path_string.clone(),
        path_case_semantics: semantics,
        last_refreshed_at: refreshed_at,
        catalog_revision,
        images: persisted_images.clone(),
    };
    let bootstrap_index = PersistedFolderIndex {
        schema_version: FOLDER_INDEX_SCHEMA_VERSION,
        folder_key,
        folder_path: folder_path_string,
        path_case_semantics: semantics,
        last_refreshed_at: refreshed_at,
        catalog_revision,
        images: persisted_images.into_iter().take(BOOTSTRAP_INDEX_IMAGE_LIMIT).collect(),
    };

    write_shard(&shard_path, &full_index)?;
    write_shard(&bootstrap_path, &bootstrap_index)
}

#[cfg(test)]
fn folder_key(folder_path: &Path) -> String {
    crate::path_normalization::normalize_path_for_key(folder_path)
}

fn folder_key_with_semantics(folder_path: &Path, semantics: PathCaseSemantics) -> String {
    normalize_path_for_key_with_semantics(folder_path, semantics)
}

fn shard_path(index_root: &Path, folder_key: &str) -> PathBuf {
    let digest = digest_hex(folder_key.as_bytes());
    index_root.join(&digest[0..2]).join(format!("{}.json", digest))
}

fn bootstrap_shard_path(index_root: &Path, folder_key: &str) -> PathBuf {
    let digest = digest_hex(folder_key.as_bytes());
    index_root.join(&digest[0..2]).join(format!("{}.bootstrap.json", digest))
}

fn read_shard(
    shard_path: &Path,
    expected_folder_key: &str,
    expected_semantics: PathCaseSemantics,
) -> Option<PersistedFolderIndex> {
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
    if parsed.path_case_semantics != expected_semantics {
        eprintln!(
            "Discarding folder index shard from '{}' because its path case semantics no longer match the authority root.",
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
    use std::sync::{Arc, Barrier};
    use std::thread;
    use tempfile::tempdir;

    fn make_image(folder: &Path, file_name: &str, size_bytes: u64, modified_at: &str) -> ImageFile {
        let path = folder.join(file_name);
        fs::write(&path, vec![0_u8; size_bytes as usize]).unwrap();

        ImageFile {
            id: None,
            session_id: None,
            path: path.to_string_lossy().to_string(),
            file_name: file_name.to_string(),
            extension: path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string(),
            size_bytes,
            modified_at: Some(modified_at.to_string()),
            created_at: None,
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
    fn bounded_folder_images_read_never_returns_full_catalog() {
        let dir = tempdir().unwrap();
        let folder = dir.path().join("images");
        fs::create_dir_all(&folder).unwrap();
        let index_root = index_root(dir.path());
        let images = (0..10)
            .map(|index| make_image(&folder, &format!("image-{index}.jpg"), 1, "100"))
            .collect::<Vec<_>>();

        write_folder_images(&index_root, &folder, &images).unwrap();

        let bounded = read_folder_images_bounded_with_semantics(
            &index_root,
            &folder,
            crate::path_normalization::runtime_path_case_semantics(),
            3,
        );
        assert_eq!(bounded, images[..3].to_vec());
    }

    #[test]
    fn bounded_folder_images_read_uses_bootstrap_shard_not_full_catalog() {
        let dir = tempdir().unwrap();
        let folder = dir.path().join("images");
        fs::create_dir_all(&folder).unwrap();
        let index_root = index_root(dir.path());
        let images = (0..10)
            .map(|index| make_image(&folder, &format!("image-{index}.jpg"), 1, "100"))
            .collect::<Vec<_>>();

        write_folder_images(&index_root, &folder, &images).unwrap();
        let key = folder_key(&folder);
        fs::write(shard_path(&index_root, &key), "{not-valid-json").unwrap();

        let bounded = read_folder_images_bounded_with_semantics(
            &index_root,
            &folder,
            crate::path_normalization::runtime_path_case_semantics(),
            3,
        );
        assert_eq!(bounded, images[..3].to_vec());
        assert!(read_folder_images(&index_root, &folder).is_empty());
    }

    #[test]
    fn stale_revision_write_after_newer_publish_preserves_full_and_bootstrap_indexes() {
        let dir = tempdir().unwrap();
        let folder = Arc::new(dir.path().join("images"));
        fs::create_dir_all(folder.as_ref()).unwrap();
        let index_root = Arc::new(index_root(dir.path()));
        let semantics = crate::path_normalization::runtime_path_case_semantics();

        let newer_images = Arc::new(vec![
            make_image(folder.as_ref(), "newer-0.jpg", 1, "100"),
            make_image(folder.as_ref(), "newer-1.jpg", 1, "101"),
            make_image(folder.as_ref(), "newer-2.jpg", 1, "102"),
        ]);
        let stale_images = Arc::new(vec![
            make_image(folder.as_ref(), "stale-0.jpg", 1, "090"),
            make_image(folder.as_ref(), "stale-1.jpg", 1, "091"),
            make_image(folder.as_ref(), "stale-2.jpg", 1, "092"),
        ]);
        let barrier = Arc::new(Barrier::new(2));

        let newer_thread = {
            let index_root = Arc::clone(&index_root);
            let folder = Arc::clone(&folder);
            let images = Arc::clone(&newer_images);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                write_folder_images_for_revision_with_semantics(
                    index_root.as_ref(),
                    folder.as_ref(),
                    &images,
                    semantics,
                    3,
                )
                .unwrap();
                barrier.wait();
            })
        };

        let stale_thread = {
            let index_root = Arc::clone(&index_root);
            let folder = Arc::clone(&folder);
            let images = Arc::clone(&stale_images);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                write_folder_images_for_revision_with_semantics(
                    index_root.as_ref(),
                    folder.as_ref(),
                    &images,
                    semantics,
                    2,
                )
                .unwrap();
            })
        };

        newer_thread.join().unwrap();
        stale_thread.join().unwrap();

        assert_eq!(read_folder_images(index_root.as_ref(), folder.as_ref()), *newer_images);
        assert_eq!(
            read_folder_images_bounded_with_semantics(
                index_root.as_ref(),
                folder.as_ref(),
                semantics,
                2
            ),
            newer_images[..2]
        );
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
