//! `project:writeFeedback`/`project:listFeedback` (electron/feedback.ts and its handlers).

use crate::authz::{err, lock, Session};
use crate::paths::{dir_of, normalize, relative};
use crate::project::{annotations_dir_for, read_meta, FEEDBACK_DIR};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

pub const MAX_FEEDBACK_BYTES: usize = 1024 * 1024;

/// `/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,114}\.json$/`
pub fn file_name_problem(name: &str) -> Option<&'static str> {
    let ok_char = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'-';
    let ok = name.strip_suffix(".json").is_some_and(|stem| {
        let b = stem.as_bytes();
        (1..=115).contains(&b.len()) && ok_char(b[0]) && b.iter().all(|&c| ok_char(c) || c == b'.')
    });
    (!ok).then_some(
        "Feedback file names are letters, digits, \".\" \"_\" \"-\" (up to 120 characters), must not start with a dot, and end in .json.",
    )
}

pub fn content_problem(content: &str) -> Option<&'static str> {
    if content.len() > MAX_FEEDBACK_BYTES {
        return Some("Feedback content is larger than 1 MB.");
    }
    match serde_json::from_str::<Value>(content) {
        Err(_) => Some("Feedback content is not valid JSON."),
        Ok(Value::Object(_)) => None,
        Ok(_) => Some("Feedback content must be a JSON object."),
    }
}

/// `feedbackDirFor`: `None` when absent and not to be created.
fn feedback_dir_for(
    session: &Mutex<Session>,
    project: &Path,
    create: bool,
) -> Result<Option<PathBuf>, String> {
    let key = normalize(project);
    if !lock(session).known_projects.contains(&key) {
        return Err("Refusing to use a project that was not opened this session.".into());
    }
    let base = annotations_dir_for(&key, &read_meta(&key))?;
    let dir = base.join(FEEDBACK_DIR);
    if create {
        fs::create_dir_all(&dir).map_err(err)?;
    }
    match fs::symlink_metadata(&dir) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(err(e)),
        Ok(m) if m.file_type().is_symlink() || !m.is_dir() => {
            return Err(format!(
                "Refusing a feedback folder that is a link or not a folder: \"{}\"",
                dir.display()
            ))
        }
        Ok(_) => {}
    }
    let (real_dir, real_base) = (
        dir.canonicalize().map_err(err)?,
        base.canonicalize().map_err(err)?,
    );
    if real_dir.parent() != Some(real_base.as_path()) {
        return Err(format!(
            "Refusing a feedback folder outside the annotations folder: \"{}\"",
            dir.display()
        ));
    }
    Ok(Some(dir))
}

pub fn write_feedback(
    session: &Mutex<Session>,
    project: &Path,
    name: &str,
    content: &str,
) -> Result<String, String> {
    if let Some(p) = file_name_problem(name).or_else(|| content_problem(content)) {
        return Err(p.into());
    }
    let dir = feedback_dir_for(session, project, true)?.ok_or("Feedback folder missing.")?;
    let target = dir.join(name);
    if fs::symlink_metadata(&target).is_ok() {
        return Err(format!("Feedback file \"{name}\" already exists."));
    }
    // ponytail: exists-check then rename can race a concurrent writer of the same name; callers use unique names.
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    fs::write(&tmp, content).map_err(err)?;
    fs::rename(&tmp, &target).map_err(err)?;
    Ok(relative(dir_of(&normalize(project)), &target))
}

#[derive(Serialize, Debug, PartialEq)]
pub struct FeedbackFile {
    name: String,
    bytes: u64,
}

pub fn list_feedback(
    session: &Mutex<Session>,
    project: &Path,
) -> Result<Vec<FeedbackFile>, String> {
    let Some(dir) = feedback_dir_for(session, project, false)? else {
        return Ok(vec![]);
    };
    let mut out: Vec<FeedbackFile> = fs::read_dir(&dir)
        .map_err(err)?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            file_name_problem(&name).is_none().then_some(FeedbackFile {
                bytes: e.metadata().ok()?.len(),
                name,
            })
        })
        .collect();
    // ponytail: approximates `localeCompare` for the ASCII names allowed here; use ICU collation if names widen.
    out.sort_by(|a, b| (a.name.to_lowercase(), &a.name).cmp(&(b.name.to_lowercase(), &b.name)));
    Ok(out)
}

#[tauri::command]
pub async fn project_write_feedback(
    session: State<'_, Mutex<Session>>,
    project_path: String,
    file_name: String,
    content: String,
) -> Result<String, String> {
    write_feedback(&session, Path::new(&project_path), &file_name, &content)
}

#[tauri::command]
pub async fn project_list_feedback(
    session: State<'_, Mutex<Session>>,
    project_path: String,
) -> Result<Vec<FeedbackFile>, String> {
    list_feedback(&session, Path::new(&project_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::tests::tmp;

    #[test]
    fn name_and_content_rules() {
        for ok in [
            "a.json",
            "run-1_x.v2.json",
            &format!("{}.json", "a".repeat(115)),
        ] {
            assert!(file_name_problem(ok).is_none(), "{ok}");
        }
        for bad in [
            ".a.json",
            "a.JSON",
            ".json",
            "a/b.json",
            "a b.json",
            "ä.json",
            &format!("{}.json", "a".repeat(116)),
        ] {
            assert!(file_name_problem(bad).is_some(), "{bad}");
        }
        assert!(content_problem("{}").is_none());
        assert_eq!(
            content_problem("[]"),
            Some("Feedback content must be a JSON object.")
        );
        assert_eq!(
            content_problem("{"),
            Some("Feedback content is not valid JSON.")
        );
        assert!(
            content_problem(&format!("{{\"a\":\"{}\"}}", "x".repeat(MAX_FEEDBACK_BYTES))).is_some()
        );
    }

    #[test]
    fn write_never_overwrites_and_lists_sorted() {
        let d = tmp("feedback");
        let s = Mutex::new(Session::default());
        let proj = d.join("p.json");
        fs::write(&proj, r#"{"papers":[]}"#).unwrap();
        assert!(write_feedback(&s, &proj, "a.json", "{}")
            .unwrap_err()
            .starts_with("Refusing to use"));
        lock(&s).known_projects.insert(normalize(&proj));
        assert!(list_feedback(&s, &proj).unwrap().is_empty());
        assert_eq!(
            write_feedback(&s, &proj, "B.json", "{}").unwrap(),
            "annotations/feedback/B.json"
        );
        write_feedback(&s, &proj, "a.json", "{\"x\":1}").unwrap();
        assert!(write_feedback(&s, &proj, "a.json", "{}")
            .unwrap_err()
            .contains("already exists"));
        fs::write(d.join("annotations/feedback/.hidden.json"), "{}").unwrap();
        let names: Vec<_> = list_feedback(&s, &proj)
            .unwrap()
            .into_iter()
            .map(|f| f.name)
            .collect();
        assert_eq!(names, ["a.json", "B.json"]);
    }
}
