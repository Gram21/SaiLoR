//! `local:*` (electron/localRuntime.ts, localRuntimeUtil.ts, localRuntimeIpc.ts): finds or
//! installs llama.cpp's `llama-server`, downloads decision-model files, and runs one server
//! per model on 127.0.0.1.
//!
//! Trust model: the renderer only names a catalog id. URLs, file paths and the executable are
//! decided here; every download is hash-verified against a digest the host itself publishes
//! (GitHub asset digest / Hugging Face LFS oid), and a download only starts after the matching
//! plan was produced (and shown to the user for consent) in this session.

use crate::authz::err;
use crate::net::{self, Flight};
use reqwest::{Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, Once};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use url::Url;

const IDLE_STOP: Duration = Duration::from_secs(10 * 60);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(120);
const STALL: Duration = Duration::from_secs(60);
const GH: &str = "https://api.github.com/repos/ggml-org/llama.cpp";
const EXE: &str = if cfg!(windows) {
    "llama-server.exe"
} else {
    "llama-server"
};
/// llama.cpp commit that added `POST /v1/systemone` (PR #29818). A release includes the route iff it contains this commit.
const SYSTEMONE_COMMIT: &str = "a4cb4c61fd9d9c2066c7c1747821d3d65b8943bd";
const CANCELLED: &str = "Download cancelled or stalled; the partial file is kept for resuming.";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ---- catalog (mirror of src/llm/localCatalog.ts) ------------------------------------

pub struct Entry {
    pub id: &'static str,
    hf_repo: &'static str,
    hf_file: &'static str,
    context_tokens: u32,
    license: &'static str,
    /// Set for `status: 'planned'` entries: why they cannot be downloaded or run yet.
    planned: Option<&'static str>,
}

const COMMUNITY: &str = "Community GGUF uses the 'ggmlc' architecture, which llama.cpp cannot load (tested on master 4ebdf2c); needs a ggml-org conversion.";
const CLEF: &str = "Needs a llama.cpp build with Clef support (not merged yet).";

const fn entry(
    id: &'static str,
    hf_repo: &'static str,
    hf_file: &'static str,
    context_tokens: u32,
    planned: Option<&'static str>,
) -> Entry {
    Entry {
        id,
        hf_repo,
        hf_file,
        context_tokens,
        license: "Apache-2.0",
        planned,
    }
}

const CATALOG: [Entry; 5] = [
    entry(
        "laya-en-q8",
        "ggml-org/Laya-GGUF",
        "Laya-Q8_0.gguf",
        2048,
        None,
    ),
    entry(
        "laya-multilingual-q8",
        "mys/laya-multilingual-GGUF",
        "laya_multilingual_q8_0.gguf",
        2048,
        Some(COMMUNITY),
    ),
    entry(
        "laya-typed-decisions-q8",
        "mys/laya-typed-decisions-GGUF",
        "laya_typed_decisions_q8_0.gguf",
        2048,
        Some(COMMUNITY),
    ),
    entry(
        "clef-flash",
        "bartowski/Cloudflare_clef-flash-GGUF",
        "",
        0,
        Some(CLEF),
    ),
    entry("clef", "bartowski/Cloudflare_clef-GGUF", "", 0, Some(CLEF)),
];

fn find_entry(id: &str) -> Option<&'static Entry> {
    CATALOG.iter().find(|e| e.id == id)
}

fn id_of(id: &str) -> Result<&'static str, String> {
    find_entry(id)
        .map(|e| e.id)
        .ok_or_else(|| "Unknown local model.".into())
}

fn require_available(id: &str) -> Result<&'static Entry, String> {
    let e = find_entry(id).ok_or("Unknown local model.")?;
    match e.planned {
        Some(reason) => Err(reason.into()),
        None => Ok(e),
    }
}

// ---- pure helpers (localRuntimeUtil.ts) ----------------------------------------------

#[derive(Deserialize, Clone, Debug)]
pub struct GhAsset {
    name: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    digest: Option<String>,
    #[serde(default)]
    browser_download_url: String,
}

/// Release tags are `b<build number>`; anything else must never reach a path or URL.
fn is_release_tag(t: &str) -> bool {
    t.strip_prefix('b')
        .is_some_and(|n| (1..=7).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()))
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// GitHub's `digest` field is `sha256:<hex>`; anything else is treated as missing.
fn parse_digest(d: Option<&str>) -> Option<String> {
    let d = d?;
    let (scheme, hex) = d.split_at_checked(7)?;
    (scheme.eq_ignore_ascii_case("sha256:") && is_hex(hex, 64)).then(|| hex.to_ascii_lowercase())
}

/// The `lfs.oid` of a Hugging Face tree entry is the file's SHA-256: (size, sha256).
fn parse_hf_file(tree: &Value, file: &str) -> Option<(u64, String)> {
    let e = tree
        .as_array()?
        .iter()
        .find(|x| x["type"] == "file" && x["path"] == file)?;
    let sha = e["lfs"]["oid"].as_str().filter(|s| is_hex(s, 64))?;
    let size = e["lfs"]["size"].as_u64().or(e["size"].as_u64())?;
    Some((size, sha.to_ascii_lowercase()))
}

/// The release asset for this machine and the backend it brings. Windows prefers Vulkan over
/// CUDA (CUDA builds need a separate cudart bundle). Falls back to the CPU build.
fn select_asset<'a>(
    assets: &'a [GhAsset],
    tag: &str,
    platform: &str,
    arch: &str,
    backend: &str,
) -> Option<(&'a GhAsset, &'static str)> {
    let a = match arch {
        "arm64" | "x64" => arch,
        _ => return None,
    };
    let gpu = backend == "vulkan" || backend == "cuda";
    let keys: Vec<(String, &'static str)> = match platform {
        "darwin" => vec![(format!("macos-{a}.tar.gz"), "metal")],
        "win32" => [
            gpu.then(|| (format!("win-vulkan-{a}.zip"), "vulkan")),
            Some((format!("win-cpu-{a}.zip"), "cpu")),
        ]
        .into_iter()
        .flatten()
        .collect(),
        "linux" => [
            gpu.then(|| (format!("ubuntu-vulkan-{a}.tar.gz"), "vulkan")),
            Some((format!("ubuntu-{a}.tar.gz"), "cpu")),
        ]
        .into_iter()
        .flatten()
        .collect(),
        _ => return None,
    };
    keys.into_iter().find_map(|(key, b)| {
        let name = format!("llama-{tag}-bin-{key}");
        assets.iter().find(|x| x.name == name).map(|x| (x, b))
    })
}

/// Where a download restarts, given the bytes already on disk. `0` = start over.
fn resume_offset(partial: u64, total: u64) -> u64 {
    if partial > 0 && partial <= total {
        partial
    } else {
        0
    }
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// True if a `Content-Range` header confirms the response begins at `start`.
fn content_range_starts_at(header: Option<&str>, start: u64) -> bool {
    let Some(rest) = header.and_then(|h| h.strip_prefix("bytes ")) else {
        return false;
    };
    let Some((first, rest)) = rest.split_once('-') else {
        return false;
    };
    let Some((last, total)) = rest.split_once('/') else {
        return false;
    };
    digits(first) && digits(last) && (digits(total) || total == "*") && first.parse() == Ok(start)
}

#[derive(Clone, Copy)]
enum Host {
    Github,
    HuggingFace,
}

/// Every hop of a download (first request and each redirect) must pass this. https only.
fn allowed_download_url(kind: Host, raw: &str) -> bool {
    let Ok(u) = Url::parse(raw) else {
        return false;
    };
    if u.scheme() != "https" || !u.username().is_empty() || u.password().is_some() {
        return false;
    }
    if u.port().is_some_and(|p| p != 443) {
        return false;
    }
    let h = u.host_str().unwrap_or("").to_ascii_lowercase();
    let under = |d: &str| h == d || h.ends_with(&format!(".{d}"));
    match kind {
        Host::Github => {
            h == "github.com" || h == "api.github.com" || under("githubusercontent.com")
        }
        Host::HuggingFace => under("huggingface.co") || under("hf.co"),
    }
}

fn github(u: &str) -> bool {
    allowed_download_url(Host::Github, u)
}

fn huggingface(u: &str) -> bool {
    allowed_download_url(Host::HuggingFace, u)
}

/// `llama-server --version` prints e.g. `version: 0.5.0-dev (build 11349, commit fb4b2737a)`.
fn parse_version(out: &str) -> Option<String> {
    for (i, _) in out.match_indices("(build ") {
        let n: String = out[i + 7..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if !n.is_empty() {
            if n != "0" {
                return Some(format!("b{n}"));
            }
            break;
        }
    }
    out.match_indices("version:").find_map(|(i, _)| {
        let v: String = out[i + 8..]
            .trim_start()
            .chars()
            .take_while(|c| !c.is_whitespace())
            .collect();
        (!v.is_empty()).then_some(v)
    })
}

/// `llama-server` arguments for a decision model. Batch sizes equal the context: a request's
/// prompt must fit one micro-batch, else the server answers 500 ("input is too large to
/// process"). One slot: one request at a time. `-lv 4` logs the offload summary that
/// `parse_server_log` reads.
fn build_server_args(
    model: &Path,
    port: u16,
    context_tokens: u32,
    gpu: bool,
    api_key: &str,
) -> Vec<String> {
    let c = context_tokens.to_string();
    let mut a: Vec<String> = vec![
        "-m".into(),
        model.to_string_lossy().into_owned(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "-c".into(),
        c.clone(),
        "-b".into(),
        c.clone(),
        "-ub".into(),
        c,
        "-np".into(),
        "1".into(),
    ];
    let dev: &[&str] = if gpu {
        &["-ngl", "99"]
    } else {
        &["-dev", "none", "-ngl", "0"]
    };
    a.extend(dev.iter().map(|s| s.to_string()));
    a.extend(["--no-webui", "--api-key", api_key, "-lv", "4"].map(String::from));
    a
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    catalog_id: String,
    base_url: String,
    backend: &'static str,
    using_gpu: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    layers_offloaded: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

/// The real backend, read from the startup log, never from what was asked for:
/// (backend, usingGpu, layersOffloaded).
fn parse_server_log(lines: &[String]) -> (&'static str, bool, Option<u32>) {
    let text = lines.join("\n");
    let layers = text.match_indices("offloaded ").find_map(|(i, _)| {
        let rest = &text[i + 10..];
        let (n, rest) = rest.split_once('/')?;
        let (m, rest) = rest.split_once(' ')?;
        (digits(n) && digits(m) && rest.starts_with("layers to GPU")).then(|| n.parse().ok())?
    });
    let lower = text.to_ascii_lowercase();
    let dev = lower.match_indices("using device ").find_map(|(i, _)| {
        let rest = &lower[i + 13..];
        ["mtl", "cuda", "vulkan", "rocm", "hip", "sycl", "opencl"]
            .into_iter()
            .find(|d| rest.starts_with(d))
    });
    let backend = match dev {
        Some("mtl") => "metal",
        Some("cuda") => "cuda",
        Some("vulkan") => "vulkan",
        _ => "cpu",
    };
    // "using device X" is logged even with 0 layers offloaded, so the layer count decides.
    if backend == "cpu" || layers.unwrap_or(0) == 0 {
        return ("cpu", false, layers);
    }
    (backend, true, layers)
}

/// Turn a failed start's log into a sentence the user can act on.
fn explain_start_failure(lines: &[String]) -> Option<&'static str> {
    let text = lines.join("\n");
    if text.contains("unknown model architecture") || text.contains("wrong shape") {
        return Some("This llama.cpp build cannot load the model (too old, or an incompatible conversion). Update the runtime.");
    }
    let lower = text.to_ascii_lowercase();
    [
        "out of memory",
        "failed to allocate",
        "erroroutofdevicememory",
    ]
    .iter()
    .any(|p| lower.contains(p))
    .then_some("Not enough memory to load the model.")
}

/// The last `max` complete lines of a stream, plus the unfinished one.
struct RingLog {
    lines: VecDeque<String>,
    partial: String,
    max: usize,
}

impl RingLog {
    fn new(max: usize) -> Self {
        Self {
            lines: VecDeque::new(),
            partial: String::new(),
            max,
        }
    }

    fn push(&mut self, chunk: &str) {
        let text = std::mem::take(&mut self.partial) + chunk;
        let mut parts: Vec<&str> = text.split('\n').collect();
        self.partial = parts.pop().unwrap_or("").to_string();
        for l in parts {
            let l = l.strip_suffix('\r').unwrap_or(l);
            if !l.is_empty() {
                self.lines.push_back(l.to_string());
            }
        }
        while self.lines.len() > self.max {
            self.lines.pop_front();
        }
    }

    fn all(&self) -> Vec<String> {
        let mut out: Vec<String> = self.lines.iter().cloned().collect();
        if !self.partial.is_empty() {
            out.push(self.partial.clone());
        }
        out
    }
}

// ---- shared state ---------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    found: bool,
    source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    /// `true`, `false` or `"unknown"`.
    supports_system_one: Value,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePlan {
    tag: String,
    asset_name: String,
    url: String,
    size_bytes: u64,
    sha256: String,
    backend: &'static str,
    includes_system_one: Value,
    license: &'static str,
    source: &'static str,
    destination: String,
    disk_free_bytes: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelPlan {
    catalog_id: &'static str,
    repo: &'static str,
    file: &'static str,
    url: String,
    size_bytes: u64,
    sha256: String,
    license: &'static str,
    destination: String,
    disk_free_bytes: i64,
    resume_from: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModel {
    catalog_id: &'static str,
    file: &'static str,
    size_bytes: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    id: String,
    kind: &'static str,
    completed: u64,
    total: u64,
    phase: &'static str,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    catalog_id: String,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    info: Option<ServerInfo>,
}

struct Running {
    /// Taken (and killed) by `stop`.
    child: Mutex<Option<Child>>,
    api_key: String,
    info: ServerInfo,
    last_used: Mutex<Instant>,
}

impl Running {
    fn alive(&self) -> bool {
        lock(&self.child)
            .as_mut()
            .is_some_and(|c| matches!(c.try_wait(), Ok(None)))
    }
}

#[derive(Default)]
struct Shared {
    runtime_plan: Option<RuntimePlan>,
    model_plans: HashMap<&'static str, ModelPlan>,
    servers: HashMap<&'static str, Arc<Running>>,
    starting: HashSet<&'static str>,
    logs: HashMap<&'static str, Arc<Mutex<RingLog>>>,
}

static STATE: LazyLock<Mutex<Shared>> = LazyLock::new(Default::default);
// ponytail: one lock serializes all starts (dedupes concurrent starts of one model); per-model locks if two models ever need to start at once.
static START: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static IDLE: Once = Once::new();

/// Loopback calls to llama-server: no proxy may see the per-session key, no redirects.
pub(crate) static LOOPBACK: LazyLock<Client> = LazyLock::new(|| {
    net::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("http client")
});

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn state() -> MutexGuard<'static, Shared> {
    lock(&STATE)
}

fn runtime_root(dir: &Path) -> PathBuf {
    dir.join("local-runtime").join("llama.cpp")
}

fn models_root(dir: &Path) -> PathBuf {
    dir.join("local-models")
}

fn model_file(dir: &Path, e: &Entry) -> PathBuf {
    models_root(dir).join(e.id).join(e.hf_file)
}

fn display(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Electron's `userData`, so installs made by the Electron build are reused.
fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().config_dir().map_err(err)?.join("SaiLoR"))
}

// ---- HTTP -----------------------------------------------------------------------------

type Allow = fn(&str) -> bool;
type Emit<'a> = &'a (dyn Fn(Progress) + Send + Sync);

fn host_of(u: &Url) -> String {
    let h = u.host_str().unwrap_or("");
    u.port().map_or(h.to_string(), |p| format!("{h}:{p}"))
}

/// GET with manual redirects so every hop is host-checked.
async fn get(
    client: &Client,
    allow: Allow,
    url: &str,
    headers: &[(&str, String)],
) -> Result<Response, String> {
    let mut cur = Url::parse(url).map_err(|_| "Invalid URL")?;
    for _ in 0..6 {
        if !allow(cur.as_str()) {
            return Err(format!("Refusing to download from {}.", host_of(&cur)));
        }
        let mut req = client.get(cur.clone()).header("user-agent", "SaiLoR");
        for (k, v) in headers {
            req = req.header(*k, v);
        }
        let res = req.send().await.map_err(|e| crate::webfetch::cause(&e))?;
        let loc = res
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        match loc {
            Some(loc) if res.status().is_redirection() => {
                cur = cur.join(&loc).map_err(|_| "Invalid URL")?;
            }
            _ => return Ok(res),
        }
    }
    Err("Too many redirects.".into())
}

async fn get_json(client: &Client, allow: Allow, url: &str) -> Result<Value, String> {
    let host = Url::parse(url).map(|u| host_of(&u)).unwrap_or_default();
    let fetch = async {
        let res = get(client, allow, url, &[("accept", "application/json".into())]).await?;
        if !res.status().is_success() {
            return Err(format!("{host} answered {}.", res.status().as_u16()));
        }
        let bytes = res.bytes().await.map_err(|e| crate::webfetch::cause(&e))?;
        serde_json::from_slice::<Value>(&bytes).map_err(err)
    };
    tokio::time::timeout(Duration::from_secs(20), fetch)
        .await
        .unwrap_or_else(|_| Err(format!("{host} did not answer in time.")))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn sha256_of(file: &Path) -> Result<String, String> {
    let file = file.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut f = std::fs::File::open(file).map_err(err)?;
        let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
        let mut buf = vec![0; 1 << 20];
        loop {
            let n = f.read(&mut buf).map_err(err)?;
            if n == 0 {
                return Ok(hex(ctx.finish().as_ref()));
            }
            ctx.update(&buf[..n]);
        }
    })
    .await
    .map_err(err)?
}

struct Download<'a> {
    id: &'a str,
    kind: &'static str,
    allow: Allow,
    url: &'a str,
    partial: PathBuf,
    size: u64,
    sha256: &'a str,
}

/// Download `url` to `partial` (resuming a previous partial), then verify its SHA-256.
/// `local_cancel(id)` or 60 s without data stop it and keep the partial.
async fn download_verified(client: &Client, d: Download<'_>, emit: Emit<'_>) -> Result<(), String> {
    let flight = Flight::new(&format!("local:{}", d.id));
    let stopped = |_| CANCELLED.to_string();
    let progress = |completed, phase| {
        emit(Progress {
            id: d.id.into(),
            kind: d.kind,
            completed,
            total: d.size,
            phase,
        })
    };
    if let Some(dir) = d.partial.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    let have = std::fs::metadata(&d.partial).map_or(0, |m| m.len());
    let mut offset = resume_offset(have, d.size);
    if offset < d.size {
        let range = if offset > 0 {
            vec![("range", format!("bytes={offset}-"))]
        } else {
            vec![]
        };
        let mut res = flight
            .run(STALL, get(client, d.allow, d.url, &range))
            .await
            .map_err(stopped)??;
        let status = res.status().as_u16();
        let content_range = res
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok());
        if !(status == 206 && content_range_starts_at(content_range, offset)) {
            if status != 200 {
                return Err(format!("Download failed ({status})."));
            }
            offset = 0;
        }
        let mut opts = std::fs::OpenOptions::new();
        if offset > 0 {
            opts.append(true);
        } else {
            opts.write(true).truncate(true);
        }
        let mut out = opts.create(true).open(&d.partial).map_err(err)?;
        let mut done = offset;
        let mut last: Option<Instant> = None;
        while let Some(chunk) = flight
            .run(STALL, res.chunk())
            .await
            .map_err(stopped)?
            .map_err(|e| crate::webfetch::cause(&e))?
        {
            out.write_all(&chunk).map_err(err)?;
            done += chunk.len() as u64;
            if last.is_none_or(|t| t.elapsed() > Duration::from_millis(250)) {
                last = Some(Instant::now());
                progress(done, "download");
            }
        }
        out.flush().map_err(err)?;
        progress(done, "download");
    }
    progress(d.size, "verify");
    let size = std::fs::metadata(&d.partial).map_err(err)?.len();
    if size != d.size || sha256_of(&d.partial).await? != d.sha256 {
        let _ = std::fs::remove_file(&d.partial);
        return Err(
            "Downloaded file does not match its published SHA-256; it was discarded.".into(),
        );
    }
    Ok(())
}

// ---- runtime ----------------------------------------------------------------------------

fn find_binary(dir: &Path, depth: u32) -> Option<PathBuf> {
    let entries: Vec<_> = std::fs::read_dir(dir).ok()?.flatten().collect();
    if let Some(e) = entries
        .iter()
        .find(|e| e.file_name() == EXE && e.file_type().is_ok_and(|t| t.is_file()))
    {
        return Some(e.path());
    }
    if depth >= 2 {
        return None;
    }
    entries
        .iter()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .find_map(|e| find_binary(&e.path(), depth + 1))
}

/// stdout and stderr of a tool with a time limit (killed when it runs over).
async fn run_tool(cmd: &Path, args: &[&str], limit: Duration) -> Result<String, String> {
    let mut c = tokio::process::Command::new(cmd);
    c.args(args).kill_on_drop(true).stdin(Stdio::null());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    let o = tokio::time::timeout(limit, c.output())
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(err)?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    );
    if o.status.success() {
        Ok(text)
    } else {
        Err(text)
    }
}

async fn version_of(bin: &Path) -> Option<String> {
    let out = run_tool(bin, &["--version"], Duration::from_secs(10)).await;
    parse_version(&out.unwrap_or_else(|e| e))
}

fn find_system() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .unwrap_or_default();
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .chain(
            ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
                .into_iter()
                .map(PathBuf::from),
        )
        .chain([PathBuf::from(home).join(".local").join("bin")])
        .filter(|d| !d.as_os_str().is_empty())
        .map(|d| d.join(EXE))
        .find(|f| f.is_file())
}

async fn runtime(dir: &Path) -> RuntimeStatus {
    let system = |path: &Path, version| RuntimeStatus {
        found: true,
        source: "system",
        path: Some(display(path)),
        version,
        supports_system_one: json!("unknown"),
    };
    // ponytail: a user-set path comes only from this env var, never from the renderer, which would be arbitrary exec.
    if let Some(p) = std::env::var_os("SAILOR_LLAMA_SERVER").map(PathBuf::from) {
        if p.is_file() {
            return system(&p, version_of(&p).await);
        }
    }
    let root = runtime_root(dir);
    let mut tags: Vec<(u64, String)> = std::fs::read_dir(&root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|t| is_release_tag(t))
        .map(|t| (t[1..].parse().unwrap_or(0), t))
        .collect();
    tags.sort_by_key(|t| std::cmp::Reverse(t.0));
    for (_, tag) in tags {
        let Some(bin) = find_binary(&root.join(&tag), 0) else {
            continue;
        };
        let manifest: Value = std::fs::read_to_string(root.join(&tag).join("manifest.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let includes = &manifest["includesSystemOne"];
        return RuntimeStatus {
            found: true,
            source: "managed",
            path: Some(display(&bin)),
            version: Some(tag),
            supports_system_one: if includes.is_boolean() {
                includes.clone()
            } else {
                json!("unknown")
            },
        };
    }
    if let Some(sys) = find_system() {
        return system(&sys, version_of(&sys).await);
    }
    RuntimeStatus {
        found: false,
        source: "none",
        path: None,
        version: None,
        supports_system_one: json!("unknown"),
    }
}

async fn includes_route(tag: &str) -> Value {
    let url = format!("{GH}/compare/{SYSTEMONE_COMMIT}...{tag}");
    match get_json(&net::NO_REDIRECT, github, &url).await {
        Ok(j) => json!(j["status"] == "ahead" || j["status"] == "identical"),
        Err(_) => json!("unknown"),
    }
}

#[derive(Deserialize)]
struct Release {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

async fn runtime_plan(dir: &Path) -> Result<RuntimePlan, String> {
    let hw = crate::hardware::probe(dir).await;
    // `releases/latest` points at an unrelated tag stream; the b<N> builds are the pre-releases listed here.
    let releases = get_json(
        &net::NO_REDIRECT,
        github,
        &format!("{GH}/releases?per_page=15"),
    )
    .await?;
    let releases: Vec<Release> = serde_json::from_value(releases).map_err(err)?;
    for r in releases {
        if r.draft || !is_release_tag(&r.tag_name) {
            continue;
        }
        let Some((asset, backend)) = select_asset(
            &r.assets,
            &r.tag_name,
            hw.platform,
            hw.arch,
            hw.recommended_backend,
        ) else {
            continue;
        };
        // Assets still uploading, or no published digest: skip, never guess.
        let Some(sha256) = parse_digest(asset.digest.as_deref()) else {
            continue;
        };
        let plan = RuntimePlan {
            asset_name: asset.name.clone(),
            url: asset.browser_download_url.clone(),
            size_bytes: asset.size,
            sha256,
            backend,
            includes_system_one: includes_route(&r.tag_name).await,
            license: "MIT",
            source: "github.com/ggml-org/llama.cpp",
            destination: display(&runtime_root(dir).join(&r.tag_name)),
            disk_free_bytes: hw.disk_free_bytes,
            tag: r.tag_name,
        };
        state().runtime_plan = Some(plan.clone());
        return Ok(plan);
    }
    Err("No llama.cpp release with a verifiable build for this machine was found.".into())
}

async fn extract(archive: &Path, into: &Path) -> Result<(), String> {
    // bsdtar reads .tar.gz and .zip; on Windows use the system one (a PATH `tar` may be GNU tar, which cannot read zip).
    let tar = if cfg!(windows) {
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
            .join("System32")
            .join("tar.exe")
    } else {
        PathBuf::from("tar")
    };
    let (a, i) = (display(archive), display(into));
    run_tool(&tar, &["-xf", &a, "-C", &i], Duration::from_secs(120))
        .await
        .map(drop)
        .map_err(|e| format!("Could not extract the runtime: {}", e.trim()))
}

async fn install_into(plan: &RuntimePlan, partial: &Path, tmp: &Path) -> Result<(), String> {
    std::fs::create_dir_all(tmp).map_err(err)?;
    extract(partial, tmp).await?;
    let bin = find_binary(tmp, 0).ok_or("The archive contains no llama-server.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).map_err(err)?;
    }
    if version_of(&bin).await.is_none() {
        return Err("The downloaded llama-server does not run on this machine.".into());
    }
    let manifest = json!({ "tag": plan.tag, "backend": plan.backend, "includesSystemOne": plan.includes_system_one });
    std::fs::write(tmp.join("manifest.json"), manifest.to_string()).map_err(err)?;
    let dest = Path::new(&plan.destination);
    let _ = std::fs::remove_dir_all(dest);
    std::fs::rename(tmp, dest).map_err(err)
}

async fn runtime_install(dir: &Path, emit: Emit<'_>) -> Result<RuntimeStatus, String> {
    let plan = state()
        .runtime_plan
        .clone()
        .ok_or("Review the runtime download plan first.")?;
    if plan.includes_system_one == json!(false) {
        return Err(format!("The newest llama.cpp release ({}) does not include the System One route yet. Try again later.", plan.tag));
    }
    let root = runtime_root(dir);
    let partial = root
        .join(".downloads")
        .join(format!("{}.partial", plan.asset_name));
    let d = Download {
        id: "runtime",
        kind: "runtime",
        allow: github,
        url: &plan.url,
        partial: partial.clone(),
        size: plan.size_bytes,
        sha256: &plan.sha256,
    };
    download_verified(&net::NO_REDIRECT, d, emit).await?;
    let step = |phase| {
        emit(Progress {
            id: "runtime".into(),
            kind: "runtime",
            completed: plan.size_bytes,
            total: plan.size_bytes,
            phase,
        })
    };
    step("extract");
    let tmp = root.join(format!(".tmp-{}", plan.tag));
    let _ = std::fs::remove_dir_all(&tmp);
    let r = install_into(&plan, &partial, &tmp).await;
    let _ = std::fs::remove_dir_all(&tmp);
    let _ = std::fs::remove_file(&partial);
    r?;
    for e in std::fs::read_dir(&root).map_err(err)?.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if is_release_tag(&name) && name != plan.tag {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
    step("done");
    Ok(runtime(dir).await)
}

// ---- model files ------------------------------------------------------------------------

async fn disk_free(dir: &Path) -> i64 {
    let dir = dir.to_path_buf();
    tokio::task::spawn_blocking(move || crate::hardware::disk_free(&dir))
        .await
        .unwrap_or(-1)
}

async fn model_plan(dir: &Path, id: &str) -> Result<ModelPlan, String> {
    let e = require_available(id)?;
    let info = get_json(
        &net::NO_REDIRECT,
        huggingface,
        &format!("https://huggingface.co/api/models/{}", e.hf_repo),
    )
    .await?;
    let rev = info["sha"]
        .as_str()
        .filter(|s| s.len() == 40 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
        .ok_or("Could not resolve the model revision.")?;
    let tree = get_json(
        &net::NO_REDIRECT,
        huggingface,
        &format!("https://huggingface.co/api/models/{}/tree/{rev}", e.hf_repo),
    )
    .await?;
    let (size, sha256) = parse_hf_file(&tree, e.hf_file)
        .ok_or("Hugging Face lists no verifiable checksum for this model file.")?;
    let dest = model_file(dir, e);
    let plan = ModelPlan {
        catalog_id: e.id,
        repo: e.hf_repo,
        file: e.hf_file,
        url: format!(
            "https://huggingface.co/{}/resolve/{rev}/{}",
            e.hf_repo, e.hf_file
        ),
        size_bytes: size,
        sha256,
        license: e.license,
        destination: display(&dest),
        disk_free_bytes: disk_free(dir).await,
        resume_from: std::fs::metadata(partial_of(&dest)).map_or(0, |m| m.len()),
    };
    state().model_plans.insert(e.id, plan.clone());
    Ok(plan)
}

fn partial_of(dest: &Path) -> PathBuf {
    let mut p = dest.as_os_str().to_owned();
    p.push(".partial");
    p.into()
}

async fn model_install(dir: &Path, id: &str, emit: Emit<'_>) -> Result<InstalledModel, String> {
    let e = require_available(id)?;
    let plan = state()
        .model_plans
        .get(e.id)
        .cloned()
        .ok_or("Review the model download plan first.")?;
    if plan.disk_free_bytes >= 0
        && (plan.disk_free_bytes as u64) < plan.size_bytes.saturating_sub(plan.resume_from)
    {
        return Err("Not enough free disk space.".into());
    }
    let dest = model_file(dir, e);
    let d = Download {
        id: e.id,
        kind: "model",
        allow: huggingface,
        url: &plan.url,
        partial: partial_of(&dest),
        size: plan.size_bytes,
        sha256: &plan.sha256,
    };
    download_verified(&net::NO_REDIRECT, d, emit).await?;
    std::fs::rename(partial_of(&dest), &dest).map_err(err)?;
    emit(Progress {
        id: e.id.into(),
        kind: "model",
        completed: plan.size_bytes,
        total: plan.size_bytes,
        phase: "done",
    });
    Ok(InstalledModel {
        catalog_id: e.id,
        file: e.hf_file,
        size_bytes: plan.size_bytes,
    })
}

fn installed(dir: &Path) -> Vec<InstalledModel> {
    std::fs::read_dir(models_root(dir))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|d| find_entry(&d.file_name().to_string_lossy()))
        .filter_map(|e| {
            let m = std::fs::metadata(model_file(dir, e)).ok()?;
            m.is_file().then_some(InstalledModel {
                catalog_id: e.id,
                file: e.hf_file,
                size_bytes: m.len(),
            })
        })
        .collect()
}

fn remove(dir: &Path, id: &str) -> Result<Vec<InstalledModel>, String> {
    let id = id_of(id)?;
    stop(id);
    let _ = std::fs::remove_dir_all(models_root(dir).join(id));
    Ok(installed(dir))
}

// ---- server manager ---------------------------------------------------------------------

fn spawn_server(bin: &Path, args: &[String]) -> std::io::Result<Child> {
    let mut c = Command::new(bin);
    c.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(d) = bin.parent().filter(|d| !d.as_os_str().is_empty()) {
        c.current_dir(d);
    }
    // Its own process group, so `terminate` reaches everything it starts.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut c, 0);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut c, CREATE_NO_WINDOW);
    c.spawn()
}

/// Signal the whole process tree: SIGTERM/SIGKILL to the group on unix, `taskkill /T /F` on Windows.
fn terminate(child: &Child, hard: bool) {
    #[cfg(unix)]
    {
        let sig = if hard { libc::SIGKILL } else { libc::SIGTERM };
        // SAFETY: kill(2) on the child's own process group (see `spawn_server`).
        unsafe { libc::kill(-(child.id() as libc::pid_t), sig) };
    }
    #[cfg(windows)]
    {
        let _ = hard;
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/pid", &child.id().to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Stop gently, then hard after 3 s; reaps the child off-thread.
fn kill(mut child: Child) {
    if !matches!(child.try_wait(), Ok(None)) {
        return;
    }
    std::thread::spawn(move || {
        terminate(&child, false);
        for _ in 0..30 {
            if !matches!(child.try_wait(), Ok(None)) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        terminate(&child, true);
        let _ = child.wait();
    });
}

fn pump(mut src: impl Read + Send + 'static, logs: [Arc<Mutex<RingLog>>; 2]) {
    std::thread::spawn(move || {
        let mut buf = [0; 8192];
        while let Ok(n @ 1..) = src.read(&mut buf) {
            // ponytail: lossy per read, so a UTF-8 char split across reads shows as U+FFFD; buffer the tail if logs ever need exact non-ASCII.
            let text = String::from_utf8_lossy(&buf[..n]);
            for l in &logs {
                lock(l).push(&text);
            }
        }
    });
}

struct LaunchError {
    msg: String,
    no_retry: bool,
}

fn random_key() -> Result<String, String> {
    use ring::rand::SecureRandom;
    let mut key = [0; 24];
    ring::rand::SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| "No secure random source.")?;
    Ok(hex(&key))
}

async fn launch(
    bin: &Path,
    dir: &Path,
    e: &'static Entry,
    gpu: bool,
) -> Result<Running, LaunchError> {
    let plain = |msg: String| LaunchError {
        msg,
        no_retry: false,
    };
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map_err(|x| plain(x.to_string()))?
        .port();
    let api_key = random_key().map_err(plain)?;
    let args = build_server_args(&model_file(dir, e), port, e.context_tokens, gpu, &api_key);
    let log = Arc::new(Mutex::new(RingLog::new(200)));
    state().logs.insert(e.id, log.clone());
    // The offload summary sits early in a long startup log; the 200-line ring would drop it.
    let startup = Arc::new(Mutex::new(RingLog::new(2000)));
    let mut child = spawn_server(bin, &args).map_err(|x| plain(x.to_string()))?;
    if let Some(s) = child.stdout.take() {
        pump(s, [log.clone(), startup.clone()]);
    }
    if let Some(s) = child.stderr.take() {
        pump(s, [log.clone(), startup.clone()]);
    }
    let base_url = format!("http://127.0.0.1:{port}");
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    let failure = loop {
        if !matches!(child.try_wait(), Ok(None)) {
            break "The local model server exited during startup.";
        }
        if Instant::now() > deadline {
            break "The local model server did not become ready in time.";
        }
        let health = LOOPBACK
            .get(format!("{base_url}/health"))
            .timeout(Duration::from_secs(2))
            .send()
            .await;
        if health.is_ok_and(|r| r.status().is_success()) {
            let (backend, using_gpu, layers_offloaded) = parse_server_log(&lock(&startup).all());
            return Ok(Running {
                child: Mutex::new(Some(child)),
                api_key,
                info: ServerInfo {
                    catalog_id: e.id.into(),
                    base_url,
                    backend,
                    using_gpu,
                    layers_offloaded,
                    note: None,
                },
                last_used: Mutex::new(Instant::now()),
            });
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    };
    kill(child);
    let mut lines = lock(&startup).all();
    lines.extend(lock(&log).all());
    let hint = explain_start_failure(&lines);
    // An incompatible build/model fails the same way on the CPU, so don't retry there.
    Err(LaunchError {
        msg: hint.unwrap_or(failure).into(),
        no_retry: hint.is_some_and(|h| !h.contains("memory")),
    })
}

/// Ask the freshly started server a tiny question; a build without the route answers 404.
async fn probe_route(r: &Running) -> Result<(), String> {
    let res = LOOPBACK
        .post(format!("{}/v1/systemone", r.info.base_url))
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {}", r.api_key))
        .body(r#"{"state":"ok","questions":{"q":{"type":"noul","instructions":"Is this text?"}}}"#)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| crate::webfetch::cause(&e))?;
    match res.status().as_u16() {
        200..=299 => Ok(()),
        404 | 405 => Err("This llama.cpp build has no System One route (/v1/systemone). Install a newer runtime.".into()),
        501 => Err("This model is not a decision model for this llama.cpp build.".into()),
        s => Err(format!("The local model server rejected the self-test ({s}).")),
    }
}

/// The running server's info, with its idle clock reset; prunes a server that exited.
fn running(id: &str) -> Option<Arc<Running>> {
    let mut s = state();
    let r = s.servers.get(id)?.clone();
    if !r.alive() {
        s.servers.remove(id);
        return None;
    }
    *lock(&r.last_used) = Instant::now();
    Some(r)
}

#[cfg(unix)]
fn is_root() -> bool {
    // SAFETY: getuid(2) cannot fail and has no preconditions.
    unsafe { libc::getuid() == 0 }
}

#[cfg(not(unix))]
fn is_root() -> bool {
    false
}

async fn start_locked(dir: &Path, e: &'static Entry) -> Result<Arc<Running>, String> {
    if let Some(r) = running(e.id) {
        return Ok(r);
    }
    if is_root() {
        return Err("Refusing to run a model server as root.".into());
    }
    if !installed(dir).iter().any(|m| m.catalog_id == e.id) {
        return Err("The model is not downloaded yet.".into());
    }
    let bin = runtime(dir)
        .await
        .path
        .ok_or("No llama.cpp runtime is installed.")?;
    let bin = PathBuf::from(bin);
    // GPU init can fail on odd drivers or run out of VRAM: try once more on the CPU and say so.
    let mut run = match launch(&bin, dir, e, true).await {
        Ok(r) => r,
        Err(f) if f.no_retry => return Err(f.msg),
        Err(f) => {
            let mut r = launch(&bin, dir, e, false).await.map_err(|f| f.msg)?;
            r.info.note = Some(format!("GPU start failed ({}); running on the CPU.", f.msg));
            r
        }
    };
    run.last_used = Mutex::new(Instant::now());
    let run = Arc::new(run);
    state().servers.insert(e.id, run.clone());
    if let Err(m) = probe_route(&run).await {
        stop(e.id);
        return Err(m);
    }
    *lock(&run.last_used) = Instant::now();
    IDLE.call_once(|| {
        tauri::async_runtime::spawn(async {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let idle: Vec<&str> = state()
                    .servers
                    .iter()
                    .filter(|(_, r)| lock(&r.last_used).elapsed() > IDLE_STOP)
                    .map(|(id, _)| *id)
                    .collect();
                idle.into_iter().for_each(stop);
            }
        });
    });
    Ok(run)
}

async fn start(dir: &Path, id: &str) -> Result<Arc<Running>, String> {
    let e = require_available(id)?;
    if let Some(r) = running(e.id) {
        return Ok(r);
    }
    state().starting.insert(e.id);
    let r = {
        let _one = START.lock().await;
        start_locked(dir, e).await
    };
    state().starting.remove(e.id);
    r
}

fn stop(id: &str) {
    let r = state().servers.remove(id);
    if let Some(child) = r.and_then(|r| lock(&r.child).take()) {
        kill(child);
    }
}

/// On app exit: kill every server's process tree now.
pub fn stop_all() {
    let servers: Vec<_> = state().servers.drain().map(|(_, r)| r).collect();
    for r in servers {
        if let Some(mut c) = lock(&r.child).take() {
            terminate(&c, true);
            let _ = c.wait();
        }
    }
}

fn status() -> Vec<ServerStatus> {
    let ids: Vec<&'static str> = state().servers.keys().copied().collect();
    let mut out: Vec<ServerStatus> = ids
        .into_iter()
        .filter_map(|id| {
            let r = state().servers.get(id)?.clone();
            if !r.alive() {
                state().servers.remove(id);
                return None;
            }
            Some(ServerStatus {
                catalog_id: id.into(),
                state: "running",
                info: Some(r.info.clone()),
            })
        })
        .collect();
    let s = state();
    out.extend(
        s.starting
            .iter()
            .filter(|id| !s.servers.contains_key(*id))
            .map(|id| ServerStatus {
                catalog_id: (*id).into(),
                state: "starting",
                info: None,
            }),
    );
    out
}

/// For `llm_call`: lazily start the model and hand out its origin and per-session API key.
pub async fn endpoint(dir: &Path, catalog_id: &str) -> Result<(String, String), String> {
    let r = start(dir, catalog_id).await?;
    Ok((r.info.base_url.clone(), r.api_key.clone()))
}

// ---- commands -------------------------------------------------------------------------

fn emitter(app: &tauri::AppHandle) -> impl Fn(Progress) + Send + Sync + '_ {
    move |p| {
        let _ = app.emit("local:progress", p);
    }
}

#[tauri::command]
pub async fn local_runtime(app: tauri::AppHandle) -> Result<RuntimeStatus, String> {
    Ok(runtime(&data_dir(&app)?).await)
}

#[tauri::command]
pub async fn local_runtime_plan(app: tauri::AppHandle) -> Result<RuntimePlan, String> {
    runtime_plan(&data_dir(&app)?).await
}

#[tauri::command]
pub async fn local_runtime_install(app: tauri::AppHandle) -> Result<RuntimeStatus, String> {
    runtime_install(&data_dir(&app)?, &emitter(&app)).await
}

#[tauri::command]
pub async fn local_model_plan(app: tauri::AppHandle, id: String) -> Result<ModelPlan, String> {
    model_plan(&data_dir(&app)?, id_of(&id)?).await
}

#[tauri::command]
pub async fn local_model_install(
    app: tauri::AppHandle,
    id: String,
) -> Result<InstalledModel, String> {
    model_install(&data_dir(&app)?, id_of(&id)?, &emitter(&app)).await
}

#[tauri::command]
pub async fn local_cancel(id: String) -> Result<(), String> {
    let id = if id == "runtime" {
        "runtime"
    } else {
        id_of(&id)?
    };
    net::abort(&format!("local:{id}"));
    Ok(())
}

#[tauri::command]
pub async fn local_installed(app: tauri::AppHandle) -> Result<Vec<InstalledModel>, String> {
    Ok(installed(&data_dir(&app)?))
}

#[tauri::command]
pub async fn local_remove(
    app: tauri::AppHandle,
    id: String,
) -> Result<Vec<InstalledModel>, String> {
    remove(&data_dir(&app)?, &id)
}

#[tauri::command]
pub async fn local_start(app: tauri::AppHandle, id: String) -> Result<ServerInfo, String> {
    Ok(start(&data_dir(&app)?, id_of(&id)?).await?.info.clone())
}

#[tauri::command]
pub async fn local_stop(id: String) -> Result<(), String> {
    stop(id_of(&id)?);
    Ok(())
}

#[tauri::command]
pub async fn local_status() -> Vec<ServerStatus> {
    status()
}

#[tauri::command]
pub async fn local_logs(id: String) -> Result<Vec<String>, String> {
    let id = id_of(&id)?;
    Ok(state()
        .logs
        .get(id)
        .map(|l| lock(l).all())
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::mock::{response, serve};

    const TAG: &str = "b11349";

    fn assets() -> Vec<GhAsset> {
        [
            "macos-arm64.tar.gz",
            "macos-x64.tar.gz",
            "ubuntu-x64.tar.gz",
            "ubuntu-vulkan-x64.tar.gz",
            "ubuntu-arm64.tar.gz",
            "win-cpu-x64.zip",
            "win-cpu-arm64.zip",
            "win-vulkan-x64.zip",
            "win-cuda-12.4-x64.zip",
            "win-cuda-13.4-x64.zip",
        ]
        .map(|n| GhAsset {
            name: format!("llama-{TAG}-bin-{n}"),
            size: 1,
            digest: Some(format!("sha256:{}", "a".repeat(64))),
            browser_download_url: format!("https://github.com/x/{n}"),
        })
        .to_vec()
    }

    fn pick(platform: &str, arch: &str, backend: &str) -> Option<(String, &'static str)> {
        let a = assets();
        select_asset(&a, TAG, platform, arch, backend).map(|(x, b)| (x.name.clone(), b))
    }

    #[test]
    fn select_asset_per_platform() {
        let name = |p, a, b| pick(p, a, b).unwrap().0;
        assert_eq!(
            name("darwin", "arm64", "metal"),
            format!("llama-{TAG}-bin-macos-arm64.tar.gz")
        );
        assert_eq!(
            name("darwin", "x64", "cpu"),
            format!("llama-{TAG}-bin-macos-x64.tar.gz")
        );
        // Windows prefers Vulkan over CUDA, else CPU.
        assert_eq!(pick("win32", "x64", "cuda").unwrap().1, "vulkan");
        assert!(name("win32", "x64", "vulkan").contains("win-vulkan-x64"));
        assert!(name("win32", "x64", "cpu").contains("win-cpu-x64"));
        assert!(name("win32", "arm64", "vulkan").contains("win-cpu-arm64"));
        assert!(name("linux", "x64", "vulkan").contains("ubuntu-vulkan-x64"));
        assert!(name("linux", "x64", "cpu").contains("ubuntu-x64"));
        assert_eq!(pick("linux", "arm64", "vulkan").unwrap().1, "cpu");
        assert_eq!(pick("freebsd", "x64", "cpu"), None);
        assert_eq!(pick("linux", "ia32", "cpu"), None);
        assert!(select_asset(&[], TAG, "darwin", "arm64", "metal").is_none());
    }

    #[test]
    fn digests_and_tags() {
        assert_eq!(
            parse_digest(Some(&format!("sha256:{}", "AB".repeat(32)))),
            Some("ab".repeat(32))
        );
        for v in [
            "",
            "sha1:abc",
            &format!("sha256:{}", "a".repeat(63)),
            &"a".repeat(64),
        ] {
            assert_eq!(parse_digest(Some(v)), None, "{v}");
        }
        assert_eq!(parse_digest(None), None);
        let tree = json!([
            { "type": "file", "path": "README.md", "size": 5 },
            { "type": "file", "path": "m.gguf", "size": 134, "lfs": { "oid": "c0".repeat(32), "size": 99 } },
        ]);
        assert_eq!(parse_hf_file(&tree, "m.gguf"), Some((99, "c0".repeat(32))));
        assert_eq!(parse_hf_file(&tree, "README.md"), None);
        assert_eq!(parse_hf_file(&tree, "nope"), None);
        assert_eq!(parse_hf_file(&json!({}), "m.gguf"), None);
        assert!(is_release_tag("b11349"));
        for v in ["../b1", "v0.5.0", "b", "b1/2", "b12345678"] {
            assert!(!is_release_tag(v), "{v}");
        }
    }

    #[test]
    fn resume_math() {
        assert_eq!(resume_offset(100, 1000), 100);
        assert_eq!(resume_offset(1000, 1000), 1000);
        assert_eq!(resume_offset(0, 1000), 0);
        assert_eq!(resume_offset(1001, 1000), 0);
        assert!(content_range_starts_at(Some("bytes 100-999/1000"), 100));
        assert!(content_range_starts_at(Some("bytes 100-999/*"), 100));
        assert!(!content_range_starts_at(Some("bytes 0-999/1000"), 100));
        assert!(!content_range_starts_at(None, 100));
    }

    #[test]
    fn download_hosts() {
        for u in [
            "https://github.com/ggml-org/llama.cpp/releases/download/b1/x.zip",
            "https://api.github.com/repos/a/b",
            "https://release-assets.githubusercontent.com/x",
            "https://objects.githubusercontent.com/x",
            "https://github.com:443/x",
        ] {
            assert!(github(u), "{u}");
        }
        for u in [
            "https://huggingface.co/a/b",
            "https://cdn-lfs.huggingface.co/x",
            "https://cas-bridge.xethub.hf.co/x",
        ] {
            assert!(huggingface(u), "{u}");
        }
        for (k, u) in [
            (Host::Github, "http://github.com/x"),
            (Host::Github, "https://evilgithub.com/x"),
            (Host::Github, "https://github.com.evil.io/x"),
            (Host::Github, "https://huggingface.co/x"),
            (Host::HuggingFace, "https://github.com/x"),
            (Host::HuggingFace, "https://nothf.co/x"),
            (Host::Github, "https://user:pw@github.com/x"),
            (Host::Github, "https://github.com:8443/x"),
            (Host::Github, "file:///etc/passwd"),
            (Host::Github, "not a url"),
        ] {
            assert!(!allowed_download_url(k, u), "{u}");
        }
    }

    #[test]
    fn server_flags_and_logs() {
        let m = Path::new("/m/x.gguf");
        let a = build_server_args(m, 5555, 2048, true, "k").join(" ");
        assert_eq!(a, "-m /m/x.gguf --host 127.0.0.1 --port 5555 -c 2048 -b 2048 -ub 2048 -np 1 -ngl 99 --no-webui --api-key k -lv 4");
        assert!(build_server_args(m, 5555, 2048, false, "k")
            .join(" ")
            .contains("-dev none -ngl 0"));

        let gpu: Vec<String> = [
            "0.00.116.899 I llama_prepare_model_devices: using device MTL0 (Apple M3 Pro) (unknown id) - 13639 MiB free",
            "0.00.228.851 I load_tensors: offloaded 31/31 layers to GPU",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(parse_server_log(&gpu), ("metal", true, Some(31)));
        let swap = |d: &str| gpu.iter().map(|l| l.replace("MTL0", d)).collect::<Vec<_>>();
        assert_eq!(parse_server_log(&swap("CUDA0")).0, "cuda");
        assert_eq!(parse_server_log(&swap("Vulkan0")).0, "vulkan");
        assert_eq!(parse_server_log(&swap("SYCL0")), ("cpu", false, Some(31)));
        let cpu = [
            "using device MTL0 (Apple M3 Pro)",
            "load_tensors: offloaded 0/31 layers to GPU",
        ]
        .map(String::from);
        assert_eq!(parse_server_log(&cpu), ("cpu", false, Some(0)));
        assert_eq!(parse_server_log(&[]), ("cpu", false, None));

        let explain = |l: &str| explain_start_failure(&[l.to_string()]);
        assert!(
            explain("error loading model: unknown model architecture: 'ggmlc'")
                .unwrap()
                .contains("cannot load")
        );
        assert!(explain("check_tensor_dims: tensor x has wrong shape")
            .unwrap()
            .contains("cannot load"));
        assert!(explain("ggml_vulkan: ErrorOutOfDeviceMemory")
            .unwrap()
            .contains("memory"));
        assert_eq!(explain("something else"), None);

        assert_eq!(
            parse_version("version: 0.5.0-dev (build 11349, commit fb4b2737a)\nbuilt with")
                .as_deref(),
            Some("b11349")
        );
        assert_eq!(
            parse_version("version: 0.5.0-dev (build 0, commit unknown)").as_deref(),
            Some("0.5.0-dev")
        );
        assert_eq!(parse_version("garbage"), None);
    }

    #[test]
    fn ring_log_keeps_the_last_lines() {
        let mut r = RingLog::new(3);
        r.push("a\nb\nc");
        r.push("\r\nd\ne\nf\n");
        assert_eq!(r.all(), ["d", "e", "f"]);
        r.push("par");
        assert_eq!(r.all(), ["d", "e", "f", "par"]);
    }

    #[test]
    fn catalog_matches_the_renderer() {
        let ts = include_str!("../../src/llm/localCatalog.ts");
        for e in &CATALOG {
            for s in [e.id, e.hf_repo, e.license] {
                assert!(
                    ts.contains(&format!("'{s}'")),
                    "{s} missing in localCatalog.ts"
                );
            }
            assert!(
                ts.contains(&format!("hfFile: '{}'", e.hf_file)),
                "{}",
                e.hf_file
            );
            assert!(ts.contains(&format!("contextTokens: {}", e.context_tokens)));
            let status = if e.planned.is_some() {
                "planned"
            } else {
                "available"
            };
            assert!(ts.contains(&format!("status: '{status}'")));
        }
        assert!(ts.contains(COMMUNITY) && ts.contains(CLEF));
        assert_eq!(id_of("../x"), Err("Unknown local model.".into()));
        assert_eq!(require_available("clef").err().as_deref(), Some(CLEF));
        assert!(require_available("laya-en-q8").is_ok());
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sailor-local-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn client() -> Client {
        net::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .unwrap()
    }

    fn sha(bytes: &[u8]) -> String {
        hex(ring::digest::digest(&ring::digest::SHA256, bytes).as_ref())
    }

    fn any(_: &str) -> bool {
        true
    }

    fn not_evil(u: &str) -> bool {
        !u.contains("/evil")
    }

    async fn fetch(
        id: &str,
        allow: Allow,
        url: &str,
        partial: &Path,
        body: &[u8],
    ) -> (Result<(), String>, Vec<Progress>) {
        let seen = Mutex::new(Vec::new());
        let emit = |p| seen.lock().unwrap().push(p);
        let d = Download {
            id,
            kind: "model",
            allow,
            url,
            partial: partial.to_path_buf(),
            size: body.len() as u64,
            sha256: &sha(body),
        };
        let r = download_verified(&client(), d, &emit).await;
        (r, seen.into_inner().unwrap())
    }

    #[tokio::test]
    async fn download_verifies_resumes_and_refuses() {
        let body = b"0123456789";
        let raw = |head: &str, body: &str| {
            format!(
                "HTTP/1.1 {head}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            )
        };
        let srv = serve(vec![
            (
                "GET /f",
                response(200, "application/octet-stream", "0123456789"),
            ),
            ("GET /r", raw("302 X\r\nlocation: /f", "")),
            ("GET /to-evil", raw("302 X\r\nlocation: /evil", "")),
            (
                "GET /part",
                raw("206 X\r\ncontent-range: bytes 3-9/10", "3456789"),
            ),
            (
                "GET /bad",
                response(200, "application/octet-stream", "0123456780"),
            ),
        ]);
        let o = &srv.origin;
        let dir = temp_dir("dl");
        let partial = dir.join("sub").join("m.gguf.partial");

        let (r, seen) = fetch("t-full", any, &format!("{o}/r"), &partial, body).await;
        assert_eq!(r, Ok(()));
        assert_eq!(std::fs::read(&partial).unwrap(), body);
        let phases: Vec<_> = seen.iter().map(|p| (p.phase, p.completed)).collect();
        assert_eq!(phases.first(), Some(&("download", 10)));
        assert_eq!(phases.last(), Some(&("verify", 10)));

        std::fs::write(&partial, b"012").unwrap();
        let (r, _) = fetch("t-resume", any, &format!("{o}/part"), &partial, body).await;
        assert_eq!(r, Ok(()));
        assert_eq!(std::fs::read(&partial).unwrap(), body);
        assert!(srv
            .seen
            .lock()
            .unwrap()
            .iter()
            .any(|l| l.starts_with("GET /part")));

        // A server that ignores Range restarts the file.
        std::fs::write(&partial, b"xyz").unwrap();
        let (r, _) = fetch("t-restart", any, &format!("{o}/f"), &partial, body).await;
        assert_eq!(r, Ok(()));
        assert_eq!(std::fs::read(&partial).unwrap(), body);

        // A complete partial is only verified.
        let before = srv.seen.lock().unwrap().len();
        let (r, _) = fetch("t-done", any, &format!("{o}/f"), &partial, body).await;
        assert_eq!((r, srv.seen.lock().unwrap().len()), (Ok(()), before));

        std::fs::remove_file(&partial).unwrap();
        let (r, _) = fetch("t-bad", any, &format!("{o}/bad"), &partial, body).await;
        assert_eq!(
            r.unwrap_err(),
            "Downloaded file does not match its published SHA-256; it was discarded."
        );
        assert!(!partial.exists());

        let (r, _) = fetch("t-404", any, &format!("{o}/missing"), &partial, body).await;
        assert_eq!(r.unwrap_err(), "Download failed (404).");

        let host = o.trim_start_matches("http://");
        let (r, _) = fetch("t-hop", not_evil, &format!("{o}/to-evil"), &partial, body).await;
        assert_eq!(r.unwrap_err(), format!("Refusing to download from {host}."));
        let (r, _) = fetch("t-host", github, &format!("{o}/f"), &partial, body).await;
        assert_eq!(r.unwrap_err(), format!("Refusing to download from {host}."));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn download_can_be_cancelled() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/slow", listener.local_addr().unwrap());
        // Accept and never answer.
        std::thread::spawn(move || {
            let _held: Vec<_> = listener.incoming().take(1).collect();
            std::thread::sleep(Duration::from_secs(30));
        });
        let dir = temp_dir("cancel");
        let partial = dir.join("x.partial");
        let task =
            tokio::spawn(async move { fetch("laya-en-q8", any, &url, &partial, b"abc").await.0 });
        tokio::time::sleep(Duration::from_millis(200)).await;
        local_cancel("laya-en-q8".into()).await.unwrap();
        assert_eq!(task.await.unwrap(), Err(CANCELLED.into()));
        assert_eq!(
            local_cancel("../x".into()).await,
            Err("Unknown local model.".into())
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn installed_remove_and_runtime_lookup() {
        let dir = temp_dir("inst");
        let e = find_entry("laya-en-q8").unwrap();
        std::fs::create_dir_all(model_file(&dir, e).parent().unwrap()).unwrap();
        std::fs::write(model_file(&dir, e), b"gguf").unwrap();
        std::fs::create_dir_all(models_root(&dir).join("stranger")).unwrap();
        let want = InstalledModel {
            catalog_id: "laya-en-q8",
            file: "Laya-Q8_0.gguf",
            size_bytes: 4,
        };
        assert_eq!(installed(&dir), [want]);
        assert_eq!(remove(&dir, "laya-en-q8"), Ok(vec![]));
        assert_eq!(remove(&dir, "nope").unwrap_err(), "Unknown local model.");

        assert_eq!(
            start(&dir, "nope").await.err().unwrap(),
            "Unknown local model."
        );
        assert_eq!(start(&dir, "clef").await.err().unwrap(), CLEF);
        if !is_root() {
            assert_eq!(
                start(&dir, "laya-en-q8").await.err().unwrap(),
                "The model is not downloaded yet."
            );
        }
        assert!(model_install(&dir, "laya-en-q8", &|_| {})
            .await
            .unwrap_err()
            .contains("plan first"));

        if std::env::var_os("SAILOR_LLAMA_SERVER").is_none() {
            let root = runtime_root(&dir);
            std::fs::create_dir_all(root.join("b100")).unwrap();
            std::fs::write(root.join("b100").join(EXE), b"").unwrap();
            std::fs::create_dir_all(root.join("b200").join("build").join("bin")).unwrap();
            std::fs::write(root.join("b200").join("build").join("bin").join(EXE), b"").unwrap();
            std::fs::write(
                root.join("b200").join("manifest.json"),
                r#"{"includesSystemOne":true}"#,
            )
            .unwrap();
            std::fs::create_dir_all(root.join("b9999")).unwrap(); // no binary: skipped
            let rt = runtime(&dir).await;
            assert_eq!(
                (rt.source, rt.version.as_deref()),
                ("managed", Some("b200"))
            );
            assert_eq!(rt.supports_system_one, json!(true));
            assert!(rt.path.unwrap().ends_with(EXE));
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn terminate_reaches_the_whole_tree() {
        let args = ["-c".to_string(), "sleep 30 & echo $!; wait".to_string()];
        let mut child = spawn_server(Path::new("/bin/sh"), &args).unwrap();
        let mut out = child.stdout.take().unwrap();
        let mut buf = [0; 32];
        let n = out.read(&mut buf).unwrap();
        let grandchild: i32 = String::from_utf8_lossy(&buf[..n]).trim().parse().unwrap();
        terminate(&child, false);
        assert!(!child.wait().unwrap().success());
        // SAFETY: signal 0 only probes whether the pid still exists.
        let gone = (0..50).any(|_| {
            std::thread::sleep(Duration::from_millis(20));
            (unsafe { libc::kill(grandchild, 0) }) != 0
        });
        assert!(gone, "grandchild {grandchild} survived");
    }
}
