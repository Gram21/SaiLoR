//! `update:*` channels on tauri-plugin-updater. User-triggered only; the
//! feed URL and public key come from tauri.conf.json, never the renderer.

use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::utils::config::BundleType;
use tauri::utils::platform::bundle_type;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Pending {
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}

pub type State = Mutex<Pending>;

/// deb/rpm and unbundled binaries update through the package manager or by hand.
fn self_update_supported(bundle: Option<BundleType>) -> bool {
    matches!(
        bundle,
        Some(BundleType::AppImage | BundleType::Nsis | BundleType::Msi | BundleType::App)
    )
}

fn percent(done: u64, total: Option<u64>) -> Option<u64> {
    total.filter(|t| *t > 0).map(|t| (done * 100 / t).min(100))
}

fn error(app: &AppHandle, e: impl ToString) {
    let _ = app.emit("update:error", e.to_string());
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Value {
    if !self_update_supported(bundle_type()) {
        return json!({ "supported": false, "manual": true });
    }
    match app.updater().map_err(|e| e.to_string()) {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                *app.state::<State>().lock().unwrap() = Pending {
                    update: Some(update),
                    bytes: None,
                };
                let _ = app.emit("update:available", json!({ "version": version }));
            }
            Ok(None) => {}
            Err(e) => error(&app, e),
        },
        Err(e) => error(&app, e),
    }
    json!({ "supported": true })
}

#[tauri::command]
pub fn update_download(app: AppHandle) {
    let Some(update) = app.state::<State>().lock().unwrap().update.clone() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let (mut done, mut last) = (0u64, None);
        let progress = |chunk: usize, total: Option<u64>| {
            done += chunk as u64;
            let p = percent(done, total);
            if p.is_some() && p != last {
                last = p;
                let _ = app.emit("update:progress", json!({ "percent": p }));
            }
        };
        match update.download(progress, || {}).await {
            Ok(bytes) => {
                app.state::<State>().lock().unwrap().bytes = Some(bytes);
                let _ = app.emit("update:downloaded", ());
            }
            Err(e) => error(&app, e),
        }
    });
}

#[tauri::command]
pub async fn update_install(app: AppHandle) {
    if app.state::<crate::close::Guard>().is_dirty() {
        error(&app, "Save your project before you install the update.");
        return;
    }
    let pending = std::mem::take(&mut *app.state::<State>().lock().unwrap());
    let (Some(update), Some(bytes)) = (pending.update, pending.bytes) else {
        return;
    };
    match update.install(bytes) {
        Ok(()) => app.restart(),
        Err(e) => error(&app, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_appimage_windows_and_macos_self_update() {
        for b in [
            BundleType::AppImage,
            BundleType::Nsis,
            BundleType::Msi,
            BundleType::App,
        ] {
            assert!(self_update_supported(Some(b)));
        }
        for b in [
            Some(BundleType::Deb),
            Some(BundleType::Rpm),
            Some(BundleType::Dmg),
            None,
        ] {
            assert!(!self_update_supported(b));
        }
    }

    #[test]
    fn percent_needs_a_known_total_and_caps_at_100() {
        assert_eq!(percent(50, Some(200)), Some(25));
        assert_eq!(percent(300, Some(200)), Some(100));
        assert_eq!(percent(5, None), None);
        assert_eq!(percent(5, Some(0)), None);
    }

    #[test]
    fn feed_is_fixed_https_github_and_signed_versions_are_required() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = &conf["plugins"]["updater"];
        assert_eq!(
            updater["endpoints"],
            json!(["https://github.com/Gram21/SaiLoR/releases/latest/download/latest.json"])
        );
        assert_eq!(updater["requireSignedVersion"], json!(true));
        serde_json::from_value::<tauri_plugin_updater::Config>(updater.clone()).unwrap();
    }
}
