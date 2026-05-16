use crate::commands::{
    image_file_from_path, is_supported_image_path, sort_image_files_by_name, ImageFile,
};
use crate::{folder_index, path_normalization::normalize_path_for_key};
use notify::event::{ModifyKind, RenameMode};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const FOLDER_WATCHER_EVENT: &str = "folder-watcher-changed";
const DEBOUNCE_INTERVAL: Duration = Duration::from_millis(250);
const RAW_EVENT_FULL_REFRESH_THRESHOLD: usize = 128;
const CHANGE_FULL_REFRESH_THRESHOLD: usize = 64;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderWatcherPayload {
    pub folder_path: String,
    pub changes: Vec<FolderWatcherChange>,
    pub requires_full_refresh: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderWatcherChange {
    pub kind: FolderWatcherChangeKind,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<ImageFile>,
    #[serde(skip_serializing)]
    split_rename_side: Option<SplitRenameSide>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FolderWatcherChangeKind {
    Added,
    Removed,
    Modified,
    Renamed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SplitRenameSide {
    From,
    To,
}

#[derive(Debug, Default)]
struct EventClassification {
    changes: Vec<FolderWatcherChange>,
    requires_full_refresh: bool,
}

enum WatcherMessage {
    Event(notify::Result<Event>),
    Shutdown,
}

struct FolderWatcherSession {
    _watcher: RecommendedWatcher,
    sender: Sender<WatcherMessage>,
    worker: Option<JoinHandle<()>>,
    watch_id: String,
}

impl FolderWatcherSession {
    fn shutdown(mut self) {
        let _ = self.sender.send(WatcherMessage::Shutdown);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[tauri::command]
pub fn watch_folder(app: AppHandle, folder_path: String, watch_id: String) -> Result<(), String> {
    let folder_path = PathBuf::from(folder_path);
    if !folder_path.is_dir() {
        return Err(format!("'{}' is not a valid directory", folder_path.display()));
    }

    let session = create_watcher_session(app, folder_path, watch_id)?;
    let previous = {
        let mut active = active_watcher().lock().unwrap_or_else(|err| err.into_inner());
        active.replace(session)
    };

    if let Some(previous) = previous {
        previous.shutdown();
    }

    Ok(())
}

#[tauri::command]
pub fn unwatch_folder(watch_id: Option<String>) -> Result<(), String> {
    if let Some(watch_id) = watch_id {
        unwatch_active_folder_by_id(&watch_id);
    } else {
        unwatch_active_folder();
    }
    Ok(())
}

pub fn unwatch_active_folder() {
    shutdown_active_watcher(None);
}

fn unwatch_active_folder_by_id(watch_id: &str) {
    shutdown_active_watcher(Some(watch_id));
}

fn shutdown_active_watcher(expected_watch_id: Option<&str>) {
    let previous = {
        let mut active = active_watcher().lock().unwrap_or_else(|err| err.into_inner());
        let should_take = active
            .as_ref()
            .map(|session| {
                expected_watch_id.map(|watch_id| session.watch_id == watch_id).unwrap_or(true)
            })
            .unwrap_or(false);

        if should_take {
            active.take()
        } else {
            None
        }
    };

    if let Some(previous) = previous {
        previous.shutdown();
    }
}

fn active_watcher() -> &'static Mutex<Option<FolderWatcherSession>> {
    static ACTIVE_WATCHER: OnceLock<Mutex<Option<FolderWatcherSession>>> = OnceLock::new();
    ACTIVE_WATCHER.get_or_init(|| Mutex::new(None))
}

fn create_watcher_session(
    app: AppHandle,
    folder_path: PathBuf,
    watch_id: String,
) -> Result<FolderWatcherSession, String> {
    let (sender, receiver) = mpsc::channel::<WatcherMessage>();
    let watcher_sender = sender.clone();
    let mut watcher = RecommendedWatcher::new(
        move |result| {
            let _ = watcher_sender.send(WatcherMessage::Event(result));
        },
        Config::default(),
    )
    .map_err(|err| format!("Failed to create folder watcher: {}", err))?;

    watcher
        .watch(&folder_path, RecursiveMode::NonRecursive)
        .map_err(|err| format!("Failed to watch folder '{}': {}", folder_path.display(), err))?;

    let worker_folder_path = folder_path.clone();
    let worker = thread::spawn(move || run_watcher_worker(app, worker_folder_path, receiver));

    Ok(FolderWatcherSession { _watcher: watcher, sender, worker: Some(worker), watch_id })
}

fn run_watcher_worker(app: AppHandle, folder_path: PathBuf, receiver: Receiver<WatcherMessage>) {
    while let Ok(WatcherMessage::Event(first_event)) = receiver.recv() {
        let mut results = vec![first_event];
        let mut should_shutdown = false;

        loop {
            match receiver.recv_timeout(DEBOUNCE_INTERVAL) {
                Ok(WatcherMessage::Event(result)) => results.push(result),
                Ok(WatcherMessage::Shutdown) => {
                    should_shutdown = true;
                    break;
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    should_shutdown = true;
                    break;
                }
            }

            if results.len() > RAW_EVENT_FULL_REFRESH_THRESHOLD {
                break;
            }
        }

        if should_shutdown {
            break;
        }

        publish_watcher_batch(&app, &folder_path, results);
    }
}

fn publish_watcher_batch(
    app: &AppHandle,
    folder_path: &Path,
    raw_results: Vec<notify::Result<Event>>,
) {
    let mut requires_full_refresh = raw_results.len() > RAW_EVENT_FULL_REFRESH_THRESHOLD;
    let mut changes = Vec::new();

    for result in raw_results {
        match result {
            Ok(event) => {
                let classification = classify_notify_event(&event);
                changes.extend(classification.changes);
                requires_full_refresh |= classification.requires_full_refresh;
            }
            Err(err) => {
                eprintln!(
                    "Folder watcher error for '{}': {}. Falling back to full refresh.",
                    folder_path.display(),
                    err
                );
                requires_full_refresh = true;
            }
        }
    }

    let pairing = pair_split_rename_changes(changes);
    requires_full_refresh |= pairing.requires_full_refresh;

    let mut changes = coalesce_repeated_changes(pairing.changes);
    if changes.len() > CHANGE_FULL_REFRESH_THRESHOLD {
        changes.clear();
        requires_full_refresh = true;
    }

    if changes.is_empty() && !requires_full_refresh {
        return;
    }

    let payload = FolderWatcherPayload {
        folder_path: folder_path.to_string_lossy().to_string(),
        changes,
        requires_full_refresh,
    };

    let index_changes =
        if !payload.requires_full_refresh { Some(payload.changes.clone()) } else { None };

    if let Err(err) = app.emit(FOLDER_WATCHER_EVENT, payload) {
        eprintln!("Failed to emit folder watcher update for '{}': {}", folder_path.display(), err);
    }

    if let Some(changes) = index_changes {
        update_persistent_folder_index(app, folder_path, &changes);
    }
}

fn classify_notify_event(event: &Event) -> EventClassification {
    match &event.kind {
        EventKind::Create(_) => classify_added_paths(&event.paths),
        EventKind::Remove(_) => classify_removed_paths(&event.paths),
        EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Metadata(_)) => {
            classify_modified_paths(&event.paths)
        }
        EventKind::Modify(ModifyKind::Name(rename_mode)) => {
            classify_rename_paths(&event.paths, *rename_mode)
        }
        EventKind::Modify(ModifyKind::Any) => {
            let changes = event
                .paths
                .iter()
                .filter_map(|path| {
                    if path.is_file() {
                        modified_change(path)
                    } else if is_supported_image_path(path) {
                        removed_change(path)
                    } else {
                        None
                    }
                })
                .collect();

            EventClassification { changes, requires_full_refresh: true }
        }
        EventKind::Any => EventClassification {
            changes: Vec::new(),
            requires_full_refresh: !event.paths.is_empty(),
        },
        EventKind::Access(_) | EventKind::Modify(_) | EventKind::Other => {
            EventClassification::default()
        }
    }
}

fn classify_added_paths(paths: &[PathBuf]) -> EventClassification {
    EventClassification {
        changes: paths.iter().filter_map(|path| added_change(path)).collect(),
        requires_full_refresh: false,
    }
}

fn classify_removed_paths(paths: &[PathBuf]) -> EventClassification {
    EventClassification {
        changes: paths.iter().filter_map(|path| removed_change(path)).collect(),
        requires_full_refresh: false,
    }
}

fn classify_modified_paths(paths: &[PathBuf]) -> EventClassification {
    EventClassification {
        changes: paths.iter().filter_map(|path| modified_change(path)).collect(),
        requires_full_refresh: false,
    }
}

fn classify_rename_paths(paths: &[PathBuf], rename_mode: RenameMode) -> EventClassification {
    if paths.len() >= 2 {
        return classify_rename_pair(&paths[0], &paths[1]);
    }

    match (rename_mode, paths.first()) {
        (RenameMode::From, Some(path)) => {
            classify_removed_rename_from_paths(std::slice::from_ref(path))
        }
        (RenameMode::To, Some(path)) => classify_added_rename_to_paths(std::slice::from_ref(path)),
        (_, Some(path)) if path.is_file() => EventClassification {
            changes: added_change(path).into_iter().collect(),
            requires_full_refresh: true,
        },
        (_, Some(path)) if is_supported_image_path(path) => EventClassification {
            changes: removed_change(path).into_iter().collect(),
            requires_full_refresh: true,
        },
        _ => EventClassification::default(),
    }
}

fn classify_rename_pair(old_path: &Path, new_path: &Path) -> EventClassification {
    let old_supported = is_supported_image_path(old_path);
    let new_image = image_file_from_path(new_path);

    let change = match (old_supported, new_image) {
        (true, Some(image)) => Some(FolderWatcherChange {
            kind: FolderWatcherChangeKind::Renamed,
            path: path_string(new_path),
            old_path: Some(path_string(old_path)),
            image: Some(image),
            split_rename_side: None,
        }),
        (true, None) => removed_change(old_path),
        (false, Some(image)) => Some(FolderWatcherChange {
            kind: FolderWatcherChangeKind::Added,
            path: path_string(new_path),
            old_path: None,
            image: Some(image),
            split_rename_side: None,
        }),
        (false, None) => None,
    };

    EventClassification { changes: change.into_iter().collect(), requires_full_refresh: false }
}

fn added_change(path: &Path) -> Option<FolderWatcherChange> {
    added_change_with_rename_side(path, None)
}

fn added_change_with_rename_side(
    path: &Path,
    split_rename_side: Option<SplitRenameSide>,
) -> Option<FolderWatcherChange> {
    image_file_from_path(path).map(|image| FolderWatcherChange {
        kind: FolderWatcherChangeKind::Added,
        path: path_string(path),
        old_path: None,
        image: Some(image),
        split_rename_side,
    })
}

fn removed_change(path: &Path) -> Option<FolderWatcherChange> {
    removed_change_with_rename_side(path, None)
}

fn removed_change_with_rename_side(
    path: &Path,
    split_rename_side: Option<SplitRenameSide>,
) -> Option<FolderWatcherChange> {
    if !is_supported_image_path(path) {
        return None;
    }

    Some(FolderWatcherChange {
        kind: FolderWatcherChangeKind::Removed,
        path: path_string(path),
        old_path: None,
        image: None,
        split_rename_side,
    })
}

fn modified_change(path: &Path) -> Option<FolderWatcherChange> {
    image_file_from_path(path).map(|image| FolderWatcherChange {
        kind: FolderWatcherChangeKind::Modified,
        path: path_string(path),
        old_path: None,
        image: Some(image),
        split_rename_side: None,
    })
}

fn classify_added_rename_to_paths(paths: &[PathBuf]) -> EventClassification {
    EventClassification {
        changes: paths
            .iter()
            .filter_map(|path| added_change_with_rename_side(path, Some(SplitRenameSide::To)))
            .collect(),
        requires_full_refresh: false,
    }
}

fn classify_removed_rename_from_paths(paths: &[PathBuf]) -> EventClassification {
    EventClassification {
        changes: paths
            .iter()
            .filter_map(|path| removed_change_with_rename_side(path, Some(SplitRenameSide::From)))
            .collect(),
        requires_full_refresh: false,
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
struct SplitRenamePairing {
    changes: Vec<FolderWatcherChange>,
    requires_full_refresh: bool,
}

fn pair_split_rename_changes(changes: Vec<FolderWatcherChange>) -> SplitRenamePairing {
    let mut paired = Vec::new();
    let mut pending_from: Option<FolderWatcherChange> = None;
    let mut requires_full_refresh = false;

    for change in changes {
        match change.split_rename_side {
            Some(SplitRenameSide::From) => {
                if let Some(previous_from) = pending_from.take() {
                    paired.push(clear_split_rename_side(previous_from));
                    paired.push(clear_split_rename_side(change));
                    requires_full_refresh = true;
                } else {
                    pending_from = Some(change);
                }
            }
            Some(SplitRenameSide::To) => {
                if let Some(from_change) = pending_from.take() {
                    paired.push(FolderWatcherChange {
                        kind: FolderWatcherChangeKind::Renamed,
                        path: change.path,
                        old_path: Some(from_change.path),
                        image: change.image,
                        split_rename_side: None,
                    });
                } else {
                    paired.push(clear_split_rename_side(change));
                }
            }
            None => {
                paired.push(change);
            }
        }
    }

    if let Some(from_change) = pending_from {
        paired.push(clear_split_rename_side(from_change));
    }

    SplitRenamePairing { changes: paired, requires_full_refresh }
}

fn clear_split_rename_side(mut change: FolderWatcherChange) -> FolderWatcherChange {
    change.split_rename_side = None;
    change
}

fn coalesce_repeated_changes(changes: Vec<FolderWatcherChange>) -> Vec<FolderWatcherChange> {
    let mut coalesced = Vec::new();
    let mut positions_by_key = HashMap::<String, usize>::new();

    for change in changes {
        let key = coalesce_key(&change);
        if let Some(index) = positions_by_key.get(&key).copied() {
            coalesced[index] = change;
        } else {
            positions_by_key.insert(key, coalesced.len());
            coalesced.push(change);
        }
    }

    coalesced
}

fn coalesce_key(change: &FolderWatcherChange) -> String {
    format!(
        "{:?}|{}|{}",
        change.kind,
        normalize_path_for_key(Path::new(&change.path)),
        change
            .old_path
            .as_deref()
            .map(|path| normalize_path_for_key(Path::new(path)))
            .unwrap_or_default()
    )
}

fn update_persistent_folder_index(
    app: &AppHandle,
    folder_path: &Path,
    changes: &[FolderWatcherChange],
) {
    let index_root = match app.path().app_cache_dir() {
        Ok(cache_dir) => folder_index::index_root(&cache_dir),
        Err(err) => {
            eprintln!(
                "Failed to resolve app cache directory for folder watcher index update: {}",
                err
            );
            return;
        }
    };

    let existing_images = folder_index::read_folder_images(&index_root, folder_path);
    if existing_images.is_empty() {
        return;
    }

    let mut images_by_key: HashMap<String, ImageFile> = existing_images
        .into_iter()
        .map(|image| (normalize_path_for_key(Path::new(&image.path)), image))
        .collect();

    for change in changes {
        apply_index_change(&mut images_by_key, change);
    }

    let mut images: Vec<ImageFile> = images_by_key.into_values().collect();
    sort_image_files_by_name(&mut images);

    if let Err(err) = folder_index::write_folder_images(&index_root, folder_path, &images) {
        eprintln!(
            "Failed to update persistent folder index from watcher changes for '{}': {}",
            folder_path.display(),
            err
        );
    }
}

fn apply_index_change(
    images_by_key: &mut HashMap<String, ImageFile>,
    change: &FolderWatcherChange,
) {
    match change.kind {
        FolderWatcherChangeKind::Added | FolderWatcherChangeKind::Modified => {
            if let Some(image) = &change.image {
                images_by_key.insert(normalize_path_for_key(Path::new(&image.path)), image.clone());
            }
        }
        FolderWatcherChangeKind::Removed => {
            images_by_key.remove(&normalize_path_for_key(Path::new(&change.path)));
        }
        FolderWatcherChangeKind::Renamed => {
            if let Some(old_path) = &change.old_path {
                images_by_key.remove(&normalize_path_for_key(Path::new(old_path)));
            }
            if let Some(image) = &change.image {
                images_by_key.insert(normalize_path_for_key(Path::new(&image.path)), image.clone());
            }
        }
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, MetadataKind, RemoveKind};
    use tempfile::tempdir;

    fn event(kind: EventKind, paths: Vec<PathBuf>) -> Event {
        Event { kind, paths, attrs: Default::default() }
    }

    #[test]
    fn classifies_created_supported_images_as_added() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("new.jpg");
        std::fs::write(&image_path, b"image").unwrap();

        let classification =
            classify_notify_event(&event(EventKind::Create(CreateKind::File), vec![image_path]));

        assert!(!classification.requires_full_refresh);
        assert_eq!(classification.changes.len(), 1);
        assert_eq!(classification.changes[0].kind, FolderWatcherChangeKind::Added);
        assert_eq!(classification.changes[0].image.as_ref().unwrap().file_name, "new.jpg");
    }

    #[test]
    fn classifies_removed_supported_images_even_when_file_is_gone() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("removed.png");

        let classification =
            classify_notify_event(&event(EventKind::Remove(RemoveKind::File), vec![image_path]));

        assert!(!classification.requires_full_refresh);
        assert_eq!(classification.changes.len(), 1);
        assert_eq!(classification.changes[0].kind, FolderWatcherChangeKind::Removed);
        assert!(classification.changes[0].image.is_none());
    }

    #[test]
    fn classifies_renamed_images_with_old_and_new_paths() {
        let dir = tempdir().unwrap();
        let old_path = dir.path().join("old.jpg");
        let new_path = dir.path().join("new.jpg");
        std::fs::write(&new_path, b"image").unwrap();

        let classification = classify_notify_event(&event(
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            vec![old_path.clone(), new_path.clone()],
        ));

        assert!(!classification.requires_full_refresh);
        assert_eq!(classification.changes.len(), 1);
        assert_eq!(classification.changes[0].kind, FolderWatcherChangeKind::Renamed);
        let expected_old_path = path_string(&old_path);
        assert_eq!(classification.changes[0].old_path.as_deref(), Some(expected_old_path.as_str()));
        assert_eq!(classification.changes[0].path, path_string(&new_path));
    }

    #[test]
    fn pairs_split_rename_events_with_old_and_new_paths() {
        let dir = tempdir().unwrap();
        let old_path = dir.path().join("old.jpg");
        let new_path = dir.path().join("new.jpg");
        std::fs::write(&new_path, b"image").unwrap();

        let from = classify_notify_event(&event(
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            vec![old_path.clone()],
        ));
        let to = classify_notify_event(&event(
            EventKind::Modify(ModifyKind::Name(RenameMode::To)),
            vec![new_path.clone()],
        ));
        let paired =
            pair_split_rename_changes(from.changes.into_iter().chain(to.changes).collect());

        assert!(!paired.requires_full_refresh);
        assert_eq!(paired.changes.len(), 1);
        assert_eq!(paired.changes[0].kind, FolderWatcherChangeKind::Renamed);
        let expected_old_path = path_string(&old_path);
        assert_eq!(paired.changes[0].old_path.as_deref(), Some(expected_old_path.as_str()));
        assert_eq!(paired.changes[0].path, path_string(&new_path));
    }

    #[test]
    fn falls_back_for_ambiguous_split_rename_events() {
        let dir = tempdir().unwrap();
        let old_a_path = dir.path().join("old-a.jpg");
        let old_b_path = dir.path().join("old-b.jpg");
        let new_a_path = dir.path().join("new-a.jpg");
        let new_b_path = dir.path().join("new-b.jpg");
        std::fs::write(&new_a_path, b"image").unwrap();
        std::fs::write(&new_b_path, b"image").unwrap();

        let old_a = classify_notify_event(&event(
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            vec![old_a_path],
        ));
        let old_b = classify_notify_event(&event(
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            vec![old_b_path],
        ));
        let new_a = classify_notify_event(&event(
            EventKind::Modify(ModifyKind::Name(RenameMode::To)),
            vec![new_a_path],
        ));
        let new_b = classify_notify_event(&event(
            EventKind::Modify(ModifyKind::Name(RenameMode::To)),
            vec![new_b_path],
        ));

        let paired = pair_split_rename_changes(
            old_a
                .changes
                .into_iter()
                .chain(old_b.changes)
                .chain(new_a.changes)
                .chain(new_b.changes)
                .collect(),
        );

        assert!(paired.requires_full_refresh);
    }

    #[test]
    fn ignores_unsupported_files() {
        let dir = tempdir().unwrap();
        let text_path = dir.path().join("notes.txt");
        std::fs::write(&text_path, b"not an image").unwrap();

        let classification =
            classify_notify_event(&event(EventKind::Create(CreateKind::File), vec![text_path]));

        assert!(!classification.requires_full_refresh);
        assert!(classification.changes.is_empty());
    }

    #[test]
    fn coalesces_repeated_modified_events_for_the_same_path() {
        let dir = tempdir().unwrap();
        let image_path = dir.path().join("photo.jpg");
        std::fs::write(&image_path, b"first").unwrap();

        let first = classify_notify_event(&event(
            EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            vec![image_path.clone()],
        ));
        std::fs::write(&image_path, b"second").unwrap();
        let second = classify_notify_event(&event(
            EventKind::Modify(ModifyKind::Metadata(MetadataKind::WriteTime)),
            vec![image_path],
        ));

        let coalesced =
            coalesce_repeated_changes(first.changes.into_iter().chain(second.changes).collect());

        assert_eq!(coalesced.len(), 1);
        assert_eq!(coalesced[0].kind, FolderWatcherChangeKind::Modified);
        assert_eq!(coalesced[0].image.as_ref().unwrap().size_bytes, 6);
    }
}
