//! `llm:*` (electron/main.ts, electron/llmConfig.ts): LLM targets and the outbound
//! call. The API key never reaches the renderer: it lives in the OS keychain
//! (`keyring`), and the renderer only writes the `{{apiKey}}` sentinel where it goes.
//!
//! The target list stays in `llm-config.json` in the Electron format. Entries are
//! kept as raw JSON, so unknown fields survive. A key saved here sets
//! `"keyring": true` on the entry; Electron's safeStorage `key` blob is left in
//! place but cannot be decrypted, so such keys must be entered once more.

use crate::authz::err;
use crate::net::{self, Flight};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use url::Url;

const API_KEY_SENTINEL: &str = "{{apiKey}}";
const LLM_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const KEYRING_SERVICE: &str = "SaiLoR";
const MARKER: &str = "keyring";

/// Serializes the read-modify-write of the config file across concurrent commands.
static FILE: Mutex<()> = Mutex::new(());

pub trait Keys: Sync {
    fn set(&self, id: &str, key: &str) -> Result<(), String>;
    fn get(&self, id: &str) -> Result<Option<String>, String>;
    fn delete(&self, id: &str) -> Result<(), String>;
}

struct Keyring;

fn entry(id: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("llm:{id}"))
}

impl Keys for Keyring {
    fn set(&self, id: &str, key: &str) -> Result<(), String> {
        entry(id).and_then(|e| e.set_password(key)).map_err(|e| {
            format!("This system provides no secure storage, so the API key cannot be saved. ({e})")
        })
    }

    fn get(&self, id: &str) -> Result<Option<String>, String> {
        match entry(id).and_then(|e| e.get_password()) {
            Ok(k) => Ok(Some(k)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!(
                "Could not read the API key from the system keychain: {e}"
            )),
        }
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        match entry(id).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!(
                "Could not remove the API key from the system keychain: {e}"
            )),
        }
    }
}

/// JavaScript truthiness, for `Boolean(config.noKey)`.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn valid_price(v: &Value) -> bool {
    v.as_f64().is_some_and(|n| n >= 0.0)
}

fn valid_positive_int(v: &Value) -> bool {
    v.as_f64().is_some_and(|n| n > 0.0 && n.fract() == 0.0)
}

fn valid_system_one_flavor(v: &Value) -> bool {
    v == "jev" || v == "cloudflare"
}

fn valid_account_id(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| s.len() == 32 && s.bytes().all(|b| matches!(b, b'a'..=b'f' | b'0'..=b'9')))
}

fn valid_managed(v: &Value) -> Option<Value> {
    let id = v.get("catalogId")?.as_str()?;
    let ok = (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'));
    ok.then(|| serde_json::json!({ "catalogId": id }))
}

pub fn build_call_headers(
    headers: &HashMap<String, String>,
    api_key: Option<&str>,
    no_key: bool,
) -> Result<HashMap<String, String>, String> {
    if let Some(key) = api_key {
        return Ok(headers
            .iter()
            .map(|(k, v)| (k.clone(), v.replace(API_KEY_SENTINEL, key)))
            .collect());
    }
    if !no_key {
        return Err("No API key is stored for this target.".into());
    }
    Ok(headers
        .iter()
        .filter(|(_, v)| !v.contains(API_KEY_SENTINEL))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect())
}

pub fn read_configs(path: &Path) -> Vec<Value> {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

fn write_configs(path: &Path, configs: &[Value]) -> Result<(), String> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    let text = serde_json::to_string_pretty(configs).map_err(err)?;
    let mut f = std::fs::File::create(path).map_err(err)?;
    #[cfg(unix)]
    f.set_permissions(std::os::unix::fs::PermissionsExt::from_mode(0o600))
        .map_err(err)?;
    f.write_all(text.as_bytes()).map_err(err)
}

fn has_key(c: &Value) -> bool {
    c[MARKER] == true
}

/// The renderer's view: no key, no marker, only `hasKey`.
pub fn public_configs(configs: &[Value]) -> Vec<Value> {
    configs
        .iter()
        .map(|c| {
            let key = has_key(c);
            let mut c = c.clone();
            if let Some(o) = c.as_object_mut() {
                o.remove("key");
                o.remove(MARKER);
                o.insert("hasKey".into(), Value::Bool(key));
            }
            c
        })
        .collect()
}

fn id_of(c: &Value) -> Option<&str> {
    c["id"].as_str()
}

pub fn save_config(
    path: &Path,
    keys: &dyn Keys,
    config: Value,
    api_key: Option<String>,
) -> Result<Vec<Value>, String> {
    let Value::Object(mut next) = config else {
        return Err("Invalid LLM target.".into());
    };
    let id = next
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Invalid LLM target.")?
        .to_string();
    for k in ["key", MARKER, "hasKey"] {
        next.remove(k);
    }
    type Check = fn(&Value) -> bool;
    let checks: [(&str, Check); 7] = [
        ("inputPrice", valid_price),
        ("outputPrice", valid_price),
        ("maxStateTokens", valid_positive_int),
        ("contextTokens", valid_positive_int),
        ("optionsBudgetTokens", valid_positive_int),
        ("systemOneFlavor", valid_system_one_flavor),
        ("accountId", valid_account_id),
    ];
    for (field, valid) in checks {
        if next.get(field).is_some_and(|v| !valid(v)) {
            next.remove(field);
        }
    }
    let managed = next.get("managed").and_then(valid_managed);
    let no_key = next.get("noKey").is_some_and(truthy) || managed.is_some();
    next.remove("managed");
    if let Some(m) = managed {
        next.insert("managed".into(), m);
    }
    next.insert("noKey".into(), Value::Bool(no_key));

    let _guard = FILE.lock().unwrap_or_else(|e| e.into_inner());
    let mut configs = read_configs(path);
    let existing = configs.iter().position(|c| id_of(c) == Some(id.as_str()));
    // An edit with a blank key field keeps the stored key: the user cannot read it back to retype it.
    let keep = |field: &str, next: &mut Map<String, Value>| {
        if let Some(v) = existing.and_then(|i| configs[i].get(field)) {
            next.insert(field.into(), v.clone());
        }
    };
    keep("key", &mut next);
    keep(MARKER, &mut next);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        keys.set(&id, &key)?;
        next.insert(MARKER.into(), Value::Bool(true));
    }
    match existing {
        Some(i) => configs[i] = Value::Object(next),
        None => configs.push(Value::Object(next)),
    }
    write_configs(path, &configs)?;
    Ok(public_configs(&configs))
}

pub fn delete_config(path: &Path, keys: &dyn Keys, id: &str) -> Result<Vec<Value>, String> {
    let _guard = FILE.lock().unwrap_or_else(|e| e.into_inner());
    let mut configs = read_configs(path);
    if configs.iter().any(|c| id_of(c) == Some(id) && has_key(c)) {
        keys.delete(id)?;
    }
    configs.retain(|c| id_of(c) != Some(id));
    write_configs(path, &configs)?;
    Ok(public_configs(&configs))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallRequest {
    config_id: String,
    url: String,
    headers: HashMap<String, String>,
    method: Option<String>,
    body: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CallResult {
    ok: bool,
    status: u16,
    body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_ms: Option<u64>,
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Hinnant's days_from_civil).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468
}

/// IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`) in ms since the epoch.
// ponytail: the obsolete RFC 850 and asctime forms that Date.parse also reads give no hint; add them if a provider sends them.
fn http_date_ms(s: &str) -> Option<i64> {
    let p: Vec<&str> = s.split_whitespace().collect();
    let [_, day, mon, year, time, "GMT"] = p.as_slice() else {
        return None;
    };
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let m = MONTHS.iter().position(|x| x == mon)? as i64 + 1;
    let hms: Vec<i64> = time
        .split(':')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    let [h, mi, se] = hms.as_slice() else {
        return None;
    };
    let days = days_from_civil(year.parse().ok()?, m, day.parse().ok()?);
    Some((days * 86400 + h * 3600 + mi * 60 + se) * 1000)
}

/// `Retry-After` in ms: delta-seconds or an HTTP-date, None when absent or unreadable.
pub fn parse_retry_after(header: Option<&str>, now_ms: i64) -> Option<u64> {
    let t = header?.trim();
    if !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()) {
        return t.parse::<u64>().ok().map(|s| s.saturating_mul(1000));
    }
    Some(http_date_ms(t)?.saturating_sub(now_ms).max(0) as u64)
}

fn origin(u: &Url) -> String {
    u.origin().ascii_serialization()
}

/// Where a managed call really goes: only the llama-server API paths, on the server we run.
fn managed_target_url(request: &Url, server_base: &str) -> Result<Url, String> {
    let p = request.path();
    if !(p.starts_with("/v1/") || p == "/health") {
        return Err(format!("Refusing to call {p} on the local model server."));
    }
    let tail = match request.query() {
        Some(q) => format!("{p}?{q}"),
        None => p.to_string(),
    };
    Url::parse(server_base)
        .and_then(|b| b.join(&tail))
        .map_err(|_| "Invalid URL".into())
}

pub async fn call(
    path: &Path,
    keys: &dyn Keys,
    client: &Client,
    request_id: &str,
    request: CallRequest,
) -> Result<CallResult, String> {
    let config = read_configs(path)
        .into_iter()
        .find(|c| id_of(c) == Some(request.config_id.as_str()))
        .ok_or("That LLM target no longer exists.")?;
    let no_key = truthy(&config["noKey"]);
    if !has_key(&config) && !no_key {
        return Err("No API key is stored for this target.".into());
    }
    // The renderer names the URL: pin it to the configured origin before the key goes anywhere.
    let target = Url::parse(&request.url).map_err(|_| "Invalid URL")?;
    let allowed =
        Url::parse(config["baseUrl"].as_str().unwrap_or("")).map_err(|_| "Invalid URL")?;
    if !["https", "http"].contains(&target.scheme()) || target.scheme() != allowed.scheme() {
        return Err(format!(
            "Refusing to send the API key over {}:.",
            target.scheme()
        ));
    }
    if origin(&target) != origin(&allowed) {
        return Err(format!(
            "Refusing to send the API key to {}.",
            origin(&target)
        ));
    }
    let api_key = if has_key(&config) {
        keys.get(&request.config_id)?
    } else {
        None
    };
    let mut headers = build_call_headers(&request.headers, api_key.as_deref(), no_key)?;
    // Managed local model: the stored base URL is only a placeholder the checks above pinned the
    // request to; the call goes to the server this app runs, with that server's per-session key.
    let (call_url, client) = match config["managed"]["catalogId"].as_str() {
        Some(id) => {
            let dir = path.parent().ok_or("Invalid URL")?;
            let (base, key) = crate::localruntime::endpoint(dir, id).await?;
            headers.insert("Authorization".into(), format!("Bearer {key}"));
            (
                managed_target_url(&target, &base)?,
                &*crate::localruntime::LOOPBACK,
            )
        }
        None => (target.clone(), client),
    };
    let mut map = HeaderMap::new();
    for (k, v) in &headers {
        map.insert(
            HeaderName::from_bytes(k.as_bytes()).map_err(err)?,
            HeaderValue::from_str(v).map_err(err)?,
        );
    }
    let method = request.method.as_deref().unwrap_or("POST");
    let mut req = client
        .request(
            Method::from_bytes(method.as_bytes()).map_err(err)?,
            call_url.as_str(),
        )
        .headers(map);
    if method != "GET" {
        if let Some(body) = request.body {
            req = req.body(body);
        }
    }
    let send = async {
        let res = req.send().await.map_err(|e| crate::webfetch::cause(&e))?;
        // Following a redirect would carry the key to an origin nobody checked.
        if res.status().is_redirection() {
            return Err(format!(
                "Refusing to follow a redirect from {}.",
                origin(&target)
            ));
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64);
        let retry_after_ms = parse_retry_after(
            res.headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok()),
            now,
        );
        let status = res.status();
        let bytes = res.bytes().await.map_err(|e| crate::webfetch::cause(&e))?;
        let body = String::from_utf8_lossy(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes))
            .into_owned();
        Ok(CallResult {
            ok: status.is_success(),
            status: status.as_u16(),
            body,
            retry_after_ms,
        })
    };
    let flight = Flight::new(&format!("llm:{request_id}"));
    flight
        .run(LLM_TIMEOUT, send)
        .await
        .unwrap_or_else(|_| Err("This operation was aborted".into()))
}

fn config_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .config_dir()
        .map_err(err)?
        .join("SaiLoR")
        .join("llm-config.json"))
}

#[tauri::command]
pub async fn llm_configs(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    Ok(public_configs(&read_configs(&config_file(&app)?)))
}

#[tauri::command]
pub async fn llm_save_config(
    app: tauri::AppHandle,
    config: Value,
    api_key: Option<String>,
) -> Result<Vec<Value>, String> {
    let path = config_file(&app)?;
    tokio::task::spawn_blocking(move || save_config(&path, &Keyring, config, api_key))
        .await
        .map_err(err)?
}

#[tauri::command]
pub async fn llm_delete_config(app: tauri::AppHandle, id: String) -> Result<Vec<Value>, String> {
    let path = config_file(&app)?;
    tokio::task::spawn_blocking(move || delete_config(&path, &Keyring, &id))
        .await
        .map_err(err)?
}

#[tauri::command]
pub async fn llm_call(
    app: tauri::AppHandle,
    request_id: String,
    request: CallRequest,
) -> Result<CallResult, String> {
    call(
        &config_file(&app)?,
        &Keyring,
        &net::NO_REDIRECT,
        &request_id,
        request,
    )
    .await
}

#[tauri::command]
pub async fn llm_abort(request_id: String) {
    net::abort(&format!("llm:{request_id}"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::mock::{response, serve};
    use serde_json::json;

    #[derive(Default)]
    struct Memory(Mutex<HashMap<String, String>>);

    impl Keys for Memory {
        fn set(&self, id: &str, key: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(id.into(), key.into());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(id).cloned())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sailor-llm-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("llm-config.json")
    }

    fn client() -> Client {
        net::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .unwrap()
    }

    fn headers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn request(config_id: &str, url: &str) -> CallRequest {
        CallRequest {
            config_id: config_id.into(),
            url: url.into(),
            headers: headers(&[
                ("x-api-key", "{{apiKey}}"),
                ("content-type", "application/json"),
            ]),
            method: None,
            body: Some("{}".into()),
        }
    }

    #[test]
    fn call_headers() {
        let h = headers(&[
            ("Authorization", "Bearer {{apiKey}}"),
            ("x", "{{apiKey}}{{apiKey}}"),
            ("y", "1"),
        ]);
        let with = build_call_headers(&h, Some("k"), false).unwrap();
        assert_eq!(
            (with["Authorization"].as_str(), with["x"].as_str()),
            ("Bearer k", "kk")
        );
        assert_eq!(
            build_call_headers(&h, None, false),
            Err("No API key is stored for this target.".into())
        );
        assert_eq!(
            build_call_headers(&h, None, true).unwrap(),
            headers(&[("y", "1")])
        );
    }

    #[test]
    fn retry_after() {
        assert_eq!(parse_retry_after(Some(" 12 "), 0), Some(12_000));
        assert_eq!(parse_retry_after(None, 0), None);
        assert_eq!(parse_retry_after(Some("soon"), 0), None);
        let at = http_date_ms("Sun, 06 Nov 1994 08:49:37 GMT").unwrap();
        assert_eq!(at, 784_111_777_000);
        assert_eq!(
            parse_retry_after(Some("Sun, 06 Nov 1994 08:49:37 GMT"), at - 5_000),
            Some(5_000)
        );
        assert_eq!(
            parse_retry_after(Some("Sun, 06 Nov 1994 08:49:37 GMT"), at + 5_000),
            Some(0)
        );
    }

    #[test]
    fn save_sanitizes_and_keeps_keys_out_of_the_file() {
        let path = temp_file("save");
        let keys = Memory::default();
        let legacy =
            json!([{ "id": "old", "baseUrl": "https://x", "key": "c2FmZQ==", "extra": 1 }]);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, legacy.to_string()).unwrap();

        let input = json!({ "id": "a", "baseUrl": "https://api.example.com", "inputPrice": -1, "outputPrice": 2.5,
            "maxStateTokens": 1.5, "contextTokens": 8192, "systemOneFlavor": "x", "accountId": "A".repeat(32),
            "managed": { "catalogId": "BAD" }, "noKey": 0, "key": "smuggled", "hasKey": true, "keyring": true });
        let out = save_config(&path, &keys, input, Some("sk-1".into())).unwrap();
        assert_eq!(
            out[0],
            json!({ "id": "old", "baseUrl": "https://x", "extra": 1, "hasKey": false })
        );
        assert_eq!(
            out[1],
            json!({ "id": "a", "baseUrl": "https://api.example.com", "outputPrice": 2.5,
            "contextTokens": 8192, "noKey": false, "hasKey": true })
        );
        let file = std::fs::read_to_string(&path).unwrap();
        assert!(!file.contains("sk-1") && !file.contains("smuggled") && file.contains("c2FmZQ=="));
        assert_eq!(keys.get("a").unwrap().as_deref(), Some("sk-1"));
        #[cfg(unix)]
        assert_eq!(
            std::os::unix::fs::PermissionsExt::mode(
                &std::fs::metadata(&path).unwrap().permissions()
            ) & 0o777,
            0o600
        );

        let edit = json!({ "id": "a", "baseUrl": "https://api.example.com", "managed": { "catalogId": "qwen-1.5b" } });
        let out = save_config(&path, &keys, edit, Some(String::new())).unwrap();
        assert_eq!(out[1]["hasKey"], true);
        assert_eq!(
            (&out[1]["noKey"], &out[1]["managed"]),
            (&json!(true), &json!({ "catalogId": "qwen-1.5b" }))
        );
        let out = save_config(
            &path,
            &keys,
            json!({ "id": "old", "baseUrl": "https://x" }),
            None,
        )
        .unwrap();
        assert!(
            std::fs::read_to_string(&path).unwrap().contains("c2FmZQ==")
                && out[0]["hasKey"] == false
        );

        assert_eq!(delete_config(&path, &keys, "a").unwrap().len(), 1);
        assert_eq!(keys.get("a").unwrap(), None);
        assert!(save_config(&path, &keys, json!({ "name": "no id" }), None).is_err());
    }

    #[tokio::test]
    async fn call_pins_the_origin_and_splices_the_key() {
        let path = temp_file("call");
        let keys = Memory::default();
        let s = serve(vec![
            ("POST /v1/chat", "HTTP/1.1 429 X\r\nretry-after: 3\r\ncontent-length: 4\r\nconnection: close\r\n\r\nslow".to_string()),
            ("GET /v1/models", response(200, "application/json", "\u{feff}{\"data\":[]}")),
            ("POST /moved", "HTTP/1.1 302 X\r\nlocation: https://evil.example/\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_string()),
        ]);
        let cfg = json!({ "id": "t", "baseUrl": format!("{}/v1", s.origin) });
        save_config(&path, &keys, cfg, Some("sk-9".into())).unwrap();
        let local = json!({ "id": "free", "baseUrl": s.origin, "noKey": true });
        save_config(&path, &keys, local, None).unwrap();
        save_config(
            &path,
            &keys,
            json!({ "id": "nokey", "baseUrl": s.origin }),
            None,
        )
        .unwrap();
        let c = client();

        let r = call(
            &path,
            &keys,
            &c,
            "1",
            request("t", &format!("{}/v1/chat", s.origin)),
        )
        .await
        .unwrap();
        assert_eq!(
            r,
            CallResult {
                ok: false,
                status: 429,
                body: "slow".into(),
                retry_after_ms: Some(3000)
            }
        );
        let mut get = request("free", &format!("{}/v1/models", s.origin));
        get.method = Some("GET".into());
        let r = call(&path, &keys, &c, "2", get).await.unwrap();
        assert_eq!((r.ok, r.body.as_str()), (true, "{\"data\":[]}"));
        let seen = s.seen.lock().unwrap().clone();
        assert_eq!(
            seen,
            vec![
                "POST /v1/chat {}".to_string(),
                "GET /v1/models ".to_string()
            ]
        );

        let refused = [
            (
                request("gone", &s.origin),
                "That LLM target no longer exists.".to_string(),
            ),
            (
                request("nokey", &s.origin),
                "No API key is stored for this target.".into(),
            ),
            (
                request("t", "https://evil.example/v1/chat"),
                "Refusing to send the API key over https:.".into(),
            ),
            (
                request("t", "http://evil.example/v1/chat"),
                "Refusing to send the API key to http://evil.example.".into(),
            ),
            (
                request("t", "file:///etc/passwd"),
                "Refusing to send the API key over file:.".into(),
            ),
            (
                request("t", &format!("{}/moved", s.origin)),
                format!("Refusing to follow a redirect from {}.", s.origin),
            ),
        ];
        for (req, want) in refused {
            assert_eq!(call(&path, &keys, &c, "3", req).await, Err(want));
        }
        assert_eq!(s.seen.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn managed_calls_go_to_the_local_server() {
        let base = "http://127.0.0.1:5555";
        let to = |u: &str| managed_target_url(&Url::parse(u).unwrap(), base).map(String::from);
        assert_eq!(
            to("http://127.0.0.1/v1/systemone?a=1").as_deref(),
            Ok("http://127.0.0.1:5555/v1/systemone?a=1")
        );
        assert_eq!(
            to("http://127.0.0.1/health").as_deref(),
            Ok("http://127.0.0.1:5555/health")
        );
        for u in ["http://127.0.0.1/props", "http://127.0.0.1/v1/../props"] {
            assert_eq!(
                to(u),
                Err("Refusing to call /props on the local model server.".into())
            );
        }

        let path = temp_file("managed");
        let keys = Memory::default();
        for (id, catalog) in [("m", "qwen-1.5b"), ("l", "laya-en-q8")] {
            let cfg = json!({ "id": id, "baseUrl": "http://127.0.0.1:1", "managed": { "catalogId": catalog } });
            save_config(&path, &keys, cfg, None).unwrap();
        }
        let c = client();
        let unknown = call(
            &path,
            &keys,
            &c,
            "m",
            request("m", "http://127.0.0.1:1/v1/x"),
        )
        .await;
        assert_eq!(unknown, Err("Unknown local model.".into()));
        let missing = call(
            &path,
            &keys,
            &c,
            "l",
            request("l", "http://127.0.0.1:1/v1/x"),
        )
        .await;
        assert!(missing.is_err_and(|e| e.contains("not downloaded") || e.contains("root")));
    }

    #[tokio::test]
    async fn call_can_be_aborted() {
        let path = temp_file("abort");
        let keys = Memory::default();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        save_config(
            &path,
            &keys,
            json!({ "id": "t", "baseUrl": base, "noKey": true }),
            None,
        )
        .unwrap();
        let c = client();
        let pending = call(
            &path,
            &keys,
            &c,
            "slow",
            request("t", &format!("{base}/hang")),
        );
        let abort = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            net::abort("llm:slow");
        };
        let (r, ()) = tokio::join!(pending, abort);
        assert_eq!(r, Err("This operation was aborted".into()));
        drop(listener);
    }
}
