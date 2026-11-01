//! Desktop shell behavior of the main window.

use tauri::{AppHandle, Manager};

/// A second launch exits; the running instance comes to the front.
pub fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}
