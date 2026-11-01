//! The `slr-file` scheme: PDFs from the open project's directory, with single
//! byte ranges so pdf.js can stream (`slr-file://localhost/pdf?path=<rel>`).

use crate::authz::Session;
use crate::pdf::resolve_project_path;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::ops::Range;
use std::sync::Mutex;
use tauri::http::{header, Method, Request, Response, StatusCode};

fn respond(status: StatusCode) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Accept-Ranges, Content-Range, Content-Length",
        )
}

fn text(status: StatusCode, body: &str) -> Response<Vec<u8>> {
    respond(status).body(body.as_bytes().to_vec()).unwrap()
}

/// One satisfiable `bytes=` range of a `len`-byte file. `None` = serve it whole
/// (absent, malformed, multi-range or another unit); `Some(Err)` = 416.
fn parse_range(value: &str, len: u64) -> Option<Result<Range<u64>, ()>> {
    let spec = value.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (a, b) = spec.trim().split_once('-')?;
    let num = |s: &str| s.trim().parse::<u64>().ok();
    let range = match (a.trim().is_empty(), b.trim().is_empty()) {
        (true, false) => {
            let n = num(b)?;
            len.saturating_sub(n)..len
        }
        (false, true) => num(a)?..len,
        (false, false) => {
            let (a, b) = (num(a)?, num(b)?);
            if b < a {
                return None;
            }
            a..b.saturating_add(1).min(len)
        }
        (true, true) => return None,
    };
    Some(if range.start < len && !range.is_empty() {
        Ok(range)
    } else {
        Err(())
    })
}

pub fn serve(session: &Mutex<Session>, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if req.method() == Method::OPTIONS {
        return respond(StatusCode::NO_CONTENT)
            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range")
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
            .body(vec![])
            .unwrap();
    }
    let rel = form_urlencoded::parse(req.uri().query().unwrap_or("").as_bytes())
        .find(|(k, _)| k == "path")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    let real = match resolve_project_path(session, &rel) {
        Ok(real) => real,
        Err("escapes") => return text(StatusCode::FORBIDDEN, "Forbidden"),
        Err("no-project") => return text(StatusCode::NOT_FOUND, "No project open"),
        Err(_) => return text(StatusCode::NOT_FOUND, "Not found"),
    };
    let Ok(mut file) = File::open(&real) else {
        return text(StatusCode::NOT_FOUND, "Not found");
    };
    let Ok(len) = file.metadata().map(|m| m.len()) else {
        return text(StatusCode::NOT_FOUND, "Not found");
    };
    let content_type = match real.extension() {
        Some(e) if e.eq_ignore_ascii_case("pdf") => "application/pdf",
        _ => "application/octet-stream",
    };
    let range = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| parse_range(v, len));
    let (status, range) = match range {
        Some(Err(())) => {
            return respond(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .body(vec![])
                .unwrap()
        }
        Some(Ok(r)) => (StatusCode::PARTIAL_CONTENT, r),
        None => (StatusCode::OK, 0..len),
    };
    let mut body = vec![0; (range.end - range.start) as usize];
    if req.method() != Method::HEAD
        && (file.seek(SeekFrom::Start(range.start)).is_err() || file.read_exact(&mut body).is_err())
    {
        return text(StatusCode::NOT_FOUND, "Not found");
    }
    let mut res = respond(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, body.len());
    if status == StatusCode::PARTIAL_CONTENT {
        res = res.header(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{len}", range.start, range.end - 1),
        );
    }
    if req.method() == Method::HEAD {
        body.clear();
    }
    res.body(body).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::lock;
    use crate::project::tests::tmp;

    fn get(s: &Mutex<Session>, rel: &str, range: Option<&str>) -> Response<Vec<u8>> {
        let q: String = form_urlencoded::Serializer::new(String::new())
            .append_pair("path", rel)
            .finish();
        let mut req = Request::builder().uri(format!("slr-file://localhost/pdf?{q}"));
        if let Some(r) = range {
            req = req.header(header::RANGE, r);
        }
        serve(s, &req.body(vec![]).unwrap())
    }

    fn setup(name: &str) -> (std::path::PathBuf, Mutex<Session>) {
        let d = tmp(name);
        std::fs::create_dir_all(d.join("proj/pdfs")).unwrap();
        std::fs::write(d.join("proj/pdfs/a b.pdf"), b"0123456789").unwrap();
        std::fs::write(d.join("proj/data.bin"), b"x").unwrap();
        std::fs::write(d.join("secret.pdf"), b"s").unwrap();
        let s = Mutex::new(Session::default());
        lock(&s).project_dir = Some(d.join("proj"));
        (d, s)
    }

    #[test]
    fn statuses_and_traversal() {
        let (d, s) = setup("proto-status");
        assert_eq!(get(&s, "../secret.pdf", None).status(), 403);
        assert_eq!(get(&s, "pdfs/../../secret.pdf", None).status(), 403);
        assert_eq!(
            get(&s, &d.join("secret.pdf").display().to_string(), None).status(),
            403
        );
        assert_eq!(get(&s, "nope.pdf", None).status(), 404);
        let ok = get(&s, "pdfs/a b.pdf", None);
        assert_eq!(ok.status(), 200);
        assert_eq!(ok.body(), b"0123456789");
        assert_eq!(ok.headers()[header::CONTENT_TYPE], "application/pdf");
        assert_eq!(ok.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(
            get(&s, "data.bin", None).headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        let none = Mutex::new(Session::default());
        assert_eq!(get(&none, "pdfs/a b.pdf", None).body(), b"No project open");
    }

    #[test]
    fn plus_in_query_is_a_space_like_url_search_params() {
        let (_d, s) = setup("proto-plus");
        let req = Request::builder()
            .uri("slr-file://localhost/pdf?path=pdfs/a+b.pdf")
            .body(vec![])
            .unwrap();
        assert_eq!(serve(&s, &req).status(), 200);
    }

    #[test]
    fn ranges() {
        let (_d, s) = setup("proto-range");
        let r = |h: &str| get(&s, "pdfs/a b.pdf", Some(h));
        let part = r("bytes=2-4");
        assert_eq!(part.status(), 206);
        assert_eq!(part.body(), b"234");
        assert_eq!(part.headers()[header::CONTENT_RANGE], "bytes 2-4/10");
        assert_eq!(part.headers()[header::CONTENT_LENGTH], "3");
        assert_eq!(r("bytes=7-").body(), b"789");
        assert_eq!(r("bytes=-3").body(), b"789");
        assert_eq!(
            r("bytes=8-100").headers()[header::CONTENT_RANGE],
            "bytes 8-9/10"
        );
        assert_eq!(r("bytes=-100").body(), b"0123456789");
        let bad = r("bytes=10-");
        assert_eq!(bad.status(), 416);
        assert_eq!(bad.headers()[header::CONTENT_RANGE], "bytes */10");
        assert_eq!(r("bytes=-0").status(), 416);
        for whole in ["bytes=0-1,4-5", "items=0-1", "bytes=5-2", "bytes=x-"] {
            assert_eq!(r(whole).status(), 200, "{whole}");
        }
    }

    #[test]
    fn preflight() {
        let (_d, s) = setup("proto-options");
        let req = Request::builder()
            .method(Method::OPTIONS)
            .uri("slr-file://localhost/pdf")
            .body(vec![])
            .unwrap();
        let res = serve(&s, &req);
        assert_eq!(res.status(), 204);
        assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS], "Range");
    }
}
