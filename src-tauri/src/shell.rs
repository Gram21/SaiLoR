//! Desktop shell behavior of the main window.

use crate::close;
use std::path::Path;
use tauri::menu::{MenuItem, PredefinedMenuItem};
use tauri::webview::NewWindowResponse;
use tauri::{App, AppHandle, Emitter, Manager, Url, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const REPO_URL: &str = "https://github.com/Gram21/SaiLoR";

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

/// Menu ids. An id that the renderer handles is also its event name.
#[derive(Debug, PartialEq)]
enum Action {
    Reload,
    Quit,
    CloseWindow,
    Fullscreen,
    Minimize,
    ToggleMaximize,
    Github,
    About,
    /// Emitted to the renderer under the same name.
    Emit(&'static str),
}

fn action(id: &str) -> Option<Action> {
    Some(match id {
        "app:reload" => Action::Reload,
        "app:quit" => Action::Quit,
        "app:closeWindow" => Action::CloseWindow,
        "app:fullscreen" => Action::Fullscreen,
        "app:minimize" => Action::Minimize,
        "app:maximize" => Action::ToggleMaximize,
        "app:github" => Action::Github,
        "app:about" => Action::About,
        "app:undo" => Action::Emit("app:undo"),
        "app:redo" => Action::Emit("app:redo"),
        "app:closeProject" => Action::Emit("app:closeProject"),
        "app:settings" => Action::Emit("app:settings"),
        _ => return None,
    })
}

fn run(app: &AppHandle, action: Action) {
    let window = app.get_webview_window("main");
    match action {
        Action::Emit(event) => {
            let _ = app.emit(event, ());
        }
        Action::Reload => close::request_reload(app),
        Action::Quit => close::request_quit(app),
        Action::Github => {
            if let Ok(url) = Url::parse(REPO_URL) {
                open_external(&url);
            }
        }
        Action::About => {
            let mut dialog = app
                .dialog()
                .message(format!("Version {}", app.package_info().version))
                .title("About SaiLoR")
                .kind(MessageDialogKind::Info);
            if let Some(w) = &window {
                dialog = dialog.parent(w);
            }
            dialog.show(|_| {});
        }
        Action::CloseWindow => {
            if let Some(w) = &window {
                let _ = w.close();
            }
        }
        Action::Fullscreen => {
            if let Some(w) = &window {
                let _ = w.set_fullscreen(!w.is_fullscreen().unwrap_or(false));
            }
        }
        Action::Minimize => {
            if let Some(w) = &window {
                let _ = w.minimize();
            }
        }
        Action::ToggleMaximize => {
            if let Some(w) = &window {
                let _ = if w.is_maximized().unwrap_or(false) {
                    w.unmaximize()
                } else {
                    w.maximize()
                };
            }
        }
    }
}

/// Builds the `main` window from `tauri.conf.json` (`create: false`) with link routing.
pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    if let Ok(dir) = app.path().config_dir() {
        if let Ok(home) = app.path().home_dir() {
            migrate_data_dir(
                &dir.join("SaiLoR"),
                &home.join(crate::localruntime::DATA_DIR_NAME),
            );
        }
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
    macos_menu(app)?;
    #[cfg(not(target_os = "macos"))]
    app.set_menu(menu(app)?)?;
    app.on_menu_event(|app, e| {
        if let Some(act) = action(e.id().as_ref()) {
            run(app, act);
        }
    });
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

/// Moves the 1.x data folder (`<config>/SaiLoR`) to `~/.sailor` once, only if the new
/// folder does not exist. Falls back to a copy when a rename is not possible.
/// Best effort: errors are logged, startup goes on.
pub fn migrate_data_dir(old: &Path, new: &Path) {
    if new.exists() || !old.is_dir() {
        return;
    }
    if std::fs::rename(old, new).is_err() {
        if let Err(e) = copy_new(old, new) {
            eprintln!("Could not migrate {}: {e}", old.display());
            return;
        }
    }
    hide(new);
}

#[cfg(windows)]
pub fn hide(dir: &Path) {
    let _ = std::process::Command::new("attrib")
        .arg("+h")
        .arg(dir)
        .status();
}

#[cfg(not(windows))]
pub fn hide(_dir: &Path) {}

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

/// The default macOS menu, with Settings in the app menu (`app:settings`) and the app
/// history for Undo and Redo (`app:undo`, `app:redo`).
/// The page sees Cmd+Z first; the menu item fires only when the page did not handle it.
#[cfg(target_os = "macos")]
fn macos_menu(app: &App) -> tauri::Result<()> {
    use tauri::menu::MenuItemKind;
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let app_name = app.package_info().name.clone();
    for item in menu.items()? {
        let MenuItemKind::Submenu(sub) = item else {
            continue;
        };
        match sub.text()?.as_str() {
            name if name == app_name => {
                sub.insert_items(
                    &[
                        &MenuItem::with_id(
                            app,
                            "app:settings",
                            "Settings…",
                            true,
                            Some("CmdOrCtrl+,"),
                        )?,
                        &PredefinedMenuItem::separator(app)?,
                    ],
                    2,
                )?;
            }
            "Edit" => {
                sub.remove_at(0)?;
                sub.remove_at(0)?;
                sub.prepend_items(&[
                    &MenuItem::with_id(app, "app:undo", "Undo", true, Some("CmdOrCtrl+Z"))?,
                    &MenuItem::with_id(app, "app:redo", "Redo", true, Some("CmdOrCtrl+Shift+Z"))?,
                ])?;
            }
            "View" => {
                sub.prepend_items(&[
                    &MenuItem::with_id(app, "app:reload", "Reload", true, Some("CmdOrCtrl+R"))?,
                    &PredefinedMenuItem::separator(app)?,
                ])?;
            }
            _ => {}
        }
    }
    Ok(())
}

/// Windows and Linux have no default menu bar. This builds the Electron menus.
#[cfg(not(target_os = "macos"))]
fn menu(app: &App) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, Submenu};
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "app:settings", "Settings…", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "app:closeProject", "Close project", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "app:quit", "Quit", true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &MenuItem::with_id(app, "app:undo", "Undo", true, Some("CmdOrCtrl+Z"))?,
            &MenuItem::with_id(app, "app:redo", "Redo", true, Some("CmdOrCtrl+Shift+Z"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, "app:reload", "Reload", true, Some("CmdOrCtrl+R"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "app:fullscreen", "Full Screen", true, Some("F11"))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &MenuItem::with_id(app, "app:minimize", "Minimize", true, None::<&str>)?,
            &MenuItem::with_id(app, "app:maximize", "Maximize/Restore", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "app:closeWindow", "Close", true, None::<&str>)?,
        ],
    )?;
    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &MenuItem::with_id(app, "app:github", "Project on GitHub", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "app:about", "About SaiLoR", true, None::<&str>)?,
        ],
    )?;
    Menu::with_items(app, &[&file, &edit, &view, &window, &help])
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

    #[test]
    fn data_dir_moves_once_and_never_overwrites() {
        let root = std::env::temp_dir().join(format!("sailor-data-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (old, new) = (root.join("SaiLoR"), root.join(".sailor"));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("llm-config.json"), "old").unwrap();
        migrate_data_dir(&old, &new);
        assert_eq!(
            std::fs::read_to_string(new.join("llm-config.json")).unwrap(),
            "old"
        );
        assert!(!old.exists());
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("llm-config.json"), "again").unwrap();
        migrate_data_dir(&old, &new);
        assert_eq!(
            std::fs::read_to_string(new.join("llm-config.json")).unwrap(),
            "old"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn menu_ids_map_to_actions() {
        assert_eq!(action("app:reload"), Some(Action::Reload));
        assert_eq!(action("app:quit"), Some(Action::Quit));
        assert_eq!(action("app:closeWindow"), Some(Action::CloseWindow));
        assert_eq!(action("app:fullscreen"), Some(Action::Fullscreen));
        assert_eq!(action("app:maximize"), Some(Action::ToggleMaximize));
        assert_eq!(action("app:github"), Some(Action::Github));
        assert_eq!(action("app:about"), Some(Action::About));
        for event in ["app:undo", "app:redo", "app:closeProject", "app:settings"] {
            assert_eq!(action(event), Some(Action::Emit(event)));
        }
        assert_eq!(action("tauri:quit"), None);
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
