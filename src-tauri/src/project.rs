//! `project:*` file handlers. Thin I/O plus authorization: assembling the split
//! layout into one project stays in TypeScript (src/model/project.ts).

use crate::authz::{assert_not_symlink, changed, err, lock, within, Session};
use crate::paths::{dir_of, normalize, resolve};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

pub const DEFAULT_ANNOTATIONS_DIR: &str = "annotations";
pub const FEEDBACK_DIR: &str = "feedback";

/// `paperIdProblem(id) === null` from src/model/paperId.ts.
pub fn paper_id_ok(id: &str) -> bool {
    const RESERVED: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];
    let base = id.split('.').next().unwrap_or("").to_uppercase();
    let numbered = |p: &str| {
        base.strip_prefix(p)
            .is_some_and(|n| n.len() == 1 && matches!(n.as_bytes()[0], b'1'..=b'9'))
    };
    !id.is_empty()
        && !id.chars().any(|c| c < '\u{20}')
        && id != "."
        && id != ".."
        && !id.chars().any(|c| "<>:\"/\\|?*".contains(c))
        && !id.ends_with(['.', ' '])
        && !RESERVED.contains(&base.as_str())
        && !numbered("COM")
        && !numbered("LPT")
        && id.to_lowercase() != FEEDBACK_DIR
}

/// `annotationsDirProblem(name) === null` from src/model/annotationsDir.ts.
pub fn annotations_dir_ok(name: &str) -> bool {
    name == name.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        && paper_id_ok(name)
        && !name.starts_with('.')
}

/// `annotationsDirOf`: the folder a parsed project file names, or the default.
pub fn annotations_dir_of(raw: &Value) -> String {
    match raw.get("annotationsDir").and_then(Value::as_str) {
        Some(n) if annotations_dir_ok(n) => n.to_string(),
        _ => DEFAULT_ANNOTATIONS_DIR.to_string(),
    }
}

/// `isLegacyProjectShape`: papers still carry `annotations`/`reviews` inline.
pub fn is_legacy_shape(raw: &Value) -> bool {
    raw.get("papers")
        .and_then(Value::as_array)
        .is_some_and(|ps| {
            ps.iter()
                .any(|p| p.get("annotations").is_some() || p.get("reviews").is_some())
        })
}

/// `annotationsDirFor`: one folder directly inside the project's directory, never a link.
pub fn annotations_dir_for(file: &Path, raw: &Value) -> Result<PathBuf, String> {
    let project_dir = dir_of(&normalize(file)).to_path_buf();
    let dir = project_dir.join(annotations_dir_of(raw));
    let outside = || {
        format!(
            "Refusing an annotations folder outside the project's own directory: \"{}\"",
            dir.display()
        )
    };
    if dir.parent() != Some(project_dir.as_path()) {
        return Err(outside());
    }
    match fs::symlink_metadata(&dir) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(dir),
        Err(e) => return Err(err(e)),
        Ok(m) if m.file_type().is_symlink() => {
            return Err(format!(
                "Refusing an annotations folder that is a symbolic link: \"{}\"",
                dir.display()
            ))
        }
        Ok(_) => {}
    }
    let real = dir.canonicalize().map_err(err)?;
    if real.parent() != Some(project_dir.canonicalize().map_err(err)?.as_path()) {
        return Err(outside());
    }
    Ok(dir)
}

pub fn read_lossy(p: &Path) -> io::Result<String> {
    fs::read(p).map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// `readProjectMeta`: parsed project file, or `null` when missing or unreadable.
pub fn read_meta(file: &Path) -> Value {
    read_lossy(file)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null)
}

/// `safeReadAnnotationFile`: `None` when missing or resolving (via any link) outside `base`.
pub fn safe_read(base: &Path, rel: &str) -> Option<String> {
    let resolved = resolve(base, Path::new(rel));
    if !within(&resolved, base) {
        return None;
    }
    let real = resolved.canonicalize().ok()?;
    if !within(&real, &base.canonicalize().ok()?) {
        return None;
    }
    read_lossy(&real).ok()
}

pub fn paper_ids(raw: &Value) -> Vec<String> {
    let mut seen = HashSet::new();
    raw.get("papers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|p| p.get("id")?.as_str())
        .filter(|id| seen.insert(id.to_string()))
        .map(str::to_string)
        .collect()
}

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub rel_path: String,
    pub text: String,
}

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct Sibling {
    pub name: String,
    pub text: String,
}

/// What `project:open`/`project:openPath` hand to the TS side. `text` is
/// `project.json` as stored. For a split project, `files` holds every `.json`
/// in each listed paper's folder (`<paperId>/<name>`, annotations-relative) and
/// `siblings` the other project files sharing the annotations folder; the TS
/// side assembles these into the whole-project text Electron returns.
#[derive(Serialize, Debug)]
pub struct Opened {
    pub path: String,
    pub text: String,
    pub files: Vec<FileText>,
    pub siblings: Vec<Sibling>,
}

/// `projectsUsingFolder` without the `keep` filter: other project files next to
/// `file` whose annotations folder is `folder`. Links and non-projects skipped.
pub fn projects_using_folder(file: &Path, folder: &str) -> Vec<Sibling> {
    let own = file.file_name();
    let Ok(entries) = fs::read_dir(dir_of(&normalize(file))) else {
        return vec![];
    };
    let mut out: Vec<Sibling> = entries
        .flatten()
        .filter(|e| Some(e.file_name().as_os_str()) != own)
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .to_lowercase()
                .ends_with(".json")
        })
        .filter(|e| e.file_type().is_ok_and(|t| !t.is_symlink()))
        .filter_map(|e| {
            let text = read_lossy(&e.path()).ok()?;
            let raw: Value = serde_json::from_str(&text).ok()?;
            (raw.get("papers").is_some_and(Value::is_array) && annotations_dir_of(&raw) == folder)
                .then(|| Sibling {
                    name: e.file_name().to_string_lossy().into_owned(),
                    text,
                })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// `readProjectText` minus the assembly; records stamps for a later save.
pub fn read_project(session: &Mutex<Session>, file: &Path) -> Result<Opened, String> {
    let text = read_lossy(file).map_err(err)?;
    let raw: Value = serde_json::from_str(&text).map_err(err)?;
    let path = file.display().to_string();
    if is_legacy_shape(&raw) {
        return Ok(Opened {
            path,
            text,
            files: vec![],
            siblings: vec![],
        });
    }
    let dir = annotations_dir_for(file, &raw)?;
    let ids = paper_ids(&raw);
    let mut files = vec![];
    for id in &ids {
        let paper_dir = resolve(&dir, Path::new(id));
        if paper_dir == dir || !within(&paper_dir, &dir) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&paper_dir) else {
            continue;
        };
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| !t.is_dir()))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".json"))
            .collect();
        names.sort();
        for name in names {
            let rel_path = format!("{id}/{name}");
            if let Some(text) = safe_read(&dir, &rel_path) {
                files.push(FileText { rel_path, text });
            }
        }
    }
    let mut s = lock(session);
    s.stamps.remove(&normalize(file));
    s.remember(file, file);
    for id in &ids {
        for e in fs::read_dir(dir.join(id)).into_iter().flatten().flatten() {
            s.remember(file, &e.path());
        }
    }
    drop(s);
    let siblings = projects_using_folder(file, &annotations_dir_of(&raw));
    Ok(Opened {
        path,
        text,
        files,
        siblings,
    })
}

fn open(session: &Mutex<Session>, file: &Path) -> Result<Opened, String> {
    let opened = read_project(session, file)?;
    lock(session).known_projects.insert(normalize(file));
    Ok(opened)
}

#[tauri::command]
pub async fn project_open(
    app: AppHandle,
    session: State<'_, Mutex<Session>>,
) -> Result<Option<Opened>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Open SLR project")
        .add_filter("SLR project", &["json"])
        .blocking_pick_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    open(&session, &picked.into_path().map_err(err)?).map(Some)
}

#[tauri::command]
pub async fn project_open_path(
    session: State<'_, Mutex<Session>>,
    file_path: String,
) -> Result<Option<Opened>, String> {
    Ok(open(&session, Path::new(&file_path)).ok())
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SaveFile {
    pub rel_path: String,
    pub text: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Saved {
    pub stale: Vec<String>,
}

/// `isDeletableAnnotationText`: empty or parseable; anything else must survive.
fn deletable(text: &str) -> bool {
    text.trim().is_empty() || serde_json::from_str::<Value>(text).is_ok()
}

fn is_feedback_path(rel: &str) -> bool {
    let rel = rel.replace('\\', "/").to_lowercase();
    rel == FEEDBACK_DIR || rel.starts_with(&format!("{FEEDBACK_DIR}/"))
}

fn meta_of(file: &Path, meta_text: Option<&str>) -> Result<Value, String> {
    match meta_text {
        Some(t) => serde_json::from_str(t).map_err(err),
        None => Ok(read_meta(file)),
    }
}

/// `writeProjectFiles`: meta, then reconcile the annotations folder against `files`.
pub fn write_project_files(
    session: &Mutex<Session>,
    file: &Path,
    meta_text: Option<&str>,
    files: &[SaveFile],
) -> Result<(), String> {
    if let Some(meta) = meta_text {
        assert_not_symlink(file)?;
        fs::write(file, meta).map_err(err)?;
        lock(session).remember(file, file);
    }
    let base = annotations_dir_for(file, &meta_of(file, meta_text)?)?;
    fs::create_dir_all(&base).map_err(err)?;
    let real_base = base.canonicalize().map_err(err)?;
    for f in files {
        let target = resolve(&base, Path::new(&f.rel_path));
        let outside = || {
            format!(
                "Refusing to write annotation file outside the project: \"{}\"",
                f.rel_path
            )
        };
        if !within(&target, &base) {
            return Err(outside());
        }
        if is_feedback_path(&f.rel_path) {
            return Err(format!(
                "\"{FEEDBACK_DIR}\" is reserved for AI feedback files and cannot be a paper id."
            ));
        }
        let parent = dir_of(&target).to_path_buf();
        let Some(text) = &f.text else {
            match read_lossy(&target) {
                Ok(existing) if !deletable(&existing) => continue,
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(err(e)),
                _ => {}
            }
            match fs::remove_file(&target) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(err(e)),
                _ => {}
            }
            lock(session).remember(file, &target);
            if parent != base {
                let _ = fs::remove_dir(&parent);
            }
            continue;
        };
        fs::create_dir_all(&parent).map_err(err)?;
        if !within(&parent.canonicalize().map_err(err)?, &real_base) {
            return Err(outside());
        }
        assert_not_symlink(&target)?;
        fs::write(&target, text).map_err(err)?;
        lock(session).remember(file, &target);
    }
    Ok(())
}

/// `project:save`: refuses unknown paths; writes nothing when any target changed on disk.
pub fn save(
    session: &Mutex<Session>,
    file: &Path,
    meta_text: Option<&str>,
    files: &[SaveFile],
) -> Result<Saved, String> {
    if !lock(session).is_known(file) {
        return Err(format!(
            "Refusing to save to \"{}\": it was not opened or chosen via a dialog this session.",
            file.display()
        ));
    }
    let base = annotations_dir_for(file, &meta_of(file, meta_text)?)?;
    let folder = base
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let mut targets = vec![];
    if meta_text.is_some() {
        targets.push((
            file.to_path_buf(),
            file.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        ));
    }
    targets.extend(files.iter().map(|f| {
        (
            resolve(&base, Path::new(&f.rel_path)),
            format!("{folder}/{}", f.rel_path),
        )
    }));
    let stale: Vec<String> = match lock(session).stamps.get(&normalize(file)) {
        None => vec![],
        Some(stamps) => targets
            .into_iter()
            .filter(|(abs, _)| {
                changed(
                    stamps.get(&normalize(abs)),
                    crate::authz::stamp(abs).as_ref(),
                )
            })
            .map(|(_, rel)| rel)
            .collect(),
    };
    if !stale.is_empty() {
        return Ok(Saved { stale });
    }
    write_project_files(session, file, meta_text, files)?;
    Ok(Saved { stale })
}

#[tauri::command]
pub async fn project_save(
    session: State<'_, Mutex<Session>>,
    file_path: String,
    meta_text: Option<String>,
    files: Vec<SaveFile>,
) -> Result<Saved, String> {
    save(
        &session,
        Path::new(&file_path),
        meta_text.as_deref(),
        &files,
    )
}

pub fn set_dir(session: &Mutex<Session>, file: &Path) {
    let dir = dir_of(file).to_path_buf();
    let mut s = lock(session);
    if s.project_dir.as_ref() != Some(&dir) {
        s.allowed_escapes.clear();
    }
    s.project_dir = Some(dir);
}

#[tauri::command]
pub async fn project_set_dir(
    session: State<'_, Mutex<Session>>,
    file_path: String,
) -> Result<(), String> {
    set_dir(&session, Path::new(&file_path));
    Ok(())
}

/// Native save dialog; `suggested` may be a bare name or a full path.
pub fn save_dialog(
    app: &AppHandle,
    title: &str,
    suggested: &str,
    filter: (&str, &[&str]),
) -> Result<Option<PathBuf>, String> {
    let suggested = Path::new(suggested);
    let mut d = app
        .dialog()
        .file()
        .set_title(title)
        .add_filter(filter.0, filter.1);
    if let Some(dir) = suggested.parent().filter(|p| !p.as_os_str().is_empty()) {
        d = d.set_directory(dir);
    }
    if let Some(name) = suggested.file_name() {
        d = d.set_file_name(name.to_string_lossy());
    }
    d.blocking_save_file()
        .map(|p| p.into_path().map_err(err))
        .transpose()
}

#[derive(Serialize)]
pub struct PickedPath {
    path: String,
}

#[tauri::command]
pub async fn project_pick_save_path(
    app: AppHandle,
    session: State<'_, Mutex<Session>>,
    suggested_name: String,
) -> Result<Option<PickedPath>, String> {
    let Some(p) = save_dialog(
        &app,
        "Choose where to store the project JSON",
        &suggested_name,
        ("SLR project", &["json"]),
    )?
    else {
        return Ok(None);
    };
    lock(&session).known_projects.insert(normalize(&p));
    Ok(Some(PickedPath {
        path: p.display().to_string(),
    }))
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Peek {
    exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

pub fn peek(path: &str) -> Peek {
    if fs::File::open(path).is_err() {
        return Peek {
            exists: false,
            title: None,
        };
    }
    let title = read_lossy(Path::new(path))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|raw| raw.get("title")?.as_str().map(str::to_string))
        .filter(|t| !t.trim().is_empty());
    Peek {
        exists: true,
        title,
    }
}

#[tauri::command]
pub async fn project_peek(paths: Vec<String>) -> Result<Vec<Peek>, String> {
    Ok(paths.iter().map(|p| peek(p)).collect())
}

#[derive(Serialize, Debug)]
pub struct Source {
    name: String,
    #[serde(flatten)]
    opened: Opened,
}

/// The screening project an open project names in its provenance: a plain file
/// name next to it, read like `project:open` reads; `None` when absent or refused.
pub fn screening_source(
    session: &Mutex<Session>,
    project_path: &str,
) -> Result<Option<Source>, String> {
    let key = normalize(Path::new(project_path));
    if !lock(session).is_known(&key) {
        return Err("Refusing to inspect a project that was not opened this session.".into());
    }
    let raw = read_meta(&key);
    if raw.pointer("/provenance/kind").and_then(Value::as_str) != Some("screening-import") {
        return Ok(None);
    }
    let Some(name) = raw
        .pointer("/provenance/source/file")
        .and_then(Value::as_str)
    else {
        return Ok(None);
    };
    let plain = !name.contains(['/', '\\'])
        && name.len() > 5
        && name.to_lowercase().ends_with(".json")
        && !name.starts_with('.')
        && paper_id_ok(name);
    let file = dir_of(&key).join(name);
    if !plain || file == key {
        return Ok(None);
    }
    if fs::symlink_metadata(&file).map_or(true, |m| m.file_type().is_symlink()) {
        return Ok(None);
    }
    Ok(read_project(session, &file).ok().map(|opened| Source {
        name: name.to_string(),
        opened,
    }))
}

#[tauri::command]
pub async fn project_screening_source(
    session: State<'_, Mutex<Session>>,
    project_path: String,
) -> Result<Option<Source>, String> {
    screening_source(&session, &project_path)
}

#[derive(Serialize)]
pub struct PickedReference {
    text: String,
    name: String,
}

#[tauri::command]
pub async fn reference_pick(app: AppHandle) -> Result<Option<PickedReference>, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("Import references")
        .add_filter("Reference files", &["bib", "ris", "json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let p = picked.into_path().map_err(err)?;
    Ok(Some(PickedReference {
        text: read_lossy(&p).map_err(err)?,
        name: p
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
    }))
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sailor-rs-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        let d = d.canonicalize().unwrap();
        // `canonicalize` yields `\\?\C:\…` on Windows, where `/` is no separator.
        #[cfg(windows)]
        let d = PathBuf::from(d.to_string_lossy().trim_start_matches(r"\\?\"));
        d
    }

    fn file(rel: &str, text: Option<&str>) -> SaveFile {
        SaveFile {
            rel_path: rel.into(),
            text: text.map(str::to_string),
        }
    }

    const META: &str = r#"{"title":"T","papers":[{"id":"p1"}]}"#;

    #[test]
    fn annotations_dir_names() {
        for ok in ["annotations", "review-annotations", "a.b"] {
            assert!(annotations_dir_ok(ok), "{ok}");
        }
        for bad in [
            "", ".", "..", ".git", "a/b", "a\\b", "C:x", " a", "a ", "a.", "con", "LPT1.txt",
            "Feedback", "a\u{1}",
        ] {
            assert!(!annotations_dir_ok(bad), "{bad}");
        }
        assert!(annotations_dir_ok("COM0"));
        assert_eq!(
            annotations_dir_of(&serde_json::json!({"annotationsDir": "../x"})),
            "annotations"
        );
    }

    #[test]
    fn save_refuses_unauthorized_path() {
        let d = tmp("unauth");
        let s = Mutex::new(Session::default());
        let target = d.join("evil.json");
        let e = save(&s, &target, Some(META), &[]).unwrap_err();
        assert!(e.starts_with("Refusing to save"), "{e}");
        assert!(!target.exists());
    }

    #[test]
    fn save_round_trip_stale_and_deletion_rules() {
        let d = tmp("roundtrip");
        let s = Mutex::new(Session::default());
        let proj = d.join("p.json");
        lock(&s).known_projects.insert(normalize(&proj));
        let first = save(
            &s,
            &proj,
            Some(META),
            &[file("p1/reviewer-1.json", Some("{}"))],
        )
        .unwrap();
        assert!(first.stale.is_empty());
        assert_eq!(
            fs::read_to_string(d.join("annotations/p1/reviewer-1.json")).unwrap(),
            "{}"
        );

        let opened = open(&s, &proj).unwrap();
        assert_eq!(
            opened.files,
            [FileText {
                rel_path: "p1/reviewer-1.json".into(),
                text: "{}".into()
            }]
        );

        // Changed underneath: nothing is written.
        fs::write(d.join("annotations/p1/reviewer-1.json"), "{\"x\":1}").unwrap();
        let stale = save(&s, &proj, None, &[file("p1/reviewer-1.json", Some("{}"))])
            .unwrap()
            .stale;
        assert_eq!(stale, ["annotations/p1/reviewer-1.json"]);
        // A file nobody had seen also counts.
        fs::write(d.join("annotations/p1/reviewer-2.json"), "{}").unwrap();
        open(&s, &proj).unwrap();

        // Unparseable files survive a delete; parseable ones go, and the emptied folder with them.
        fs::write(d.join("annotations/p1/reviewer-2.json"), "<<<<<<< conflict").unwrap();
        open(&s, &proj).unwrap();
        save(
            &s,
            &proj,
            None,
            &[
                file("p1/reviewer-1.json", None),
                file("p1/reviewer-2.json", None),
            ],
        )
        .unwrap();
        assert!(!d.join("annotations/p1/reviewer-1.json").exists());
        assert!(d.join("annotations/p1/reviewer-2.json").exists());
        fs::remove_file(d.join("annotations/p1/reviewer-2.json")).unwrap();
        save(&s, &proj, None, &[file("p1/reviewer-2.json", None)]).unwrap();
        assert!(!d.join("annotations/p1").exists());
    }

    #[test]
    fn save_refuses_escapes_and_feedback() {
        let d = tmp("escape");
        let s = Mutex::new(Session::default());
        let proj = d.join("p.json");
        lock(&s).known_projects.insert(normalize(&proj));
        assert!(
            save(&s, &proj, Some(META), &[file("../../x.json", Some("{}"))])
                .unwrap_err()
                .contains("outside")
        );
        assert!(
            save(&s, &proj, None, &[file("Feedback/x.json", Some("{}"))])
                .unwrap_err()
                .contains("reserved")
        );
        assert!(!d.join("x.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn save_refuses_symlinks() {
        use std::os::unix::fs::symlink;
        let d = tmp("symlink");
        let outside = tmp("symlink-out");
        let s = Mutex::new(Session::default());
        let proj = d.join("p.json");
        lock(&s).known_projects.insert(normalize(&proj));
        fs::create_dir_all(d.join("annotations")).unwrap();
        symlink(&outside, d.join("annotations/p1")).unwrap();
        assert!(save(
            &s,
            &proj,
            Some(META),
            &[file("p1/reviewer-1.json", Some("{}"))]
        )
        .unwrap_err()
        .contains("outside"));
        assert!(!outside.join("reviewer-1.json").exists());

        symlink(outside.join("rc"), d.join("q.json")).unwrap();
        lock(&s).known_projects.insert(normalize(&d.join("q.json")));
        assert!(save(&s, &d.join("q.json"), Some(META), &[])
            .unwrap_err()
            .contains("symbolic link"));
        assert!(!outside.join("rc").exists());
    }

    #[test]
    fn open_path_registers_only_on_success_and_skips_legacy() {
        let d = tmp("open");
        let s = Mutex::new(Session::default());
        assert!(open(&s, &d.join("missing.json")).is_err());
        assert!(lock(&s).known_projects.is_empty());
        let legacy = r#"{"papers":[{"id":"p1","annotations":{}}]}"#;
        fs::write(d.join("l.json"), legacy).unwrap();
        let o = open(&s, &d.join("l.json")).unwrap();
        assert_eq!(o.text, legacy);
        assert!(o.files.is_empty());
        assert!(lock(&s).is_known(&d.join("l.json")));
        assert!(lock(&s).stamps.is_empty());

        fs::write(d.join("a.json"), META).unwrap();
        fs::write(d.join("b.json"), r#"{"papers":[]}"#).unwrap();
        fs::write(
            d.join("c.json"),
            r#"{"papers":[],"annotationsDir":"other"}"#,
        )
        .unwrap();
        let names: Vec<_> = open(&s, &d.join("a.json"))
            .unwrap()
            .siblings
            .into_iter()
            .map(|x| x.name)
            .collect();
        assert_eq!(names, ["b.json", "l.json"]);
    }

    #[test]
    fn set_dir_clears_escapes_only_on_change() {
        let s = Mutex::new(Session::default());
        set_dir(&s, Path::new("/a/p.json"));
        lock(&s).allowed_escapes.insert("../x.pdf".into());
        set_dir(&s, Path::new("/a/q.json"));
        assert_eq!(lock(&s).allowed_escapes.len(), 1);
        set_dir(&s, Path::new("/b/p.json"));
        assert!(lock(&s).allowed_escapes.is_empty());
    }

    #[test]
    fn peek_reports_existence_and_title() {
        let d = tmp("peek");
        fs::write(d.join("a.json"), r#"{"title":"Hello"}"#).unwrap();
        fs::write(d.join("b.json"), r#"{"title":"  "}"#).unwrap();
        fs::write(d.join("c.json"), "nope").unwrap();
        let p = |n: &str| peek(&d.join(n).display().to_string());
        assert_eq!(
            p("a.json"),
            Peek {
                exists: true,
                title: Some("Hello".into())
            }
        );
        assert_eq!(
            p("b.json"),
            Peek {
                exists: true,
                title: None
            }
        );
        assert_eq!(
            p("c.json"),
            Peek {
                exists: true,
                title: None
            }
        );
        assert_eq!(
            p("x.json"),
            Peek {
                exists: false,
                title: None
            }
        );
    }

    #[test]
    fn screening_source_reads_only_a_plain_sibling() {
        let d = tmp("screening-source");
        let own = d.join("review.json");
        let with_source = |file: &str| {
            fs::write(
                &own,
                format!(r#"{{"papers":[],"provenance":{{"kind":"screening-import","source":{{"file":"{file}"}}}}}}"#),
            )
            .unwrap();
        };
        fs::write(
            d.join("screen.json"),
            r#"{"papers":[{"id":"p1"}],"config":{"screening":{}}}"#,
        )
        .unwrap();
        let path = own.display().to_string();
        with_source("screen.json");
        assert!(screening_source(&Mutex::new(Session::default()), &path).is_err());
        let session = Mutex::new(Session::default());
        lock(&session).known_projects.insert(normalize(&own));
        let got = screening_source(&session, &path).unwrap().unwrap();
        assert_eq!(got.name, "screen.json");
        assert!(got.opened.text.contains("\"p1\""));
        for bad in [
            "../screen.json",
            "sub\\\\x.json",
            ".hidden.json",
            "screen.txt",
            "review.json",
            "missing.json",
            "CON.json",
        ] {
            with_source(bad);
            assert!(
                screening_source(&session, &path).unwrap().is_none(),
                "{bad}"
            );
        }
        fs::write(
            &own,
            r#"{"papers":[],"provenance":{"kind":"other","source":{"file":"screen.json"}}}"#,
        )
        .unwrap();
        assert!(screening_source(&session, &path).unwrap().is_none());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(d.join("screen.json"), d.join("link.json")).unwrap();
            with_source("link.json");
            assert!(screening_source(&session, &path).unwrap().is_none());
        }
    }
}
