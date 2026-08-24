use std::fs;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use windows::{
    core::PCWSTR,
    Win32::Storage::FileSystem::{ReplaceFileW, REPLACE_FILE_FLAGS},
};

#[cfg(windows)]
fn encode_windows_api_path(path: &Path) -> Result<Vec<u16>, String> {
    let absolute = std::path::absolute(path)
        .map_err(|error| format!("Failed to resolve Windows path '{}': {error}", path.display()))?;
    let path_wide: Vec<u16> = absolute.as_os_str().encode_wide().collect();
    let verbatim_prefix = [b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    let device_prefix = [b'\\' as u16, b'\\' as u16, b'.' as u16, b'\\' as u16];
    let unc_prefix = [b'\\' as u16, b'\\' as u16];

    let mut encoded =
        if path_wide.starts_with(&verbatim_prefix) || path_wide.starts_with(&device_prefix) {
            path_wide
        } else if path_wide.starts_with(&unc_prefix) {
            "\\\\?\\UNC\\".encode_utf16().chain(path_wide.into_iter().skip(2)).collect()
        } else {
            "\\\\?\\".encode_utf16().chain(path_wide).collect()
        };
    encoded.push(0);
    Ok(encoded)
}

pub(crate) fn build_unique_sibling_path(
    source_path: &Path,
    label: &str,
) -> Result<PathBuf, String> {
    let parent_dir = source_path
        .parent()
        .ok_or_else(|| "Source path must include a parent directory".to_string())?;
    let stem = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Source file name is invalid".to_string())?;
    let extension = source_path.extension().and_then(|value| value.to_str()).unwrap_or("img");
    let unique_suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    let mut attempt = 0_u32;
    loop {
        let candidate = parent_dir
            .join(format!("{}.{}-{}-{}.{}", stem, label, unique_suffix, attempt, extension));
        if !candidate.exists() {
            return Ok(candidate);
        }
        attempt = attempt.saturating_add(1);
    }
}

pub(crate) fn write_text_file_atomically(
    path: &Path,
    content: &str,
    label: &str,
) -> Result<(), String> {
    let parent_dir =
        path.parent().ok_or_else(|| format!("{} path must include a parent directory", label))?;
    fs::create_dir_all(parent_dir)
        .map_err(|error| format!("Failed to create {} directory: {}", label, error))?;

    let temp_path = build_unique_sibling_path(path, &format!("lightframe-{}", label))?;
    fs::write(&temp_path, content)
        .map_err(|error| format!("Failed to write temporary {} file: {}", label, error))?;

    if path.exists() {
        replace_file_safely_with_label(&temp_path, path, label)
    } else {
        fs::rename(&temp_path, path).map_err(|error| {
            let _ = fs::remove_file(&temp_path);
            format!("Failed to finalize {} file: {}", label, error)
        })
    }
}

pub(crate) fn replace_file_safely(temp_path: &Path, destination_path: &Path) -> Result<(), String> {
    replace_file_safely_with_label(temp_path, destination_path, "image")
}

fn replace_file_safely_with_label(
    temp_path: &Path,
    destination_path: &Path,
    label: &str,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let backup_path = build_unique_sibling_path(destination_path, "lightframe-replace-backup")?;
        let destination_wide = encode_windows_api_path(destination_path)?;
        let temp_wide = encode_windows_api_path(temp_path)?;
        let backup_wide = encode_windows_api_path(&backup_path)?;
        // SAFETY: all three paths are null-terminated UTF-16 buffers that remain alive for the
        // duration of the call, and the reserved pointer parameters are required to be null.
        let replace_result = unsafe {
            ReplaceFileW(
                PCWSTR(destination_wide.as_ptr()),
                PCWSTR(temp_wide.as_ptr()),
                PCWSTR(backup_wide.as_ptr()),
                REPLACE_FILE_FLAGS(0),
                None,
                None,
            )
        };

        match replace_result {
            Ok(()) => fs::remove_file(&backup_path).map_err(|error| {
                format!(
                    "Replaced {label} file but failed to clear recovery backup '{}': {error}",
                    backup_path.display()
                )
            }),
            Err(error) => {
                let recovery_result = if destination_path.exists() {
                    Ok(())
                } else if backup_path.exists() {
                    fs::rename(&backup_path, destination_path)
                } else if temp_path.exists() {
                    fs::rename(temp_path, destination_path)
                } else {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "no replacement file survived",
                    ))
                };

                if destination_path.exists() && temp_path.exists() {
                    let _ = fs::remove_file(temp_path);
                }
                let recovery_message = recovery_result
                    .err()
                    .map(|recovery_error| {
                        format!("; failed to restore a live destination: {recovery_error}")
                    })
                    .unwrap_or_default();
                Err(format!("Failed to replace {label} file: {error}{recovery_message}"))
            }
        }
    }

    #[cfg(not(windows))]
    {
        fs::rename(temp_path, destination_path)
            .map_err(|error| format!("Failed to replace {} file: {}", label, error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn atomic_text_write_replaces_existing_content() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("state.json");
        fs::write(&path, "old").unwrap();

        write_text_file_atomically(&path, "new", "test state").unwrap();

        assert_eq!(fs::read_to_string(path).unwrap(), "new");
    }

    #[cfg(windows)]
    #[test]
    fn windows_replacement_does_not_leave_staged_backups() {
        let dir = tempdir().unwrap();
        let destination = dir.path().join("state.json");
        let replacement = dir.path().join("replacement.json");
        fs::write(&destination, "old").unwrap();
        fs::write(&replacement, "new").unwrap();

        replace_file_safely(&replacement, &destination).unwrap();

        assert_eq!(fs::read_to_string(destination).unwrap(), "new");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn windows_replacement_supports_extended_length_paths() {
        let dir = tempdir().unwrap();
        let mut nested = dir.path().to_path_buf();
        for index in 0..6 {
            nested.push(format!("segment-{index}-abcdefghijklmnopqrstuvwxyz0123456789"));
        }
        fs::create_dir_all(&nested).unwrap();
        let destination = nested.join("state.json");
        let replacement = nested.join("replacement.json");
        assert!(destination.as_os_str().encode_wide().count() > 260);
        fs::write(&destination, "old").unwrap();
        fs::write(&replacement, "new").unwrap();

        replace_file_safely(&replacement, &destination).unwrap();

        assert_eq!(fs::read_to_string(destination).unwrap(), "new");
    }
}
