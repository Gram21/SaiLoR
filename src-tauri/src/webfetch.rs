//! `web:fetch` / `web:abort` (electron/main.ts) and the SSRF guard (electron/webFetch.ts).
//! The URL comes from an LLM that may have read attacker-controlled text, so every
//! hop's host is checked, and the client's resolver refuses blocked addresses too:
//! that pins the checked answer and closes the DNS-rebinding gap Electron accepted.

use crate::net::{self, Flight};
use reqwest::Client;
use serde::Serialize;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::LazyLock;
use std::time::Duration;
use url::{Host, Url};

const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const ACCEPT: &str = "text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.1";

/// True if `address` (a literal IP) must not be reached; anything that is not an IP is refused.
#[cfg(test)]
pub fn is_blocked_address(address: &str) -> bool {
    address.parse::<IpAddr>().map_or(true, is_blocked_ip)
}

// [impl->req~llm-400~1]
pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_v4(v4),
        IpAddr::V6(v6) => is_blocked_v6(v6),
    }
}

fn is_blocked_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || a >= 224
}

fn is_blocked_v6(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() {
        return true;
    }
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_blocked_v4(v4);
    }
    let seg = ip.segments();
    // Embedded IPv4 forms: IPv4-compatible (::/96), NAT64 (64:ff9b::/96), 6to4 (2002::/16).
    if seg[..6] == [0; 6] {
        return is_blocked_v4(Ipv4Addr::new(
            (seg[6] >> 8) as u8,
            seg[6] as u8,
            (seg[7] >> 8) as u8,
            seg[7] as u8,
        ));
    }
    if seg[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return is_blocked_v4(Ipv4Addr::new(
            (seg[6] >> 8) as u8,
            seg[6] as u8,
            (seg[7] >> 8) as u8,
            seg[7] as u8,
        ));
    }
    if seg[0] == 0x2002 {
        return is_blocked_v4(Ipv4Addr::new(
            (seg[1] >> 8) as u8,
            seg[1] as u8,
            (seg[2] >> 8) as u8,
            seg[2] as u8,
        ));
    }
    // fe80::/10 link-local, fc00::/7 unique-local, ff00::/8 multicast.
    (seg[0] & 0xffc0) == 0xfe80 || (seg[0] & 0xfe00) == 0xfc00 || (seg[0] & 0xff00) == 0xff00
}

// [impl->req~llm-400~1]
/// Local/internal by name alone, before any DNS lookup.
pub fn is_blocked_hostname(hostname: &str) -> bool {
    let h = hostname.to_lowercase();
    h == "localhost"
        || [".localhost", ".local", ".internal"]
            .iter()
            .any(|s| h.ends_with(s))
}

// [impl->req~llm-400~1]
/// Scheme, credential and hostname checks that need no DNS lookup. Re-run on every hop.
/// Ok carries the hostname (an IP without brackets, or a domain to resolve).
pub fn validate_fetch_url(raw: &str) -> Result<Host<String>, String> {
    let url = Url::parse(raw).map_err(|_| "Invalid URL.".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("Unsupported URL scheme \"{}:\"", url.scheme()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URLs with embedded credentials are not allowed.".into());
    }
    let host = url.host().ok_or("Invalid URL.")?.to_owned();
    let (name, ip) = match &host {
        Host::Domain(d) => (d.clone(), None),
        Host::Ipv4(v4) => (v4.to_string(), Some(IpAddr::V4(*v4))),
        Host::Ipv6(v6) => (v6.to_string(), Some(IpAddr::V6(*v6))),
    };
    if is_blocked_hostname(&name) {
        return Err(format!("Refusing to fetch local/internal host \"{name}\"."));
    }
    if ip.is_some_and(is_blocked_ip) {
        return Err(format!(
            "Refusing to fetch local/internal address \"{name}\"."
        ));
    }
    Ok(host)
}

/// `checkPublicHost`: refuse unless every address the host names is public.
async fn check_public_host(raw: String) -> Result<(), String> {
    let Host::Domain(name) = validate_fetch_url(&raw)? else {
        return Ok(());
    };
    resolve_public(&name).await.map(|_| ())
}

// [impl->req~llm-400~1]
async fn resolve_public(name: &str) -> Result<Vec<SocketAddr>, String> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((name, 0))
        .await
        .map_err(|_| format!("Could not resolve host \"{name}\"."))?
        .collect();
    if addrs.is_empty() || addrs.iter().any(|a| is_blocked_ip(a.ip())) {
        return Err(format!("Refusing to fetch local/internal host \"{name}\"."));
    }
    Ok(addrs)
}

/// The resolver the request actually connects with: same rule as `check_public_host`.
struct PublicOnly;

impl reqwest::dns::Resolve for PublicOnly {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let name = name.as_str().to_string();
        Box::pin(async move {
            let addrs = resolve_public(&name).await?;
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

// [impl->req~llm-400~1]
static WEB: LazyLock<Client> = LazyLock::new(|| {
    net::builder()
        .redirect(reqwest::redirect::Policy::none())
        .dns_resolver(PublicOnly)
        .no_proxy()
        .build()
        .expect("http client")
});

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchResult {
    ok: bool,
    status: u16,
    url: String,
    content_type: String,
    body: String,
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn fail(url: &str, status: u16, error: String, content_type: &str) -> WebFetchResult {
    WebFetchResult {
        ok: false,
        status,
        url: url.into(),
        content_type: content_type.into(),
        body: String::new(),
        truncated: false,
        error: Some(error),
    }
}

fn is_textual(content_type: &str) -> bool {
    let t = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    t.starts_with("text/")
        || t.starts_with("application/json")
        || t.starts_with("application/xml")
        || t.starts_with("application/xhtml+xml")
        || t.strip_prefix("application/")
            .and_then(|r| r.get(1..))
            .is_some_and(|r| r.contains("+xml"))
}

fn charset(content_type: &str) -> &'static encoding_rs::Encoding {
    let lower = content_type.to_ascii_lowercase();
    lower
        .find("charset=")
        .map(|i| content_type[i + 8..].split(';').next().unwrap_or("").trim())
        .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8)
}

/// Innermost cause: the resolver's refusal or the OS error, not reqwest's wrapper text.
pub fn cause(e: &reqwest::Error) -> String {
    let mut msg = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        msg = s.to_string();
        src = s.source();
    }
    msg
}

async fn fetch_loop<C, F>(client: &Client, check: C, ua: &str, url: &mut String) -> WebFetchResult
where
    C: Fn(String) -> F,
    F: Future<Output = Result<(), String>>,
{
    for redirects in 0.. {
        if let Err(e) = check(url.clone()).await {
            return fail(url, 0, e, "");
        }
        let res = match client
            .get(url.as_str())
            .header("User-Agent", ua)
            .header("Accept", ACCEPT)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => return fail(url, 0, cause(&e), ""),
        };
        let status = res.status().as_u16();
        let header = |n: &str| {
            res.headers()
                .get(n)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        if let (300..=399, Some(location)) = (status, header("location")) {
            if redirects >= MAX_REDIRECTS {
                return fail(url, status, "Too many redirects.".into(), "");
            }
            match Url::parse(url).and_then(|base| base.join(&location)) {
                Ok(next) => *url = next.to_string(),
                Err(_) => return fail(url, status, "Invalid redirect location.".into(), ""),
            }
            continue;
        }
        let content_type = header("content-type").unwrap_or_default();
        if !is_textual(&content_type) {
            let e = format!("Unsupported content type \"{content_type}\".");
            return fail(url, status, e, &content_type);
        }
        let ok = res.status().is_success();
        let (bytes, truncated) = match read_capped(res, MAX_BYTES).await {
            Ok(b) => b,
            Err(e) => return fail(url, status, cause(&e), &content_type),
        };
        let (body, _) = charset(&content_type).decode_with_bom_removal(&bytes);
        return WebFetchResult {
            ok,
            status,
            url: url.clone(),
            content_type,
            body: body.into_owned(),
            truncated,
            error: None,
        };
    }
    unreachable!()
}

pub(crate) async fn read_capped(
    mut res: reqwest::Response,
    max: usize,
) -> Result<(Vec<u8>, bool), reqwest::Error> {
    let mut bytes = Vec::new();
    while let Some(chunk) = res.chunk().await? {
        let remaining = max - bytes.len();
        if chunk.len() > remaining {
            bytes.extend_from_slice(&chunk[..remaining]);
            return Ok((bytes, true));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((bytes, false))
}

async fn fetch_with<C, F>(
    client: &Client,
    check: C,
    ua: &str,
    request_id: &str,
    raw: String,
) -> WebFetchResult
where
    C: Fn(String) -> F,
    F: Future<Output = Result<(), String>>,
{
    let flight = Flight::new(request_id);
    let mut url = raw;
    let r = flight
        .run(TIMEOUT, fetch_loop(client, check, ua, &mut url))
        .await;
    r.unwrap_or_else(|_| fail(&url, 0, "This operation was aborted".into(), ""))
}

// [impl->req~llm-400~1]
#[tauri::command]
pub async fn web_fetch(
    app: tauri::AppHandle,
    request_id: String,
    url: String,
) -> Result<WebFetchResult, String> {
    let ua = format!(
        "SaiLoR/{} (literature review assistant)",
        app.package_info().version
    );
    Ok(fetch_with(&WEB, check_public_host, &ua, &request_id, url).await)
}

// [impl->req~llm-400~1]
#[tauri::command]
pub async fn web_abort(request_id: String) {
    net::abort(&request_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::mock::{response, serve};

    // [utest->req~llm-400~1]
    #[test]
    fn blocked_addresses() {
        for ip in [
            "127.0.0.1",
            "10.0.0.5",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.1.1",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "::1",
            "::",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:7f00:1",
            "::ffff:a9fe:a9fe",
            "fe81::1",
            "febf::1",
            "::127.0.0.1",
            "::a9fe:a9fe",
            "64:ff9b::a9fe:a9fe",
            "2002:7f00:1::1",
            "example.com",
        ] {
            assert!(is_blocked_address(ip), "{ip}");
        }
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "172.32.0.1",
            "172.15.255.255",
            "2606:4700:4700::1111",
            "::ffff:8.8.8.8",
            "64:ff9b::808:808",
            "2002:808:808::1",
            "fec0::1",
        ] {
            assert!(!is_blocked_address(ip), "{ip}");
        }
    }

    #[test]
    fn blocked_hostnames() {
        for h in [
            "localhost",
            "LOCALHOST",
            "foo.localhost",
            "printer.local",
            "db.internal",
        ] {
            assert!(is_blocked_hostname(h), "{h}");
        }
        assert!(!is_blocked_hostname("example.com"));
    }

    // [utest->req~llm-400~1]
    #[test]
    fn validate_urls() {
        for u in [
            "file:///etc/passwd",
            "ftp://example.com",
            "http://user:pass@example.com",
            "http://localhost/",
            "http://127.0.0.1/",
            "http://192.168.1.1/",
            "http://[::1]/",
            "not a url",
            "http://[::ffff:127.0.0.1]/",
            "http://0x7f.1/",
        ] {
            assert!(validate_fetch_url(u).is_err(), "{u}");
        }
        assert_eq!(
            validate_fetch_url("ftp://x").unwrap_err(),
            "Unsupported URL scheme \"ftp:\""
        );
        assert_eq!(
            validate_fetch_url("https://example.com/page").unwrap(),
            Host::Domain("example.com".to_string())
        );
    }

    // [utest->req~llm-400~1]
    #[test]
    fn content_types() {
        for t in [
            "text/html; charset=utf-8",
            "application/json",
            "application/atom+xml",
            "APPLICATION/XHTML+XML",
        ] {
            assert!(is_textual(t), "{t}");
        }
        for t in ["application/pdf", "image/png", "", "application/+xml"] {
            assert!(!is_textual(t), "{t}");
        }
        assert_eq!(
            charset("text/html; Charset=ISO-8859-1").name(),
            "windows-1252"
        );
        assert_eq!(charset("text/html; charset=\"bogus\"").name(), "UTF-8");
    }

    // [utest->req~llm-400~1]
    #[tokio::test]
    async fn fetches_ignore_proxy_settings() {
        const NAME: &str = "webfetch::tests::fetches_ignore_proxy_settings";
        if std::env::var_os("SAILOR_PROXY_CHILD").is_some() {
            let get = WEB.get("http://public.test/x").send();
            let _ = tokio::time::timeout(std::time::Duration::from_secs(10), get).await;
            return;
        }
        let s = serve(vec![(
            "GET http://public.test/x",
            response(200, "text/plain", "via proxy"),
        )]);
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([NAME, "--exact", "--test-threads=1"])
            .env("SAILOR_PROXY_CHILD", "1")
            .env("HTTP_PROXY", &s.origin)
            .env("http_proxy", &s.origin)
            .env("ALL_PROXY", &s.origin)
            .env_remove("NO_PROXY")
            .env_remove("no_proxy")
            .status()
            .unwrap();
        assert!(status.success());
        assert!(s.seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn resolver_refuses_localhost() {
        assert!(resolve_public("localhost").await.is_err());
        assert!(check_public_host("http://localhost/".into()).await.is_err());
    }

    fn client() -> Client {
        net::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .unwrap()
    }

    /// The mock lives on 127.0.0.1; let only that through, everything else goes through the real guard.
    async fn loopback_ok(u: String) -> Result<(), String> {
        if u.starts_with("http://127.0.0.1:") {
            return Ok(());
        }
        check_public_host(u).await
    }

    fn redirect(to: &str) -> String {
        format!("HTTP/1.1 302 Found\r\nlocation: {to}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
    }

    // [utest->req~llm-400~1]
    #[tokio::test]
    async fn redirects_are_rechecked() {
        let s = serve(vec![
            ("GET /a", redirect("/b")),
            (
                "GET /b",
                response(200, "text/plain; charset=utf-8", "hello"),
            ),
            ("GET /evil", redirect("http://localhost:1/")),
            ("GET /loop", redirect("/loop")),
            ("GET /bin", response(200, "application/pdf", "%PDF")),
        ]);
        let r = fetch_with(
            &client(),
            loopback_ok,
            "ua",
            "w1",
            format!("{}/a", s.origin),
        )
        .await;
        assert!(
            r.ok && r.body == "hello" && r.url.ends_with("/b") && !r.truncated,
            "{r:?}"
        );

        let r = fetch_with(
            &client(),
            loopback_ok,
            "ua",
            "w2",
            format!("{}/evil", s.origin),
        )
        .await;
        assert_eq!(
            r.error.as_deref(),
            Some("Refusing to fetch local/internal host \"localhost\".")
        );

        let r = fetch_with(
            &client(),
            loopback_ok,
            "ua",
            "w3",
            format!("{}/loop", s.origin),
        )
        .await;
        assert_eq!(
            (r.status, r.error.as_deref()),
            (302, Some("Too many redirects."))
        );

        let r = fetch_with(
            &client(),
            loopback_ok,
            "ua",
            "w4",
            format!("{}/bin", s.origin),
        )
        .await;
        assert_eq!(
            r.error.as_deref(),
            Some("Unsupported content type \"application/pdf\".")
        );
        assert_eq!(r.content_type, "application/pdf");
    }

    // [utest->req~llm-400~1]
    #[tokio::test]
    async fn body_is_capped() {
        let big = "x".repeat(MAX_BYTES + 10);
        let s = serve(vec![("GET /big", response(200, "text/plain", &big))]);
        let r = fetch_with(
            &client(),
            loopback_ok,
            "ua",
            "w5",
            format!("{}/big", s.origin),
        )
        .await;
        assert!(r.ok && r.truncated && r.body.len() == MAX_BYTES);
    }

    #[tokio::test]
    async fn literal_private_ip_is_refused_without_a_request() {
        let r = fetch_with(
            &client(),
            check_public_host,
            "ua",
            "w6",
            "http://127.0.0.1:9/".into(),
        )
        .await;
        assert_eq!(
            r.error.as_deref(),
            Some("Refusing to fetch local/internal address \"127.0.0.1\".")
        );
    }
}
