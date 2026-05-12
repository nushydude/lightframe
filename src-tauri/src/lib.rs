mod commands;
mod thumbnails;

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
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(projector_window) = window.app_handle().get_webview_window("secondary")
                {
                    let _ = projector_window.close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::is_dir,
            commands::scan_folder,
            commands::get_image_metadata,
            commands::get_preview_image,
            commands::read_settings,
            commands::write_settings,
            commands::read_curation_metadata,
            commands::write_image_curation,
            commands::clear_image_curation,
            commands::move_to_trash,
            commands::copy_image_to_folder,
            commands::move_image_to_folder,
            commands::copy_image_to_clipboard,
            commands::open_in_external_application,
            commands::get_exif_metadata,
            commands::save_rotated_image,
            commands::save_cropped_copy,
            commands::overwrite_with_crop,
            commands::get_thumbnail,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
