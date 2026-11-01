//! Session authorization state (REQ-PLT-30) and the shared "real destination" checks.
//! Mirrors the module-level sets in electron/main.ts; nothing here is persisted.

use crate::paths::normalize;
use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

#[derive(Default)]
pub struct Session {
    /// Directory PDFs resolve against (`projectDir`).
    pub project_dir: Option<PathBuf>,
    /// Stored `pdf` values the reviewer agreed to open outside `project_dir` (`allowedEscapes`).
    pub allowed_escapes: HashSet<String>,
    /// Project files opened or chosen via a dialog this session (`knownProjectPaths`).
    pub known_projects: HashSet<PathBuf>,
    /// PDFs returned by `pdf:pick`/`pdf:pickFolder` (`readablePdfPaths`).
    pub readable_pdfs: HashSet<PathBuf>,
    /// Targets chosen in an export dialog (`writableExportPaths`).
    pub writable_exports: HashSet<PathBuf>,
    /// `mtime:size` per file, per project, as last read or written (`projectFileStamps`).
    pub stamps: HashMap<PathBuf, HashMap<PathBuf, String>>,
    /// Repository roots resolved by `git:info` or created by `git:clone` (`knownGitRoots`).
    pub known_git_roots: HashSet<PathBuf>,
}

impl Session {
    pub fn is_known(&self, project: &Path) -> bool {
        self.known_projects.contains(&normalize(project))
    }

    /// Remember `abs` as it is right now for `project` (`rememberStamp`).
    pub fn remember(&mut self, project: &Path, abs: &Path) {
        let stamps = self.stamps.entry(normalize(project)).or_default();
        match stamp(abs) {
            Some(s) => stamps.insert(normalize(abs), s),
            None => stamps.remove(&normalize(abs)),
        };
    }
}

pub fn lock(m: &Mutex<Session>) -> MutexGuard<'_, Session> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Error text for the renderer.
pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub fn stamp(abs: &Path) -> Option<String> {
    let m = std::fs::metadata(abs).ok()?;
    let t = m
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some(format!("{}:{}", t.as_nanos(), m.len()))
}

/// `changedTargets` from src/model/fileStamps.ts.
pub fn changed(known: Option<&String>, now: Option<&String>) -> bool {
    match known {
        None => now.is_some(),
        Some(k) => now.is_some_and(|n| n != k),
    }
}

/// `real` is `base` or below it, component-wise (`x === b || x.startsWith(b + sep)`).
pub fn within(real: &Path, base: &Path) -> bool {
    real.starts_with(base)
}

/// `assertNotSymlink`: a missing file is fine, a link is refused.
pub fn assert_not_symlink(p: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.file_type().is_symlink() => Err(format!(
            "Refusing to write to \"{}\": it is a symbolic link, and writing would modify the file it points at instead.",
            p.display()
        )),
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(err(e)),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changed_targets_rule() {
        let a = "1:2".to_string();
        let b = "3:4".to_string();
        assert!(!changed(None, None));
        assert!(changed(None, Some(&a)));
        assert!(!changed(Some(&a), Some(&a)));
        assert!(changed(Some(&a), Some(&b)));
        assert!(!changed(Some(&a), None));
    }
}
