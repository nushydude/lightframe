mod commands;
mod thumbnails;

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
        .invoke_handler(tauri::generate_handler![
            commands::is_dir,
            commands::scan_folder,
            commands::get_image_metadata,
            commands::get_preview_image,
            commands::read_settings,
            commands::write_settings,
            commands::move_to_trash,
            commands::copy_image_to_clipboard,
            commands::get_exif_metadata,
            commands::save_rotated_image,
            commands::get_thumbnail,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
