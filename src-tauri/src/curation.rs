use crate::atomic_file::{build_unique_sibling_path, write_text_file_atomically};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const LEGACY_FILE_NAME: &str = "curation.json";
const STORE_DIRECTORY_NAME: &str = "curation";
const JOURNAL_FILE_NAME: &str = "pending.json";

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
        shard.extend(read_metadata_file(&path)?);
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
        let mut shard = read_metadata_file(&path)?;
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
    migrate_legacy_store(config_dir)?;
    fs::create_dir_all(store_directory(config_dir))
        .map_err(|error| format!("Failed to create curation store: {error}"))?;
    recover_pending_journal(config_dir)
}

pub(crate) fn read_curation_metadata(
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
            metadata.extend(read_metadata_file(&path)?);
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
