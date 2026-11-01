//! `pdf:*` and `text:pickExportPath`, plus the project-bound PDF resolution the
//! `slr-file` protocol shares.

use crate::authz::{err, lock, within, Session};
use crate::paths::{normalize, resolve};
use crate::project::save_dialog;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{ipc::Response, AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// `resolveProjectPath`: the real file `rel` names inside the open project's
/// directory, or why not (`no-project`, `escapes`, `not-found`).
pub fn resolve_project_path(session: &Mutex<Session>, rel: &str) -> Result<PathBuf, &'static str> {
    let (dir, allowed) = {
        let s = lock(session);
        (s.project_dir.clone(), s.allowed_escapes.contains(rel))
    };
    let Some(dir) = dir else {
        return Err("no-project");
    };
    let base = normalize(&dir);
    let resolved = resolve(&base, Path::new(rel));
    let within_base = within(&resolved, &base);
    if !within_base && !allowed {
        return Err("escapes");
    }
    let real = resolved.canonicalize().map_err(|_| "not-found")?;
    if within_base {
        let real_base = base.canonicalize().map_err(|_| "no-project")?;
        if !within(&real, &real_base) {
            return Err("escapes");
        }
    }
    Ok(real)
}

#[tauri::command]
pub async fn pdf_check_path(
    session: State<'_, Mutex<Session>>,
    rel: String,
) -> Result<Value, String> {
    Ok(match resolve_project_path(&session, &rel) {
        Ok(_) => json!({ "ok": true }),
        Err(reason) => json!({ "ok": false, "reason": reason }),
    })
}

fn readable(session: &Mutex<Session>, paths: Vec<PathBuf>) -> Vec<String> {
    let mut s = lock(session);
    paths
        .into_iter()
        .map(|p| {
            s.readable_pdfs.insert(normalize(&p));
            p.display().to_string()
        })
        .collect()
}

#[tauri::command]
pub async fn pdf_pick(
    app: AppHandle,
    session: State<'_, Mutex<Session>>,
) -> Result<Vec<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Add PDFs")
        .add_filter("PDF", &["pdf"])
        .blocking_pick_files();
    let paths = picked
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.into_path().map_err(err))
        .collect::<Result<_, _>>()?;
    Ok(readable(&session, paths))
}

/// `collectPdfsRecursive`: links are neither followed nor returned; unreadable folders skipped.
pub fn collect_pdfs(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let Ok(t) = e.file_type() else { continue };
        if t.is_dir() {
            collect_pdfs(&e.path(), out);
        } else if t.is_file()
            && e.file_name()
                .to_string_lossy()
                .to_lowercase()
                .ends_with(".pdf")
        {
            out.push(e.path());
        }
    }
}

#[tauri::command]
pub async fn pdf_pick_folder(
    app: AppHandle,
    session: State<'_, Mutex<Session>>,
) -> Result<Vec<String>, String> {
    let Some(dir) = app
        .dialog()
        .file()
        .set_title("Add a folder of PDFs")
        .blocking_pick_folder()
    else {
        return Ok(vec![]);
    };
    let mut paths = vec![];
    collect_pdfs(&dir.into_path().map_err(err)?, &mut paths);
    Ok(readable(&session, paths))
}

#[tauri::command]
pub async fn pdf_read(
    session: State<'_, Mutex<Session>>,
    file_path: String,
) -> Result<Response, String> {
    if !lock(&session)
        .readable_pdfs
        .contains(&normalize(Path::new(&file_path)))
    {
        return Err(format!(
            "\"{file_path}\" was not selected via a file picker."
        ));
    }
    fs::read(&file_path).map(Response::new).map_err(err)
}

#[tauri::command]
pub async fn pdf_allow_path(
    app: AppHandle,
    session: State<'_, Mutex<Session>>,
    rel: String,
) -> Result<bool, String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(false);
    };
    // ponytail: no defaultId in the plugin, so Enter may pick "Open anyway"; a custom dialog if that matters.
    let approved = app
        .dialog()
        .message(format!(
            "PDF \"{rel}\" is stored outside this project's own folder.\n\n\
             Opening it means reading a file at a path the project itself names. If you didn't author this \
             project yourself — it came from a collaborator, or somewhere else — that path could point at a file \
             on your disk you didn't intend to share. Only continue if you trust where this project came from."
        ))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Open anyway".into(), "Cancel".into()))
        .parent(&window)
        .blocking_show();
    if approved {
        lock(&session).allowed_escapes.insert(rel);
    }
    Ok(approved)
}

fn export_path(
    app: &AppHandle,
    session: &Mutex<Session>,
    title: &str,
    suggested: &str,
    filter: (&str, &[&str]),
) -> Result<Option<String>, String> {
    let Some(p) = save_dialog(app, title, suggested, filter)? else {
        return Ok(None);
    };
    lock(session).writable_exports.insert(normalize(&p));
    Ok(Some(p.display().to_string()))
}

#[tauri::command]
pub async fn pdf_pick_export_path(
    app: AppHandle,
    session: State<'_, Mutex<Session>>,
    suggested_name: String,
) -> Result<Option<String>, String> {
    export_path(
        &app,
        &session,
        "Export annotated PDF",
        &suggested_name,
        ("PDF", &["pdf"]),
    )
}

#[tauri::command]
pub async fn text_pick_export_path(
    app: AppHandle,
    session: State<'_, Mutex<Session>>,
    suggested_name: String,
) -> Result<Option<String>, String> {
    export_path(
        &app,
        &session,
        "Export as text",
        &suggested_name,
        ("Text", &["txt"]),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::tests::tmp;

    #[test]
    fn project_path_resolution() {
        let d = tmp("pdfres");
        let proj = d.join("proj");
        fs::create_dir_all(proj.join("pdfs")).unwrap();
        fs::write(proj.join("pdfs/a.pdf"), "%PDF").unwrap();
        fs::write(d.join("outside.pdf"), "%PDF").unwrap();
        let s = Mutex::new(Session::default());
        let real = |p: PathBuf| Ok(p.canonicalize().unwrap());
        assert_eq!(resolve_project_path(&s, "pdfs/a.pdf"), Err("no-project"));
        lock(&s).project_dir = Some(proj.clone());
        assert_eq!(
            resolve_project_path(&s, "pdfs/a.pdf"),
            real(proj.join("pdfs/a.pdf"))
        );
        assert_eq!(
            resolve_project_path(&s, "pdfs/../pdfs/a.pdf"),
            real(proj.join("pdfs/a.pdf"))
        );
        assert_eq!(resolve_project_path(&s, "../outside.pdf"), Err("escapes"));
        assert_eq!(resolve_project_path(&s, "nope.pdf"), Err("not-found"));
        lock(&s).allowed_escapes.insert("../outside.pdf".into());
        assert_eq!(
            resolve_project_path(&s, "../outside.pdf"),
            real(d.join("outside.pdf"))
        );
        assert_eq!(resolve_project_path(&s, "../missing.pdf"), Err("escapes"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_inside_project_pointing_out_is_an_escape() {
        let d = tmp("pdflink");
        fs::create_dir_all(d.join("proj")).unwrap();
        fs::write(d.join("secret"), "x").unwrap();
        std::os::unix::fs::symlink(d.join("secret"), d.join("proj/a.pdf")).unwrap();
        let s = Mutex::new(Session::default());
        lock(&s).project_dir = Some(d.join("proj"));
        assert_eq!(resolve_project_path(&s, "a.pdf"), Err("escapes"));
    }

    #[test]
    fn folder_walk_finds_pdfs_case_insensitively() {
        let d = tmp("walk");
        fs::create_dir_all(d.join("a/b")).unwrap();
        for f in ["x.pdf", "a/Y.PDF", "a/b/z.pdf", "a/notes.txt"] {
            fs::write(d.join(f), "").unwrap();
        }
        let mut out = vec![];
        collect_pdfs(&d, &mut out);
        out.sort();
        assert_eq!(
            out,
            [d.join("a/Y.PDF"), d.join("a/b/z.pdf"), d.join("x.pdf")]
        );
    }
}
