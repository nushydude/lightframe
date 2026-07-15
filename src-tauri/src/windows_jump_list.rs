use crate::commands::RecentFolder;

#[cfg(windows)]
mod imp {
    use super::RecentFolder;
    use std::collections::HashSet;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows::core::{Interface, PCWSTR};
    use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink,
    };

    const APP_USER_MODEL_ID: &str = "com.lightframe.app";
    const CATEGORY_NAME: &str = "Recent Folders";
    const FOLDER_ARGUMENT: &str = "--folder";

    pub fn update_recent_folders_jump_list(
        recent_folders: Vec<RecentFolder>,
    ) -> Result<Vec<String>, String> {
        let _com = ComApartment::new()?;
        let executable_path = std::env::current_exe()
            .map_err(|error| format!("failed to resolve LightFrame executable: {error}"))?;
        let destination_list: ICustomDestinationList =
            unsafe { CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER) }
                .map_err(|error| format!("failed to create Windows Jump List: {error}"))?;

        let app_id = wide_string(APP_USER_MODEL_ID);
        unsafe {
            destination_list
                .SetAppID(PCWSTR(app_id.as_ptr()))
                .map_err(|error| format!("failed to set Jump List application ID: {error}"))?;
        }

        let mut minimum_slots = 0;
        let removed_destinations: IObjectArray =
            unsafe { destination_list.BeginList(&mut minimum_slots) }
                .map_err(|error| format!("failed to begin Windows Jump List update: {error}"))?;
        let removed_paths = removed_folder_paths(&removed_destinations)?;
        let removed_keys: HashSet<String> =
            removed_paths.iter().map(|path| normalize_path(path)).collect();

        let collection: IObjectCollection =
            unsafe { CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER) }
                .map_err(|error| format!("failed to create Jump List item collection: {error}"))?;
        let mut added_count = 0;

        for folder in recent_folders {
            if !Path::new(&folder.path).is_dir()
                || removed_keys.contains(&normalize_path(&folder.path))
            {
                continue;
            }

            let shell_link: IShellLinkW =
                unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }
                    .map_err(|error| format!("failed to create Jump List folder link: {error}"))?;
            let executable_wide = wide_string(executable_path.as_os_str());
            let arguments_wide = wide_string(format!(
                "{FOLDER_ARGUMENT} {}",
                quote_windows_command_line_argument(&folder.path)
            ));
            let label_wide = wide_string(&folder.label);
            let title = PROPVARIANT::from(folder.label.as_str());

            unsafe {
                shell_link
                    .SetPath(PCWSTR(executable_wide.as_ptr()))
                    .map_err(|error| format!("failed to set Jump List link target: {error}"))?;
                shell_link
                    .SetArguments(PCWSTR(arguments_wide.as_ptr()))
                    .map_err(|error| format!("failed to set Jump List folder argument: {error}"))?;
                shell_link
                    .SetDescription(PCWSTR(label_wide.as_ptr()))
                    .map_err(|error| format!("failed to set Jump List folder label: {error}"))?;
                shell_link
                    .SetIconLocation(PCWSTR(executable_wide.as_ptr()), 0)
                    .map_err(|error| format!("failed to set Jump List folder icon: {error}"))?;
                let property_store: IPropertyStore = shell_link.cast().map_err(|error| {
                    format!("failed to open Jump List folder properties: {error}")
                })?;
                property_store
                    .SetValue(&PKEY_Title, &title)
                    .map_err(|error| format!("failed to set Jump List folder title: {error}"))?;
                property_store.Commit().map_err(|error| {
                    format!("failed to commit Jump List folder properties: {error}")
                })?;
                let shell_link_unknown: windows::core::IUnknown = shell_link
                    .cast()
                    .map_err(|error| format!("failed to cast Jump List folder link: {error}"))?;
                collection
                    .AddObject(&shell_link_unknown)
                    .map_err(|error| format!("failed to add folder to Jump List: {error}"))?;
            }
            added_count += 1;
        }

        unsafe {
            if added_count > 0 {
                destination_list
                    .AppendCategory(PCWSTR(wide_string(CATEGORY_NAME).as_ptr()), &collection)
                    .map_err(|error| {
                        format!("failed to append Recent Folders Jump List category: {error}")
                    })?;
            }
            destination_list
                .CommitList()
                .map_err(|error| format!("failed to commit Windows Jump List: {error}"))?;
        }

        Ok(removed_paths)
    }

    fn removed_folder_paths(removed_destinations: &IObjectArray) -> Result<Vec<String>, String> {
        let count = unsafe { removed_destinations.GetCount() }
            .map_err(|error| format!("failed to inspect removed Jump List items: {error}"))?;
        let mut paths = Vec::new();

        for index in 0..count {
            let removed_object: windows::core::IUnknown =
                unsafe { removed_destinations.GetAt(index) }
                    .map_err(|error| format!("failed to read removed Jump List item: {error}"))?;
            let shell_link: IShellLinkW = match removed_object.cast() {
                Ok(shell_link) => shell_link,
                Err(_) => continue,
            };
            let mut arguments = vec![0u16; 32_768];
            unsafe {
                shell_link
                    .GetArguments(&mut arguments)
                    .map_err(|error| format!("failed to read removed folder argument: {error}"))?;
            }
            if let Some(path) = parse_folder_argument(&wide_buffer_to_string(&arguments)) {
                paths.push(path);
            }
        }

        Ok(paths)
    }

    fn parse_folder_argument(arguments: &str) -> Option<String> {
        let prefix = format!("{FOLDER_ARGUMENT} ");
        let value = arguments.strip_prefix(&prefix)?.trim_start();
        let value = value.strip_prefix('"')?;
        let mut backslash_count = 0;

        for (index, character) in value.char_indices() {
            if character == '\\' {
                backslash_count += 1;
                continue;
            }

            if character == '"' && backslash_count % 2 == 0 {
                let quoted_path = &value[..index];
                let trailing_backslashes =
                    quoted_path.chars().rev().take_while(|character| *character == '\\').count();
                let prefix_length = quoted_path.len() - trailing_backslashes;
                let mut path = quoted_path[..prefix_length].to_string();
                path.extend(std::iter::repeat_n('\\', trailing_backslashes / 2));
                return (!path.is_empty()).then_some(path);
            }

            backslash_count = 0;
        }

        None
    }

    fn quote_windows_command_line_argument(value: &str) -> String {
        let mut quoted = String::with_capacity(value.len() + 2);
        let mut backslash_count = 0;
        quoted.push('"');

        for character in value.chars() {
            if character == '\\' {
                backslash_count += 1;
                continue;
            }

            if character == '"' {
                quoted.extend(std::iter::repeat_n('\\', backslash_count * 2 + 1));
                quoted.push('"');
            } else {
                quoted.extend(std::iter::repeat_n('\\', backslash_count));
                quoted.push(character);
            }
            backslash_count = 0;
        }

        quoted.extend(std::iter::repeat_n('\\', backslash_count * 2));
        quoted.push('"');
        quoted
    }

    fn normalize_path(path: &str) -> String {
        path.replace('/', "\\").to_ascii_lowercase()
    }

    fn wide_string<T: AsRef<OsStr>>(value: T) -> Vec<u16> {
        value.as_ref().encode_wide().chain(std::iter::once(0)).collect()
    }

    fn wide_buffer_to_string(buffer: &[u16]) -> String {
        let end = buffer.iter().position(|value| *value == 0).unwrap_or(buffer.len());
        String::from_utf16_lossy(&buffer[..end])
    }

    struct ComApartment;

    impl ComApartment {
        fn new() -> Result<Self, String> {
            let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            if result.is_ok() {
                Ok(Self)
            } else {
                Err(format!("failed to initialize COM for Jump List: {result}"))
            }
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn parses_folder_jump_list_argument() {
            assert_eq!(
                parse_folder_argument(r#"--folder "C:\Images\Summer""#),
                Some(r"C:\Images\Summer".to_string())
            );
        }

        #[test]
        fn quotes_drive_root_without_escaping_the_closing_quote() {
            let arguments = format!("--folder {}", quote_windows_command_line_argument(r#"C:\"#));

            assert_eq!(arguments, format!("--folder \"C:{}\"", r"\\"));
            assert_eq!(parse_folder_argument(&arguments), Some(r#"C:\"#.to_string()));
        }

        #[test]
        fn preserves_trailing_separators_when_quoting_and_parsing() {
            for path in [r#"C:\Images\"#, r#"C:\Images\\"#] {
                let arguments = format!("--folder {}", quote_windows_command_line_argument(path));
                assert_eq!(parse_folder_argument(&arguments), Some(path.to_string()));
            }
        }

        #[test]
        fn ignores_non_folder_jump_list_arguments() {
            assert_eq!(parse_folder_argument("--file photo.jpg"), None);
        }

        #[test]
        fn normalizes_windows_path_case_and_slashes() {
            assert_eq!(normalize_path("C:/Images"), normalize_path(r"c:\images"));
        }
    }
}

#[cfg(windows)]
pub fn update_recent_folders_jump_list(
    recent_folders: Vec<RecentFolder>,
) -> Result<Vec<String>, String> {
    imp::update_recent_folders_jump_list(recent_folders)
}

#[cfg(not(windows))]
pub fn update_recent_folders_jump_list(
    _recent_folders: Vec<RecentFolder>,
) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}
