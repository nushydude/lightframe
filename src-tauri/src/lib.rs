mod atomic_file;
mod commands;
mod curation;
mod display_inhibition;
mod folder_index;
mod folder_watcher;
mod native_codecs;
mod path_normalization;
mod thumbnails;
mod update_channels;
mod windows_jump_list;
mod windows_shortcuts;

use tauri::{Manager, State};

#[tauri::command]
fn acquire_slideshow_display_inhibition(
    inhibition: State<'_, display_inhibition::DisplayInhibition>,
) -> Result<(), String> {
    inhibition.inner().acquire()
}

#[tauri::command]
fn release_slideshow_display_inhibition(
    inhibition: State<'_, display_inhibition::DisplayInhibition>,
) -> Result<(), String> {
    inhibition.inner().release()
}

#[tauri::command]
async fn update_recent_folders_jump_list(
    recent_folders: Vec<commands::RecentFolder>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        windows_jump_list::update_recent_folders_jump_list(recent_folders)
    })
    .await
    .map_err(|error| format!("Recent folders Jump List worker failed: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_process::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .manage(display_inhibition::DisplayInhibition::default())
        .setup(|_| {
            windows_shortcuts::repair_lightframe_shortcuts_async();
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(inhibition) =
                    window.app_handle().try_state::<display_inhibition::DisplayInhibition>()
                {
                    let _ = inhibition.inner().release();
                }
                folder_watcher::unwatch_active_folder();
                if let Some(projector_window) = window.app_handle().get_webview_window("secondary")
                {
                    let _ = projector_window.close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::is_dir,
            commands::scan_folder,
            folder_watcher::watch_folder,
            folder_watcher::unwatch_folder,
            commands::read_folder_index,
            commands::refresh_folder_index,
            commands::get_image_metadata,
            commands::get_image_caption,
            commands::get_codec_health,
            commands::clear_generated_image_cache,
            commands::retry_native_codecs,
            commands::get_preview_image,
            commands::get_image_tile,
            commands::read_settings,
            commands::write_settings,
            update_channels::check_update_channel,
            commands::save_diagnostics_snapshot,
            commands::read_curation_metadata,
            commands::write_image_curation,
            commands::write_image_curation_batch,
            commands::clear_image_curation,
            commands::move_to_trash,
            commands::copy_image_to_folder,
            commands::move_image_to_folder,
            commands::transfer_images_to_folder,
            commands::copy_image_to_clipboard,
            commands::open_in_external_application,
            commands::get_exif_metadata,
            commands::save_rotated_image,
            commands::save_cropped_copy,
            commands::save_scaled_copy,
            commands::overwrite_with_crop,
            commands::get_thumbnail,
            acquire_slideshow_display_inhibition,
            release_slideshow_display_inhibition,
            update_recent_folders_jump_list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
