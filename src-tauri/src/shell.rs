//! Desktop shell behavior of the main window.

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

}
