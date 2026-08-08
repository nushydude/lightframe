use std::fs;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[allow(dead_code)]
pub enum PathCaseSemantics {
    #[serde(rename = "case-sensitive")]
    Sensitive,
    #[serde(rename = "case-insensitive")]
    Insensitive,
}

pub const fn runtime_path_case_semantics() -> PathCaseSemantics {
    #[cfg(windows)]
    {
        PathCaseSemantics::Insensitive
    }
    #[cfg(not(windows))]
    {
        PathCaseSemantics::Sensitive
    }
}

#[cfg(windows)]
fn is_known_unsupported_case_sensitivity_query_hresult(code: windows::core::HRESULT) -> bool {
    matches!(
        code.0 as u32,
        0x8007_0057 // HRESULT_FROM_WIN32(ERROR_INVALID_PARAMETER)
            | 0x8007_0032 // HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED)
            | 0x8007_0001 // HRESULT_FROM_WIN32(ERROR_INVALID_FUNCTION)
            | 0x0000_0057 // ERROR_INVALID_PARAMETER, for APIs that surface raw Win32 codes
            | 0x0000_0032 // ERROR_NOT_SUPPORTED
            | 0x0000_0001 // ERROR_INVALID_FUNCTION
    )
}

pub fn directory_path_case_semantics(directory: &fs::File) -> Result<PathCaseSemantics, String> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::{
            FileCaseSensitiveInfo, GetFileInformationByHandleEx, FILE_CASE_SENSITIVE_INFO,
        };
        use windows::Win32::System::SystemServices::FILE_CS_FLAG_CASE_SENSITIVE_DIR;

        let mut info = FILE_CASE_SENSITIVE_INFO::default();
        let query_result = unsafe {
            GetFileInformationByHandleEx(
                HANDLE(directory.as_raw_handle()),
                FileCaseSensitiveInfo,
                (&mut info as *mut FILE_CASE_SENSITIVE_INFO).cast(),
                std::mem::size_of::<FILE_CASE_SENSITIVE_INFO>() as u32,
            )
        };
        if let Err(error) = query_result {
            if is_known_unsupported_case_sensitivity_query_hresult(error.code()) {
                // Older Windows/filesystem combinations can reject FileCaseSensitiveInfo even
                // for otherwise valid directory handles. Fall back to the conservative identity
                // model so containment checks never collapse two distinct spellings.
                return Ok(PathCaseSemantics::Sensitive);
            }
            return Err(format!("Failed to query directory case-sensitivity: {error}"));
        }
        if info.Flags & FILE_CS_FLAG_CASE_SENSITIVE_DIR != 0 {
            Ok(PathCaseSemantics::Sensitive)
        } else {
            Ok(PathCaseSemantics::Insensitive)
        }
    }
    #[cfg(not(windows))]
    {
        let _ = directory;
        Ok(PathCaseSemantics::Sensitive)
    }
}

pub fn directory_path_case_semantics_for_path(path: &Path) -> Result<PathCaseSemantics, String> {
    #[cfg(windows)]
    let directory = {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
            .open(path)
            .map_err(|error| {
                format!("Failed to open directory for case-sensitivity query: {error}")
            })?
    };
    #[cfg(not(windows))]
    let directory = fs::File::open(path)
        .map_err(|error| format!("Failed to open directory for case-sensitivity query: {error}"))?;
    directory_path_case_semantics(&directory)
}

pub fn normalize_path_text_for_key_with_semantics(
    path: &str,
    semantics: PathCaseSemantics,
) -> String {
    let normalized = path.trim().replace('\\', "/");
    match semantics {
        PathCaseSemantics::Sensitive => normalized,
        PathCaseSemantics::Insensitive => normalized.to_lowercase(),
    }
}

#[allow(dead_code)]
pub fn normalize_path_text_for_key(path: &str) -> String {
    normalize_path_text_for_key_with_semantics(path, runtime_path_case_semantics())
}

pub fn normalize_path_for_key_with_semantics(path: &Path, semantics: PathCaseSemantics) -> String {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map(|cwd| cwd.join(path)).unwrap_or_else(|_| path.to_path_buf())
    };
    let canonical = fs::canonicalize(&absolute).unwrap_or(absolute);
    normalize_path_text_for_key_with_semantics(&canonical.to_string_lossy(), semantics)
}

pub fn normalize_path_for_key(path: &Path) -> String {
    normalize_path_for_key_with_semantics(path, runtime_path_case_semantics())
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

    #[test]
    fn runtime_text_identity_obeys_platform_case_semantics() {
        let upper = normalize_path_text_for_key("/photos/A.jpg");
        let lower = normalize_path_text_for_key("/photos/a.jpg");
        if cfg!(windows) {
            assert_eq!(upper, lower);
        } else {
            assert_ne!(upper, lower);
        }
    }

    #[test]
    fn path_case_semantics_wire_values_match_frontend_contract() {
        assert_eq!(
            serde_json::to_string(&PathCaseSemantics::Sensitive).unwrap(),
            "\"case-sensitive\""
        );
        assert_eq!(
            serde_json::to_string(&PathCaseSemantics::Insensitive).unwrap(),
            "\"case-insensitive\""
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_known_case_query_compatibility_errors_are_classified() {
        use windows::core::HRESULT;

        for code in [
            0x8007_0057u32,
            0x8007_0032u32,
            0x8007_0001u32,
            0x0000_0057u32,
            0x0000_0032u32,
            0x0000_0001u32,
        ] {
            assert!(super::is_known_unsupported_case_sensitivity_query_hresult(HRESULT(
                code as i32
            )));
        }

        assert!(!super::is_known_unsupported_case_sensitivity_query_hresult(HRESULT(
            0x8007_0005u32 as i32
        )));
    }
}
