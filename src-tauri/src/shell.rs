//! Desktop shell behavior of the main window.

use crate::close;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::NewWindowResponse;
use tauri::{App, AppHandle, Emitter, Manager, Url, WebviewWindowBuilder, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const REPO_URL: &str = "https://github.com/Gram21/SaiLoR";

static LANGUAGE: AtomicUsize = AtomicUsize::new(usize::MAX);

// [impl->req~plt-400~1]
/// German texts of the native menu labels and the About dialog.
const DE: &[(&str, &str)] = &[
    ("File", "Datei"),
    ("Edit", "Bearbeiten"),
    ("View", "Ansicht"),
    ("Window", "Fenster"),
    ("Help", "Hilfe"),
    ("Settings…", "Einstellungen…"),
    ("Close project", "Projekt schließen"),
    ("Quit", "Beenden"),
    ("Quit SaiLoR", "SaiLoR beenden"),
    ("Undo", "Rückgängig"),
    ("Redo", "Wiederholen"),
    ("Cut", "Ausschneiden"),
    ("Copy", "Kopieren"),
    ("Paste", "Einfügen"),
    ("Select All", "Alles auswählen"),
    ("Reload", "Neu laden"),
    ("Full Screen", "Vollbild"),
    ("Minimize", "Minimieren"),
    ("Maximize/Restore", "Maximieren/Wiederherstellen"),
    ("Zoom", "Zoomen"),
    ("Close", "Schließen"),
    ("Close Window", "Fenster schließen"),
    ("Services", "Dienste"),
    ("Hide SaiLoR", "SaiLoR ausblenden"),
    ("Hide Others", "Andere ausblenden"),
    ("Project on GitHub", "Projekt auf GitHub"),
    ("About SaiLoR", "Über SaiLoR"),
    ("Version", "Version"),
];

// [impl->req~plt-400~1]
/// Italian texts of the native menu labels and the About dialog.
const IT: &[(&str, &str)] = &[
    ("File", "File"),
    ("Edit", "Modifica"),
    ("View", "Vista"),
    ("Window", "Finestra"),
    ("Help", "Aiuto"),
    ("Settings…", "Impostazioni…"),
    ("Close project", "Chiudi progetto"),
    ("Quit", "Esci"),
    ("Quit SaiLoR", "Esci da SaiLoR"),
    ("Undo", "Annulla"),
    ("Redo", "Ripeti"),
    ("Cut", "Taglia"),
    ("Copy", "Copia"),
    ("Paste", "Incolla"),
    ("Select All", "Seleziona tutto"),
    ("Reload", "Ricarica"),
    ("Full Screen", "Schermo intero"),
    ("Minimize", "Riduci a icona"),
    ("Maximize/Restore", "Ingrandisci/Ripristina"),
    ("Zoom", "Zoom"),
    ("Close", "Chiudi"),
    ("Close Window", "Chiudi finestra"),
    ("Services", "Servizi"),
    ("Hide SaiLoR", "Nascondi SaiLoR"),
    ("Hide Others", "Nascondi altre"),
    ("Project on GitHub", "Progetto su GitHub"),
    ("About SaiLoR", "Informazioni su SaiLoR"),
    ("Version", "Versione"),
];

// [impl->req~plt-400~1]
/// Portuguese texts of the native menu labels and the About dialog.
const PT: &[(&str, &str)] = &[
    ("File", "Arquivo"),
    ("Edit", "Editar"),
    ("View", "Exibir"),
    ("Window", "Janela"),
    ("Help", "Ajuda"),
    ("Settings…", "Configurações…"),
    ("Close project", "Fechar projeto"),
    ("Quit", "Sair"),
    ("Quit SaiLoR", "Sair do SaiLoR"),
    ("Undo", "Desfazer"),
    ("Redo", "Refazer"),
    ("Cut", "Recortar"),
    ("Copy", "Copiar"),
    ("Paste", "Colar"),
    ("Select All", "Selecionar tudo"),
    ("Reload", "Recarregar"),
    ("Full Screen", "Tela cheia"),
    ("Minimize", "Minimizar"),
    ("Maximize/Restore", "Maximizar/Restaurar"),
    ("Zoom", "Zoom"),
    ("Close", "Fechar"),
    ("Close Window", "Fechar janela"),
    ("Services", "Serviços"),
    ("Hide SaiLoR", "Ocultar SaiLoR"),
    ("Hide Others", "Ocultar outros"),
    ("Project on GitHub", "Projeto no GitHub"),
    ("About SaiLoR", "Sobre o SaiLoR"),
    ("Version", "Versão"),
];

// [impl->req~plt-400~1]
/// The menu tables by UI language code. English needs no table.
const TABLES: &[(&str, &[(&str, &str)])] = &[("de", DE), ("it", IT), ("pt", PT)];

// [impl->req~plt-400~1]
/// The text of a menu label in the active language. English is the fallback.
fn tr(en: &'static str) -> &'static str {
    TABLES
        .get(LANGUAGE.load(Relaxed))
        .and_then(|(_, table)| table.iter().find(|(k, _)| *k == en))
        .map_or(en, |(_, text)| text)
}

// [impl->req~plt-400~1]
/// The renderer sends the UI language at start and after each change.
#[tauri::command]
pub fn app_set_language(app: AppHandle, lang: String) -> Result<(), String> {
    let index = TABLES.iter().position(|(code, _)| *code == lang);
    LANGUAGE.store(index.unwrap_or(usize::MAX), Relaxed);
    app.set_menu(build_menu(&app).map_err(|e| e.to_string())?)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn build_menu<M: Manager<Wry>>(app: &M) -> tauri::Result<Menu<Wry>> {
    if cfg!(target_os = "macos") {
        macos_menu(app)
    } else {
        menu(app)
    }
}

// [impl->req~plt-250~1]
/// Only these schemes leave the app, in the system browser.
pub fn is_external(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

// [impl->req~plt-250~1]
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

// [impl->req~ui-100~1]
// [impl->req~plt-120~1]
// [impl->req~plt-310~1]
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

// [impl->req~plt-120~1]
// [impl->req~plt-310~1]
// [impl->req~plt-370~1]
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
                .message(format!("{} {}", tr("Version"), app.package_info().version))
                .title(tr("About SaiLoR"))
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

// [impl->req~plt-250~1]
// [impl->req~plt-390~1]
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
    app.set_menu(build_menu(app.handle())?)?;
    app.on_menu_event(|app, e| {
        if let Some(act) = action(e.id().as_ref()) {
            run(app, act);
        }
    });
    Ok(())
}

// [impl->req~plt-11~1]
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

// [impl->req~plt-180~1]
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

// [impl->req~plt-390~1]
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

// [impl->req~plt-180~1]
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

// [impl->req~ui-100~1]
// [impl->req~plt-120~1]
// [impl->req~plt-310~1]
// [impl->req~plt-370~1]
// [impl->req~plt-400~1]
/// The default macOS menu, with Settings in the app menu (`app:settings`) and the app
/// history for Undo and Redo (`app:undo`, `app:redo`).
/// The page sees Cmd+Z first; the menu item fires only when the page did not handle it.
fn macos_menu<M: Manager<Wry>>(app: &M) -> tauri::Result<Menu<Wry>> {
    use tauri::menu::{HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app.config().bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let app_menu = Submenu::with_items(
        app,
        info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, Some(tr("About SaiLoR")), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "app:settings",
                tr("Settings…"),
                true,
                Some("CmdOrCtrl+,"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some(tr("Services")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(tr("Hide SaiLoR")))?,
            &PredefinedMenuItem::hide_others(app, Some(tr("Hide Others")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(tr("Quit SaiLoR")))?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        tr("File"),
        true,
        &[&PredefinedMenuItem::close_window(
            app,
            Some(tr("Close Window")),
        )?],
    )?;
    let edit = Submenu::with_items(
        app,
        tr("Edit"),
        true,
        &[
            &MenuItem::with_id(app, "app:undo", tr("Undo"), true, Some("CmdOrCtrl+Z"))?,
            &MenuItem::with_id(app, "app:redo", tr("Redo"), true, Some("CmdOrCtrl+Shift+Z"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(tr("Cut")))?,
            &PredefinedMenuItem::copy(app, Some(tr("Copy")))?,
            &PredefinedMenuItem::paste(app, Some(tr("Paste")))?,
            &PredefinedMenuItem::select_all(app, Some(tr("Select All")))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        tr("View"),
        true,
        &[
            &MenuItem::with_id(app, "app:reload", tr("Reload"), true, Some("CmdOrCtrl+R"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, Some(tr("Full Screen")))?,
        ],
    )?;
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        tr("Window"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(tr("Minimize")))?,
            &PredefinedMenuItem::maximize(app, Some(tr("Zoom")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some(tr("Close Window")))?,
        ],
    )?;
    let help = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, tr("Help"), true, &[])?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
}

// [impl->req~ui-100~1]
// [impl->req~plt-120~1]
// [impl->req~plt-310~1]
// [impl->req~plt-370~1]
// [impl->req~plt-400~1]
/// Windows and Linux have no default menu bar. This builds the Electron menus.
fn menu<M: Manager<Wry>>(app: &M) -> tauri::Result<Menu<Wry>> {
    let file = Submenu::with_items(
        app,
        tr("File"),
        true,
        &[
            &MenuItem::with_id(
                app,
                "app:settings",
                tr("Settings…"),
                true,
                Some("CmdOrCtrl+,"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "app:closeProject",
                tr("Close project"),
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "app:quit", tr("Quit"), true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        tr("Edit"),
        true,
        &[
            &MenuItem::with_id(app, "app:undo", tr("Undo"), true, Some("CmdOrCtrl+Z"))?,
            &MenuItem::with_id(app, "app:redo", tr("Redo"), true, Some("CmdOrCtrl+Shift+Z"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(tr("Cut")))?,
            &PredefinedMenuItem::copy(app, Some(tr("Copy")))?,
            &PredefinedMenuItem::paste(app, Some(tr("Paste")))?,
            &PredefinedMenuItem::select_all(app, Some(tr("Select All")))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        tr("View"),
        true,
        &[
            &MenuItem::with_id(app, "app:reload", tr("Reload"), true, Some("CmdOrCtrl+R"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "app:fullscreen", tr("Full Screen"), true, Some("F11"))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        tr("Window"),
        true,
        &[
            &MenuItem::with_id(app, "app:minimize", tr("Minimize"), true, None::<&str>)?,
            &MenuItem::with_id(
                app,
                "app:maximize",
                tr("Maximize/Restore"),
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "app:closeWindow", tr("Close"), true, None::<&str>)?,
        ],
    )?;
    let help = Submenu::with_items(
        app,
        tr("Help"),
        true,
        &[
            &MenuItem::with_id(
                app,
                "app:github",
                tr("Project on GitHub"),
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "app:about", tr("About SaiLoR"), true, None::<&str>)?,
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

    // [utest->req~plt-250~1]
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

    // [utest->req~plt-250~1]
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

    // [utest->req~plt-390~1]
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

    // [utest->req~plt-120~1]
    // [utest->req~plt-310~1]
    // [utest->req~plt-370~1]
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

    // [utest->req~plt-400~1]
    #[test]
    fn every_menu_label_has_an_entry_in_every_language() {
        let needle = format!("{}(\"", "tr");
        let source = include_str!("shell.rs");
        let labels: Vec<&str> = source
            .split(needle.as_str())
            .skip(1)
            .filter_map(|rest| rest.split('"').next())
            .collect();
        assert!(labels.len() > 20, "{labels:?}");
        let languages = include_str!("../../src/state/settings.ts")
            .split("LANGUAGES = [")
            .nth(1)
            .and_then(|rest| rest.split(']').next())
            .expect("LANGUAGES in settings.ts");
        let codes: Vec<&str> = languages
            .split(',')
            .map(|code| code.trim().trim_matches('\''))
            .filter(|code| *code != "en")
            .collect();
        assert!(!codes.is_empty(), "{languages}");
        for code in &codes {
            assert!(
                TABLES.iter().any(|(c, _)| c == code),
                "no menu table for {code}"
            );
        }
        for (code, table) in TABLES {
            for label in &labels {
                let entry = table.iter().find(|(en, _)| en == label);
                assert!(
                    entry.is_some_and(|(_, text)| !text.is_empty()),
                    "no {code} text for {label}"
                );
            }
            for (en, _) in *table {
                assert!(labels.contains(en), "unused {code} entry {en}");
            }
        }
        LANGUAGE.store(0, Relaxed);
        assert_eq!(tr("Edit"), "Bearbeiten");
        LANGUAGE.store(usize::MAX, Relaxed);
        assert_eq!(tr("Edit"), "Edit");
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("sailor-rs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    // [utest->req~plt-180~1]
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

    // [utest->req~plt-180~1]
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

    // [utest->req~plt-180~1]
    #[test]
    fn migration_without_legacy_creates_nothing() {
        let root = tmp("nolegacy");
        migrate_legacy(&root);
        assert!(!root.join("SaiLoR").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
