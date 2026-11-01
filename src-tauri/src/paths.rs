//! Node `path` semantics the Electron handlers relied on, plus the `paths:*` commands.

use crate::authz::{lock, Session};
use std::path::{Component, Path, PathBuf, MAIN_SEPARATOR_STR};
use std::sync::Mutex;
use tauri::State;

/// Node's `path.resolve(base, rel)`: absolute, `.`/`..` folded lexically, no links followed.
pub fn resolve(base: &Path, rel: &Path) -> PathBuf {
    let joined = base.join(rel);
    let joined = std::path::absolute(&joined).unwrap_or(joined);
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            c => out.push(c),
        }
    }
    out
}

/// Node's `path.resolve(p)`.
pub fn normalize(p: &Path) -> PathBuf {
    resolve(p, Path::new(""))
}

/// Node's `path.dirname(p)` for the absolute paths the renderer sends.
pub fn dir_of(p: &Path) -> &Path {
    p.parent().unwrap_or(p)
}

/// Native separators to `/`, like `.split(path.sep).join('/')`.
pub fn slashed(p: &Path) -> String {
    p.to_string_lossy().replace(MAIN_SEPARATOR_STR, "/")
}

#[cfg(windows)]
fn same(a: &Component, b: &Component) -> bool {
    a.as_os_str().to_string_lossy().to_lowercase() == b.as_os_str().to_string_lossy().to_lowercase()
}

#[cfg(not(windows))]
fn same(a: &Component, b: &Component) -> bool {
    a == b
}

/// Node's `path.relative(from, to)`, `/`-separated. Another drive yields `to` itself.
pub fn relative(from: &Path, to: &Path) -> String {
    let (from, to) = (normalize(from), normalize(to));
    let a: Vec<_> = from.components().collect();
    let b: Vec<_> = to.components().collect();
    let common = a.iter().zip(&b).take_while(|(x, y)| same(x, y)).count();
    if common == 0 {
        return slashed(&to);
    }
    let mut out = PathBuf::new();
    for _ in common..a.len() {
        out.push("..");
    }
    for c in &b[common..] {
        out.push(c);
    }
    slashed(&out)
}

#[tauri::command]
pub async fn paths_relative(
    from_file: String,
    to_files: Vec<String>,
) -> Result<Vec<String>, String> {
    let from_dir = dir_of(Path::new(&from_file));
    Ok(to_files
        .iter()
        .map(|t| relative(from_dir, Path::new(t)))
        .collect())
}

#[tauri::command]
pub async fn paths_rebase(
    from_file: String,
    to_file: String,
    rels: Vec<String>,
) -> Result<Vec<String>, String> {
    let (from_dir, to_dir) = (dir_of(Path::new(&from_file)), dir_of(Path::new(&to_file)));
    Ok(rels
        .iter()
        .map(|r| relative(to_dir, &resolve(from_dir, Path::new(r))))
        .collect())
}

#[tauri::command]
pub async fn paths_absolute(from_file: String, rels: Vec<String>) -> Result<Vec<String>, String> {
    let from_dir = dir_of(Path::new(&from_file));
    Ok(rels
        .iter()
        .map(|r| resolve(from_dir, Path::new(r)).display().to_string())
        .collect())
}

/// A fresh file next to a project this session knows; registered as a save target.
pub fn sibling(
    session: &Mutex<Session>,
    source_file: &str,
    file_name: &str,
) -> Result<String, String> {
    let source = Path::new(source_file);
    if !lock(session).is_known(source) {
        return Err(format!(
            "\"{source_file}\" is not a project this session has open."
        ));
    }
    let safe = Path::new(file_name).file_name().and_then(|n| n.to_str());
    if safe != Some(file_name) {
        return Err(format!("\"{file_name}\" is not a valid file name."));
    }
    let result = dir_of(source).join(file_name);
    lock(session).known_projects.insert(normalize(&result));
    Ok(result.display().to_string())
}

#[tauri::command]
pub async fn paths_sibling(
    session: State<'_, Mutex<Session>>,
    source_file: String,
    file_name: String,
) -> Result<String, String> {
    sibling(&session, &source_file, &file_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_folds_dots_and_keeps_root() {
        let root = normalize(Path::new("/"));
        assert_eq!(
            resolve(&root.join("a/b"), Path::new("../c/./d")),
            root.join("a/c/d")
        );
        assert_eq!(resolve(&root, Path::new("../../x")), root.join("x"));
        assert_eq!(resolve(&root.join("a"), &root.join("z")), root.join("z"));
    }

    #[test]
    fn relative_matches_node() {
        let r = normalize(Path::new("/"));
        assert_eq!(
            relative(&r.join("p"), &r.join("p/pdfs/a.pdf")),
            "pdfs/a.pdf"
        );
        assert_eq!(relative(&r.join("p/q"), &r.join("p/x/a.pdf")), "../x/a.pdf");
        assert_eq!(relative(&r.join("p"), &r.join("p")), "");
        assert_eq!(relative(&r.join("p/q"), &r.join("p")), "..");
    }

    #[test]
    fn rebase_and_absolute() {
        let r = normalize(Path::new("/"));
        let from = r.join("old/proj.json").display().to_string();
        let to = r.join("new/deep/proj.json").display().to_string();
        let rebased = tauri::async_runtime::block_on(paths_rebase(
            from.clone(),
            to,
            vec!["pdfs/a.pdf".into()],
        ))
        .unwrap();
        assert_eq!(rebased, ["../../old/pdfs/a.pdf"]);
        let abs = tauri::async_runtime::block_on(paths_absolute(from, vec!["../x/./a.pdf".into()]))
            .unwrap();
        assert_eq!(abs, [r.join("x/a.pdf").display().to_string()]);
    }

    #[cfg(not(windows))]
    #[test]
    fn backslash_is_a_plain_character_on_posix() {
        assert_eq!(
            relative(Path::new("/p"), Path::new("/p/a\\b.pdf")),
            "a\\b.pdf"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_separators_case_and_drives() {
        assert_eq!(
            relative(Path::new(r"C:\p"), Path::new(r"c:\P\pdfs\a.pdf")),
            "pdfs/a.pdf"
        );
        assert_eq!(
            relative(Path::new(r"C:\p"), Path::new("C:/p/x/../b.pdf")),
            "b.pdf"
        );
        assert_eq!(
            relative(Path::new(r"C:\p"), Path::new(r"D:\x\a.pdf")),
            "D:/x/a.pdf"
        );
        assert_eq!(
            resolve(Path::new(r"C:\p"), Path::new("a/b.pdf")),
            PathBuf::from(r"C:\p\a\b.pdf")
        );
    }

    #[test]
    fn sibling_requires_known_source_and_plain_name() {
        let session = Mutex::new(Session::default());
        let src = normalize(Path::new("/proj/a.json")).display().to_string();
        assert!(sibling(&session, &src, "b.json").is_err());
        lock(&session)
            .known_projects
            .insert(normalize(Path::new(&src)));
        for bad in ["", "..", ".", "sub/b.json", "../b.json"] {
            assert!(sibling(&session, &src, bad).is_err(), "{bad}");
        }
        let made = sibling(&session, &src, "b.json").unwrap();
        assert!(lock(&session).is_known(Path::new(&made)));
    }
}
