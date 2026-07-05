use serde::{Deserialize, Serialize};
use tauri::{Manager, ResourceId, Runtime, Webview};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

const PREVIEW_UPDATE_ENDPOINT: &str =
    "https://github.com/nushydude/lightframe/releases/download/app-preview-channel/latest.json";

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Stable,
    Preview,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelUpdateMetadata {
    rid: ResourceId,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
}

#[tauri::command]
pub async fn check_update_channel<R: Runtime>(
    webview: Webview<R>,
    channel: UpdateChannel,
) -> Result<Option<ChannelUpdateMetadata>, String> {
    let mut builder = webview.updater_builder();
    if channel == UpdateChannel::Preview {
        let endpoint = Url::parse(PREVIEW_UPDATE_ENDPOINT)
            .map_err(|error| format!("Invalid preview update endpoint: {error}"))?;
        builder = builder
            .endpoints(vec![endpoint])
            .map_err(|error| format!("Invalid preview update endpoint: {error}"))?;
    }

    let updater = builder.build().map_err(|error| format!("Failed to create updater: {error}"))?;
    let update =
        updater.check().await.map_err(|error| format!("Failed to check for updates: {error}"))?;

    Ok(update.map(|update| {
        let metadata = ChannelUpdateMetadata {
            current_version: update.current_version.clone(),
            version: update.version.clone(),
            date: None,
            body: update.body.clone(),
            raw_json: update.raw_json.clone(),
            rid: webview.resources_table().add(update),
        };
        metadata
    }))
}
