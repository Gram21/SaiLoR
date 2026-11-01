//! `ollama:*` and `localserver:discover` (electron/ollama.ts) with the response
//! parsers of src/llm/ollama.ts. The renderer names the server URL, so it is
//! checked here: http(s) only, no credentials, reduced to its origin. No API key
//! is ever attached.

use crate::net::{self, Flight};
use crate::webfetch::{is_blocked_hostname, is_blocked_ip};
use reqwest::{Client, Method};
use serde::Serialize;
use serde_json::{json, Value};
use std::net::IpAddr;
use std::sync::LazyLock;
use std::time::Duration;
use tauri::Emitter;
use url::{Host, Url};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// A pull that delivers nothing for this long is considered dead.
const PULL_IDLE: Duration = Duration::from_secs(120);
const REGISTRY: &str = "https://registry.ollama.ai";

/// Registry manifests may redirect to a CDN; this is the one client that follows.
static FOLLOW: LazyLock<Client> = LazyLock::new(|| net::builder().build().expect("http client"));

// ---- Parsers (src/llm/ollama.ts) ----

fn num(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite())
}

fn text(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

fn items<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v[key].as_array().map_or(&[], Vec::as_slice)
}

pub fn is_valid_model_tag(tag: &str) -> bool {
    let name_ok = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'/' | b'-'))
    };
    let ver_ok = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'))
    };
    let shape = match tag.split_once(':') {
        Some((n, v)) => name_ok(n) && ver_ok(v),
        None => name_ok(tag),
    };
    tag.len() <= 200 && shape && !tag.contains("..") && !tag.contains("//") && !tag.starts_with('/')
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModel {
    name: String,
    size_bytes: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parameter_size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quantization: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    family: Option<String>,
}

pub fn parse_tags(json: &Value) -> Vec<OllamaModel> {
    items(json, "models")
        .iter()
        .filter(|m| m.is_object())
        .filter_map(|m| {
            let d = &m["details"];
            Some(OllamaModel {
                name: text(&m["name"]).or_else(|| text(&m["model"]))?,
                size_bytes: num(&m["size"]).unwrap_or(0.0),
                digest: text(&m["digest"]),
                parameter_size: text(&d["parameter_size"]),
                quantization: text(&d["quantization_level"]),
                family: text(&d["family"]),
            })
        })
        .collect()
}

pub fn capabilities_of(show: &Value) -> Vec<String> {
    items(show, "capabilities")
        .iter()
        .filter_map(|c| c.as_str().map(str::to_string))
        .collect()
}

pub fn context_of(show: &Value) -> Option<f64> {
    let info = &show["model_info"];
    let arch = text(&info["general.architecture"])?;
    num(&info[format!("{arch}.context_length").as_str()]).filter(|n| *n > 0.0)
}

pub fn thinking_of(show: &Value) -> Value {
    let values: Vec<&str> = items(&show["thinking"], "values")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    if values.is_empty() {
        return Value::Null;
    }
    match text(&show["thinking"]["default"]) {
        Some(d) => json!({ "values": values, "default": d }),
        None => json!({ "values": values }),
    }
}

/// A per-layer array is read as its maximum: over-estimates.
fn num_or_max(v: &Value) -> Option<f64> {
    match v.as_array() {
        Some(a) => a.iter().filter_map(Value::as_f64).reduce(f64::max),
        None => num(v),
    }
}

/// KV-cache size at `num_ctx` (f16 K and V): 2 * layers * kv heads * head dim * 2 bytes * ctx.
pub fn estimate_kv_bytes(info: &Value, num_ctx: f64) -> Option<f64> {
    let arch = text(&info["general.architecture"])?;
    let key = |k: &str| &info[format!("{arch}.{k}").as_str()];
    let nonzero = |n: Option<f64>| n.filter(|x| *x != 0.0);
    let layers = nonzero(num(key("block_count")))?;
    let heads = num_or_max(key("attention.head_count"));
    let kv_heads = nonzero(num_or_max(key("attention.head_count_kv")).or(heads))?;
    let embed = num(key("embedding_length"));
    let head_dim = num(key("attention.key_length")).or(match (embed, heads) {
        (Some(e), Some(h)) if e != 0.0 && h != 0.0 => Some(e / h),
        _ => None,
    });
    let head_dim = nonzero(head_dim)?;
    Some((2.0 * layers * kv_heads * head_dim * 2.0 * num_ctx).ceil())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OllamaRunning {
    name: String,
    size_bytes: f64,
    size_vram: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_length: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
}

pub fn parse_ps(json: &Value) -> Vec<OllamaRunning> {
    items(json, "models")
        .iter()
        .filter(|m| m.is_object())
        .filter_map(|m| {
            Some(OllamaRunning {
                name: text(&m["name"]).or_else(|| text(&m["model"]))?,
                size_bytes: num(&m["size"]).unwrap_or(0.0),
                size_vram: num(&m["size_vram"]).unwrap_or(0.0),
                context_length: num(&m["context_length"]),
                expires_at: text(&m["expires_at"]),
            })
        })
        .collect()
}

/// One NDJSON line of `POST /api/pull`, as the `{...p}` object; None when not a status/error object.
pub fn parse_pull_line(line: &str) -> Option<serde_json::Map<String, Value>> {
    let j: Value = serde_json::from_str(line).ok()?;
    j.as_object()?;
    let error = text(&j["error"]);
    let status = text(&j["status"]);
    if status.is_none() && error.is_none() {
        return None;
    }
    let mut p = serde_json::Map::new();
    p.insert(
        "status".into(),
        json!(status.unwrap_or_else(|| "error".into())),
    );
    let fields = [
        ("digest", text(&j["digest"]).map(Value::from)),
        ("total", num(&j["total"]).map(Value::from)),
        ("completed", num(&j["completed"]).map(Value::from)),
        ("error", error.map(Value::from)),
    ];
    for (k, v) in fields {
        if let Some(v) = v {
            p.insert(k.into(), v);
        }
    }
    Some(p)
}

pub fn manifest_url(tag: &str) -> Option<String> {
    if !is_valid_model_tag(tag) {
        return None;
    }
    let (name, version) = tag.split_once(':').unwrap_or((tag, "latest"));
    let repo = if name.contains('/') {
        name.to_string()
    } else {
        format!("library/{name}")
    };
    Some(format!("{REGISTRY}/v2/{repo}/manifests/{version}"))
}

pub fn sum_manifest_bytes(json: &Value) -> Option<f64> {
    let layers = json["layers"].as_array().filter(|l| !l.is_empty())?;
    layers
        .iter()
        .map(|l| num(&l["size"]).filter(|s| *s >= 0.0))
        .sum()
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerModel {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size_bytes: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    loaded: Option<bool>,
}

/// LM Studio `GET /api/v1/models`; embedding models are dropped.
pub fn parse_lm_studio_models(json: &Value) -> Vec<LocalServerModel> {
    items(json, "models")
        .iter()
        .filter(|m| m.is_object() && m["type"] != "embedding")
        .filter_map(|m| {
            let loaded: Vec<&Value> = items(m, "loaded_instances")
                .iter()
                .filter(|i| i.is_object())
                .collect();
            let cfg = loaded.first().map_or(&Value::Null, |i| &i["config"]);
            Some(LocalServerModel {
                id: text(&m["key"])?,
                context_tokens: num(&cfg["context_length"])
                    .or_else(|| num(&m["max_context_length"])),
                size_bytes: num(&m["size_bytes"]),
                loaded: Some(!loaded.is_empty()),
            })
        })
        .collect()
}

pub fn parse_llama_cpp_props(json: &Value) -> Option<f64> {
    num(&json["default_generation_settings"]["n_ctx"])
}

/// `GET /v1/models` of llama.cpp (`meta.n_ctx_train`) or vLLM (`max_model_len`).
pub fn parse_open_ai_models_meta(json: &Value) -> (Vec<LocalServerModel>, bool) {
    let mut vllm = false;
    let models = items(json, "data")
        .iter()
        .filter(|m| m.is_object())
        .filter_map(|m| {
            let max_len = num(&m["max_model_len"]);
            vllm |= max_len.is_some();
            Some(LocalServerModel {
                id: text(&m["id"])?,
                context_tokens: max_len.or_else(|| num(&m["meta"]["n_ctx_train"])),
                size_bytes: num(&m["meta"]["size"]),
                loaded: None,
            })
        })
        .collect();
    (models, vllm)
}

// ---- Handlers (electron/ollama.ts) ----

/// Origin and `isLocal` of a renderer-supplied server URL.
pub fn check_base_url(raw: &str) -> Result<(String, bool), String> {
    let url = Url::parse(raw).map_err(|_| "Invalid server URL.".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("Unsupported URL scheme \"{}:\".", url.scheme()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URLs with embedded credentials are not allowed.".into());
    }
    let is_local = match url.host() {
        Some(Host::Domain(d)) => is_blocked_hostname(d),
        Some(Host::Ipv4(v4)) => is_blocked_ip(IpAddr::V4(v4)),
        Some(Host::Ipv6(v6)) => is_blocked_ip(IpAddr::V6(v6)),
        None => return Err("Invalid server URL.".into()),
    };
    // ponytail: the path is dropped, so a server behind a path-prefixed reverse proxy is unreachable here.
    Ok((url.origin().ascii_serialization(), is_local))
}

fn fail(error: impl Into<String>) -> Value {
    json!({ "ok": false, "error": error.into() })
}

fn unreachable(origin: &str) -> String {
    format!("Can't reach {origin}. Is the server running?")
}

async fn read_error(res: reqwest::Response) -> String {
    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();
    if let Some(e) = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|j| text(&j["error"]))
    {
        return format!("{e} (HTTP {status})");
    }
    if body.is_empty() {
        return format!("HTTP {status}");
    }
    format!(
        "HTTP {status}: {}",
        body.chars().take(200).collect::<String>()
    )
}

/// One JSON request with a timeout. The client refuses redirects.
async fn request(
    client: &Client,
    origin: &str,
    path: &str,
    method: Method,
    body: Option<Value>,
    limit: Duration,
) -> Result<Value, String> {
    let go = async {
        let mut req = client.request(method, format!("{origin}{path}"));
        if let Some(b) = body {
            req = req
                .header("content-type", "application/json")
                .body(b.to_string());
        }
        let res = req.send().await.map_err(|_| unreachable(origin))?;
        if !res.status().is_success() {
            return Err(read_error(res).await);
        }
        let t = res.text().await.map_err(|_| unreachable(origin))?;
        if t.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&t).map_err(|_| unreachable(origin))
    };
    tokio::time::timeout(limit, go)
        .await
        .unwrap_or_else(|_| Err(format!("Timed out waiting for {origin}.")))
}

/// Check the URL and the optional model tag before any request.
fn server(base_url: &str, model: Option<&str>) -> Result<(String, bool), Value> {
    let base = check_base_url(base_url).map_err(fail)?;
    if model.is_some_and(|m| !is_valid_model_tag(m)) {
        return Err(fail("Invalid model name."));
    }
    Ok(base)
}

macro_rules! try_ {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return e,
        }
    };
}

async fn get(client: &Client, origin: &str, path: &str) -> Result<Value, Value> {
    request(client, origin, path, Method::GET, None, REQUEST_TIMEOUT)
        .await
        .map_err(fail)
}

pub async fn version(client: &Client, base_url: &str) -> Value {
    let (origin, is_local) = try_!(server(base_url, None));
    let j = try_!(get(client, &origin, "/api/version").await);
    match j["version"].as_str() {
        Some(v) => json!({ "ok": true, "version": v, "isLocal": is_local }),
        None => fail("Not an Ollama server."),
    }
}

pub async fn list(client: &Client, base_url: &str) -> Value {
    let (origin, is_local) = try_!(server(base_url, None));
    let j = try_!(get(client, &origin, "/api/tags").await);
    json!({ "ok": true, "models": parse_tags(&j), "isLocal": is_local })
}

pub async fn show(client: &Client, base_url: &str, model: &str, num_ctx: Option<f64>) -> Value {
    let (origin, _) = try_!(server(base_url, Some(model)));
    let body = Some(json!({ "model": model }));
    let j = try_!(request(
        client,
        &origin,
        "/api/show",
        Method::POST,
        body,
        REQUEST_TIMEOUT
    )
    .await
    .map_err(fail));
    let ctx = num_ctx.filter(|n| n.fract() == 0.0 && *n > 0.0);
    json!({ "ok": true, "info": {
        "capabilities": capabilities_of(&j),
        "contextTokens": context_of(&j),
        "thinking": thinking_of(&j),
        "kvBytes": ctx.and_then(|c| estimate_kv_bytes(&j["model_info"], c)),
    }})
}

pub async fn ps(client: &Client, base_url: &str) -> Value {
    let (origin, _) = try_!(server(base_url, None));
    let j = try_!(get(client, &origin, "/api/ps").await);
    json!({ "ok": true, "running": parse_ps(&j) })
}

pub async fn delete(client: &Client, base_url: &str, model: &str) -> Value {
    let (origin, _) = try_!(server(base_url, Some(model)));
    let body = Some(json!({ "model": model }));
    try_!(request(
        client,
        &origin,
        "/api/delete",
        Method::DELETE,
        body,
        REQUEST_TIMEOUT
    )
    .await
    .map_err(fail));
    json!({ "ok": true })
}

pub async fn manifest_size_at(client: &Client, url: &str) -> Value {
    let go = async {
        let res = client
            .get(url)
            .header(
                "accept",
                "application/vnd.docker.distribution.manifest.v2+json",
            )
            .send()
            .await
            .map_err(|_| unreachable("registry.ollama.ai"))?;
        if res.status() == 404 {
            return Ok(json!({ "ok": true, "bytes": null }));
        }
        if !res.status().is_success() {
            return Err(read_error(res).await);
        }
        let bytes = res
            .bytes()
            .await
            .map_err(|_| unreachable("registry.ollama.ai"))?;
        let j: Value =
            serde_json::from_slice(&bytes).map_err(|_| unreachable("registry.ollama.ai"))?;
        Ok(json!({ "ok": true, "bytes": sum_manifest_bytes(&j) }))
    };
    match tokio::time::timeout(REQUEST_TIMEOUT, go).await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => fail(e),
        Err(_) => fail("Timed out waiting for registry.ollama.ai."),
    }
}

/// One pull step: a stall past PULL_IDLE stops the download.
async fn within_idle<T>(
    origin: &str,
    step: impl std::future::Future<Output = reqwest::Result<T>>,
) -> Result<T, String> {
    match tokio::time::timeout(PULL_IDLE, step).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(_)) => Err(unreachable(origin)),
        Err(_) => Err("Download stopped.".into()),
    }
}

pub async fn pull(
    client: &Client,
    request_id: &str,
    base_url: &str,
    model: &str,
    emit: impl Fn(Value),
) -> Value {
    let (origin, _) = try_!(server(base_url, Some(model)));
    if request_id.is_empty() {
        return fail("Missing request id.");
    }
    let flight = Flight::new(&format!("pull:{request_id}"));
    let stream = async {
        let send = client
            .post(format!("{origin}/api/pull"))
            .header("content-type", "application/json")
            .body(json!({ "model": model, "stream": true }).to_string())
            .send();
        let mut res = within_idle(&origin, send).await?;
        if !res.status().is_success() {
            return Err(read_error(res).await);
        }
        let mut buffer = Vec::new();
        let mut succeeded = false;
        while let Some(chunk) = within_idle(&origin, res.chunk()).await? {
            buffer.extend_from_slice(&chunk);
            let Some(end) = buffer.iter().rposition(|b| *b == b'\n') else {
                continue;
            };
            let lines: Vec<u8> = buffer.drain(..=end).collect();
            for line in String::from_utf8_lossy(&lines)
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
            {
                let Some(mut p) = parse_pull_line(line) else {
                    continue;
                };
                if let Some(e) = p.get("error").and_then(Value::as_str) {
                    return Err(e.to_string());
                }
                succeeded |= p["status"] == "success";
                p.insert("requestId".into(), json!(request_id));
                emit(Value::Object(p));
            }
        }
        if succeeded {
            Ok(json!({ "ok": true }))
        } else {
            Err("The download ended before it finished. Pull again to resume.".into())
        }
    };
    match flight
        .run(Duration::from_secs(365 * 24 * 3600), stream)
        .await
    {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => fail(e),
        Err(_) => fail("Download stopped."),
    }
}

pub async fn discover(client: &Client, base_url: &str) -> Value {
    let (origin, is_local) = try_!(server(base_url, None));
    let probe = |path: &'static str| {
        let origin = origin.clone();
        async move {
            request(client, &origin, path, Method::GET, None, PROBE_TIMEOUT)
                .await
                .unwrap_or(Value::Null)
        }
    };
    let found = |kind: &str, models: Vec<LocalServerModel>| json!({ "ok": true, "kind": kind, "models": models, "isLocal": is_local });

    if probe("/api/version").await["version"].is_string() {
        let running = parse_ps(&probe("/api/ps").await);
        let models = parse_tags(&probe("/api/tags").await)
            .into_iter()
            .map(|m| {
                let live = running.iter().find(|r| r.name == m.name);
                LocalServerModel {
                    id: m.name,
                    size_bytes: Some(m.size_bytes),
                    loaded: Some(live.is_some()),
                    context_tokens: live.and_then(|r| r.context_length),
                }
            })
            .collect();
        return found("ollama", models);
    }
    let lm = parse_lm_studio_models(&probe("/api/v1/models").await);
    if !lm.is_empty() {
        return found("lmstudio", lm);
    }
    let n_ctx = parse_llama_cpp_props(&probe("/props").await);
    let (models, vllm) = parse_open_ai_models_meta(&probe("/v1/models").await);
    if let Some(n) = n_ctx {
        let served = models
            .into_iter()
            .map(|m| LocalServerModel {
                context_tokens: Some(n),
                loaded: Some(true),
                ..m
            })
            .collect();
        return found("llamacpp", served);
    }
    if vllm {
        return found("vllm", models);
    }
    if !models.is_empty() {
        return found("unknown", models);
    }
    fail(format!("No local LLM server answered at {origin}."))
}

// ---- Commands ----

#[tauri::command]
pub async fn ollama_version(base_url: String) -> Result<Value, String> {
    Ok(version(&net::NO_REDIRECT, &base_url).await)
}

#[tauri::command]
pub async fn ollama_list(base_url: String) -> Result<Value, String> {
    Ok(list(&net::NO_REDIRECT, &base_url).await)
}

#[tauri::command]
pub async fn ollama_show(
    base_url: String,
    model: String,
    num_ctx: Option<f64>,
) -> Result<Value, String> {
    Ok(show(&net::NO_REDIRECT, &base_url, &model, num_ctx).await)
}

#[tauri::command]
pub async fn ollama_ps(base_url: String) -> Result<Value, String> {
    Ok(ps(&net::NO_REDIRECT, &base_url).await)
}

#[tauri::command]
pub async fn ollama_delete(base_url: String, model: String) -> Result<Value, String> {
    Ok(delete(&net::NO_REDIRECT, &base_url, &model).await)
}

#[tauri::command]
pub async fn ollama_manifest_size(model: String) -> Result<Value, String> {
    match manifest_url(&model) {
        Some(url) => Ok(manifest_size_at(&FOLLOW, &url).await),
        None => Ok(fail("Invalid model name.")),
    }
}

#[tauri::command]
pub async fn ollama_pull(
    app: tauri::AppHandle,
    request_id: String,
    base_url: String,
    model: String,
) -> Result<Value, String> {
    let emit = |p: Value| {
        let _ = app.emit("ollama:pullProgress", p);
    };
    Ok(pull(&net::NO_REDIRECT, &request_id, &base_url, &model, emit).await)
}

/// Closes the connection; the server may keep downloading, and pulling again resumes.
#[tauri::command]
pub async fn ollama_cancel_pull(request_id: String) {
    net::abort(&format!("pull:{request_id}"));
}

#[tauri::command]
pub async fn localserver_discover(base_url: String) -> Result<Value, String> {
    Ok(discover(&net::NO_REDIRECT, &base_url).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::mock::{response, serve};
    use std::sync::Mutex;

    fn client() -> Client {
        net::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .unwrap()
    }

    fn json_ok(v: Value) -> String {
        response(200, "application/json", &v.to_string())
    }

    #[test]
    fn base_urls() {
        assert_eq!(
            check_base_url("http://localhost:11434/api"),
            Ok(("http://localhost:11434".into(), true))
        );
        for h in [
            "http://127.0.0.1:1",
            "http://192.168.1.5:11434",
            "http://[::1]:1",
            "http://box.local:1",
        ] {
            assert_eq!(check_base_url(h).map(|b| b.1), Ok(true), "{h}");
        }
        for h in ["https://gpu.example.com", "http://8.8.8.8:1"] {
            assert_eq!(check_base_url(h).map(|b| b.1), Ok(false), "{h}");
        }
        for bad in [
            "file:///etc/passwd",
            "ftp://x",
            "http://u:p@localhost",
            "nonsense",
            "undefined",
        ] {
            assert!(check_base_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn model_tags() {
        for ok in ["qwen3.5:9b", "library/llama3", "hf.co/x/y:q4_k_m"] {
            assert!(is_valid_model_tag(ok), "{ok}");
        }
        for bad in [
            "../evil",
            "A B",
            "/x",
            "a//b",
            "a:b:c",
            "a:",
            "",
            &"a".repeat(201),
        ] {
            assert!(!is_valid_model_tag(bad), "{bad}");
        }
        assert_eq!(
            manifest_url("qwen3.5:9b").unwrap(),
            "https://registry.ollama.ai/v2/library/qwen3.5/manifests/9b"
        );
        assert_eq!(
            manifest_url("a/b").unwrap(),
            "https://registry.ollama.ai/v2/a/b/manifests/latest"
        );
    }

    #[test]
    fn parsers() {
        assert_eq!(
            sum_manifest_bytes(&json!({ "layers": [{ "size": 3 }, { "size": 4 }] })),
            Some(7.0)
        );
        assert_eq!(
            sum_manifest_bytes(&json!({ "layers": [{ "size": 3 }, {}] })),
            None
        );
        assert_eq!(sum_manifest_bytes(&json!({ "layers": [] })), None);
        let info = json!({ "general.architecture": "a", "a.block_count": 2, "a.attention.head_count": [4, 8], "a.embedding_length": 64 });
        assert_eq!(
            estimate_kv_bytes(&info, 10.0),
            Some(2.0 * 2.0 * 8.0 * 8.0 * 2.0 * 10.0)
        );
        assert_eq!(estimate_kv_bytes(&json!({}), 10.0), None);
        let p = parse_pull_line(r#"{"status":"pulling x","total":10}"#).unwrap();
        assert_eq!(
            Value::Object(p),
            json!({ "status": "pulling x", "total": 10.0 })
        );
        assert_eq!(
            parse_pull_line(r#"{"error":"x"}"#).unwrap()["status"],
            "error"
        );
        assert!(
            parse_pull_line("[1]").is_none()
                && parse_pull_line("{}").is_none()
                && parse_pull_line("x").is_none()
        );
        let t = json!({ "thinking": { "values": ["low", 3, "high"], "default": "low" } });
        assert_eq!(
            thinking_of(&t),
            json!({ "values": ["low", "high"], "default": "low" })
        );
        let lm = json!({ "models": [
            { "key": "m", "type": "llm", "max_context_length": 8192, "loaded_instances": [{ "config": { "context_length": 4096 } }] },
            { "key": "e", "type": "embedding" },
        ]});
        let lm = parse_lm_studio_models(&lm);
        assert_eq!(
            (lm.len(), lm[0].context_tokens, lm[0].loaded),
            (1, Some(4096.0), Some(true))
        );
    }

    #[tokio::test]
    async fn handlers() {
        let show_body = json!({ "capabilities": ["tools"], "model_info": {
            "general.architecture": "q", "q.context_length": 32768, "q.block_count": 2,
            "q.attention.head_count_kv": 1, "q.attention.key_length": 4 } });
        let s = serve(vec![
            (
                "GET /api/tags",
                json_ok(json!({ "models": [{ "name": "a:1", "size": 5 }] })),
            ),
            ("POST /api/show", json_ok(show_body)),
            (
                "GET /v2/library/q/manifests/9b",
                json_ok(json!({ "layers": [{ "size": 3 }, { "size": 4 }] })),
            ),
            (
                "GET /api/ps",
                response(500, "application/json", r#"{"error":"boom"}"#),
            ),
        ]);
        let c = client();
        let r = list(&c, &s.origin).await;
        assert_eq!(
            (
                r["ok"].as_bool(),
                r["isLocal"].as_bool(),
                &r["models"][0]["name"]
            ),
            (Some(true), Some(true), &json!("a:1"))
        );
        let r = show(&c, &s.origin, "q:1", Some(10.0)).await;
        assert_eq!(
            r["info"],
            json!({ "capabilities": ["tools"], "contextTokens": 32768.0, "thinking": null, "kvBytes": 320.0 })
        );
        assert_eq!(ps(&c, &s.origin).await, fail("boom (HTTP 500)"));
        assert_eq!(
            manifest_size_at(&c, &format!("{}/v2/library/q/manifests/9b", s.origin)).await,
            json!({ "ok": true, "bytes": 7.0 })
        );
        assert_eq!(
            manifest_size_at(&c, &format!("{}/v2/x", s.origin)).await,
            json!({ "ok": true, "bytes": null })
        );

        let before = s.seen.lock().unwrap().len();
        assert_eq!(show(&c, "file:///x", "a", None).await["ok"], false);
        assert_eq!(
            show(&c, &s.origin, "../evil", None).await,
            fail("Invalid model name.")
        );
        assert_eq!(
            delete(&c, &s.origin, "A B").await,
            fail("Invalid model name.")
        );
        assert_eq!(s.seen.lock().unwrap().len(), before);

        let closed = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let r = version(&c, &format!("http://{closed}")).await;
        assert!(
            r["error"].as_str().unwrap().starts_with("Can't reach"),
            "{r}"
        );
    }

    #[tokio::test]
    async fn pulls() {
        let ok = "{\"status\":\"pulling x\",\"digest\":\"d\",\"total\":10,\"completed\":5}\n{\"status\":\"success\"}\n";
        let s = serve(vec![(
            "POST /api/pull",
            response(200, "application/x-ndjson", ok),
        )]);
        let sent = Mutex::new(Vec::new());
        let r = pull(&client(), "r1", &s.origin, "a:1", |p| {
            sent.lock().unwrap().push(p)
        })
        .await;
        assert_eq!(r, json!({ "ok": true }));
        let sent = sent.into_inner().unwrap();
        assert_eq!(
            (
                sent.len(),
                &sent[0]["completed"],
                &sent[1]["status"],
                &sent[1]["requestId"]
            ),
            (2, &json!(5.0), &json!("success"), &json!("r1"))
        );
        assert!(s.seen.lock().unwrap()[0].contains(r#""stream":true"#));

        let cut = serve(vec![(
            "POST /api/pull",
            response(200, "application/x-ndjson", "{\"status\":\"pulling x\"}\n"),
        )]);
        assert_eq!(
            pull(&client(), "r2", &cut.origin, "a:1", |_| ()).await["ok"],
            false
        );
        let err = serve(vec![(
            "POST /api/pull",
            response(200, "application/x-ndjson", "{\"error\":\"disk full\"}\n"),
        )]);
        assert_eq!(
            pull(&client(), "r3", &err.origin, "a:1", |_| ()).await,
            fail("disk full")
        );
        assert_eq!(
            pull(&client(), "", &err.origin, "a:1", |_| ()).await,
            fail("Missing request id.")
        );
    }

    #[tokio::test]
    async fn discovers() {
        let c = client();
        let ollama = serve(vec![
            ("GET /api/version", json_ok(json!({ "version": "0.35.0" }))),
            (
                "GET /api/tags",
                json_ok(
                    json!({ "models": [{ "name": "a:1", "size": 5 }, { "name": "b:1", "size": 6 }] }),
                ),
            ),
            (
                "GET /api/ps",
                json_ok(
                    json!({ "models": [{ "name": "a:1", "size": 5, "size_vram": 5, "context_length": 4096 }] }),
                ),
            ),
        ]);
        let r = discover(&c, &ollama.origin).await;
        assert_eq!(
            (&r["kind"], r["isLocal"].as_bool()),
            (&json!("ollama"), Some(true))
        );
        assert_eq!(
            r["models"],
            json!([
                { "id": "a:1", "sizeBytes": 5.0, "loaded": true, "contextTokens": 4096.0 },
                { "id": "b:1", "sizeBytes": 6.0, "loaded": false },
            ])
        );

        let lm = serve(vec![(
            "GET /api/v1/models",
            json_ok(
                json!({ "models": [{ "key": "m", "type": "llm", "max_context_length": 8192 }] }),
            ),
        )]);
        assert_eq!(discover(&c, &lm.origin).await["kind"], "lmstudio");
        let llama = serve(vec![
            (
                "GET /props",
                json_ok(json!({ "default_generation_settings": { "n_ctx": 4096 } })),
            ),
            (
                "GET /v1/models",
                json_ok(json!({ "data": [{ "id": "g.gguf", "meta": { "n_ctx_train": 32768 } }] })),
            ),
        ]);
        let r = discover(&c, &format!("{}/v1", llama.origin)).await;
        assert_eq!(
            (&r["kind"], &r["models"][0]["contextTokens"]),
            (&json!("llamacpp"), &json!(4096.0))
        );
        let vllm = serve(vec![(
            "GET /v1/models",
            json_ok(json!({ "data": [{ "id": "m", "max_model_len": 16384 }] })),
        )]);
        assert_eq!(discover(&c, &vllm.origin).await["kind"], "vllm");
        let other = serve(vec![(
            "GET /v1/models",
            json_ok(json!({ "data": [{ "id": "m" }] })),
        )]);
        assert_eq!(discover(&c, &other.origin).await["kind"], "unknown");
        let none = serve(vec![]);
        assert_eq!(discover(&c, &none.origin).await["ok"], false);
    }
}
