mod atomic_file;
pub mod authority;
mod commands;
mod curation;
mod display_inhibition;
mod folder_index;
mod folder_watcher;
mod generated_cache_maintenance;
mod image_metadata;
pub mod image_resource_policy;
pub mod media_executor;
mod native_codecs;
mod path_normalization;
mod thumbnails;
mod update_channels;
mod windows_jump_list;
mod windows_shortcuts;

use tauri::{Emitter, Manager, State};

const ASSET_MAX_RESPONSE_BYTES: usize = 512 * 1024 * 1024;
const ASSET_MAX_AGGREGATE_RESPONSE_BYTES: usize = 640 * 1024 * 1024;
const ASSET_MAX_LIVE_DELIVERIES: usize = 128;
const ASSET_MAX_LIVE_RESPONSES: usize = 512;
const ASSET_DELIVERY_TTL: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommandPolicy {
    MainOnly,
    ProjectorParticipant,
    AuthorizedMediaReader,
    SecondaryOnly,
}

// Security-review inventory for the exact invoke surface. A source-contract test below keeps this
// registry in lockstep with generate_handler!, while each command still enforces the named policy
// at its handler boundary.
const REGISTERED_COMMANDS: &[(&str, CommandPolicy)] = &[
    ("consume_startup_session", CommandPolicy::MainOnly),
    ("open_recent_folder_session", CommandPolicy::MainOnly),
    ("create_asset_delivery", CommandPolicy::ProjectorParticipant),
    ("acknowledge_asset_delivery_responses", CommandPolicy::ProjectorParticipant),
    ("release_asset_delivery", CommandPolicy::ProjectorParticipant),
    ("select_folder_session", CommandPolicy::MainOnly),
    ("select_file_session", CommandPolicy::MainOnly),
    ("close_folder_session", CommandPolicy::MainOnly),
    ("select_destination", CommandPolicy::MainOnly),
    ("select_destination_folder", CommandPolicy::MainOnly),
    ("select_external_editor", CommandPolicy::MainOnly),
    ("emit_projector_sync_by_id", CommandPolicy::ProjectorParticipant),
    ("clear_projector_sync", CommandPolicy::MainOnly),
    ("request_projector_sync", CommandPolicy::SecondaryOnly),
    ("close_projector_grant", CommandPolicy::SecondaryOnly),
    ("cancel_media_request", CommandPolicy::ProjectorParticipant),
    ("get_media_executor_telemetry", CommandPolicy::MainOnly),
    ("get_preview_image_by_id", CommandPolicy::AuthorizedMediaReader),
    ("get_thumbnail_by_id", CommandPolicy::AuthorizedMediaReader),
    ("get_image_metadata_by_id", CommandPolicy::AuthorizedMediaReader),
    ("get_image_tile_by_id", CommandPolicy::AuthorizedMediaReader),
    ("read_folder_index_by_session", CommandPolicy::MainOnly),
    ("watch_folder_by_session", CommandPolicy::MainOnly),
    ("unwatch_folder_by_session", CommandPolicy::MainOnly),
    ("get_image_caption_by_id", CommandPolicy::MainOnly),
    ("is_dir_by_grant", CommandPolicy::MainOnly),
    ("get_codec_health", CommandPolicy::MainOnly),
    ("clear_generated_image_cache", CommandPolicy::MainOnly),
    ("retry_native_codecs", CommandPolicy::MainOnly),
    ("read_settings", CommandPolicy::MainOnly),
    ("read_projector_settings", CommandPolicy::SecondaryOnly),
    ("write_settings", CommandPolicy::MainOnly),
    ("check_update_channel", CommandPolicy::MainOnly),
    ("save_diagnostics_snapshot", CommandPolicy::MainOnly),
    ("read_curation_metadata_by_id", CommandPolicy::MainOnly),
    ("read_curation_metadata_for_ids", CommandPolicy::MainOnly),
    ("write_image_curation_by_id", CommandPolicy::MainOnly),
    ("write_image_curation_batch_by_id", CommandPolicy::MainOnly),
    ("clear_image_curation_by_id", CommandPolicy::MainOnly),
    ("trash_image_by_id", CommandPolicy::MainOnly),
    ("copy_image_by_id", CommandPolicy::MainOnly),
    ("move_image_by_id", CommandPolicy::MainOnly),
    ("transfer_images_by_id", CommandPolicy::MainOnly),
    ("copy_image_by_id_to_clipboard", CommandPolicy::MainOnly),
    ("reveal_image_by_id", CommandPolicy::MainOnly),
    ("launch_external_editor_by_id", CommandPolicy::MainOnly),
    ("get_exif_metadata_by_id", CommandPolicy::MainOnly),
    ("rotate_image_by_id", CommandPolicy::MainOnly),
    ("save_cropped_copy_by_id", CommandPolicy::MainOnly),
    ("save_scaled_copy_by_id", CommandPolicy::MainOnly),
    ("overwrite_with_crop_by_id", CommandPolicy::MainOnly),
    ("read_projector_display_record", CommandPolicy::SecondaryOnly),
    ("navigate_projector_image", CommandPolicy::SecondaryOnly),
    ("acquire_slideshow_display_inhibition", CommandPolicy::MainOnly),
    ("release_slideshow_display_inhibition", CommandPolicy::MainOnly),
    ("update_recent_folders_jump_list", CommandPolicy::MainOnly),
];

struct AssetDeliveryBudget {
    live_deliveries:
        std::sync::Mutex<std::collections::HashMap<(String, String), AssetDeliveryReservation>>,
    max_response_bytes: usize,
    max_aggregate_bytes: usize,
}

struct AssetDeliveryReservation {
    session_id: String,
    image_id: String,
    bytes: usize,
    responses: std::collections::HashMap<String, AssetResponseReservation>,
    expires_at: std::time::Instant,
    closed: bool,
    owner_destroyed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AssetResponseState {
    Active,
    Committed,
}

struct AssetResponseReservation {
    bytes: usize,
    state: AssetResponseState,
    acknowledged: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetDeliveryClose {
    closed: bool,
    response_ids: Vec<String>,
}

impl Default for AssetDeliveryBudget {
    fn default() -> Self {
        Self {
            live_deliveries: std::sync::Mutex::new(std::collections::HashMap::new()),
            max_response_bytes: ASSET_MAX_RESPONSE_BYTES,
            max_aggregate_bytes: ASSET_MAX_AGGREGATE_RESPONSE_BYTES,
        }
    }
}

struct AssetDeliveryPermit<'a> {
    budget: &'a AssetDeliveryBudget,
    owner: String,
    delivery_id: String,
    response_id: String,
    tracked: bool,
    committed: bool,
}

impl AssetDeliveryBudget {
    fn create_delivery(
        &self,
        owner: &str,
        session_id: &str,
        image_id: &str,
    ) -> Result<String, u16> {
        let mut deliveries = self.live_deliveries.lock().unwrap();
        Self::sweep_expired_pending_locked(&mut deliveries, std::time::Instant::now());
        if deliveries.len() >= ASSET_MAX_LIVE_DELIVERIES {
            return Err(503);
        }
        let delivery_id = format!("delivery_{}", uuid::Uuid::new_v4().simple());
        deliveries.insert(
            (owner.to_string(), delivery_id.clone()),
            AssetDeliveryReservation {
                session_id: session_id.to_string(),
                image_id: image_id.to_string(),
                bytes: 0,
                responses: std::collections::HashMap::new(),
                expires_at: std::time::Instant::now() + ASSET_DELIVERY_TTL,
                closed: false,
                owner_destroyed: false,
            },
        );
        Ok(delivery_id)
    }

    fn try_admit(
        &self,
        owner: &str,
        delivery_id: &str,
        session_id: &str,
        image_id: &str,
        bytes: usize,
    ) -> Result<AssetDeliveryPermit<'_>, u16> {
        if delivery_id.len() < 16
            || delivery_id.len() > 96
            || !delivery_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(400);
        }
        if bytes > self.max_response_bytes {
            return Err(413);
        }
        let mut deliveries = self.live_deliveries.lock().unwrap();
        Self::sweep_expired_pending_locked(&mut deliveries, std::time::Instant::now());
        let key = (owner.to_string(), delivery_id.to_string());
        let Some(existing) = deliveries.get(&key) else {
            return Err(403);
        };
        if existing.session_id != session_id || existing.image_id != image_id {
            return Err(403);
        }
        if existing.closed {
            return Err(410);
        }
        if bytes == 0 {
            return Ok(AssetDeliveryPermit {
                budget: self,
                owner: owner.to_string(),
                delivery_id: delivery_id.to_string(),
                response_id: format!("response_{}", uuid::Uuid::new_v4().simple()),
                tracked: false,
                committed: false,
            });
        }
        let live_responses: usize = deliveries.values().map(|entry| entry.responses.len()).sum();
        if live_responses >= ASSET_MAX_LIVE_RESPONSES {
            return Err(503);
        }
        let current: usize = deliveries.values().map(|entry| entry.bytes).sum();
        let next = current.checked_add(bytes).ok_or(503u16)?;
        if next > self.max_aggregate_bytes {
            return Err(503);
        }
        let reservation = deliveries.get_mut(&key).expect("delivery disappeared while admitting");
        let response_id = format!("response_{}", uuid::Uuid::new_v4().simple());
        reservation.bytes += bytes;
        reservation.responses.insert(
            response_id.clone(),
            AssetResponseReservation {
                bytes,
                state: AssetResponseState::Active,
                acknowledged: false,
            },
        );
        Ok(AssetDeliveryPermit {
            budget: self,
            owner: owner.to_string(),
            delivery_id: delivery_id.to_string(),
            response_id,
            tracked: true,
            committed: false,
        })
    }

    fn close(&self, owner: &str, delivery_id: &str) -> AssetDeliveryClose {
        let mut deliveries = self.live_deliveries.lock().unwrap();
        Self::sweep_expired_pending_locked(&mut deliveries, std::time::Instant::now());
        let key = (owner.to_string(), delivery_id.to_string());
        let Some(reservation) = deliveries.get_mut(&key) else {
            return AssetDeliveryClose { closed: false, response_ids: Vec::new() };
        };
        reservation.closed = true;
        let mut response_ids = reservation.responses.keys().cloned().collect::<Vec<_>>();
        response_ids.sort();
        if reservation.responses.is_empty() {
            deliveries.remove(&key);
        }
        AssetDeliveryClose { closed: true, response_ids }
    }

    fn abandon_response(&self, owner: &str, delivery_id: &str, response_id: &str) {
        let mut deliveries = self.live_deliveries.lock().unwrap();
        let key = (owner.to_string(), delivery_id.to_string());
        if let Some(reservation) = deliveries.get_mut(&key) {
            if let Some(response) = reservation.responses.remove(response_id) {
                reservation.bytes = reservation.bytes.saturating_sub(response.bytes);
            }
            if reservation.closed && reservation.responses.is_empty() {
                deliveries.remove(&key);
            }
        }
    }

    fn acknowledge_response(&self, owner: &str, delivery_id: &str, response_id: &str) -> bool {
        let mut deliveries = self.live_deliveries.lock().unwrap();
        let key = (owner.to_string(), delivery_id.to_string());
        let Some(reservation) = deliveries.get_mut(&key) else {
            return false;
        };
        let Some(response) = reservation.responses.get_mut(response_id) else {
            return false;
        };
        if response.acknowledged {
            return false;
        }
        response.acknowledged = true;
        if response.state == AssetResponseState::Committed {
            let bytes = response.bytes;
            reservation.responses.remove(response_id);
            reservation.bytes = reservation.bytes.saturating_sub(bytes);
        }
        if reservation.closed && reservation.responses.is_empty() {
            deliveries.remove(&key);
        }
        true
    }

    fn release_owner(&self, owner: &str) {
        let mut deliveries = self.live_deliveries.lock().unwrap();
        for ((label, _), reservation) in deliveries.iter_mut() {
            if label != owner {
                continue;
            }
            reservation.closed = true;
            reservation.owner_destroyed = true;
            let committed_bytes: usize = reservation
                .responses
                .values()
                .filter(|response| response.state == AssetResponseState::Committed)
                .map(|response| response.bytes)
                .sum();
            reservation
                .responses
                .retain(|_, response| response.state == AssetResponseState::Active);
            for response in reservation.responses.values_mut() {
                response.acknowledged = true;
            }
            reservation.bytes = reservation.bytes.saturating_sub(committed_bytes);
        }
        deliveries
            .retain(|(label, _), reservation| label != owner || !reservation.responses.is_empty());
    }

    fn sweep_expired_pending_locked(
        deliveries: &mut std::collections::HashMap<(String, String), AssetDeliveryReservation>,
        now: std::time::Instant,
    ) {
        deliveries.retain(|_, reservation| {
            !reservation.responses.is_empty() || reservation.expires_at > now
        });
    }

    #[cfg(test)]
    fn live_bytes(&self) -> usize {
        self.live_deliveries.lock().unwrap().values().map(|entry| entry.bytes).sum()
    }
}

impl AssetDeliveryPermit<'_> {
    fn response_id(&self) -> &str {
        &self.response_id
    }

    fn commit(mut self) {
        if self.tracked {
            let mut deliveries = self.budget.live_deliveries.lock().unwrap();
            let key = (self.owner.clone(), self.delivery_id.clone());
            let mut remove = false;
            if let Some(reservation) = deliveries.get_mut(&key) {
                let acknowledged = reservation
                    .responses
                    .get(&self.response_id)
                    .map(|response| response.acknowledged)
                    .unwrap_or(true);
                if reservation.owner_destroyed || acknowledged {
                    if let Some(response) = reservation.responses.remove(&self.response_id) {
                        reservation.bytes = reservation.bytes.saturating_sub(response.bytes);
                    }
                } else if let Some(response) = reservation.responses.get_mut(&self.response_id) {
                    response.state = AssetResponseState::Committed;
                }
                remove = reservation.closed && reservation.responses.is_empty();
            }
            if remove {
                deliveries.remove(&key);
            }
        }
        self.committed = true;
    }
}

impl Drop for AssetDeliveryPermit<'_> {
    fn drop(&mut self) {
        if !self.committed && self.tracked {
            self.budget.abandon_response(&self.owner, &self.delivery_id, &self.response_id);
        }
    }
}

#[tauri::command]
fn create_asset_delivery(
    window: tauri::Window,
    budget: State<'_, AssetDeliveryBudget>,
    session_manager: State<'_, authority::SessionManager>,
    session_id: String,
    image_id: String,
) -> Result<String, String> {
    commands::enforce_projector_participant_label(window.label())?;
    let _lease = session_manager.lease_image(&session_id, &image_id, Some(window.label()))?;
    budget
        .create_delivery(window.label(), &session_id, &image_id)
        .map_err(|status| format!("Asset delivery admission failed with status {status}"))
}

#[tauri::command]
fn release_asset_delivery(
    window: tauri::Window,
    budget: State<'_, AssetDeliveryBudget>,
    delivery_id: String,
) -> Result<AssetDeliveryClose, String> {
    commands::enforce_projector_participant_label(window.label())?;
    Ok(budget.close(window.label(), &delivery_id))
}

#[tauri::command]
fn acknowledge_asset_delivery_responses(
    window: tauri::Window,
    budget: State<'_, AssetDeliveryBudget>,
    delivery_id: String,
    response_id: String,
) -> Result<bool, String> {
    commands::enforce_projector_participant_label(window.label())?;
    Ok(budget.acknowledge_response(window.label(), &delivery_id, &response_id))
}

#[tauri::command]
fn acquire_slideshow_display_inhibition(
    window: tauri::Window,
    inhibition: State<'_, display_inhibition::DisplayInhibition>,
) -> Result<(), String> {
    commands::enforce_main_window(&window)?;
    inhibition.inner().acquire()
}

#[tauri::command]
fn release_slideshow_display_inhibition(
    window: tauri::Window,
    inhibition: State<'_, display_inhibition::DisplayInhibition>,
) -> Result<(), String> {
    commands::enforce_main_window(&window)?;
    inhibition.inner().release()
}

#[tauri::command]
async fn update_recent_folders_jump_list(
    window: tauri::Window,
    app: tauri::AppHandle,
) -> Result<Vec<String>, String> {
    commands::enforce_main_window(&window)?;
    let recent_folders = commands::settings_commands::trusted_recent_folders(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        windows_jump_list::update_recent_folders_jump_list(recent_folders)
    })
    .await
    .map_err(|error| format!("Recent folders Jump List worker failed: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    debug_assert!(!REGISTERED_COMMANDS.is_empty());
    if let Err(error) = windows_jump_list::set_process_app_user_model_id() {
        eprintln!("Warning: failed to set LightFrame AppUserModelID: {error}");
    }

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder = builder.register_uri_scheme_protocol("lightframe-asset", move |ctx, request| {
        let uri = request.uri();
        let session_id = uri.host().unwrap_or_default();
        let image_id = uri.path().trim_start_matches('/');
        let delivery_id = uri
            .query()
            .and_then(|query| query.split('&').find_map(|part| part.strip_prefix("deliveryId=")))
            .unwrap_or_default();

        let session_manager = ctx.app_handle().state::<authority::SessionManager>();

        let resolve_res =
            session_manager.lease_image(session_id, image_id, Some(ctx.webview_label()));

        match resolve_res {
            Ok(lease) => {
                let path = lease.path();
                let mut pinned_file = match lease.try_clone_file() {
                    Ok(file) => file,
                    Err(_) => {
                        return tauri::http::Response::builder().status(409).body(vec![]).unwrap()
                    }
                };
                let metadata = match pinned_file.metadata() {
                    Ok(m) => m,
                    Err(_) => {
                        return tauri::http::Response::builder().status(404).body(vec![]).unwrap()
                    }
                };

                let limits = crate::image_resource_policy::PolicyLimits::for_operation(
                    crate::image_resource_policy::OperationClass::Preview,
                );
                if metadata.len() > limits.max_file_size_bytes {
                    return tauri::http::Response::builder().status(413).body(vec![]).unwrap();
                }

                let mime = match path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.to_lowercase())
                    .as_deref()
                {
                    Some("jpg") | Some("jpeg") => "image/jpeg",
                    Some("png") => "image/png",
                    Some("webp") => "image/webp",
                    Some("gif") => "image/gif",
                    Some("bmp") => "image/bmp",
                    Some("svg") => "image/svg+xml",
                    Some("tiff") | Some("tif") => "image/tiff",
                    Some("avif") => "image/avif",
                    Some("heic") => "image/heic",
                    Some("heif") => "image/heif",
                    _ => "application/octet-stream",
                };

                let file_len = metadata.len();
                let range_header = request.headers().get("Range").and_then(|v| v.to_str().ok());

                let response_plan = match plan_asset_response(range_header, file_len) {
                    Ok(plan) => plan,
                    Err(AssetResponsePlanError::Unsatisfiable) => {
                        return tauri::http::Response::builder()
                            .status(416)
                            .header("Content-Range", format!("bytes */{}", file_len))
                            .body(vec![])
                            .unwrap();
                    }
                    Err(AssetResponsePlanError::Malformed) => {
                        return tauri::http::Response::builder().status(400).body(vec![]).unwrap();
                    }
                };
                let start = response_plan.start;
                let bytes_to_read = response_plan.length;
                let delivery_budget = ctx.app_handle().state::<AssetDeliveryBudget>();
                let delivery_permit = match delivery_budget.try_admit(
                    ctx.webview_label(),
                    delivery_id,
                    session_id,
                    image_id,
                    bytes_to_read,
                ) {
                    Ok(permit) => permit,
                    Err(status) => {
                        return tauri::http::Response::builder()
                            .status(status)
                            .header("Content-Length", "0")
                            .body(vec![])
                            .unwrap();
                    }
                };

                let body_bytes = match read_asset_bytes(&mut pinned_file, start, bytes_to_read) {
                    Ok(bytes) => bytes,
                    Err(_) => {
                        return tauri::http::Response::builder().status(500).body(vec![]).unwrap();
                    }
                };
                if lease.revalidate().is_err() {
                    return tauri::http::Response::builder().status(409).body(vec![]).unwrap();
                }

                let response_id = delivery_permit.response_id().to_string();
                let mut response = build_asset_response(response_plan, mime, body_bytes);
                response.headers_mut().insert(
                    "x-lightframe-response-id",
                    tauri::http::HeaderValue::from_str(&response_id)
                        .expect("generated response identity is an HTTP header value"),
                );
                if response.status().is_success() {
                    delivery_permit.commit();
                }
                response
            }
            Err(_) => tauri::http::Response::builder().status(403).body(vec![]).unwrap(),
        }
    });

    let app = builder
        .manage(display_inhibition::DisplayInhibition::default())
        .manage(AssetDeliveryBudget::default())
        .manage(authority::SessionManager::new())
        .manage(commands::StartupSessionState::default())
        .manage(media_executor::MediaExecutor::default())
        .setup(|_| {
            windows_shortcuts::repair_lightframe_shortcuts_async();
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(delivery_budget) =
                    window.app_handle().try_state::<AssetDeliveryBudget>()
                {
                    delivery_budget.release_owner(window.label());
                }
            }
            if window.label() == "secondary"
                && matches!(
                    event,
                    tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
                )
            {
                if let Some(session_manager) =
                    window.app_handle().try_state::<authority::SessionManager>()
                {
                    session_manager.revoke_projector_grant("secondary");
                }
            }

            if window.label() != "main" {
                return;
            }

            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if let Some(path) = paths.first().cloned() {
                    let app = window.app_handle().clone();
                    if let Some(session_manager) = app.try_state::<authority::SessionManager>() {
                        let session_manager = session_manager.inner().clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            let selection = if path.is_dir() {
                                session_manager.open_folder_session(&path, Some("main")).map(
                                    |session| commands::StartupSessionSelection::Folder { session },
                                )
                            } else {
                                session_manager.open_file_session(&path, Some("main")).map(
                                    |session| commands::StartupSessionSelection::Image { session },
                                )
                            };
                            match selection {
                                Ok(selection) => {
                                    let folder = match &selection {
                                        commands::StartupSessionSelection::Folder { session } => {
                                            &session.canonical_folder
                                        }
                                        commands::StartupSessionSelection::Image { session } => {
                                            &session.canonical_folder
                                        }
                                        commands::StartupSessionSelection::Empty => return,
                                    };
                                    if let Err(error) =
                                        commands::settings_commands::record_trusted_recent_folder(
                                            &app,
                                            std::path::Path::new(folder),
                                        )
                                    {
                                        eprintln!(
                                            "Failed to record dropped recent authority: {error}"
                                        );
                                        return;
                                    }
                                    let _ = app.emit_to(
                                        "main",
                                        "trusted-native-drop-session",
                                        selection,
                                    );
                                }
                                Err(error) => eprintln!("Dropped path was rejected: {error}"),
                            }
                        });
                    }
                }
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
            create_asset_delivery,
            acknowledge_asset_delivery_responses,
            release_asset_delivery,
            commands::consume_startup_session,
            commands::open_recent_folder_session,
            commands::select_folder_session,
            commands::select_file_session,
            commands::close_folder_session,
            commands::select_destination,
            commands::select_destination_folder,
            commands::select_external_editor,
            commands::emit_projector_sync_by_id,
            commands::clear_projector_sync,
            commands::request_projector_sync,
            commands::close_projector_grant,
            commands::cancel_media_request,
            commands::get_media_executor_telemetry,
            commands::get_preview_image_by_id,
            commands::get_thumbnail_by_id,
            commands::get_image_metadata_by_id,
            commands::get_image_tile_by_id,
            commands::read_folder_index_by_session,
            folder_watcher::watch_folder_by_session,
            folder_watcher::unwatch_folder_by_session,
            commands::get_image_caption_by_id,
            commands::is_dir_by_grant,
            commands::get_codec_health,
            commands::clear_generated_image_cache,
            commands::retry_native_codecs,
            commands::read_settings,
            commands::read_projector_settings,
            commands::write_settings,
            update_channels::check_update_channel,
            commands::save_diagnostics_snapshot,
            commands::read_curation_metadata_by_id,
            commands::read_curation_metadata_for_ids,
            commands::write_image_curation_by_id,
            commands::write_image_curation_batch_by_id,
            commands::clear_image_curation_by_id,
            commands::trash_image_by_id,
            commands::copy_image_by_id,
            commands::move_image_by_id,
            commands::transfer_images_by_id,
            commands::copy_image_by_id_to_clipboard,
            commands::reveal_image_by_id,
            commands::launch_external_editor_by_id,
            commands::get_exif_metadata_by_id,
            commands::rotate_image_by_id,
            commands::save_cropped_copy_by_id,
            commands::save_scaled_copy_by_id,
            commands::overwrite_with_crop_by_id,
            commands::read_projector_display_record,
            commands::navigate_projector_image,
            acquire_slideshow_display_inhibition,
            release_slideshow_display_inhibition,
            update_recent_folders_jump_list,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(executor) = app_handle.try_state::<media_executor::MediaExecutor>() {
                executor.shutdown();
            }
        }
    });
}

fn read_asset_bytes(
    file: &mut std::fs::File,
    start: u64,
    length: usize,
) -> Result<Vec<u8>, String> {
    use std::io::{Read, Seek, SeekFrom};
    if length > 0 {
        file.seek(SeekFrom::Start(start))
            .map_err(|error| format!("Failed to seek authorized asset: {error}"))?;
    }
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(length).map_err(|_| {
        "Authorized asset response allocation exceeded available memory".to_string()
    })?;
    let mut remaining = length;
    let mut buffer = [0_u8; 64 * 1024];
    while remaining > 0 {
        let chunk_len = remaining.min(buffer.len());
        let read = file
            .read(&mut buffer[..chunk_len])
            .map_err(|error| format!("Failed to read authorized asset: {error}"))?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
        remaining -= read;
    }
    if bytes.len() != length {
        return Err(format!(
            "Authorized asset changed while reading (expected {length} bytes, got {})",
            bytes.len()
        ));
    }
    Ok(bytes)
}

#[derive(Debug, PartialEq, Eq)]
pub enum ParsedHttpRange {
    Full,
    Range { start: u64, end: u64 },
    Unsatisfiable,
    Malformed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AssetResponsePlan {
    status: u16,
    start: u64,
    end: u64,
    length: usize,
    file_len: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AssetResponsePlanError {
    Unsatisfiable,
    Malformed,
}

fn plan_asset_response(
    range_header: Option<&str>,
    file_len: u64,
) -> Result<AssetResponsePlan, AssetResponsePlanError> {
    let (status, start, end) = match parse_http_range(range_header, file_len) {
        ParsedHttpRange::Full => (200, 0, file_len.saturating_sub(1)),
        ParsedHttpRange::Range { start, end } => (206, start, end),
        ParsedHttpRange::Unsatisfiable => return Err(AssetResponsePlanError::Unsatisfiable),
        ParsedHttpRange::Malformed => return Err(AssetResponsePlanError::Malformed),
    };
    let length_u64 = if file_len == 0 { 0 } else { end.saturating_sub(start) + 1 };
    let length = usize::try_from(length_u64).map_err(|_| AssetResponsePlanError::Unsatisfiable)?;
    Ok(AssetResponsePlan { status, start, end, length, file_len })
}

fn build_asset_response(
    plan: AssetResponsePlan,
    mime: &str,
    body: Vec<u8>,
) -> tauri::http::Response<Vec<u8>> {
    if body.len() != plan.length {
        return tauri::http::Response::builder().status(500).body(vec![]).unwrap();
    }
    let mut builder = tauri::http::Response::builder()
        .status(plan.status)
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", body.len().to_string())
        .header("Access-Control-Allow-Origin", "http://tauri.localhost");
    if plan.status == 206 {
        builder = builder.header(
            "Content-Range",
            format!("bytes {}-{}/{}", plan.start, plan.end, plan.file_len),
        );
    }
    builder
        .body(body)
        .unwrap_or_else(|_| tauri::http::Response::builder().status(500).body(vec![]).unwrap())
}

pub fn parse_http_range(range_header: Option<&str>, file_len: u64) -> ParsedHttpRange {
    let Some(header) = range_header else {
        return ParsedHttpRange::Full;
    };

    let header = header.trim();
    if header.is_empty() {
        return ParsedHttpRange::Malformed;
    }

    let Some(bytes_spec) = header.strip_prefix("bytes=") else {
        return ParsedHttpRange::Malformed;
    };

    let spec_trimmed = bytes_spec.trim();
    if spec_trimmed.is_empty() || spec_trimmed.contains(',') {
        // Multi-range requests are rejected with 400 Bad Request
        return ParsedHttpRange::Malformed;
    }

    if let Some(suffix_str) = spec_trimmed.strip_prefix('-') {
        let Ok(suffix_len) = suffix_str.parse::<u64>() else {
            return ParsedHttpRange::Malformed;
        };
        if suffix_len == 0 || file_len == 0 {
            return ParsedHttpRange::Unsatisfiable;
        }
        let start = file_len.saturating_sub(suffix_len);
        let end = file_len.saturating_sub(1);
        return ParsedHttpRange::Range { start, end };
    }

    let parts: Vec<&str> = spec_trimmed.splitn(2, '-').collect();
    if parts.len() != 2 {
        return ParsedHttpRange::Malformed;
    }

    let start_str = parts[0].trim();
    let end_str = parts[1].trim();

    let Ok(start) = start_str.parse::<u64>() else {
        return ParsedHttpRange::Malformed;
    };

    if file_len == 0 || start >= file_len {
        return ParsedHttpRange::Unsatisfiable;
    }

    let end = if end_str.is_empty() {
        file_len.saturating_sub(1)
    } else {
        let Ok(req_end) = end_str.parse::<u64>() else {
            return ParsedHttpRange::Malformed;
        };
        if req_end < start {
            return ParsedHttpRange::Unsatisfiable;
        }
        req_end.min(file_len.saturating_sub(1))
    };

    ParsedHttpRange::Range { start, end }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_delivery(budget: &AssetDeliveryBudget, owner: &str) -> String {
        budget.create_delivery(owner, "session", "image").unwrap()
    }

    fn command_sources() -> [&'static str; 6] {
        [
            include_str!("lib.rs"),
            include_str!("commands/mod.rs"),
            include_str!("commands/settings_commands.rs"),
            include_str!("commands/curation_commands.rs"),
            include_str!("folder_watcher.rs"),
            include_str!("update_channels.rs"),
        ]
    }

    fn annotated_command_names(source: &str) -> Vec<&str> {
        let marker = ["#[tauri", "::command]"].concat();
        source
            .split(&marker)
            .skip(1)
            .filter_map(|tail| {
                let function = tail.find("fn ")?;
                let name = &tail[function + 3..];
                let end = name.find(|character: char| {
                    !character.is_ascii_alphanumeric() && character != '_'
                })?;
                Some(&name[..end])
            })
            .collect()
    }

    fn command_body<'a>(sources: &'a [&str], name: &str) -> &'a str {
        for source in sources {
            let needle = format!("fn {name}");
            let Some(start) = source.match_indices(&needle).find_map(|(start, matched)| {
                matches!(source.as_bytes().get(start + matched.len()), Some(b'(' | b'<'))
                    .then_some(start)
            }) else {
                continue;
            };
            let tail = &source[start..];
            let open = tail.find('{').expect("command body start");
            let mut depth = 0usize;
            for (offset, character) in tail[open..].char_indices() {
                match character {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            return &tail[..open + offset + 1];
                        }
                    }
                    _ => {}
                }
            }
        }
        panic!("missing command source for {name}")
    }

    #[test]
    fn invoke_registry_is_exact_unique_and_contains_no_legacy_raw_path_handlers() {
        let source = include_str!("lib.rs");
        let handler_body = source
            .split_once(".invoke_handler(tauri::generate_handler![")
            .expect("generate_handler start")
            .1
            .split_once("])")
            .expect("generate_handler end")
            .0;
        let generated_entries: Vec<_> = handler_body
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(|line| line.trim_end_matches(','))
            .map(|line| line.rsplit("::").next().unwrap_or(line))
            .collect();
        let generated: std::collections::BTreeSet<_> = generated_entries.iter().copied().collect();
        let registered: std::collections::BTreeSet<_> =
            REGISTERED_COMMANDS.iter().map(|(name, _)| *name).collect();

        assert_eq!(registered.len(), REGISTERED_COMMANDS.len(), "duplicate registry entry");
        assert_eq!(generated.len(), generated_entries.len(), "duplicate generate_handler entry");
        assert_eq!(generated, registered, "generate_handler and policy registry drifted");
        let sources = command_sources();
        let annotated_entries: Vec<_> =
            sources.iter().flat_map(|source| annotated_command_names(source)).collect();
        let annotated: std::collections::BTreeSet<_> = annotated_entries.iter().copied().collect();
        assert_eq!(annotated.len(), annotated_entries.len(), "duplicate command annotation");
        assert_eq!(annotated, registered, "annotated commands and policy registry drifted");

        // This is the sole raw-path invoke entry point: the path originates from a backend-owned
        // protected recent-folder record and the handler canonicalizes and reauthorizes it before
        // opening a session. Every media operation after that boundary is ID/grant based.
        let raw_path_authority_entries = ["open_recent_folder_session"];

        for (name, policy) in REGISTERED_COMMANDS {
            let body = command_body(&sources, name);
            let guard_present = match policy {
                CommandPolicy::MainOnly => body.contains("enforce_main_window"),
                CommandPolicy::SecondaryOnly => body.contains("enforce_secondary_window"),
                CommandPolicy::ProjectorParticipant => {
                    body.contains("enforce_projector_participant_label")
                }
                CommandPolicy::AuthorizedMediaReader => {
                    body.contains("lease_image") && body.contains("window.label()")
                }
            };
            assert!(guard_present, "command '{name}' is missing its declared policy guard");
            let signature = body.split('{').next().unwrap_or(body);
            for raw_path_arg in [
                "file_path:",
                "folder_path:",
                "destination_folder:",
                "application_path:",
                "output_path:",
            ] {
                if signature.contains(raw_path_arg) {
                    assert!(
                        raw_path_authority_entries.contains(name),
                        "annotated command '{name}' accepts raw path argument '{raw_path_arg}'"
                    );
                    assert!(body.contains("canonicalize_existing_file"));
                    assert!(body.contains("is_trusted_recent_folder"));
                }
            }
        }
        for forbidden in [
            "scan_folder",
            "get_preview_image",
            "get_thumbnail",
            "get_image_metadata",
            "get_image_tile",
            "trash_image",
            "copy_image",
            "move_image",
            "launch_external_editor",
            "rotate_image",
            "save_cropped_copy",
            "save_scaled_copy",
            "overwrite_with_crop",
            "open_folder_session",
            "open_file_session",
            "grant_destination",
            "grant_external_editor",
        ] {
            assert!(
                !registered.contains(forbidden),
                "legacy raw-path handler registered: {forbidden}"
            );
        }
    }

    #[test]
    fn renderer_capabilities_cannot_mint_or_reveal_raw_path_authority() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        let permissions = capability["permissions"].as_array().unwrap();
        let identifiers: Vec<&str> = permissions
            .iter()
            .filter_map(|entry| {
                entry.as_str().or_else(|| entry.get("identifier").and_then(|value| value.as_str()))
            })
            .collect();
        for forbidden in [
            "cli:default",
            "dialog:default",
            "dialog:allow-open",
            "dialog:allow-save",
            "opener:allow-reveal-item-in-dir",
        ] {
            assert!(
                !identifiers.contains(&forbidden),
                "forbidden renderer capability: {forbidden}"
            );
        }
        assert!(identifiers.contains(&"opener:allow-open-url"));
    }

    #[test]
    fn plugin_capability_allowlists_are_exact_for_each_window() {
        fn identifiers(source: &str) -> std::collections::BTreeSet<String> {
            let capability: serde_json::Value = serde_json::from_str(source).unwrap();
            capability["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|entry| {
                    entry
                        .as_str()
                        .or_else(|| entry.get("identifier").and_then(|value| value.as_str()))
                })
                .map(str::to_string)
                .collect()
        }

        let main = identifiers(include_str!("../capabilities/main.json"));
        let expected_main: std::collections::BTreeSet<String> = [
            "core:default",
            "opener:allow-open-url",
            "dialog:allow-confirm",
            "dialog:allow-message",
            "dialog:allow-ask",
            "core:window:allow-close",
            "core:window:allow-show",
            "core:window:allow-set-focus",
            "core:window:allow-set-position",
            "core:window:allow-set-size",
            "core:window:allow-set-fullscreen",
            "core:window:allow-is-fullscreen",
            "core:window:allow-set-title",
            "core:webview:allow-create-webview-window",
            "updater:default",
            "process:allow-restart",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        assert_eq!(main, expected_main);

        let projector = identifiers(include_str!("../capabilities/projector.json"));
        let expected_projector: std::collections::BTreeSet<String> = [
            "core:event:allow-listen",
            "core:window:allow-close",
            "core:window:allow-show",
            "core:window:allow-set-focus",
            "core:window:allow-set-position",
            "core:window:allow-set-size",
            "core:window:allow-set-fullscreen",
            "core:window:allow-is-fullscreen",
            "core:window:allow-set-title",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        assert_eq!(projector, expected_projector);

        let mut mutated = projector.clone();
        mutated.insert("dialog:allow-open".to_string());
        assert_ne!(mutated, expected_projector, "allowlist mutation must be detected");
    }

    #[test]
    fn window_policy_guards_reject_unauthorized_labels() {
        assert!(commands::enforce_main_window_label("main").is_ok());
        assert!(commands::enforce_main_window_label("secondary").is_err());
        assert!(commands::enforce_secondary_window_label("secondary").is_ok());
        assert!(commands::enforce_secondary_window_label("main").is_err());
        assert!(commands::enforce_projector_participant_label("main").is_ok());
        assert!(commands::enforce_projector_participant_label("secondary").is_ok());
        assert!(commands::enforce_projector_participant_label("unknown").is_err());
    }

    #[test]
    fn test_parse_http_range_rfc7233_compliance() {
        let len = 1000;
        assert_eq!(parse_http_range(None, len), ParsedHttpRange::Full);
        assert_eq!(parse_http_range(Some(""), len), ParsedHttpRange::Malformed);
        assert_eq!(
            parse_http_range(Some("bytes=0-499"), len),
            ParsedHttpRange::Range { start: 0, end: 499 }
        );
        assert_eq!(
            parse_http_range(Some("bytes=500-"), len),
            ParsedHttpRange::Range { start: 500, end: 999 }
        );
        assert_eq!(
            parse_http_range(Some("bytes=-300"), len),
            ParsedHttpRange::Range { start: 700, end: 999 }
        );
        assert_eq!(parse_http_range(Some("bytes=1000-2000"), len), ParsedHttpRange::Unsatisfiable);
        assert_eq!(parse_http_range(Some("bytes=500-200"), len), ParsedHttpRange::Unsatisfiable);
        assert_eq!(parse_http_range(Some("bytes=0-10,20-30"), len), ParsedHttpRange::Malformed);
        assert_eq!(parse_http_range(Some("invalid-range"), len), ParsedHttpRange::Malformed);
    }

    #[test]
    fn asset_delivery_budget_rejects_before_overcommit_and_releases_exactly() {
        let budget = AssetDeliveryBudget {
            live_deliveries: std::sync::Mutex::new(std::collections::HashMap::new()),
            max_response_bytes: 80,
            max_aggregate_bytes: 100,
        };

        let first_id = create_test_delivery(&budget, "main");
        let second_id = create_test_delivery(&budget, "main");
        assert!(matches!(budget.try_admit("main", &first_id, "session", "image", 81), Err(413)));
        let first = budget.try_admit("main", &first_id, "session", "image", 60).unwrap();
        assert!(matches!(budget.try_admit("main", &second_id, "session", "image", 50), Err(503)));
        assert_eq!(budget.live_bytes(), 60);
        drop(first);
        assert_eq!(budget.live_bytes(), 0);
        let second = budget.try_admit("main", &second_id, "session", "image", 50).unwrap();
        assert_eq!(budget.live_bytes(), 50);
        drop(second);
    }

    #[test]
    fn asset_delivery_budget_serializes_concurrent_admission() {
        let budget = std::sync::Arc::new(AssetDeliveryBudget {
            live_deliveries: std::sync::Mutex::new(std::collections::HashMap::new()),
            max_response_bytes: 100,
            max_aggregate_bytes: 100,
        });
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let worker_budget = budget.clone();
        let worker_id = create_test_delivery(&budget, "main");
        let main_id = create_test_delivery(&budget, "main");
        let final_id = create_test_delivery(&budget, "main");
        let worker_barrier = barrier.clone();
        let worker = std::thread::spawn(move || {
            let permit =
                worker_budget.try_admit("main", &worker_id, "session", "image", 70).unwrap();
            worker_barrier.wait();
            worker_barrier.wait();
            drop(permit);
        });

        barrier.wait();
        assert!(matches!(budget.try_admit("main", &main_id, "session", "image", 40), Err(503)));
        barrier.wait();
        worker.join().unwrap();
        assert!(budget.try_admit("main", &final_id, "session", "image", 100).is_ok());
    }

    #[test]
    fn committed_asset_bodies_remain_accounted_until_explicit_consumption_ack() {
        let budget = AssetDeliveryBudget {
            live_deliveries: std::sync::Mutex::new(std::collections::HashMap::new()),
            max_response_bytes: 80,
            max_aggregate_bytes: 100,
        };

        let retained_body = [7_u8; 70];
        let retained_id = create_test_delivery(&budget, "main");
        let blocked_id = create_test_delivery(&budget, "main");
        let unblocked_id = create_test_delivery(&budget, "main");
        let retained = budget
            .try_admit("main", &retained_id, "session", "image", retained_body.len())
            .unwrap();
        let retained_response_id = retained.response_id().to_string();
        retained.commit();
        assert_eq!(budget.live_bytes(), retained_body.len());
        assert!(matches!(budget.try_admit("main", &blocked_id, "session", "image", 40), Err(503)));
        assert_eq!(retained_body[0], 7);
        assert!(!budget.close("secondary", &retained_id).closed);
        assert!(budget.close("main", &retained_id).closed);
        assert_eq!(budget.live_bytes(), retained_body.len());
        assert!(!budget.acknowledge_response("secondary", &retained_id, &retained_response_id));
        assert!(budget.acknowledge_response("main", &retained_id, &retained_response_id));
        assert!(!budget.acknowledge_response("main", &retained_id, &retained_response_id));
        assert!(budget.try_admit("main", &unblocked_id, "session", "image", 40).is_ok());
    }

    #[test]
    fn early_delivery_release_cannot_unaccount_an_active_or_committed_body() {
        let budget = AssetDeliveryBudget {
            live_deliveries: std::sync::Mutex::new(std::collections::HashMap::new()),
            max_response_bytes: 100,
            max_aggregate_bytes: 100,
        };
        let delivery_id = create_test_delivery(&budget, "main");
        let permit = budget.try_admit("main", &delivery_id, "session", "image", 80).unwrap();
        let response_id = permit.response_id().to_string();

        assert!(budget.close("main", &delivery_id).closed);
        assert_eq!(budget.live_bytes(), 80);
        assert!(matches!(budget.try_admit("main", &delivery_id, "session", "image", 1), Err(410)));
        permit.commit();
        assert_eq!(budget.live_bytes(), 80);
        assert!(!budget.close("secondary", &delivery_id).closed);
        assert!(budget.acknowledge_response("main", &delivery_id, &response_id));
        assert_eq!(budget.live_bytes(), 0);
    }

    #[test]
    fn concurrent_range_reads_are_accounted_until_each_finishes_construction() {
        let budget = AssetDeliveryBudget {
            live_deliveries: std::sync::Mutex::new(std::collections::HashMap::new()),
            max_response_bytes: 100,
            max_aggregate_bytes: 100,
        };
        let delivery_id = create_test_delivery(&budget, "main");
        let first = budget.try_admit("main", &delivery_id, "session", "image", 40).unwrap();
        let second = budget.try_admit("main", &delivery_id, "session", "image", 50).unwrap();
        let second_response_id = second.response_id().to_string();
        assert_eq!(budget.live_bytes(), 90);

        drop(first);
        assert_eq!(budget.live_bytes(), 50);
        second.commit();
        assert_eq!(budget.live_bytes(), 50);
        assert!(budget.close("main", &delivery_id).closed);
        assert_eq!(budget.live_bytes(), 50);
        assert!(budget.acknowledge_response("main", &delivery_id, &second_response_id));
        assert_eq!(budget.live_bytes(), 0);
    }

    #[test]
    fn response_capabilities_survive_close_and_ack_before_commit_without_leaking() {
        let budget = AssetDeliveryBudget {
            live_deliveries: std::sync::Mutex::new(std::collections::HashMap::new()),
            max_response_bytes: 100,
            max_aggregate_bytes: 100,
        };
        let delivery_id = create_test_delivery(&budget, "main");
        let first = budget.try_admit("main", &delivery_id, "session", "image", 40).unwrap();
        let first_id = first.response_id().to_string();
        let second = budget.try_admit("main", &delivery_id, "session", "image", 50).unwrap();
        let second_id = second.response_id().to_string();
        assert_ne!(first_id, second_id);

        first.commit();
        let closed = budget.close("main", &delivery_id);
        assert!(closed.closed);
        assert_eq!(closed.response_ids.len(), 2);
        assert!(closed.response_ids.contains(&first_id));
        assert!(closed.response_ids.contains(&second_id));
        assert!(matches!(budget.try_admit("main", &delivery_id, "session", "image", 1), Err(410)));

        assert!(!budget.acknowledge_response("secondary", &delivery_id, &first_id));
        assert!(budget.acknowledge_response("main", &delivery_id, &first_id));
        assert!(!budget.acknowledge_response("main", &delivery_id, &first_id));
        assert_eq!(budget.live_bytes(), 50);

        // The second acknowledgement arrives while construction is still active. It is retained
        // on that exact capability, so the delayed commit releases rather than resurrecting bytes.
        assert!(budget.acknowledge_response("main", &delivery_id, &second_id));
        assert!(!budget.acknowledge_response("main", &delivery_id, &second_id));
        assert_eq!(budget.live_bytes(), 50);
        second.commit();
        assert_eq!(budget.live_bytes(), 0);
        assert!(budget.live_deliveries.lock().unwrap().is_empty());
    }

    #[test]
    fn owner_teardown_reclaims_committed_bodies_but_not_reads_still_constructing() {
        let budget = AssetDeliveryBudget {
            live_deliveries: std::sync::Mutex::new(std::collections::HashMap::new()),
            max_response_bytes: 100,
            max_aggregate_bytes: 100,
        };
        let delivery_id = create_test_delivery(&budget, "main");
        let constructing = budget.try_admit("main", &delivery_id, "session", "image", 40).unwrap();
        let committed = budget.try_admit("main", &delivery_id, "session", "image", 50).unwrap();
        committed.commit();
        assert_eq!(budget.live_bytes(), 90);

        budget.release_owner("secondary");
        assert_eq!(budget.live_bytes(), 90);
        budget.release_owner("main");
        assert_eq!(budget.live_bytes(), 40);
        constructing.commit();
        assert_eq!(budget.live_bytes(), 0);
    }

    #[test]
    fn asset_delivery_allows_repeated_ranges_without_zero_byte_cardinality_growth() {
        let budget = AssetDeliveryBudget {
            live_deliveries: std::sync::Mutex::new(std::collections::HashMap::new()),
            max_response_bytes: 100,
            max_aggregate_bytes: 100,
        };
        let repeated_id = create_test_delivery(&budget, "main");
        budget.try_admit("main", &repeated_id, "session", "image", 20).unwrap().commit();
        budget.try_admit("main", &repeated_id, "session", "image", 30).unwrap().commit();
        for index in 0..1_000 {
            let _ = index;
            budget.try_admit("main", &repeated_id, "session", "image", 0).unwrap().commit();
        }
        assert_eq!(budget.live_deliveries.lock().unwrap().len(), 1);
        assert_eq!(budget.live_bytes(), 50);
        budget.release_owner("main");
        assert_eq!(budget.live_bytes(), 0);
    }

    #[test]
    fn asset_delivery_expiry_only_reclaims_unserved_tokens_and_live_bodies_require_teardown() {
        let budget = AssetDeliveryBudget::default();
        let live_id = create_test_delivery(&budget, "main");
        let pending_id = create_test_delivery(&budget, "main");
        budget.try_admit("main", &live_id, "session", "image", 64 * 1024 * 1024).unwrap().commit();
        {
            let mut deliveries = budget.live_deliveries.lock().unwrap();
            deliveries.values_mut().for_each(|entry| {
                entry.expires_at = std::time::Instant::now() - std::time::Duration::from_secs(1)
            });
        }
        let fresh_id = budget.create_delivery("main", "session", "image").unwrap();
        assert!(!budget.live_deliveries.lock().unwrap().contains_key(&("main".into(), pending_id)));
        assert_eq!(budget.live_bytes(), 64 * 1024 * 1024);
        assert!(!budget.close("secondary", &live_id).closed);
        assert!(budget.close("main", &live_id).closed);
        assert!(budget.close("main", &fresh_id).closed);
    }

    #[test]
    fn asset_response_planner_and_builder_return_exact_range_contract() {
        let plan = plan_asset_response(Some("bytes=2-5"), 10).unwrap();
        assert_eq!(
            plan,
            AssetResponsePlan { status: 206, start: 2, end: 5, length: 4, file_len: 10 }
        );
        let response = build_asset_response(plan, "image/jpeg", vec![2, 3, 4, 5]);
        assert_eq!(response.status(), 206);
        assert_eq!(response.headers()["Content-Type"], "image/jpeg");
        assert_eq!(response.headers()["Content-Length"], "4");
        assert_eq!(response.headers()["Content-Range"], "bytes 2-5/10");
        assert_eq!(response.body(), &vec![2, 3, 4, 5]);

        assert_eq!(
            plan_asset_response(Some("bytes=20-30"), 10),
            Err(AssetResponsePlanError::Unsatisfiable)
        );
        assert_eq!(
            plan_asset_response(Some("items=0-1"), 10),
            Err(AssetResponsePlanError::Malformed)
        );
        assert_eq!(
            plan_asset_response(Some("bytes=0-0"), 0),
            Err(AssetResponsePlanError::Unsatisfiable)
        );
        assert_eq!(
            plan_asset_response(Some("bytes=-0"), 10),
            Err(AssetResponsePlanError::Unsatisfiable)
        );
        let mismatch = build_asset_response(plan, "image/jpeg", vec![2, 3]);
        assert_eq!(mismatch.status(), 500);
        assert!(mismatch.body().is_empty());
    }

    #[test]
    fn asset_reader_does_not_truncate_representations_larger_than_64_mib() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.bin");
        let length = 64 * 1024 * 1024 + 1;
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(length as u64).unwrap();
        drop(file);

        let mut file = std::fs::File::open(&path).unwrap();
        let bytes = read_asset_bytes(&mut file, 0, length).unwrap();
        assert_eq!(bytes.len(), length);
    }
}
