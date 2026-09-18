use semver::Version;
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

fn select_newest_update<T>(
    current_version: &str,
    candidates: impl IntoIterator<Item = (String, T)>,
) -> Result<Option<T>, String> {
    let current_version = Version::parse(current_version)
        .map_err(|error| format!("Invalid current updater version: {error}"))?;
    let mut newest: Option<(Version, T)> = None;

    for (version, candidate) in candidates {
        let version = Version::parse(&version)
            .map_err(|error| format!("Invalid updater version '{version}': {error}"))?;
        if version.cmp_precedence(&current_version) != std::cmp::Ordering::Greater {
            continue;
        }

        let is_newer = newest.as_ref().is_none_or(|(newest_version, _)| {
            version.cmp_precedence(newest_version) == std::cmp::Ordering::Greater
        });
        if is_newer {
            newest = Some((version, candidate));
        }
    }

    Ok(newest.map(|(_, candidate)| candidate))
}

fn combine_preview_candidates<T>(
    current_version: &str,
    stable: Result<Option<(String, T)>, String>,
    preview: Result<Option<(String, T)>, String>,
) -> Result<Option<T>, String> {
    let (stable, stable_error) = match stable {
        Ok(update) => (update, None),
        Err(error) => (None, Some(format!("stable feed: {error}"))),
    };
    let (preview, preview_error) = match preview {
        Ok(update) => (update, None),
        Err(error) => (None, Some(format!("preview feed: {error}"))),
    };

    let errors = [stable_error, preview_error].into_iter().flatten().collect::<Vec<_>>();
    let candidates = [stable, preview].into_iter().flatten();

    if errors.len() == 2 {
        return Err(format!("Failed to check stable and preview feeds: {}", errors.join("; ")));
    }

    select_newest_update(current_version, candidates)
}

#[tauri::command]
pub async fn check_update_channel<R: Runtime>(
    webview: Webview<R>,
    channel: UpdateChannel,
) -> Result<Option<ChannelUpdateMetadata>, String> {
    let current_version = webview.app_handle().package_info().version.to_string();
    let update = match channel {
        UpdateChannel::Stable => {
            let updater = webview
                .updater_builder()
                .build()
                .map_err(|error| format!("Failed to create updater: {error}"))?;
            updater
                .check()
                .await
                .map_err(|error| format!("Failed to check for updates: {error}"))?
        }
        UpdateChannel::Preview => {
            let preview_endpoint = Url::parse(PREVIEW_UPDATE_ENDPOINT)
                .map_err(|error| format!("Invalid preview update endpoint: {error}"))?;

            let stable_result = match webview.updater_builder().build() {
                Ok(updater) => updater
                    .check()
                    .await
                    .map(|update| update.map(|update| (update.version.clone(), update)))
                    .map_err(|error| format!("{error}")),
                Err(error) => Err(format!("{error}")),
            };
            let preview_result = match webview
                .updater_builder()
                .endpoints(vec![preview_endpoint])
                .map_err(|error| format!("{error}"))
                .and_then(|builder| builder.build().map_err(|error| format!("{error}")))
            {
                Ok(updater) => updater
                    .check()
                    .await
                    .map(|update| update.map(|update| (update.version.clone(), update)))
                    .map_err(|error| format!("{error}")),
                Err(error) => Err(error),
            };

            combine_preview_candidates(&current_version, stable_result, preview_result)?
        }
    };

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

#[cfg(test)]
mod tests {
    use super::combine_preview_candidates;

    fn candidate(version: &str, source: &str) -> Option<(String, String)> {
        Some((version.to_string(), source.to_string()))
    }

    #[test]
    fn selects_highest_semver_update_across_stable_and_preview_feeds() {
        let selected = combine_preview_candidates(
            "8.0.0",
            Ok(candidate("8.3.0", "stable")),
            Ok(candidate("8.4.0-beta.1", "preview")),
        )
        .unwrap();

        assert_eq!(selected.as_deref(), Some("preview"));
    }

    #[test]
    fn stable_release_promotes_over_preview_of_the_same_version() {
        let selected = combine_preview_candidates(
            "8.0.0",
            Ok(candidate("8.4.0", "stable")),
            Ok(candidate("8.4.0-beta.1", "preview")),
        )
        .unwrap();

        assert_eq!(selected.as_deref(), Some("stable"));
    }

    #[test]
    fn older_stable_release_does_not_replace_newer_preview() {
        let selected = combine_preview_candidates(
            "8.4.0-beta.1",
            Ok(candidate("8.3.0", "stable")),
            Ok(candidate("8.4.0-beta.1", "preview")),
        )
        .unwrap();

        assert_eq!(selected, None);
    }

    #[test]
    fn ignores_releases_that_are_not_newer_than_installed_version() {
        let selected = combine_preview_candidates(
            "8.4.0",
            Ok(candidate("8.4.0", "stable")),
            Ok(candidate("8.4.0-beta.1", "preview")),
        )
        .unwrap();

        assert_eq!(selected, None);
    }

    #[test]
    fn a_failed_feed_does_not_hide_an_update_from_the_other_feed() {
        let selected = combine_preview_candidates(
            "8.0.0",
            Err("stable unavailable".to_string()),
            Ok(candidate("8.4.0-beta.1", "preview")),
        )
        .unwrap();

        assert_eq!(selected.as_deref(), Some("preview"));
    }

    #[test]
    fn stable_release_remains_available_when_preview_feed_fails() {
        let selected = combine_preview_candidates(
            "8.4.0-beta.2",
            Ok(candidate("8.4.0", "stable")),
            Err("preview unavailable".to_string()),
        )
        .unwrap();

        assert_eq!(selected.as_deref(), Some("stable"));
    }

    #[test]
    fn compares_prerelease_numeric_identifiers_numerically() {
        let selected = combine_preview_candidates(
            "8.0.0",
            Ok(candidate("8.4.0-beta.2", "stable")),
            Ok(candidate("8.4.0-beta.10", "preview")),
        )
        .unwrap();

        assert_eq!(selected.as_deref(), Some("preview"));
    }

    #[test]
    fn one_failed_feed_and_one_empty_feed_is_no_update() {
        let selected = combine_preview_candidates::<String>(
            "8.0.0",
            Err("stable unavailable".to_string()),
            Ok(None),
        )
        .unwrap();

        assert_eq!(selected, None);
    }

    #[test]
    fn total_feed_failure_is_reported() {
        let error = combine_preview_candidates::<String>(
            "8.0.0",
            Err("stable unavailable".to_string()),
            Err("preview unavailable".to_string()),
        )
        .unwrap_err();

        assert!(error.contains("stable feed: stable unavailable"));
        assert!(error.contains("preview feed: preview unavailable"));
    }
}
