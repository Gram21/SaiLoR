//! `git:*` handlers. git runs as a child process with a fixed argument vector,
//! hardened config and environment, and a timeout. The string validators here
//! are the trust-boundary copies of src/git/{url,ref,relpath}.ts. Raw output that
//! Electron passed through (status porcelain, diff) still crosses to TypeScript.

use crate::authz::{assert_not_symlink, err, lock, within, Session};
use crate::paths::{dir_of, normalize};
use crate::project::{
    self, annotations_dir_of, annotations_dir_ok, read_lossy, read_meta, FileText, Opened,
    SaveFile, DEFAULT_ANNOTATIONS_DIR, FEEDBACK_DIR,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const TIMEOUT: Duration = Duration::from_secs(30);
/// Clone, push, and the fetch before a pull or merge.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(900);
/// `BACKGROUND_FETCH_TIMEOUT_MS` from src/git/fetchPolicy.ts.
const BACKGROUND_FETCH_TIMEOUT: Duration = Duration::from_secs(60);
const LOG_MAX_COMMITS: usize = 250;

/// Inherited variables that would point git at another repository (`gitEnv`).
const STRIPPED_ENV: [&str; 7] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_GLOBAL",
];

/// `NON_INTERACTIVE_ENV` from src/git/fetchPolicy.ts.
const NON_INTERACTIVE_ENV: [(&str, &str); 4] = [
    ("GCM_INTERACTIVE", "never"),
    ("SSH_ASKPASS_REQUIRE", "never"),
    ("GIT_ASKPASS", ""),
    ("SSH_ASKPASS", ""),
];

/// `FETCH_COMMAND_KEYS` from src/git/fetchPolicy.ts (a regex git evaluates).
const FETCH_COMMAND_KEYS: &str = r"^(core\.(sshcommand|gitproxy|askpass)|credential\..*helper|remote\..*\.(uploadpack|receivepack)|include\.path|includeif\..*\.path)$";

const BRANCH_SWITCH_STASH_MESSAGE: &str = "sailor: switching branch";
const MANUAL_STASH_PREFIX: &str = "sailor stash: ";
const STASH_LIST_FORMAT: &str = "%gd%x09%H%x09%cI%x09%gs%x00";
const CARRY_OVER_STRANDED: &str = "Your uncommitted changes were not lost — they are kept as a stash. Open Git and use \"Stashed changes\" to restore them.";

const SETUP_AUTHOR: &str = "SaiLoR <noreply@sailor.invalid>";
const SETUP_COMMIT_MESSAGE: &str = "chore: configure git for SaiLoR annotation data\n\n\
Normalises JSON to LF so a Windows checkout does not rewrite every line,\n\
and stops git line-merging annotation files, which can combine two\n\
reviewers' answers into something clean and wrong. Also ignores the OS\n\
and editor droppings that would otherwise block a merge from inside\n\
SaiLoR by sitting untracked in the annotations folder.";
const BLOCK_BEGIN: &str = "# >>> SaiLoR (managed) >>>";
const BLOCK_END: &str = "# <<< SaiLoR (managed) <<<";
const ATTRIBUTES_BODY: &str =
    "# Annotation data is JSON that SaiLoR rewrites in full on every save.
#
# eol=lf: git's Windows default (core.autocrlf) would rewrite every line on
# checkout and back on commit, turning one reviewer on Windows into a source
# of whole-file diffs and phantom conflicts for the whole team.
#
# -merge: git's line merge can combine two reviewers' answers into something
# clean and wrong — valid JSON neither of them wrote. SaiLoR re-derives a
# merge from the committed revisions instead, so it never reads that result;
# this makes git conflict honestly for anyone merging outside the app.
*.json text eol=lf -merge";
const IGNORE_BODY: &str =
    "# Not just tidiness: SaiLoR refuses to merge while an untracked file sits in
# the annotations/ folder, so one of these dropped there by the Finder or
# Explorer blocks every pull until somebody deletes it by hand.
.DS_Store
Thumbs.db
desktop.ini
*~
.*.swp";

// ---- Running git ----

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct GitRun {
    pub ok: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl GitRun {
    fn failed(stderr: impl Into<String>) -> Self {
        GitRun {
            ok: false,
            code: None,
            stdout: String::new(),
            stderr: stderr.into(),
        }
    }

    fn done() -> Self {
        GitRun {
            ok: true,
            code: Some(0),
            stdout: String::new(),
            stderr: String::new(),
        }
    }

    fn out(&self) -> &str {
        self.stdout.trim()
    }
}

/// `GIT_SAFE_CONFIG`: `-c` beats every config file, so a received repository
/// cannot name a command git runs on `status` or `diff`.
fn safe_config() -> Vec<String> {
    let hooks = std::env::temp_dir().join("sailor-no-hooks-does-not-exist");
    [
        "core.fsmonitor=false".to_string(),
        format!("core.hooksPath={}", hooks.display()),
        "core.pager=cat".into(),
        "core.editor=false".into(),
        "core.alternateRefsCommand=".into(),
        "uploadpack.packObjectsHook=".into(),
        "protocol.ext.allow=never".into(),
    ]
    .into_iter()
    .flat_map(|kv| ["-c".to_string(), kv])
    .collect()
}

fn reader<R: Read + Send + 'static>(pipe: Option<R>) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut p) = pipe {
            let _ = p.read_to_end(&mut buf);
        }
        let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
    });
    rx
}

/// `runGit`: a non-zero exit is data, not an error. `code: None` means git did
/// not start or was killed at `timeout`.
pub fn run_git(
    args: &[&str],
    cwd: Option<&Path>,
    timeout: Duration,
    extra_env: &[(&str, &str)],
) -> GitRun {
    let mut cmd = Command::new("git");
    cmd.args(safe_config())
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    for k in STRIPPED_ENV {
        cmd.env_remove(k);
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true");
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return GitRun::failed(e.to_string()),
    };
    let (out, errs) = (reader(child.stdout.take()), reader(child.stderr.take()));
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if start.elapsed() < timeout => thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let Some(status) = status else {
        // A grandchild (ssh, a credential helper) may still hold the pipes open.
        let grace = Duration::from_secs(1);
        return GitRun {
            ok: false,
            code: None,
            stdout: out.recv_timeout(grace).unwrap_or_default(),
            stderr: format!("git timed out after {}s.", timeout.as_secs()),
        };
    };
    GitRun {
        ok: status.success(),
        code: status.code(),
        stdout: out.recv().unwrap_or_default(),
        stderr: errs.recv().unwrap_or_default(),
    }
}

fn git(root: &Path, args: &[&str]) -> GitRun {
    run_git(args, Some(root), TIMEOUT, &[])
}

fn git_owned(root: &Path, args: &[String]) -> GitRun {
    git(root, &args.iter().map(String::as_str).collect::<Vec<_>>())
}

/// `gitErrorText` from src/git/output.ts.
pub fn error_text(r: &GitRun) -> String {
    let (e, o) = (r.stderr.trim(), r.stdout.trim());
    if !e.is_empty() {
        return if o.is_empty() {
            e.to_string()
        } else {
            format!("{e}\n{o}")
        };
    }
    if !o.is_empty() {
        return o.to_string();
    }
    match r.code {
        None => "git could not be started.".into(),
        Some(c) => format!("git exited with code {c}."),
    }
}

fn non_empty(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_string())
}

/// JavaScript's `String.prototype.trim`.
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

// ---- Validators (src/git/relpath.ts, ref.ts, url.ts) ----

/// `relPathProblem`: `None` when `p` is a safe repo-relative path.
pub fn rel_path_problem(p: &str) -> Option<&'static str> {
    if p.is_empty() {
        return Some("empty");
    }
    if p.contains(['\0', '\r', '\n']) {
        return Some("control-char");
    }
    let b = p.as_bytes();
    if (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':') || p.starts_with(['/', '\\']) {
        return Some("absolute");
    }
    let segments: Vec<&str> = p.split(['/', '\\']).collect();
    if segments.contains(&"..") {
        return Some("traversal");
    }
    if segments
        .iter()
        .any(|s| js_trim(s).to_lowercase().trim_end_matches(['.', ' ']) == ".git")
    {
        return Some("dot-git");
    }
    None
}

/// `refProblem`: `None` when `r` is a safe branch name.
pub fn ref_problem(r: &str) -> Option<&'static str> {
    if r.is_empty() {
        return Some("empty");
    }
    if r.starts_with('-') {
        return Some("option-like");
    }
    if r.chars().any(|c| c < '\u{20}' || c == '\u{7f}') {
        return Some("control-char");
    }
    let bad = r
        .chars()
        .any(|c| c.is_whitespace() || c == '\u{feff}' || "~^:?*[\\".contains(c))
        || r.contains("..")
        || r.contains("@{")
        || r.starts_with('/')
        || r.ends_with('/')
        || r.contains("//")
        || r.ends_with('.')
        || r.split('/')
            .any(|s| s.is_empty() || s.starts_with('.') || s.ends_with(".lock"));
    bad.then_some("bad-syntax")
}

const ALLOWED_SCHEMES: [&str; 6] = [
    "https://",
    "http://",
    "ssh://",
    "git://",
    "git+ssh://",
    "file://",
];

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `SCP_LIKE`: `^[\w.+-]+@[\w.-]+:(?!\/)`.
fn scp_like(url: &str) -> bool {
    let Some((user, rest)) = url.split_once('@') else {
        return false;
    };
    let host_len = rest
        .find(|c: char| !(is_word(c) || c == '.' || c == '-'))
        .unwrap_or(rest.len());
    !user.is_empty()
        && user.chars().all(|c| is_word(c) || ".+-".contains(c))
        && host_len > 0
        && rest[host_len..].starts_with(':')
        && !rest[host_len + 1..].starts_with('/')
}

/// `WINDOWS_PATH`: `^[A-Za-z]:[\\/]`.
fn windows_path(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/')
}

/// `REMOTE_HELPER`: `^[A-Za-z0-9+.-]*::`.
fn remote_helper(s: &str) -> bool {
    let n = s
        .find(|c: char| !(c.is_ascii_alphanumeric() || "+.-".contains(c)))
        .unwrap_or(s.len());
    s[n..].starts_with("::")
}

/// `validateGitUrl`: `None` when acceptable, else the message to show.
pub fn validate_git_url(raw: &str) -> Option<&'static str> {
    let url = js_trim(raw);
    if url.is_empty() {
        return Some("Enter the repository URL.");
    }
    if url.contains(['\0', '\r', '\n']) {
        return Some("The URL contains a line break or a null byte.");
    }
    if url.starts_with('-') {
        return Some("A URL cannot start with \"-\" — git would read it as an option.");
    }
    if remote_helper(url) {
        return Some("Remote-helper URLs (\"ext::…\") are not accepted: they make git run a program named by the URL.");
    }
    let lower = url.to_lowercase();
    if ALLOWED_SCHEMES.iter().any(|s| lower.starts_with(s))
        || scp_like(url)
        || url.starts_with('/')
        || windows_path(url)
    {
        return None;
    }
    Some("Use an https://, ssh://, git:// or file:// URL, a git@host:org/repo path, or an absolute path to a local repository.")
}

/// `validateClonePath`.
pub fn validate_clone_path(dest: &str) -> Option<&'static str> {
    let d = js_trim(dest);
    if d.is_empty() {
        return Some("Choose where to clone the repository.");
    }
    if d.contains(['\0', '\r', '\n']) {
        return Some("The destination contains a line break or a null byte.");
    }
    if d.starts_with('-') {
        return Some("A destination cannot start with \"-\" — git would read it as an option.");
    }
    if !(d.starts_with('/') || windows_path(d)) {
        return Some("The destination must be an absolute path.");
    }
    None
}

fn assert_rel_path(p: &str) -> Result<(), String> {
    match rel_path_problem(p) {
        Some(why) => Err(format!("Refusing to act on the path \"{p}\" ({why}).")),
        None => Ok(()),
    }
}

fn assert_ref(r: &str) -> Result<(), String> {
    match ref_problem(r) {
        Some(why) => Err(format!("Refusing to act on the ref \"{r}\" ({why}).")),
        None => Ok(()),
    }
}

/// A stash is named by commit sha across IPC.
fn assert_sha(sha: &str) -> Result<(), String> {
    let hex = sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if hex && (sha.len() == 40 || sha.len() == 64) {
        Ok(())
    } else {
        Err("Not a valid stash id.".into())
    }
}

/// `assertRoot`: `root` came from `git:info` or `git:clone` this session.
fn assert_root(session: &Mutex<Session>, root: &str) -> Result<PathBuf, String> {
    let p = normalize(Path::new(root));
    if lock(session).known_git_roots.contains(&p) {
        Ok(p)
    } else {
        Err(format!(
            "Refusing to act on \"{root}\": not a repository this session opened."
        ))
    }
}

/// `assertInsideRoot`: the real parent folder of `file` lies inside `root`.
fn assert_inside_root(root: &Path, file: &Path) -> Result<(), String> {
    let base = root.canonicalize().map_err(err)?;
    let parent = match dir_of(file).canonicalize() {
        Ok(p) => p,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Err(format!(
                "Refusing to write to \"{}\": its folder does not exist.",
                file.display()
            ))
        }
        Err(e) => return Err(err(e)),
    };
    if !within(&parent, &base) {
        return Err(format!(
            "Refusing to write to \"{}\": it resolves to \"{}\", outside the repository.",
            file.display(),
            parent.display()
        ));
    }
    Ok(())
}

// ---- Parsers and pure rules ----

#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub path: String,
    pub code: String,
    pub unmerged: bool,
    pub from: Option<String>,
}

/// `parsePorcelain`: `git status --porcelain=v1 -z`.
pub fn parse_porcelain(raw: &str) -> Vec<Change> {
    let records: Vec<&str> = raw.split('\0').filter(|r| !r.is_empty()).collect();
    let mut out = vec![];
    let mut i = 0;
    while i < records.len() {
        let rec = records[i];
        i += 1;
        let at = |n: usize| rec.char_indices().nth(n).map(|(i, _)| i);
        let (Some(two), Some(three)) = (at(2), at(3)) else {
            continue;
        };
        let code = &rec[..two];
        let mut c = code.chars();
        let (x, y) = (c.next().unwrap_or(' '), c.next().unwrap_or(' '));
        let from = if x == 'R' || x == 'C' {
            i += 1;
            records.get(i - 1).map(|s| s.to_string())
        } else {
            None
        };
        out.push(Change {
            path: rec[three..].to_string(),
            code: code.to_string(),
            unmerged: x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D'),
            from,
        });
    }
    out
}

#[derive(Serialize, Debug, PartialEq)]
pub struct CommitRecord {
    hash: String,
    date: String,
    subject: String,
}

/// `parseGitLog`: `git log --format=%x00%H%x09%aI%x09%s`.
pub fn parse_git_log(raw: &str) -> Vec<CommitRecord> {
    raw.split('\0')
        .filter_map(|rec| {
            let mut f = rec.splitn(3, '\t');
            let (hash, date, subject) = (f.next()?, f.next()?, f.next()?);
            (!hash.is_empty()).then(|| CommitRecord {
                hash: hash.into(),
                date: date.into(),
                subject: subject.into(),
            })
        })
        .collect()
}

#[derive(Serialize, Debug, PartialEq)]
pub struct StashEntry {
    sha: String,
    #[serde(rename = "ref")]
    stash_ref: String,
    date: String,
    branch: Option<String>,
    message: String,
    origin: &'static str,
}

/// `^(?:WIP on|On) ([^:]+): (.*)$` without a regex.
fn split_stash_subject(s: &str) -> Option<(&str, &str)> {
    let rest = s
        .strip_prefix("WIP on ")
        .or_else(|| s.strip_prefix("On "))?;
    let (branch, after) = rest.split_once(':')?;
    Some((branch, after.strip_prefix(' ')?)).filter(|(b, _)| !b.is_empty())
}

/// `parseStashList` from src/git/stash.ts.
pub fn parse_stash_list(stdout: &str) -> Vec<StashEntry> {
    stdout
        .split('\0')
        .filter_map(|rec| {
            let line = rec.trim_start_matches('\n');
            let mut f = line.splitn(4, '\t');
            let (r, sha) = (f.next().unwrap_or(""), f.next().unwrap_or(""));
            if r.is_empty() || sha.is_empty() {
                return None;
            }
            let date = f.next().unwrap_or("");
            let subject = f.next().unwrap_or("");
            let (branch, message) = match split_stash_subject(subject) {
                Some((b, m)) => (Some(b.to_string()), m),
                None => (None, subject),
            };
            let origin = if message == BRANCH_SWITCH_STASH_MESSAGE {
                "branch-switch"
            } else if message.starts_with(MANUAL_STASH_PREFIX) {
                "sailor"
            } else {
                "other"
            };
            Some(StashEntry {
                sha: sha.into(),
                stash_ref: r.into(),
                date: date.into(),
                branch,
                message: message.into(),
                origin,
            })
        })
        .collect()
}

/// `parseAnnotationAuthors` from src/git/seatOwner.ts: newest author per file.
pub fn parse_annotation_authors(stdout: &str, dir: &str) -> Map<String, Value> {
    let prefix = format!("{dir}/");
    let mut files = Map::new();
    for rec in stdout.split('\0') {
        let mut lines = rec.split('\n');
        let mut header = lines.next().unwrap_or("").split('\t');
        let (name, email) = (header.next().unwrap_or(""), header.next().unwrap_or(""));
        if name.is_empty() && email.is_empty() {
            continue;
        }
        for line in lines {
            if let Some(rel) = js_trim(line).strip_prefix(&prefix) {
                files
                    .entry(rel)
                    .or_insert_with(|| json!({ "name": name, "email": email }));
            }
        }
    }
    files
}

/// JavaScript truthiness of a JSON value.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `ownAnnotationPathMatcher`: does `<paperId>/<name>.json` belong to `raw`'s family?
pub fn own_matcher(raw: &Value) -> impl Fn(&str) -> bool {
    let ids: HashSet<String> = raw
        .get("papers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|p| Some(p.get("id")?.as_str()?.to_string()))
        .collect();
    let screening = truthy(raw.pointer("/config/screening"));
    let (consolidated, reviewer, marks) = if screening {
        ("screening-consolidated", "screening", "screening-marks")
    } else {
        ("consolidated", "reviewer", "marks")
    };
    let marks_consolidated = format!("{marks}-consolidated");
    move |rel: &str| {
        let Some((id, file)) = rel.split_once('/') else {
            return false;
        };
        let Some(name) = file.strip_suffix(".json") else {
            return false;
        };
        let numbered = |prefix: &str| {
            name.strip_prefix(prefix)
                .and_then(|r| r.strip_prefix('-'))
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        };
        ids.contains(id)
            && (name == consolidated
                || numbered(reviewer)
                || name == marks_consolidated
                || numbered(marks))
    }
}

/// `ownAnnotationPathsIn`: changed paths (and rename sources) of this project's own files.
pub fn own_annotation_paths_in(changes: &[Change], dir: &str, raw: &Value) -> Vec<String> {
    let matches = own_matcher(raw);
    let prefix = format!("{dir}/");
    let is_own = |p: &str| p.strip_prefix(&prefix).is_some_and(&matches);
    let mut out: Vec<String> = vec![];
    for c in changes {
        for p in std::iter::once(&c.path).chain(&c.from) {
            if is_own(p) && !out.contains(p) {
                out.push(p.clone());
            }
        }
    }
    out
}

/// `annotationsRelDir(relPath, annotationsDirOf(raw))`, git-style.
pub fn annotations_rel_dir(rel_path: &str, raw: &Value) -> String {
    let name = annotations_dir_of(raw);
    let folder = if annotations_dir_ok(&name) {
        name.as_str()
    } else {
        DEFAULT_ANNOTATIONS_DIR
    };
    let parts: Vec<&str> = rel_path.split(['/', '\\']).collect();
    let dir = parts[..parts.len() - 1].join("/");
    if dir.is_empty() {
        folder.to_string()
    } else {
        format!("{dir}/{folder}")
    }
}

/// `projectAnnotationsRelDir`: as the working tree's project file names it.
fn project_rel_dir(root: &Path, rel_path: &str) -> String {
    annotations_rel_dir(rel_path, &read_meta(&root.join(rel_path)))
}

/// `mergeBlockingPaths`: tracked changes, plus untracked files in the annotations folder.
pub fn merge_blocking_paths(changes: &[Change], dir: &str) -> Vec<String> {
    let prefix = format!("{dir}/");
    let feedback = format!("{FEEDBACK_DIR}/");
    changes
        .iter()
        .filter(|c| {
            c.code != "??"
                || c.path
                    .strip_prefix(&prefix)
                    .is_some_and(|r| r != FEEDBACK_DIR && !r.starts_with(&feedback))
        })
        .map(|c| c.path.clone())
        .collect()
}

#[derive(Debug, PartialEq)]
pub struct Managed {
    text: String,
    changed: bool,
    had_existing: bool,
}

/// `applyManagedBlock` from src/git/repoSetup.ts.
pub fn apply_managed_block(existing: Option<&str>, body: &str) -> Managed {
    let block = format!("{BLOCK_BEGIN}\n{body}\n{BLOCK_END}");
    let Some(existing) = existing.filter(|e| !js_trim(e).is_empty()) else {
        return Managed {
            text: format!("{block}\n"),
            changed: true,
            had_existing: false,
        };
    };
    if let (Some(start), Some(end)) = (existing.find(BLOCK_BEGIN), existing.find(BLOCK_END)) {
        if end > start {
            let text = format!(
                "{}{block}{}",
                &existing[..start],
                &existing[end + BLOCK_END.len()..]
            );
            return Managed {
                changed: text != existing,
                text,
                had_existing: true,
            };
        }
    }
    let sep = if existing.ends_with('\n') {
        "\n"
    } else {
        "\n\n"
    };
    Managed {
        text: format!("{existing}{sep}{block}\n"),
        changed: true,
        had_existing: true,
    }
}

/// `planRepoSetup`: (attributes, ignore, upToDate, needsConsent).
fn plan_repo_setup(
    attributes: Option<&str>,
    ignore: Option<&str>,
) -> (Managed, Managed, bool, bool) {
    let a = apply_managed_block(attributes, ATTRIBUTES_BODY);
    let i = apply_managed_block(ignore, IGNORE_BODY);
    let changed = a.changed || i.changed;
    let consent = changed && ((a.changed && a.had_existing) || (i.changed && i.had_existing));
    (a, i, !changed, consent)
}

/// `setupPaths`: `.gitattributes` and `.gitignore` next to the project file.
fn setup_paths(rel_path: &str) -> (String, String) {
    let rel = rel_path.replace(std::path::MAIN_SEPARATOR, "/");
    let prefix = match rel.rsplit_once('/') {
        Some((dir, _)) if !dir.is_empty() => format!("{dir}/"),
        _ => String::new(),
    };
    (
        format!("{prefix}.gitattributes"),
        format!("{prefix}.gitignore"),
    )
}

fn read_if_present(p: &Path) -> Result<Option<String>, String> {
    match read_lossy(p) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}

// ---- Project content at a revision ----

/// A project at a git revision: the stored `project.json` text and, for a split
/// project, its own parseable annotation files (`<paperId>/<name>.json`,
/// annotations-relative). The TS side assembles it, as for `project_open`.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub text: String,
    pub files: Vec<FileText>,
}

fn show_all(root: &Path, rev: &str, paths: &[String]) -> Vec<GitRun> {
    let chunk = paths.len().div_ceil(8).max(1);
    thread::scope(|s| {
        let workers: Vec<_> = paths
            .chunks(chunk)
            .map(|c| {
                s.spawn(move || {
                    c.iter()
                        .map(|p| git(root, &["show", &format!("{rev}:{p}")]))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|w| w.join().unwrap_or_else(|e| std::panic::resume_unwind(e)))
            .collect()
    })
}

/// `readProjectAtRevision`: `None` when `rel_path` does not exist at `rev`;
/// `Err` when it exists but is not JSON.
fn read_at(root: &Path, rel_path: &str, rev: &str) -> Result<Option<Snapshot>, String> {
    let show = git(root, &["show", &format!("{rev}:{rel_path}")]);
    if !show.ok {
        return Ok(None);
    }
    let raw: Value = serde_json::from_str(&show.stdout).map_err(err)?;
    if project::is_legacy_shape(&raw) {
        return Ok(Some(Snapshot {
            text: show.stdout,
            files: vec![],
        }));
    }
    let dir = annotations_rel_dir(rel_path, &raw);
    let prefix = format!("{dir}/");
    let ls = git(
        root,
        &["ls-tree", "-r", "--name-only", "-z", rev, "--", &dir],
    );
    let own = own_matcher(&raw);
    let matched: Vec<String> = if ls.ok {
        ls.stdout
            .split('\0')
            .filter(|p| p.strip_prefix(&prefix).is_some_and(&own))
            .map(str::to_string)
            .collect()
    } else {
        vec![]
    };
    let files = matched
        .iter()
        .zip(show_all(root, rev, &matched))
        .filter(|(_, r)| r.ok && serde_json::from_str::<Value>(&r.stdout).is_ok())
        .map(|(p, r)| FileText {
            rel_path: p[prefix.len()..].to_string(),
            text: r.stdout,
        })
        .collect();
    Ok(Some(Snapshot {
        text: show.stdout,
        files,
    }))
}

/// `{ metaText, files }` from `splitProjectFiles`.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Contents {
    pub meta_text: String,
    pub files: Vec<SaveFile>,
}

fn write_contents(
    session: &Mutex<Session>,
    root: &Path,
    file: &Path,
    c: &Contents,
) -> Result<(), String> {
    assert_inside_root(root, file)?;
    project::write_project_files(session, file, Some(&c.meta_text), &c.files)
}

// ---- Shared flows ----

/// `detachedHeadRefusal`: a commit on a detached HEAD belongs to no branch.
fn detached_refusal(root: &Path) -> Option<GitRun> {
    let b = git(root, &["symbolic-ref", "--short", "-q", "HEAD"]);
    if b.ok && !b.out().is_empty() {
        return None;
    }
    Some(GitRun::failed(
        "HEAD is not on a branch (detached HEAD), so a commit made now would belong to no branch \
         and would disappear from view the next time you check one out.\n\n\
         Check out a branch first — `git checkout <branch>` — and commit again.",
    ))
}

fn status_changes(root: &Path, all_untracked: bool) -> GitRun {
    let mut args = vec!["status", "--porcelain=v1", "-z"];
    if all_untracked {
        args.push("-uall");
    }
    git(root, &args)
}

/// `ownChangedAnnotationPaths`.
fn own_changed_paths(root: &Path, rel_path: &str, meta_text: &str) -> Result<Vec<String>, String> {
    let raw: Value = serde_json::from_str(meta_text).map_err(err)?;
    let st = status_changes(root, true);
    if !st.ok {
        return Err(error_text(&st));
    }
    Ok(own_annotation_paths_in(
        &parse_porcelain(&st.stdout),
        &annotations_rel_dir(rel_path, &raw),
        &raw,
    ))
}

fn merge_blocking_dirty(root: &Path, rel_path: &str) -> Vec<String> {
    let st = status_changes(root, false);
    merge_blocking_paths(
        &parse_porcelain(&st.stdout),
        &project_rel_dir(root, rel_path),
    )
}

fn error(message: impl Into<String>) -> Value {
    json!({ "kind": "error", "message": message.into() })
}

/// `beginMergeInto`: up to the point where the reviewer has to decide.
fn begin_merge_into(root: &Path, rel_path: &str, r: &str) -> Result<Value, String> {
    if git(root, &["merge-base", "--is-ancestor", r, "HEAD"]).ok {
        return Ok(json!({ "kind": "up-to-date" }));
    }
    if git(root, &["merge-base", "--is-ancestor", "HEAD", r]).ok {
        let ff = git(root, &["merge", "--ff-only", r]);
        return Ok(if ff.ok {
            json!({ "kind": "fast-forwarded" })
        } else {
            error(error_text(&ff))
        });
    }
    let base_run = git(root, &["merge-base", "HEAD", r]);
    let base = match base_run
        .ok
        .then(|| base_run.out())
        .filter(|s| !s.is_empty())
    {
        Some(sha) => read_at(root, rel_path, sha)?,
        None => None,
    };
    let ours = read_at(root, rel_path, "HEAD")?;
    let theirs = read_at(root, rel_path, r)?;
    let (Some(ours), Some(theirs)) = (ours, theirs) else {
        return Ok(error(format!(
            "The project file does not exist at {}. Merge this by hand with git.",
            if read_at(root, rel_path, "HEAD")?.is_none() {
                "HEAD"
            } else {
                r
            }
        )));
    };
    let merge = git(root, &["merge", "--no-commit", "--no-ff", r]);
    if !git(root, &["rev-parse", "--verify", "-q", "MERGE_HEAD"]).ok {
        return Ok(error(error_text(&merge)));
    }
    let dir = project_rel_dir(root, rel_path);
    let prefix = format!("{dir}/");
    let parsed = |t: &str| serde_json::from_str(t).unwrap_or(Value::Null);
    let (mine, other) = (
        own_matcher(&parsed(&ours.text)),
        own_matcher(&parsed(&theirs.text)),
    );
    let others: Vec<String> = parse_porcelain(&status_changes(root, false).stdout)
        .into_iter()
        .filter(|c| c.unmerged)
        .map(|c| c.path)
        .filter(|p| {
            p != rel_path
                && !p
                    .strip_prefix(&prefix)
                    .is_some_and(|rest| mine(rest) || other(rest))
        })
        .collect();
    if !others.is_empty() {
        git(root, &["merge", "--abort"]);
        return Ok(json!({ "kind": "conflict-elsewhere", "paths": others }));
    }
    Ok(json!({ "kind": "merge", "ref": r, "base": base, "ours": ours, "theirs": theirs }))
}

fn is_remote_tracking_ref(root: &Path, r: &str) -> bool {
    let run = git(
        root,
        &["rev-parse", "--symbolic-full-name", "--verify", "-q", r],
    );
    run.ok && run.out().starts_with("refs/remotes/")
}

// ---- Stash operations (src/git/stashOps.ts) ----

fn list_stashes(root: &Path) -> Vec<StashEntry> {
    let r = git(
        root,
        &["stash", "list", &format!("--format={STASH_LIST_FORMAT}")],
    );
    if r.ok {
        parse_stash_list(&r.stdout)
    } else {
        vec![]
    }
}

fn resolve_stash_ref(root: &Path, sha: &str) -> Option<String> {
    list_stashes(root)
        .into_iter()
        .find(|e| e.sha == sha)
        .map(|e| e.stash_ref)
}

fn push_stash(root: &Path, rel_path: &str, raw: &Value, message: &str) -> GitRun {
    let st = status_changes(root, true);
    if !st.ok {
        return st;
    }
    let changes = parse_porcelain(&st.stdout);
    let mut paths: Vec<String> = changes
        .iter()
        .filter(|c| c.path == rel_path)
        .map(|c| c.path.clone())
        .collect();
    paths.extend(own_annotation_paths_in(
        &changes,
        &annotations_rel_dir(rel_path, raw),
        raw,
    ));
    if paths.is_empty() {
        return GitRun::failed("There are no uncommitted changes to this project to stash.");
    }
    let note = match js_trim(message) {
        "" => "stashed from SaiLoR",
        n => n,
    };
    let mut args: Vec<String> = ["stash", "push", "-u", "-m"].map(String::from).into();
    args.push(format!("{MANUAL_STASH_PREFIX}{note}"));
    args.push("--".into());
    args.extend(paths);
    git_owned(root, &args)
}

/// `restoreStash`: all or nothing onto a clean tree.
fn restore_stash(root: &Path, sha: &str, dir: &str) -> Value {
    let Some(r) = resolve_stash_ref(root, sha) else {
        return json!({ "kind": "gone" });
    };
    let st = status_changes(root, true);
    if !st.ok {
        return error(error_text(&st));
    }
    let blocking = merge_blocking_paths(&parse_porcelain(&st.stdout), dir);
    if !blocking.is_empty() {
        return json!({ "kind": "dirty", "paths": blocking });
    }
    let apply = git(root, &["stash", "apply", &r]);
    if apply.ok {
        let drop = git(root, &["stash", "drop", &r]);
        return if drop.ok {
            json!({ "kind": "restored" })
        } else {
            json!({ "kind": "restored-kept", "message": error_text(&drop) })
        };
    }
    let after = status_changes(root, false);
    let leftovers = after.ok
        && parse_porcelain(&after.stdout)
            .iter()
            .any(|c| c.code != "??");
    if !leftovers {
        return error(error_text(&apply));
    }
    git(root, &["reset", "--merge"]);
    let untracked = git(
        root,
        &["ls-tree", "-r", "--name-only", "-z", &format!("{r}^3")],
    );
    if untracked.ok {
        let paths: Vec<String> = untracked
            .stdout
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(str::to_string)
            .collect();
        if !paths.is_empty() {
            let mut args: Vec<String> = ["clean", "-f", "-q", "--"].map(String::from).into();
            args.extend(paths);
            git_owned(root, &args);
        }
    }
    json!({ "kind": "conflict" })
}

fn drop_stash(root: &Path, sha: &str) -> GitRun {
    match resolve_stash_ref(root, sha) {
        Some(r) => git(root, &["stash", "drop", &r]),
        None => GitRun::failed("That stash no longer exists."),
    }
}

fn branch_from_stash(root: &Path, sha: &str, branch: &str, dir: &str) -> GitRun {
    let Some(r) = resolve_stash_ref(root, sha) else {
        return GitRun::failed("That stash no longer exists.");
    };
    let st = status_changes(root, true);
    if !st.ok {
        return st;
    }
    let blocking = merge_blocking_paths(&parse_porcelain(&st.stdout), dir);
    if !blocking.is_empty() {
        return GitRun::failed(format!(
            "Commit or stash these first, so the switch cannot mix two sets of edits:\n{}",
            blocking.join("\n")
        ));
    }
    git(root, &["stash", "branch", branch, &r])
}

fn carry_over_ref(root: &Path) -> Option<String> {
    list_stashes(root)
        .into_iter()
        .find(|e| e.origin == "branch-switch")
        .map(|e| e.stash_ref)
}

fn pop_carry_over(root: &Path) -> GitRun {
    match carry_over_ref(root) {
        Some(r) => git(root, &["stash", "pop", &r]),
        None => GitRun::failed("The stash holding your changes could not be found."),
    }
}

fn drop_carry_over(root: &Path) -> GitRun {
    match carry_over_ref(root) {
        Some(r) => git(root, &["stash", "drop", &r]),
        None => GitRun::done(),
    }
}

// ---- Handlers (session-aware, synchronous; wrapped as commands below) ----

pub fn probe() -> Value {
    let r = run_git(&["--version"], None, TIMEOUT, &[]);
    if r.ok {
        return json!({ "available": true, "version": r.out(), "error": "" });
    }
    let e = r.stderr.trim();
    let e = if e.is_empty() {
        "git was not found on this system's PATH."
    } else {
        e
    };
    json!({ "available": false, "version": "", "error": e })
}

pub fn clone(session: &Mutex<Session>, url: &str, dest: &str) -> Value {
    if let Some(e) = validate_git_url(url).or_else(|| validate_clone_path(dest)) {
        return json!({ "ok": false, "error": e });
    }
    let r = run_git(&["clone", "--", url, dest], None, NETWORK_TIMEOUT, &[]);
    if !r.ok {
        return json!({ "ok": false, "error": error_text(&r) });
    }
    lock(session)
        .known_git_roots
        .insert(normalize(Path::new(dest)));
    json!({ "ok": true, "dest": dest })
}

pub fn info(session: &Mutex<Session>, project_path: &str) -> Option<Value> {
    let file = Path::new(project_path);
    let dir = dir_of(file);
    let run = |args: &[&str]| git(dir, args);
    let inside = run(&["rev-parse", "--is-inside-work-tree"]);
    if !inside.ok || inside.out() != "true" {
        return None;
    }
    let top = run(&["rev-parse", "--show-toplevel"]);
    let prefix = run(&["rev-parse", "--show-prefix"]);
    let head = run(&["rev-parse", "--verify", "-q", "HEAD"]);
    let branch = run(&["symbolic-ref", "--short", "-q", "HEAD"]);
    let upstream = run(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    let behind = run(&["rev-list", "--count", "HEAD..@{u}"]);

    let root = top.out().to_string();
    let base_name = file.file_name().unwrap_or_default().to_string_lossy();
    let rel_path = format!("{}{base_name}", prefix.out());
    let branch = if branch.ok {
        non_empty(branch.out())
    } else {
        None
    };
    let upstream = if upstream.ok {
        non_empty(upstream.out())
    } else {
        None
    };
    let behind = match (&upstream, behind.ok) {
        (Some(_), true) if behind.out().is_empty() => Some(0),
        (Some(_), true) => behind.out().parse::<u64>().ok(),
        _ => None,
    };
    if !root.is_empty() {
        lock(session)
            .known_git_roots
            .insert(normalize(Path::new(&root)));
    }
    let annotations_dir = annotations_rel_dir(&rel_path, &read_meta(file));
    Some(json!({
        "root": root,
        "relPath": rel_path,
        "branch": branch,
        "upstream": upstream,
        "hasHead": head.ok,
        "behind": behind,
        "annotationsDir": annotations_dir,
    }))
}

pub fn status(session: &Mutex<Session>, root: &str) -> Result<Value, String> {
    let root = assert_root(session, root)?;
    let st = status_changes(&root, false);
    let diff = if git(&root, &["rev-parse", "--verify", "-q", "HEAD"]).ok {
        git(
            &root,
            &[
                "--no-pager",
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "HEAD",
                "--",
            ],
        )
        .stdout
    } else {
        String::new()
    };
    Ok(json!({ "porcelain": st.stdout, "diff": diff }))
}

pub fn head_content(
    session: &Mutex<Session>,
    root: &str,
    rel_path: &str,
) -> Result<Option<Snapshot>, String> {
    let root = assert_root(session, root)?;
    assert_rel_path(rel_path)?;
    read_at(&root, rel_path, "HEAD")
}

pub fn working_content(
    session: &Mutex<Session>,
    root: &str,
    rel_path: &str,
) -> Result<Option<Opened>, String> {
    let root = assert_root(session, root)?;
    assert_rel_path(rel_path)?;
    Ok(project::read_project(session, &root.join(rel_path)).ok())
}

pub fn log_begin(session: &Mutex<Session>, root: &str, rel_path: &str) -> Result<Value, String> {
    let root = assert_root(session, root)?;
    assert_rel_path(rel_path)?;
    let dir = project_rel_dir(&root, rel_path);
    let max = format!("--max-count={LOG_MAX_COMMITS}");
    let r = git(
        &root,
        &[
            "log",
            &max,
            "--date=iso-strict",
            "--format=%x00%H%x09%aI%x09%s",
            "--",
            rel_path,
            &dir,
        ],
    );
    if !r.ok {
        return Ok(json!({ "commits": [], "truncated": false, "error": error_text(&r) }));
    }
    let commits = parse_git_log(&r.stdout);
    let truncated = commits.len() == LOG_MAX_COMMITS;
    Ok(json!({ "commits": commits, "truncated": truncated, "error": null }))
}

pub fn log_diff(
    session: &Mutex<Session>,
    root: &str,
    rel_path: &str,
    rev: &str,
) -> Result<Value, String> {
    let root = assert_root(session, root)?;
    assert_rel_path(rel_path)?;
    if ref_problem(rev).is_some() {
        return Ok(error("Not a valid revision."));
    }
    let (Ok(head), Ok(parent)) = (
        read_at(&root, rel_path, rev),
        read_at(&root, rel_path, &format!("{rev}^")),
    ) else {
        return Ok(error(
            "The project file could not be read at this revision.",
        ));
    };
    Ok(match (head, parent) {
        (None, _) => error("Could not read this revision."),
        (Some(_), None) => json!({ "kind": "initial" }),
        (Some(head), Some(parent)) => json!({ "kind": "texts", "head": head, "parent": parent }),
    })
}

pub fn commit(
    session: &Mutex<Session>,
    root: &str,
    paths: &[String],
    message: &str,
    amend: bool,
) -> Result<GitRun, String> {
    let root = assert_root(session, root)?;
    for p in paths {
        assert_rel_path(p)?;
    }
    if paths.is_empty() {
        return Ok(GitRun::failed("Nothing selected to commit."));
    }
    if let Some(d) = detached_refusal(&root) {
        return Ok(d);
    }
    Ok(add_and_commit(&root, paths, message, amend))
}

fn add_and_commit(root: &Path, paths: &[String], message: &str, amend: bool) -> GitRun {
    let mut add: Vec<String> = vec!["add".into(), "--".into()];
    add.extend(paths.iter().cloned());
    let added = git_owned(root, &add);
    if !added.ok {
        return added;
    }
    let mut args: Vec<String> = vec!["commit".into(), "-m".into(), message.into()];
    if amend {
        args.push("--amend".into());
    }
    args.push("--".into());
    args.extend(paths.iter().cloned());
    git_owned(root, &args)
}

pub fn last_commit_message(session: &Mutex<Session>, root: &str) -> Result<Option<String>, String> {
    let root = assert_root(session, root)?;
    let r = git(&root, &["log", "-1", "--format=%B"]);
    Ok(r.ok.then(|| r.stdout.strip_suffix('\n').unwrap_or(&r.stdout).to_string()))
}

pub fn push(session: &Mutex<Session>, root: &str) -> Result<GitRun, String> {
    let root = assert_root(session, root)?;
    Ok(run_git(&["push"], Some(&root), NETWORK_TIMEOUT, &[]))
}

pub fn pull_begin(session: &Mutex<Session>, root: &str, rel_path: &str) -> Result<Value, String> {
    let root = assert_root(session, root)?;
    assert_rel_path(rel_path)?;
    let dirty = merge_blocking_dirty(&root, rel_path);
    if !dirty.is_empty() {
        return Ok(json!({ "kind": "dirty", "paths": dirty }));
    }
    let up = git(
        &root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    );
    if !up.ok {
        let b = git(&root, &["symbolic-ref", "--short", "-q", "HEAD"]);
        let branch = if b.ok { non_empty(b.out()) } else { None };
        return Ok(json!({ "kind": "no-upstream", "branch": branch }));
    }
    let fetch = run_git(&["fetch"], Some(&root), NETWORK_TIMEOUT, &[]);
    if !fetch.ok {
        return Ok(error(error_text(&fetch)));
    }
    begin_merge_into(&root, rel_path, up.out())
}

pub fn merge_begin(
    session: &Mutex<Session>,
    root: &str,
    rel_path: &str,
    r: &str,
) -> Result<Value, String> {
    let root = assert_root(session, root)?;
    assert_rel_path(rel_path)?;
    assert_ref(r)?;
    let dirty = merge_blocking_dirty(&root, rel_path);
    if !dirty.is_empty() {
        return Ok(json!({ "kind": "dirty", "paths": dirty }));
    }
    if r.starts_with("refs/remotes/") || is_remote_tracking_ref(&root, r) {
        let fetch = run_git(&["fetch"], Some(&root), NETWORK_TIMEOUT, &[]);
        if !fetch.ok {
            return Ok(error(error_text(&fetch)));
        }
    }
    let commit = format!("{r}^{{commit}}");
    if !git(&root, &["rev-parse", "--verify", "-q", &commit]).ok {
        return Ok(error(format!("There is no branch named {r}.")));
    }
    begin_merge_into(&root, rel_path, r)
}

/// Runs `f`, turning an `Err` into a failed run the renderer can show.
fn as_run(f: impl FnOnce() -> Result<GitRun, String>) -> GitRun {
    f().unwrap_or_else(GitRun::failed)
}

pub fn pull_finish(
    session: &Mutex<Session>,
    root: &str,
    rel_path: &str,
    working: &Contents,
) -> Result<GitRun, String> {
    let root = assert_root(session, root)?;
    Ok(as_run(|| {
        assert_rel_path(rel_path)?;
        write_contents(session, &root, &root.join(rel_path), working)?;
        let mut paths = vec![rel_path.to_string()];
        paths.extend(own_changed_paths(&root, rel_path, &working.meta_text)?);
        let mut add: Vec<String> = vec!["add".into(), "--".into()];
        add.extend(paths);
        let added = git_owned(&root, &add);
        if !added.ok {
            return Ok(added);
        }
        Ok(git(&root, &["commit", "--no-edit"]))
    }))
}

pub fn pull_abort(session: &Mutex<Session>, root: &str) -> Result<GitRun, String> {
    let root = assert_root(session, root)?;
    Ok(git(&root, &["merge", "--abort"]))
}

pub fn annotation_authors(
    session: &Mutex<Session>,
    root: &str,
    rel_path: &str,
) -> Result<Value, String> {
    let root = assert_root(session, root)?;
    assert_rel_path(rel_path)?;
    let dir = project_rel_dir(&root, rel_path);
    let name = git(&root, &["config", "--get", "user.name"]);
    let email = git(&root, &["config", "--get", "user.email"]);
    let log = git(
        &root,
        &[
            "log",
            "--no-merges",
            "--format=%x00%an%x09%ae",
            "--name-only",
            "--",
            &dir,
        ],
    );
    let name = if name.ok { name.out() } else { "" };
    let email = if email.ok { email.out() } else { "" };
    let me =
        (!name.is_empty() || !email.is_empty()).then(|| json!({ "name": name, "email": email }));
    let files = if log.ok {
        parse_annotation_authors(&log.stdout, &dir)
    } else {
        Map::new()
    };
    Ok(json!({ "me": me, "files": files }))
}

pub fn repo_setup_status(
    session: &Mutex<Session>,
    root: &str,
    rel_path: &str,
) -> Result<Value, String> {
    let root = assert_root(session, root)?;
    assert_rel_path(rel_path)?;
    let (attributes, ignore) = setup_paths(rel_path);
    let (_, _, up_to_date, needs_consent) = plan_repo_setup(
        read_if_present(&root.join(&attributes))?.as_deref(),
        read_if_present(&root.join(&ignore))?.as_deref(),
    );
    Ok(json!({
        "upToDate": up_to_date,
        "needsConsent": needs_consent,
        "paths": [attributes, ignore],
    }))
}

pub fn apply_repo_setup(
    session: &Mutex<Session>,
    root: &str,
    rel_path: &str,
) -> Result<GitRun, String> {
    let root = assert_root(session, root)?;
    assert_rel_path(rel_path)?;
    if let Some(d) = detached_refusal(&root) {
        return Ok(d);
    }
    let (attributes, ignore) = setup_paths(rel_path);
    let (abs_a, abs_i) = (root.join(&attributes), root.join(&ignore));
    let (a, i, up_to_date, _) = plan_repo_setup(
        read_if_present(&abs_a)?.as_deref(),
        read_if_present(&abs_i)?.as_deref(),
    );
    if up_to_date {
        return Ok(GitRun::done());
    }
    let mut written = vec![];
    for (plan, abs, rel) in [(a, abs_a, attributes), (i, abs_i, ignore)] {
        if plan.changed {
            assert_inside_root(&root, &abs)?;
            assert_not_symlink(&abs)?;
            fs::write(&abs, plan.text).map_err(err)?;
            written.push(rel);
        }
    }
    let mut add: Vec<String> = vec!["add".into(), "--".into()];
    add.extend(written.iter().cloned());
    let added = git_owned(&root, &add);
    if !added.ok {
        return Ok(added);
    }
    let mut args: Vec<String> = [
        "commit",
        "--author",
        SETUP_AUTHOR,
        "-m",
        SETUP_COMMIT_MESSAGE,
        "--",
    ]
    .map(String::from)
    .into();
    args.extend(written);
    Ok(git_owned(&root, &args))
}

pub fn background_fetch(session: &Mutex<Session>, root: &str) -> Result<Value, String> {
    let root = assert_root(session, root)?;
    let risky = git(
        &root,
        &[
            "config",
            "--local",
            "--name-only",
            "--get-regexp",
            FETCH_COMMAND_KEYS,
        ],
    );
    if risky.ok && !risky.out().is_empty() {
        return Ok(json!({ "fetched": false, "refused": true }));
    }
    let r = run_git(
        &["fetch", "--quiet"],
        Some(&root),
        BACKGROUND_FETCH_TIMEOUT,
        &NON_INTERACTIVE_ENV,
    );
    Ok(json!({ "fetched": r.ok, "refused": false }))
}

pub fn branches(session: &Mutex<Session>, root: &str) -> Result<Vec<Value>, String> {
    let root = assert_root(session, root)?;
    let r = git(
        &root,
        &[
            "for-each-ref",
            "--format=%(refname)%09%(refname:short)%09%(HEAD)",
            "refs/heads",
            "refs/remotes",
        ],
    );
    if !r.ok {
        return Ok(vec![]);
    }
    Ok(r.stdout
        .split('\n')
        .filter(|l| !l.is_empty())
        .map(|l| {
            let mut f = l.split('\t');
            (
                f.next().unwrap_or(""),
                f.next().unwrap_or(""),
                f.next().unwrap_or(""),
            )
        })
        .filter(|(refname, _, _)| !refname.ends_with("/HEAD"))
        .map(|(refname, name, head)| {
            json!({
                "name": name,
                "current": head == "*",
                "remote": refname.starts_with("refs/remotes/"),
            })
        })
        .collect())
}

pub fn branch_create(session: &Mutex<Session>, root: &str, name: &str) -> Result<GitRun, String> {
    let root = assert_root(session, root)?;
    Ok(git(&root, &["branch", "--", name]))
}

pub fn branch_delete(session: &Mutex<Session>, root: &str, branch: &str) -> Result<GitRun, String> {
    let root = assert_root(session, root)?;
    Ok(git(&root, &["branch", "-d", "--", branch]))
}

pub fn checkout(session: &Mutex<Session>, root: &str, branch: &str) -> Result<GitRun, String> {
    let root = assert_root(session, root)?;
    assert_ref(branch)?;
    Ok(git(&root, &["checkout", branch, "--"]))
}

pub fn branch_switch_begin(
    session: &Mutex<Session>,
    root: &str,
    rel_path: &str,
    branch: &str,
) -> Result<Value, String> {
    let root = assert_root(session, root)?;
    assert_rel_path(rel_path)?;
    assert_ref(branch)?;
    let dir = project_rel_dir(&root, rel_path);
    let ours = project::read_project(session, &root.join(rel_path));
    let raw = ours
        .as_ref()
        .ok()
        .and_then(|o| serde_json::from_str(&o.text).ok())
        .unwrap_or(Value::Null);
    let matches = own_matcher(&raw);
    let prefix = format!("{dir}/");
    let in_scope = |p: &str| p == rel_path || p.strip_prefix(&prefix).is_some_and(&matches);

    let feedback_prefix = format!("{dir}/{FEEDBACK_DIR}/");
    let changes: Vec<Change> = parse_porcelain(&status_changes(&root, true).stdout)
        .into_iter()
        .filter(|c| !c.path.starts_with(&feedback_prefix))
        .collect();
    let others: Vec<&str> = changes
        .iter()
        .map(|c| c.path.as_str())
        .filter(|p| !in_scope(p))
        .collect();
    if !others.is_empty() {
        return Ok(json!({ "kind": "other-files-dirty", "paths": others }));
    }
    if !changes.iter().any(|c| in_scope(&c.path)) {
        return Ok(json!({ "kind": "no-changes" }));
    }

    let source = git(&root, &["symbolic-ref", "--short", "-q", "HEAD"]);
    let source_branch = if source.ok { source.out() } else { "" };
    if source_branch.is_empty() {
        return Ok(error("Cannot switch branches from a detached HEAD."));
    }
    let old_head = git(&root, &["rev-parse", "HEAD"]);
    let base = read_at(&root, rel_path, old_head.out())?;
    let ours = match ours {
        Ok(o) => o,
        Err(e) => {
            return Ok(error(format!(
                "Could not read the project's current state: {e}"
            )))
        }
    };
    let Some(theirs) = read_at(&root, rel_path, branch)? else {
        return Ok(error(format!(
            "The project file does not exist on branch \"{branch}\"."
        )));
    };

    let exclude = format!(":(exclude){feedback_prefix}");
    let stash = git(
        &root,
        &[
            "stash",
            "push",
            "-u",
            "-m",
            BRANCH_SWITCH_STASH_MESSAGE,
            "--",
            rel_path,
            &dir,
            &exclude,
        ],
    );
    if !stash.ok {
        return Ok(error(error_text(&stash)));
    }
    let co = git(&root, &["checkout", branch, "--"]);
    if !co.ok {
        let restored = pop_carry_over(&root).ok;
        return Ok(error(if restored {
            error_text(&co)
        } else {
            format!("{}\n\n{CARRY_OVER_STRANDED}", error_text(&co))
        }));
    }
    Ok(json!({
        "kind": "merge",
        "sourceBranch": source_branch,
        "base": base,
        "ours": ours,
        "theirs": theirs,
    }))
}

pub fn branch_switch_finish(
    session: &Mutex<Session>,
    root: &str,
    rel_path: &str,
    resolved: &Contents,
) -> Result<GitRun, String> {
    let root = assert_root(session, root)?;
    Ok(as_run(|| {
        assert_rel_path(rel_path)?;
        write_contents(session, &root, &root.join(rel_path), resolved)?;
        Ok(drop_carry_over(&root))
    }))
}

pub fn branch_switch_abort(
    session: &Mutex<Session>,
    root: &str,
    source_branch: &str,
) -> Result<GitRun, String> {
    let root = assert_root(session, root)?;
    assert_ref(source_branch)?;
    let co = git(&root, &["checkout", source_branch, "--"]);
    if !co.ok {
        return Ok(co);
    }
    let pop = pop_carry_over(&root);
    if pop.ok {
        return Ok(pop);
    }
    Ok(GitRun {
        stderr: format!("{}\n\n{CARRY_OVER_STRANDED}", error_text(&pop)),
        ..pop
    })
}

pub fn stash_list(session: &Mutex<Session>, root: &str) -> Result<Vec<StashEntry>, String> {
    Ok(list_stashes(&assert_root(session, root)?))
}

pub fn stash_push(
    session: &Mutex<Session>,
    root: &str,
    rel_path: &str,
    message: &str,
) -> Result<GitRun, String> {
    let root = assert_root(session, root)?;
    assert_rel_path(rel_path)?;
    let raw = read_lossy(&root.join(rel_path))
        .map_err(err)
        .and_then(|t| serde_json::from_str::<Value>(&t).map_err(err));
    Ok(match raw {
        Ok(raw) => push_stash(&root, rel_path, &raw, message),
        Err(e) => GitRun::failed(format!("The project file could not be read: {e}")),
    })
}

pub fn stash_restore(
    session: &Mutex<Session>,
    root: &str,
    rel_path: &str,
    sha: &str,
) -> Result<Value, String> {
    let root = assert_root(session, root)?;
    assert_rel_path(rel_path)?;
    assert_sha(sha)?;
    Ok(restore_stash(&root, sha, &project_rel_dir(&root, rel_path)))
}

pub fn stash_drop(session: &Mutex<Session>, root: &str, sha: &str) -> Result<GitRun, String> {
    let root = assert_root(session, root)?;
    assert_sha(sha)?;
    Ok(drop_stash(&root, sha))
}

pub fn stash_branch(
    session: &Mutex<Session>,
    root: &str,
    rel_path: &str,
    sha: &str,
    branch: &str,
) -> Result<GitRun, String> {
    let root = assert_root(session, root)?;
    assert_rel_path(rel_path)?;
    assert_sha(sha)?;
    assert_ref(branch)?;
    Ok(branch_from_stash(
        &root,
        sha,
        branch,
        &project_rel_dir(&root, rel_path),
    ))
}

/// `git:commitPartial`: write `committed`, stage and commit it, then always
/// write `working` back.
#[allow(clippy::too_many_arguments)]
pub fn commit_partial(
    session: &Mutex<Session>,
    root: &str,
    rel_path: &str,
    committed: &Contents,
    working: &Contents,
    other_paths: &[String],
    message: &str,
    amend: bool,
) -> Result<GitRun, String> {
    let root = assert_root(session, root)?;
    assert_rel_path(rel_path)?;
    for p in other_paths {
        assert_rel_path(p)?;
    }
    if let Some(d) = detached_refusal(&root) {
        return Ok(d);
    }
    let full = root.join(rel_path);
    let attempt = (|| -> Result<GitRun, String> {
        write_contents(session, &root, &full, committed)?;
        let mut paths = vec![rel_path.to_string()];
        paths.extend(own_changed_paths(&root, rel_path, &committed.meta_text)?);
        paths.extend(other_paths.iter().cloned());
        Ok(add_and_commit(&root, &paths, message, amend))
    })();
    let restored = write_contents(session, &root, &full, working);
    Ok(match restored {
        Err(e) => GitRun::failed(e),
        Ok(()) => attempt.unwrap_or_else(GitRun::failed),
    })
}

pub fn write_working(
    session: &Mutex<Session>,
    root: &str,
    rel_path: &str,
    working: &Contents,
) -> Result<GitRun, String> {
    let root = assert_root(session, root)?;
    assert_rel_path(rel_path)?;
    Ok(as_run(|| {
        write_contents(session, &root, &root.join(rel_path), working)?;
        Ok(GitRun::done())
    }))
}

pub fn discard_file(
    session: &Mutex<Session>,
    root: &str,
    rel_path: &str,
    project_rel_path: &str,
) -> Result<GitRun, String> {
    let root = assert_root(session, root)?;
    Ok(as_run(|| {
        assert_rel_path(rel_path)?;
        assert_rel_path(project_rel_path)?;
        let own_dir = project_rel_dir(&root, project_rel_path);
        if rel_path == project_rel_path
            || rel_path == own_dir
            || rel_path.starts_with(&format!("{own_dir}/"))
        {
            return Ok(GitRun::failed(
                "Discarding the project's own file here is not supported — use the field review above.",
            ));
        }
        let st = git(&root, &["status", "--porcelain=v1", "-z", "--", rel_path]);
        let Some(change) = parse_porcelain(&st.stdout).into_iter().next() else {
            return Ok(GitRun::done());
        };
        if change.unmerged || change.from.is_some() {
            return Ok(GitRun::failed(
                "Discarding a merge conflict or a rename is not supported here — use git directly.",
            ));
        }
        if !change.code.starts_with('?') {
            return Ok(git(&root, &["checkout", "--", rel_path]));
        }
        let full = root.join(rel_path.trim_end_matches('/'));
        assert_inside_root(&root, &full)?;
        if rel_path.ends_with('/') {
            match fs::remove_dir_all(&full) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(err(e)),
                _ => {}
            }
        } else {
            fs::remove_file(&full).map_err(err)?;
        }
        Ok(GitRun::done())
    }))
}

// ---- Tauri commands ----

/// Runs a handler off the async workers: git may take minutes (clone, push).
async fn blocking<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&Mutex<Session>) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<Mutex<Session>>()))
        .await
        .map_err(err)?
}

#[tauri::command]
pub async fn git_probe(app: AppHandle) -> Result<Value, String> {
    blocking(app, |_| Ok(probe())).await
}

#[tauri::command]
pub async fn git_pick_clone_dir(app: AppHandle) -> Result<Option<String>, String> {
    app.dialog()
        .file()
        .set_title("Choose where to clone the repository")
        .set_can_create_directories(true)
        .blocking_pick_folder()
        .map(|p| p.into_path().map(|p| p.display().to_string()).map_err(err))
        .transpose()
}

#[tauri::command]
pub async fn git_clone(app: AppHandle, url: String, dest: String) -> Result<Value, String> {
    blocking(app, move |s| Ok(clone(s, &url, &dest))).await
}

#[tauri::command]
pub async fn git_pick_project_in(app: AppHandle, dir: String) -> Result<Option<String>, String> {
    app.dialog()
        .file()
        .set_title("Open SLR project")
        .set_directory(&dir)
        .add_filter("SLR project", &["json"])
        .blocking_pick_file()
        .map(|p| p.into_path().map(|p| p.display().to_string()).map_err(err))
        .transpose()
}

#[tauri::command]
pub async fn git_info(app: AppHandle, project_path: String) -> Result<Option<Value>, String> {
    blocking(app, move |s| Ok(info(s, &project_path))).await
}

#[tauri::command]
pub async fn git_status(app: AppHandle, root: String) -> Result<Value, String> {
    blocking(app, move |s| status(s, &root)).await
}

#[tauri::command]
pub async fn git_commit(
    app: AppHandle,
    root: String,
    paths: Vec<String>,
    message: String,
    amend: bool,
) -> Result<GitRun, String> {
    blocking(app, move |s| commit(s, &root, &paths, &message, amend)).await
}

#[tauri::command]
pub async fn git_last_commit_message(
    app: AppHandle,
    root: String,
) -> Result<Option<String>, String> {
    blocking(app, move |s| last_commit_message(s, &root)).await
}

#[tauri::command]
pub async fn git_push(app: AppHandle, root: String) -> Result<GitRun, String> {
    blocking(app, move |s| push(s, &root)).await
}

#[tauri::command]
pub async fn git_pull_begin(
    app: AppHandle,
    root: String,
    rel_path: String,
) -> Result<Value, String> {
    blocking(app, move |s| pull_begin(s, &root, &rel_path)).await
}

#[tauri::command]
pub async fn git_pull_finish(
    app: AppHandle,
    root: String,
    rel_path: String,
    working: Contents,
) -> Result<GitRun, String> {
    blocking(app, move |s| pull_finish(s, &root, &rel_path, &working)).await
}

#[tauri::command]
pub async fn git_pull_abort(app: AppHandle, root: String) -> Result<GitRun, String> {
    blocking(app, move |s| pull_abort(s, &root)).await
}

#[tauri::command]
pub async fn git_merge_begin(
    app: AppHandle,
    root: String,
    rel_path: String,
    r#ref: String,
) -> Result<Value, String> {
    blocking(app, move |s| merge_begin(s, &root, &rel_path, &r#ref)).await
}

#[tauri::command]
pub async fn git_log_begin(
    app: AppHandle,
    root: String,
    rel_path: String,
) -> Result<Value, String> {
    blocking(app, move |s| log_begin(s, &root, &rel_path)).await
}

#[tauri::command]
pub async fn git_log_diff(
    app: AppHandle,
    root: String,
    rel_path: String,
    rev: String,
) -> Result<Value, String> {
    blocking(app, move |s| log_diff(s, &root, &rel_path, &rev)).await
}

#[tauri::command]
pub async fn git_annotation_authors(
    app: AppHandle,
    root: String,
    rel_path: String,
) -> Result<Value, String> {
    blocking(app, move |s| annotation_authors(s, &root, &rel_path)).await
}

#[tauri::command]
pub async fn git_repo_setup_status(
    app: AppHandle,
    root: String,
    rel_path: String,
) -> Result<Value, String> {
    blocking(app, move |s| repo_setup_status(s, &root, &rel_path)).await
}

#[tauri::command]
pub async fn git_apply_repo_setup(
    app: AppHandle,
    root: String,
    rel_path: String,
) -> Result<GitRun, String> {
    blocking(app, move |s| apply_repo_setup(s, &root, &rel_path)).await
}

#[tauri::command]
pub async fn git_background_fetch(app: AppHandle, root: String) -> Result<Value, String> {
    blocking(app, move |s| background_fetch(s, &root)).await
}

#[tauri::command]
pub async fn git_stash_list(app: AppHandle, root: String) -> Result<Vec<StashEntry>, String> {
    blocking(app, move |s| stash_list(s, &root)).await
}

#[tauri::command]
pub async fn git_stash_push(
    app: AppHandle,
    root: String,
    rel_path: String,
    message: Option<String>,
) -> Result<GitRun, String> {
    blocking(app, move |s| {
        stash_push(s, &root, &rel_path, message.as_deref().unwrap_or(""))
    })
    .await
}

#[tauri::command]
pub async fn git_stash_restore(
    app: AppHandle,
    root: String,
    rel_path: String,
    sha: String,
) -> Result<Value, String> {
    blocking(app, move |s| stash_restore(s, &root, &rel_path, &sha)).await
}

#[tauri::command]
pub async fn git_stash_drop(app: AppHandle, root: String, sha: String) -> Result<GitRun, String> {
    blocking(app, move |s| stash_drop(s, &root, &sha)).await
}

#[tauri::command]
pub async fn git_stash_branch(
    app: AppHandle,
    root: String,
    rel_path: String,
    sha: String,
    branch: String,
) -> Result<GitRun, String> {
    blocking(app, move |s| {
        stash_branch(s, &root, &rel_path, &sha, &branch)
    })
    .await
}

#[tauri::command]
pub async fn git_branches(app: AppHandle, root: String) -> Result<Vec<Value>, String> {
    blocking(app, move |s| branches(s, &root)).await
}

#[tauri::command]
pub async fn git_branch_create(
    app: AppHandle,
    root: String,
    name: String,
) -> Result<GitRun, String> {
    blocking(app, move |s| branch_create(s, &root, &name)).await
}

#[tauri::command]
pub async fn git_branch_delete(
    app: AppHandle,
    root: String,
    branch: String,
) -> Result<GitRun, String> {
    blocking(app, move |s| branch_delete(s, &root, &branch)).await
}

#[tauri::command]
pub async fn git_checkout(app: AppHandle, root: String, branch: String) -> Result<GitRun, String> {
    blocking(app, move |s| checkout(s, &root, &branch)).await
}

#[tauri::command]
pub async fn git_branch_switch_begin(
    app: AppHandle,
    root: String,
    rel_path: String,
    branch: String,
) -> Result<Value, String> {
    blocking(app, move |s| {
        branch_switch_begin(s, &root, &rel_path, &branch)
    })
    .await
}

#[tauri::command]
pub async fn git_branch_switch_finish(
    app: AppHandle,
    root: String,
    rel_path: String,
    resolved: Contents,
) -> Result<GitRun, String> {
    blocking(app, move |s| {
        branch_switch_finish(s, &root, &rel_path, &resolved)
    })
    .await
}

#[tauri::command]
pub async fn git_branch_switch_abort(
    app: AppHandle,
    root: String,
    source_branch: String,
) -> Result<GitRun, String> {
    blocking(app, move |s| branch_switch_abort(s, &root, &source_branch)).await
}

#[tauri::command]
pub async fn git_head_content(
    app: AppHandle,
    root: String,
    rel_path: String,
) -> Result<Option<Snapshot>, String> {
    blocking(app, move |s| head_content(s, &root, &rel_path)).await
}

#[tauri::command]
pub async fn git_working_content(
    app: AppHandle,
    root: String,
    rel_path: String,
) -> Result<Option<Opened>, String> {
    blocking(app, move |s| working_content(s, &root, &rel_path)).await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn git_commit_partial(
    app: AppHandle,
    root: String,
    rel_path: String,
    committed: Contents,
    working: Contents,
    other_paths: Vec<String>,
    message: String,
    amend: bool,
) -> Result<GitRun, String> {
    blocking(app, move |s| {
        commit_partial(
            s,
            &root,
            &rel_path,
            &committed,
            &working,
            &other_paths,
            &message,
            amend,
        )
    })
    .await
}

#[tauri::command]
pub async fn git_write_working(
    app: AppHandle,
    root: String,
    rel_path: String,
    working: Contents,
) -> Result<GitRun, String> {
    blocking(app, move |s| write_working(s, &root, &rel_path, &working)).await
}

#[tauri::command]
pub async fn git_discard_file(
    app: AppHandle,
    root: String,
    rel_path: String,
    project_rel_path: String,
) -> Result<GitRun, String> {
    blocking(app, move |s| {
        discard_file(s, &root, &rel_path, &project_rel_path)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::tests::tmp;

    // ---- Vectors shared with src/git/*.test.ts ----

    #[test]
    fn rel_path_vectors() {
        for p in [
            "project.json",
            "papers/a.json",
            "a/b/c/d.json",
            "my.git/x",
            "..git/x",
            "git/x",
        ] {
            assert_eq!(rel_path_problem(p), None, "{p}");
        }
        let cases = [
            ("../x", "traversal"),
            ("a/../../x", "traversal"),
            ("..\\..\\Users\\victim\\.bashrc", "traversal"),
            ("/etc/passwd", "absolute"),
            ("C:\\Windows\\x", "absolute"),
            ("c:/Windows/x", "absolute"),
            ("\\\\server\\share\\x", "absolute"),
            ("a\0b", "control-char"),
            ("a\nb", "control-char"),
            ("a\rb", "control-char"),
            (".git/config", "dot-git"),
            (".git/hooks/pre-commit", "dot-git"),
            ("a/.git/config", "dot-git"),
            (".GIT/hooks/pre-commit", "dot-git"),
            (".Git/config", "dot-git"),
            (".git./config", "dot-git"),
            (".git /config", "dot-git"),
            (" .git/config", "dot-git"),
            (".GIT. ./config", "dot-git"),
            ("", "empty"),
        ];
        for (p, want) in cases {
            assert_eq!(rel_path_problem(p), Some(want), "{p:?}");
        }
    }

    #[test]
    fn ref_vectors() {
        for r in [
            "main",
            "feature/x",
            "origin/main",
            "origin/feature/nested/x",
            "v1.6.2",
            "a_b-c",
        ] {
            assert_eq!(ref_problem(r), None, "{r}");
        }
        let mut cases = vec![
            ("", "empty"),
            ("--upload-pack=touch /tmp/pwn", "option-like"),
            ("-x", "option-like"),
            ("ma\nin", "control-char"),
            ("ma\tin", "control-char"),
            ("main\x7f", "control-char"),
            ("origin/.hidden/x", "bad-syntax"),
            ("origin/x.lock/y", "bad-syntax"),
            (".git", "bad-syntax"),
        ];
        for r in [
            "main^",
            "main~1",
            "main..other",
            "main:path/to/file",
            "main@{1}",
            "a b",
            "a?b",
            "a*b",
            "a[b",
            "a\\b",
            "/main",
            "main/",
            "a//b",
            "main.",
            "main.lock",
        ] {
            cases.push((r, "bad-syntax"));
        }
        for (r, want) in cases {
            assert_eq!(ref_problem(r), Some(want), "{r:?}");
        }
    }

    #[test]
    fn url_vectors() {
        for u in [
            "https://github.com/Gram21/SaiLoR.git",
            "http://example.com/repo.git",
            "ssh://git@host:2222/a/b.git",
            "git://example.com/repo.git",
            "file:///abs/repo",
            "git@github.com:Gram21/SaiLoR.git",
            "/abs/local/repo",
            "C:\\repos\\x",
            "  https://github.com/Gram21/SaiLoR.git  ",
            "ssh://git@host/a/b.git",
        ] {
            assert_eq!(validate_git_url(u), None, "{u}");
        }
        let cases = [
            ("", "Enter the repository URL."),
            ("   ", "Enter the repository URL."),
            ("-x", "would read it as an option"),
            ("--upload-pack=/bin/sh", "would read it as an option"),
            ("ext::sh -c whoami", "emote-helper"),
            ("EXT::sh -c whoami", "emote-helper"),
            ("transport::addr", "emote-helper"),
            ("https://host/a\nb", "line break"),
            ("https://host/a\0b", "null byte"),
            ("notaurl", "Use an https"),
            ("git@host:/abs", "Use an https"),
        ];
        for (u, want) in cases {
            let got = validate_git_url(u).unwrap_or("");
            assert!(got.contains(want), "{u:?}: {got}");
        }
        assert_eq!(validate_clone_path("/Users/me/repos/x"), None);
        assert_eq!(validate_clone_path("C:\\Users\\me\\repos\\x"), None);
        for (d, want) in [
            ("repos/x", "absolute"),
            ("", "Choose where"),
            ("-x", "would read it as an option"),
            ("/tmp/a\nb", "line break"),
        ] {
            assert!(validate_clone_path(d).unwrap_or("").contains(want), "{d:?}");
        }
    }

    fn change(path: &str, code: &str) -> Change {
        Change {
            path: path.into(),
            code: code.into(),
            unmerged: false,
            from: None,
        }
    }

    #[test]
    fn porcelain_and_log_parsers() {
        assert_eq!(
            parse_porcelain(" M review.json\0"),
            [change("review.json", " M")]
        );
        assert_eq!(
            parse_porcelain("?? pdfs/new.pdf\0"),
            [change("pdfs/new.pdf", "??")]
        );
        let renamed = parse_porcelain("R  new.json\0old.json\0?? extra.pdf\0");
        assert_eq!(renamed.len(), 2);
        assert_eq!(renamed[0].from.as_deref(), Some("old.json"));
        assert_eq!(renamed[1].path, "extra.pdf");
        assert!(parse_porcelain("UU a.json\0")[0].unmerged);
        assert!(parse_porcelain("AA a.json\0")[0].unmerged);
        assert!(!parse_porcelain(" M a.json\0")[0].unmerged);
        assert!(parse_porcelain("").is_empty());
        assert!(parse_porcelain(" M\0").is_empty());
        assert_eq!(
            parse_porcelain(" M my review.json\0")[0].path,
            "my review.json"
        );

        let log = parse_git_log("\0abc\t2026-01-01T00:00:00Z\tFix: a\tb\n\0bad\0");
        assert_eq!(
            log,
            [CommitRecord {
                hash: "abc".into(),
                date: "2026-01-01T00:00:00Z".into(),
                subject: "Fix: a\tb\n".into()
            }]
        );

        let err_of = |stderr: &str, stdout: &str, code| {
            error_text(&GitRun {
                ok: false,
                code,
                stdout: stdout.into(),
                stderr: stderr.into(),
            })
        };
        assert_eq!(err_of("fatal: x", "noise", Some(1)), "fatal: x\nnoise");
        assert_eq!(
            err_of(" ", "nothing to commit", Some(1)),
            "nothing to commit"
        );
        assert_eq!(err_of("", "", None), "git could not be started.");
        assert_eq!(err_of("", "", Some(2)), "git exited with code 2.");
    }

    #[test]
    fn stash_list_parser() {
        let rec = |r: &str, sha: &str, d: &str, s: &str| format!("{r}\t{sha}\t{d}\t{s}\0\n");
        let list = parse_stash_list(&format!(
            "{}{}{}garbage\0",
            rec(
                "stash@{0}",
                "abc",
                "d0",
                "On main: sailor stash: note: see\tabove"
            ),
            rec("stash@{1}", "def", "d1", "WIP on feature: 1a2b3c4 Fix typo"),
            rec(
                "stash@{2}",
                "aaa",
                "d2",
                &format!("On main: {BRANCH_SWITCH_STASH_MESSAGE}")
            ),
        ));
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[0].message, "sailor stash: note: see\tabove");
        assert_eq!(list[0].origin, "sailor");
        assert_eq!(list[1].branch.as_deref(), Some("feature"));
        assert_eq!(list[1].message, "1a2b3c4 Fix typo");
        assert_eq!(list[1].origin, "other");
        assert_eq!(list[2].origin, "branch-switch");
        assert_eq!(list[2].stash_ref, "stash@{2}");
        assert!(parse_stash_list("").is_empty());
        let odd = parse_stash_list("stash@{0}\tx\td\tsomething else\0");
        assert_eq!(
            (odd[0].branch.as_ref(), odd[0].message.as_str()),
            (None, "something else")
        );
    }

    #[test]
    fn annotation_authors_parser() {
        let out = "\0Ann\tann@x\n\nannotations/p1/reviewer-1.json\nother/x.json\n\0Bob\tbob@x\n\nannotations/p1/reviewer-1.json\nannotations/p2/reviewer-1.json\n";
        let files = parse_annotation_authors(out, "annotations");
        assert_eq!(
            files["p1/reviewer-1.json"],
            json!({"name":"Ann","email":"ann@x"})
        );
        assert_eq!(
            files["p2/reviewer-1.json"],
            json!({"name":"Bob","email":"bob@x"})
        );
        assert_eq!(files.len(), 2);
    }

    fn project(papers: &[&str], screening: bool) -> Value {
        let ps: Vec<Value> = papers.iter().map(|id| json!({ "id": id })).collect();
        let cfg = if screening {
            json!({"reasons":["x"]})
        } else {
            Value::Null
        };
        json!({ "config": { "screening": cfg }, "papers": ps })
    }

    #[test]
    fn own_annotation_path_vectors() {
        let m = own_matcher(&project(&["p1"], false));
        for p in [
            "p1/consolidated.json",
            "p1/reviewer-1.json",
            "p1/reviewer-2.json",
            "p1/marks-consolidated.json",
            "p1/marks-1.json",
        ] {
            assert!(m(p), "{p}");
        }
        for p in [
            "p2/consolidated.json",
            "p2/reviewer-1.json",
            "p1/notes.txt",
            "p1/reviewer-x.json",
            "p1.json",
            "consolidated.json",
            "p1/screening-1.json",
            "p1/screening-marks-1.json",
            "p1/reviewer-.json",
        ] {
            assert!(!m(p), "{p}");
        }
        let s = own_matcher(&project(&["p1"], true));
        for p in [
            "p1/screening-consolidated.json",
            "p1/screening-1.json",
            "p1/screening-marks-1.json",
        ] {
            assert!(s(p), "{p}");
        }
        for p in [
            "p1/consolidated.json",
            "p1/reviewer-1.json",
            "p1/marks-1.json",
        ] {
            assert!(!s(p), "{p}");
        }
        for raw in [
            Value::Null,
            json!({}),
            json!({"papers":"not-an-array"}),
            json!({"papers":[{"id":42}]}),
        ] {
            assert!(!own_matcher(&raw)("p1/consolidated.json"));
        }

        let changes: Vec<Change> = [
            "annotations/p1/consolidated.json",
            "annotations/p1/reviewer-2.json",
            "annotations/q9/consolidated.json",
            "annotations/p1/notes.txt",
            "papers/p1.pdf",
        ]
        .map(|p| change(p, " M"))
        .into();
        assert_eq!(
            own_annotation_paths_in(&changes, "annotations", &project(&["p1"], false)),
            [
                "annotations/p1/consolidated.json",
                "annotations/p1/reviewer-2.json"
            ]
        );
        let renamed = [Change {
            from: Some("annotations/p1/reviewer-1.json".into()),
            ..change("annotations/p1/reviewer-2.json", "R ")
        }];
        assert_eq!(
            own_annotation_paths_in(&renamed, "annotations", &project(&["p1"], false)),
            [
                "annotations/p1/reviewer-2.json",
                "annotations/p1/reviewer-1.json"
            ]
        );
        assert!(own_annotation_paths_in(
            &[change("annotations/p2/", "??")],
            "annotations",
            &project(&["p2"], false)
        )
        .is_empty());
    }

    #[test]
    fn rel_dir_and_merge_blocking() {
        assert_eq!(
            annotations_rel_dir("project.json", &Value::Null),
            "annotations"
        );
        assert_eq!(
            annotations_rel_dir("reviews/project.json", &Value::Null),
            "reviews/annotations"
        );
        assert_eq!(
            annotations_rel_dir("a/b/c/project.json", &Value::Null),
            "a/b/c/annotations"
        );
        assert_eq!(
            annotations_rel_dir("reviews\\project.json", &Value::Null),
            "reviews/annotations"
        );
        assert_eq!(
            annotations_rel_dir("r/p.json", &json!({"annotationsDir":"x"})),
            "r/x"
        );
        assert_eq!(
            annotations_rel_dir("r/p.json", &json!({"annotationsDir":"../x"})),
            "r/annotations"
        );

        let tracked = [change("project.json", " M"), change("papers/a.pdf", "M ")];
        assert_eq!(
            merge_blocking_paths(&tracked, "annotations"),
            ["project.json", "papers/a.pdf"]
        );
        let untracked = [
            change("annotations/p5/reviewer-2.json", "??"),
            change("notes.md", "??"),
            change("annotations/feedback/run.json", "??"),
            change("annotations/feedback", "??"),
        ];
        assert_eq!(
            merge_blocking_paths(&untracked, "annotations"),
            ["annotations/p5/reviewer-2.json"]
        );
        let nested = [
            change("sub/annotations/p1/consolidated.json", "??"),
            change("other/annotations/p1/consolidated.json", "??"),
        ];
        assert_eq!(
            merge_blocking_paths(&nested, "sub/annotations"),
            ["sub/annotations/p1/consolidated.json"]
        );
    }

    #[test]
    fn managed_block_converges() {
        let fresh = apply_managed_block(None, "x");
        assert_eq!(fresh.text, format!("{BLOCK_BEGIN}\nx\n{BLOCK_END}\n"));
        assert!(fresh.changed && !fresh.had_existing);
        assert!(!apply_managed_block(Some("  \n"), "x").had_existing);
        let appended = apply_managed_block(Some("mine"), "x");
        assert_eq!(
            appended.text,
            format!("mine\n\n{BLOCK_BEGIN}\nx\n{BLOCK_END}\n")
        );
        assert!(appended.had_existing);
        let again = apply_managed_block(Some(&appended.text), "x");
        assert!(!again.changed);
        let updated = apply_managed_block(Some(&appended.text), "y");
        assert_eq!(
            updated.text,
            format!("mine\n\n{BLOCK_BEGIN}\ny\n{BLOCK_END}\n")
        );
        let (_, _, up, consent) = plan_repo_setup(None, None);
        assert!(!up && !consent);
        let (_, _, _, consent) = plan_repo_setup(Some("*.pdf binary\n"), None);
        assert!(consent);
        assert_eq!(
            setup_paths("p.json"),
            (".gitattributes".into(), ".gitignore".into())
        );
        assert_eq!(setup_paths("r/p.json").0, "r/.gitattributes");
    }

    #[test]
    fn sha_and_root_checks() {
        assert!(assert_sha(&"a".repeat(40)).is_ok());
        assert!(assert_sha(&"0".repeat(64)).is_ok());
        for bad in ["", "abc", &"A".repeat(40), &"a".repeat(41)] {
            assert!(assert_sha(bad).is_err(), "{bad}");
        }
        let s = Mutex::new(Session::default());
        let e = status(&s, "/somewhere").unwrap_err();
        assert!(e.contains("not a repository this session opened"), "{e}");
    }

    // ---- Against real repositories ----

    fn sh(dir: &Path, args: &[&str]) -> String {
        let r = run_git(args, Some(dir), TIMEOUT, &[]);
        assert!(r.ok, "git {args:?}: {}", r.stderr);
        r.stdout
    }

    fn configure(d: &Path) {
        sh(d, &["config", "user.name", "Tester"]);
        sh(d, &["config", "user.email", "t@example.com"]);
        sh(d, &["config", "commit.gpgsign", "false"]);
    }

    fn put(d: &Path, rel: &str, text: &str) {
        let p = d.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    fn commit_all(d: &Path, msg: &str) {
        sh(d, &["add", "-A"]);
        sh(d, &["commit", "-q", "-m", msg]);
    }

    const META: &str = r#"{"papers":[{"id":"p1"}]}"#;

    /// A repository holding `p.json` with one reviewer file, opened via `info`.
    fn repo(name: &str) -> (PathBuf, Mutex<Session>) {
        let d = tmp(name);
        sh(&d, &["init", "-q", "-b", "main"]);
        configure(&d);
        put(&d, "p.json", META);
        put(&d, "annotations/p1/reviewer-1.json", r#"{"a":1}"#);
        commit_all(&d, "init");
        let s = Mutex::new(Session::default());
        info(&s, &d.join("p.json").display().to_string()).unwrap();
        (d, s)
    }

    fn root(d: &Path) -> String {
        d.display().to_string()
    }

    fn contents(meta: &str, files: &[(&str, &str)]) -> Contents {
        Contents {
            meta_text: meta.into(),
            files: files
                .iter()
                .map(|(r, t)| SaveFile {
                    rel_path: (*r).into(),
                    text: Some((*t).into()),
                })
                .collect(),
        }
    }

    #[test]
    fn info_status_commit_and_detached_refusal() {
        let (d, s) = repo("git-basic");
        let i = info(&s, &d.join("p.json").display().to_string()).unwrap();
        assert_eq!(i["relPath"], "p.json");
        assert_eq!(i["branch"], "main");
        assert_eq!(i["hasHead"], true);
        assert_eq!(i["behind"], Value::Null);
        assert_eq!(i["annotationsDir"], "annotations");
        assert!(info(&s, &tmp("git-none").join("p.json").display().to_string()).is_none());

        put(&d, "notes.md", "n");
        put(&d, "p.json", r#"{"papers":[{"id":"p1"}],"title":"x"}"#);
        let st = status(&s, &root(&d)).unwrap();
        assert!(st["porcelain"].as_str().unwrap().contains("?? notes.md"));
        assert!(st["diff"].as_str().unwrap().contains("title"));

        assert!(!commit(&s, &root(&d), &[], "m", false).unwrap().ok);
        assert!(commit(&s, &root(&d), &["../x".into()], "m", false).is_err());
        let r = commit(&s, &root(&d), &["notes.md".into()], "add notes", false).unwrap();
        assert!(r.ok, "{}", r.stderr);
        assert_eq!(
            last_commit_message(&s, &root(&d)).unwrap().as_deref(),
            Some("add notes\n")
        );
        assert!(status(&s, &root(&d)).unwrap()["porcelain"]
            .as_str()
            .unwrap()
            .contains(" M p.json"));

        sh(&d, &["checkout", "-q", "--detach"]);
        let r = commit(&s, &root(&d), &["p.json".into()], "m", false).unwrap();
        assert!(r.stderr.contains("detached HEAD"), "{}", r.stderr);
    }

    #[test]
    fn head_content_and_log() {
        let (d, s) = repo("git-head");
        put(&d, "annotations/p9/reviewer-1.json", "{}");
        put(&d, "annotations/p1/notes.txt", "x");
        commit_all(&d, "sibling files");
        let snap = head_content(&s, &root(&d), "p.json").unwrap().unwrap();
        assert_eq!(snap.text, META);
        assert_eq!(
            snap.files,
            [FileText {
                rel_path: "p1/reviewer-1.json".into(),
                text: r#"{"a":1}"#.into()
            }]
        );
        assert!(head_content(&s, &root(&d), "missing.json")
            .unwrap()
            .is_none());

        let log = log_begin(&s, &root(&d), "p.json").unwrap();
        assert_eq!(log["commits"].as_array().unwrap().len(), 2);
        let first = log["commits"][1]["hash"].as_str().unwrap().to_string();
        let latest = log["commits"][0]["hash"].as_str().unwrap().to_string();
        assert_eq!(
            log_diff(&s, &root(&d), "p.json", &first).unwrap()["kind"],
            "initial"
        );
        assert_eq!(
            log_diff(&s, &root(&d), "p.json", &latest).unwrap()["kind"],
            "texts"
        );
        assert_eq!(
            log_diff(&s, &root(&d), "p.json", "main^").unwrap()["kind"],
            "error"
        );
    }

    fn clone_pair(name: &str) -> (PathBuf, PathBuf, Mutex<Session>) {
        let (origin, s) = repo(&format!("{name}-origin"));
        let base = tmp(name);
        let (a, b) = (base.join("a"), base.join("b"));
        for dest in [&a, &b] {
            let r = clone(&s, &root(&origin), &root(dest));
            assert_eq!(r["ok"], true, "{r}");
            configure(dest);
        }
        sh(&origin, &["config", "receive.denyCurrentBranch", "ignore"]);
        (a, b, s)
    }

    #[test]
    fn pull_fast_forward_merge_and_conflict_elsewhere() {
        let (a, b, s) = clone_pair("git-pull");
        put(&b, "annotations/p1/reviewer-2.json", r#"{"b":1}"#);
        commit_all(&b, "b reads");
        assert!(push(&s, &root(&b)).unwrap().ok);
        assert_eq!(
            pull_begin(&s, &root(&a), "p.json").unwrap()["kind"],
            "fast-forwarded"
        );
        assert_eq!(
            pull_begin(&s, &root(&a), "p.json").unwrap()["kind"],
            "up-to-date"
        );

        put(&a, "annotations/p1/reviewer-1.json", r#"{"a":2}"#);
        commit_all(&a, "a edits");
        put(&b, "annotations/p1/reviewer-1.json", r#"{"a":3}"#);
        commit_all(&b, "b edits");
        assert!(push(&s, &root(&b)).unwrap().ok);
        let m = pull_begin(&s, &root(&a), "p.json").unwrap();
        assert_eq!(m["kind"], "merge", "{m}");
        assert_eq!(m["ours"]["files"][0]["text"], r#"{"a":2}"#);
        assert_eq!(m["theirs"]["files"][0]["text"], r#"{"a":3}"#);
        let done = pull_finish(
            &s,
            &root(&a),
            "p.json",
            &contents(META, &[("p1/reviewer-1.json", r#"{"a":4}"#)]),
        )
        .unwrap();
        assert!(done.ok, "{}", done.stderr);
        assert_eq!(sh(&a, &["log", "-1", "--format=%p"]).split(' ').count(), 2);

        put(&a, "notes.md", "a");
        commit_all(&a, "a notes");
        put(&b, "notes.md", "b");
        commit_all(&b, "b notes");
        let r = merge_begin(&s, &root(&b), "p.json", "origin/main").unwrap();
        assert_eq!(r["kind"], "up-to-date", "{r}");
        assert!(push(&s, &root(&a)).unwrap().ok);
        let r = pull_begin(&s, &root(&b), "p.json").unwrap();
        assert_eq!(r, json!({"kind":"conflict-elsewhere","paths":["notes.md"]}));
        assert!(!b.join(".git/MERGE_HEAD").exists());

        put(&b, "annotations/p1/new.json", "{}");
        assert_eq!(
            pull_begin(&s, &root(&b), "p.json").unwrap()["kind"],
            "dirty"
        );
        assert_eq!(
            merge_begin(&s, &root(&a), "p.json", "nope").unwrap()["kind"],
            "error"
        );
        assert!(merge_begin(&s, &root(&a), "p.json", "main^").is_err());
    }

    #[test]
    fn stash_push_restore_drop() {
        let (d, s) = repo("git-stash");
        assert!(!stash_push(&s, &root(&d), "p.json", "").unwrap().ok);
        put(&d, "annotations/p1/reviewer-2.json", "{}");
        put(&d, "annotations/p9/reviewer-1.json", "{}");
        let r = stash_push(&s, &root(&d), "p.json", " note ").unwrap();
        assert!(r.ok, "{}", r.stderr);
        assert!(!d.join("annotations/p1/reviewer-2.json").exists());
        assert!(d.join("annotations/p9/reviewer-1.json").exists());
        let list = stash_list(&s, &root(&d)).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].message, "sailor stash: note");
        let sha = list[0].sha.clone();

        put(&d, "annotations/p1/reviewer-1.json", r#"{"dirty":1}"#);
        assert_eq!(
            stash_restore(&s, &root(&d), "p.json", &sha).unwrap()["kind"],
            "dirty"
        );
        sh(&d, &["checkout", "--", "."]);
        fs::remove_file(d.join("annotations/p9/reviewer-1.json")).unwrap();
        assert_eq!(
            stash_restore(&s, &root(&d), "p.json", &sha).unwrap()["kind"],
            "restored"
        );
        assert!(d.join("annotations/p1/reviewer-2.json").exists());
        assert_eq!(
            stash_restore(&s, &root(&d), "p.json", &sha).unwrap()["kind"],
            "gone"
        );

        stash_push(&s, &root(&d), "p.json", "").unwrap();
        let sha = stash_list(&s, &root(&d)).unwrap()[0].sha.clone();
        assert_eq!(
            stash_list(&s, &root(&d)).unwrap()[0].message,
            "sailor stash: stashed from SaiLoR"
        );
        assert!(stash_drop(&s, &root(&d), &sha).unwrap().ok);
        assert!(!stash_drop(&s, &root(&d), &sha).unwrap().ok);
        assert!(stash_drop(&s, &root(&d), "HEAD").is_err());
    }

    #[test]
    fn branch_switch_begin_abort_finish() {
        let (d, s) = repo("git-switch");
        sh(&d, &["branch", "side"]);
        let names: Vec<String> = branches(&s, &root(&d))
            .unwrap()
            .iter()
            .map(|b| b["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, ["main", "side"]);
        assert_eq!(
            branch_switch_begin(&s, &root(&d), "p.json", "side").unwrap()["kind"],
            "no-changes"
        );

        put(&d, "notes.md", "x");
        assert_eq!(
            branch_switch_begin(&s, &root(&d), "p.json", "side").unwrap(),
            json!({"kind":"other-files-dirty","paths":["notes.md"]})
        );
        fs::remove_file(d.join("notes.md")).unwrap();

        put(&d, "annotations/p1/reviewer-1.json", r#"{"a":5}"#);
        let m = branch_switch_begin(&s, &root(&d), "p.json", "side").unwrap();
        assert_eq!(m["kind"], "merge", "{m}");
        assert_eq!(m["sourceBranch"], "main");
        assert_eq!(m["ours"]["files"][0]["text"], r#"{"a":5}"#);
        assert_eq!(sh(&d, &["symbolic-ref", "--short", "HEAD"]).trim(), "side");

        let r = branch_switch_abort(&s, &root(&d), "main").unwrap();
        assert!(r.ok, "{}", r.stderr);
        assert_eq!(
            fs::read_to_string(d.join("annotations/p1/reviewer-1.json")).unwrap(),
            r#"{"a":5}"#
        );

        branch_switch_begin(&s, &root(&d), "p.json", "side").unwrap();
        let r = branch_switch_finish(
            &s,
            &root(&d),
            "p.json",
            &contents(META, &[("p1/reviewer-1.json", r#"{"a":6}"#)]),
        )
        .unwrap();
        assert!(r.ok, "{}", r.stderr);
        assert!(stash_list(&s, &root(&d)).unwrap().is_empty());
        assert_eq!(
            fs::read_to_string(d.join("annotations/p1/reviewer-1.json")).unwrap(),
            r#"{"a":6}"#
        );
        assert!(checkout(&s, &root(&d), "--force").is_err());
    }

    #[test]
    fn commit_partial_restores_working_and_write_working() {
        let (d, s) = repo("git-partial");
        put(&d, "annotations/p9/reviewer-1.json", "{}");
        let r = commit_partial(
            &s,
            &root(&d),
            "p.json",
            &contents(META, &[("p1/reviewer-1.json", r#"{"a":"committed"}"#)]),
            &contents(META, &[("p1/reviewer-1.json", r#"{"a":"working"}"#)]),
            &[],
            "partial",
            false,
        )
        .unwrap();
        assert!(r.ok, "{}", r.stderr);
        assert_eq!(
            sh(&d, &["show", "HEAD:annotations/p1/reviewer-1.json"]),
            r#"{"a":"committed"}"#
        );
        assert_eq!(
            fs::read_to_string(d.join("annotations/p1/reviewer-1.json")).unwrap(),
            r#"{"a":"working"}"#
        );
        assert!(sh(&d, &["status", "--porcelain"]).contains("?? annotations/p9/"));

        let r = write_working(
            &s,
            &root(&d),
            "p.json",
            &contents(META, &[("p1/reviewer-1.json", "{}")]),
        )
        .unwrap();
        assert!(r.ok);
        assert_eq!(
            fs::read_to_string(d.join("annotations/p1/reviewer-1.json")).unwrap(),
            "{}"
        );
        assert!(working_content(&s, &root(&d), "p.json").unwrap().is_some());
    }

    #[test]
    fn repo_setup_and_annotation_authors() {
        let (d, s) = repo("git-setup");
        let st = repo_setup_status(&s, &root(&d), "p.json").unwrap();
        assert_eq!(st["upToDate"], false);
        assert_eq!(st["needsConsent"], false);
        let r = apply_repo_setup(&s, &root(&d), "p.json").unwrap();
        assert!(r.ok, "{}", r.stderr);
        assert_eq!(sh(&d, &["log", "-1", "--format=%an"]).trim(), "SaiLoR");
        assert_eq!(
            repo_setup_status(&s, &root(&d), "p.json").unwrap()["upToDate"],
            true
        );
        assert!(apply_repo_setup(&s, &root(&d), "p.json").unwrap().ok);

        let a = annotation_authors(&s, &root(&d), "p.json").unwrap();
        assert_eq!(a["me"], json!({"name":"Tester","email":"t@example.com"}));
        assert_eq!(a["files"]["p1/reviewer-1.json"]["name"], "Tester");
        assert_eq!(background_fetch(&s, &root(&d)).unwrap()["refused"], false);
        sh(&d, &["config", "core.sshCommand", "evil"]);
        assert_eq!(background_fetch(&s, &root(&d)).unwrap()["refused"], true);
    }

    #[test]
    fn discard_file_rules() {
        let (d, s) = repo("git-discard");
        put(&d, "notes.md", "a");
        commit_all(&d, "notes");
        put(&d, "notes.md", "changed");
        put(&d, "exports/a/b.txt", "x");
        put(&d, "scratch.txt", "x");
        let run = |rel: &str| discard_file(&s, &root(&d), rel, "p.json").unwrap();
        assert!(run("notes.md").ok);
        assert_eq!(fs::read_to_string(d.join("notes.md")).unwrap(), "a");
        assert!(run("exports/").ok);
        assert!(!d.join("exports").exists());
        assert!(run("scratch.txt").ok);
        assert!(!d.join("scratch.txt").exists());
        assert!(run("clean.md").ok);
        put(&d, "annotations/p1/reviewer-1.json", "{}");
        assert!(run("annotations/p1/reviewer-1.json")
            .stderr
            .contains("own file"));
        assert!(run("p.json").stderr.contains("own file"));
        assert!(run("../x").stderr.contains("traversal"));
    }

    #[cfg(unix)]
    #[test]
    fn inside_root_follows_links() {
        let (d, _) = repo("git-inside");
        let outside = tmp("git-inside-out");
        std::os::unix::fs::symlink(&outside, d.join("link")).unwrap();
        assert!(assert_inside_root(&d, &d.join("a.json")).is_ok());
        let e = assert_inside_root(&d, &d.join("link/a.json")).unwrap_err();
        assert!(e.contains("outside the repository"), "{e}");
        assert!(assert_inside_root(&d, &d.join("nope/a.json"))
            .unwrap_err()
            .contains("does not exist"));
    }
}
