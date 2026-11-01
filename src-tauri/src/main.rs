#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::http::{Response, StatusCode};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct ProjectDir(Mutex<Option<PathBuf>>);

#[derive(serde::Serialize)]
struct Opened {
    path: String,
    text: String,
}

#[tauri::command]
async fn project_open(app: tauri::AppHandle, dir: State<'_, ProjectDir>) -> Result<Option<Opened>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Project", &["json"])
        .blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    *dir.0.lock().unwrap() = path.parent().map(|p| p.to_path_buf());
    Ok(Some(Opened { path: path.display().to_string(), text }))
}

#[tauri::command]
fn spike_auto(dir: State<'_, ProjectDir>) -> Option<Opened> {
    let path = PathBuf::from(std::env::var("SPIKE_PROJECT").ok()?);
    let text = std::fs::read_to_string(&path).ok()?;
    *dir.0.lock().unwrap() = path.parent().map(|p| p.to_path_buf());
    Some(Opened { path: path.display().to_string(), text })
}

#[tauri::command]
fn spike_report(line: String) {
    if let Ok(out) = std::env::var("SPIKE_REPORT") {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(out) {
            let _ = writeln!(f, "{line}");
        }
    }
}

fn serve(app: &tauri::AppHandle, uri: &str) -> Response<Vec<u8>> {
    let status = |s: StatusCode, m: &str| Response::builder().status(s).header("Access-Control-Allow-Origin", "*").body(m.as_bytes().to_vec()).unwrap();
    let query = uri.split_once('?').map(|(_, q)| q).unwrap_or("");
    let rel = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("path="))
        .map(|v| percent_encoding::percent_decode_str(v).decode_utf8_lossy().into_owned())
        .unwrap_or_default();
    let Some(base) = app.state::<ProjectDir>().0.lock().unwrap().clone() else {
        return status(StatusCode::NOT_FOUND, "No project open");
    };
    let Ok(base) = base.canonicalize() else { return status(StatusCode::NOT_FOUND, "No project open") };
    let Ok(real) = base.join(&rel).canonicalize() else { return status(StatusCode::NOT_FOUND, "Not found") };
    if !real.starts_with(&base) {
        return status(StatusCode::FORBIDDEN, "Forbidden");
    }
    match std::fs::read(&real) {
        Ok(bytes) => Response::builder()
            .header("Content-Type", "application/pdf")
            .header("Access-Control-Allow-Origin", "*")
            .body(bytes)
            .unwrap(),
        Err(_) => status(StatusCode::NOT_FOUND, "Not found"),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ProjectDir::default())
        .register_uri_scheme_protocol("slr-file", |ctx, req| serve(ctx.app_handle(), &req.uri().to_string()))
        .invoke_handler(tauri::generate_handler![project_open, spike_auto, spike_report])
        .run(tauri::generate_context!())
        .expect("tauri run failed");
}
