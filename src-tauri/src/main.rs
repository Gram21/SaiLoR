#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod authz;
mod feedback;
mod paths;
mod pdf;
mod project;
mod protocol;

use authz::Session;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

/// CI probe: open `$SPIKE_PROJECT` without a dialog.
#[tauri::command]
async fn spike_auto(session: State<'_, Mutex<Session>>) -> Result<Option<project::Opened>, String> {
    let Ok(path) = std::env::var("SPIKE_PROJECT") else {
        return Ok(None);
    };
    let path = PathBuf::from(path);
    let opened = project::read_project(&session, &path).ok();
    if opened.is_some() {
        project::set_dir(&session, &path);
    }
    Ok(opened)
}

/// CI probe: append a line to `$SPIKE_REPORT`.
#[tauri::command]
fn spike_report(line: String) {
    if let Ok(out) = std::env::var("SPIKE_REPORT") {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(out)
        {
            let _ = writeln!(f, "{line}");
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(Session::default()))
        .register_asynchronous_uri_scheme_protocol("slr-file", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                responder.respond(protocol::serve(&app.state::<Mutex<Session>>(), &req))
            });
        })
        .invoke_handler(tauri::generate_handler![
            spike_auto,
            spike_report,
            project::project_open,
            project::project_open_path,
            project::project_save,
            project::project_set_dir,
            project::project_pick_save_path,
            project::project_peek,
            feedback::project_write_feedback,
            feedback::project_list_feedback,
            pdf::pdf_pick,
            pdf::pdf_pick_folder,
            pdf::pdf_read,
            pdf::pdf_check_path,
            pdf::pdf_allow_path,
            pdf::pdf_pick_export_path,
            pdf::text_pick_export_path,
            paths::paths_relative,
            paths::paths_rebase,
            paths::paths_absolute,
            paths::paths_sibling,
        ])
        .run(tauri::generate_context!())
        .expect("tauri run failed");
}
