//! `pdf:*` and `text:*`, plus the project-bound PDF resolution the `slr-file`
//! protocol shares.

use crate::authz::{assert_not_symlink, err, lock, within, Session};
use crate::paths::{normalize, resolve};
use crate::project::save_dialog;
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, StringFormat};
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

// ---- `pdf:embedMarks` and `text:write` ----

/// `{ ok: true, path }` or `{ ok: false, error }`, like the Electron handlers.
fn outcome(r: Result<String, String>) -> Value {
    match r {
        Ok(path) => json!({ "ok": true, "path": path }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

/// `writableExportPaths`: only a path the export dialog returned this session.
fn export_target(session: &Mutex<Session>, dest: &str) -> Result<(), String> {
    if lock(session)
        .writable_exports
        .contains(&normalize(Path::new(dest)))
    {
        Ok(())
    } else {
        Err(format!("\"{dest}\" was not chosen via the export dialog."))
    }
}

fn write_file(dest: &str, bytes: &[u8]) -> Result<String, String> {
    assert_not_symlink(Path::new(dest))?;
    fs::write(dest, bytes).map_err(err)?;
    Ok(dest.to_string())
}

#[tauri::command]
pub async fn text_write(
    session: State<'_, Mutex<Session>>,
    abs_path: String,
    text: String,
) -> Result<Value, String> {
    Ok(outcome(write_text(&session, &abs_path, &text)))
}

fn write_text(session: &Mutex<Session>, abs_path: &str, text: &str) -> Result<String, String> {
    export_target(session, abs_path)?;
    write_file(abs_path, text.as_bytes())
}

/// The real file of a PDF the open project references: inside the project
/// directory, or an outside path the reviewer approved (`allowed_escapes`).
/// The same set `slr-file` serves, so this command reads nothing new.
fn project_pdf(session: &Mutex<Session>, abs: &str) -> Result<PathBuf, String> {
    let refused = || format!("\"{abs}\" is not a PDF of the open project.");
    let (dir, escapes) = {
        let s = lock(session);
        let escapes: Vec<String> = s.allowed_escapes.iter().cloned().collect();
        (s.project_dir.clone(), escapes)
    };
    let dir = dir.ok_or_else(refused)?;
    let real = Path::new(abs)
        .canonicalize()
        .map_err(|e| format!("Could not open the PDF: {e}"))?;
    let inside = normalize(&dir)
        .canonicalize()
        .is_ok_and(|base| within(&real, &base));
    let approved = || {
        escapes
            .iter()
            .any(|rel| resolve_project_path(session, rel).as_ref() == Ok(&real))
    };
    if inside || approved() {
        Ok(real)
    } else {
        Err(refused())
    }
}

/// The fields of a `PdfMark` the export uses.
struct Mark {
    page: u32,
    /// `[x, y, width, height]` as fractions of the page, top-left origin.
    rects: Vec<[f64; 4]>,
    color: String,
    comment: String,
    created_at: String,
    updated_at: String,
    note: bool,
}

fn rect_of(v: &Value) -> Option<[f64; 4]> {
    let n = |k| v.get(k)?.as_f64().filter(|n| n.is_finite());
    Some([n("x")?, n("y")?, n("width")?, n("height")?])
}

/// `parseMarks` from src/model/pdfMarks.ts: a malformed entry is dropped.
fn parse_marks(raw: &Value) -> Vec<Mark> {
    let text = |e: &Value, k| e.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let Some(list) = raw.as_array() else {
        return vec![];
    };
    list.iter()
        .filter_map(|e| {
            e.get("id")?.as_str().filter(|s| !s.is_empty())?;
            let page = e.get("page")?.as_u64().filter(|p| *p >= 1)?;
            let rects = e.get("rects")?.as_array()?;
            let rects = rects.iter().map(rect_of).collect::<Option<Vec<_>>>()?;
            let color = e.get("color")?.as_str().filter(|s| !s.is_empty())?;
            (!rects.is_empty()).then(|| Mark {
                page: u32::try_from(page).unwrap_or(u32::MAX),
                rects,
                color: color.to_string(),
                comment: text(e, "comment"),
                created_at: text(e, "createdAt"),
                updated_at: text(e, "updatedAt"),
                note: e.get("kind").and_then(Value::as_str) == Some("note"),
            })
        })
        .collect()
}

/// `hexToRgb01`: `#rrggbb` to 0..1 floats, highlighter yellow when malformed.
fn rgb01(hex: &str) -> Vec<Object> {
    let h = hex.strip_prefix('#').unwrap_or(hex);
    let rgb = (h.len() == 6 && h.is_ascii())
        .then(|| {
            (0..3)
                .map(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).map(|c| f64::from(c) / 255.0))
                .collect::<Result<Vec<_>, _>>()
                .ok()
        })
        .flatten()
        .unwrap_or_else(|| vec![1.0, 0.88, 0.4]);
    rgb.into_iter().map(Object::from).collect()
}

/// `PDFString.fromDate`: `D:YYYYMMDDHHmmSSZ` in UTC, or none when unparseable.
fn pdf_date(iso: &str) -> Option<Object> {
    let d = chrono::DateTime::parse_from_rfc3339(iso).ok()?;
    let s = d.with_timezone(&chrono::Utc).format("D:%Y%m%d%H%M%SZ");
    Some(Object::string_literal(s.to_string()))
}

/// `PDFHexString.fromText`: UTF-16BE with a byte order mark.
fn pdf_text(s: &str) -> Object {
    let mut b = vec![0xFE, 0xFF];
    b.extend(s.encode_utf16().flat_map(u16::to_be_bytes));
    Object::String(b, StringFormat::Hexadecimal)
}

/// `rectToPdfPoints` from src/model/pdfExport.ts: `[x, y, width, height]` in points.
fn to_points(r: [f64; 4], w: f64, h: f64) -> [f64; 4] {
    let height = r[3] * h;
    [r[0] * w, h - r[1] * h - height, r[2] * w, height]
}

fn reals(v: &[f64]) -> Object {
    Object::Array(v.iter().copied().map(Object::from).collect())
}

/// Width and height of the page's MediaBox, inherited from the page tree.
/// US Letter when no node has one.
fn page_size(doc: &Document, page: ObjectId) -> (f64, f64) {
    let mut node = doc.get_dictionary(page).ok();
    for _ in 0..64 {
        let Some(d) = node else { break };
        let b = d
            .get(b"MediaBox")
            .and_then(|o| doc.dereference(o))
            .and_then(|(_, o)| o.as_array());
        if let Ok([x1, y1, x2, y2]) = b.map(Vec::as_slice) {
            let f = |o: &Object| o.as_float().map(f64::from).unwrap_or(0.0);
            return (f(x2) - f(x1), f(y2) - f(y1));
        }
        node = d
            .get(b"Parent")
            .and_then(Object::as_reference)
            .and_then(|id| doc.get_dictionary(id))
            .ok();
    }
    (612.0, 792.0)
}

fn annotation(m: &Mark, w: f64, h: f64) -> Dictionary {
    let mut d = dictionary! {
        "Type" => "Annot",
        "C" => rgb01(&m.color),
        "Contents" => pdf_text(&m.comment),
        "T" => Object::string_literal("SaiLoR"),
    };
    if m.note {
        const ICON: f64 = 20.0;
        let [x, y, ..] = to_points([m.rects[0][0], m.rects[0][1], 0.0, 0.0], w, h);
        let half = ICON / 2.0;
        d.set("Subtype", "Text");
        d.set("Rect", reals(&[x - half, y - half, x + half, y + half]));
        d.set("Name", "Comment");
        d.set("Open", false);
    } else {
        let (mut quads, mut bbox) = (
            vec![],
            [
                f64::INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::NEG_INFINITY,
            ],
        );
        for r in &m.rects {
            let [x, y, rw, rh] = to_points(*r, w, h);
            quads.extend([x, y + rh, x + rw, y + rh, x, y, x + rw, y]);
            bbox = [
                bbox[0].min(x),
                bbox[1].min(y),
                bbox[2].max(x + rw),
                bbox[3].max(y + rh),
            ];
        }
        d.set("Subtype", "Highlight");
        d.set("Rect", reals(&bbox));
        d.set("QuadPoints", reals(&quads));
        d.set("CA", 0.4);
    }
    if let Some(date) = pdf_date(&m.created_at) {
        d.set("CreationDate", date);
    }
    if let Some(date) = pdf_date(&m.updated_at) {
        d.set("M", date);
    }
    d
}

/// Append `annot` to the page's `/Annots`, direct or referenced, so existing annotations stay.
fn add_annot(doc: &mut Document, page: ObjectId, annot: ObjectId) -> lopdf::Result<()> {
    let existing = doc.get_dictionary(page)?.get(b"Annots").ok().cloned();
    if let Some(Object::Reference(id)) = existing {
        if let Ok(Object::Array(a)) = doc.get_object_mut(id) {
            a.push(annot.into());
            return Ok(());
        }
    }
    let mut list = match existing {
        Some(Object::Array(a)) => a,
        _ => vec![],
    };
    list.push(annot.into());
    doc.get_dictionary_mut(page)?.set("Annots", list);
    Ok(())
}

/// `embedMarksIntoPdf`: one annotation per mark. A mark on a page the PDF does not have is skipped.
fn embed(doc: &mut Document, marks: &[Mark]) -> lopdf::Result<()> {
    let pages = doc.get_pages();
    for m in marks {
        let Some(&page) = pages.get(&m.page) else {
            continue;
        };
        let (w, h) = page_size(doc, page);
        let id = doc.add_object(annotation(m, w, h));
        add_annot(doc, page, id)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn pdf_embed_marks(
    session: State<'_, Mutex<Session>>,
    pdf_abs_path: String,
    marks: Value,
    target: Value,
) -> Result<Value, String> {
    Ok(outcome(embed_marks(
        &session,
        &pdf_abs_path,
        &marks,
        &target,
    )))
}

fn embed_marks(
    session: &Mutex<Session>,
    pdf_abs_path: &str,
    marks: &Value,
    target: &Value,
) -> Result<String, String> {
    let dest = match target {
        Value::String(s) if s == "original" => pdf_abs_path,
        _ => {
            let p = target.get("newPath").and_then(Value::as_str);
            let p = p.ok_or("Unknown export target.")?;
            export_target(session, p)?;
            p
        }
    };
    let source = project_pdf(session, pdf_abs_path)?;
    let marks = parse_marks(marks);
    let opened = fs::read(&source)
        .map_err(err)
        .and_then(|b| Document::load_mem(&b).map_err(err))
        .and_then(|d| {
            if d.was_encrypted() || d.is_encrypted() {
                Err("the PDF is encrypted.".to_string())
            } else {
                Ok(d)
            }
        });
    let mut doc = opened.map_err(|e| format!("Could not open the PDF: {e}"))?;
    embed(&mut doc, &marks).map_err(err)?;
    let mut bytes = vec![];
    doc.save_to(&mut bytes).map_err(err)?;
    write_file(dest, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::tests::tmp;

    fn ints(v: &[i64]) -> Object {
        Object::Array(v.iter().copied().map(Object::from).collect())
    }

    /// Two pages; the MediaBox sits on the page tree; page 2 has one annotation in a referenced array.
    fn sample_pdf() -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages = doc.new_object_id();
        let old = doc.add_object(
            dictionary! { "Type" => "Annot", "Subtype" => "Text", "Rect" => ints(&[0, 0, 1, 1]) },
        );
        let annots = doc.add_object(vec![Object::Reference(old)]);
        let p1 = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages });
        let p2 =
            doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages, "Annots" => annots });
        doc.objects.insert(
            pages,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![p1.into(), p2.into()],
                "Count" => 2,
                "MediaBox" => ints(&[0, 0, 200, 100]),
            }),
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", catalog);
        let mut out = vec![];
        doc.save_to(&mut out).unwrap();
        out
    }

    fn floats(o: &Object) -> Vec<f32> {
        o.as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_float().unwrap())
            .collect()
    }

    #[test]
    fn text_write_needs_an_export_dialog_path() {
        let d = tmp("textwrite");
        let out = d.join("out.txt").display().to_string();
        let s = Mutex::new(Session::default());
        assert!(write_text(&s, &out, "x")
            .unwrap_err()
            .contains("export dialog"));
        assert!(!d.join("out.txt").exists());
        lock(&s).writable_exports.insert(normalize(Path::new(&out)));
        assert_eq!(write_text(&s, &out, "Grüße"), Ok(out.clone()));
        assert_eq!(fs::read_to_string(&out).unwrap(), "Grüße");
        assert_eq!(
            outcome(write_text(
                &s,
                &d.join("other.txt").display().to_string(),
                "x"
            ))["ok"],
            false
        );
    }

    #[cfg(unix)]
    #[test]
    fn text_write_refuses_a_symlink() {
        let d = tmp("textlink");
        fs::write(d.join("target"), "keep").unwrap();
        std::os::unix::fs::symlink(d.join("target"), d.join("link.txt")).unwrap();
        let s = Mutex::new(Session::default());
        lock(&s)
            .writable_exports
            .insert(normalize(&d.join("link.txt")));
        let r = write_text(&s, &d.join("link.txt").display().to_string(), "x");
        assert!(r.unwrap_err().contains("symbolic link"));
        assert_eq!(fs::read_to_string(d.join("target")).unwrap(), "keep");
    }

    #[test]
    fn marks_parse_like_parse_marks() {
        let raw = json!([
            { "id": "a", "page": 1, "rects": [{ "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4 }], "color": "#ff0000", "kind": "note" },
            { "id": "", "page": 1, "rects": [{ "x": 0, "y": 0, "width": 1, "height": 1 }], "color": "#fff" },
            { "id": "b", "page": 0, "rects": [{ "x": 0, "y": 0, "width": 1, "height": 1 }], "color": "#fff" },
            { "id": "c", "page": 1.5, "rects": [{ "x": 0, "y": 0, "width": 1, "height": 1 }], "color": "#fff" },
            { "id": "d", "page": 1, "rects": [], "color": "#fff" },
            { "id": "e", "page": 1, "rects": [{ "x": 0, "y": 0, "width": 1 }], "color": "#fff" },
            { "id": "f", "page": 1, "rects": [{ "x": 0, "y": 0, "width": 1, "height": 1 }], "color": "" },
            "junk"
        ]);
        let m = parse_marks(&raw);
        assert_eq!(m.len(), 1);
        assert!(m[0].note);
        assert_eq!(m[0].rects, [[0.1, 0.2, 0.3, 0.4]]);
        assert_eq!(m[0].comment, "");
        assert!(parse_marks(&json!({})).is_empty());
    }

    #[test]
    fn colors_dates_and_text_match_pdf_lib() {
        assert_eq!(floats(&Object::Array(rgb01("#ff0033"))), [1.0, 0.0, 0.2]);
        assert_eq!(floats(&Object::Array(rgb01("00FF00"))), [0.0, 1.0, 0.0]);
        assert_eq!(floats(&Object::Array(rgb01("red"))), [1.0, 0.88, 0.4]);
        assert_eq!(floats(&Object::Array(rgb01("#ééé"))), [1.0, 0.88, 0.4]);
        assert_eq!(
            pdf_date("2024-01-02T03:04:05.678+02:00"),
            Some(Object::string_literal("D:20240102010405Z"))
        );
        assert_eq!(pdf_date(""), None);
        assert_eq!(pdf_date("yesterday"), None);
        assert_eq!(
            pdf_text("é"),
            Object::String(vec![0xFE, 0xFF, 0x00, 0xE9], StringFormat::Hexadecimal)
        );
    }

    #[test]
    fn embeds_annotations_into_a_project_pdf() {
        let d = tmp("embed");
        fs::create_dir_all(d.join("proj")).unwrap();
        let pdf = d.join("proj/a.pdf");
        fs::write(&pdf, sample_pdf()).unwrap();
        let out = d.join("out.pdf");
        let (pdf_s, out_s) = (pdf.display().to_string(), out.display().to_string());
        let s = Mutex::new(Session::default());
        lock(&s).project_dir = Some(d.join("proj"));
        let marks = json!([
            { "id": "h", "page": 1, "rects": [{ "x": 0.1, "y": 0.2, "width": 0.5, "height": 0.1 }],
              "color": "#ff0000", "comment": "Hi", "createdAt": "2024-01-02T03:04:05.000Z", "updatedAt": "" },
            { "id": "n", "page": 2, "rects": [{ "x": 0.5, "y": 0.5, "width": 0.01, "height": 0.01 }],
              "color": "#00ff00", "kind": "note" },
            { "id": "gone", "page": 9, "rects": [{ "x": 0, "y": 0, "width": 1, "height": 1 }], "color": "#fff" }
        ]);
        let target = json!({ "newPath": out_s });

        let r = embed_marks(&s, &pdf_s, &marks, &target);
        assert!(r.unwrap_err().contains("export dialog"));
        lock(&s).writable_exports.insert(normalize(&out));
        assert_eq!(embed_marks(&s, &pdf_s, &marks, &target), Ok(out_s.clone()));

        let doc = Document::load(&out).unwrap();
        let pages = doc.get_pages();
        let annots = |n| doc.get_page_annotations(pages[&n]).unwrap();
        let first = annots(1);
        assert_eq!(first.len(), 1);
        let h = first[0];
        assert_eq!(h.get(b"Subtype").unwrap().as_name().unwrap(), b"Highlight");
        assert_eq!(floats(h.get(b"Rect").unwrap()), [20.0, 70.0, 120.0, 80.0]);
        assert_eq!(
            floats(h.get(b"QuadPoints").unwrap()),
            [20.0, 80.0, 120.0, 80.0, 20.0, 70.0, 120.0, 70.0]
        );
        assert_eq!(floats(h.get(b"C").unwrap()), [1.0, 0.0, 0.0]);
        assert_eq!(h.get(b"CA").unwrap().as_float().unwrap(), 0.4);
        assert_eq!(
            h.get(b"Contents").unwrap().as_str().unwrap(),
            [0xFE, 0xFF, 0, b'H', 0, b'i']
        );
        assert_eq!(h.get(b"T").unwrap().as_str().unwrap(), b"SaiLoR");
        assert_eq!(
            h.get(b"CreationDate").unwrap().as_str().unwrap(),
            b"D:20240102030405Z"
        );
        assert!(!h.has(b"M"));
        let second = annots(2);
        assert_eq!(second.len(), 2, "the existing annotation stays");
        let n = second[1];
        assert_eq!(n.get(b"Subtype").unwrap().as_name().unwrap(), b"Text");
        assert_eq!(floats(n.get(b"Rect").unwrap()), [90.0, 40.0, 110.0, 60.0]);
        assert!(!n.get(b"Open").unwrap().as_bool().unwrap());
        assert_eq!(
            fs::read(&pdf).unwrap(),
            sample_pdf(),
            "the source is unchanged"
        );

        assert_eq!(
            embed_marks(&s, &pdf_s, &marks, &json!("original")),
            Ok(pdf_s.clone())
        );
        assert_eq!(
            Document::load(&pdf)
                .unwrap()
                .get_page_annotations(pages[&1])
                .unwrap()
                .len(),
            1
        );
        assert!(embed_marks(&s, &pdf_s, &marks, &json!("other")).is_err());
    }

    #[test]
    fn embed_reads_only_project_pdfs() {
        let d = tmp("embedauth");
        fs::create_dir_all(d.join("proj")).unwrap();
        fs::write(d.join("outside.pdf"), sample_pdf()).unwrap();
        let outside = d.join("outside.pdf").display().to_string();
        let s = Mutex::new(Session::default());
        let r = embed_marks(&s, &outside, &json!([]), &json!("original"));
        assert!(r.unwrap_err().contains("not a PDF of the open project"));
        lock(&s).project_dir = Some(d.join("proj"));
        let r = embed_marks(&s, &outside, &json!([]), &json!("original"));
        assert!(r.unwrap_err().contains("not a PDF of the open project"));
        lock(&s).allowed_escapes.insert("../outside.pdf".into());
        assert_eq!(
            embed_marks(&s, &outside, &json!([]), &json!("original")),
            Ok(outside)
        );
    }

    #[test]
    fn embed_refuses_an_encrypted_pdf() {
        let d = tmp("embedenc");
        fs::create_dir_all(d.join("proj")).unwrap();
        let mut doc = Document::load_mem(&sample_pdf()).unwrap();
        let enc = doc.add_object(dictionary! { "Filter" => "Standard", "V" => 1, "R" => 2 });
        doc.trailer.set("Encrypt", enc);
        doc.save(d.join("proj/e.pdf")).unwrap();
        let before = fs::read(d.join("proj/e.pdf")).unwrap();
        let s = Mutex::new(Session::default());
        lock(&s).project_dir = Some(d.join("proj"));
        let pdf = d.join("proj/e.pdf").display().to_string();
        let r = embed_marks(&s, &pdf, &json!([]), &json!("original"));
        assert!(r.unwrap_err().starts_with("Could not open the PDF"));
        assert_eq!(fs::read(d.join("proj/e.pdf")).unwrap(), before);
    }

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
