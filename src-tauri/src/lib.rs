mod commands;
mod folder_index;
mod folder_watcher;
mod native_codecs;
mod path_normalization;
mod thumbnails;
mod update_channels;
mod windows_shortcuts;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_process::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .setup(|_| {
            windows_shortcuts::repair_lightframe_shortcuts_async();
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
