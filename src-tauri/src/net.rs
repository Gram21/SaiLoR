//! Shared HTTP plumbing for the AI channels: the rustls client setup and the
//! abort registry (`inFlight` / `pulls` in electron/main.ts and electron/ollama.ts).

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

/// A client builder with the ring TLS provider installed. No cookies, no decompression.
pub fn builder() -> reqwest::ClientBuilder {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
}

/// Redirects refused: the LLM and local-server calls must not leave the checked origin.
pub static NO_REDIRECT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("http client")
});

static IN_FLIGHT: LazyLock<Mutex<HashMap<String, Arc<Notify>>>> = LazyLock::new(Default::default);

fn table() -> std::sync::MutexGuard<'static, HashMap<String, Arc<Notify>>> {
    IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner())
}

/// One abortable request, registered under `id` until dropped.
pub struct Flight {
    id: String,
    signal: Arc<Notify>,
}

impl Flight {
    pub fn new(id: &str) -> Self {
        let signal = Arc::new(Notify::new());
        table().insert(id.to_string(), signal.clone());
        Self {
            id: id.to_string(),
            signal,
        }
    }

    /// Run `fut` until it ends, `abort(id)` is called, or `limit` passes.
    pub async fn run<F: Future>(&self, limit: Duration, fut: F) -> Result<F::Output, Stop> {
        tokio::select! {
            r = fut => Ok(r),
            _ = self.signal.notified() => Err(Stop::Aborted),
            _ = tokio::time::sleep(limit) => Err(Stop::TimedOut),
        }
    }
}

impl Drop for Flight {
    fn drop(&mut self) {
        let mut t = table();
        if t.get(&self.id)
            .is_some_and(|s| Arc::ptr_eq(s, &self.signal))
        {
            t.remove(&self.id);
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Stop {
    Aborted,
    TimedOut,
}

/// `inFlight.get(requestId)?.abort()`. A permit is stored, so an abort that wins the race still counts.
pub fn abort(id: &str) {
    if let Some(s) = table().get(id) {
        s.notify_one();
    }
}

#[cfg(test)]
pub mod mock {
    //! A one-thread HTTP/1.1 server for tests: `routes` maps "METHOD /path" to a raw response.
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    pub struct Server {
        pub origin: String,
        pub seen: Arc<Mutex<Vec<String>>>,
    }

    pub fn response(status: u16, ctype: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status} X\r\ncontent-type: {ctype}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    pub fn serve(routes: Vec<(&str, String)>) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let routes: Vec<(String, String)> = routes
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let mut len = 0;
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                        break;
                    }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0; len];
                let _ = reader.read_exact(&mut body);
                let key: Vec<&str> = line.split_whitespace().take(2).collect();
                let key = key.join(" ");
                log.lock()
                    .unwrap()
                    .push(format!("{key} {}", String::from_utf8_lossy(&body)));
                let reply = routes
                    .iter()
                    .find(|(k, _)| *k == key)
                    .map(|(_, v)| v.clone())
                    .unwrap_or_else(|| response(404, "text/plain", "nope"));
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        Server { origin, seen }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn abort_and_timeout() {
        let f = Flight::new("t1");
        abort("t1");
        let r = f
            .run(Duration::from_secs(5), std::future::pending::<()>())
            .await;
        assert_eq!(r, Err(Stop::Aborted));
        let r = f
            .run(Duration::from_millis(10), std::future::pending::<()>())
            .await;
        assert_eq!(r, Err(Stop::TimedOut));
        assert_eq!(f.run(Duration::from_secs(1), async { 7 }).await, Ok(7));
        drop(f);
        assert!(table().get("t1").is_none());
    }
}
