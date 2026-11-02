//! Desktop shell behavior of the main window.

use std::path::Path;
use tauri::webview::NewWindowResponse;
use tauri::{App, AppHandle, Manager, Url, WebviewWindowBuilder};

/// Only these schemes leave the app, in the system browser.
pub fn is_external(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// The app document itself: `tauri://localhost`, `http(s)://tauri.localhost` on Windows,
/// or the dev server in debug builds.
pub fn is_app_url(url: &Url, dev_url: Option<&Url>) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "about" => url.path() == "blank",
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || dev_url.is_some_and(|d| d.origin() == url.origin())
        }
        _ => false,
    }
}

fn open_external(url: &Url) {
    if is_external(url) {
        if let Err(e) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
            eprintln!("Could not open {url}: {e}");
        }
    }
}

/// Builds the `main` window from `tauri.conf.json` (`create: false`) with link routing.
pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    if let Ok(dir) = app.path().config_dir() {
        migrate_legacy(&dir);
    }
    let cfg = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .ok_or("no main window in tauri.conf.json")?;
    let dev_url = cfg!(debug_assertions)
        .then(|| app.config().build.dev_url.clone())
        .flatten();
    WebviewWindowBuilder::from_config(app.handle(), &cfg)?
        .on_navigation(move |url| {
            let inside = is_app_url(url, dev_url.as_ref());
            if !inside {
                open_external(url);
            }
            inside
        })
        .on_new_window(|url, _| {
            open_external(&url);
            NewWindowResponse::Deny
        })
        .build()?;
    #[cfg(target_os = "macos")]
    edit_menu(app)?;
    Ok(())
}

/// A second launch exits; the running instance comes to the front.
pub fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Electron's userData names before the rename to SaiLoR.
const LEGACY_DIRS: [&str; 2] = ["SLR Helper", "slr-helper"];
const LEGACY_ITEMS: [&str; 2] = ["window-state.json", "Local Storage"];

fn has_profile(dir: &Path) -> bool {
    LEGACY_ITEMS.iter().any(|i| dir.join(i).exists())
}

/// Copies the pre-rename settings into `<config>/SaiLoR` once, only into an unused
/// profile. Best effort: errors are logged, startup goes on.
pub fn migrate_legacy(config_dir: &Path) {
    let target = config_dir.join("SaiLoR");
    if has_profile(&target) {
        return;
    }
    let Some(legacy) = LEGACY_DIRS
        .iter()
        .map(|d| config_dir.join(d))
        .find(|d| *d != target && has_profile(d))
    else {
        return;
    };
    for item in LEGACY_ITEMS {
        if let Err(e) = copy_new(&legacy.join(item), &target.join(item)) {
            eprintln!("Could not migrate {item} from {}: {e}", legacy.display());
        }
    }
}

/// Recursive copy that skips symlinks and never replaces an existing file.
fn copy_new(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = match std::fs::symlink_metadata(from) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if meta.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_new(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else if meta.is_file() && !to.exists() {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(from, to)?;
    }
    Ok(())
}

/// Swaps the default menu's native Undo/Redo for the app history (`app:undo`, `app:redo`).
/// The page sees Cmd+Z first; the menu item fires only when the page did not handle it.
#[cfg(target_os = "macos")]
fn edit_menu(app: &App) -> tauri::Result<()> {
    use tauri::menu::{MenuItem, MenuItemKind};
    use tauri::Emitter;
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    for item in menu.items()? {
        let MenuItemKind::Submenu(edit) = item else {
            continue;
        };
        if edit.text()? != "Edit" {
            continue;
        }
        edit.remove_at(0)?;
        edit.remove_at(0)?;
        edit.prepend_items(&[
            &MenuItem::with_id(app, "app:undo", "Undo", true, Some("CmdOrCtrl+Z"))?,
            &MenuItem::with_id(app, "app:redo", "Redo", true, Some("CmdOrCtrl+Shift+Z"))?,
        ])?;
    }
    app.on_menu_event(|app, e| {
        let id = e.id().as_ref();
        if id == "app:undo" || id == "app:redo" {
            let _ = app.emit(id, ());
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_http_and_https_are_external() {
        for ok in ["http://example.org/a", "https://doi.org/10.1/x"] {
            assert!(is_external(&url(ok)), "{ok}");
        }
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "mailto:a@b.c",
            "tauri://localhost/",
            "data:text/html,x",
            "smb://host/share",
        ] {
            assert!(!is_external(&url(bad)), "{bad}");
        }
    }

    #[test]
    fn app_urls_stay_in_the_window() {
        let dev = url("http://localhost:5173");
        for ok in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/#x",
            "about:blank",
            "http://localhost:5173/src/main.tsx",
        ] {
            assert!(is_app_url(&url(ok), Some(&dev)), "{ok}");
        }
        for bad in [
            "https://example.org/",
            "http://localhost:5174/",
            "https://localhost:5173/",
            "tauri://evil/",
            "http://slr-file.localhost/x.pdf",
            "slr-file://localhost/x.pdf",
            "file:///tmp/x.html",
            "about:srcdoc",
        ] {
            assert!(!is_app_url(&url(bad), Some(&dev)), "{bad}");
        }
        assert!(!is_app_url(&url("http://localhost:5173/"), None));
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("sailor-rs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn migrates_legacy_profile_once() {
        let root = tmp("migrate");
        let old = root.join("SLR Helper");
        std::fs::create_dir_all(old.join("Local Storage/leveldb")).unwrap();
        std::fs::write(old.join("window-state.json"), "{\"width\":800}").unwrap();
        std::fs::write(old.join("Local Storage/leveldb/000.log"), "recent").unwrap();
        std::fs::write(old.join("other.txt"), "skip").unwrap();
        migrate_legacy(&root);
        let new = root.join("SaiLoR");
        assert_eq!(
            std::fs::read_to_string(new.join("window-state.json")).unwrap(),
            "{\"width\":800}"
        );
        assert_eq!(
            std::fs::read_to_string(new.join("Local Storage/leveldb/000.log")).unwrap(),
            "recent"
        );
        assert!(!new.join("other.txt").exists());

        // A used profile wins: nothing is copied again or overwritten.
        std::fs::write(new.join("window-state.json"), "mine").unwrap();
        std::fs::write(old.join("Local Storage/leveldb/001.log"), "late").unwrap();
        migrate_legacy(&root);
        assert_eq!(
            std::fs::read_to_string(new.join("window-state.json")).unwrap(),
            "mine"
        );
        assert!(!new.join("Local Storage/leveldb/001.log").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_never_overwrites_and_skips_missing() {
        let root = tmp("copynew");
        std::fs::write(root.join("a"), "new").unwrap();
        std::fs::write(root.join("b"), "old").unwrap();
        copy_new(&root.join("a"), &root.join("b")).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("b")).unwrap(), "old");
        copy_new(&root.join("missing"), &root.join("c")).unwrap();
        assert!(!root.join("c").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migration_without_legacy_creates_nothing() {
        let root = tmp("nolegacy");
        migrate_legacy(&root);
        assert!(!root.join("SaiLoR").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
