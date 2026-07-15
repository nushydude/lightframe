use std::fs;
use std::path::{Path, PathBuf};

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
        let backup_path = build_unique_sibling_path(destination_path, "lightframe-backup")?;
        fs::rename(destination_path, &backup_path)
            .map_err(|error| format!("Failed to stage original {} file: {}", label, error))?;

        match fs::rename(temp_path, destination_path) {
            Ok(()) => {
                let _ = fs::remove_file(&backup_path);
                Ok(())
            }
            Err(error) => {
                let _ = fs::rename(&backup_path, destination_path);
                let _ = fs::remove_file(temp_path);
                Err(format!("Failed to replace {} file: {}", label, error))
            }
        }
    }

    #[cfg(not(windows))]
    {
        fs::rename(temp_path, destination_path)
            .map_err(|error| format!("Failed to replace {} file: {}", label, error))
    }
}
