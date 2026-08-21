use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct SessionId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct ImageId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct DestinationGrantId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct ExternalEditorGrantId(pub String);

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AuthorizedImageRecord {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub extension: String,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FolderSessionSnapshot {
    pub session_id: String,
    pub session_instance_id: String,
    pub canonical_folder: String,
    pub path_case_semantics: crate::path_normalization::PathCaseSemantics,
    pub catalog_revision: u64,
    pub images: Vec<AuthorizedImageRecord>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileSessionSnapshot {
    pub session_id: String,
    pub session_instance_id: String,
    pub requested_image_id: String,
    pub canonical_folder: String,
    pub path_case_semantics: crate::path_normalization::PathCaseSemantics,
    pub catalog_revision: u64,
    pub images: Vec<AuthorizedImageRecord>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProjectorDisplayRecord {
    pub session_id: String,
    pub image: AuthorizedImageRecord,
    pub images: Vec<AuthorizedImageRecord>,
    pub grant_epoch: u64,
    pub navigation_generation: u64,
}

#[derive(Debug, Clone)]
pub struct ImageRecordInternal {
    pub id: String,
    pub canonical_path: PathBuf,
    pub display_path: String,
    pub file_name: String,
    pub extension: String,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
    pub created_at: Option<String>,
    pub filesystem_identity: Option<String>,
}

fn filesystem_identity(path: &Path, metadata: &fs::Metadata) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = path;
        Some(format!("{}:{}", metadata.dev(), metadata.ino()))
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        let file = open_replaceable_image_file(path).ok()?;
        let (volume, file_id) = windows_file_identity(&file).ok()?;
        Some(format!("{volume}:{file_id}"))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, metadata);
        None
    }
}

fn filesystem_identity_for_handle(file: &fs::File) -> Result<String, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
    }
    #[cfg(windows)]
    {
        let (volume, file_id) = windows_file_identity(file)?;
        Ok(format!("{volume}:{file_id}"))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = file;
        Err("Stable filesystem identity is unavailable on this platform".into())
    }
}

#[cfg(windows)]
fn windows_file_identity(file: &fs::File) -> Result<(u32, u64), String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
        .map_err(|error| format!("Failed to read Windows file identity: {error}"))?;
    Ok((
        info.dwVolumeSerialNumber,
        ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    ))
}

#[cfg(target_os = "linux")]
fn linux_directory_entry_for_identity(
    directory: &fs::File,
    target: &fs::File,
) -> Result<Option<std::ffi::OsString>, String> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    let target_metadata = target.metadata().map_err(|error| error.to_string())?;
    let proc_directory = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()));
    let entries = fs::read_dir(&proc_directory)
        .map_err(|error| format!("Failed to enumerate pinned directory for recovery: {error}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_c = match std::ffi::CString::new(name.as_bytes()) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name_c.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            continue;
        }
        let candidate = unsafe { fs::File::from_raw_fd(fd) };
        let Ok(metadata) = candidate.metadata() else {
            continue;
        };
        if metadata.dev() == target_metadata.dev() && metadata.ino() == target_metadata.ino() {
            return Ok(Some(name));
        }
    }
    Ok(None)
}

#[cfg(target_os = "linux")]
struct LinuxNamedCleanup {
    directory_fd: std::os::fd::RawFd,
    names: Vec<std::ffi::CString>,
}

#[cfg(target_os = "linux")]
impl LinuxNamedCleanup {
    fn new(directory_fd: std::os::fd::RawFd) -> Self {
        Self { directory_fd, names: Vec::new() }
    }

    fn track(&mut self, name: std::ffi::CString) {
        if !self.names.iter().any(|candidate| candidate == &name) {
            self.names.push(name);
        }
    }

    fn forget(&mut self, name: &std::ffi::CStr) {
        self.names.retain(|candidate| candidate.as_c_str() != name);
    }

    fn cleanup_all(&mut self) -> Result<(), String> {
        let mut failures = Vec::new();
        let pending = std::mem::take(&mut self.names);
        for name in pending {
            let result = unsafe { libc::unlinkat(self.directory_fd, name.as_ptr(), 0) };
            if result != 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() != std::io::ErrorKind::NotFound {
                    failures.push(format!("{}: {error}", name.to_string_lossy()));
                    self.names.push(name);
                }
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!("Failed to clean replacement artifacts: {}", failures.join(", ")))
        }
    }
}

#[cfg(target_os = "linux")]
impl Drop for LinuxNamedCleanup {
    fn drop(&mut self) {
        let _ = self.cleanup_all();
    }
}

#[cfg(target_os = "linux")]
fn linux_rename_noreplace(
    directory_fd: std::os::fd::RawFd,
    from: &std::ffi::CStr,
    to: &std::ffi::CStr,
) -> std::io::Result<()> {
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            directory_fd,
            from.as_ptr(),
            directory_fd,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
#[derive(Clone, Debug)]
struct LinuxHandoffAliasIsolation {
    recovery_name: std::ffi::OsString,
    identity: LinuxIsolationIdentity,
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinuxIsolationIdentity {
    Unknown,
    Exact,
    Mismatched,
}

#[cfg(target_os = "linux")]
type LinuxPreservedRecoveryArtifact = (PathBuf, &'static str);

#[cfg(target_os = "linux")]
fn linux_record_preserved_recovery_artifact(
    artifacts: &std::cell::RefCell<Vec<LinuxPreservedRecoveryArtifact>>,
    path: PathBuf,
    kind: &'static str,
) {
    let mut artifacts = artifacts.borrow_mut();
    if !artifacts.iter().any(|(existing, _)| existing == &path) {
        artifacts.push((path, kind));
    }
}

#[cfg(target_os = "linux")]
fn linux_report_preserved_recovery_artifacts(
    error: String,
    artifacts: &[LinuxPreservedRecoveryArtifact],
) -> String {
    if artifacts.is_empty() {
        error
    } else {
        let paths = artifacts
            .iter()
            .map(|(path, kind)| format!("{kind} '{}'", path.display()))
            .collect::<Vec<_>>()
            .join(", ");
        format!("{error}; preserved recovery artifacts: {paths}")
    }
}

#[cfg(target_os = "linux")]
fn linux_finalize_authoritative_trash<BeforeRename, BeforeVerification>(
    directory: &fs::File,
    canonical_folder: &Path,
    isolation: &std::cell::RefCell<Option<LinuxHandoffAliasIsolation>>,
    recovery_alias: &std::ffi::OsStr,
    expected: &fs::File,
    before_rename: BeforeRename,
    before_verification: BeforeVerification,
) -> TrashCommitOutcome
where
    BeforeRename: FnOnce() -> Result<(), String>,
    BeforeVerification: FnOnce() -> Result<(), String>,
{
    let isolation_result = linux_isolate_handoff_alias(
        isolation,
        directory,
        recovery_alias,
        expected,
        before_rename,
        before_verification,
        |_| Ok(()),
    );

    let preservation = match isolation_result {
        Ok(isolation) => {
            let retained_kind = match isolation.identity {
                LinuxIsolationIdentity::Exact => {
                    "exact retained committed trash recovery link"
                }
                LinuxIsolationIdentity::Mismatched => {
                    "identity-mismatched retained committed trash recovery link"
                }
                LinuxIsolationIdentity::Unknown => {
                    "unverified retained committed trash recovery link"
                }
            };
            format!(
                "{retained_kind} '{}' was preserved",
                canonical_folder.join(isolation.recovery_name).display()
            )
        }
        Err(error) => match isolation.borrow().as_ref() {
            Some(isolation) => format!(
                "unverified retained committed trash recovery link '{}' was preserved, but verification failed: {error}",
                canonical_folder.join(&isolation.recovery_name).display()
            ),
            None => format!(
                "the recovery entry could not be isolated or verified; no stable recovery artifact path is claimed: {error}"
            ),
        },
    };
    let warning = match directory.sync_all() {
        Ok(()) => format!(
            "Trash committed: canonical source name is absent and the exact object is in authoritative trash; {preservation}"
        ),
        Err(error) => format!(
            "Trash committed: canonical source name is absent and the exact object is in authoritative trash; {preservation}, but source-directory durability could not be confirmed: {error}"
        ),
    };
    TrashCommitOutcome::with_warning(warning)
}

#[cfg(target_os = "linux")]
fn linux_isolate_handoff_alias<BeforeRename, BeforeVerification, AfterVerification>(
    isolation: &std::cell::RefCell<Option<LinuxHandoffAliasIsolation>>,
    directory: &fs::File,
    alias: &std::ffi::OsStr,
    expected: &fs::File,
    before_rename: BeforeRename,
    before_verification: BeforeVerification,
    after_verification: AfterVerification,
) -> Result<LinuxHandoffAliasIsolation, String>
where
    BeforeRename: FnOnce() -> Result<(), String>,
    BeforeVerification: FnOnce() -> Result<(), String>,
    AfterVerification: FnOnce(&std::ffi::OsStr) -> Result<(), String>,
{
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    if let Some(existing) = isolation.borrow().as_ref() {
        return Ok(existing.clone());
    }
    let alias = std::ffi::CString::new(alias.as_bytes())
        .map_err(|_| "Trash handoff alias contains NUL".to_string())?;
    let isolated = std::ffi::CString::new(format!(
        ".lightframe-isolated-trash-handoff-{}",
        uuid::Uuid::new_v4()
    ))
    .expect("generated recovery name has no NUL");

    before_rename()?;
    // Commit point: atomically isolate the discovered alias before inspecting it. The recovered
    // name is retained for audit/recovery regardless of which identity was found there.
    linux_rename_noreplace(directory.as_raw_fd(), &alias, &isolated)
        .map_err(|error| format!("failed to isolate trash handoff alias: {error}"))?;

    let recovery_name = std::ffi::OsStr::from_bytes(isolated.to_bytes()).to_os_string();
    *isolation.borrow_mut() = Some(LinuxHandoffAliasIsolation {
        recovery_name: recovery_name.clone(),
        identity: LinuxIsolationIdentity::Unknown,
    });
    before_verification().map_err(|error| {
        format!(
            "isolated handoff alias '{}' was retained but could not be verified: {error}",
            recovery_name.to_string_lossy()
        )
    })?;

    let isolated_file =
        linux_open_named_nofollow(directory.as_raw_fd(), &isolated).map_err(|error| {
            format!(
                "isolated handoff alias '{}' was retained but could not be verified: {error}",
                recovery_name.to_string_lossy()
            )
        })?;
    let metadata = isolated_file.metadata().map_err(|error| {
        format!(
            "isolated handoff alias '{}' was retained but could not be verified: {error}",
            recovery_name.to_string_lossy()
        )
    })?;
    let expected_metadata = expected.metadata().map_err(|error| {
        format!(
            "isolated handoff alias '{}' was retained but could not be verified: {error}",
            recovery_name.to_string_lossy()
        )
    })?;
    let identity =
        if metadata.dev() == expected_metadata.dev() && metadata.ino() == expected_metadata.ino() {
            LinuxIsolationIdentity::Exact
        } else {
            LinuxIsolationIdentity::Mismatched
        };
    *isolation.borrow_mut() =
        Some(LinuxHandoffAliasIsolation { recovery_name: recovery_name.clone(), identity });
    after_verification(&recovery_name)?;
    Ok(isolation.borrow().as_ref().expect("isolated alias outcome was recorded").clone())
}

#[cfg(target_os = "linux")]
fn linux_open_named_nofollow(
    directory_fd: std::os::fd::RawFd,
    name: &std::ffi::CStr,
) -> std::io::Result<fs::File> {
    use std::os::fd::FromRawFd;
    let fd = unsafe {
        libc::openat(
            directory_fd,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(unsafe { fs::File::from_raw_fd(fd) })
    }
}

#[cfg(target_os = "linux")]
fn linux_same_file(left: &fs::File, right: &fs::File) -> Result<bool, String> {
    use std::os::unix::fs::MetadataExt;
    let left = left.metadata().map_err(|error| error.to_string())?;
    let right = right.metadata().map_err(|error| error.to_string())?;
    Ok(left.dev() == right.dev() && left.ino() == right.ino())
}

pub struct SessionInternal {
    pub id: String,
    pub instance_id: String,
    pub window_label: Option<String>,
    pub canonical_folder: PathBuf,
    pub directory_handle: fs::File,
    pub path_case_semantics: crate::path_normalization::PathCaseSemantics,
    pub images_by_id: HashMap<String, ImageRecordInternal>,
    pub catalog_revision: u64,
    pub created_at_epoch: u64,
    pub last_used_at_epoch: u64,
}

pub struct DestinationGrantInternal {
    pub id: String,
    pub window_label: Option<String>,
    pub canonical_folder: PathBuf,
    // Kept open for the lifetime of the grant. On Windows the handle deliberately omits
    // FILE_SHARE_DELETE, so the granted directory cannot be renamed/replaced underneath us.
    pub directory_handle: fs::File,
    pub path_case_semantics: crate::path_normalization::PathCaseSemantics,
    pub scope: DestinationGrantScope,
    pub created_at_epoch: u64,
    pub last_used_at_epoch: u64,
}

#[derive(Debug, Clone)]
pub enum DestinationGrantScope {
    Folder,
    ExactFile { relative_file_name: String, operation: String, expires_at_epoch: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExactDestinationGrantError {
    pub consumed: bool,
    pub message: String,
}

impl ExactDestinationGrantError {
    fn retained(message: impl Into<String>) -> Self {
        Self { consumed: false, message: message.into() }
    }

    fn consumed(message: impl Into<String>) -> Self {
        Self { consumed: true, message: message.into() }
    }

    pub fn tagged_message(&self) -> String {
        let state = if self.consumed { "CONSUMED" } else { "NOT_CONSUMED" };
        format!("DESTINATION_GRANT_{state}: {}", self.message)
    }
}

impl std::fmt::Display for ExactDestinationGrantError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

pub struct ExternalEditorGrantInternal {
    pub id: String,
    pub window_label: Option<String>,
    pub canonical_app_path: PathBuf,
    pub executable_handle: fs::File,
    pub path_case_semantics: crate::path_normalization::PathCaseSemantics,
    pub created_at_epoch: u64,
    pub last_used_at_epoch: u64,
}

pub struct ImageAuthorityLease {
    canonical_path: PathBuf,
    canonical_folder: PathBuf,
    file_handle: fs::File,
    directory_handle: fs::File,
    path_case_semantics: crate::path_normalization::PathCaseSemantics,
}

struct SourceReplacementRecovery<R: FnMut(String) -> Result<(), String>> {
    recover: R,
    armed: bool,
}

impl<R: FnMut(String) -> Result<(), String>> SourceReplacementRecovery<R> {
    fn new(recover: R) -> Self {
        Self { recover, armed: false }
    }

    fn fail<T>(&mut self, reason: String) -> Result<T, String> {
        match self.recover_now(reason.clone()) {
            Ok(()) => Err(format!("{reason}; exact original restored")),
            Err(recovery_error) => {
                Err(format!("{reason}; source recovery incomplete: {recovery_error}"))
            }
        }
    }

    fn recover_now(&mut self, reason: String) -> Result<(), String> {
        match (self.recover)(reason) {
            Ok(()) => {
                self.armed = false;
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    fn mutate<T>(
        &mut self,
        context: &str,
        mutation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.armed = true;
        match mutation() {
            Ok(value) => Ok(value),
            Err(error) => self.fail(format!("{context}: {error}")),
        }
    }

    fn commit(&mut self) {
        self.armed = false;
    }
}

impl<R: FnMut(String) -> Result<(), String>> Drop for SourceReplacementRecovery<R> {
    fn drop(&mut self) {
        if self.armed {
            if let Err(error) = (self.recover)("Replacement unwound before commit".into()) {
                eprintln!("Source replacement unwind recovery failed: {error}");
            }
        }
    }
}

#[cfg(windows)]
struct WindowsNamedFileCleanup(PathBuf);

#[cfg(windows)]
impl Drop for WindowsNamedFileCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(windows)]
fn current_windows_user_sid() -> Result<String, String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token = HANDLE(std::ptr::null_mut());
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }
        .map_err(|error| format!("Failed to open current process token: {error}"))?;
    let result = (|| -> Result<String, String> {
        let mut length = 0_u32;
        let _ = unsafe { GetTokenInformation(token, TokenUser, None, 0, &mut length) };
        if length == 0 {
            return Err("Current user token did not report a SID buffer length".into());
        }
        let mut buffer = vec![0_u8; length as usize];
        unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                Some(buffer.as_mut_ptr().cast()),
                length,
                &mut length,
            )
        }
        .map_err(|error| format!("Failed to read current user SID: {error}"))?;
        let token_user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
        let mut sid_string = PWSTR::null();
        unsafe { ConvertSidToStringSidW(token_user.User.Sid, &mut sid_string) }
            .map_err(|error| format!("Failed to format current user SID: {error}"))?;
        let value = unsafe { sid_string.to_string() }
            .map_err(|error| format!("Current user SID is not valid UTF-16: {error}"));
        unsafe {
            let _ = LocalFree(Some(HLOCAL(sid_string.0.cast())));
        }
        value
    })();
    unsafe {
        let _ = CloseHandle(token);
    }
    result
}

#[cfg(windows)]
fn is_current_user_recycle_path(path: &Path, current_sid: &str) -> bool {
    let normalized = path.to_string_lossy().replace('/', "\\");
    let normalized = normalized.strip_prefix(r"\\?\").unwrap_or(&normalized);
    let parts = normalized.split('\\').filter(|part| !part.is_empty()).collect::<Vec<_>>();
    parts.len() >= 4
        && parts[0].len() == 2
        && parts[0].as_bytes()[0].is_ascii_alphabetic()
        && parts[0].ends_with(':')
        && parts[1].eq_ignore_ascii_case("$Recycle.Bin")
        && parts[2].eq_ignore_ascii_case(current_sid)
}

#[cfg(target_os = "linux")]
fn valid_trash_deletion_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 19
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7 | 10 | 13 | 16) || byte.is_ascii_digit())
        && value[5..7].parse::<u8>().is_ok_and(|month| (1..=12).contains(&month))
        && value[8..10].parse::<u8>().is_ok_and(|day| (1..=31).contains(&day))
        && value[11..13].parse::<u8>().is_ok_and(|hour| hour < 24)
        && value[14..16].parse::<u8>().is_ok_and(|minute| minute < 60)
        && value[17..19].parse::<u8>().is_ok_and(|second| second < 60)
}

#[cfg(target_os = "linux")]
fn trashinfo_proves_original(
    info_path: &Path,
    original_path: &Path,
    mount_root: Option<&Path>,
) -> bool {
    let Ok(metadata) = fs::symlink_metadata(info_path) else {
        return false;
    };
    if !metadata.file_type().is_file() {
        return false;
    }
    let Ok(content) = fs::read_to_string(info_path) else {
        return false;
    };
    let mut lines = content.lines();
    if lines.next() != Some("[Trash Info]") {
        return false;
    }
    let mut encoded_path = None;
    let mut deletion_date = None;
    for line in lines {
        if let Some(value) = line.strip_prefix("Path=") {
            if encoded_path.replace(value).is_some() {
                return false;
            }
        } else if let Some(value) = line.strip_prefix("DeletionDate=") {
            if deletion_date.replace(value).is_some() {
                return false;
            }
        } else if !line.trim().is_empty() {
            return false;
        }
    }
    let (Some(encoded_path), Some(deletion_date)) = (encoded_path, deletion_date) else {
        return false;
    };
    if !valid_trash_deletion_date(deletion_date) {
        return false;
    }
    let Ok(decoded) = percent_encoding::percent_decode_str(encoded_path).decode_utf8() else {
        return false;
    };
    let decoded = PathBuf::from(decoded.as_ref());
    let resolved = if decoded.is_absolute() {
        decoded
    } else if let Some(root) = mount_root {
        root.join(decoded)
    } else {
        return false;
    };
    crate::path_normalization::normalize_path_for_key(&resolved)
        == crate::path_normalization::normalize_path_for_key(original_path)
}

#[cfg(target_os = "linux")]
fn decode_mountinfo_path(value: &str) -> PathBuf {
    PathBuf::from(
        value
            .replace("\\040", " ")
            .replace("\\011", "\t")
            .replace("\\012", "\n")
            .replace("\\134", "\\"),
    )
}

#[cfg(target_os = "linux")]
fn linux_mount_root_for_path(path: &Path, expected_device: u64) -> Option<PathBuf> {
    use std::os::unix::fs::MetadataExt;

    let canonical = fs::canonicalize(path).ok()?;
    let mountinfo = fs::read_to_string("/proc/self/mountinfo").ok()?;
    mountinfo
        .lines()
        .filter_map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            let mount_point = fields.get(4).map(|value| decode_mountinfo_path(value))?;
            let canonical_mount = fs::canonicalize(mount_point).ok()?;
            let metadata = fs::metadata(&canonical_mount).ok()?;
            if metadata.dev() == expected_device && canonical.starts_with(&canonical_mount) {
                Some(canonical_mount)
            } else {
                None
            }
        })
        .max_by_key(|mount| mount.components().count())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
enum ReplacementFailurePoint {
    None,
    AfterPartialStagingWrite,
    AfterStagingFlush,
    BeforeSourceRevalidation,
    StagingPathSwap,
    AfterSourceQuarantine,
    DuringBackupReopen,
    DuringPublication,
    PublishedPathSwap,
    AfterPublication,
    DuringDirectorySync,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)]
enum MoveFailurePoint {
    None,
    AfterQuarantine,
    DuringCopy,
    DuringLink,
    DuringPublishedMetadata,
    DuringDestinationSync,
    DuringDestinationRollback,
    DuringDestinationRollbackSync,
    DuringCommittedDestinationSync,
    DuringSourceUnlink,
    DuringSourceSync,
    DuringRollback,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashCommitOutcome {
    pub committed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

impl TrashCommitOutcome {
    #[cfg(windows)]
    fn durable() -> Self {
        Self { committed: true, warning: None }
    }

    #[cfg(target_os = "linux")]
    fn with_warning(warning: String) -> Self {
        Self { committed: true, warning: Some(warning) }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoveCommitOutcome {
    Committed { target_path: PathBuf, durability_warning: Option<String>, source_removed: bool },
}

impl MoveCommitOutcome {
    fn durable(target_path: PathBuf) -> Self {
        Self::Committed { target_path, durability_warning: None, source_removed: true }
    }

    fn with_warning(target_path: PathBuf, warning: String, source_removed: bool) -> Self {
        Self::Committed { target_path, durability_warning: Some(warning), source_removed }
    }

    pub fn durability_warning(&self) -> Option<&str> {
        match self {
            Self::Committed { durability_warning, .. } => durability_warning.as_deref(),
        }
    }

    pub fn target_path(&self) -> &Path {
        match self {
            Self::Committed { target_path, .. } => target_path,
        }
    }

    pub fn source_removed(&self) -> bool {
        match self {
            Self::Committed { source_removed, .. } => *source_removed,
        }
    }
}

/// A private, short-lived pathname representation copied from an authorized file handle.
/// Third-party codecs that only accept paths must consume this snapshot instead of reopening
/// the user-controlled pathname after authority validation.
pub struct AuthorizedSourceSnapshot {
    path: PathBuf,
    directory: PathBuf,
}

pub struct SidecarAuthorityLease {
    file_name: String,
    file_handle: fs::File,
}

impl SidecarAuthorityLease {
    pub fn file_name(&self) -> &str {
        &self.file_name
    }

    pub fn into_file(self) -> fs::File {
        self.file_handle
    }
}

impl AuthorizedSourceSnapshot {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for AuthorizedSourceSnapshot {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_dir(&self.directory);
    }
}

impl ImageAuthorityLease {
    pub fn path(&self) -> &Path {
        &self.canonical_path
    }

    pub fn path_case_semantics(&self) -> crate::path_normalization::PathCaseSemantics {
        self.path_case_semantics
    }

    pub fn revalidate(&self) -> Result<(), String> {
        let current = SessionManager::canonicalize_existing_file(&self.canonical_path)?;
        if !is_path_contained_in_with_semantics(
            &current,
            &self.canonical_folder,
            self.path_case_semantics,
        ) {
            return Err("Authorized image escaped its session folder during the operation".into());
        }
        verify_pinned_file(&self.file_handle, &current, "Authorized image")
    }

    pub fn try_clone_file(&self) -> Result<fs::File, String> {
        self.file_handle
            .try_clone()
            .map_err(|error| format!("Failed to clone authorized image handle: {error}"))
    }

    pub fn blocking_path_pin(&self) -> Result<fs::File, String> {
        self.revalidate()?;
        let file = open_pinned_file(&self.canonical_path, "blocking authorized image")?;
        verify_pinned_file(&file, &self.canonical_path, "Blocking authorized image")?;
        Ok(file)
    }

    pub fn replace_contents_from(self, replacement_path: &Path) -> Result<(), String> {
        self.replace_contents_from_with_failure(
            replacement_path,
            None,
            ReplacementFailurePoint::None,
        )
    }

    pub fn replace_contents_from_pinned(
        self,
        replacement_path: &Path,
        replacement_handle: fs::File,
    ) -> Result<(), String> {
        self.replace_contents_from_with_failure(
            replacement_path,
            Some(replacement_handle),
            ReplacementFailurePoint::None,
        )
    }

    fn replace_contents_from_with_failure(
        self,
        replacement_path: &Path,
        replacement_handle: Option<fs::File>,
        failure: ReplacementFailurePoint,
    ) -> Result<(), String> {
        use std::io::{Read, Seek, Write};
        self.revalidate()?;
        let mut replacement = match replacement_handle {
            Some(file) => file,
            None => open_readonly_nofollow_file(replacement_path, "prepared replacement")?,
        };
        verify_pinned_file(&replacement, replacement_path, "Prepared replacement")?;
        let expected = replacement.metadata().map_err(|error| error.to_string())?.len();
        replacement
            .seek(std::io::SeekFrom::Start(0))
            .map_err(|error| format!("Failed to rewind prepared replacement handle: {error}"))?;
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use std::os::windows::fs::{FileTimesExt, OpenOptionsExt};
            use std::os::windows::io::AsRawHandle;
            use windows::core::PCWSTR;
            use windows::Win32::Foundation::HANDLE;
            use windows::Win32::Storage::FileSystem::{
                FileDispositionInfoEx, FileRenameInfo, MoveFileExW, SetFileInformationByHandle,
                FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
                FILE_DISPOSITION_INFO_EX, FILE_DISPOSITION_INFO_EX_FLAGS, FILE_RENAME_INFO,
                MOVEFILE_WRITE_THROUGH, MOVE_FILE_FLAGS,
            };

            let extension = self
                .canonical_path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| format!(".{value}"))
                .unwrap_or_default();
            let staging_path = self.canonical_folder.join(format!(
                ".lightframe-replacement-{}{}",
                uuid::Uuid::new_v4(),
                extension
            ));
            let backup_path = self.canonical_folder.join(format!(
                ".lightframe-recovery-{}{}",
                uuid::Uuid::new_v4(),
                extension
            ));
            let mut staging = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .access_mode(0xC000_0000 | 0x0001_0000)
                .share_mode(0x0000_0001 | 0x0000_0002 | 0x0000_0004)
                .custom_flags(0x0020_0000)
                .open(&staging_path)
                .map_err(|error| format!("Failed to create replacement staging: {error}"))?;
            let _staging_cleanup = WindowsNamedFileCleanup(staging_path.clone());

            let copy_limit = if failure == ReplacementFailurePoint::AfterPartialStagingWrite {
                expected.saturating_div(2).max(1)
            } else {
                expected.saturating_add(1)
            };
            let copied = std::io::copy(
                &mut std::io::Read::by_ref(&mut replacement).take(copy_limit),
                &mut staging,
            )
            .map_err(|error| format!("Failed to stage authorized replacement: {error}"))?;
            if failure == ReplacementFailurePoint::AfterPartialStagingWrite {
                drop(staging);
                let _ = fs::remove_file(&staging_path);
                return Err("Injected failure after partial replacement staging write".into());
            }
            if copied != expected {
                drop(staging);
                let _ = fs::remove_file(&staging_path);
                return Err("Prepared replacement length changed during staging".into());
            }
            staging
                .flush()
                .and_then(|_| staging.sync_all())
                .map_err(|error| format!("Failed to durably flush replacement staging: {error}"))?;
            if failure == ReplacementFailurePoint::AfterStagingFlush {
                drop(staging);
                let _ = fs::remove_file(&staging_path);
                return Err("Injected failure after replacement staging flush".into());
            }
            self.revalidate()?;
            verify_pinned_file(&staging, &staging_path, "Replacement staging")?;

            let rename_handle = |file: &fs::File, path: &Path| -> Result<(), String> {
                let target_display = path.to_string_lossy();
                let target_nt = if let Some(value) = target_display.strip_prefix(r"\\?\UNC\") {
                    format!(r"\??\UNC\{value}")
                } else if let Some(value) = target_display.strip_prefix(r"\\?\") {
                    format!(r"\??\{value}")
                } else if let Some(value) = target_display.strip_prefix(r"\\") {
                    format!(r"\??\UNC\{value}")
                } else {
                    format!(r"\??\{target_display}")
                };
                let target: Vec<u16> = std::ffi::OsStr::new(&target_nt).encode_wide().collect();
                let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
                let mut buffer =
                    vec![0_u8; offset + (target.len() + 1) * std::mem::size_of::<u16>()];
                let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
                unsafe {
                    (*info).Anonymous.ReplaceIfExists = false;
                    (*info).RootDirectory = HANDLE(std::ptr::null_mut());
                    (*info).FileNameLength = (target.len() * std::mem::size_of::<u16>()) as u32;
                    std::ptr::copy_nonoverlapping(
                        target.as_ptr(),
                        (*info).FileName.as_mut_ptr(),
                        target.len(),
                    );
                    SetFileInformationByHandle(
                        HANDLE(file.as_raw_handle()),
                        FileRenameInfo,
                        buffer.as_ptr().cast(),
                        buffer.len() as u32,
                    )
                }
                .map_err(|error| format!("Handle rename to '{}' failed: {error}", path.display()))
            };
            let mark_delete = |file: &fs::File| -> Result<(), String> {
                let disposition = FILE_DISPOSITION_INFO_EX {
                    Flags: FILE_DISPOSITION_INFO_EX_FLAGS(
                        FILE_DISPOSITION_FLAG_DELETE.0 | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS.0,
                    ),
                };
                unsafe {
                    SetFileInformationByHandle(
                        HANDLE(file.as_raw_handle()),
                        FileDispositionInfoEx,
                        (&disposition as *const FILE_DISPOSITION_INFO_EX).cast(),
                        std::mem::size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
                    )
                }
                .map_err(|error| format!("Failed to delete recovery handle: {error}"))
            };
            let move_path = |from: &Path, to: &Path| -> Result<(), String> {
                let encode = |path: &Path| {
                    let display = path.to_string_lossy();
                    let api_path = if display.starts_with(r"\\?\") {
                        display.into_owned()
                    } else if let Some(value) = display.strip_prefix(r"\\") {
                        format!(r"\\?\UNC\{value}")
                    } else {
                        format!(r"\\?\{display}")
                    };
                    api_path.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>()
                };
                let from = encode(from);
                let to = encode(to);
                unsafe {
                    MoveFileExW(
                        PCWSTR(from.as_ptr()),
                        PCWSTR(to.as_ptr()),
                        MOVE_FILE_FLAGS(MOVEFILE_WRITE_THROUGH.0),
                    )
                }
                .map_err(|error| format!("Path move failed: {error}"))
            };

            let original_handle = self.file_handle;
            let backup_handle = original_handle
                .try_clone()
                .map_err(|error| format!("Failed to clone original recovery handle: {error}"))?;
            let abandoned_path = self.canonical_folder.join(format!(
                ".lightframe-aborted-replacement-{}{}",
                uuid::Uuid::new_v4(),
                extension
            ));
            let mut source_recovery = SourceReplacementRecovery::new(|reason| {
                if verify_pinned_file(
                    &backup_handle,
                    &self.canonical_path,
                    "Recovered original image",
                )
                .is_ok()
                {
                    return Ok(());
                }
                if fs::symlink_metadata(&self.canonical_path).is_ok() {
                    move_path(&self.canonical_path, &abandoned_path).map_err(|error| {
                        format!(
                            "{reason}; visible replacement could not be quarantined: {error}; exact original retained at '{}'",
                            backup_path.display()
                        )
                    })?;
                }
                rename_handle(&backup_handle, &self.canonical_path).map_err(|error| {
                    format!(
                        "{reason}; exact original retained at '{}'; restore failed: {error}",
                        backup_path.display()
                    )
                })?;
                verify_pinned_file(
                    &backup_handle,
                    &self.canonical_path,
                    "Recovered exact original image",
                )?;
                mark_delete(&staging).map_err(|error| {
                    format!(
                        "{reason}; original restored but replacement handle cleanup failed: {error}"
                    )
                })?;
                if abandoned_path.exists() {
                    fs::remove_file(&abandoned_path).map_err(|error| {
                        format!(
                            "{reason}; original restored but cleanup artifact '{}' was retained: {error}",
                            abandoned_path.display()
                        )
                    })?;
                }
                Ok(())
            });
            source_recovery.mutate("Failed to quarantine replacement source", || {
                rename_handle(&original_handle, &backup_path)?;
                verify_pinned_file(&original_handle, &backup_path, "Quarantined original image")
            })?;
            drop(original_handle);
            if failure == ReplacementFailurePoint::AfterSourceQuarantine {
                return source_recovery.fail("Injected failure after source quarantine".into());
            }
            if failure == ReplacementFailurePoint::DuringPublication {
                return source_recovery.fail("Injected replacement publication failure".into());
            }
            source_recovery.mutate("Replacement publication failed", || {
                move_path(&staging_path, &self.canonical_path)
            })?;

            if failure == ReplacementFailurePoint::PublishedPathSwap {
                let stolen_path = self.canonical_folder.join(format!(
                    ".lightframe-stolen-replacement-{}{}",
                    uuid::Uuid::new_v4(),
                    extension
                ));
                let injected = (|| -> Result<(), String> {
                    move_path(&self.canonical_path, &stolen_path)?;
                    fs::write(&self.canonical_path, vec![b'x'; expected as usize]).map_err(
                        |error| format!("Failed to create injected publication decoy: {error}"),
                    )?;
                    let created = fs::metadata(&stolen_path)
                        .and_then(|metadata| metadata.created())
                        .map_err(|error| {
                            format!("Failed to inspect injected publication decoy: {error}")
                        })?;
                    fs::OpenOptions::new()
                        .write(true)
                        .open(&self.canonical_path)
                        .and_then(|file| {
                            file.set_times(std::fs::FileTimes::new().set_created(created))
                        })
                        .map_err(|error| {
                            format!("Failed to clone injected decoy creation time: {error}")
                        })
                })();
                if let Err(error) = injected {
                    return source_recovery.fail(error);
                }
            }
            if let Err(error) =
                verify_pinned_file(&staging, &self.canonical_path, "Published replacement image")
            {
                return source_recovery.fail(error);
            }
            if failure == ReplacementFailurePoint::AfterPublication {
                return source_recovery
                    .fail("Injected failure after replacement publication".into());
            }
            if failure == ReplacementFailurePoint::DuringDirectorySync {
                return source_recovery.fail("Injected replacement durability failure".into());
            }
            // Windows ordinary directory handles cannot be flushed with FlushFileBuffers
            // (ACCESS_DENIED). The staging file has been synced and the handle rename is journaled.
            if let Err(error) = mark_delete(&backup_handle) {
                return source_recovery.fail(error);
            }
            source_recovery.commit();
            Ok(())
        }

        #[cfg(target_os = "linux")]
        {
            use std::ffi::CString;
            use std::os::fd::{AsRawFd, FromRawFd};
            use std::os::unix::ffi::OsStrExt;
            let source_name = self
                .canonical_path
                .file_name()
                .ok_or_else(|| "Authorized mutation target has no file name".to_string())?;
            let source_name = CString::new(source_name.as_bytes())
                .map_err(|_| "Authorized mutation target contains NUL".to_string())?;
            let staging_name =
                CString::new(format!(".lightframe-replacement-{}", uuid::Uuid::new_v4())).unwrap();
            let backup_name =
                CString::new(format!(".lightframe-recovery-{}", uuid::Uuid::new_v4())).unwrap();
            let directory_fd = self.directory_handle.as_raw_fd();
            let mut cleanup = LinuxNamedCleanup::new(directory_fd);
            cleanup.track(staging_name.clone());
            let staging_fd = unsafe {
                libc::openat(
                    directory_fd,
                    staging_name.as_ptr(),
                    libc::O_RDWR
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if staging_fd < 0 {
                return Err(format!(
                    "Failed to create handle-relative replacement staging: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let mut staging = unsafe { fs::File::from_raw_fd(staging_fd) };
            let copy_limit = if failure == ReplacementFailurePoint::AfterPartialStagingWrite {
                expected.saturating_div(2).max(1)
            } else {
                expected.saturating_add(1)
            };
            let copied = std::io::copy(
                &mut std::io::Read::by_ref(&mut replacement).take(copy_limit),
                &mut staging,
            )
            .map_err(|error| format!("Failed to stage replacement: {error}"))?;
            if failure == ReplacementFailurePoint::AfterPartialStagingWrite || copied != expected {
                return Err("Replacement staging did not complete; original unchanged".into());
            }
            staging
                .flush()
                .and_then(|_| staging.sync_all())
                .map_err(|error| format!("Failed to sync replacement staging: {error}"))?;
            if failure == ReplacementFailurePoint::AfterStagingFlush {
                return Err("Injected failure after staging flush; original unchanged".into());
            }
            if failure == ReplacementFailurePoint::BeforeSourceRevalidation {
                return Err(
                    "Injected failure before source revalidation; original unchanged".into()
                );
            }
            self.revalidate()?;

            if failure == ReplacementFailurePoint::StagingPathSwap {
                unsafe {
                    libc::unlinkat(directory_fd, staging_name.as_ptr(), 0);
                }
                let decoy_fd = unsafe {
                    libc::openat(
                        directory_fd,
                        staging_name.as_ptr(),
                        libc::O_WRONLY
                            | libc::O_CREAT
                            | libc::O_EXCL
                            | libc::O_NOFOLLOW
                            | libc::O_CLOEXEC,
                        0o600,
                    )
                };
                if decoy_fd >= 0 {
                    let mut decoy = unsafe { fs::File::from_raw_fd(decoy_fd) };
                    decoy
                        .write_all(b"replacement-path-decoy")
                        .map_err(|error| error.to_string())?;
                    decoy.sync_all().map_err(|error| error.to_string())?;
                }
            }

            // The pathname is attacker-controlled even though the producer handle is pinned.
            // Reopen it handle-relative immediately before quarantine and require the same inode.
            let named_staging =
                linux_open_named_nofollow(directory_fd, &staging_name).map_err(|error| {
                    format!("Failed to revalidate replacement staging name: {error}")
                })?;
            if !linux_same_file(&staging, &named_staging)? {
                return Err(
                    "Replacement staging pathname identity changed; original unchanged".into()
                );
            }

            let rejected_name =
                CString::new(format!(".lightframe-aborted-replacement-{}", uuid::Uuid::new_v4()))
                    .unwrap();
            let mut source_recovery = SourceReplacementRecovery::new(|reason| {
                if linux_open_named_nofollow(directory_fd, &source_name)
                    .ok()
                    .and_then(|current| linux_same_file(&self.file_handle, &current).ok())
                    == Some(true)
                {
                    self.directory_handle.sync_all().map_err(|error| {
                        format!(
                            "{reason}; original is canonical but directory sync failed: {error}"
                        )
                    })?;
                    return Ok(());
                }
                match linux_rename_noreplace(directory_fd, &source_name, &rejected_name) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(format!(
                            "{reason}; visible replacement could not be quarantined: {error}"
                        ))
                    }
                }
                let exact_name = linux_directory_entry_for_identity(
                    &self.directory_handle,
                    &self.file_handle,
                )?
                .ok_or_else(|| {
                    format!("{reason}; exact pinned original has no recoverable directory entry")
                })?;
                let exact_name = CString::new(exact_name.as_bytes())
                    .map_err(|_| "Recovered source name contains NUL".to_string())?;
                linux_rename_noreplace(directory_fd, &exact_name, &source_name)
                    .map_err(|error| format!("{reason}; exact original restore failed: {error}"))?;
                let restored = linux_open_named_nofollow(directory_fd, &source_name)
                    .map_err(|error| format!("{reason}; restored source reopen failed: {error}"))?;
                if !linux_same_file(&self.file_handle, &restored).map_err(|error| {
                    format!("{reason}; restored source identity query failed: {error}")
                })? {
                    return Err(format!("{reason}; canonical source is not the pinned original"));
                }
                if let Some(exact_staging_name) =
                    linux_directory_entry_for_identity(&self.directory_handle, &staging)?
                {
                    let exact_staging_name =
                        CString::new(exact_staging_name.as_bytes()).map_err(|_| {
                            "Published replacement recovery name contains NUL".to_string()
                        })?;
                    if exact_staging_name.as_c_str() != source_name.as_c_str() {
                        let removed =
                            unsafe { libc::unlinkat(directory_fd, exact_staging_name.as_ptr(), 0) };
                        if removed != 0 {
                            return Err(format!(
                                "{reason}; replacement artifact '{}' retained: {}",
                                exact_staging_name.to_string_lossy(),
                                std::io::Error::last_os_error()
                            ));
                        }
                    }
                }
                let rejected_removed =
                    unsafe { libc::unlinkat(directory_fd, rejected_name.as_ptr(), 0) };
                if rejected_removed != 0
                    && std::io::Error::last_os_error().kind() != std::io::ErrorKind::NotFound
                {
                    return Err(format!(
                        "{reason}; rejected artifact '{}' retained: {}",
                        rejected_name.to_string_lossy(),
                        std::io::Error::last_os_error()
                    ));
                }
                self.directory_handle.sync_all().map_err(|error| {
                    format!("{reason}; original restored but rollback sync failed: {error}")
                })?;
                Ok(())
            });
            source_recovery.mutate("Failed to quarantine replacement source", || {
                linux_rename_noreplace(directory_fd, &source_name, &backup_name)
                    .map_err(|error| error.to_string())?;
                let backup = linux_open_named_nofollow(directory_fd, &backup_name)
                    .map_err(|error| format!("Failed to reopen quarantined source: {error}"))?;
                if !linux_same_file(&self.file_handle, &backup)? {
                    return Err("Quarantined source identity changed".into());
                }
                self.directory_handle
                    .sync_all()
                    .map_err(|error| format!("Failed to sync quarantined source: {error}"))
            })?;
            let _backup_handle = match if failure == ReplacementFailurePoint::DuringBackupReopen {
                Err("Injected quarantined source reopen failure".to_string())
            } else {
                linux_open_named_nofollow(directory_fd, &backup_name)
                    .map_err(|error| error.to_string())
            } {
                Ok(handle) => handle,
                Err(error) => {
                    return source_recovery
                        .fail(format!("Failed to retain quarantined source handle: {error}"))
                }
            };

            if failure == ReplacementFailurePoint::AfterSourceQuarantine {
                return source_recovery.fail("Injected failure after source quarantine".into());
            }
            if failure == ReplacementFailurePoint::DuringPublication {
                return source_recovery.fail("Injected replacement publication failure".into());
            }
            if let Err(error) = linux_rename_noreplace(directory_fd, &staging_name, &source_name) {
                return source_recovery.fail(format!("Replacement publication failed: {error}"));
            }
            cleanup.forget(&staging_name);

            if failure == ReplacementFailurePoint::PublishedPathSwap {
                let stolen_name = CString::new(format!(
                    ".lightframe-stolen-replacement-{}",
                    uuid::Uuid::new_v4()
                ))
                .unwrap();
                if let Err(error) = linux_rename_noreplace(directory_fd, &source_name, &stolen_name)
                {
                    return source_recovery
                        .fail(format!("Injected published path swap failed: {error}"));
                }
                cleanup.track(stolen_name);
                let decoy_fd = unsafe {
                    libc::openat(
                        directory_fd,
                        source_name.as_ptr(),
                        libc::O_WRONLY
                            | libc::O_CREAT
                            | libc::O_EXCL
                            | libc::O_NOFOLLOW
                            | libc::O_CLOEXEC,
                        0o600,
                    )
                };
                if decoy_fd >= 0 {
                    let mut decoy = unsafe { fs::File::from_raw_fd(decoy_fd) };
                    if let Err(error) =
                        decoy.write_all(b"published-path-decoy").and_then(|_| decoy.sync_all())
                    {
                        return source_recovery
                            .fail(format!("Injected publication decoy failed: {error}"));
                    }
                }
            }

            let published_handle = linux_open_named_nofollow(directory_fd, &source_name)
                .map_err(|error| format!("Failed to reopen published replacement: {error}"));
            let published_matches = match published_handle {
                Ok(handle) => match linux_same_file(&staging, &handle) {
                    Ok(matches) => matches,
                    Err(error) => {
                        return source_recovery.fail(format!(
                            "Failed to compare published replacement identity: {error}"
                        ))
                    }
                },
                Err(error) => return source_recovery.fail(error),
            };
            if !published_matches {
                return source_recovery
                    .fail("Published replacement pathname identity changed".into());
            }
            if failure == ReplacementFailurePoint::AfterPublication {
                return source_recovery
                    .fail("Injected failure after replacement publication".into());
            }

            let durability_error = if failure == ReplacementFailurePoint::DuringDirectorySync {
                Some("Injected replacement directory sync failure".to_string())
            } else {
                self.directory_handle
                    .sync_all()
                    .err()
                    .map(|error| format!("Failed to sync replacement directory: {error}"))
            };
            if let Some(error) = durability_error {
                return source_recovery.fail(error);
            }

            // Publication and the exact recovery name are now durable. Complete every fallible
            // cleanup while rollback remains possible, then revalidate before the commit point.
            if let Err(error) = cleanup.cleanup_all() {
                return source_recovery
                    .fail(format!("Failed replacement cleanup before commit: {error}"));
            }
            if let Err(error) = self.directory_handle.sync_all() {
                return source_recovery
                    .fail(format!("Failed to sync replacement cleanup: {error}"));
            }
            let visible = match linux_open_named_nofollow(directory_fd, &source_name) {
                Ok(visible) => visible,
                Err(error) => {
                    return source_recovery
                        .fail(format!("Failed final replacement identity check: {error}"))
                }
            };
            let visible_matches = match linux_same_file(&staging, &visible) {
                Ok(matches) => matches,
                Err(error) => {
                    return source_recovery
                        .fail(format!("Failed final replacement identity comparison: {error}"))
                }
            };
            if !visible_matches {
                return source_recovery.fail("Final replacement identity check failed".into());
            }
            let removed = unsafe { libc::unlinkat(directory_fd, backup_name.as_ptr(), 0) };
            if removed != 0 {
                return source_recovery.fail(format!(
                    "Failed to delete replacement recovery before commit: {}",
                    std::io::Error::last_os_error()
                ));
            }
            cleanup.forget(&backup_name);
            // The backup unlink is the explicit committed-success point. A subsequent directory
            // flush failure cannot be reported as a failed replacement because exact rollback is
            // no longer possible; the visible replacement was already durably published above.
            if let Err(error) = self.directory_handle.sync_all() {
                eprintln!("Replacement committed; final recovery-unlink sync failed: {error}");
            }
            source_recovery.commit();
            Ok(())
        }

        #[cfg(all(unix, not(target_os = "linux")))]
        {
            let _ = (replacement, expected, failure);
            Err("Atomic identity-bound image replacement is unavailable on this platform".into())
        }
    }

    pub fn trash_with_recovery(self) -> Result<TrashCommitOutcome, String> {
        self.trash_with_action(|path| {
            trash::delete(path).map_err(|error| format!("Operating-system trash failed: {error}"))
        })
    }

    fn trash_with_action<F>(self, trash_action: F) -> Result<TrashCommitOutcome, String>
    where
        F: FnOnce(&Path) -> Result<(), String>,
    {
        self.revalidate()?;
        let original_name = self
            .canonical_path
            .file_name()
            .ok_or_else(|| "Authorized trash source has no file name".to_string())?;
        #[cfg(target_os = "linux")]
        let quarantine_name = format!(".lightframe-trash-recovery-{}", uuid::Uuid::new_v4());
        #[cfg(not(target_os = "linux"))]
        let quarantine_name = format!(
            ".lightframe-trash-{}--{}",
            uuid::Uuid::new_v4(),
            original_name.to_string_lossy()
        );
        #[cfg(windows)]
        let quarantine_path = self.canonical_folder.join(&quarantine_name);

        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use std::os::windows::io::AsRawHandle;
            use windows::core::PCWSTR;
            use windows::Win32::Foundation::HANDLE;
            use windows::Win32::Storage::FileSystem::{
                FileRenameInfo, GetFinalPathNameByHandleW, MoveFileExW, SetFileInformationByHandle,
                FILE_NAME_NORMALIZED, FILE_RENAME_INFO, GETFINALPATHNAMEBYHANDLE_FLAGS,
                MOVEFILE_WRITE_THROUGH, MOVE_FILE_FLAGS, VOLUME_NAME_DOS,
            };

            let rename_handle = |file: &fs::File, path: &Path| -> Result<(), String> {
                let target_display = path.to_string_lossy();
                let target_nt = format!(r"\??\{target_display}");
                let target: Vec<u16> = std::ffi::OsStr::new(&target_nt).encode_wide().collect();
                let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
                let mut buffer =
                    vec![0_u8; offset + (target.len() + 1) * std::mem::size_of::<u16>()];
                let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
                unsafe {
                    (*info).Anonymous.ReplaceIfExists = false;
                    (*info).RootDirectory = HANDLE(std::ptr::null_mut());
                    (*info).FileNameLength = (target.len() * std::mem::size_of::<u16>()) as u32;
                    std::ptr::copy_nonoverlapping(
                        target.as_ptr(),
                        (*info).FileName.as_mut_ptr(),
                        target.len(),
                    );
                    SetFileInformationByHandle(
                        HANDLE(file.as_raw_handle()),
                        FileRenameInfo,
                        buffer.as_ptr().cast(),
                        buffer.len() as u32,
                    )
                }
                .map_err(|error| format!("Failed to quarantine trash source handle: {error}"))
            };
            let move_path = |from: &Path, to: &Path| -> Result<(), String> {
                let encode = |path: &Path| {
                    let display = path.to_string_lossy();
                    let api_path = if display.starts_with(r"\\?\") {
                        display.into_owned()
                    } else {
                        format!(r"\\?\{display}")
                    };
                    api_path.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>()
                };
                let from = encode(from);
                let to = encode(to);
                unsafe {
                    MoveFileExW(
                        PCWSTR(from.as_ptr()),
                        PCWSTR(to.as_ptr()),
                        MOVE_FILE_FLAGS(MOVEFILE_WRITE_THROUGH.0),
                    )
                }
                .map_err(|error| format!("Trash rollback path move failed: {error}"))
            };
            let final_path_for_handle = |file: &fs::File| -> Option<PathBuf> {
                let mut path = vec![0_u16; 32_768];
                let length = unsafe {
                    GetFinalPathNameByHandleW(
                        HANDLE(file.as_raw_handle()),
                        &mut path,
                        GETFINALPATHNAMEBYHANDLE_FLAGS(FILE_NAME_NORMALIZED.0 | VOLUME_NAME_DOS.0),
                    )
                } as usize;
                (length > 0 && length < path.len())
                    .then(|| PathBuf::from(String::from_utf16_lossy(&path[..length])))
            };

            let original_handle = self.file_handle;
            let recovery_handle = original_handle
                .try_clone()
                .map_err(|error| format!("Failed to clone trash recovery handle: {error}"))?;
            let rejected_path = self
                .canonical_folder
                .join(format!(".lightframe-rejected-trash-{}", uuid::Uuid::new_v4()));
            let recovery_link_path = self
                .canonical_folder
                .join(format!(".lightframe-trash-recovery-{}", uuid::Uuid::new_v4()));
            let mut trash_transaction = SourceReplacementRecovery::new(|reason| {
                if verify_pinned_file(&recovery_handle, &self.canonical_path, "Trash source")
                    .is_ok()
                {
                    if recovery_link_path.exists() {
                        fs::remove_file(&recovery_link_path).map_err(|error| {
                            format!(
                                "{reason}; canonical source is intact but recovery link '{}' could not be removed: {error}",
                                recovery_link_path.display()
                            )
                        })?;
                    }
                    return Ok(());
                }
                if fs::symlink_metadata(&self.canonical_path).is_ok() {
                    move_path(&self.canonical_path, &rejected_path).map_err(|error| {
                        format!("{reason}; trash handoff decoy could not be quarantined: {error}")
                    })?;
                }
                if recovery_link_path.exists() {
                    if let Some(handoff_path) = final_path_for_handle(&recovery_handle) {
                        let is_recovery_link =
                            handoff_path.file_name() == recovery_link_path.file_name();
                        if !is_recovery_link
                            && handoff_path != self.canonical_path
                            && handoff_path.exists()
                            && verify_pinned_file(
                                &recovery_handle,
                                &handoff_path,
                                "Rejected exact trash handoff",
                            )
                            .is_ok()
                        {
                            fs::remove_file(&handoff_path).map_err(|error| {
                                format!(
                                    "{reason}; rejected exact trash handoff '{}' could not be removed: {error}",
                                    handoff_path.display()
                                )
                            })?;
                        }
                    }
                    fs::hard_link(&recovery_link_path, &self.canonical_path).map_err(|error| {
                        format!(
                            "{reason}; exact trash recovery link could not restore '{}': {error}",
                            self.canonical_path.display()
                        )
                    })?;
                    verify_pinned_file(
                        &recovery_handle,
                        &self.canonical_path,
                        "Restored exact trash source",
                    )?;
                    fs::remove_file(&recovery_link_path).map_err(|error| {
                        format!(
                            "{reason}; exact source restored but recovery link '{}' retained: {error}",
                            recovery_link_path.display()
                        )
                    })?;
                    if rejected_path.exists() {
                        fs::remove_file(&rejected_path).map_err(|error| {
                            format!(
                                "{reason}; exact source restored but rejected artifact '{}' retained: {error}",
                                rejected_path.display()
                            )
                        })?;
                    }
                    return Ok(());
                }
                rename_handle(&recovery_handle, &self.canonical_path)?;
                verify_pinned_file(
                    &recovery_handle,
                    &self.canonical_path,
                    "Restored exact trash source",
                )?;
                if rejected_path.exists() {
                    fs::remove_file(&rejected_path).map_err(|error| {
                        format!(
                            "{reason}; exact source restored but rejected artifact '{}' retained: {error}",
                            rejected_path.display()
                        )
                    })?;
                }
                Ok(())
            });
            let quarantine_handle = trash_transaction.mutate("Trash quarantine failed", || {
                rename_handle(&original_handle, &quarantine_path)?;
                let handle = open_replaceable_image_file(&quarantine_path)?;
                verify_pinned_file(&original_handle, &quarantine_path, "Quarantined trash source")?;
                rename_handle(&handle, &self.canonical_path)?;
                verify_pinned_file(&handle, &self.canonical_path, "Restored trash source")?;
                Ok(handle)
            })?;
            drop(original_handle);
            let current_sid = match current_windows_user_sid() {
                Ok(sid) => sid,
                Err(error) => return trash_transaction.fail(error),
            };
            if let Err(error) = fs::hard_link(&self.canonical_path, &recovery_link_path) {
                return trash_transaction.fail(format!(
                    "Failed to create exact trash recovery link '{}': {error}",
                    recovery_link_path.display()
                ));
            }
            let exact_object_was_trashed = || -> bool {
                final_path_for_handle(&quarantine_handle)
                    .is_some_and(|moved| is_current_user_recycle_path(&moved, &current_sid))
            };
            match trash_action(&self.canonical_path) {
                Ok(()) if exact_object_was_trashed() => {
                    if let Err(error) = fs::remove_file(&recovery_link_path) {
                        return trash_transaction.fail(format!(
                            "Trash handoff succeeded but recovery link '{}' could not be removed: {error}",
                            recovery_link_path.display()
                        ));
                    }
                    trash_transaction.commit();
                    Ok(TrashCommitOutcome::durable())
                }
                Ok(()) => trash_transaction.fail(
                    "Trash handoff did not place the exact object in the current user's recycle bin"
                        .into(),
                ),
                Err(error) => trash_transaction.fail(error),
            }
        }

        #[cfg(target_os = "linux")]
        {
            use std::ffi::CString;
            use std::os::fd::{AsRawFd, FromRawFd};
            use std::os::unix::ffi::OsStrExt;
            use std::os::unix::fs::MetadataExt;
            let source = CString::new(original_name.as_bytes())
                .map_err(|_| "Trash source name contains NUL".to_string())?;
            let quarantine = CString::new(quarantine_name.as_bytes()).unwrap();
            let rename = |from: &CString, to: &CString| -> std::io::Result<()> {
                let result = unsafe {
                    libc::syscall(
                        libc::SYS_renameat2,
                        self.directory_handle.as_raw_fd(),
                        from.as_ptr(),
                        self.directory_handle.as_raw_fd(),
                        to.as_ptr(),
                        libc::RENAME_NOREPLACE,
                    )
                };
                if result == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::last_os_error())
                }
            };
            let pinned = self.file_handle.metadata().map_err(|error| error.to_string())?;
            let rejected =
                CString::new(format!(".lightframe-rejected-trash-{}", uuid::Uuid::new_v4()))
                    .unwrap();
            let trash_handoff_handle = std::cell::RefCell::new(None::<fs::File>);
            let preserved_recovery_artifacts =
                std::cell::RefCell::new(Vec::<LinuxPreservedRecoveryArtifact>::new());
            let handoff_isolation = std::cell::RefCell::new(None::<LinuxHandoffAliasIsolation>);
            let quarantine_isolation = std::cell::RefCell::new(None::<LinuxHandoffAliasIsolation>);
            let report_preserved_recovery_artifacts = |error: String| {
                let artifacts = preserved_recovery_artifacts.borrow();
                linux_report_preserved_recovery_artifacts(error, &artifacts)
            };
            let mut trash_transaction = SourceReplacementRecovery::new(|reason| {
                if let Some(handoff) = trash_handoff_handle.borrow().as_ref() {
                    if let Ok(link) =
                        fs::read_link(format!("/proc/self/fd/{}", handoff.as_raw_fd()))
                    {
                        let link_display = link.to_string_lossy();
                        let quarantine_path =
                            self.canonical_folder.join(quarantine.to_string_lossy().as_ref());
                        if !link_display.ends_with(" (deleted)")
                            && link != self.canonical_path
                            && link != quarantine_path
                        {
                            if link.parent() == Some(self.canonical_folder.as_path()) {
                                let isolation = linux_isolate_handoff_alias(
                                    &handoff_isolation,
                                    &self.directory_handle,
                                    link.file_name().ok_or_else(|| {
                                        format!("{reason}; handoff alias has no file name")
                                    })?,
                                    handoff,
                                    || Ok(()),
                                    || Ok(()),
                                    |_| Ok(()),
                                )
                                .map_err(|error| format!("{reason}; {error}"))?;
                                let identity = if isolation.identity
                                    == LinuxIsolationIdentity::Exact
                                {
                                    "exact handoff alias"
                                } else if isolation.identity == LinuxIsolationIdentity::Mismatched {
                                    "identity-mismatched handoff alias"
                                } else {
                                    "unverified handoff alias"
                                };
                                linux_record_preserved_recovery_artifact(
                                    &preserved_recovery_artifacts,
                                    self.canonical_folder.join(isolation.recovery_name),
                                    identity,
                                );
                            } else {
                                let identity = open_readonly_nofollow_file(
                                    &link,
                                    "Outside-canonical trash handoff",
                                )
                                .and_then(|candidate| linux_same_file(handoff, &candidate))
                                .map(|is_exact| {
                                    if is_exact {
                                        "exact outside-canonical handoff path"
                                    } else {
                                        "identity-mismatched outside-canonical handoff path"
                                    }
                                })
                                .unwrap_or("unverified outside-canonical handoff path");
                                linux_record_preserved_recovery_artifact(
                                    &preserved_recovery_artifacts,
                                    link,
                                    identity,
                                );
                            }
                        }
                    }
                }
                let source_fd = unsafe {
                    libc::openat(
                        self.directory_handle.as_raw_fd(),
                        source.as_ptr(),
                        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if source_fd >= 0 {
                    let current = unsafe { fs::File::from_raw_fd(source_fd) };
                    let current_metadata = current.metadata().map_err(|error| error.to_string())?;
                    if current_metadata.dev() == pinned.dev()
                        && current_metadata.ino() == pinned.ino()
                    {
                        let isolation = linux_isolate_handoff_alias(
                            &quarantine_isolation,
                            &self.directory_handle,
                            std::ffi::OsStr::from_bytes(quarantine.to_bytes()),
                            &self.file_handle,
                            || Ok(()),
                            || Ok(()),
                            |_| Ok(()),
                        )
                        .map_err(|error| {
                            format!("{reason}; failed to preserve trash recovery link: {error}")
                        })?;
                        let identity = if isolation.identity == LinuxIsolationIdentity::Exact {
                            "exact retained trash recovery link"
                        } else if isolation.identity == LinuxIsolationIdentity::Mismatched {
                            "identity-mismatched retained trash recovery link"
                        } else {
                            "unverified retained trash recovery link"
                        };
                        linux_record_preserved_recovery_artifact(
                            &preserved_recovery_artifacts,
                            self.canonical_folder.join(isolation.recovery_name),
                            identity,
                        );
                        self.directory_handle.sync_all().map_err(|error| {
                            format!("{reason}; restored trash source sync failed: {error}")
                        })?;
                        return Ok(());
                    }
                    rename(&source, &rejected).map_err(|error| {
                        format!("{reason}; failed to preserve trash decoy: {error}")
                    })?;
                    linux_record_preserved_recovery_artifact(
                        &preserved_recovery_artifacts,
                        self.canonical_folder.join(rejected.to_string_lossy().as_ref()),
                        "canonical-name collision",
                    );
                }
                rename(&quarantine, &source).map_err(|error| {
                    format!("{reason}; failed to restore exact trash source: {error}")
                })?;
                let restored =
                    linux_open_named_nofollow(self.directory_handle.as_raw_fd(), &source)
                        .map_err(|error| error.to_string())?;
                let restored_metadata = restored.metadata().map_err(|error| error.to_string())?;
                if restored_metadata.dev() != pinned.dev()
                    || restored_metadata.ino() != pinned.ino()
                {
                    return Err(format!("{reason}; canonical trash rollback identity mismatch"));
                }
                self.directory_handle.sync_all().map_err(|error| {
                    format!("{reason}; exact trash rollback sync failed: {error}")
                })?;
                Ok(())
            });
            let handoff_handle = trash_transaction
                .mutate("Failed to quarantine trash source", || {
                    rename(&source, &quarantine).map_err(|error| error.to_string())?;
                    let quarantine_handle =
                        linux_open_named_nofollow(self.directory_handle.as_raw_fd(), &quarantine)
                            .map_err(|error| error.to_string())?;
                    let quarantined =
                        quarantine_handle.metadata().map_err(|error| error.to_string())?;
                    if pinned.dev() != quarantined.dev() || pinned.ino() != quarantined.ino() {
                        return Err("Trash source identity changed during quarantine".into());
                    }
                    let linked = unsafe {
                        libc::linkat(
                            self.directory_handle.as_raw_fd(),
                            quarantine.as_ptr(),
                            self.directory_handle.as_raw_fd(),
                            source.as_ptr(),
                            0,
                        )
                    };
                    if linked != 0 {
                        return Err(format!(
                            "Failed to create durable trash recovery link: {}",
                            std::io::Error::last_os_error()
                        ));
                    }
                    let handoff =
                        linux_open_named_nofollow(self.directory_handle.as_raw_fd(), &source)
                            .map_err(|error| error.to_string())?;
                    let handoff_metadata = handoff.metadata().map_err(|error| error.to_string())?;
                    if handoff_metadata.dev() != pinned.dev()
                        || handoff_metadata.ino() != pinned.ino()
                    {
                        return Err("Trash handoff link is not the exact pinned object".into());
                    }
                    self.directory_handle
                        .sync_all()
                        .map_err(|error| format!("Failed to sync trash recovery link: {error}"))?;
                    Ok(handoff)
                })
                .map_err(&report_preserved_recovery_artifacts)?;
            let retained_handoff = match handoff_handle.try_clone() {
                Ok(handle) => handle,
                Err(error) => {
                    return trash_transaction
                        .fail(format!("Failed to retain trash handoff proof: {error}"))
                        .map_err(&report_preserved_recovery_artifacts)
                }
            };
            *trash_handoff_handle.borrow_mut() = Some(retained_handoff);
            let exact_object_was_trashed = || -> bool {
                let link = fs::read_link(format!("/proc/self/fd/{}", handoff_handle.as_raw_fd()));
                let Ok(path) = link else {
                    return false;
                };
                // A generic unlinked inode is not an operating-system trash handoff.
                if path.to_string_lossy().ends_with(" (deleted)") {
                    return false;
                }
                let Ok(moved) = fs::canonicalize(&path) else {
                    return false;
                };
                let Some(parent) = moved.parent() else {
                    return false;
                };
                let Some(file_name) = moved.file_name() else {
                    return false;
                };
                let Some(source_mount_root) =
                    linux_mount_root_for_path(&self.canonical_folder, pinned.dev())
                else {
                    return false;
                };
                let trusted_data_root =
                    std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| {
                        std::env::var_os("HOME")
                            .map(|home| PathBuf::from(home).join(".local").join("share"))
                    });
                if let Some(root) = trusted_data_root {
                    let files = root.join("Trash").join("files");
                    let info = root
                        .join("Trash")
                        .join("info")
                        .join(format!("{}.trashinfo", file_name.to_string_lossy()));
                    if fs::canonicalize(&files).is_ok_and(|trusted| trusted == parent)
                        && trashinfo_proves_original(&info, &self.canonical_path, None)
                    {
                        return true;
                    }
                }
                let uid = unsafe { libc::geteuid() };
                let Some(files_name) = parent.file_name() else {
                    return false;
                };
                let Some(trash_root) = parent.parent() else {
                    return false;
                };
                let expected_root_name = format!(".Trash-{uid}");
                if files_name != "files" {
                    return false;
                }
                use std::os::unix::fs::{MetadataExt, PermissionsExt};
                let info = trash_root
                    .join("info")
                    .join(format!("{}.trashinfo", file_name.to_string_lossy()));
                if trash_root.file_name().and_then(|name| name.to_str())
                    == Some(expected_root_name.as_str())
                {
                    if trash_root.parent().and_then(|path| fs::canonicalize(path).ok())
                        != Some(source_mount_root.clone())
                    {
                        return false;
                    }
                    return fs::symlink_metadata(trash_root).is_ok_and(|metadata| {
                        metadata.is_dir() && metadata.uid() == uid && metadata.dev() == pinned.dev()
                    }) && trashinfo_proves_original(
                        &info,
                        &self.canonical_path,
                        trash_root.parent(),
                    );
                }
                let Some(shared_trash) = trash_root.parent() else {
                    return false;
                };
                if trash_root.file_name().and_then(|name| name.to_str())
                    != Some(uid.to_string().as_str())
                    || shared_trash.file_name().and_then(|name| name.to_str()) != Some(".Trash")
                {
                    return false;
                }
                if shared_trash.parent().and_then(|path| fs::canonicalize(path).ok())
                    != Some(source_mount_root)
                {
                    return false;
                }
                fs::symlink_metadata(shared_trash).is_ok_and(|metadata| {
                    metadata.is_dir()
                        && metadata.permissions().mode() & 0o1000 != 0
                        && metadata.dev() == pinned.dev()
                }) && fs::symlink_metadata(trash_root).is_ok_and(|metadata| {
                    metadata.is_dir() && metadata.uid() == uid && metadata.dev() == pinned.dev()
                }) && trashinfo_proves_original(&info, &self.canonical_path, shared_trash.parent())
            };
            match trash_action(&self.canonical_path) {
                Ok(()) if exact_object_was_trashed() => {
                    trash_transaction.commit();
                    Ok(linux_finalize_authoritative_trash(
                        &self.directory_handle,
                        &self.canonical_folder,
                        &quarantine_isolation,
                        std::ffi::OsStr::from_bytes(quarantine.to_bytes()),
                        &self.file_handle,
                        || Ok(()),
                        || Ok(()),
                    ))
                }
                Ok(()) => trash_transaction
                    .fail(
                        "Trash handoff did not produce authoritative trash metadata for the exact object"
                            .into(),
                    )
                    .map_err(&report_preserved_recovery_artifacts),
                Err(error) => trash_transaction
                    .fail(error)
                    .map_err(report_preserved_recovery_artifacts),
            }
        }

        #[cfg(all(unix, not(target_os = "linux")))]
        {
            let _ = trash_action;
            Err("Identity-bound trash is unavailable on this platform".into())
        }
    }

    pub fn source_directory_lease(&self) -> Result<DestinationAuthorityLease, String> {
        Ok(DestinationAuthorityLease {
            canonical_folder: self.canonical_folder.clone(),
            path_case_semantics: self.path_case_semantics,
            directory_handle: self
                .directory_handle
                .try_clone()
                .map_err(|error| format!("Failed to clone source directory authority: {error}"))?,
        })
    }

    pub fn snapshot_for_path_consumer(
        &self,
        operation: crate::image_resource_policy::OperationClass,
    ) -> Result<AuthorizedSourceSnapshot, String> {
        use std::io::{Read, Seek, Write};

        self.revalidate()?;
        let limits = crate::image_resource_policy::PolicyLimits::for_operation(operation);
        let expected_length = self
            .file_handle
            .metadata()
            .map_err(|error| format!("Failed to inspect authorized input handle: {error}"))?
            .len();
        crate::image_resource_policy::validate_file_size_bytes(expected_length, &limits)
            .map_err(|error| error.to_string())?;
        let root = std::env::temp_dir().join("lightframe-authorized-inputs");
        fs::create_dir_all(&root)
            .map_err(|error| format!("Failed to create authorized input root: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .map_err(|error| format!("Failed to secure authorized input root: {error}"))?;
        }

        let directory = root.join(format!("snapshot_{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory)
            .map_err(|error| format!("Failed to create authorized input directory: {error}"))?;
        let mut snapshot =
            AuthorizedSourceSnapshot { path: directory.join("source.pending"), directory };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&snapshot.directory, fs::Permissions::from_mode(0o700))
                .map_err(|error| format!("Failed to secure authorized input directory: {error}"))?;
        }

        let extension = self
            .canonical_path
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| value.bytes().all(|byte| byte.is_ascii_alphanumeric()))
            .map(|value| format!(".{value}"))
            .unwrap_or_default();
        snapshot.path = snapshot.directory.join(format!("source{extension}"));
        let mut output =
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&snapshot.path)
                .map_err(|error| format!("Failed to create authorized input snapshot: {error}"))?;
        let mut input = self.try_clone_file()?;
        input
            .seek(std::io::SeekFrom::Start(0))
            .map_err(|error| format!("Failed to seek authorized image handle: {error}"))?;
        let copied = std::io::copy(&mut input.take(expected_length.saturating_add(1)), &mut output)
            .map_err(|error| format!("Failed to snapshot authorized image handle: {error}"))?;
        if copied != expected_length {
            return Err("Authorized image length changed while creating decoder snapshot".into());
        }
        output
            .flush()
            .map_err(|error| format!("Failed to flush authorized input snapshot: {error}"))?;
        drop(output);
        if self
            .file_handle
            .metadata()
            .map_err(|error| format!("Failed to recheck authorized input handle: {error}"))?
            .len()
            != expected_length
        {
            return Err("Authorized image length changed after decoder snapshot".into());
        }
        self.revalidate()?;
        Ok(snapshot)
    }

    pub fn move_to_destination(
        &self,
        destination: &DestinationAuthorityLease,
        target_name: &std::ffi::OsStr,
    ) -> Result<MoveCommitOutcome, String> {
        self.move_to_destination_with_failure(destination, target_name, MoveFailurePoint::None)
    }

    fn move_to_destination_with_failure(
        &self,
        destination: &DestinationAuthorityLease,
        target_name: &std::ffi::OsStr,
        failure: MoveFailurePoint,
    ) -> Result<MoveCommitOutcome, String> {
        self.revalidate()?;
        destination.revalidate()?;
        #[cfg(unix)]
        let source_name = self
            .canonical_path
            .file_name()
            .ok_or_else(|| "Authorized source file name is missing".to_string())?;

        #[cfg(windows)]
        {
            use std::io::{Read, Seek, Write};
            use std::os::windows::ffi::OsStrExt;
            use std::os::windows::fs::OpenOptionsExt;
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::Foundation::HANDLE;
            use windows::Win32::Storage::FileSystem::{
                FileDispositionInfo, FileRenameInfo, SetFileInformationByHandle,
                FILE_DISPOSITION_INFO, FILE_RENAME_INFO,
            };

            let mark_delete = |file: &fs::File| -> Result<(), String> {
                let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
                unsafe {
                    SetFileInformationByHandle(
                        HANDLE(file.as_raw_handle()),
                        FileDispositionInfo,
                        (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                        std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
                    )
                }
                .map_err(|error| format!("Failed to delete authorized file handle: {error}"))
            };

            let rename_handle =
                |file: &fs::File, path: &Path| -> Result<(), windows::core::Error> {
                    let target: Vec<u16> = path.as_os_str().encode_wide().collect();
                    let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
                    let mut buffer = vec![0_u8; offset + target.len() * std::mem::size_of::<u16>()];
                    let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
                    unsafe {
                        (*info).Anonymous.ReplaceIfExists = false;
                        (*info).RootDirectory = HANDLE(std::ptr::null_mut());
                        (*info).FileNameLength = (target.len() * std::mem::size_of::<u16>()) as u32;
                        std::ptr::copy_nonoverlapping(
                            target.as_ptr(),
                            (*info).FileName.as_mut_ptr(),
                            target.len(),
                        );
                        SetFileInformationByHandle(
                            HANDLE(file.as_raw_handle()),
                            FileRenameInfo,
                            buffer.as_ptr().cast(),
                            buffer.len() as u32,
                        )
                    }
                };

            let target_path = destination.canonical_folder.join(target_name);
            if failure == MoveFailurePoint::None {
                match rename_handle(&self.file_handle, &target_path) {
                    Ok(()) => return Ok(MoveCommitOutcome::durable(target_path)),
                    Err(error) if error.code().0 as u32 != 0x8007_0011 => {
                        return Err(format!("Failed to move authorized image handle: {error}"));
                    }
                    Err(_) => {}
                }
            }

            // Cross-volume fallback: copy from the pinned source handle into a pinned destination
            // staging handle, durably publish that exact handle, then delete the source identity.
            let extension = target_path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| format!(".{value}"))
                .unwrap_or_default();
            let staging_path = destination.canonical_folder.join(format!(
                ".lightframe-move-{}{}",
                uuid::Uuid::new_v4(),
                extension
            ));
            let mut staging = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .access_mode(0xC000_0000 | 0x0001_0000)
                .share_mode(0x0000_0001 | 0x0000_0002)
                .custom_flags(0x0020_0000)
                .open(&staging_path)
                .map_err(|error| format!("Failed to create cross-volume move staging: {error}"))?;
            let mut source = self.try_clone_file()?;
            source
                .seek(std::io::SeekFrom::Start(0))
                .map_err(|error| format!("Failed to seek move source handle: {error}"))?;
            let expected = source.metadata().map_err(|error| error.to_string())?.len();
            let copied = std::io::copy(
                &mut std::io::Read::by_ref(&mut source).take(expected + 1),
                &mut staging,
            )
            .map_err(|error| format!("Failed to copy cross-volume move source: {error}"))?;
            if copied != expected {
                drop(staging);
                let _ = fs::remove_file(&staging_path);
                return Err("Move source length changed during cross-volume copy".into());
            }
            staging
                .flush()
                .and_then(|_| staging.sync_all())
                .map_err(|error| format!("Failed to durably flush cross-volume move: {error}"))?;
            if let Err(error) = rename_handle(&staging, &target_path) {
                drop(staging);
                let _ = fs::remove_file(&staging_path);
                return Err(format!("Failed to publish cross-volume move: {error}"));
            }
            let source_delete = if matches!(
                failure,
                MoveFailurePoint::DuringPublishedMetadata
                    | MoveFailurePoint::DuringDestinationSync
                    | MoveFailurePoint::DuringDestinationRollback
                    | MoveFailurePoint::DuringDestinationRollbackSync
                    | MoveFailurePoint::DuringCommittedDestinationSync
                    | MoveFailurePoint::DuringSourceUnlink
            ) {
                Err(format!("Injected post-publication move failure: {failure:?}"))
            } else {
                mark_delete(&self.file_handle)
            };
            if let Err(error) = source_delete {
                let destination_rollback = if failure == MoveFailurePoint::DuringDestinationRollback
                {
                    Err("Injected destination rollback failure".to_string())
                } else {
                    mark_delete(&staging)
                };
                return match destination_rollback {
                    Ok(()) => Err(format!(
                        "{error}; exact published destination rolled back and source was not removed"
                    )),
                    Err(rollback_error) => Ok(MoveCommitOutcome::with_warning(
                        target_path.clone(),
                        format!(
                            "Destination committed at '{}'; {error}; exact destination rollback failed: {rollback_error}. The source remains and this operation must not be retried automatically.",
                            target_path.display()
                        ),
                        false,
                    )),
                };
            }
            if failure == MoveFailurePoint::DuringSourceSync {
                return Ok(MoveCommitOutcome::with_warning(
                    target_path.clone(),
                    format!(
                        "Move committed at '{}' and the source was removed, but source durability could not be confirmed",
                        target_path.display()
                    ),
                    true,
                ));
            }
            Ok(MoveCommitOutcome::durable(target_path))
        }

        #[cfg(target_os = "linux")]
        {
            use std::ffi::CString;
            use std::io::{Read, Seek, Write};
            use std::os::fd::{AsRawFd, FromRawFd};
            use std::os::unix::ffi::OsStrExt;
            use std::os::unix::fs::MetadataExt;

            let source = CString::new(source_name.as_bytes())
                .map_err(|_| "Authorized source name contains NUL".to_string())?;
            let target = CString::new(target_name.as_bytes())
                .map_err(|_| "Destination name contains NUL".to_string())?;
            let temporary_name = format!(".lightframe-move-{}", uuid::Uuid::new_v4());
            let temporary = CString::new(temporary_name.as_bytes()).unwrap();
            let recovery_path = self.canonical_folder.join(&temporary_name);
            let target_path = destination.canonical_folder.join(target_name);
            let rejected =
                CString::new(format!(".lightframe-rejected-move-{}", uuid::Uuid::new_v4()))
                    .unwrap();
            let rename_no_replace =
                |from_dir: i32, from: &CString, to_dir: i32, to: &CString| -> std::io::Result<()> {
                    let result = unsafe {
                        libc::syscall(
                            libc::SYS_renameat2,
                            from_dir,
                            from.as_ptr(),
                            to_dir,
                            to.as_ptr(),
                            libc::RENAME_NOREPLACE,
                        )
                    };
                    if result == 0 {
                        Ok(())
                    } else {
                        Err(std::io::Error::last_os_error())
                    }
                };
            let mut move_recovery = SourceReplacementRecovery::new(|context| {
                if failure == MoveFailurePoint::DuringRollback {
                    return Err(format!(
                        "{context}; rollback was injected and the exact source is recoverable at '{}'",
                        recovery_path.display()
                    ));
                }
                if let Ok(current) =
                    linux_open_named_nofollow(self.directory_handle.as_raw_fd(), &source)
                {
                    if linux_same_file(&self.file_handle, &current)? {
                        self.directory_handle.sync_all().map_err(|error| {
                            format!("{context}; source is canonical but sync failed: {error}")
                        })?;
                        return Ok(());
                    }
                    rename_no_replace(
                        self.directory_handle.as_raw_fd(),
                        &source,
                        self.directory_handle.as_raw_fd(),
                        &rejected,
                    )
                    .map_err(|error| {
                        format!("{context}; changed source entry could not be preserved: {error}")
                    })?;
                }
                let exact_name =
                    linux_directory_entry_for_identity(&self.directory_handle, &self.file_handle)?
                        .ok_or_else(|| {
                            format!(
                        "{context}; exact source is recoverable only through its pinned handle"
                    )
                        })?;
                let exact_name = CString::new(exact_name.as_bytes())
                    .map_err(|_| "Recovered move source name contains NUL".to_string())?;
                rename_no_replace(
                    self.directory_handle.as_raw_fd(),
                    &exact_name,
                    self.directory_handle.as_raw_fd(),
                    &source,
                )
                .map_err(|error| format!("{context}; exact source restore failed: {error}"))?;
                let restored =
                    linux_open_named_nofollow(self.directory_handle.as_raw_fd(), &source)
                        .map_err(|error| error.to_string())?;
                if !linux_same_file(&self.file_handle, &restored)? {
                    return Err(format!("{context}; restored source identity mismatch"));
                }
                let cleaned = unsafe {
                    libc::unlinkat(self.directory_handle.as_raw_fd(), rejected.as_ptr(), 0)
                };
                if cleaned != 0
                    && std::io::Error::last_os_error().kind() != std::io::ErrorKind::NotFound
                {
                    return Err(format!(
                        "{context}; rejected move artifact '{}' retained: {}",
                        rejected.to_string_lossy(),
                        std::io::Error::last_os_error()
                    ));
                }
                self.directory_handle
                    .sync_all()
                    .map_err(|error| format!("{context}; source restore sync failed: {error}"))
            });
            move_recovery.mutate("Failed to quarantine authorized move source", || {
                rename_no_replace(
                    self.directory_handle.as_raw_fd(),
                    &source,
                    self.directory_handle.as_raw_fd(),
                    &temporary,
                )
                .map_err(|error| error.to_string())
            })?;
            if failure == MoveFailurePoint::AfterQuarantine
                || failure == MoveFailurePoint::DuringRollback
            {
                return move_recovery.fail("Injected failure after source quarantine".into());
            }

            let staged_fd = unsafe {
                libc::openat(
                    self.directory_handle.as_raw_fd(),
                    temporary.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if staged_fd < 0 {
                return move_recovery.fail("Failed to verify quarantined move source".into());
            }
            let mut staged = unsafe { fs::File::from_raw_fd(staged_fd) };
            let pinned_metadata = match self.file_handle.metadata() {
                Ok(metadata) => metadata,
                Err(error) => {
                    return move_recovery
                        .fail(format!("Failed to inspect pinned move source: {error}"))
                }
            };
            let staged_metadata = match staged.metadata() {
                Ok(metadata) => metadata,
                Err(error) => {
                    return move_recovery
                        .fail(format!("Failed to inspect quarantined move source: {error}"))
                }
            };
            if pinned_metadata.dev() != staged_metadata.dev()
                || pinned_metadata.ino() != staged_metadata.ino()
            {
                return move_recovery
                    .fail("Authorized move source identity changed before commit".into());
            }
            let force_cross_volume_path = matches!(
                failure,
                MoveFailurePoint::DuringCopy
                    | MoveFailurePoint::DuringLink
                    | MoveFailurePoint::DuringPublishedMetadata
                    | MoveFailurePoint::DuringDestinationSync
                    | MoveFailurePoint::DuringDestinationRollback
                    | MoveFailurePoint::DuringDestinationRollbackSync
                    | MoveFailurePoint::DuringSourceUnlink
                    | MoveFailurePoint::DuringSourceSync
            );
            let direct_rename = if force_cross_volume_path {
                Err(std::io::Error::from_raw_os_error(libc::EXDEV))
            } else {
                rename_no_replace(
                    self.directory_handle.as_raw_fd(),
                    &temporary,
                    destination.directory_handle.as_raw_fd(),
                    &target,
                )
            };
            match direct_rename {
                Ok(()) => {
                    // The rename itself is the commit point. Directory sync failures after this
                    // point are reported with the committed target rather than pretending the
                    // source can still be rolled back.
                    let destination_sync = if failure
                        == MoveFailurePoint::DuringCommittedDestinationSync
                    {
                        Err(std::io::Error::other("injected committed destination sync failure"))
                    } else {
                        destination.directory_handle.sync_all()
                    };
                    let source_sync = self.directory_handle.sync_all();
                    let mut warnings = Vec::new();
                    if let Err(error) = destination_sync {
                        warnings.push(format!(
                            "destination directory durability could not be confirmed: {error}"
                        ));
                    }
                    if let Err(error) = source_sync {
                        warnings.push(format!(
                            "source directory durability could not be confirmed: {error}"
                        ));
                    }
                    move_recovery.commit();
                    return if warnings.is_empty() {
                        Ok(MoveCommitOutcome::durable(target_path))
                    } else {
                        Ok(MoveCommitOutcome::with_warning(
                            target_path.clone(),
                            format!(
                                "Move committed at '{}', but {}",
                                target_path.display(),
                                warnings.join("; ")
                            ),
                            true,
                        ))
                    };
                }
                Err(error) if error.raw_os_error() != Some(libc::EXDEV) => {
                    return move_recovery
                        .fail(format!("Failed to publish authorized move: {error}"));
                }
                Err(_) => {}
            }

            // renameat2 cannot cross filesystems. Materialize into a securely named file created
            // relative to the pinned destination directory. This is usable by unprivileged
            // processes and on filesystems that support only ordinary named staging files.
            let destination_fd = destination.directory_handle.as_raw_fd();
            if failure == MoveFailurePoint::DuringCopy {
                return move_recovery.fail("Injected cross-volume copy failure".into());
            }
            let destination_staging_name =
                CString::new(format!(".lightframe-cross-volume-{}", uuid::Uuid::new_v4())).unwrap();
            let destination_staging_fd = unsafe {
                libc::openat(
                    destination_fd,
                    destination_staging_name.as_ptr(),
                    libc::O_RDWR
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    staged_metadata.mode() & 0o777,
                )
            };
            if destination_staging_fd < 0 {
                return move_recovery.fail(format!(
                    "Failed to create cross-volume move staging: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let cleanup_destination_staging =
                || unsafe { libc::unlinkat(destination_fd, destination_staging_name.as_ptr(), 0) };
            let mut output = unsafe { fs::File::from_raw_fd(destination_staging_fd) };
            let prepared_output = (|| -> Result<(), String> {
                staged
                    .seek(std::io::SeekFrom::Start(0))
                    .map_err(|error| format!("Failed to seek cross-volume move source: {error}"))?;
                let expected = staged_metadata.len();
                let copied = std::io::copy(
                    &mut std::io::Read::by_ref(&mut staged).take(expected + 1),
                    &mut output,
                )
                .map_err(|error| format!("Failed to copy cross-volume move source: {error}"))?;
                if copied != expected {
                    return Err("Move source length changed during cross-volume copy".into());
                }
                output.flush().and_then(|_| output.sync_all()).map_err(|error| {
                    format!("Failed to durably flush cross-volume move: {error}")
                })?;
                let current_staged = staged.metadata().map_err(|error| error.to_string())?;
                if current_staged.dev() != pinned_metadata.dev()
                    || current_staged.ino() != pinned_metadata.ino()
                    || current_staged.len() != expected
                {
                    return Err("Authorized move source changed during cross-volume copy".into());
                }
                let reopened_fd = unsafe {
                    libc::openat(
                        destination_fd,
                        destination_staging_name.as_ptr(),
                        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if reopened_fd < 0 {
                    return Err(format!(
                        "Failed to verify named cross-volume staging: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                let reopened = unsafe { fs::File::from_raw_fd(reopened_fd) };
                let output_metadata = output.metadata().map_err(|error| error.to_string())?;
                let reopened_metadata = reopened.metadata().map_err(|error| error.to_string())?;
                if output_metadata.dev() != reopened_metadata.dev()
                    || output_metadata.ino() != reopened_metadata.ino()
                {
                    return Err(
                        "Named cross-volume staging identity changed before publication".into()
                    );
                }
                Ok(())
            })();
            if let Err(error) = prepared_output {
                cleanup_destination_staging();
                return move_recovery.fail(error);
            }
            let expected_output_metadata = match output.metadata() {
                Ok(metadata) => metadata,
                Err(error) => {
                    cleanup_destination_staging();
                    return move_recovery
                        .fail(format!("Failed to retain cross-volume staging identity: {error}"));
                }
            };
            if failure == MoveFailurePoint::DuringLink {
                cleanup_destination_staging();
                return move_recovery.fail("Injected destination publication failure".into());
            }
            let mut published = unsafe {
                libc::syscall(
                    libc::SYS_renameat2,
                    destination_fd,
                    destination_staging_name.as_ptr(),
                    destination_fd,
                    target.as_ptr(),
                    libc::RENAME_NOREPLACE,
                )
            };
            if published != 0
                && matches!(
                    std::io::Error::last_os_error().raw_os_error(),
                    Some(libc::ENOSYS) | Some(libc::EINVAL) | Some(libc::EOPNOTSUPP)
                )
            {
                published = unsafe {
                    let linked = libc::linkat(
                        destination_fd,
                        destination_staging_name.as_ptr(),
                        destination_fd,
                        target.as_ptr(),
                        0,
                    );
                    if linked == 0 {
                        let _ =
                            libc::unlinkat(destination_fd, destination_staging_name.as_ptr(), 0);
                        0
                    } else {
                        linked
                    }
                } as i64;
            }
            if published != 0 {
                let publish_error = std::io::Error::last_os_error();
                cleanup_destination_staging();
                return move_recovery
                    .fail(format!("Failed to publish cross-volume move: {publish_error}"));
            }
            let rollback_published_destination = || -> Result<(), String> {
                if failure == MoveFailurePoint::DuringDestinationRollback {
                    return Err("injected destination rollback failure".into());
                }
                let current = linux_open_named_nofollow(destination_fd, &target)
                    .map_err(|error| format!("published target reopen failed: {error}"))?;
                let current_metadata = current.metadata().map_err(|error| error.to_string())?;
                if current_metadata.dev() != expected_output_metadata.dev()
                    || current_metadata.ino() != expected_output_metadata.ino()
                {
                    return Err(
                        "published target identity changed; different object preserved".into()
                    );
                }
                let rollback_anchor =
                    CString::new(format!(".lightframe-rollback-anchor-{}", uuid::Uuid::new_v4()))
                        .unwrap();
                let anchored = unsafe {
                    libc::linkat(
                        destination_fd,
                        target.as_ptr(),
                        destination_fd,
                        rollback_anchor.as_ptr(),
                        0,
                    )
                };
                if anchored != 0 {
                    return Err(format!(
                        "failed to create durable destination rollback anchor: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                if let Err(error) = destination.directory_handle.sync_all() {
                    unsafe {
                        libc::unlinkat(destination_fd, rollback_anchor.as_ptr(), 0);
                    }
                    return Err(format!("destination rollback anchor sync failed: {error}"));
                }
                let removed = unsafe { libc::unlinkat(destination_fd, target.as_ptr(), 0) };
                if removed != 0 {
                    unsafe {
                        libc::unlinkat(destination_fd, rollback_anchor.as_ptr(), 0);
                    }
                    return Err(format!(
                        "exact published destination unlink failed: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                let rollback_sync = if failure == MoveFailurePoint::DuringDestinationRollbackSync {
                    Err(std::io::Error::other("injected destination rollback sync failure"))
                } else {
                    destination.directory_handle.sync_all()
                };
                if let Err(error) = rollback_sync {
                    let restored = unsafe {
                        libc::syscall(
                            libc::SYS_renameat2,
                            destination_fd,
                            rollback_anchor.as_ptr(),
                            destination_fd,
                            target.as_ptr(),
                            libc::RENAME_NOREPLACE,
                        )
                    };
                    if restored == 0 {
                        let restore_sync = destination.directory_handle.sync_all();
                        return Err(format!(
                            "destination rollback sync failed: {error}; exact published destination was restored; restore sync={restore_sync:?}"
                        ));
                    }
                    return Err(format!(
                        "destination rollback sync failed: {error}; exact published destination restoration failed: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                let anchor_removed =
                    unsafe { libc::unlinkat(destination_fd, rollback_anchor.as_ptr(), 0) };
                if anchor_removed != 0 {
                    return Err(format!(
                        "destination rollback completed but rollback anchor cleanup failed: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                destination
                    .directory_handle
                    .sync_all()
                    .map_err(|error| format!("destination rollback cleanup sync failed: {error}"))
            };
            macro_rules! resolve_post_publish_failure {
                ($reason:expr) => {{
                    let reason: String = $reason;
                    match rollback_published_destination() {
                        Ok(()) => return move_recovery.fail(reason),
                        Err(rollback_error) => {
                            let target_is_committed = linux_open_named_nofollow(
                                destination_fd,
                                &target,
                            )
                            .map_err(|error| error.to_string())
                            .and_then(|file| {
                                let metadata = file.metadata().map_err(|error| error.to_string())?;
                                if metadata.dev() == expected_output_metadata.dev()
                                    && metadata.ino() == expected_output_metadata.ino()
                                {
                                    Ok(file)
                                } else {
                                    Err("published target identity changed".to_string())
                                }
                            })
                            .is_ok();
                            if !target_is_committed {
                                return move_recovery.fail(format!(
                                    "{reason}; destination rollback warning: {rollback_error}; target path is not committed"
                                ));
                            }
                            let source_recovery = move_recovery.recover_now(format!(
                                "{reason}; destination rollback failed: {rollback_error}"
                            ));
                            return Ok(MoveCommitOutcome::with_warning(
                                target_path.clone(),
                                format!(
                                    "Destination committed at '{}'; {reason}; destination rollback failed: {rollback_error}; source recovery={source_recovery:?}. The source may remain as a duplicate and this operation must not be retried automatically.",
                                    target_path.display()
                                ),
                                false,
                            ));
                        }
                    }
                }};
            }
            let published_fd = if matches!(
                failure,
                MoveFailurePoint::DuringPublishedMetadata
                    | MoveFailurePoint::DuringDestinationRollback
                    | MoveFailurePoint::DuringDestinationRollbackSync
            ) {
                -1
            } else {
                unsafe {
                    libc::openat(
                        destination_fd,
                        target.as_ptr(),
                        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                }
            };
            if published_fd < 0 {
                resolve_post_publish_failure!(format!(
                    "published destination identity could not be reopened: {}",
                    if matches!(
                        failure,
                        MoveFailurePoint::DuringPublishedMetadata
                            | MoveFailurePoint::DuringDestinationRollback
                            | MoveFailurePoint::DuringDestinationRollbackSync
                    ) {
                        std::io::Error::other("injected post-publication verification failure")
                    } else {
                        std::io::Error::last_os_error()
                    }
                ));
            }
            let published_file = unsafe { fs::File::from_raw_fd(published_fd) };
            let published_metadata = match published_file.metadata() {
                Ok(metadata) => metadata,
                Err(error) => resolve_post_publish_failure!(format!(
                    "published destination metadata failed: {error}"
                )),
            };
            if expected_output_metadata.dev() != published_metadata.dev()
                || expected_output_metadata.ino() != published_metadata.ino()
            {
                resolve_post_publish_failure!("Published destination identity changed".into());
            }
            let destination_sync = if failure == MoveFailurePoint::DuringDestinationSync {
                Err(std::io::Error::other("injected destination sync failure"))
            } else {
                destination.directory_handle.sync_all()
            };
            if let Err(sync_error) = destination_sync {
                resolve_post_publish_failure!(format!(
                    "destination directory sync failed: {sync_error}"
                ));
            }

            let removed = if failure == MoveFailurePoint::DuringSourceUnlink {
                -1
            } else {
                unsafe { libc::unlinkat(self.directory_handle.as_raw_fd(), temporary.as_ptr(), 0) }
            };
            if removed != 0 {
                let unlink_error = if failure == MoveFailurePoint::DuringSourceUnlink {
                    std::io::Error::other("injected source unlink failure")
                } else {
                    std::io::Error::last_os_error()
                };
                resolve_post_publish_failure!(format!(
                    "source unlink failed after destination publication: {unlink_error}"
                ));
            }
            move_recovery.commit();
            let source_sync = if failure == MoveFailurePoint::DuringSourceSync {
                Err(std::io::Error::other("injected source sync failure"))
            } else {
                self.directory_handle.sync_all()
            };
            if let Err(error) = source_sync {
                return Ok(MoveCommitOutcome::with_warning(
                    target_path.clone(),
                    format!(
                        "Move committed at '{}' and the source entry was removed, but source directory durability could not be confirmed: {error}",
                        target_path.display()
                    ),
                    true,
                ));
            }
            Ok(MoveCommitOutcome::durable(target_path))
        }

        #[cfg(all(unix, not(target_os = "linux")))]
        {
            let _ = (source_name, target_name, failure);
            Err("Identity-bound moves are not supported on this platform".to_string())
        }
    }
}

pub struct DestinationAuthorityLease {
    canonical_folder: PathBuf,
    directory_handle: fs::File,
    path_case_semantics: crate::path_normalization::PathCaseSemantics,
}

impl DestinationAuthorityLease {
    pub fn path(&self) -> &Path {
        &self.canonical_folder
    }

    pub fn path_case_semantics(&self) -> crate::path_normalization::PathCaseSemantics {
        self.path_case_semantics
    }

    pub fn revalidate(&self) -> Result<(), String> {
        verify_pinned_directory_parts(&self.directory_handle, &self.canonical_folder)
    }

    pub fn try_clone_directory(&self) -> Result<fs::File, String> {
        self.directory_handle
            .try_clone()
            .map_err(|error| format!("Failed to clone destination directory authority: {error}"))
    }
}

pub struct ExternalEditorAuthorityLease {
    canonical_path: PathBuf,
    executable_handle: fs::File,
}

impl ExternalEditorAuthorityLease {
    pub fn path(&self) -> &Path {
        &self.canonical_path
    }

    pub fn revalidate(&self) -> Result<(), String> {
        verify_pinned_file(&self.executable_handle, &self.canonical_path, "External editor")
    }
}

pub const MAX_BOUNDED_GRANTS: usize = 100;

#[derive(Default)]
pub struct SessionStore {
    pub sessions: HashMap<String, SessionInternal>,
    pub destination_grants: HashMap<String, DestinationGrantInternal>,
    pub external_editor_grants: HashMap<String, ExternalEditorGrantInternal>,
    pub projector_read_grants: std::collections::HashSet<(String, String, String)>,
    pub projector_navigation_generations: HashMap<String, u64>,
    pub projector_grant_epochs: HashMap<String, u64>,
    pub next_projector_grant_epoch: u64,
}

fn evict_oldest_destination_grant(store: &mut SessionStore) {
    if store.destination_grants.len() < MAX_BOUNDED_GRANTS {
        return;
    }
    if let Some(oldest_key) = store
        .destination_grants
        .iter()
        .min_by_key(|(_, grant)| grant.last_used_at_epoch)
        .map(|(key, _)| key.clone())
    {
        store.destination_grants.remove(&oldest_key);
    }
}

#[derive(Clone, Default)]
pub struct SessionManager {
    pub store: Arc<Mutex<SessionStore>>,
    refresh_lock: Arc<Mutex<()>>,
}

struct ScannedSessionImage {
    canonical_path: PathBuf,
    display_path: String,
    file_name: String,
    extension: String,
    size_bytes: u64,
    modified_at: Option<String>,
    created_at: Option<String>,
    identity: Option<String>,
}

fn bootstrap_directory_entry_budget(limit: usize) -> usize {
    limit.saturating_mul(4).max(limit).max(1)
}

#[cfg(test)]
fn record_test_scan_entry() {
    TEST_SCAN_ENTRY_COUNT.with(|count| count.set(count.get().saturating_add(1)));
    let hook = TEST_SCAN_ENTRY_HOOK.with(|hook| hook.borrow_mut().take());
    if let Some(hook) = hook {
        hook();
    }
}

#[cfg(test)]
fn reset_test_scan_entry_count() {
    TEST_SCAN_ENTRY_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
fn test_scan_entry_count() -> usize {
    TEST_SCAN_ENTRY_COUNT.with(|count| count.get())
}

#[cfg(test)]
fn set_test_scan_entry_hook(hook: impl FnOnce() + 'static) {
    TEST_SCAN_ENTRY_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

#[cfg(test)]
thread_local! {
    static TEST_SCAN_ENTRY_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static TEST_SCAN_ENTRY_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}

/// Threat model boundary note:
/// LightFrame's SessionManager encapsulates filesystem authority behind opaque identifiers
/// (SessionId, ImageId, DestinationGrantId, ExternalEditorGrantId).
/// Untrusted renderer IPC calls cannot supply arbitrary raw paths; all privileged image read,
/// edit, move, trash, and launch commands resolve target paths through authorized session state.
impl SessionManager {
    pub fn new() -> Self {
        Self {
            store: Arc::new(Mutex::new(SessionStore::default())),
            refresh_lock: Arc::new(Mutex::new(())),
        }
    }

    fn generate_opaque_id(&self, prefix: &str) -> String {
        format!("{}_{}", prefix, uuid::Uuid::new_v4().simple())
    }

    pub fn canonicalize_existing_file(path: &Path) -> Result<PathBuf, String> {
        let canonical = fs::canonicalize(path).map_err(|e| {
            format!("Path '{}' cannot be resolved or does not exist: {}", path.display(), e)
        })?;
        Ok(normalize_path_buf(&canonical))
    }

    pub fn canonicalize_output_target(path: &Path) -> Result<PathBuf, String> {
        let parent = path
            .parent()
            .ok_or_else(|| format!("Target path '{}' has no parent directory", path.display()))?;
        let canonical_parent = fs::canonicalize(parent).map_err(|e| {
            format!("Parent directory of '{}' cannot be resolved: {}", path.display(), e)
        })?;
        let filename = path
            .file_name()
            .ok_or_else(|| format!("Invalid target filename in '{}'", path.display()))?;
        Ok(normalize_path_buf(&canonical_parent.join(filename)))
    }

    pub fn canonicalize_path(path: &Path) -> Result<PathBuf, String> {
        if path.exists() {
            Self::canonicalize_existing_file(path)
        } else {
            Self::canonicalize_output_target(path)
        }
    }

    fn scanned_image_from_canonical_path(
        canonical_entry: PathBuf,
    ) -> Result<Option<ScannedSessionImage>, String> {
        if !is_supported_image_file(&canonical_entry) {
            return Ok(None);
        }
        let file_handle = open_replaceable_image_file(&canonical_entry)?;
        verify_pinned_file(&file_handle, &canonical_entry, "Authorized image")?;
        let metadata = file_handle
            .metadata()
            .map_err(|error| format!("Failed to inspect authorized image: {error}"))?;
        if !metadata.is_file() {
            return Ok(None);
        }
        let file_name =
            canonical_entry.file_name().and_then(|s| s.to_str()).unwrap_or_default().to_string();
        let extension = canonical_entry
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        let size_bytes = metadata.len();
        let identity = filesystem_identity(&canonical_entry, &metadata);
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_nanos().to_string());
        let created_at = metadata
            .created()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_nanos().to_string());
        let display_path = canonical_entry.to_string_lossy().to_string();

        Ok(Some(ScannedSessionImage {
            canonical_path: canonical_entry,
            display_path,
            file_name,
            extension,
            size_bytes,
            modified_at,
            created_at,
            identity,
        }))
    }

    fn cached_hint_to_scanned_image(
        hint_path: &Path,
        canonical_folder: &Path,
        path_case_semantics: crate::path_normalization::PathCaseSemantics,
    ) -> Option<ScannedSessionImage> {
        let hint_metadata = fs::symlink_metadata(hint_path).ok()?;
        if is_link_or_reparse_point(&hint_metadata) || !hint_metadata.is_file() {
            return None;
        }
        let canonical_entry = Self::canonicalize_existing_file(hint_path).ok()?;
        if !is_direct_child_with_semantics(&canonical_entry, canonical_folder, path_case_semantics)
        {
            return None;
        }
        Self::scanned_image_from_canonical_path(canonical_entry).ok().flatten()
    }

    fn scan_folder_images(
        canonical_folder: &Path,
        path_case_semantics: crate::path_normalization::PathCaseSemantics,
        limit: Option<usize>,
    ) -> Result<Vec<ScannedSessionImage>, String> {
        Self::scan_folder_images_with_controls(
            canonical_folder,
            path_case_semantics,
            limit,
            None,
            || Ok(()),
        )
    }

    fn scan_folder_images_with_controls<C>(
        canonical_folder: &Path,
        path_case_semantics: crate::path_normalization::PathCaseSemantics,
        accepted_limit: Option<usize>,
        entry_limit: Option<usize>,
        mut check_current: C,
    ) -> Result<Vec<ScannedSessionImage>, String>
    where
        C: FnMut() -> Result<(), String>,
    {
        let mut scanned_images = Vec::new();
        let mut examined_entries = 0usize;
        if let Ok(entries) = fs::read_dir(canonical_folder) {
            for entry in entries.flatten() {
                check_current()?;
                if accepted_limit.is_some_and(|limit| scanned_images.len() >= limit) {
                    break;
                }
                if entry_limit.is_some_and(|limit| examined_entries >= limit) {
                    break;
                }
                examined_entries = examined_entries.saturating_add(1);
                #[cfg(test)]
                record_test_scan_entry();
                let entry_path = entry.path();
                let Ok(entry_metadata) = fs::symlink_metadata(&entry_path) else {
                    continue;
                };
                if is_link_or_reparse_point(&entry_metadata) || !entry_metadata.is_file() {
                    continue;
                }
                let canonical_entry = match Self::canonicalize_existing_file(&entry_path) {
                    Ok(p) => p,
                    Err(_) => continue,
                };

                if !is_direct_child_with_semantics(
                    &canonical_entry,
                    canonical_folder,
                    path_case_semantics,
                ) {
                    continue;
                }

                if let Ok(Some(scanned)) = Self::scanned_image_from_canonical_path(canonical_entry)
                {
                    scanned_images.push(scanned);
                }
            }
        }
        Ok(scanned_images)
    }

    fn build_authorized_records(
        &self,
        session_id: &str,
        scanned_images: Vec<ScannedSessionImage>,
        store: &SessionStore,
    ) -> (HashMap<String, ImageRecordInternal>, Vec<AuthorizedImageRecord>) {
        let existing_by_path: HashMap<PathBuf, (Option<String>, String)> = store
            .sessions
            .get(session_id)
            .map(|session| {
                session
                    .images_by_id
                    .values()
                    .map(|record| {
                        (
                            record.canonical_path.clone(),
                            (record.filesystem_identity.clone(), record.id.clone()),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let existing_ids_by_identity: HashMap<String, Vec<String>> = store
            .sessions
            .get(session_id)
            .map(|session| {
                let mut by_identity: HashMap<String, Vec<String>> = HashMap::new();
                for record in session.images_by_id.values() {
                    if let Some(identity) = &record.filesystem_identity {
                        by_identity.entry(identity.clone()).or_default().push(record.id.clone());
                    }
                }
                for ids in by_identity.values_mut() {
                    ids.sort();
                }
                by_identity
            })
            .unwrap_or_default();

        // Reconcile in two passes. Exact paths are reusable only when the kernel identity is
        // unchanged, and each prior ID may be consumed once. Resolving exact-path matches first
        // keeps separate hard-link records stable; a later identity pass handles genuine renames.
        let mut assigned_ids = vec![None; scanned_images.len()];
        let mut force_new_identity = vec![false; scanned_images.len()];
        let mut consumed_ids = std::collections::HashSet::new();
        for (index, scanned) in scanned_images.iter().enumerate() {
            if let Some((previous_identity, previous_id)) =
                existing_by_path.get(&scanned.canonical_path)
            {
                if scanned.identity.is_some()
                    && scanned.identity.as_ref() == previous_identity.as_ref()
                {
                    assigned_ids[index] = Some(previous_id.clone());
                    consumed_ids.insert(previous_id.clone());
                } else {
                    // A same-name replacement is a new authority object even if another hard link
                    // happens to expose the replacement inode elsewhere in the folder.
                    force_new_identity[index] = true;
                }
            }
        }
        for (index, scanned) in scanned_images.iter().enumerate() {
            if assigned_ids[index].is_some() || force_new_identity[index] {
                continue;
            }
            let Some(identity) = &scanned.identity else {
                continue;
            };
            if let Some(previous_id) = existing_ids_by_identity
                .get(identity)
                .and_then(|ids| ids.iter().find(|id| !consumed_ids.contains(*id)))
            {
                assigned_ids[index] = Some(previous_id.clone());
                consumed_ids.insert(previous_id.clone());
            }
        }

        let mut images_by_id = HashMap::new();
        let mut snapshot_records = Vec::new();
        for (index, scanned) in scanned_images.into_iter().enumerate() {
            let image_id =
                assigned_ids[index].take().unwrap_or_else(|| self.generate_opaque_id("img"));
            images_by_id.insert(
                image_id.clone(),
                ImageRecordInternal {
                    id: image_id.clone(),
                    canonical_path: scanned.canonical_path,
                    display_path: scanned.display_path.clone(),
                    file_name: scanned.file_name.clone(),
                    extension: scanned.extension.clone(),
                    size_bytes: scanned.size_bytes,
                    modified_at: scanned.modified_at.clone(),
                    created_at: scanned.created_at.clone(),
                    filesystem_identity: scanned.identity,
                },
            );
            snapshot_records.push(AuthorizedImageRecord {
                id: image_id,
                path: scanned.display_path,
                file_name: scanned.file_name,
                extension: scanned.extension,
                size_bytes: scanned.size_bytes,
                modified_at: scanned.modified_at,
                created_at: scanned.created_at,
            });
        }

        snapshot_records.sort_by(|left, right| left.file_name.cmp(&right.file_name));
        (images_by_id, snapshot_records)
    }

    fn publish_folder_session(
        &self,
        canonical_folder: PathBuf,
        directory_handle: fs::File,
        path_case_semantics: crate::path_normalization::PathCaseSemantics,
        scanned_images: Vec<ScannedSessionImage>,
        window_label: Option<&str>,
    ) -> Result<FolderSessionSnapshot, String> {
        let now_epoch =
            SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);

        let mut store = self.store.lock().unwrap();
        let existing_session_id = store
            .sessions
            .iter()
            .find(|(_, session)| {
                session.canonical_folder == canonical_folder
                    && session.window_label.as_deref() == window_label
            })
            .map(|(id, _)| id.clone());

        if let Some(existing_id) = existing_session_id.as_ref() {
            let existing = store.sessions.get(existing_id).expect("existing session disappeared");
            verify_pinned_directory_parts(&existing.directory_handle, &existing.canonical_folder)?;
        }
        verify_pinned_directory_parts(&directory_handle, &canonical_folder)?;

        let session_id = existing_session_id.unwrap_or_else(|| self.generate_opaque_id("session"));
        let session_instance_id = self.generate_opaque_id("session_instance");
        let catalog_revision = store
            .sessions
            .get(&session_id)
            .map(|session| session.catalog_revision.saturating_add(1))
            .unwrap_or(1);
        let created_at_epoch = store
            .sessions
            .get(&session_id)
            .map(|session| session.created_at_epoch)
            .unwrap_or(now_epoch);
        let (images_by_id, snapshot_records) =
            self.build_authorized_records(&session_id, scanned_images, &store);
        let session_internal = SessionInternal {
            id: session_id.clone(),
            instance_id: session_instance_id.clone(),
            window_label: window_label.map(String::from),
            canonical_folder: canonical_folder.clone(),
            directory_handle,
            path_case_semantics,
            images_by_id,
            catalog_revision,
            created_at_epoch,
            last_used_at_epoch: now_epoch,
        };

        if !store.sessions.contains_key(&session_id) && store.sessions.len() >= 50 {
            if let Some(lru_key) = store
                .sessions
                .iter()
                .min_by_key(|(_, s)| s.last_used_at_epoch)
                .map(|(k, _)| k.clone())
            {
                store.sessions.remove(&lru_key);
            }
        }

        store.sessions.insert(session_id.clone(), session_internal);

        Ok(FolderSessionSnapshot {
            session_id,
            session_instance_id,
            canonical_folder: canonical_folder.to_string_lossy().to_string(),
            path_case_semantics,
            catalog_revision,
            images: snapshot_records,
        })
    }

    pub fn open_folder_session_bootstrap(
        &self,
        folder_path: &Path,
        cached_hints: &[String],
        limit: usize,
        window_label: Option<&str>,
    ) -> Result<FolderSessionSnapshot, String> {
        let canonical_folder = Self::canonicalize_existing_file(folder_path)?;
        if !canonical_folder.is_dir() {
            return Err(format!("'{}' is not a valid directory", folder_path.display()));
        }
        let directory_handle = open_pinned_directory(&canonical_folder)?;
        let path_case_semantics =
            crate::path_normalization::directory_path_case_semantics(&directory_handle)?;

        let mut scanned_images = Vec::new();
        for hint in cached_hints.iter().take(limit) {
            if let Some(scanned) = Self::cached_hint_to_scanned_image(
                Path::new(hint),
                &canonical_folder,
                path_case_semantics,
            ) {
                scanned_images.push(scanned);
            }
        }
        if scanned_images.is_empty() && limit > 0 {
            scanned_images = Self::scan_folder_images_with_controls(
                &canonical_folder,
                path_case_semantics,
                Some(limit),
                Some(bootstrap_directory_entry_budget(limit)),
                || Ok(()),
            )?;
        }

        self.publish_folder_session(
            canonical_folder,
            directory_handle,
            path_case_semantics,
            scanned_images,
            window_label,
        )
    }

    pub fn open_folder_session(
        &self,
        folder_path: &Path,
        window_label: Option<&str>,
    ) -> Result<FolderSessionSnapshot, String> {
        let canonical_folder = Self::canonicalize_existing_file(folder_path)?;
        if !canonical_folder.is_dir() {
            return Err(format!("'{}' is not a valid directory", folder_path.display()));
        }
        let directory_handle = open_pinned_directory(&canonical_folder)?;
        let path_case_semantics =
            crate::path_normalization::directory_path_case_semantics(&directory_handle)?;

        let scanned_images =
            Self::scan_folder_images(&canonical_folder, path_case_semantics, None)?;
        self.publish_folder_session(
            canonical_folder,
            directory_handle,
            path_case_semantics,
            scanned_images,
            window_label,
        )
    }

    pub fn refresh_folder_session(
        &self,
        session_id: &str,
        window_label: Option<&str>,
    ) -> Result<FolderSessionSnapshot, String> {
        self.refresh_folder_session_with_barrier(session_id, window_label, || {})
    }

    fn ensure_session_revision(
        &self,
        session_id: &str,
        session_instance_id: &str,
        catalog_revision: u64,
    ) -> Result<(), String> {
        let store = self.store.lock().unwrap();
        let session = store
            .sessions
            .get(session_id)
            .ok_or_else(|| "Folder session is no longer active".to_string())?;
        if session.instance_id != session_instance_id
            || session.catalog_revision != catalog_revision
        {
            return Err("Folder session refresh was superseded by a newer catalog revision".into());
        }
        Ok(())
    }

    fn refresh_folder_session_with_barrier<F>(
        &self,
        session_id: &str,
        window_label: Option<&str>,
        before_refresh: F,
    ) -> Result<FolderSessionSnapshot, String>
    where
        F: FnOnce(),
    {
        let _refresh_guard = self.refresh_lock.lock().unwrap();
        before_refresh();
        let directory = self.lease_session_directory(session_id, window_label)?;
        let (session_instance_id, start_revision) = {
            let store = self.store.lock().unwrap();
            let session = store
                .sessions
                .get(session_id)
                .ok_or_else(|| "Folder session is no longer active".to_string())?;
            (session.instance_id.clone(), session.catalog_revision)
        };
        directory.revalidate()?;
        let scanned_images = Self::scan_folder_images_with_controls(
            directory.path(),
            directory.path_case_semantics(),
            None,
            None,
            || self.ensure_session_revision(session_id, &session_instance_id, start_revision),
        )?;
        directory.revalidate()?;
        let mut store = self.store.lock().unwrap();
        let (images_by_id, snapshot_records) =
            self.build_authorized_records(session_id, scanned_images, &store);
        let session = store
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| "Folder session disappeared during refresh".to_string())?;
        if session.instance_id != session_instance_id || session.catalog_revision != start_revision
        {
            return Err("Folder session refresh was superseded by a newer catalog revision".into());
        }
        session.images_by_id = images_by_id;
        session.catalog_revision = session.catalog_revision.saturating_add(1);
        session.last_used_at_epoch =
            SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let catalog_revision = session.catalog_revision;
        let canonical_folder = session.canonical_folder.to_string_lossy().to_string();
        let path_case_semantics = session.path_case_semantics;
        Ok(FolderSessionSnapshot {
            session_id: session_id.to_string(),
            session_instance_id,
            canonical_folder,
            path_case_semantics,
            catalog_revision,
            images: snapshot_records,
        })
    }

    pub fn open_file_session(
        &self,
        file_path: &Path,
        window_label: Option<&str>,
    ) -> Result<FileSessionSnapshot, String> {
        let canonical_file = Self::canonicalize_existing_file(file_path)?;
        if !canonical_file.is_file() {
            return Err(format!("'{}' is not a valid file", file_path.display()));
        }

        let parent_folder =
            canonical_file.parent().ok_or_else(|| "File has no parent directory".to_string())?;

        let folder_session = self.open_folder_session(parent_folder, window_label)?;

        let requested_record = folder_session
            .images
            .iter()
            .find(|img| {
                Path::new(&img.path) == canonical_file
                    || Self::canonicalize_existing_file(Path::new(&img.path))
                        .map(|c| c == canonical_file)
                        .unwrap_or(false)
            })
            .ok_or_else(|| {
                format!("Could not find authorized record for '{}'", file_path.display())
            })?;

        Ok(FileSessionSnapshot {
            session_id: folder_session.session_id,
            session_instance_id: folder_session.session_instance_id,
            requested_image_id: requested_record.id.clone(),
            canonical_folder: folder_session.canonical_folder,
            path_case_semantics: folder_session.path_case_semantics,
            catalog_revision: folder_session.catalog_revision,
            images: folder_session.images,
        })
    }

    pub fn open_file_session_bootstrap(
        &self,
        file_path: &Path,
        cached_hints: &[String],
        limit: usize,
        window_label: Option<&str>,
    ) -> Result<FileSessionSnapshot, String> {
        let canonical_file = Self::canonicalize_existing_file(file_path)?;
        if !canonical_file.is_file() {
            return Err(format!("'{}' is not a valid file", file_path.display()));
        }
        let parent_folder =
            canonical_file.parent().ok_or_else(|| "File has no parent directory".to_string())?;
        let requested_path = canonical_file.to_string_lossy().to_string();
        let mut hints = Vec::with_capacity(limit.max(1));
        hints.push(requested_path);
        hints.extend(
            cached_hints
                .iter()
                .filter(|hint| Path::new(hint.as_str()) != canonical_file)
                .take(limit.saturating_sub(1))
                .cloned(),
        );
        let folder_session =
            self.open_folder_session_bootstrap(parent_folder, &hints, limit, window_label)?;
        let requested_record = folder_session
            .images
            .iter()
            .find(|img| Path::new(&img.path) == canonical_file)
            .ok_or_else(|| {
                format!("Could not find authorized record for '{}'", file_path.display())
            })?;

        Ok(FileSessionSnapshot {
            session_id: folder_session.session_id,
            session_instance_id: folder_session.session_instance_id,
            requested_image_id: requested_record.id.clone(),
            canonical_folder: folder_session.canonical_folder,
            path_case_semantics: folder_session.path_case_semantics,
            catalog_revision: folder_session.catalog_revision,
            images: folder_session.images,
        })
    }

    pub fn close_session(
        &self,
        session_id: &str,
        window_label: Option<&str>,
    ) -> Result<(), String> {
        let mut store = self.store.lock().unwrap();
        if let Some(session) = store.sessions.get(session_id) {
            if let (Some(bound), Some(caller)) = (session.window_label.as_deref(), window_label) {
                if bound != caller {
                    return Err(format!(
                        "Window '{}' is not authorized to close session '{}'",
                        caller, session_id
                    ));
                }
            }
        }
        if store.sessions.remove(session_id).is_some() {
            store.projector_read_grants.retain(|(s, _, _)| s != session_id);
            Ok(())
        } else {
            Err(format!("Session '{}' does not exist or is already closed", session_id))
        }
    }

    pub fn close_session_instance(
        &self,
        session_id: &str,
        session_instance_id: &str,
        window_label: Option<&str>,
    ) -> Result<bool, String> {
        let mut store = self.store.lock().unwrap();
        let Some(session) = store.sessions.get(session_id) else {
            return Ok(false);
        };
        if let (Some(bound), Some(caller)) = (session.window_label.as_deref(), window_label) {
            if bound != caller {
                return Err(format!(
                    "Window '{}' is not authorized to close session '{}'",
                    caller, session_id
                ));
            }
        }
        if session.instance_id != session_instance_id {
            return Ok(false);
        }
        store.sessions.remove(session_id);
        store.projector_read_grants.retain(|(s, _, _)| s != session_id);
        Ok(true)
    }

    pub fn resolve_session_folder(
        &self,
        session_id: &str,
        window_label: Option<&str>,
    ) -> Result<PathBuf, String> {
        let store = self.store.lock().unwrap();
        let session = store
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session '{}' is invalid or expired", session_id))?;

        if let (Some(bound), Some(caller)) = (session.window_label.as_deref(), window_label) {
            if bound != caller
                && !store
                    .projector_read_grants
                    .iter()
                    .any(|(s, _, w)| s == session_id && w == caller)
            {
                return Err(format!(
                    "Window '{}' is not authorized for session '{}'",
                    caller, session_id
                ));
            }
        }

        Ok(session.canonical_folder.clone())
    }

    pub fn lease_session_directory(
        &self,
        session_id: &str,
        window_label: Option<&str>,
    ) -> Result<DestinationAuthorityLease, String> {
        let _ = self.resolve_session_folder(session_id, window_label)?;
        let store = self.store.lock().unwrap();
        let session = store
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session '{session_id}' is invalid or expired"))?;
        let lease = DestinationAuthorityLease {
            canonical_folder: session.canonical_folder.clone(),
            path_case_semantics: session.path_case_semantics,
            directory_handle: session
                .directory_handle
                .try_clone()
                .map_err(|error| format!("Failed to clone session directory handle: {error}"))?,
        };
        lease.revalidate()?;
        Ok(lease)
    }

    pub fn get_session_snapshot(
        &self,
        session_id: &str,
        window_label: Option<&str>,
    ) -> Result<FolderSessionSnapshot, String> {
        let store = self.store.lock().unwrap();
        let session = store
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session '{}' is invalid or expired", session_id))?;
        if let (Some(bound), Some(caller)) = (session.window_label.as_deref(), window_label) {
            if bound != caller {
                return Err(format!(
                    "Window '{}' is not authorized for session '{}'",
                    caller, session_id
                ));
            }
        }
        let mut images: Vec<_> = session
            .images_by_id
            .values()
            .map(|record| AuthorizedImageRecord {
                id: record.id.clone(),
                path: record.display_path.clone(),
                file_name: record.file_name.clone(),
                extension: record.extension.clone(),
                size_bytes: record.size_bytes,
                modified_at: record.modified_at.clone(),
                created_at: record.created_at.clone(),
            })
            .collect();
        images.sort_by(|left, right| left.file_name.cmp(&right.file_name));
        Ok(FolderSessionSnapshot {
            session_id: session.id.clone(),
            session_instance_id: session.instance_id.clone(),
            canonical_folder: session.canonical_folder.to_string_lossy().to_string(),
            path_case_semantics: session.path_case_semantics,
            catalog_revision: session.catalog_revision,
            images,
        })
    }

    pub fn authorize_projector_read(&self, session_id: &str, image_id: &str, window_label: &str) {
        let mut store = self.store.lock().unwrap();
        // Revoke previous projector read grants for this window label to enforce single-image scope
        store.projector_read_grants.retain(|(_, _, w)| w != window_label);
        store.projector_read_grants.insert((
            session_id.to_string(),
            image_id.to_string(),
            window_label.to_string(),
        ));
        store.next_projector_grant_epoch = store.next_projector_grant_epoch.saturating_add(1);
        let epoch = store.next_projector_grant_epoch;
        store.projector_grant_epochs.insert(window_label.to_string(), epoch);
    }

    pub fn revoke_projector_grant(&self, window_label: &str) {
        let mut store = self.store.lock().unwrap();
        store.projector_read_grants.retain(|(_, _, w)| w != window_label);
        store.next_projector_grant_epoch = store.next_projector_grant_epoch.saturating_add(1);
        let revoked_epoch = store.next_projector_grant_epoch;
        store.projector_grant_epochs.insert(window_label.to_string(), revoked_epoch);
        store.projector_navigation_generations.remove(window_label);
    }

    pub fn get_projector_grant(&self, window_label: &str) -> Option<(String, String)> {
        let store = self.store.lock().unwrap();
        store
            .projector_read_grants
            .iter()
            .find(|(_, _, w)| w == window_label)
            .map(|(s, i, _)| (s.clone(), i.clone()))
    }

    pub fn is_projector_read_authorized(
        &self,
        session_id: &str,
        image_id: &str,
        window_label: &str,
    ) -> bool {
        let store = self.store.lock().unwrap();
        store.projector_read_grants.contains(&(
            session_id.to_string(),
            image_id.to_string(),
            window_label.to_string(),
        ))
    }

    pub fn get_projector_display_record(
        &self,
        window_label: &str,
    ) -> Result<ProjectorDisplayRecord, String> {
        let store = self.store.lock().unwrap();
        Self::projector_display_record_locked(&store, window_label)
    }

    fn projector_display_record_locked(
        store: &SessionStore,
        window_label: &str,
    ) -> Result<ProjectorDisplayRecord, String> {
        let (session_id, current_image_id, _) = store
            .projector_read_grants
            .iter()
            .find(|(_, _, label)| label == window_label)
            .cloned()
            .ok_or_else(|| format!("No active projector grant for window '{}'", window_label))?;
        let session = store
            .sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session '{}' is not active", session_id))?;

        let mut images = Vec::new();
        let mut current_image = None;

        for (id, rec) in &session.images_by_id {
            let auth_rec = AuthorizedImageRecord {
                id: id.clone(),
                path: rec.display_path.clone(),
                file_name: rec.file_name.clone(),
                extension: rec.extension.clone(),
                size_bytes: rec.size_bytes,
                modified_at: rec.modified_at.clone(),
                created_at: rec.created_at.clone(),
            };
            if id == &current_image_id {
                current_image = Some(auth_rec.clone());
            }
            images.push(auth_rec);
        }

        images.sort_by(|a, b| a.file_name.cmp(&b.file_name));

        let image = current_image
            .ok_or_else(|| format!("Granted image '{}' not found in session", current_image_id))?;

        let grant_epoch = store.projector_grant_epochs.get(window_label).copied().unwrap_or(0);
        let navigation_generation =
            store.projector_navigation_generations.get(window_label).copied().unwrap_or(0);
        Ok(ProjectorDisplayRecord { session_id, image, images, grant_epoch, navigation_generation })
    }

    pub fn navigate_projector_image(
        &self,
        window_label: &str,
        target_image_id: &str,
        grant_epoch: u64,
        navigation_generation: u64,
    ) -> Result<ProjectorDisplayRecord, String> {
        self.navigate_projector_image_with_barrier(
            window_label,
            target_image_id,
            grant_epoch,
            navigation_generation,
            || {},
        )
    }

    fn navigate_projector_image_with_barrier<F>(
        &self,
        window_label: &str,
        target_image_id: &str,
        grant_epoch: u64,
        navigation_generation: u64,
        before_transaction: F,
    ) -> Result<ProjectorDisplayRecord, String>
    where
        F: FnOnce(),
    {
        before_transaction();

        let mut store = self.store.lock().unwrap();
        let (session_id, _, _) = store
            .projector_read_grants
            .iter()
            .find(|(_, _, label)| label == window_label)
            .cloned()
            .ok_or_else(|| format!("No active projector grant for window '{}'", window_label))?;
        let current_generation =
            store.projector_navigation_generations.get(window_label).copied().unwrap_or(0);
        let current_epoch = store.projector_grant_epochs.get(window_label).copied().unwrap_or(0);
        if grant_epoch != current_epoch {
            return Err("Projector navigation grant epoch is stale".to_string());
        }
        if navigation_generation <= current_generation {
            return Err("Projector navigation request was superseded".to_string());
        }
        let session = store
            .sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session '{}' is not active", session_id))?;

        if !session.images_by_id.contains_key(target_image_id) {
            return Err(format!(
                "Image '{}' is not authorized under active session '{}'",
                target_image_id, session_id
            ));
        }
        store.projector_read_grants.retain(|(_, _, w)| w != window_label);
        store.projector_read_grants.insert((
            session_id.clone(),
            target_image_id.to_string(),
            window_label.to_string(),
        ));
        store
            .projector_navigation_generations
            .insert(window_label.to_string(), navigation_generation);
        Self::projector_display_record_locked(&store, window_label)
    }

    pub fn resolve_image_path(
        &self,
        session_id: &str,
        image_id: &str,
        window_label: Option<&str>,
    ) -> Result<PathBuf, String> {
        let (canonical_path, canonical_folder, expected_identity, directory) = {
            let mut store = self.store.lock().unwrap();
            let is_proj_auth = window_label.is_some_and(|w| {
                store.projector_read_grants.contains(&(
                    session_id.to_string(),
                    image_id.to_string(),
                    w.to_string(),
                ))
            });
            let session = store
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| format!("Session '{}' is invalid or expired", session_id))?;

            if let (Some(bound), Some(caller)) = (session.window_label.as_deref(), window_label) {
                if bound != caller && !is_proj_auth {
                    return Err(format!(
                        "Window '{}' is not authorized for session '{}'",
                        caller, session_id
                    ));
                }
            }
            session.last_used_at_epoch =
                SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let record = session
                .images_by_id
                .get(image_id)
                .ok_or_else(|| format!("ImageId '{}' is not authorized in session", image_id))?;
            (
                record.canonical_path.clone(),
                session.canonical_folder.clone(),
                record.filesystem_identity.clone().ok_or_else(|| {
                    format!("ImageId '{}' has no stable filesystem identity", image_id)
                })?,
                session.directory_handle.try_clone().map_err(|error| {
                    format!("Failed to clone authorized directory handle: {error}")
                })?,
            )
        };

        verify_pinned_directory_parts(&directory, &canonical_folder)?;
        if canonical_path.parent() != Some(canonical_folder.as_path()) {
            return Err(format!("ImageId '{}' is outside its authorized directory", image_id));
        }
        #[cfg(target_os = "linux")]
        let current = {
            use std::ffi::CString;
            use std::os::fd::AsRawFd;
            use std::os::unix::ffi::OsStrExt;
            let name = canonical_path
                .file_name()
                .ok_or_else(|| "Authorized image has no file name".to_string())?;
            let name = CString::new(name.as_bytes())
                .map_err(|_| "Authorized image name contains NUL".to_string())?;
            linux_open_named_nofollow(directory.as_raw_fd(), &name)
                .map_err(|error| format!("Failed to reopen authorized image: {error}"))?
        };
        #[cfg(not(target_os = "linux"))]
        let current = open_readonly_nofollow_file(&canonical_path, "authorized image")?;
        let actual_identity = filesystem_identity_for_handle(&current)?;
        if actual_identity != expected_identity {
            return Err(format!(
                "ImageId '{}' no longer refers to its authorized filesystem object",
                image_id
            ));
        }
        if !current
            .metadata()
            .map_err(|error| format!("Failed to inspect authorized image: {error}"))?
            .is_file()
        {
            return Err(format!("ImageId '{}' no longer refers to a file", image_id));
        }
        Ok(canonical_path)
    }

    pub fn lease_image(
        &self,
        session_id: &str,
        image_id: &str,
        window_label: Option<&str>,
    ) -> Result<ImageAuthorityLease, String> {
        let canonical_path = self.resolve_image_path(session_id, image_id, window_label)?;
        let canonical_folder = {
            let store = self.store.lock().unwrap();
            store
                .sessions
                .get(session_id)
                .ok_or_else(|| format!("Session '{}' expired while acquiring lease", session_id))?
                .canonical_folder
                .clone()
        };
        let file_handle = open_replaceable_image_file(&canonical_path)?;
        let (directory_handle, expected_identity, path_case_semantics) = {
            let store = self.store.lock().unwrap();
            let session = store
                .sessions
                .get(session_id)
                .ok_or_else(|| format!("Session '{session_id}' is not active"))?;
            let record = session
                .images_by_id
                .get(image_id)
                .ok_or_else(|| format!("ImageId '{image_id}' is no longer authorized"))?;
            (
                session.directory_handle.try_clone().map_err(|error| {
                    format!("Failed to clone session directory authority: {error}")
                })?,
                record.filesystem_identity.clone().ok_or_else(|| {
                    format!("ImageId '{image_id}' has no stable filesystem identity")
                })?,
                session.path_case_semantics,
            )
        };
        if filesystem_identity_for_handle(&file_handle)? != expected_identity {
            return Err(format!(
                "ImageId '{image_id}' changed while acquiring its authority handle"
            ));
        }
        let lease = ImageAuthorityLease {
            canonical_path,
            canonical_folder,
            file_handle,
            directory_handle,
            path_case_semantics,
        };
        lease.revalidate()?;
        Ok(lease)
    }

    pub fn grant_destination(
        &self,
        folder_path: &Path,
        window_label: Option<&str>,
    ) -> Result<String, String> {
        let canonical = Self::canonicalize_path(folder_path)?;
        if !canonical.is_dir() {
            return Err(format!("'{}' is not a valid directory", folder_path.display()));
        }
        let grant_id = self.generate_opaque_id("dest");
        let directory_handle = open_pinned_directory(&canonical)?;
        let path_case_semantics =
            crate::path_normalization::directory_path_case_semantics(&directory_handle)?;
        let now_epoch =
            SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let grant = DestinationGrantInternal {
            id: grant_id.clone(),
            window_label: window_label.map(String::from),
            canonical_folder: canonical,
            directory_handle,
            path_case_semantics,
            scope: DestinationGrantScope::Folder,
            created_at_epoch: now_epoch,
            last_used_at_epoch: now_epoch,
        };
        let mut store = self.store.lock().unwrap();
        evict_oldest_destination_grant(&mut store);
        store.destination_grants.insert(grant_id.clone(), grant);
        Ok(grant_id)
    }

    pub fn grant_exact_destination(
        &self,
        target_path: &Path,
        operation: &str,
        window_label: Option<&str>,
    ) -> Result<(String, String), String> {
        let canonical_target = Self::canonicalize_output_target(target_path)?;
        let canonical_folder = canonical_target
            .parent()
            .ok_or_else(|| "Selected destination has no parent".to_string())?
            .to_path_buf();
        let relative_file_name = canonical_target
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Selected destination has an invalid file name".to_string())?
            .to_string();
        if operation.trim().is_empty() {
            return Err("Exact destination operation must not be empty".to_string());
        }
        let grant_id = self.generate_opaque_id("save");
        let directory_handle = open_pinned_directory(&canonical_folder)?;
        let path_case_semantics =
            crate::path_normalization::directory_path_case_semantics(&directory_handle)?;
        let now_epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        let grant = DestinationGrantInternal {
            id: grant_id.clone(),
            window_label: window_label.map(String::from),
            canonical_folder,
            directory_handle,
            path_case_semantics,
            scope: DestinationGrantScope::ExactFile {
                relative_file_name: relative_file_name.clone(),
                operation: operation.to_string(),
                expires_at_epoch: now_epoch.saturating_add(10 * 60),
            },
            created_at_epoch: now_epoch,
            last_used_at_epoch: now_epoch,
        };
        let mut store = self.store.lock().unwrap();
        evict_oldest_destination_grant(&mut store);
        store.destination_grants.insert(grant_id.clone(), grant);
        Ok((grant_id, relative_file_name))
    }

    pub fn consume_exact_destination_grant(
        &self,
        grant_id: &str,
        relative_file_name: &str,
        operation: &str,
        window_label: Option<&str>,
    ) -> Result<DestinationAuthorityLease, ExactDestinationGrantError> {
        let mut store = self.store.lock().unwrap();
        let prepared = (|| {
            let grant = store.destination_grants.get(grant_id).ok_or_else(|| {
                ExactDestinationGrantError::consumed(format!(
                    "Destination grant '{}' is invalid or already consumed",
                    grant_id
                ))
            })?;
            if let (Some(bound), Some(caller)) = (grant.window_label.as_deref(), window_label) {
                if bound != caller {
                    return Err(ExactDestinationGrantError::retained(format!(
                        "Window '{}' is not authorized for destination grant '{}'",
                        caller, grant_id
                    )));
                }
            }
            let now_epoch = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .unwrap_or(0);
            match &grant.scope {
                DestinationGrantScope::Folder => {
                    return Err(ExactDestinationGrantError::retained(
                        "Folder-scoped destination grant cannot authorize an exact save",
                    ));
                }
                DestinationGrantScope::ExactFile {
                    relative_file_name: selected_name,
                    operation: selected_operation,
                    expires_at_epoch,
                } => {
                    if now_epoch > *expires_at_epoch {
                        return Err(ExactDestinationGrantError::consumed(
                            "Exact destination grant expired",
                        ));
                    }
                    if selected_name != relative_file_name {
                        return Err(ExactDestinationGrantError::retained(
                            "Exact destination grant does not authorize this file name",
                        ));
                    }
                    if selected_operation != operation {
                        return Err(ExactDestinationGrantError::retained(
                            "Exact destination grant does not authorize this operation",
                        ));
                    }
                }
            }
            verify_pinned_directory(grant).map_err(ExactDestinationGrantError::consumed)?;
            let lease = DestinationAuthorityLease {
                canonical_folder: grant.canonical_folder.clone(),
                path_case_semantics: grant.path_case_semantics,
                directory_handle: grant.directory_handle.try_clone().map_err(|error| {
                    ExactDestinationGrantError::consumed(format!(
                        "Failed to clone exact destination authority: {error}"
                    ))
                })?,
            };
            lease.revalidate().map_err(ExactDestinationGrantError::consumed)?;
            Ok(lease)
        })();

        match prepared {
            Ok(lease) => {
                // Fully validate first, then consume in one infallible operation. This makes the
                // consumed bit exact even if the destination authority has gone stale.
                store.destination_grants.remove(grant_id);
                Ok(lease)
            }
            Err(error) => {
                if error.consumed {
                    store.destination_grants.remove(grant_id);
                }
                Err(error)
            }
        }
    }

    pub fn resolve_destination_grant(
        &self,
        grant_id: &str,
        window_label: Option<&str>,
    ) -> Result<PathBuf, String> {
        let mut store = self.store.lock().unwrap();
        let grant = store
            .destination_grants
            .get_mut(grant_id)
            .ok_or_else(|| format!("Destination grant '{}' is invalid", grant_id))?;

        if !matches!(grant.scope, DestinationGrantScope::Folder) {
            return Err("Exact save grant cannot be used as a folder grant".to_string());
        }

        if let (Some(bound), Some(caller)) = (grant.window_label.as_deref(), window_label) {
            if bound != caller {
                return Err(format!(
                    "Window '{}' is not authorized for destination grant '{}'",
                    caller, grant_id
                ));
            }
        }

        grant.last_used_at_epoch =
            SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);

        verify_pinned_directory(grant)?;

        Ok(grant.canonical_folder.clone())
    }

    pub fn destination_grant_case_semantics(
        &self,
        grant_id: &str,
        window_label: Option<&str>,
    ) -> Result<crate::path_normalization::PathCaseSemantics, String> {
        let store = self.store.lock().unwrap();
        let grant = store
            .destination_grants
            .get(grant_id)
            .ok_or_else(|| format!("Destination grant '{}' is invalid", grant_id))?;
        if let (Some(bound), Some(caller)) = (grant.window_label.as_deref(), window_label) {
            if bound != caller {
                return Err(format!(
                    "Window '{}' is not authorized for destination grant '{}'",
                    caller, grant_id
                ));
            }
        }
        Ok(grant.path_case_semantics)
    }

    pub fn lease_destination_grant(
        &self,
        grant_id: &str,
        window_label: Option<&str>,
    ) -> Result<DestinationAuthorityLease, String> {
        let mut store = self.store.lock().unwrap();
        let grant = store
            .destination_grants
            .get_mut(grant_id)
            .ok_or_else(|| format!("Destination grant '{}' is invalid", grant_id))?;
        if !matches!(grant.scope, DestinationGrantScope::Folder) {
            return Err("Exact save grant cannot be used as a folder grant".to_string());
        }
        if let (Some(bound), Some(caller)) = (grant.window_label.as_deref(), window_label) {
            if bound != caller {
                return Err(format!(
                    "Window '{}' is not authorized for destination grant '{}'",
                    caller, grant_id
                ));
            }
        }
        verify_pinned_directory(grant)?;
        grant.last_used_at_epoch =
            SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let lease = DestinationAuthorityLease {
            canonical_folder: grant.canonical_folder.clone(),
            path_case_semantics: grant.path_case_semantics,
            directory_handle: grant
                .directory_handle
                .try_clone()
                .map_err(|error| format!("Failed to clone destination authority: {error}"))?,
        };
        lease.revalidate()?;
        Ok(lease)
    }

    pub fn grant_external_editor(
        &self,
        app_path: &Path,
        window_label: Option<&str>,
    ) -> Result<String, String> {
        let canonical = Self::canonicalize_path(app_path)?;
        if !canonical.is_file() {
            return Err(format!("'{}' is not a valid executable file", app_path.display()));
        }
        let grant_id = self.generate_opaque_id("editor");
        let now_epoch =
            SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let executable_handle = open_pinned_file(&canonical, "external editor")?;
        let parent = canonical
            .parent()
            .ok_or_else(|| "External editor executable has no parent directory".to_string())?;
        let directory_handle = open_pinned_directory(parent)?;
        let path_case_semantics =
            crate::path_normalization::directory_path_case_semantics(&directory_handle)?;
        let grant = ExternalEditorGrantInternal {
            id: grant_id.clone(),
            window_label: window_label.map(String::from),
            canonical_app_path: canonical,
            executable_handle,
            path_case_semantics,
            created_at_epoch: now_epoch,
            last_used_at_epoch: now_epoch,
        };
        let mut store = self.store.lock().unwrap();
        if store.external_editor_grants.len() >= MAX_BOUNDED_GRANTS {
            if let Some(oldest_key) = store
                .external_editor_grants
                .iter()
                .min_by_key(|(_, g)| g.last_used_at_epoch)
                .map(|(k, _)| k.clone())
            {
                store.external_editor_grants.remove(&oldest_key);
            }
        }
        store.external_editor_grants.insert(grant_id.clone(), grant);
        Ok(grant_id)
    }

    pub fn external_editor_grant_case_semantics(
        &self,
        grant_id: &str,
        window_label: Option<&str>,
    ) -> Result<crate::path_normalization::PathCaseSemantics, String> {
        let store = self.store.lock().unwrap();
        let grant = store
            .external_editor_grants
            .get(grant_id)
            .ok_or_else(|| format!("External editor grant '{grant_id}' is invalid"))?;
        if let (Some(bound), Some(caller)) = (grant.window_label.as_deref(), window_label) {
            if bound != caller {
                return Err(format!(
                    "Window '{caller}' is not authorized for external editor grant '{grant_id}'"
                ));
            }
        }
        Ok(grant.path_case_semantics)
    }

    pub fn resolve_external_editor_grant(
        &self,
        grant_id: &str,
        window_label: Option<&str>,
    ) -> Result<PathBuf, String> {
        let mut store = self.store.lock().unwrap();
        let grant = store
            .external_editor_grants
            .get_mut(grant_id)
            .ok_or_else(|| format!("External editor grant '{}' is invalid", grant_id))?;

        if let (Some(bound), Some(caller)) = (grant.window_label.as_deref(), window_label) {
            if bound != caller {
                return Err(format!(
                    "Window '{}' is not authorized for external editor grant '{}'",
                    caller, grant_id
                ));
            }
        }

        grant.last_used_at_epoch =
            SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);

        Ok(grant.canonical_app_path.clone())
    }

    pub fn lease_external_editor_grant(
        &self,
        grant_id: &str,
        window_label: Option<&str>,
    ) -> Result<ExternalEditorAuthorityLease, String> {
        let mut store = self.store.lock().unwrap();
        let grant = store
            .external_editor_grants
            .get_mut(grant_id)
            .ok_or_else(|| format!("External editor grant '{}' is invalid", grant_id))?;
        if let (Some(bound), Some(caller)) = (grant.window_label.as_deref(), window_label) {
            if bound != caller {
                return Err(format!(
                    "Window '{}' is not authorized for external editor grant '{}'",
                    caller, grant_id
                ));
            }
        }
        grant.last_used_at_epoch =
            SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let lease = ExternalEditorAuthorityLease {
            canonical_path: grant.canonical_app_path.clone(),
            executable_handle: grant
                .executable_handle
                .try_clone()
                .map_err(|error| format!("Failed to clone external editor authority: {error}"))?,
        };
        lease.revalidate()?;
        Ok(lease)
    }

    pub fn lease_xmp_sidecar(
        &self,
        session_id: &str,
        image_id: &str,
        window_label: Option<&str>,
    ) -> Result<Option<SidecarAuthorityLease>, String> {
        let image_lease = self.lease_image(session_id, image_id, window_label)?;
        let image_name = image_lease
            .path()
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Authorized image file name is invalid".to_string())?
            .to_string();
        let stem = image_lease
            .path()
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Authorized image stem is invalid".to_string())?
            .to_string();
        let (directory, folder) = {
            let store = self.store.lock().unwrap();
            let session = store
                .sessions
                .get(session_id)
                .ok_or_else(|| format!("Session '{session_id}' is no longer active"))?;
            (
                session.directory_handle.try_clone().map_err(|error| {
                    format!("Failed to clone session directory authority: {error}")
                })?,
                session.canonical_folder.clone(),
            )
        };
        verify_pinned_directory_parts(&directory, &folder)?;
        let candidates = [
            format!("{stem}.xmp"),
            format!("{stem}.XMP"),
            format!("{image_name}.xmp"),
            format!("{image_name}.XMP"),
        ];

        for file_name in candidates {
            #[cfg(unix)]
            let opened = {
                use std::ffi::CString;
                use std::os::fd::{AsRawFd, FromRawFd};
                let name = CString::new(file_name.as_bytes())
                    .map_err(|_| "Sidecar file name contains a NUL byte".to_string())?;
                let fd = unsafe {
                    libc::openat(
                        directory.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    let error = std::io::Error::last_os_error();
                    if error.kind() == std::io::ErrorKind::NotFound {
                        None
                    } else {
                        return Err(format!("Failed to open authorized XMP sidecar: {error}"));
                    }
                } else {
                    Some(unsafe { fs::File::from_raw_fd(fd) })
                }
            };
            #[cfg(not(unix))]
            let opened = {
                let candidate = folder.join(&file_name);
                match fs::symlink_metadata(&candidate) {
                    Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                        return Err(
                            "XMP sidecar links and non-files are not authorized".to_string()
                        );
                    }
                    Ok(_) => Some(open_pinned_file(&candidate, "XMP sidecar")?),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => return Err(format!("Failed to inspect XMP sidecar: {error}")),
                }
            };
            if let Some(file_handle) = opened {
                if !file_handle
                    .metadata()
                    .map_err(|error| format!("Failed to inspect XMP sidecar handle: {error}"))?
                    .is_file()
                {
                    return Err("XMP sidecar handle is not a regular file".to_string());
                }
                return Ok(Some(SidecarAuthorityLease { file_name, file_handle }));
            }
        }
        Ok(None)
    }

    pub fn lease_caption_sidecars(
        &self,
        session_id: &str,
        image_id: &str,
        window_label: Option<&str>,
    ) -> Result<Vec<SidecarAuthorityLease>, String> {
        let image_lease = self.lease_image(session_id, image_id, window_label)?;
        let stem = image_lease
            .path()
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Authorized image stem is invalid".to_string())?;
        let candidates =
            ["txt", "caption", "TXT", "CAPTION"].map(|extension| format!("{stem}.{extension}"));
        let (directory, folder) = {
            let store = self.store.lock().unwrap();
            let session = store
                .sessions
                .get(session_id)
                .ok_or_else(|| format!("Session '{session_id}' is no longer active"))?;
            (
                session.directory_handle.try_clone().map_err(|error| {
                    format!("Failed to clone session directory authority: {error}")
                })?,
                session.canonical_folder.clone(),
            )
        };
        verify_pinned_directory_parts(&directory, &folder)?;
        let mut leases = Vec::new();
        for file_name in candidates {
            #[cfg(unix)]
            let opened = {
                use std::ffi::CString;
                use std::os::fd::{AsRawFd, FromRawFd};
                let name = CString::new(file_name.as_bytes())
                    .map_err(|_| "Caption sidecar name contains a NUL byte".to_string())?;
                let fd = unsafe {
                    libc::openat(
                        directory.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    let error = std::io::Error::last_os_error();
                    if error.kind() == std::io::ErrorKind::NotFound {
                        None
                    } else {
                        return Err(format!("Failed to open authorized caption sidecar: {error}"));
                    }
                } else {
                    Some(unsafe { fs::File::from_raw_fd(fd) })
                }
            };
            #[cfg(not(unix))]
            let opened = {
                let candidate = folder.join(&file_name);
                match fs::symlink_metadata(&candidate) {
                    Ok(_) => Some(open_pinned_file(&candidate, "caption sidecar")?),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => {
                        return Err(format!("Failed to inspect caption sidecar: {error}"))
                    }
                }
            };
            if let Some(file_handle) = opened {
                if !file_handle
                    .metadata()
                    .map_err(|error| format!("Failed to inspect caption sidecar: {error}"))?
                    .is_file()
                {
                    return Err("Caption sidecar links and non-files are not authorized".into());
                }
                leases.push(SidecarAuthorityLease { file_name, file_handle });
            }
        }
        Ok(leases)
    }
}

fn open_pinned_file(path: &Path, description: &str) -> Result<fs::File, String> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            // DELETE permits identity-bound rename/delete through the handle itself.
            .access_mode(0x8000_0000 | 0x0001_0000)
            // Permit application writes but deny rename/delete replacement while leased.
            .share_mode(0x0000_0001 | 0x0000_0002)
            // Open the reparse point itself so a symlink/junction is rejected by metadata checks.
            .custom_flags(0x0020_0000)
            .open(path)
            .map_err(|error| format!("Failed to pin {description} identity: {error}"))
    }
    #[cfg(not(windows))]
    {
        fs::File::open(path)
            .map_err(|error| format!("Failed to pin {description} identity: {error}"))
    }
}

fn open_replaceable_image_file(path: &Path) -> Result<fs::File, String> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .access_mode(0x8000_0000 | 0x0001_0000)
            // Reads remain pinned to this exact handle, while FILE_SHARE_DELETE permits the
            // handle-based atomic replacement protocol to quarantine and republish its name.
            .share_mode(0x0000_0001 | 0x0000_0002 | 0x0000_0004)
            .custom_flags(0x0020_0000)
            .open(path)
            .map_err(|error| format!("Failed to pin replaceable image identity: {error}"))
    }
    #[cfg(not(windows))]
    {
        open_pinned_file(path, "replaceable image")
    }
}

fn open_readonly_nofollow_file(path: &Path, description: &str) -> Result<fs::File, String> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .access_mode(0x8000_0000)
            // The pinned authority handle itself may carry DELETE access for identity-bound
            // handoffs, so the verification reopen must share delete to coexist with it.
            .share_mode(0x0000_0001 | 0x0000_0002 | 0x0000_0004)
            .custom_flags(0x0020_0000)
            .open(path)
            .map_err(|error| format!("Failed to open {description}: {error}"))
    }
    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::fd::FromRawFd;
        use std::os::unix::ffi::OsStrExt;
        let path = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| format!("{description} path contains NUL"))?;
        let fd = unsafe {
            libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        };
        if fd < 0 {
            return Err(format!(
                "Failed to open {description}: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(unsafe { fs::File::from_raw_fd(fd) })
    }
}

fn verify_pinned_file(handle: &fs::File, path: &Path, description: &str) -> Result<(), String> {
    let path_metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("{description} path is no longer valid: {error}"))?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
        return Err(format!("{description} was replaced by a link or non-file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let handle_metadata = handle
            .metadata()
            .map_err(|error| format!("{description} handle is no longer valid: {error}"))?;
        if handle_metadata.dev() != path_metadata.dev()
            || handle_metadata.ino() != path_metadata.ino()
        {
            return Err(format!("{description} identity changed"));
        }
    }
    #[cfg(windows)]
    {
        let path_handle = open_readonly_nofollow_file(path, description)?;
        if windows_file_identity(handle)? != windows_file_identity(&path_handle)? {
            return Err(format!("{description} identity changed"));
        }
    }
    Ok(())
}

fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn is_direct_child_with_semantics(
    path: &Path,
    folder: &Path,
    semantics: crate::path_normalization::PathCaseSemantics,
) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    is_path_contained_in_with_semantics(path, folder, semantics)
        && crate::path_normalization::normalize_path_for_key_with_semantics(parent, semantics)
            == crate::path_normalization::normalize_path_for_key_with_semantics(folder, semantics)
}

fn open_pinned_directory(path: &Path) -> Result<fs::File, String> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ | FILE_SHARE_WRITE, intentionally excluding FILE_SHARE_DELETE.
        // FILE_FLAG_BACKUP_SEMANTICS permits opening a directory and OPEN_REPARSE_POINT avoids
        // granting authority through a reparse point introduced between canonicalization/open.
        fs::OpenOptions::new()
            .read(true)
            .share_mode(0x0000_0001 | 0x0000_0002)
            .custom_flags(0x0200_0000 | 0x0020_0000)
            .open(path)
            .map_err(|error| format!("Failed to pin destination directory identity: {error}"))
    }
    #[cfg(not(windows))]
    {
        fs::File::open(path)
            .map_err(|error| format!("Failed to pin destination directory identity: {error}"))
    }
}

fn verify_pinned_directory(grant: &DestinationGrantInternal) -> Result<(), String> {
    verify_pinned_directory_parts(&grant.directory_handle, &grant.canonical_folder)
}

fn verify_pinned_directory_parts(handle: &fs::File, path: &Path) -> Result<(), String> {
    let handle_metadata = handle
        .metadata()
        .map_err(|error| format!("Granted destination handle is no longer valid: {error}"))?;
    let path_metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Granted destination path is no longer valid: {error}"))?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_dir() {
        return Err("Granted destination directory was replaced by a link or non-directory".into());
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if handle_metadata.dev() != path_metadata.dev()
            || handle_metadata.ino() != path_metadata.ino()
        {
            return Err("Granted destination directory identity changed".into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // The pinned handle prevents a rename/replacement while alive. These stable attributes
        // additionally fail closed if an unusual filesystem does not honor share-delete denial.
        if handle_metadata.creation_time() != path_metadata.creation_time()
            || handle_metadata.file_attributes() != path_metadata.file_attributes()
        {
            return Err("Granted destination directory identity changed".into());
        }
    }
    Ok(())
}

pub fn normalize_path_buf(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    let cleaned = s.strip_prefix(r"\\?\").unwrap_or(&s);
    PathBuf::from(cleaned)
}

pub fn is_path_contained_in(child: &Path, parent: &Path) -> bool {
    is_path_contained_in_with_semantics(
        child,
        parent,
        crate::path_normalization::runtime_path_case_semantics(),
    )
}

pub fn is_path_contained_in_with_semantics(
    child: &Path,
    parent: &Path,
    semantics: crate::path_normalization::PathCaseSemantics,
) -> bool {
    let norm_child = normalize_path_buf(child);
    let norm_parent = normalize_path_buf(parent);
    let child_components: Vec<_> = norm_child.components().collect();
    let parent_components: Vec<_> = norm_parent.components().collect();
    if child_components.len() < parent_components.len() {
        return false;
    }
    child_components.iter().zip(parent_components.iter()).all(|(child, parent)| {
        let child = child.as_os_str().to_string_lossy();
        let parent = parent.as_os_str().to_string_lossy();
        match semantics {
            crate::path_normalization::PathCaseSemantics::Sensitive => child == parent,
            crate::path_normalization::PathCaseSemantics::Insensitive => {
                child.eq_ignore_ascii_case(&parent)
            }
        }
    })
}

fn is_supported_image_file(path: &Path) -> bool {
    const SUPPORTED_EXTENSIONS: &[&str] = &[
        "jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "tif", "heic", "heif", "avif", "svg",
        "dng", "cr2", "cr3", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "pef", "srw",
    ];

    path.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .map(|ext| SUPPORTED_EXTENSIONS.contains(&ext.as_str()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_recovery_retries_failed_rollback_on_drop_and_runs_on_unwind() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let attempts = Arc::new(AtomicUsize::new(0));
        {
            let attempts_for_recovery = Arc::clone(&attempts);
            let mut recovery = SourceReplacementRecovery::new(move |_| {
                if attempts_for_recovery.fetch_add(1, Ordering::SeqCst) == 0 {
                    Err("injected rollback failure".into())
                } else {
                    Ok(())
                }
            });
            assert!(recovery.mutate::<()>("injected mutation", || Err("failure".into())).is_err());
            assert_eq!(attempts.load(Ordering::SeqCst), 1);
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 2);

        let unwind_attempts = Arc::new(AtomicUsize::new(0));
        let captured = Arc::clone(&unwind_attempts);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let mut recovery = SourceReplacementRecovery::new(move |_| {
                captured.fetch_add(1, Ordering::SeqCst);
                Ok(())
            });
            recovery.mutate("armed mutation", || Ok(())).unwrap();
            panic!("injected unwind");
        }));
        assert!(result.is_err());
        assert_eq!(unwind_attempts.load(Ordering::SeqCst), 1);
    }

    #[cfg(windows)]
    fn clone_creation_time(source: &Path, destination: &Path) {
        use std::os::windows::fs::FileTimesExt;
        let created = fs::metadata(source).unwrap().created().unwrap();
        let destination = fs::OpenOptions::new().write(true).open(destination).unwrap();
        destination.set_times(std::fs::FileTimes::new().set_created(created)).unwrap();
    }

    #[test]
    fn test_session_manager_opens_and_resolves_image_id() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        fs::write(&image, b"dummy-image").unwrap();

        let manager = SessionManager::new();
        let snapshot = manager.open_folder_session(dir.path(), None).unwrap();
        assert_eq!(snapshot.images.len(), 1);

        let img_record = &snapshot.images[0];
        let resolved_path =
            manager.resolve_image_path(&snapshot.session_id, &img_record.id, None).unwrap();

        assert_eq!(SessionManager::canonicalize_path(&image).unwrap(), resolved_path);
    }

    #[test]
    fn repeated_same_folder_open_preserves_session_and_image_ids() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("photo.jpg"), b"dummy-image").unwrap();
        let manager = SessionManager::new();

        let first = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let second = manager.open_folder_session(dir.path(), Some("main")).unwrap();

        assert_eq!(first.session_id, second.session_id);
        assert_eq!(first.images[0].id, second.images[0].id);
        assert_eq!(manager.store.lock().unwrap().sessions.len(), 1);
    }

    #[test]
    fn bootstrap_session_revalidates_cached_hints_and_keeps_result_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("images");
        let outside = dir.path().join("outside.jpg");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("a.jpg"), b"a").unwrap();
        fs::write(folder.join("b.jpg"), b"b").unwrap();
        fs::write(folder.join("c.jpg"), b"c").unwrap();
        fs::write(&outside, b"outside").unwrap();

        let hints = vec![
            outside.to_string_lossy().to_string(),
            folder.join("a.jpg").to_string_lossy().to_string(),
            folder.join("b.jpg").to_string_lossy().to_string(),
            folder.join("c.jpg").to_string_lossy().to_string(),
        ];
        let manager = SessionManager::new();
        let snapshot =
            manager.open_folder_session_bootstrap(&folder, &hints, 2, Some("main")).unwrap();

        assert_eq!(snapshot.images.len(), 1);
        assert!(snapshot.images[0].path.ends_with("a.jpg"));
        let lease = manager
            .lease_image(&snapshot.session_id, &snapshot.images[0].id, Some("main"))
            .unwrap();
        assert_eq!(fs::read(lease.path()).unwrap(), b"a");
    }

    #[test]
    fn bootstrap_session_uses_bounded_directory_fallback_for_empty_cache() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["a.jpg", "b.jpg", "c.jpg"] {
            fs::write(dir.path().join(name), name.as_bytes()).unwrap();
        }

        let manager = SessionManager::new();
        let snapshot =
            manager.open_folder_session_bootstrap(dir.path(), &[], 2, Some("main")).unwrap();

        assert_eq!(snapshot.images.len(), 2);
        assert_eq!(
            manager.store.lock().unwrap().sessions[&snapshot.session_id].images_by_id.len(),
            2
        );
    }

    #[test]
    fn bootstrap_directory_fallback_stops_after_entry_budget() {
        reset_test_scan_entry_count();
        let dir = tempfile::tempdir().unwrap();
        for index in 0..100 {
            fs::write(dir.path().join(format!("unsupported-{index}.txt")), b"not-image").unwrap();
        }

        let manager = SessionManager::new();
        let snapshot =
            manager.open_folder_session_bootstrap(dir.path(), &[], 2, Some("main")).unwrap();

        assert!(snapshot.images.is_empty());
        assert!(test_scan_entry_count() <= bootstrap_directory_entry_budget(2));
    }

    #[test]
    fn refresh_rejects_session_closed_during_reconciliation() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("photo.jpg"), b"dummy-image").unwrap();
        let manager = SessionManager::new();
        let snapshot =
            manager.open_folder_session_bootstrap(dir.path(), &[], 1, Some("main")).unwrap();
        let instance_id = snapshot.session_instance_id.clone();

        let result =
            manager.refresh_folder_session_with_barrier(&snapshot.session_id, Some("main"), || {
                manager
                    .close_session_instance(&snapshot.session_id, &instance_id, Some("main"))
                    .unwrap();
            });

        assert!(result.unwrap_err().contains("invalid or expired"));
    }

    #[test]
    fn refresh_cancel_probe_stops_stale_scan_after_session_reopen() {
        reset_test_scan_entry_count();
        let dir = tempfile::tempdir().unwrap();
        for index in 0..200 {
            fs::write(dir.path().join(format!("image-{index:03}.jpg")), b"image").unwrap();
        }
        let manager = SessionManager::new();
        let snapshot =
            manager.open_folder_session_bootstrap(dir.path(), &[], 1, Some("main")).unwrap();
        reset_test_scan_entry_count();

        let manager_for_hook = manager.clone();
        let session_id_for_hook = snapshot.session_id.clone();
        let instance_id_for_hook = snapshot.session_instance_id.clone();
        let folder_for_hook = dir.path().to_path_buf();
        set_test_scan_entry_hook(move || {
            manager_for_hook
                .close_session_instance(&session_id_for_hook, &instance_id_for_hook, Some("main"))
                .unwrap();
            let _ = manager_for_hook.open_folder_session_bootstrap(
                &folder_for_hook,
                &[],
                1,
                Some("main"),
            );
        });

        let result = manager.refresh_folder_session(&snapshot.session_id, Some("main"));

        let error = result.unwrap_err();
        assert!(
            error.contains("no longer active") || error.contains("superseded"),
            "unexpected stale refresh error: {error}"
        );
        assert!(test_scan_entry_count() < 10);
        let store = manager.store.lock().unwrap();
        assert!(!store.sessions.contains_key(&snapshot.session_id));
        assert_eq!(store.sessions.len(), 1);
    }

    #[test]
    fn authoritative_refresh_reconciles_add_modify_rename_and_remove_records() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("a.jpg");
        let added = dir.path().join("b.jpg");
        let renamed = dir.path().join("renamed.jpg");
        fs::write(&original, b"one").unwrap();
        let manager = SessionManager::new();
        let initial = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let original_id = initial.images[0].id.clone();

        fs::write(&original, b"one-modified").unwrap();
        fs::write(&added, b"two").unwrap();
        let refreshed = manager.refresh_folder_session(&initial.session_id, Some("main")).unwrap();
        assert_eq!(refreshed.session_instance_id, initial.session_instance_id);
        assert_eq!(
            refreshed.images.iter().find(|image| image.path.ends_with("a.jpg")).unwrap().id,
            original_id
        );
        let added_id =
            refreshed.images.iter().find(|image| image.path.ends_with("b.jpg")).unwrap().id.clone();

        fs::rename(&original, &renamed).unwrap();
        fs::remove_file(&added).unwrap();
        let refreshed = manager.refresh_folder_session(&initial.session_id, Some("main")).unwrap();
        let renamed_record =
            refreshed.images.iter().find(|image| image.path.ends_with("renamed.jpg")).unwrap();
        assert_eq!(renamed_record.id, original_id);
        assert_eq!(renamed_record.size_bytes, b"one-modified".len() as u64);
        assert!(renamed_record.modified_at.is_some());
        assert!(manager.lease_image(&initial.session_id, &added_id, Some("main")).is_err());

        let lease =
            manager.lease_image(&initial.session_id, &renamed_record.id, Some("main")).unwrap();
        assert_eq!(
            fs::read(
                lease
                    .snapshot_for_path_consumer(
                        crate::image_resource_policy::OperationClass::Preview
                    )
                    .unwrap()
                    .path()
            )
            .unwrap(),
            b"one-modified"
        );
        manager.authorize_projector_read(&initial.session_id, &renamed_record.id, "secondary");
        assert!(manager
            .lease_image(&initial.session_id, &renamed_record.id, Some("secondary"))
            .is_ok());
    }

    #[test]
    fn authoritative_refresh_revokes_same_path_replacement_identity() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        let displaced = dir.path().join("displaced.bin");
        fs::write(&image, b"old-authorized-object").unwrap();
        let manager = SessionManager::new();
        let initial = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let old_id = initial.images[0].id.clone();

        fs::rename(&image, &displaced).unwrap();
        fs::write(&image, b"new-authorized-object").unwrap();
        assert!(manager.resolve_image_path(&initial.session_id, &old_id, Some("main")).is_err());
        let refreshed = manager.refresh_folder_session(&initial.session_id, Some("main")).unwrap();
        let replacement =
            refreshed.images.iter().find(|record| record.path.ends_with("photo.jpg")).unwrap();

        assert_ne!(replacement.id, old_id);
        assert!(manager.lease_image(&initial.session_id, &old_id, Some("main")).is_err());
        let lease =
            manager.lease_image(&initial.session_id, &replacement.id, Some("main")).unwrap();
        assert_eq!(fs::read(lease.path()).unwrap(), b"new-authorized-object");
    }

    #[test]
    fn authoritative_refresh_keeps_distinct_stable_ids_for_hard_links() {
        let dir = tempfile::tempdir().unwrap();
        let first_path = dir.path().join("first.jpg");
        let second_path = dir.path().join("second.jpg");
        fs::write(&first_path, b"shared-object").unwrap();
        fs::hard_link(&first_path, &second_path).unwrap();
        let manager = SessionManager::new();
        let initial = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let initial_by_name: HashMap<_, _> = initial
            .images
            .iter()
            .map(|record| (record.file_name.clone(), record.id.clone()))
            .collect();
        assert_eq!(initial_by_name.len(), 2);
        assert_ne!(initial_by_name["first.jpg"], initial_by_name["second.jpg"]);

        let refreshed = manager.refresh_folder_session(&initial.session_id, Some("main")).unwrap();
        let refreshed_by_name: HashMap<_, _> = refreshed
            .images
            .iter()
            .map(|record| (record.file_name.clone(), record.id.clone()))
            .collect();
        assert_eq!(refreshed_by_name, initial_by_name);
        assert_eq!(
            manager.store.lock().unwrap().sessions[&initial.session_id].images_by_id.len(),
            2
        );
    }

    #[test]
    fn concurrent_authoritative_refreshes_commit_serially() {
        use std::sync::mpsc;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("photo.jpg"), b"image").unwrap();
        let manager = SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();

        let first_manager = manager.clone();
        let first_session_id = session.session_id.clone();
        let (first_entered_tx, first_entered_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();
        let first = std::thread::spawn(move || {
            first_manager.refresh_folder_session_with_barrier(
                &first_session_id,
                Some("main"),
                || {
                    first_entered_tx.send(()).unwrap();
                    release_first_rx.recv().unwrap();
                },
            )
        });
        first_entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        let second_manager = manager.clone();
        let second_session_id = session.session_id.clone();
        let (second_entered_tx, second_entered_rx) = mpsc::channel();
        let second = std::thread::spawn(move || {
            second_manager.refresh_folder_session_with_barrier(
                &second_session_id,
                Some("main"),
                || second_entered_tx.send(()).unwrap(),
            )
        });

        assert!(second_entered_rx.recv_timeout(Duration::from_millis(100)).is_err());
        release_first_tx.send(()).unwrap();
        first.join().unwrap().unwrap();
        second_entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        second.join().unwrap().unwrap();
    }

    #[test]
    fn delayed_close_for_reused_session_id_cannot_remove_new_instance() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("photo.jpg"), b"image").unwrap();
        let manager = SessionManager::new();
        let first = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let second = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        assert_eq!(first.session_id, second.session_id);
        assert_ne!(first.session_instance_id, second.session_instance_id);
        assert!(!manager
            .close_session_instance(&first.session_id, &first.session_instance_id, Some("main"))
            .unwrap());
        assert!(manager.get_session_snapshot(&second.session_id, Some("main")).is_ok());
        assert!(manager
            .close_session_instance(&second.session_id, &second.session_instance_id, Some("main"))
            .unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn destination_grant_pins_original_windows_directory_identity() {
        let root = tempfile::tempdir().unwrap();
        let granted = root.path().join("granted");
        let moved = root.path().join("moved");
        fs::create_dir(&granted).unwrap();
        let target = granted.join("existing.jpg");
        fs::write(&target, b"existing-target").unwrap();
        let outside = root.path().join("outside-sentinel");
        fs::write(&outside, b"outside-safe").unwrap();
        let manager = SessionManager::new();
        let grant = manager.grant_destination(&granted, Some("main")).unwrap();

        let rename = fs::rename(&granted, &moved);
        assert!(rename.is_err(), "pinned granted directory must reject rename/replacement");
        assert_eq!(fs::read(&target).unwrap(), b"existing-target");
        assert_eq!(fs::read(&outside).unwrap(), b"outside-safe");
        assert_eq!(
            manager.resolve_destination_grant(&grant, Some("main")).unwrap(),
            normalize_path_buf(&fs::canonicalize(&granted).unwrap())
        );
    }

    #[cfg(unix)]
    #[test]
    fn destination_grant_rejects_replaced_directory_identity_on_unix() {
        let root = tempfile::tempdir().unwrap();
        let granted = root.path().join("granted");
        let moved = root.path().join("moved");
        fs::create_dir(&granted).unwrap();
        let manager = SessionManager::new();
        let grant = manager.grant_destination(&granted, Some("main")).unwrap();
        fs::rename(&granted, &moved).unwrap();
        fs::create_dir(&granted).unwrap();

        assert!(manager.resolve_destination_grant(&grant, Some("main")).is_err());
    }

    #[test]
    fn test_session_manager_rejects_unauthorized_or_stale_ids() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        fs::write(&image, b"dummy-image").unwrap();

        let manager = SessionManager::new();
        let snapshot = manager.open_folder_session(dir.path(), None).unwrap();
        let session_id = snapshot.session_id.clone();
        let image_id = snapshot.images[0].id.clone();

        // 1. Invalid image ID
        assert!(manager.resolve_image_path(&session_id, "img_fake", None).is_err());

        // 2. Closed session
        manager.close_session(&session_id, None).unwrap();
        assert!(manager.resolve_image_path(&session_id, &image_id, None).is_err());
    }

    #[test]
    fn active_image_lease_survives_session_close_and_projector_revocation() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        fs::write(&image, b"leased-image").unwrap();
        let manager = SessionManager::new();
        let snapshot = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let image_id = snapshot.images[0].id.clone();
        manager.authorize_projector_read(&snapshot.session_id, &image_id, "secondary");
        let lease =
            manager.lease_image(&snapshot.session_id, &image_id, Some("secondary")).unwrap();

        manager.revoke_projector_grant("secondary");
        manager.close_session(&snapshot.session_id, Some("main")).unwrap();

        assert_eq!(fs::read(lease.path()).unwrap(), b"leased-image");
        lease.revalidate().unwrap();
        assert!(manager.lease_image(&snapshot.session_id, &image_id, Some("secondary")).is_err());
        drop(lease);
        drop(manager);
    }

    #[test]
    fn projector_navigation_rejects_stale_epochs_and_out_of_order_generations() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.jpg"), b"a").unwrap();
        fs::write(dir.path().join("b.jpg"), b"b").unwrap();
        let manager = SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let first = session.images[0].id.clone();
        let second = session.images[1].id.clone();

        manager.authorize_projector_read(&session.session_id, &first, "secondary");
        let initial = manager.get_projector_display_record("secondary").unwrap();
        let navigated =
            manager.navigate_projector_image("secondary", &second, initial.grant_epoch, 2).unwrap();
        assert_eq!(navigated.image.id, second);
        assert_eq!(navigated.navigation_generation, 2);

        assert!(manager
            .navigate_projector_image("secondary", &first, initial.grant_epoch, 1,)
            .is_err());

        manager.authorize_projector_read(&session.session_id, &first, "secondary");
        let renewed = manager.get_projector_display_record("secondary").unwrap();
        assert!(renewed.grant_epoch > initial.grant_epoch);
        assert!(manager
            .navigate_projector_image("secondary", &second, initial.grant_epoch, 3,)
            .is_err());
        assert_eq!(manager.get_projector_display_record("secondary").unwrap().image.id, first);
    }

    #[test]
    fn projector_clear_invalidates_navigation_waiting_to_enter_transaction() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.jpg"), b"a").unwrap();
        fs::write(dir.path().join("b.jpg"), b"b").unwrap();
        let manager = SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let first = session.images[0].id.clone();
        let second = session.images[1].id.clone();
        manager.authorize_projector_read(&session.session_id, &first, "secondary");
        let epoch = manager.get_projector_display_record("secondary").unwrap().grant_epoch;
        let entered = std::sync::Arc::new(std::sync::Barrier::new(2));
        let proceed = std::sync::Arc::new(std::sync::Barrier::new(2));
        let worker_manager = manager.clone();
        let worker_entered = entered.clone();
        let worker_proceed = proceed.clone();
        let worker = std::thread::spawn(move || {
            worker_manager.navigate_projector_image_with_barrier(
                "secondary",
                &second,
                epoch,
                1,
                || {
                    worker_entered.wait();
                    worker_proceed.wait();
                },
            )
        });

        entered.wait();
        manager.revoke_projector_grant("secondary");
        proceed.wait();

        assert!(worker.join().unwrap().is_err());
        assert!(manager.get_projector_grant("secondary").is_none());
        assert!(manager.get_projector_display_record("secondary").is_err());
    }

    #[test]
    fn active_destination_lease_survives_registry_eviction() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionManager::new();
        let grant = manager.grant_destination(dir.path(), Some("main")).unwrap();
        let lease = manager.lease_destination_grant(&grant, Some("main")).unwrap();

        manager.store.lock().unwrap().destination_grants.remove(&grant);

        lease.revalidate().unwrap();
        assert_eq!(lease.path(), normalize_path_buf(&fs::canonicalize(dir.path()).unwrap()));
        assert!(manager.lease_destination_grant(&grant, Some("main")).is_err());
        drop(lease);
        drop(manager);
    }

    #[cfg(any(windows, target_os = "linux"))]
    #[test]
    fn identity_bound_move_survives_session_close_and_grant_eviction() {
        let source_dir = tempfile::tempdir().unwrap();
        let destination_dir = tempfile::tempdir().unwrap();
        let image = source_dir.path().join("photo.jpg");
        fs::write(&image, b"authorized-move-bytes").unwrap();
        let manager = SessionManager::new();
        let session = manager.open_folder_session(source_dir.path(), Some("main")).unwrap();
        let image_lease =
            manager.lease_image(&session.session_id, &session.images[0].id, Some("main")).unwrap();
        let grant = manager.grant_destination(destination_dir.path(), Some("main")).unwrap();
        let destination_lease = manager.lease_destination_grant(&grant, Some("main")).unwrap();

        manager.close_session(&session.session_id, Some("main")).unwrap();
        manager.store.lock().unwrap().destination_grants.remove(&grant);
        image_lease
            .move_to_destination(&destination_lease, std::ffi::OsStr::new("moved.jpg"))
            .unwrap();

        assert!(!image.exists());
        assert_eq!(
            fs::read(destination_dir.path().join("moved.jpg")).unwrap(),
            b"authorized-move-bytes"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn cross_volume_move_failure_points_preserve_a_coherent_recovery_state() {
        let failures = [
            MoveFailurePoint::AfterQuarantine,
            MoveFailurePoint::DuringCopy,
            MoveFailurePoint::DuringLink,
            MoveFailurePoint::DuringPublishedMetadata,
            MoveFailurePoint::DuringDestinationSync,
            MoveFailurePoint::DuringDestinationRollback,
            MoveFailurePoint::DuringDestinationRollbackSync,
            MoveFailurePoint::DuringCommittedDestinationSync,
            MoveFailurePoint::DuringSourceUnlink,
            MoveFailurePoint::DuringSourceSync,
            MoveFailurePoint::DuringRollback,
        ];

        for failure in failures {
            let source_dir = tempfile::tempdir().unwrap();
            let destination_dir = tempfile::tempdir().unwrap();
            let source_path = source_dir.path().join("photo.jpg");
            let target_path = destination_dir.path().join("moved.jpg");
            fs::write(&source_path, b"authorized-move-bytes").unwrap();
            let manager = SessionManager::new();
            let session = manager.open_folder_session(source_dir.path(), Some("main")).unwrap();
            let source_lease = manager
                .lease_image(&session.session_id, &session.images[0].id, Some("main"))
                .unwrap();
            let grant = manager.grant_destination(destination_dir.path(), Some("main")).unwrap();
            let destination_lease = manager.lease_destination_grant(&grant, Some("main")).unwrap();

            let result = source_lease.move_to_destination_with_failure(
                &destination_lease,
                std::ffi::OsStr::new("moved.jpg"),
                failure,
            );

            let recovery_entries = fs::read_dir(source_dir.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry.file_name().to_string_lossy().starts_with(".lightframe-move-")
                })
                .collect::<Vec<_>>();
            if matches!(
                failure,
                MoveFailurePoint::DuringSourceSync
                    | MoveFailurePoint::DuringCommittedDestinationSync
                    | MoveFailurePoint::DuringDestinationRollback
                    | MoveFailurePoint::DuringDestinationRollbackSync
            ) {
                let outcome = result.expect("committed move sync warnings are not failures");
                assert!(outcome.durability_warning().is_some());
                let source_should_remain = matches!(
                    failure,
                    MoveFailurePoint::DuringDestinationRollback
                        | MoveFailurePoint::DuringDestinationRollbackSync
                );
                assert_eq!(source_path.exists(), source_should_remain);
                assert_eq!(outcome.source_removed(), !source_should_remain);
                assert_eq!(outcome.target_path(), target_path.as_path());
                assert_eq!(fs::read(&target_path).unwrap(), b"authorized-move-bytes");
                assert!(recovery_entries.is_empty());
                continue;
            }
            let error = result.unwrap_err();
            match failure {
                MoveFailurePoint::DuringRollback => {
                    assert!(!source_path.exists());
                    assert!(!target_path.exists());
                    assert_eq!(recovery_entries.len(), 1);
                    assert_eq!(
                        fs::read(recovery_entries[0].path()).unwrap(),
                        b"authorized-move-bytes"
                    );
                    assert!(
                        error.contains(&recovery_entries[0].path().to_string_lossy().to_string())
                    );
                }
                _ => {
                    assert_eq!(fs::read(&source_path).unwrap(), b"authorized-move-bytes");
                    assert!(!target_path.exists());
                    assert!(recovery_entries.is_empty());
                    assert!(
                        error.contains("exact original restored"),
                        "{failure:?} did not report exact recovery: {error}"
                    );
                }
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_post_publication_move_failures_report_exact_commit_state() {
        for failure in [
            MoveFailurePoint::DuringPublishedMetadata,
            MoveFailurePoint::DuringDestinationSync,
            MoveFailurePoint::DuringSourceUnlink,
            MoveFailurePoint::DuringDestinationRollback,
            MoveFailurePoint::DuringSourceSync,
        ] {
            let source_dir = tempfile::tempdir().unwrap();
            let destination_dir = tempfile::tempdir().unwrap();
            let source_path = source_dir.path().join("photo.jpg");
            let target_path = destination_dir.path().join("moved.jpg");
            fs::write(&source_path, b"authorized-move-bytes").unwrap();
            let manager = SessionManager::new();
            let session = manager.open_folder_session(source_dir.path(), Some("main")).unwrap();
            let source_lease = manager
                .lease_image(&session.session_id, &session.images[0].id, Some("main"))
                .unwrap();
            let grant = manager.grant_destination(destination_dir.path(), Some("main")).unwrap();
            let destination_lease = manager.lease_destination_grant(&grant, Some("main")).unwrap();

            let result = source_lease.move_to_destination_with_failure(
                &destination_lease,
                std::ffi::OsStr::new("moved.jpg"),
                failure,
            );
            drop(source_lease);

            match failure {
                MoveFailurePoint::DuringDestinationRollback => {
                    let outcome = result.expect("failed rollback must report committed");
                    assert!(!outcome.source_removed());
                    assert!(outcome.durability_warning().is_some());
                    assert_eq!(outcome.target_path(), target_path.as_path());
                    assert_eq!(fs::read(&source_path).unwrap(), b"authorized-move-bytes");
                    assert_eq!(fs::read(&target_path).unwrap(), b"authorized-move-bytes");
                }
                MoveFailurePoint::DuringSourceSync => {
                    let outcome = result.expect("post-commit sync failure must report committed");
                    assert!(outcome.source_removed());
                    assert!(outcome.durability_warning().is_some());
                    assert!(!source_path.exists());
                    assert_eq!(fs::read(&target_path).unwrap(), b"authorized-move-bytes");
                }
                _ => {
                    assert!(result.is_err());
                    assert_eq!(fs::read(&source_path).unwrap(), b"authorized-move-bytes");
                    assert!(!target_path.exists());
                }
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn external_editor_lease_blocks_executable_replacement() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("editor.exe");
        fs::write(&executable, b"fake-executable").unwrap();
        let manager = SessionManager::new();
        let grant = manager.grant_external_editor(&executable, Some("main")).unwrap();
        let lease = manager.lease_external_editor_grant(&grant, Some("main")).unwrap();

        assert!(fs::rename(&executable, root.path().join("replacement.exe")).is_err());
        lease.revalidate().unwrap();
        assert_eq!(fs::read(&executable).unwrap(), b"fake-executable");
    }

    #[test]
    fn xmp_sidecar_handle_survives_session_close_without_path_reopen() {
        use std::io::Read;

        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("photo.jpg"), b"image").unwrap();
        fs::write(dir.path().join("photo.xmp"), b"authorized-sidecar").unwrap();
        let manager = SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let sidecar = manager
            .lease_xmp_sidecar(&session.session_id, &session.images[0].id, Some("main"))
            .unwrap()
            .unwrap();
        manager.close_session(&session.session_id, Some("main")).unwrap();

        let mut file = sidecar.into_file();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"authorized-sidecar");
    }

    #[test]
    fn exact_destination_grant_is_bound_to_file_operation_window_and_one_use() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionManager::new();
        let target = dir.path().join("export.jpg");
        let (grant, relative) =
            manager.grant_exact_destination(&target, "crop-copy", Some("main")).unwrap();

        assert_eq!(relative, "export.jpg");
        let mismatch = match manager.consume_exact_destination_grant(
            &grant,
            "sibling.jpg",
            "crop-copy",
            Some("main"),
        ) {
            Err(error) => error,
            Ok(_) => panic!("mismatched name unexpectedly consumed the exact grant"),
        };
        assert!(!mismatch.consumed);
        assert!(manager
            .consume_exact_destination_grant(&grant, "export.jpg", "scale-copy", Some("main"))
            .is_err());
        assert!(manager
            .consume_exact_destination_grant(&grant, "export.jpg", "crop-copy", Some("secondary"),)
            .is_err());

        let lease = manager
            .consume_exact_destination_grant(&grant, "export.jpg", "crop-copy", Some("main"))
            .unwrap();
        lease.revalidate().unwrap();
        let reused = match manager.consume_exact_destination_grant(
            &grant,
            "export.jpg",
            "crop-copy",
            Some("main"),
        ) {
            Err(error) => error,
            Ok(_) => panic!("one-use exact grant was reusable"),
        };
        assert!(reused.consumed);
    }

    #[test]
    fn expired_exact_destination_grant_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionManager::new();
        let (grant, _) = manager
            .grant_exact_destination(&dir.path().join("expired.jpg"), "crop-copy", Some("main"))
            .unwrap();
        if let Some(DestinationGrantInternal {
            scope: DestinationGrantScope::ExactFile { expires_at_epoch, .. },
            ..
        }) = manager.store.lock().unwrap().destination_grants.get_mut(&grant)
        {
            *expires_at_epoch = 0;
        }

        let expired = match manager.consume_exact_destination_grant(
            &grant,
            "expired.jpg",
            "crop-copy",
            Some("main"),
        ) {
            Err(error) => error,
            Ok(_) => panic!("expired exact grant was accepted"),
        };
        assert!(expired.consumed);
    }

    #[test]
    fn folder_and_exact_destination_grants_cannot_be_cross_used() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionManager::new();
        let folder_grant = manager.grant_destination(dir.path(), Some("main")).unwrap();
        let (exact_grant, _) = manager
            .grant_exact_destination(&dir.path().join("one.jpg"), "scale-copy", Some("main"))
            .unwrap();

        assert!(manager
            .consume_exact_destination_grant(&folder_grant, "one.jpg", "scale-copy", Some("main"),)
            .is_err());
        assert!(manager.lease_destination_grant(&exact_grant, Some("main")).is_err());
        assert!(manager.resolve_destination_grant(&exact_grant, Some("main")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn authorized_snapshot_reads_leased_identity_after_path_replacement() {
        use std::io::Read;

        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        fs::write(&image, b"authorized-bytes").unwrap();
        let manager = SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let lease =
            manager.lease_image(&session.session_id, &session.images[0].id, Some("main")).unwrap();

        fs::rename(&image, dir.path().join("original.jpg")).unwrap();
        fs::write(&image, b"replacement-bytes").unwrap();
        let snapshot = match lease
            .snapshot_for_path_consumer(crate::image_resource_policy::OperationClass::Preview)
        {
            Ok(_) => panic!("replacement identity unexpectedly produced a snapshot"),
            Err(error) => error,
        };
        assert!(snapshot.contains("identity changed") || snapshot.contains("path"));

        let mut pinned = lease.try_clone_file().unwrap();
        let mut bytes = Vec::new();
        pinned.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"authorized-bytes");
    }

    #[test]
    fn authorized_snapshot_rejects_oversized_pinned_source_before_copying() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("oversized.jpg");
        let limits = crate::image_resource_policy::PolicyLimits::for_operation(
            crate::image_resource_policy::OperationClass::Preview,
        );
        let file = fs::File::create(&image).unwrap();
        file.set_len(limits.max_file_size_bytes + 1).unwrap();
        drop(file);

        let manager = SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let lease =
            manager.lease_image(&session.session_id, &session.images[0].id, Some("main")).unwrap();

        let error = match lease
            .snapshot_for_path_consumer(crate::image_resource_policy::OperationClass::Preview)
        {
            Ok(_) => panic!("oversized source unexpectedly received a snapshot"),
            Err(error) => error,
        };
        assert!(error.contains("exceeds"));
        assert_eq!(fs::metadata(&image).unwrap().len(), limits.max_file_size_bytes + 1);
    }

    #[cfg(windows)]
    #[test]
    fn atomic_replacement_failures_restore_complete_original_identity() {
        for failure in [
            ReplacementFailurePoint::AfterPartialStagingWrite,
            ReplacementFailurePoint::AfterStagingFlush,
            ReplacementFailurePoint::AfterSourceQuarantine,
            ReplacementFailurePoint::DuringPublication,
            ReplacementFailurePoint::PublishedPathSwap,
            ReplacementFailurePoint::AfterPublication,
            ReplacementFailurePoint::DuringDirectorySync,
        ] {
            let dir = tempfile::tempdir().unwrap();
            let image = dir.path().join("photo.jpg");
            let replacement = dir.path().join("prepared.jpg");
            fs::write(&image, b"complete-original-image").unwrap();
            fs::write(&replacement, b"complete-replacement-image").unwrap();
            let manager = SessionManager::new();
            let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
            let image_record =
                session.images.iter().find(|record| record.file_name == "photo.jpg").unwrap();
            let lease =
                manager.lease_image(&session.session_id, &image_record.id, Some("main")).unwrap();

            let error =
                lease.replace_contents_from_with_failure(&replacement, None, failure).unwrap_err();
            let restored = fs::read(&image)
                .unwrap_or_else(|read_error| panic!("{failure:?}: {error}; read: {read_error}"));
            assert_eq!(restored, b"complete-original-image", "{failure:?}: {error}");
            let residue = fs::read_dir(dir.path())
                .unwrap()
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| name.starts_with(".lightframe-"))
                .collect::<Vec<_>>();
            assert!(residue.is_empty(), "{failure:?}: {error}; residue={residue:?}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_atomic_replacement_failures_restore_exact_original_without_residue() {
        for failure in [
            ReplacementFailurePoint::AfterPartialStagingWrite,
            ReplacementFailurePoint::AfterStagingFlush,
            ReplacementFailurePoint::BeforeSourceRevalidation,
            ReplacementFailurePoint::StagingPathSwap,
            ReplacementFailurePoint::AfterSourceQuarantine,
            ReplacementFailurePoint::DuringBackupReopen,
            ReplacementFailurePoint::DuringPublication,
            ReplacementFailurePoint::PublishedPathSwap,
            ReplacementFailurePoint::AfterPublication,
            ReplacementFailurePoint::DuringDirectorySync,
        ] {
            let dir = tempfile::tempdir().unwrap();
            let image = dir.path().join("photo.jpg");
            let replacement = dir.path().join("prepared.jpg");
            fs::write(&image, b"complete-original-image").unwrap();
            fs::write(&replacement, b"complete-replacement-image").unwrap();
            let manager = SessionManager::new();
            let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
            let record =
                session.images.iter().find(|record| record.file_name == "photo.jpg").unwrap();
            let lease = manager.lease_image(&session.session_id, &record.id, Some("main")).unwrap();

            let error =
                lease.replace_contents_from_with_failure(&replacement, None, failure).unwrap_err();
            assert_eq!(
                fs::read(&image).unwrap(),
                b"complete-original-image",
                "{failure:?}: {error}"
            );
            let residue = fs::read_dir(dir.path())
                .unwrap()
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| name.starts_with(".lightframe-"))
                .collect::<Vec<_>>();
            assert!(residue.is_empty(), "{failure:?}: {error}; residue={residue:?}");
        }
    }

    #[test]
    fn atomic_replacement_commits_complete_staged_content() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        let replacement = dir.path().join("prepared.jpg");
        fs::write(&image, b"complete-original-image").unwrap();
        fs::write(&replacement, b"complete-replacement-image").unwrap();
        let manager = SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let image_record =
            session.images.iter().find(|record| record.file_name == "photo.jpg").unwrap();
        let lease =
            manager.lease_image(&session.session_id, &image_record.id, Some("main")).unwrap();

        lease.replace_contents_from(&replacement).unwrap();
        assert_eq!(fs::read(&image).unwrap(), b"complete-replacement-image");
    }

    #[cfg(windows)]
    #[test]
    fn permanent_unlink_is_not_accepted_as_windows_trash_and_exact_source_is_restored() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        fs::write(&image, b"trash-me").unwrap();
        let manager = SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let lease =
            manager.lease_image(&session.session_id, &session.images[0].id, Some("main")).unwrap();
        manager.close_session(&session.session_id, Some("main")).unwrap();

        let error = lease
            .trash_with_action(|quarantine| {
                fs::remove_file(quarantine).map_err(|error| error.to_string())
            })
            .unwrap_err();
        assert!(error.contains("recycle bin"));
        assert_eq!(fs::read(image).unwrap(), b"trash-me");
    }

    #[cfg(any(windows, target_os = "linux"))]
    #[test]
    fn production_trash_handoff_recognizes_the_exact_operating_system_result() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("production-trash.jpg");
        fs::write(&image, b"production-trash").unwrap();
        let manager = SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let record = session
            .images
            .iter()
            .find(|record| record.file_name == "production-trash.jpg")
            .unwrap();
        let lease = manager.lease_image(&session.session_id, &record.id, Some("main")).unwrap();

        lease.trash_with_recovery().unwrap();
        assert!(!image.exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn permanent_unlink_is_not_accepted_as_trash_and_exact_source_is_restored() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        fs::write(&image, b"unlink-is-not-trash").unwrap();
        let manager = SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let lease =
            manager.lease_image(&session.session_id, &session.images[0].id, Some("main")).unwrap();

        let error = lease
            .trash_with_action(|source| fs::remove_file(source).map_err(|error| error.to_string()))
            .unwrap_err();
        assert!(error.contains("authoritative trash metadata"));
        assert_eq!(fs::read(image).unwrap(), b"unlink-is-not-trash");
    }

    #[cfg(windows)]
    #[test]
    fn recycle_path_requires_volume_root_and_the_current_exact_user_sid() {
        let sid = current_windows_user_sid().unwrap();
        assert!(is_current_user_recycle_path(
            Path::new(&format!(r"\\?\C:\$Recycle.Bin\{sid}\$R123.jpg")),
            &sid
        ));
        assert!(!is_current_user_recycle_path(
            Path::new(&format!(r"\\?\C:\photos\$Recycle.Bin\{sid}\$R123.jpg")),
            &sid
        ));
        assert!(!is_current_user_recycle_path(
            Path::new(r"\\?\C:\$Recycle.Bin\S-1-5-21-999\$R123.jpg"),
            &sid
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn trashinfo_requires_matching_decoded_path_and_valid_deletion_date() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("A photo.jpg");
        let info = dir.path().join("entry.trashinfo");
        let original_text = original.to_string_lossy();
        let encoded = percent_encoding::utf8_percent_encode(
            &original_text,
            percent_encoding::NON_ALPHANUMERIC,
        );
        fs::write(
            &info,
            format!("[Trash Info]\nPath={encoded}\nDeletionDate=2026-08-03T19:30:00\n"),
        )
        .unwrap();
        assert!(trashinfo_proves_original(&info, &original, None));
        assert!(!trashinfo_proves_original(&info, &dir.path().join("different.jpg"), None));
        fs::write(&info, format!("[Trash Info]\nPath={encoded}\nDeletionDate=not-a-date\n"))
            .unwrap();
        assert!(!trashinfo_proves_original(&info, &original, None));
    }

    #[test]
    fn identity_bound_trash_failure_restores_original_name_and_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        fs::write(&image, b"keep-me").unwrap();
        let manager = SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let lease =
            manager.lease_image(&session.session_id, &session.images[0].id, Some("main")).unwrap();

        let error = lease.trash_with_action(|_| Err("injected trash failure".into())).unwrap_err();
        assert!(error.contains("original restored"));
        assert_eq!(fs::read(&image).unwrap(), b"keep-me");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_trash_rollback_preserves_a_replaced_recovery_link() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        let moved_exact = dir.path().join("moved-recovery-link.jpg");
        fs::write(&image, b"authorized-original").unwrap();
        let manager = SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let lease =
            manager.lease_image(&session.session_id, &session.images[0].id, Some("main")).unwrap();

        let error = lease
            .trash_with_action(|source| {
                let recovery_link = fs::read_dir(source.parent().unwrap())
                    .map_err(|error| error.to_string())?
                    .filter_map(Result::ok)
                    .find(|entry| {
                        entry.file_name().to_string_lossy().starts_with(".lightframe-trash-")
                    })
                    .ok_or_else(|| "missing recovery link".to_string())?
                    .path();
                fs::rename(&recovery_link, &moved_exact).map_err(|error| error.to_string())?;
                fs::write(&recovery_link, b"unrelated-sentinel")
                    .map_err(|error| error.to_string())?;
                Err("injected trash failure".into())
            })
            .unwrap_err();

        let retained = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".lightframe-isolated-trash-handoff-")
            })
            .expect("preserved replaced recovery link");
        assert!(error.contains("exact original restored"));
        assert!(error.contains("identity-mismatched retained trash recovery link"));
        assert!(error.contains(&retained.path().to_string_lossy().to_string()));
        assert_eq!(fs::read(&image).unwrap(), b"authorized-original");
        assert_eq!(fs::read(retained.path()).unwrap(), b"unrelated-sentinel");
        assert_eq!(fs::read(&moved_exact).unwrap(), b"authorized-original");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_trash_commit_preserves_a_replaced_recovery_link() {
        let dir = tempfile::tempdir().unwrap();
        let authoritative_trash_object = dir.path().join("authoritative-trash-object.jpg");
        let recovery_link = dir.path().join(".lightframe-trash-recovery");
        let moved_exact = dir.path().join("moved-recovery-link.jpg");
        fs::write(&authoritative_trash_object, b"authorized-original").unwrap();
        fs::hard_link(&authoritative_trash_object, &recovery_link).unwrap();
        let expected = fs::File::open(&authoritative_trash_object).unwrap();
        let directory = fs::File::open(dir.path()).unwrap();
        let isolation = std::cell::RefCell::new(None::<LinuxHandoffAliasIsolation>);

        let outcome = linux_finalize_authoritative_trash(
            &directory,
            dir.path(),
            &isolation,
            recovery_link.file_name().unwrap(),
            &expected,
            || {
                fs::rename(&recovery_link, &moved_exact).map_err(|error| error.to_string())?;
                fs::write(&recovery_link, b"unrelated-sentinel").map_err(|error| error.to_string())
            },
            || Ok(()),
        );

        assert!(outcome.committed);
        let warning = outcome.warning.expect("retained recovery-link warning");
        assert!(warning.contains("canonical source name is absent"));
        assert!(warning.contains("exact object is in authoritative trash"));
        assert!(warning.contains("identity-mismatched"));
        let isolated = dir.path().join(&isolation.borrow().as_ref().unwrap().recovery_name);
        assert!(warning.contains(isolated.to_string_lossy().as_ref()));
        assert_eq!(fs::read(&isolated).unwrap(), b"unrelated-sentinel");
        assert_eq!(fs::read(&moved_exact).unwrap(), b"authorized-original");
        assert_eq!(fs::read(&authoritative_trash_object).unwrap(), b"authorized-original");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_authoritative_trash_pre_rename_failure_remains_committed() {
        let dir = tempfile::tempdir().unwrap();
        let canonical_source = dir.path().join("photo.jpg");
        let authoritative_trash_object = dir.path().join("authoritative-trash-object.jpg");
        let recovery_link = dir.path().join(".lightframe-trash-recovery");
        fs::write(&authoritative_trash_object, b"authorized-original").unwrap();
        fs::hard_link(&authoritative_trash_object, &recovery_link).unwrap();
        let expected = fs::File::open(&authoritative_trash_object).unwrap();
        let directory = fs::File::open(dir.path()).unwrap();
        let isolation = std::cell::RefCell::new(None::<LinuxHandoffAliasIsolation>);

        let outcome = linux_finalize_authoritative_trash(
            &directory,
            dir.path(),
            &isolation,
            recovery_link.file_name().unwrap(),
            &expected,
            || Err("injected pre-rename failure".into()),
            || Ok(()),
        );

        assert!(outcome.committed);
        assert!(!canonical_source.exists());
        assert_eq!(fs::read(&authoritative_trash_object).unwrap(), b"authorized-original");
        assert_eq!(fs::read(&recovery_link).unwrap(), b"authorized-original");
        assert!(isolation.borrow().is_none());
        let warning = outcome.warning.unwrap();
        assert!(warning.contains("exact object is in authoritative trash"));
        assert!(warning.contains("no stable recovery artifact path is claimed"));
        assert!(warning.contains("injected pre-rename failure"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_authoritative_trash_pre_verification_failure_remains_committed() {
        let dir = tempfile::tempdir().unwrap();
        let canonical_source = dir.path().join("photo.jpg");
        let authoritative_trash_object = dir.path().join("authoritative-trash-object.jpg");
        let recovery_link = dir.path().join(".lightframe-trash-recovery");
        fs::write(&authoritative_trash_object, b"authorized-original").unwrap();
        fs::hard_link(&authoritative_trash_object, &recovery_link).unwrap();
        let expected = fs::File::open(&authoritative_trash_object).unwrap();
        let directory = fs::File::open(dir.path()).unwrap();
        let isolation = std::cell::RefCell::new(None::<LinuxHandoffAliasIsolation>);

        let outcome = linux_finalize_authoritative_trash(
            &directory,
            dir.path(),
            &isolation,
            recovery_link.file_name().unwrap(),
            &expected,
            || Ok(()),
            || Err("injected pre-verification failure".into()),
        );

        assert!(outcome.committed);
        assert!(!canonical_source.exists());
        assert_eq!(fs::read(&authoritative_trash_object).unwrap(), b"authorized-original");
        let isolated = dir.path().join(&isolation.borrow().as_ref().unwrap().recovery_name);
        assert_eq!(fs::read(&isolated).unwrap(), b"authorized-original");
        assert!(!recovery_link.exists());
        let warning = outcome.warning.unwrap();
        assert!(warning.contains("exact object is in authoritative trash"));
        assert!(warning.contains("unverified retained committed trash recovery link"));
        assert!(warning.contains(isolated.to_string_lossy().as_ref()));
        assert!(warning.contains("injected pre-verification failure"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn identity_bound_trash_rejects_trash_lookalike_path_and_restores_exact_source() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        let lookalike = dir.path().join(".Trash-1000-lookalike.jpg");
        fs::write(&image, b"authorized-original").unwrap();
        let manager = SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let lease =
            manager.lease_image(&session.session_id, &session.images[0].id, Some("main")).unwrap();

        let error = lease
            .trash_with_action(|source| {
                fs::rename(source, &lookalike).map_err(|error| error.to_string())
            })
            .unwrap_err();

        assert!(error.contains("exact original restored"));
        assert_eq!(fs::read(&image).unwrap(), b"authorized-original");
        assert!(!lookalike.exists());
        let preserved = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".lightframe-isolated-trash-handoff-")
            })
            .expect("preserved exact handoff alias");
        assert_eq!(fs::read(preserved.path()).unwrap(), b"authorized-original");
        assert!(error.contains(&preserved.path().to_string_lossy().to_string()));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn nested_mount_trash_lookalike_with_valid_metadata_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        fs::write(&image, b"authorized-original").unwrap();
        let uid = unsafe { libc::geteuid() };
        let fake_root = dir.path().join(format!(".Trash-{uid}"));
        let fake_files = fake_root.join("files");
        let fake_info = fake_root.join("info");
        fs::create_dir_all(&fake_files).unwrap();
        fs::create_dir_all(&fake_info).unwrap();
        let manager = SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let lease =
            manager.lease_image(&session.session_id, &session.images[0].id, Some("main")).unwrap();
        let original = image.clone();
        let moved = fake_files.join("photo.jpg");
        let info = fake_info.join("photo.jpg.trashinfo");

        let error = lease
            .trash_with_action(|source| {
                fs::rename(source, &moved).map_err(|error| error.to_string())?;
                let original_text = original.to_string_lossy();
                let encoded = percent_encoding::utf8_percent_encode(
                    &original_text,
                    percent_encoding::NON_ALPHANUMERIC,
                );
                fs::write(
                    &info,
                    format!("[Trash Info]\nPath={encoded}\nDeletionDate=2026-08-03T20:00:00\n"),
                )
                .map_err(|error| error.to_string())
            })
            .unwrap_err();

        assert!(error.contains("authoritative trash metadata"));
        assert_eq!(fs::read(image).unwrap(), b"authorized-original");
        assert_eq!(fs::read(&moved).unwrap(), b"authorized-original");
        assert!(error.contains(&moved.to_string_lossy().to_string()));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_handoff_alias_isolation_preserves_raced_sentinel() {
        let dir = tempfile::tempdir().unwrap();
        let exact = dir.path().join("photo.jpg");
        let handoff = dir.path().join("handoff.jpg");
        let recovered_exact = dir.path().join("recovered-exact.jpg");
        fs::write(&exact, b"authorized-original").unwrap();
        fs::hard_link(&exact, &handoff).unwrap();
        let expected = fs::File::open(&exact).unwrap();
        let directory = fs::File::open(dir.path()).unwrap();
        let cache = std::cell::RefCell::new(None::<LinuxHandoffAliasIsolation>);

        let isolation = linux_isolate_handoff_alias(
            &cache,
            &directory,
            std::ffi::OsStr::new("handoff.jpg"),
            &expected,
            || {
                fs::rename(&handoff, &recovered_exact).map_err(|error| error.to_string())?;
                fs::write(&handoff, b"unrelated-sentinel").map_err(|error| error.to_string())
            },
            || Ok(()),
            |_| Ok(()),
        )
        .unwrap();

        assert_eq!(isolation.identity, LinuxIsolationIdentity::Mismatched);
        let isolated = dir.path().join(&isolation.recovery_name);
        assert_eq!(fs::read(&isolated).unwrap(), b"unrelated-sentinel");
        assert_eq!(fs::read(&exact).unwrap(), b"authorized-original");
        assert_eq!(fs::read(&recovered_exact).unwrap(), b"authorized-original");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_handoff_alias_isolation_preserves_post_verification_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let exact = dir.path().join("photo.jpg");
        let handoff = dir.path().join("handoff.jpg");
        let moved_exact = dir.path().join("moved-exact.jpg");
        fs::write(&exact, b"authorized-original").unwrap();
        fs::hard_link(&exact, &handoff).unwrap();
        let expected = fs::File::open(&exact).unwrap();
        let directory = fs::File::open(dir.path()).unwrap();
        let cache = std::cell::RefCell::new(None::<LinuxHandoffAliasIsolation>);

        let isolation = linux_isolate_handoff_alias(
            &cache,
            &directory,
            std::ffi::OsStr::new("handoff.jpg"),
            &expected,
            || Ok(()),
            || Ok(()),
            |recovery_name| {
                let isolated = dir.path().join(recovery_name);
                fs::rename(&isolated, &moved_exact).map_err(|error| error.to_string())?;
                fs::write(&isolated, b"unrelated-sentinel").map_err(|error| error.to_string())
            },
        )
        .unwrap();

        assert_eq!(isolation.identity, LinuxIsolationIdentity::Exact);
        let preserved = dir.path().join(&isolation.recovery_name);
        assert_eq!(fs::read(&preserved).unwrap(), b"unrelated-sentinel");
        assert_eq!(fs::read(&exact).unwrap(), b"authorized-original");
        assert_eq!(fs::read(&moved_exact).unwrap(), b"authorized-original");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_handoff_alias_isolation_retains_unknown_outcome_after_verification_failure() {
        let dir = tempfile::tempdir().unwrap();
        let exact = dir.path().join("photo.jpg");
        let handoff = dir.path().join("handoff.jpg");
        fs::write(&exact, b"authorized-original").unwrap();
        fs::hard_link(&exact, &handoff).unwrap();
        let expected = fs::File::open(&exact).unwrap();
        let directory = fs::File::open(dir.path()).unwrap();
        let cache = std::cell::RefCell::new(None::<LinuxHandoffAliasIsolation>);

        let error = linux_isolate_handoff_alias(
            &cache,
            &directory,
            std::ffi::OsStr::new("handoff.jpg"),
            &expected,
            || Ok(()),
            || Err("injected verification failure".into()),
            |_| Ok(()),
        )
        .unwrap_err();
        let retained = dir.path().join(&cache.borrow().as_ref().unwrap().recovery_name);
        assert!(error
            .contains(cache.borrow().as_ref().unwrap().recovery_name.to_string_lossy().as_ref()));
        assert_eq!(cache.borrow().as_ref().unwrap().identity, LinuxIsolationIdentity::Unknown);
        assert!(retained.exists());

        let retried = linux_isolate_handoff_alias(
            &cache,
            &directory,
            std::ffi::OsStr::new("handoff.jpg"),
            &expected,
            || panic!("cached retry must not rename again"),
            || panic!("cached retry must not verify again"),
            |_| panic!("cached retry must not run hooks"),
        )
        .unwrap();
        assert_eq!(retried.identity, LinuxIsolationIdentity::Unknown);
        assert_eq!(retried.recovery_name.as_os_str(), retained.file_name().unwrap());
        assert_eq!(fs::read(retained).unwrap(), b"authorized-original");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_handoff_alias_isolation_is_reused_after_a_recovery_retry() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let dir = tempfile::tempdir().unwrap();
        let exact = dir.path().join("photo.jpg");
        let handoff = dir.path().join("handoff.jpg");
        fs::write(&exact, b"authorized-original").unwrap();
        fs::hard_link(&exact, &handoff).unwrap();
        let expected = fs::File::open(&exact).unwrap();
        let directory = fs::File::open(dir.path()).unwrap();
        let directory_path = dir.path().to_path_buf();
        let isolation = Rc::new(RefCell::new(None::<LinuxHandoffAliasIsolation>));
        let artifacts = Rc::new(RefCell::new(Vec::<LinuxPreservedRecoveryArtifact>::new()));
        let fail_once = Rc::new(RefCell::new(true));
        let recovery_attempts = Rc::new(RefCell::new(0_usize));
        let reported_path = {
            let isolation = Rc::clone(&isolation);
            let recovery_artifacts = Rc::clone(&artifacts);
            let fail_once = Rc::clone(&fail_once);
            let recovery_attempts = Rc::clone(&recovery_attempts);
            let mut recovery = SourceReplacementRecovery::new(move |_| {
                *recovery_attempts.borrow_mut() += 1;
                let outcome = linux_isolate_handoff_alias(
                    &isolation,
                    &directory,
                    std::ffi::OsStr::new("handoff.jpg"),
                    &expected,
                    || Ok(()),
                    || Ok(()),
                    |_| Ok(()),
                )?;
                let path = directory_path.join(&outcome.recovery_name);
                linux_record_preserved_recovery_artifact(
                    &recovery_artifacts,
                    path.clone(),
                    "exact handoff alias",
                );
                if std::mem::replace(&mut *fail_once.borrow_mut(), false) {
                    return Err("injected post-isolation recovery failure".into());
                }
                Ok(())
            });
            let error = recovery
                .mutate::<()>("injected mutation", || Err("operation failed".into()))
                .unwrap_err();
            let report = linux_report_preserved_recovery_artifacts(error, &artifacts.borrow());
            let path = artifacts.borrow()[0].0.clone();
            assert!(report.contains(path.to_string_lossy().as_ref()));
            assert!(report.contains("source recovery incomplete"));
            path
        };

        assert_eq!(*recovery_attempts.borrow(), 2);
        assert_eq!(artifacts.borrow().len(), 1);
        assert!(reported_path.exists());
        assert_eq!(fs::read(&reported_path).unwrap(), b"authorized-original");
        assert!(!handoff.exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn identity_bound_trash_restores_exact_source_when_handoff_path_is_swapped() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        let stolen = dir.path().join("stolen.jpg");
        fs::write(&image, b"authorized-original").unwrap();
        let manager = SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let lease =
            manager.lease_image(&session.session_id, &session.images[0].id, Some("main")).unwrap();

        let error = lease
            .trash_with_action(|source| {
                fs::rename(source, &stolen).map_err(|error| error.to_string())?;
                fs::write(source, b"collision-sentinel").map_err(|error| error.to_string())?;
                Err("injected trash failure".into())
            })
            .unwrap_err();
        assert!(error.contains("exact original restored"));
        assert_eq!(fs::read(&image).unwrap(), b"authorized-original");
        let recovered = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(".lightframe-"))
            .collect::<Vec<_>>();
        assert_eq!(recovered.len(), 2, "exact handoff and collision must both survive");
        let exact_handoff = recovered
            .iter()
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".lightframe-isolated-trash-handoff-")
            })
            .expect("preserved exact handoff alias");
        let collision = recovered
            .iter()
            .find(|entry| {
                entry.file_name().to_string_lossy().starts_with(".lightframe-rejected-trash-")
            })
            .expect("preserved canonical-name collision");
        assert_eq!(fs::read(exact_handoff.path()).unwrap(), b"authorized-original");
        assert_eq!(fs::read(collision.path()).unwrap(), b"collision-sentinel");
        assert!(error.contains(&exact_handoff.path().to_string_lossy().to_string()));
        assert!(error.contains(&collision.path().to_string_lossy().to_string()));
    }

    #[cfg(windows)]
    #[test]
    fn identity_bound_trash_rejects_a_decoy_shell_handoff_and_restores_exact_original() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        let stolen = dir.path().join("stolen.jpg");
        fs::write(&image, b"authorized-original").unwrap();
        let manager = SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let lease =
            manager.lease_image(&session.session_id, &session.images[0].id, Some("main")).unwrap();

        let error = lease
            .trash_with_action(|source| {
                fs::rename(source, &stolen).map_err(|error| error.to_string())?;
                fs::write(source, b"attacker-decoy-data").map_err(|error| error.to_string())?;
                clone_creation_time(&stolen, source);
                Ok(())
            })
            .unwrap_err();
        assert!(error.contains("did not place the exact object"));
        assert!(error.contains("exact original restored"));
        assert_eq!(fs::read(&image).unwrap(), b"authorized-original");
        assert!(!stolen.exists());
        assert!(!fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| { entry.file_name().to_string_lossy().starts_with(".lightframe-") }));
    }

    #[cfg(windows)]
    #[test]
    fn identity_bound_trash_rejects_source_name_swap_without_touching_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        let moved = dir.path().join("moved.jpg");
        fs::write(&image, b"authorized-original").unwrap();
        let manager = SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let lease =
            manager.lease_image(&session.session_id, &session.images[0].id, Some("main")).unwrap();
        fs::rename(&image, &moved).unwrap();
        fs::write(&image, b"attacker-decoy-data").unwrap();
        clone_creation_time(&moved, &image);

        assert!(lease.trash_with_action(|_| Ok(())).is_err());
        assert_eq!(fs::read(&image).unwrap(), b"attacker-decoy-data");
        assert_eq!(fs::read(&moved).unwrap(), b"authorized-original");
    }

    #[cfg(unix)]
    #[test]
    fn atomic_replacement_rejects_symlinked_prepared_content_without_touching_source() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        let outside = dir.path().join("outside.jpg");
        let replacement = dir.path().join("prepared.jpg");
        fs::write(&image, b"complete-original-image").unwrap();
        fs::write(&outside, b"outside-replacement").unwrap();
        std::os::unix::fs::symlink(&outside, &replacement).unwrap();
        let manager = SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let image_record =
            session.images.iter().find(|record| record.file_name == "photo.jpg").unwrap();
        let lease =
            manager.lease_image(&session.session_id, &image_record.id, Some("main")).unwrap();

        assert!(lease.replace_contents_from(&replacement).is_err());
        assert_eq!(fs::read(&image).unwrap(), b"complete-original-image");
    }

    #[cfg(unix)]
    #[test]
    fn xmp_sidecar_authority_rejects_links_outside_the_session_directory() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        fs::write(&image, b"image").unwrap();
        let secret = outside.path().join("secret.xmp");
        fs::write(&secret, b"outside-secret").unwrap();
        std::os::unix::fs::symlink(&secret, dir.path().join("photo.xmp")).unwrap();
        let manager = SessionManager::new();
        let session = manager.open_folder_session(dir.path(), Some("main")).unwrap();

        let error = match manager.lease_xmp_sidecar(
            &session.session_id,
            &session.images[0].id,
            Some("main"),
        ) {
            Err(error) => error,
            Ok(_) => panic!("linked sidecar unexpectedly received authority"),
        };
        assert!(error.contains("sidecar"));
        assert_eq!(fs::read(&secret).unwrap(), b"outside-secret");
    }

    #[cfg(windows)]
    #[test]
    fn active_image_lease_detects_source_swap_and_preserves_pinned_bytes_on_windows() {
        use std::io::Read;
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("photo.jpg");
        let moved = dir.path().join("moved.jpg");
        fs::write(&image, b"leased-image").unwrap();
        let manager = SessionManager::new();
        let snapshot = manager.open_folder_session(dir.path(), Some("main")).unwrap();
        let lease = manager
            .lease_image(&snapshot.session_id, &snapshot.images[0].id, Some("main"))
            .unwrap();

        fs::rename(&image, &moved).unwrap();
        fs::write(&image, b"attacker-replacement").unwrap();
        assert!(lease.revalidate().is_err());
        let mut pinned = lease.try_clone_file().unwrap();
        let mut bytes = Vec::new();
        pinned.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"leased-image");
        assert_eq!(fs::read(&image).unwrap(), b"attacker-replacement");
        drop(lease);
        drop(manager);
    }

    #[test]
    fn test_destination_and_editor_grants() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("editor.exe");
        fs::write(&app, b"dummy-exe").unwrap();

        let manager = SessionManager::new();
        let dest_grant = manager.grant_destination(dir.path(), None).unwrap();
        let editor_grant = manager.grant_external_editor(&app, None).unwrap();

        assert!(dest_grant.starts_with("dest_"));
        assert!(editor_grant.starts_with("editor_"));

        assert_eq!(
            manager.resolve_destination_grant(&dest_grant, None).unwrap(),
            SessionManager::canonicalize_path(dir.path()).unwrap()
        );
        assert_eq!(
            manager.resolve_external_editor_grant(&editor_grant, None).unwrap(),
            SessionManager::canonicalize_path(&app).unwrap()
        );
        drop(manager);
    }

    #[test]
    fn test_open_file_session_selects_exact_requested_file_not_first_file() {
        let dir = tempfile::tempdir().unwrap();
        let file_a = dir.path().join("a_first.jpg");
        let file_z = dir.path().join("z_second.jpg");
        fs::write(&file_a, b"jpeg a").unwrap();
        fs::write(&file_z, b"jpeg z").unwrap();

        let manager = SessionManager::new();
        let session = manager.open_file_session(&file_z, None).unwrap();

        let requested =
            session.images.iter().find(|img| img.id == session.requested_image_id).unwrap();

        assert_eq!(
            SessionManager::canonicalize_path(Path::new(&requested.path)).unwrap(),
            SessionManager::canonicalize_path(&file_z).unwrap()
        );
        assert_ne!(requested.file_name, "a_first.jpg");
        assert_eq!(requested.file_name, "z_second.jpg");
    }

    #[test]
    fn test_capabilities_and_asset_scope_isolation() {
        let tauri_conf_path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let content = fs::read_to_string(&tauri_conf_path).expect("Read tauri.conf.json");
        let json: serde_json::Value =
            serde_json::from_str(&content).expect("Parse tauri.conf.json");

        let scope = json["app"]["security"]["assetProtocol"]["scope"]
            .as_array()
            .expect("assetProtocol.scope array");

        let scope_strings: Vec<&str> = scope.iter().filter_map(|v| v.as_str()).collect();

        // 1. Ensure global wildcard "**" is completely removed
        assert!(
            !scope_strings.contains(&"**"),
            "assetProtocol.scope must not contain broad '**' wildcard"
        );

        // 2. Ensure permitted roots are strictly narrowed
        assert!(scope_strings.contains(&"$APPCACHE/previews/**/*"));
        assert!(scope_strings.contains(&"$APPCACHE/thumbnails/**/*"));
        assert!(scope_strings.contains(&"$APPCACHE/tiles/**/*"));
        assert!(scope_strings.contains(&"$TEMP/lightframe-generated-assets/**/*"));
        assert!(!scope_strings.contains(&"$APPDATA/lightframe/**/*"));

        // 3. Ensure capabilities main.json and projector.json exist
        let capabilities_dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        assert!(capabilities_dir.join("main.json").exists(), "main.json capability must exist");
        assert!(
            capabilities_dir.join("projector.json").exists(),
            "projector.json capability must exist"
        );
        assert!(!capabilities_dir.join("default.json").exists(), "default.json should be removed");
    }

    #[test]
    fn test_path_containment_prevents_prefix_collisions() {
        #[cfg(windows)]
        let (parent, valid_child, invalid_prefix_collision) = (
            Path::new(r"C:\photos"),
            Path::new(r"C:\photos\vacation\img1.jpg"),
            Path::new(r"C:\photos-private\secret.jpg"),
        );
        #[cfg(not(windows))]
        let (parent, valid_child, invalid_prefix_collision) = (
            Path::new("/photos"),
            Path::new("/photos/vacation/img1.jpg"),
            Path::new("/photos-private/secret.jpg"),
        );

        assert!(is_path_contained_in(valid_child, parent));
        assert!(!is_path_contained_in(invalid_prefix_collision, parent));
    }

    #[test]
    fn containment_obeys_explicit_authority_root_case_semantics() {
        use crate::path_normalization::PathCaseSemantics;
        let parent = Path::new("C:/Photos");
        let differently_cased_child = Path::new("c:/photos/A.jpg");
        assert!(is_path_contained_in_with_semantics(
            differently_cased_child,
            parent,
            PathCaseSemantics::Insensitive,
        ));
        assert!(!is_path_contained_in_with_semantics(
            differently_cased_child,
            parent,
            PathCaseSemantics::Sensitive,
        ));
    }

    #[test]
    fn session_snapshot_reports_pinned_directory_case_semantics() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("photo.jpg"), b"bytes").unwrap();
        let pinned = open_pinned_directory(dir.path()).unwrap();
        let expected = crate::path_normalization::directory_path_case_semantics(&pinned).unwrap();
        let snapshot = SessionManager::new().open_folder_session(dir.path(), Some("main")).unwrap();
        assert_eq!(snapshot.path_case_semantics, expected);
    }

    #[test]
    fn test_canonicalization_fails_closed_on_nonexistent_paths() {
        let fake_path = Path::new(r"Z:\nonexistent_directory_12345\fake_file.jpg");
        assert!(SessionManager::canonicalize_path(fake_path).is_err());
    }
}
