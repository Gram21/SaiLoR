//! Shared annotations folders: `project:annotationsDirUsers`, `project:moveAnnotationsDir`,
//! `project:sharedAnnotations`, `project:splitAnnotations`. Authorization and every
//! write stay here; `planSplit` (which file goes where) stays in TypeScript.

use crate::authz::{assert_not_symlink, err, lock, stamp, within, ListedSplit, Session};
use crate::git::truthy;
use crate::paths::{dir_of, normalize, resolve};
use crate::project::{
    annotations_dir_for, annotations_dir_of, annotations_dir_ok, paper_ids, projects_using_folder,
    read_lossy, safe_read, FileText, FEEDBACK_DIR,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;
use unicode_normalization::UnicodeNormalization;

/// `paperIdKey`: ids compared the way a case-insensitive disk would.
fn paper_id_key(id: &str) -> String {
    id.nfc().collect::<String>().to_lowercase()
}

fn is_screening(raw: &Value) -> bool {
    truthy(raw.pointer("/config/screening"))
}

/// `filesCollide` from src/model/annotationsDir.ts.
pub fn files_collide(ids: &[String], screening: bool, raw: &Value) -> bool {
    if is_screening(raw) != screening {
        return false;
    }
    let mine: HashSet<String> = ids.iter().map(|i| paper_id_key(i)).collect();
    raw.get("papers")
        .and_then(Value::as_array)
        .is_some_and(|ps| {
            ps.iter()
                .filter_map(|p| p.get("id")?.as_str())
                .any(|id| mine.contains(&paper_id_key(id)))
        })
}

/// `projectsUsingFolder` with the `filesCollide` filter: (name, text) of each sibling.
fn colliding(file: &Path, folder: &str, ids: &[String], screening: bool) -> Vec<(String, String)> {
    projects_using_folder(file, folder)
        .into_iter()
        .filter(|s| {
            serde_json::from_str::<Value>(&s.text).is_ok_and(|r| files_collide(ids, screening, &r))
        })
        .map(|s| (s.name, s.text))
        .collect()
}

fn known(session: &Mutex<Session>, project_path: &str, verb: &str) -> Result<PathBuf, String> {
    let key = normalize(Path::new(project_path));
    if !lock(session).is_known(&key) {
        return Err(format!(
            "Refusing to {verb} a project that was not opened this session."
        ));
    }
    Ok(key)
}

fn read_json(file: &Path) -> Result<Value, String> {
    serde_json::from_str(&read_lossy(file).map_err(err)?).map_err(err)
}

/// `JSON.stringify({ ...raw, annotationsDir: folder }, null, 2)`; key order kept.
fn with_folder(mut raw: Value, folder: &str) -> Result<String, String> {
    raw.as_object_mut()
        .ok_or("The project file is not a JSON object.")?
        .insert("annotationsDir".into(), json!(folder));
    serde_json::to_string_pretty(&raw).map_err(err)
}

fn folder_ok(folder: &str) -> Result<(), String> {
    if annotations_dir_ok(folder) {
        Ok(())
    } else {
        Err(format!("\"{folder}\" cannot be an annotations folder."))
    }
}

fn non_empty_dir(p: &Path) -> bool {
    fs::read_dir(p).is_ok_and(|mut e| e.next().is_some())
}

pub fn annotations_dir_users(
    session: &Mutex<Session>,
    project_path: &str,
    folder: &str,
    paper_ids: &[String],
    screening: bool,
) -> Result<Vec<String>, String> {
    let key = known(session, project_path, "inspect")?;
    Ok(colliding(&key, folder, paper_ids, screening)
        .into_iter()
        .map(|(name, _)| name)
        .collect())
}

#[tauri::command]
pub async fn project_annotations_dir_users(
    session: State<'_, Mutex<Session>>,
    project_path: String,
    folder: String,
    paper_ids: Vec<String>,
    screening: bool,
) -> Result<Vec<String>, String> {
    annotations_dir_users(&session, &project_path, &folder, &paper_ids, screening)
}

/// Rename the folder first and put it back if the project file cannot be written.
pub fn move_dir(session: &Mutex<Session>, project_path: &str, folder: &str) -> Result<(), String> {
    let key = known(session, project_path, "change")?;
    folder_ok(folder)?;
    let raw = read_json(&key)?;
    let from = annotations_dir_for(&key, &raw)?;
    let to = annotations_dir_for(&key, &json!({ "annotationsDir": folder }))?;
    if from == to {
        return Ok(());
    }
    if !colliding(&key, folder, &paper_ids(&raw), is_screening(&raw)).is_empty() {
        return Err(format!(
            "Another project file here already uses \"{folder}\"."
        ));
    }
    if non_empty_dir(&to) {
        return Err(format!(
            "The folder \"{folder}\" already exists and is not empty."
        ));
    }
    let text = with_folder(raw, folder)?;
    let moved = from.exists();
    if moved {
        // An empty leftover only (checked above). A file in the way makes the rename fail.
        let _ = fs::remove_dir(&to);
        fs::rename(&from, &to).map_err(err)?;
    }
    if let Err(e) = assert_not_symlink(&key).and_then(|_| fs::write(&key, text).map_err(err)) {
        if moved {
            let _ = fs::rename(&to, &from);
        }
        return Err(e);
    }
    let mut s = lock(session);
    s.remember(&key, &key);
    if moved {
        for id in fs::read_dir(&to).into_iter().flatten().flatten() {
            for f in fs::read_dir(id.path()).into_iter().flatten().flatten() {
                s.remember(&key, &f.path());
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn project_move_annotations_dir(
    session: State<'_, Mutex<Session>>,
    project_path: String,
    folder: String,
) -> Result<(), String> {
    move_dir(&session, &project_path, &folder)
}

#[derive(Serialize, Debug)]
pub struct ProjectText {
    pub path: String,
    pub name: String,
    pub text: String,
}

#[derive(Serialize, Debug)]
pub struct Shared {
    pub folder: String,
    pub projects: Vec<ProjectText>,
    pub files: Vec<FileText>,
}

fn sorted_names(dir: &Path) -> Option<Vec<String>> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    Some(names)
}

/// The folder and every project file using it, if others share it; recorded for the split.
pub fn shared(session: &Mutex<Session>, project_path: &str) -> Result<Option<Shared>, String> {
    let key = known(session, project_path, "inspect")?;
    let own_text = read_lossy(&key).map_err(err)?;
    let own: Value = serde_json::from_str(&own_text).map_err(err)?;
    let folder = annotations_dir_of(&own);
    let others = colliding(&key, &folder, &paper_ids(&own), is_screening(&own));
    if others.is_empty() {
        return Ok(None);
    }
    let base = annotations_dir_for(&key, &own)?;
    let mut files = vec![];
    for id in sorted_names(&base).unwrap_or_default() {
        if id == FEEDBACK_DIR {
            continue;
        }
        for name in sorted_names(&base.join(&id)).unwrap_or_default() {
            if !name.ends_with(".json") {
                continue;
            }
            let rel_path = format!("{id}/{name}");
            if let Some(text) = safe_read(&base, &rel_path) {
                files.push(FileText { rel_path, text });
            }
        }
    }
    let dir = dir_of(&key);
    let own_name = key.file_name().unwrap_or_default().to_string_lossy();
    let projects: Vec<ProjectText> = std::iter::once((own_name.into_owned(), own_text))
        .chain(others)
        .map(|(name, text)| ProjectText {
            path: dir.join(&name).display().to_string(),
            name,
            text,
        })
        .collect();
    lock(session).listed_splits.insert(
        key.clone(),
        ListedSplit {
            folder: folder.clone(),
            projects: projects
                .iter()
                .map(|p| {
                    let p = normalize(Path::new(&p.path));
                    let st = stamp(&p);
                    (p, st)
                })
                .collect(),
            files: files.iter().map(|f| f.rel_path.clone()).collect(),
        },
    );
    Ok(Some(Shared {
        folder,
        projects,
        files,
    }))
}

#[tauri::command]
pub async fn project_shared_annotations(
    session: State<'_, Mutex<Session>>,
    project_path: String,
) -> Result<Option<Shared>, String> {
    shared(&session, &project_path)
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SplitRow {
    pub rel_path: String,
    #[serde(default)]
    pub targets: Vec<String>,
}

#[derive(Deserialize, Debug, Default)]
pub struct SplitPlan {
    /// Project file path to its new folder.
    #[serde(default)]
    pub folders: HashMap<String, String>,
    #[serde(default)]
    pub rows: Vec<SplitRow>,
}

fn base_name(p: &str) -> String {
    Path::new(p)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

/// Split the listed folder. All checks run first; then `applySplit`'s order:
/// copy, point each project file at its folder, delete, remove emptied folders.
pub fn split(session: &Mutex<Session>, project_path: &str, plan: &SplitPlan) -> Result<(), String> {
    let key = normalize(Path::new(project_path));
    let listed = lock(session)
        .listed_splits
        .get(&key)
        .cloned()
        .ok_or("List the shared folder first.")?;
    let dir = dir_of(&key).to_path_buf();
    if plan.folders.len() != listed.projects.len()
        || plan
            .folders
            .keys()
            .any(|p| !listed.projects.contains_key(&normalize(Path::new(p))))
    {
        return Err("The split must give every listed project its own folder.".into());
    }
    let mut lower = HashSet::new();
    for f in plan.folders.values() {
        folder_ok(f)?;
        if *f == listed.folder {
            return Err(format!("Each project needs a folder other than \"{f}\"."));
        }
        annotations_dir_for(&key, &json!({ "annotationsDir": f }))?;
        if non_empty_dir(&dir.join(f)) {
            return Err(format!(
                "The folder \"{f}\" already exists and is not empty."
            ));
        }
        lower.insert(f.to_lowercase());
    }
    if lower.len() != plan.folders.len() {
        return Err("Two projects cannot share one folder.".into());
    }
    for (p, st) in &listed.projects {
        if stamp(p) != *st {
            return Err(format!(
                "{} changed since the folder was listed. Try again.",
                p.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
    }
    for r in &plan.rows {
        if !listed.files.contains(&r.rel_path) {
            return Err(format!("\"{}\" was not in the listed folder.", r.rel_path));
        }
        if r.targets
            .iter()
            .any(|t| !listed.projects.contains_key(&normalize(Path::new(t))))
        {
            return Err(format!("\"{}\" names an unknown project.", r.rel_path));
        }
    }

    let inside = |rel: &str| -> Result<PathBuf, String> {
        let target = resolve(&dir, Path::new(rel));
        if target == dir || !within(&target, &dir) {
            return Err(format!(
                "Refusing a path outside the project directory: \"{rel}\""
            ));
        }
        assert_not_symlink(&target)?;
        Ok(target)
    };
    let real_dir = dir.canonicalize().map_err(err)?;
    let folder_of: HashMap<String, &String> = plan
        .folders
        .iter()
        .map(|(p, f)| (base_name(p), f))
        .collect();
    let shared_dir = dir.join(&listed.folder);
    let moved: Vec<&SplitRow> = plan.rows.iter().filter(|r| !r.targets.is_empty()).collect();
    for r in &moved {
        for t in &r.targets {
            let folder = folder_of
                .get(&base_name(t))
                .ok_or_else(|| format!("No folder chosen for \"{t}\"."))?;
            let text = safe_read(&shared_dir, &r.rel_path)
                .ok_or_else(|| format!("Could not read \"{}/{}\".", listed.folder, r.rel_path))?;
            let dest = inside(&format!("{folder}/{}", r.rel_path))?;
            let parent = dir_of(&dest);
            fs::create_dir_all(parent).map_err(err)?;
            if !within(&parent.canonicalize().map_err(err)?, &real_dir) {
                return Err(format!(
                    "Refusing a path outside the project directory: \"{folder}/{}\"",
                    r.rel_path
                ));
            }
            fs::write(&dest, text).map_err(err)?;
        }
    }
    for (p, folder) in &plan.folders {
        let file = inside(&base_name(p))?;
        let text = with_folder(read_json(&file)?, folder)?;
        fs::write(&file, text).map_err(err)?;
    }
    for r in &moved {
        fs::remove_file(inside(&format!("{}/{}", listed.folder, r.rel_path))?).map_err(err)?;
    }
    let paper_dirs: HashSet<&str> = moved
        .iter()
        .filter_map(|r| r.rel_path.rsplit_once('/').map(|(d, _)| d))
        .collect();
    for d in paper_dirs {
        let _ = fs::remove_dir(inside(&format!("{}/{d}", listed.folder))?);
    }
    let _ = fs::remove_dir(inside(&listed.folder)?);
    lock(session).listed_splits.remove(&key);
    Ok(())
}

#[tauri::command]
pub async fn project_split_annotations(
    session: State<'_, Mutex<Session>>,
    project_path: String,
    plan: SplitPlan,
) -> Result<(), String> {
    split(&session, &project_path, &plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::tests::tmp;

    fn known_session(p: &Path) -> Mutex<Session> {
        let s = Mutex::new(Session::default());
        lock(&s).known_projects.insert(normalize(p));
        s
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn collide_needs_same_kind_and_a_shared_paper() {
        let review = json!({ "papers": [{ "id": "Über" }] });
        let screening = json!({ "config": { "screening": {} }, "papers": [{ "id": "p1" }] });
        // NFD "Über" matches the NFC id, case-insensitively.
        assert!(files_collide(&s(&["u\u{308}ber"]), false, &review));
        assert!(!files_collide(&s(&["Über"]), true, &review));
        assert!(files_collide(&s(&["P1"]), true, &screening));
        assert!(!files_collide(&s(&["p2"]), true, &screening));
        assert!(!files_collide(
            &s(&["p1"]),
            false,
            &json!({ "papers": "x" })
        ));
    }

    #[test]
    fn users_require_a_known_project_and_list_colliding_siblings() {
        let d = tmp("ann-users");
        let own = d.join("a.json");
        fs::write(d.join("b.json"), r#"{"papers":[{"id":"p1"}]}"#).unwrap();
        fs::write(d.join("c.json"), r#"{"papers":[{"id":"p2"}]}"#).unwrap();
        fs::write(
            d.join("d.json"),
            r#"{"papers":[{"id":"p1"}],"config":{"screening":{}}}"#,
        )
        .unwrap();
        let path = own.display().to_string();
        let unknown = Mutex::new(Session::default());
        assert!(annotations_dir_users(&unknown, &path, "annotations", &s(&["p1"]), false).is_err());
        let ses = known_session(&own);
        assert_eq!(
            annotations_dir_users(&ses, &path, "annotations", &s(&["p1"]), false).unwrap(),
            ["b.json"]
        );
        assert!(
            annotations_dir_users(&ses, &path, "other", &s(&["p1"]), false)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn move_renames_folder_keeps_key_order_and_refuses_collisions() {
        let d = tmp("ann-move");
        let own = d.join("a.json");
        fs::write(&own, r#"{"title":"T","papers":[{"id":"p1"}],"z":1}"#).unwrap();
        fs::create_dir_all(d.join("annotations/p1")).unwrap();
        fs::write(d.join("annotations/p1/reviewer-1.json"), "{}").unwrap();
        let path = own.display().to_string();
        assert!(move_dir(&Mutex::new(Session::default()), &path, "x")
            .unwrap_err()
            .starts_with("Refusing"));
        let ses = known_session(&own);
        assert!(move_dir(&ses, &path, "../x").is_err());

        fs::write(
            d.join("b.json"),
            r#"{"papers":[{"id":"p1"}],"annotationsDir":"taken"}"#,
        )
        .unwrap();
        assert!(move_dir(&ses, &path, "taken")
            .unwrap_err()
            .contains("Another project"));
        fs::create_dir_all(d.join("full")).unwrap();
        fs::write(d.join("full/x"), "").unwrap();
        assert!(move_dir(&ses, &path, "full")
            .unwrap_err()
            .contains("not empty"));

        fs::create_dir_all(d.join("mine")).unwrap();
        move_dir(&ses, &path, "mine").unwrap();
        assert!(!d.join("annotations").exists());
        assert!(d.join("mine/p1/reviewer-1.json").exists());
        assert_eq!(
            fs::read_to_string(&own).unwrap(),
            "{\n  \"title\": \"T\",\n  \"papers\": [\n    {\n      \"id\": \"p1\"\n    }\n  ],\n  \"z\": 1,\n  \"annotationsDir\": \"mine\"\n}"
        );
        assert!(lock(&ses).stamps[&normalize(&own)]
            .contains_key(&normalize(&d.join("mine/p1/reviewer-1.json"))));
    }

    #[test]
    fn move_puts_the_folder_back_when_the_project_file_cannot_be_written() {
        let d = tmp("ann-move-back");
        let own = d.join("a.json");
        fs::write(&own, "[]").unwrap();
        fs::create_dir_all(d.join("annotations/p1")).unwrap();
        let ses = known_session(&own);
        let path = own.display().to_string();
        // Not a JSON object: refused before anything moves.
        assert!(move_dir(&ses, &path, "mine").is_err());
        assert!(d.join("annotations/p1").exists());
        assert!(!d.join("mine").exists());

        fs::write(&own, r#"{"papers":[]}"#).unwrap();
        let mut perms = fs::metadata(&own).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&own, perms.clone()).unwrap();
        // Root writes read-only files anyway; nothing to prove then.
        if fs::OpenOptions::new().write(true).open(&own).is_err() {
            assert!(move_dir(&ses, &path, "mine").is_err());
            assert!(d.join("annotations/p1").exists());
            assert!(!d.join("mine").exists());
        }
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(&own, perms).unwrap();
    }

    #[test]
    fn shared_lists_then_split_moves_files_and_rewrites_projects() {
        let d = tmp("ann-split");
        let a = d.join("a.json");
        let b = d.join("b.json");
        fs::write(&a, r#"{"papers":[{"id":"p1"},{"id":"p2"}]}"#).unwrap();
        fs::write(&b, r#"{"papers":[{"id":"p1"}]}"#).unwrap();
        for (rel, text) in [
            ("p1/reviewer-1.json", "{\"n\":1}"),
            ("p2/reviewer-1.json", "{\"n\":2}"),
            ("p2/notes.txt", "x"),
            ("feedback/x.json", "{}"),
        ] {
            let f = d.join("annotations").join(rel);
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::write(f, text).unwrap();
        }
        let path = a.display().to_string();
        assert!(shared(&Mutex::new(Session::default()), &path).is_err());
        let ses = known_session(&a);
        let plan_for = |folders: &[(&Path, &str)], rows: &[(&str, &[&Path])]| SplitPlan {
            folders: folders
                .iter()
                .map(|(p, f)| (p.display().to_string(), f.to_string()))
                .collect(),
            rows: rows
                .iter()
                .map(|(r, ts)| SplitRow {
                    rel_path: r.to_string(),
                    targets: ts.iter().map(|t| t.display().to_string()).collect(),
                })
                .collect(),
        };
        assert!(split(&ses, &path, &plan_for(&[], &[]))
            .unwrap_err()
            .contains("List the shared folder first"));

        let listed = shared(&ses, &path).unwrap().unwrap();
        assert_eq!(listed.folder, "annotations");
        let names: Vec<_> = listed.projects.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["a.json", "b.json"]);
        let rels: Vec<_> = listed.files.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(rels, ["p1/reviewer-1.json", "p2/reviewer-1.json"]);

        let good = plan_for(
            &[(&a, "a-ann"), (&b, "b-ann")],
            &[
                ("p1/reviewer-1.json", &[&a, &b]),
                ("p2/reviewer-1.json", &[&a]),
            ],
        );
        for (bad, msg) in [
            (plan_for(&[(&a, "a-ann")], &[]), "every listed project"),
            (plan_for(&[(&a, "x"), (&b, "X")], &[]), "share one folder"),
            (
                plan_for(&[(&a, "annotations"), (&b, "y")], &[]),
                "other than",
            ),
            (plan_for(&[(&a, "../x"), (&b, "y")], &[]), "cannot be"),
            (
                plan_for(&[(&a, "x"), (&b, "y")], &[("feedback/x.json", &[&a])]),
                "not in the listed folder",
            ),
            (
                plan_for(
                    &[(&a, "x"), (&b, "y")],
                    &[("p1/reviewer-1.json", &[&d.join("c.json")])],
                ),
                "unknown project",
            ),
        ] {
            assert!(split(&ses, &path, &bad).unwrap_err().contains(msg), "{msg}");
        }
        fs::write(&b, r#"{"papers":[{"id":"p1"}],"title":"changed"}"#).unwrap();
        assert!(split(&ses, &path, &good)
            .unwrap_err()
            .contains("changed since"));
        assert!(!d.join("a-ann").exists());

        shared(&ses, &path).unwrap().unwrap();
        split(&ses, &path, &good).unwrap();
        let read = |r: &str| fs::read_to_string(d.join(r)).unwrap();
        assert_eq!(read("a-ann/p1/reviewer-1.json"), "{\"n\":1}");
        assert_eq!(read("b-ann/p1/reviewer-1.json"), "{\"n\":1}");
        assert_eq!(read("a-ann/p2/reviewer-1.json"), "{\"n\":2}");
        assert!(!d.join("annotations/p1").exists());
        assert!(d.join("annotations/p2/notes.txt").exists());
        assert_eq!(annotations_dir_of(&read_json(&a).unwrap()), "a-ann");
        assert_eq!(annotations_dir_of(&read_json(&b).unwrap()), "b-ann");
        assert!(split(&ses, &path, &good)
            .unwrap_err()
            .contains("List the shared folder first"));
    }
}
