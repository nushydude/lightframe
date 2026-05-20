#[cfg(windows)]
mod imp {
    use std::collections::HashSet;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::ptr::null_mut;
    use std::thread;

    use windows::core::{Interface, PCWSTR};
    use windows::Win32::Foundation::{RPC_E_CHANGED_MODE, S_FALSE, S_OK};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, STGM_READWRITE,
    };
    use windows::Win32::UI::Shell::{
        IShellLinkW, SHChangeNotify, ShellLink, SHCNE_ASSOCCHANGED, SHCNF_IDLIST,
    };

    const SHORTCUT_NAME: &str = "LightFrame.lnk";
    const APP_EXE_NAME: &str = "lightframe.exe";

    pub fn repair_lightframe_shortcuts_async() {
        thread::spawn(|| {
            if let Err(error) = repair_lightframe_shortcuts() {
                eprintln!("Warning: failed to repair LightFrame shortcut icons: {}", error);
            }
        });
    }

    fn repair_lightframe_shortcuts() -> Result<(), String> {
        let exe_path = std::env::current_exe()
            .map_err(|error| format!("failed to resolve current executable: {}", error))?;
        let shortcuts = lightframe_shortcut_candidates();
        if shortcuts.is_empty() {
            return Ok(());
        }

        let _com = ComApartment::new()?;
        let mut repaired = 0usize;
        let mut failures = Vec::new();

        for shortcut_path in shortcuts {
            match repair_shortcut_icon(&shortcut_path, &exe_path) {
                Ok(true) => repaired += 1,
                Ok(false) => {}
                Err(error) => failures.push(format!("{}: {}", shortcut_path.display(), error)),
            }
        }

        if repaired > 0 {
            eprintln!("Repaired {} LightFrame shortcut icon reference(s).", repaired);
            notify_shell_icon_cache_changed();
        }
        if !failures.is_empty() {
            eprintln!("Warning: some LightFrame shortcut icons could not be repaired:");
            for failure in failures {
                eprintln!("  {}", failure);
            }
        }

        Ok(())
    }

    fn lightframe_shortcut_candidates() -> Vec<PathBuf> {
        let mut candidates = Vec::new();

        if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
            candidates.push(
                appdata
                    .join("Microsoft")
                    .join("Internet Explorer")
                    .join("Quick Launch")
                    .join("User Pinned")
                    .join("TaskBar")
                    .join(SHORTCUT_NAME),
            );
            candidates.push(
                appdata
                    .join("Microsoft")
                    .join("Windows")
                    .join("Start Menu")
                    .join("Programs")
                    .join(SHORTCUT_NAME),
            );
            candidates.push(
                appdata
                    .join("Microsoft")
                    .join("Windows")
                    .join("Start Menu")
                    .join("Programs")
                    .join("LightFrame")
                    .join(SHORTCUT_NAME),
            );
        }

        if let Some(program_data) = std::env::var_os("PROGRAMDATA").map(PathBuf::from) {
            candidates.push(
                program_data
                    .join("Microsoft")
                    .join("Windows")
                    .join("Start Menu")
                    .join("Programs")
                    .join(SHORTCUT_NAME),
            );
            candidates.push(
                program_data
                    .join("Microsoft")
                    .join("Windows")
                    .join("Start Menu")
                    .join("Programs")
                    .join("LightFrame")
                    .join(SHORTCUT_NAME),
            );
        }

        dedupe_existing_paths(candidates)
    }

    fn dedupe_existing_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
        let mut seen = HashSet::new();
        paths
            .into_iter()
            .filter(|path| path.is_file())
            .filter(|path| seen.insert(path.to_string_lossy().to_ascii_lowercase()))
            .collect()
    }

    fn repair_shortcut_icon(shortcut_path: &Path, exe_path: &Path) -> Result<bool, String> {
        let shell_link: IShellLinkW =
            unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }
                .map_err(|error| format!("failed to create shell link COM object: {}", error))?;
        let persist_file: IPersistFile = shell_link
            .cast()
            .map_err(|error| format!("failed to access shortcut file: {}", error))?;

        let shortcut_wide = path_to_wide(shortcut_path);
        unsafe {
            persist_file
                .Load(PCWSTR(shortcut_wide.as_ptr()), STGM_READWRITE)
                .map_err(|error| format!("failed to load shortcut: {}", error))?;
        }

        let target_path = get_shortcut_target_path(&shell_link)
            .map_err(|error| format!("failed to read shortcut target: {}", error))?;
        if !shortcut_targets_current_exe(&target_path, exe_path) {
            return Ok(false);
        }

        let icon_location = get_shortcut_icon_location(&shell_link)
            .map_err(|error| format!("failed to read shortcut icon: {}", error))?;
        if !should_repair_icon_location(&icon_location.path, icon_location.index, exe_path) {
            return Ok(false);
        }

        let exe_wide = path_to_wide(exe_path);
        unsafe {
            shell_link
                .SetIconLocation(PCWSTR(exe_wide.as_ptr()), 0)
                .map_err(|error| format!("failed to set shortcut icon: {}", error))?;
            persist_file
                .Save(PCWSTR(shortcut_wide.as_ptr()), true)
                .map_err(|error| format!("failed to save shortcut: {}", error))?;
        }

        Ok(true)
    }

    fn get_shortcut_target_path(shell_link: &IShellLinkW) -> windows::core::Result<PathBuf> {
        let mut buffer = vec![0u16; 32_768];
        unsafe {
            shell_link.GetPath(&mut buffer, null_mut(), 0)?;
        }
        Ok(PathBuf::from(wide_buffer_to_string(&buffer)))
    }

    struct ShortcutIconLocation {
        path: String,
        index: i32,
    }

    fn get_shortcut_icon_location(
        shell_link: &IShellLinkW,
    ) -> windows::core::Result<ShortcutIconLocation> {
        let mut buffer = vec![0u16; 32_768];
        let mut index = 0i32;
        unsafe {
            shell_link.GetIconLocation(&mut buffer, &mut index)?;
        }
        Ok(ShortcutIconLocation { path: wide_buffer_to_string(&buffer), index })
    }

    fn shortcut_targets_current_exe(target_path: &Path, exe_path: &Path) -> bool {
        if target_path
            .file_name()
            .and_then(|file_name| file_name.to_str())
            .is_none_or(|file_name| !file_name.eq_ignore_ascii_case(APP_EXE_NAME))
        {
            return false;
        }

        paths_match(target_path, exe_path)
    }

    fn paths_match(left: &Path, right: &Path) -> bool {
        if let (Ok(left), Ok(right)) = (left.canonicalize(), right.canonicalize()) {
            return left == right;
        }

        normalize_path_for_compare(left) == normalize_path_for_compare(right)
    }

    fn should_repair_icon_location(icon_path: &str, icon_index: i32, exe_path: &Path) -> bool {
        let trimmed_icon_path = icon_path.trim();
        if trimmed_icon_path.is_empty() {
            return true;
        }

        let icon_path = Path::new(trimmed_icon_path);
        if icon_index == 0 && paths_match(icon_path, exe_path) {
            return false;
        }

        let normalized_icon_path = normalize_path_for_compare(icon_path);
        normalized_icon_path.contains(r"\windows\installer\")
            || normalized_icon_path.ends_with(r"\windows\installer\producticon")
            || !icon_path.exists()
    }

    fn notify_shell_icon_cache_changed() {
        unsafe {
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
        }
    }

    fn normalize_path_for_compare(path: &Path) -> String {
        path.to_string_lossy().replace('/', "\\").to_ascii_lowercase()
    }

    fn path_to_wide(path: &Path) -> Vec<u16> {
        os_str_to_wide(path.as_os_str())
    }

    fn os_str_to_wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn wide_buffer_to_string(buffer: &[u16]) -> String {
        let end = buffer.iter().position(|value| *value == 0).unwrap_or(buffer.len());
        String::from_utf16_lossy(&buffer[..end])
    }

    struct ComApartment {
        should_uninitialize: bool,
    }

    impl ComApartment {
        fn new() -> Result<Self, String> {
            let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            match result {
                S_OK | S_FALSE => Ok(Self { should_uninitialize: true }),
                RPC_E_CHANGED_MODE => {
                    Err("COM was already initialized with an incompatible threading model"
                        .to_string())
                }
                error => Err(windows::core::Error::from(error).message().to_string()),
            }
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            if self.should_uninitialize {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use tempfile::tempdir;

        #[test]
        fn stale_installer_cache_icon_is_repaired() {
            let dir = tempdir().unwrap();
            let exe_path = dir.path().join(APP_EXE_NAME);
            std::fs::write(&exe_path, b"exe").unwrap();

            assert!(should_repair_icon_location(
                r"C:\Windows\Installer\{OLD-PRODUCT-CODE}\ProductIcon",
                0,
                &exe_path
            ));
        }

        #[test]
        fn missing_icon_location_is_repaired() {
            let exe_path = PathBuf::from(r"C:\Program Files\LightFrame\lightframe.exe");

            assert!(should_repair_icon_location("", 0, &exe_path));
        }

        #[test]
        fn current_exe_icon_is_left_alone() {
            let dir = tempdir().unwrap();
            let exe_path = dir.path().join(APP_EXE_NAME);
            std::fs::write(&exe_path, b"exe").unwrap();

            assert!(!should_repair_icon_location(&exe_path.to_string_lossy(), 0, &exe_path));
        }

        #[test]
        fn valid_custom_icon_is_left_alone() {
            let dir = tempdir().unwrap();
            let exe_path = dir.path().join(APP_EXE_NAME);
            let icon_path = dir.path().join("custom.ico");
            std::fs::write(&exe_path, b"exe").unwrap();
            std::fs::write(&icon_path, b"icon").unwrap();

            assert!(!should_repair_icon_location(&icon_path.to_string_lossy(), 0, &exe_path));
        }

        #[test]
        fn shortcut_target_must_match_current_exe() {
            let dir = tempdir().unwrap();
            let exe_path = dir.path().join(APP_EXE_NAME);
            let other_path = dir.path().join("other.exe");
            std::fs::write(&exe_path, b"exe").unwrap();
            std::fs::write(&other_path, b"exe").unwrap();

            assert!(shortcut_targets_current_exe(&exe_path, &exe_path));
            assert!(!shortcut_targets_current_exe(&other_path, &exe_path));
        }

        #[test]
        fn repair_shortcut_icon_updates_stale_shell_link_icon() {
            let _com = ComApartment::new().unwrap();
            let dir = tempdir().unwrap();
            let exe_path = dir.path().join(APP_EXE_NAME);
            let shortcut_path = dir.path().join(SHORTCUT_NAME);
            let stale_icon_path =
                PathBuf::from(r"C:\Windows\Installer\{OLD-PRODUCT-CODE}\ProductIcon");
            std::fs::write(&exe_path, b"exe").unwrap();

            let shell_link: IShellLinkW =
                unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }.unwrap();
            let persist_file: IPersistFile = shell_link.cast().unwrap();
            let exe_wide = path_to_wide(&exe_path);
            let stale_icon_wide = path_to_wide(&stale_icon_path);
            let shortcut_wide = path_to_wide(&shortcut_path);
            unsafe {
                shell_link.SetPath(PCWSTR(exe_wide.as_ptr())).unwrap();
                shell_link.SetIconLocation(PCWSTR(stale_icon_wide.as_ptr()), 0).unwrap();
                persist_file.Save(PCWSTR(shortcut_wide.as_ptr()), true).unwrap();
            }

            assert!(repair_shortcut_icon(&shortcut_path, &exe_path).unwrap());

            let repaired_shell_link: IShellLinkW =
                unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }.unwrap();
            let repaired_persist_file: IPersistFile = repaired_shell_link.cast().unwrap();
            unsafe {
                repaired_persist_file.Load(PCWSTR(shortcut_wide.as_ptr()), STGM_READWRITE).unwrap();
            }
            let repaired_icon = get_shortcut_icon_location(&repaired_shell_link).unwrap();

            assert_eq!(repaired_icon.index, 0);
            assert!(paths_match(Path::new(&repaired_icon.path), &exe_path));
        }
    }
}

#[cfg(windows)]
pub use imp::repair_lightframe_shortcuts_async;

#[cfg(not(windows))]
pub fn repair_lightframe_shortcuts_async() {}
