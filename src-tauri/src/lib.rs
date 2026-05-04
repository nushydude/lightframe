use tauri::Emitter;
use tauri_plugin_cli::CliExt;

mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_cli::init())
        .setup(|app| {
            // Handle CLI arguments for file association
            if let Ok(matches) = app.cli().matches() {
                if let Some(arg) = matches.args.get("file") {
                    if let serde_json::Value::String(path) = &arg.value {
                        if !path.is_empty() {
                            let path = path.clone();
                            let handle = app.handle().clone();
                            // Emit event after window is ready
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_millis(500));
                                let _ = handle.emit("open-file", path);
                            });
                        }
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::is_dir,
            commands::scan_folder,
            commands::get_image_metadata,
            commands::read_settings,
            commands::write_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
