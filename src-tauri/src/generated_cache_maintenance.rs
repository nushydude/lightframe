use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub(crate) const MAX_CACHE_ENTRIES: usize = 2_000;
pub(crate) const MAX_CACHE_BYTES: u64 = 256 * 1024 * 1024;

static CACHE_MAINTENANCE: OnceLock<Mutex<CacheMaintenanceRegistry>> = OnceLock::new();

#[derive(Default)]
struct CacheMaintenanceRegistry {
    scheduled: HashSet<PathBuf>,
    reconciled: HashSet<PathBuf>,
    estimated: HashMap<PathBuf, (usize, u64)>,
    write_revisions: HashMap<PathBuf, u64>,
}

fn cache_maintenance_registry() -> &'static Mutex<CacheMaintenanceRegistry> {
    CACHE_MAINTENANCE.get_or_init(|| Mutex::new(CacheMaintenanceRegistry::default()))
}

/// Ensures a generated-cache root exists and schedules at most one background reconciliation.
pub(crate) fn ensure_cache_root(cache_root: &Path, cleanup: fn(&Path)) -> bool {
    match std::fs::create_dir_all(cache_root) {
        Ok(_) => {
            schedule_cache_reconciliation(cache_root, cleanup);
            true
        }
        Err(error) => {
            eprintln!(
                "Warning: generated image cache unavailable at '{}': {}",
                cache_root.display(),
                error
            );
            false
        }
    }
}

/// Accounts for a generated file and schedules maintenance when the estimate is not reconciled.
pub(crate) fn record_cache_write(cache_root: &Path, bytes: u64, cleanup: fn(&Path)) {
    let root = cache_root.to_path_buf();
    let should_schedule = {
        let mut registry =
            cache_maintenance_registry().lock().unwrap_or_else(|error| error.into_inner());
        let revision = registry.write_revisions.entry(root.clone()).or_default();
        *revision = revision.saturating_add(1);
        let (entry_count, total_bytes) = {
            let estimate = registry.estimated.entry(root.clone()).or_default();
            estimate.0 = estimate.0.saturating_add(1);
            estimate.1 = estimate.1.saturating_add(bytes);
            *estimate
        };
        if entry_count > MAX_CACHE_ENTRIES || total_bytes > MAX_CACHE_BYTES {
            registry.reconciled.remove(&root);
        }
        !registry.reconciled.contains(&root)
    };
    if should_schedule {
        schedule_cache_reconciliation(&root, cleanup);
    }
}

fn schedule_cache_reconciliation(cache_root: &Path, cleanup: fn(&Path)) {
    let root = cache_root.to_path_buf();
    let schedule_revision = {
        let mut registry =
            cache_maintenance_registry().lock().unwrap_or_else(|error| error.into_inner());
        if registry.reconciled.contains(&root) || registry.scheduled.contains(&root) {
            None
        } else {
            registry.scheduled.insert(root.clone());
            Some(registry.write_revisions.get(&root).copied().unwrap_or(0))
        }
    };
    let Some(schedule_revision) = schedule_revision else {
        return;
    };

    std::thread::spawn(move || {
        cleanup(&root);
        let should_reschedule = {
            let mut registry =
                cache_maintenance_registry().lock().unwrap_or_else(|error| error.into_inner());
            registry.scheduled.remove(&root);
            let current_revision = registry.write_revisions.get(&root).copied().unwrap_or(0);
            if !should_reschedule_after_reconciliation(schedule_revision, current_revision) {
                registry.reconciled.insert(root.clone());
                registry.estimated.insert(root.clone(), (0, 0));
                false
            } else {
                registry.reconciled.remove(&root);
                registry.estimated.insert(
                    root.clone(),
                    (MAX_CACHE_ENTRIES.saturating_add(1), MAX_CACHE_BYTES.saturating_add(1)),
                );
                true
            }
        };
        if should_reschedule {
            schedule_cache_reconciliation(&root, cleanup);
        }
    });
}

fn should_reschedule_after_reconciliation(start_revision: u64, current_revision: u64) -> bool {
    start_revision != current_revision
}

#[cfg(test)]
mod tests {
    use super::should_reschedule_after_reconciliation;

    #[test]
    fn reconciliation_only_reschedules_when_writes_land_during_scan() {
        assert!(!should_reschedule_after_reconciliation(7, 7));
        assert!(should_reschedule_after_reconciliation(7, 8));
    }
}
