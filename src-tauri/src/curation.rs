use crate::atomic_file::{build_unique_sibling_path, write_text_file_atomically};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const LEGACY_FILE_NAME: &str = "curation.json";
const STORE_DIRECTORY_NAME: &str = "curation";
const JOURNAL_FILE_NAME: &str = "pending.json";
const LOCK_FILE_NAME: &str = "store.lock";

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub(crate) struct ImageCuration {
    pub path: String,
    pub favorite: bool,
    pub rating: u8,
    pub updated_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageCurationUpdate {
    pub file_path: String,
    pub favorite: bool,
    pub rating: i32,
}

#[derive(Debug, Serialize, Deserialize)]
struct CurationJournal {
    updated_at: u64,
    updates: Vec<ImageCurationUpdate>,
}

fn store_directory(config_dir: &Path) -> PathBuf {
    config_dir.join(STORE_DIRECTORY_NAME)
}

fn journal_path(config_dir: &Path) -> PathBuf {
    store_directory(config_dir).join(JOURNAL_FILE_NAME)
}

fn acquire_store_lock(config_dir: &Path) -> Result<fs::File, String> {
    let directory = store_directory(config_dir);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create curation store: {error}"))?;
    let lock_path = directory.join(LOCK_FILE_NAME);
    let lock_file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|error| {
            format!("Failed to open curation store lock '{}': {error}", lock_path.display())
        })?;
    lock_file.lock().map_err(|error| {
        format!("Failed to lock curation store '{}': {error}", lock_path.display())
    })?;
    Ok(lock_file)
}

fn shard_id(file_path: &str) -> u8 {
    let hash = file_path.as_bytes().iter().fold(0xcbf29ce484222325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    });
    (hash & 0xff) as u8
}

fn shard_path(config_dir: &Path, id: u8) -> PathBuf {
    store_directory(config_dir).join(format!("{id:02x}.json"))
}

fn parse_shard_id(path: &Path) -> Option<u8> {
    let file_name = path.file_name()?.to_str()?;
    let hex = file_name.strip_suffix(".json")?;
    if hex.len() != 2 {
        return None;
    }
    u8::from_str_radix(hex, 16).ok()
}

fn normalize_metadata(metadata: HashMap<String, ImageCuration>) -> HashMap<String, ImageCuration> {
    let mut normalized = HashMap::new();
    for (key, mut value) in metadata {
        let normalized_path = if value.path.trim().is_empty() {
            key.trim().to_string()
        } else {
            value.path.trim().to_string()
        };
        if normalized_path.is_empty() {
            continue;
        }

        value.path = normalized_path.clone();
        value.rating = value.rating.min(5);
        if value.favorite || value.rating > 0 {
            normalized.insert(normalized_path, value);
        }
    }
    normalized
}

fn read_metadata_file(path: &Path) -> Result<HashMap<String, ImageCuration>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content = fs::read_to_string(path).map_err(|error| {
        format!("Failed to read curation metadata '{}': {}", path.display(), error)
    })?;
    let parsed =
        serde_json::from_str::<HashMap<String, ImageCuration>>(&content).map_err(|error| {
            format!("Failed to parse curation metadata '{}': {}", path.display(), error)
        })?;
    Ok(normalize_metadata(parsed))
}

fn read_shard_metadata_file(path: &Path) -> Result<HashMap<String, ImageCuration>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content = fs::read_to_string(path).map_err(|error| {
        format!("Failed to read curation metadata '{}': {}", path.display(), error)
    })?;
    match serde_json::from_str::<HashMap<String, ImageCuration>>(&content) {
        Ok(parsed) => Ok(normalize_metadata(parsed)),
        Err(parse_error) => {
            let quarantine_path = build_unique_sibling_path(path, "corrupt")?;
            fs::rename(path, &quarantine_path).map_err(|quarantine_error| {
                format!(
                    "Failed to parse curation metadata '{}': {}. Failed to quarantine the invalid shard as '{}': {}",
                    path.display(),
                    parse_error,
                    quarantine_path.display(),
                    quarantine_error
                )
            })?;
            eprintln!(
                "Failed to parse curation metadata '{}': {}. Quarantined the invalid shard as '{}'.",
                path.display(),
                parse_error,
                quarantine_path.display()
            );

            if let Some(parent) = path.parent() {
                if let Ok(entries) = fs::read_dir(parent) {
                    let mut backups = Vec::new();
                    for entry in entries.flatten() {
                        let backup_path = entry.path();
                        if let Some(destination) = staged_backup_destination(parent, &backup_path) {
                            if destination.file_name() == path.file_name() {
                                backups.push(backup_path);
                            }
                        }
                    }
                    backups.sort_by_key(|backup| {
                        fs::metadata(backup)
                            .and_then(|metadata| metadata.modified())
                            .unwrap_or(std::time::UNIX_EPOCH)
                    });
                    if let Some(latest_backup) = backups.pop() {
                        if let Ok(backup_content) = fs::read_to_string(&latest_backup) {
                            if let Ok(parsed_backup) = serde_json::from_str::<
                                HashMap<String, ImageCuration>,
                            >(&backup_content)
                            {
                                let _ = fs::rename(&latest_backup, path);
                                eprintln!(
                                    "Recovered curation shard metadata from staged backup '{}'",
                                    latest_backup.display()
                                );
                                return Ok(normalize_metadata(parsed_backup));
                            }
                        }
                    }
                }
            }

            Ok(HashMap::new())
        }
    }
}

fn staged_backup_destination(store_dir: &Path, path: &Path) -> Option<PathBuf> {
    let file_name = path.file_name()?.to_str()?;
    let (destination_stem, backup_suffix) = [".lightframe-backup-", ".lightframe-replace-backup-"]
        .into_iter()
        .find_map(|marker| file_name.split_once(marker))?;
    let version = backup_suffix.strip_suffix(".json")?;
    let (timestamp, attempt) = version.rsplit_once('-')?;
    if timestamp.is_empty()
        || attempt.is_empty()
        || !timestamp.bytes().all(|byte| byte.is_ascii_digit())
        || !attempt.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    if destination_stem != "pending"
        && (destination_stem.len() != 2 || u8::from_str_radix(destination_stem, 16).is_err())
    {
        return None;
    }
    Some(store_dir.join(format!("{destination_stem}.json")))
}

fn recovered_backup_stores() -> &'static Mutex<HashSet<PathBuf>> {
    static RECOVERED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    RECOVERED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn recover_staged_backups(config_dir: &Path) -> Result<(), String> {
    let store_dir = store_directory(config_dir);
    let store_key = std::path::absolute(&store_dir).unwrap_or_else(|_| store_dir.clone());
    if recovered_backup_stores()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .contains(&store_key)
        && !journal_path(config_dir).exists()
    {
        return Ok(());
    }
    let mut backups_by_destination = HashMap::<PathBuf, Vec<PathBuf>>::new();
    for entry in fs::read_dir(&store_dir)
        .map_err(|error| format!("Failed to inspect curation backups: {error}"))?
    {
        let backup_path = entry
            .map_err(|error| format!("Failed to inspect curation backup entry: {error}"))?
            .path();
        if let Some(destination) = staged_backup_destination(&store_dir, &backup_path) {
            backups_by_destination.entry(destination).or_default().push(backup_path);
        }
    }

    for (destination, mut backups) in backups_by_destination {
        let destination_valid = destination.exists() && read_metadata_file(&destination).is_ok();
        if !destination_valid {
            backups.sort_by_key(|path| {
                fs::metadata(path)
                    .and_then(|metadata| metadata.modified())
                    .unwrap_or(std::time::UNIX_EPOCH)
            });
            let Some(backup_path) = backups.pop() else {
                continue;
            };
            if destination.exists() {
                let quarantine_path = build_unique_sibling_path(&destination, "corrupt")?;
                let _ = fs::rename(&destination, &quarantine_path);
            }
            fs::rename(&backup_path, &destination).map_err(|error| {
                format!(
                    "Failed to restore staged curation backup '{}' to '{}': {}",
                    backup_path.display(),
                    destination.display(),
                    error
                )
            })?;
            eprintln!(
                "Restored staged curation backup '{}' to '{}'.",
                backup_path.display(),
                destination.display()
            );
        }

        for stale_backup in backups {
            fs::remove_file(&stale_backup).map_err(|error| {
                format!(
                    "Failed to remove stale curation backup '{}': {}",
                    stale_backup.display(),
                    error
                )
            })?;
        }
    }
    recovered_backup_stores().lock().unwrap_or_else(|error| error.into_inner()).insert(store_key);
    Ok(())
}

fn read_legacy_metadata(path: &Path) -> HashMap<String, ImageCuration> {
    match read_metadata_file(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            eprintln!("{error}. Falling back to empty state.");
            HashMap::new()
        }
    }
}

fn write_metadata_file(
    path: &Path,
    metadata: &HashMap<String, ImageCuration>,
) -> Result<(), String> {
    let content = serde_json::to_string(metadata)
        .map_err(|error| format!("Failed to serialize curation metadata: {error}"))?;
    write_text_file_atomically(path, &content, "curation metadata")
}

fn group_metadata_by_shard(
    metadata: HashMap<String, ImageCuration>,
) -> HashMap<u8, HashMap<String, ImageCuration>> {
    let mut grouped = HashMap::<u8, HashMap<String, ImageCuration>>::new();
    for (path, entry) in metadata {
        grouped.entry(shard_id(&path)).or_default().insert(path, entry);
    }
    grouped
}

fn next_legacy_backup_path(legacy_path: &Path) -> Result<PathBuf, String> {
    let preferred = legacy_path.with_file_name("curation.v1.migrated.json");
    if !preferred.exists() {
        return Ok(preferred);
    }
    build_unique_sibling_path(&preferred, "backup")
}

fn migrate_legacy_store(config_dir: &Path) -> Result<(), String> {
    let legacy_path = config_dir.join(LEGACY_FILE_NAME);
    if !legacy_path.exists() {
        return Ok(());
    }

    fs::create_dir_all(store_directory(config_dir))
        .map_err(|error| format!("Failed to create curation store: {error}"))?;
    for (id, legacy_entries) in group_metadata_by_shard(read_legacy_metadata(&legacy_path)) {
        let path = shard_path(config_dir, id);
        let mut shard = legacy_entries;
        // Existing shard values may come from a newer store restored alongside a legacy backup.
        // Prefer them so migration can never overwrite a more recent edit.
        shard.extend(read_shard_metadata_file(&path)?);
        write_metadata_file(&path, &shard)?;
    }

    let backup_path = next_legacy_backup_path(&legacy_path)?;
    fs::rename(&legacy_path, &backup_path).map_err(|error| {
        format!(
            "Failed to archive migrated curation metadata '{}' to '{}': {}",
            legacy_path.display(),
            backup_path.display(),
            error
        )
    })
}

fn normalize_updates(updates: Vec<ImageCurationUpdate>) -> Vec<ImageCurationUpdate> {
    updates
        .into_iter()
        .filter_map(|mut update| {
            update.file_path = update.file_path.trim().to_string();
            (!update.file_path.is_empty()).then_some(update)
        })
        .collect()
}

fn apply_update(
    metadata: &mut HashMap<String, ImageCuration>,
    update: &ImageCurationUpdate,
    updated_at: u64,
) {
    let rating = update.rating.clamp(0, 5) as u8;
    if !update.favorite && rating == 0 {
        metadata.remove(&update.file_path);
        return;
    }
    metadata.insert(
        update.file_path.clone(),
        ImageCuration {
            path: update.file_path.clone(),
            favorite: update.favorite,
            rating,
            updated_at,
        },
    );
}

fn apply_updates(config_dir: &Path, journal: &CurationJournal) -> Result<(), String> {
    let mut grouped = HashMap::<u8, Vec<&ImageCurationUpdate>>::new();
    for update in &journal.updates {
        grouped.entry(shard_id(&update.file_path)).or_default().push(update);
    }

    for (id, updates) in grouped {
        let path = shard_path(config_dir, id);
        let mut shard = read_shard_metadata_file(&path)?;
        for update in updates {
            apply_update(&mut shard, update, journal.updated_at);
        }

        if shard.is_empty() {
            if path.exists() {
                fs::remove_file(&path).map_err(|error| {
                    format!("Failed to remove empty curation shard '{}': {}", path.display(), error)
                })?;
            }
        } else {
            write_metadata_file(&path, &shard)?;
        }
    }
    Ok(())
}

fn recover_pending_journal(config_dir: &Path) -> Result<(), String> {
    let path = journal_path(config_dir);
    if !path.exists() {
        return Ok(());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read pending curation journal: {error}"))?;
    let journal: CurationJournal = serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse pending curation journal: {error}"))?;
    apply_updates(config_dir, &journal)?;
    fs::remove_file(&path)
        .map_err(|error| format!("Failed to clear recovered curation journal: {error}"))
}

fn prepare_store(config_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(config_dir)
        .map_err(|error| format!("Failed to create curation config directory: {error}"))?;
    fs::create_dir_all(store_directory(config_dir))
        .map_err(|error| format!("Failed to create curation store: {error}"))?;
    recover_staged_backups(config_dir)?;
    migrate_legacy_store(config_dir)?;
    recover_pending_journal(config_dir)
}

pub(crate) fn read_curation_metadata(
    config_dir: &Path,
) -> Result<HashMap<String, ImageCuration>, String> {
    let _store_lock = acquire_store_lock(config_dir)?;
    read_curation_metadata_locked(config_dir)
}

/// Read only the shards addressed by the active folder or startup file list. Stored paths are
/// normalized only for matching; the original spelling remains the persisted key for legacy data.
pub(crate) fn read_curation_metadata_for_paths(
    config_dir: &Path,
    file_paths: &[String],
) -> Result<HashMap<String, ImageCuration>, String> {
    let _store_lock = acquire_store_lock(config_dir)?;
    prepare_store(config_dir)?;
    let requested = file_paths
        .iter()
        .map(|path| path.trim())
        .filter(|path| !path.is_empty())
        .map(normalize_lookup_path)
        .collect::<HashSet<_>>();
    let shard_ids = file_paths
        .iter()
        .flat_map(|path| [path.clone(), path.replace('\\', "/"), path.to_lowercase()])
        .map(|path| shard_id(path.trim()))
        .collect::<HashSet<_>>();
    let mut metadata = HashMap::new();
    for id in shard_ids {
        let path = shard_path(config_dir, id);
        match read_shard_metadata_file(&path) {
            Ok(shard) => metadata.extend(
                shard
                    .into_iter()
                    .filter(|(_, value)| requested.contains(&normalize_lookup_path(&value.path))),
            ),
            Err(error) => {
                eprintln!("{error}. Skipping this shard while loading healthy curation data.")
            }
        }
    }
    Ok(metadata)
}

fn normalize_lookup_path(path: &str) -> String {
    path.trim().replace('\\', "/").to_lowercase()
}

fn read_curation_metadata_locked(
    config_dir: &Path,
) -> Result<HashMap<String, ImageCuration>, String> {
    prepare_store(config_dir)?;
    let mut metadata = HashMap::new();
    for entry in fs::read_dir(store_directory(config_dir))
        .map_err(|error| format!("Failed to read curation store: {error}"))?
    {
        let path = entry
            .map_err(|error| format!("Failed to inspect curation store entry: {error}"))?
            .path();
        if parse_shard_id(&path).is_some() {
            match read_shard_metadata_file(&path) {
                Ok(shard) => metadata.extend(shard),
                Err(error) => {
                    eprintln!("{error}. Skipping this shard while loading healthy curation data.")
                }
            }
        }
    }
    Ok(metadata)
}

pub(crate) fn write_curation_updates(
    config_dir: &Path,
    updates: Vec<ImageCurationUpdate>,
    updated_at: u64,
) -> Result<(), String> {
    let updates = normalize_updates(updates);
    if updates.is_empty() {
        return Ok(());
    }

    let _store_lock = acquire_store_lock(config_dir)?;
    prepare_store(config_dir)?;
    let journal = CurationJournal { updated_at, updates };
    let journal_content = serde_json::to_string(&journal)
        .map_err(|error| format!("Failed to serialize curation journal: {error}"))?;
    let path = journal_path(config_dir);
    write_text_file_atomically(&path, &journal_content, "curation journal")?;
    apply_updates(config_dir, &journal)?;
    fs::remove_file(&path).map_err(|error| format!("Failed to clear curation journal: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use tempfile::tempdir;

    fn update(path: &str, favorite: bool, rating: i32) -> ImageCurationUpdate {
        ImageCurationUpdate { file_path: path.to_string(), favorite, rating }
    }

    #[test]
    fn applies_updates_and_removes_default_entries() {
        let dir = tempdir().unwrap();
        write_curation_updates(dir.path(), vec![update("C:/images/photo.jpg", true, 9)], 42)
            .unwrap();
        let metadata = read_curation_metadata(dir.path()).unwrap();
        assert_eq!(metadata["C:/images/photo.jpg"].rating, 5);
        assert_eq!(metadata["C:/images/photo.jpg"].updated_at, 42);

        write_curation_updates(dir.path(), vec![update("C:/images/photo.jpg", false, 0)], 44)
            .unwrap();
        assert!(read_curation_metadata(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn migrates_legacy_json_without_data_loss() {
        let dir = tempdir().unwrap();
        let legacy_path = dir.path().join(LEGACY_FILE_NAME);
        fs::write(
            &legacy_path,
            r#"{"C:/images/one.jpg":{"path":"","favorite":true,"rating":7,"updated_at":1},"C:/images/empty.jpg":{"path":"C:/images/empty.jpg","favorite":false,"rating":0,"updated_at":2}}"#,
        )
        .unwrap();

        let metadata = read_curation_metadata(dir.path()).unwrap();

        assert_eq!(metadata.len(), 1);
        assert_eq!(metadata["C:/images/one.jpg"].rating, 5);
        assert!(!legacy_path.exists());
        assert!(dir.path().join("curation.v1.migrated.json").exists());
        assert!(shard_path(dir.path(), shard_id("C:/images/one.jpg")).exists());
    }

    #[test]
    fn recovers_an_interrupted_multi_shard_batch_from_the_journal() {
        let dir = tempdir().unwrap();
        prepare_store(dir.path()).unwrap();
        let updates = (0..100)
            .map(|index| update(&format!("C:/images/{index}.jpg"), true, index % 6))
            .collect();
        let journal = CurationJournal { updated_at: 88, updates };
        let content = serde_json::to_string(&journal).unwrap();
        write_curation_updates(dir.path(), journal.updates.iter().take(50).cloned().collect(), 77)
            .unwrap();
        write_text_file_atomically(&journal_path(dir.path()), &content, "test journal").unwrap();

        let metadata = read_curation_metadata(dir.path()).unwrap();

        assert_eq!(metadata.len(), 100);
        assert!(metadata.values().all(|entry| entry.updated_at == 88));
        assert!(!journal_path(dir.path()).exists());
    }

    #[test]
    fn restores_a_staged_shard_backup_before_replaying_the_journal() {
        let dir = tempdir().unwrap();
        let updated_path = "C:/images/updated.jpg";
        let shard = shard_id(updated_path);
        let unrelated_path = (0..10_000)
            .map(|index| format!("C:/images/unrelated-{index}.jpg"))
            .find(|path| shard_id(path) == shard && path != updated_path)
            .unwrap();
        let backup_path = store_directory(dir.path())
            .join(format!("{shard:02x}.lightframe-replace-backup-123456789-0.json"));
        write_curation_updates(
            dir.path(),
            vec![update(updated_path, true, 2), update(&unrelated_path, true, 4)],
            1,
        )
        .unwrap();
        fs::rename(shard_path(dir.path(), shard), &backup_path).unwrap();
        let journal =
            CurationJournal { updated_at: 2, updates: vec![update(updated_path, true, 5)] };
        fs::write(journal_path(dir.path()), serde_json::to_string(&journal).unwrap()).unwrap();

        let metadata = read_curation_metadata(dir.path()).unwrap();

        assert_eq!(metadata.len(), 2);
        assert_eq!(metadata[&unrelated_path].rating, 4);
        assert_eq!(metadata[updated_path].rating, 5);
        assert!(!backup_path.exists());
        assert!(!journal_path(dir.path()).exists());
    }

    #[test]
    fn never_restores_a_staged_backup_over_a_live_shard() {
        let dir = tempdir().unwrap();
        let live_path = "C:/images/live.jpg";
        let shard = shard_id(live_path);
        fs::create_dir_all(store_directory(dir.path())).unwrap();
        let live_entry =
            ImageCuration { path: live_path.to_string(), favorite: true, rating: 5, updated_at: 2 };
        fs::write(
            shard_path(dir.path(), shard),
            serde_json::to_string(&HashMap::from([(live_path.to_string(), live_entry)])).unwrap(),
        )
        .unwrap();
        let backup_path = store_directory(dir.path())
            .join(format!("{shard:02x}.lightframe-backup-123456789-0.json"));
        let stale_path = "C:/images/stale.jpg";
        let stale_entry = ImageCuration {
            path: stale_path.to_string(),
            favorite: true,
            rating: 1,
            updated_at: 1,
        };
        fs::write(
            &backup_path,
            serde_json::to_string(&HashMap::from([(stale_path.to_string(), stale_entry)])).unwrap(),
        )
        .unwrap();

        let metadata = read_curation_metadata(dir.path()).unwrap();

        assert_eq!(metadata.len(), 1);
        assert_eq!(metadata[live_path].rating, 5);
        assert!(!backup_path.exists());
    }

    #[test]
    fn malformed_shard_is_quarantined_without_hiding_healthy_shards() {
        let dir = tempdir().unwrap();
        let damaged_path = "C:/images/damaged.jpg";
        let damaged_shard = shard_id(damaged_path);
        let healthy_path = (0..1_000)
            .map(|index| format!("C:/images/healthy-{index}.jpg"))
            .find(|path| shard_id(path) != damaged_shard)
            .unwrap();
        write_curation_updates(
            dir.path(),
            vec![update(damaged_path, true, 5), update(&healthy_path, true, 4)],
            1,
        )
        .unwrap();
        fs::write(shard_path(dir.path(), damaged_shard), "{not-json").unwrap();

        let metadata = read_curation_metadata(dir.path()).unwrap();

        assert_eq!(metadata.len(), 1);
        assert_eq!(metadata[&healthy_path].rating, 4);
        assert!(!metadata.contains_key(damaged_path));
        assert!(fs::read_dir(store_directory(dir.path())).unwrap().filter_map(Result::ok).any(
            |entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(&format!("{damaged_shard:02x}.corrupt-"))
        ));
    }

    #[test]
    fn read_curation_metadata_auto_recovers_staged_replace_backups() {
        let dir = tempdir().unwrap();
        let path = "C:/photos/cat.jpg";
        let target_shard = shard_id(path);
        let shard_file = shard_path(dir.path(), target_shard);
        fs::create_dir_all(store_directory(dir.path())).unwrap();

        let backup_path = store_directory(dir.path()).join(format!(
            "{target_shard:02x}.lightframe-replace-backup-1700000000000000000-0.json"
        ));
        let mut map = HashMap::new();
        map.insert(
            path.to_string(),
            ImageCuration { path: path.to_string(), favorite: true, rating: 5, updated_at: 100 },
        );
        fs::write(&backup_path, serde_json::to_string(&map).unwrap()).unwrap();
        fs::write(&shard_file, "{corrupt-json-truncated").unwrap();

        let metadata = read_curation_metadata(dir.path()).unwrap();
        assert_eq!(metadata.get(path).map(|c| c.rating), Some(5));
        assert!(shard_file.exists());
    }

    #[test]
    fn store_lock_rejects_a_second_independent_holder() {
        let dir = tempdir().unwrap();
        let held_lock = acquire_store_lock(dir.path()).unwrap();
        let lock_path = store_directory(dir.path()).join(LOCK_FILE_NAME);
        let second_lock = fs::OpenOptions::new().read(true).write(true).open(lock_path).unwrap();

        assert!(matches!(second_lock.try_lock(), Err(std::fs::TryLockError::WouldBlock)));
        drop(held_lock);

        second_lock.try_lock().unwrap();
    }

    #[test]
    fn single_edit_reads_and_rewrites_only_its_shard() {
        let dir = tempdir().unwrap();
        let paths: Vec<String> =
            (0..10_000).map(|index| format!("C:/library/{index}.jpg")).collect();
        let updates = paths.iter().map(|path| update(path, true, 3)).collect();
        write_curation_updates(dir.path(), updates, 1).unwrap();
        let target = &paths[4_321];
        let target_shard = shard_id(target);
        let untouched: HashMap<u8, Vec<u8>> = fs::read_dir(store_directory(dir.path()))
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let id = parse_shard_id(&entry.path())?;
                (id != target_shard).then(|| (id, fs::read(entry.path()).unwrap()))
            })
            .collect();

        write_curation_updates(dir.path(), vec![update(target, false, 1)], 2).unwrap();

        for (id, bytes) in untouched {
            assert_eq!(fs::read(shard_path(dir.path(), id)).unwrap(), bytes);
        }
        assert_eq!(read_curation_metadata(dir.path()).unwrap()[target].updated_at, 2);
    }

    #[test]
    fn folder_scoped_reads_return_only_requested_records_at_library_scale() {
        for count in [10_000, 100_000] {
            let dir = tempdir().unwrap();
            prepare_store(dir.path()).unwrap();
            let mut grouped = HashMap::<u8, HashMap<String, ImageCuration>>::new();
            for index in 0..count {
                let path = format!("C:/library/unrelated/{index}.jpg");
                grouped.entry(shard_id(&path)).or_default().insert(
                    path.clone(),
                    ImageCuration { path, favorite: true, rating: 3, updated_at: 1 },
                );
            }
            let requested =
                ["C:/library/active/one.jpg".to_string(), "C:/library/active/two.jpg".to_string()];
            for path in &requested {
                grouped.entry(shard_id(path)).or_default().insert(
                    path.clone(),
                    ImageCuration { path: path.clone(), favorite: true, rating: 5, updated_at: 2 },
                );
            }
            for (id, shard) in grouped {
                write_metadata_file(&shard_path(dir.path(), id), &shard).unwrap();
            }

            let metadata = read_curation_metadata_for_paths(dir.path(), &requested).unwrap();
            assert_eq!(metadata.len(), requested.len());
            assert!(metadata.keys().all(|path| path.starts_with("C:/library/active/")));
        }
    }

    #[test]
    #[ignore = "manual scalability benchmark"]
    fn benchmark_curation_shards_at_10k_and_100k_entries() {
        for count in [10_000, 100_000] {
            let dir = tempdir().unwrap();
            let updates: Vec<_> = (0..count)
                .map(|index| update(&format!("C:/library/{index}.jpg"), true, 3))
                .collect();
            let seed_started = Instant::now();
            write_curation_updates(dir.path(), updates, 1).unwrap();
            let seed_elapsed = seed_started.elapsed();
            let edit_started = Instant::now();
            write_curation_updates(
                dir.path(),
                vec![update(&format!("C:/library/{}.jpg", count / 2), true, 5)],
                2,
            )
            .unwrap();
            eprintln!(
                "curation benchmark: {count} entries, seed={:?}, single_edit={:?}",
                seed_elapsed,
                edit_started.elapsed()
            );
        }
    }
}
