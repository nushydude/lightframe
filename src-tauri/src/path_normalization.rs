use std::fs;
use std::path::Path;

pub fn normalize_path_for_key(path: &Path) -> String {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map(|cwd| cwd.join(path)).unwrap_or_else(|_| path.to_path_buf())
    };

    let canonical = fs::canonicalize(&absolute).unwrap_or(absolute);
    let normalized = canonical.to_string_lossy().replace('\\', "/");

    #[cfg(windows)]
    {
        normalized.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        normalized
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn normalize_path_for_key_canonicalizes_relative_segments() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("images");
        std::fs::create_dir_all(&nested).unwrap();

        let normalized = normalize_path_for_key(&nested.join("."));
        let direct = normalize_path_for_key(&nested);

        assert_eq!(normalized, direct);
    }

    #[test]
    fn normalize_path_for_key_uses_absolute_paths_for_relative_inputs() {
        let current_dir = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        let normalized = normalize_path_for_key(Path::new("."));
        let expected = normalize_path_for_key(&current_dir);

        assert_eq!(normalized, expected);
    }
}
