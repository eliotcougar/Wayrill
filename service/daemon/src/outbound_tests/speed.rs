//! One bounded HTTP download per route; retain byte counts, never the payload.
use super::{checked_url, invalid};
use serde::Serialize;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use wayrill_protocol::Result;

const WINDOW: Duration = Duration::from_secs(5);
const MAX_BYTES: u64 = 256 * 1024 * 1024;
const MIN_BYTES: u64 = 64 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Measurement {
    pub bytes_per_second: f64,
    pub bytes: u64,
    pub elapsed_ms: u64,
}

pub(super) fn test(port: u16, password: &str, url: &str, stop: &AtomicBool) -> Result<Measurement> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| invalid("Cannot start the speed test client."))?
        .block_on(download(port, password, url, stop, WINDOW))
}

async fn download(
    port: u16,
    password: &str,
    text: &str,
    stop: &AtomicBool,
    window: Duration,
) -> Result<Measurement> {
    if stop.load(Ordering::SeqCst) {
        return Err(invalid("Test cancelled."));
    }
    let url = checked_url(text)?;
    let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
        .map_err(|_| invalid("Cannot select the private test proxy."))?
        .basic_auth("wayrill-test", password);
    let client = reqwest::Client::builder()
        .no_proxy()
        .proxy(proxy)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(5) + window)
        .pool_max_idle_per_host(0)
        .user_agent("Wayrill speed test")
        .build()
        .map_err(|_| invalid("Cannot create the speed test client."))?;
    let mut cancellation = tokio::time::interval(Duration::from_millis(100));
    let send = client
        .get(url)
        .header("Accept-Encoding", "identity")
        .header("Cache-Control", "no-cache, no-store")
        .send();
    tokio::pin!(send);
    let headers = tokio::time::sleep(Duration::from_secs(5));
    tokio::pin!(headers);
    let mut response = loop {
        tokio::select! {
            result = &mut send => break result.map_err(|e| invalid(if e.is_timeout() {
                "Speed test connection timed out."
            } else { "Cannot download through this outbound." }))?,
            _ = &mut headers => return Err(invalid("Speed test connection timed out.")),
            _ = cancellation.tick() => if stop.load(Ordering::SeqCst) { return Err(invalid("Test cancelled.")); },
        }
    };
    if !response.status().is_success() {
        return Err(invalid(&format!(
            "Speed test URL returned HTTP {}; use a download URL without redirects.",
            response.status().as_u16()
        )));
    }
    if response
        .headers()
        .get("content-encoding")
        .is_some_and(|v| v != "identity")
    {
        return Err(invalid(
            "The speed test server returned compressed data; choose an uncompressed download URL.",
        ));
    }
    let start = Instant::now();
    let deadline = tokio::time::sleep(window);
    tokio::pin!(deadline);
    let mut bytes = 0u64;
    loop {
        tokio::select! {
            _ = &mut deadline => break,
            _ = cancellation.tick() => if stop.load(Ordering::SeqCst) { return Err(invalid("Test cancelled.")); },
            next = response.chunk() => {
                let Some(chunk) = next.map_err(|_| invalid("The speed test download was interrupted."))? else { break };
                bytes += (chunk.len() as u64).min(MAX_BYTES - bytes);
                if bytes == MAX_BYTES { break; }
            }
        }
    }
    if stop.load(Ordering::SeqCst) {
        return Err(invalid("Test cancelled."));
    }
    if bytes < MIN_BYTES {
        return Err(invalid(
            "Speed test response is too small; choose a download file of at least 64 KiB.",
        ));
    }
    let elapsed = start.elapsed();
    Ok(Measurement {
        bytes_per_second: bytes as f64 / elapsed.as_secs_f64().max(0.001),
        bytes,
        elapsed_ms: elapsed.as_millis().max(1) as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::Arc,
    };

    fn server(body: Vec<u8>, delay: Duration) -> (u16, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        (
            port,
            std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((s, _)) => break s,
                        Err(e)
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            std::thread::sleep(Duration::from_millis(5))
                        }
                        Err(e) => panic!("Private speed proxy was not used: {e}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = Vec::new();
                let mut chunk = [0; 2048];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = stream.read(&mut chunk).unwrap();
                    assert!(n > 0 && request.len() < 16384);
                    request.extend_from_slice(&chunk[..n]);
                }
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                for bytes in body.chunks(32768) {
                    if stream.write_all(bytes).is_err() {
                        break;
                    }
                    std::thread::sleep(delay);
                }
                String::from_utf8(request).unwrap()
            }),
        )
    }

    #[test]
    fn measures_a_stream_through_the_authenticated_proxy_without_buffering_it() {
        let body = vec![0x55; 256 * 1024];
        let (port, peer) = server(body, Duration::from_millis(20));
        let measurement = test(
            port,
            "fixture",
            "http://127.9.8.7:1/data",
            &AtomicBool::new(false),
        )
        .unwrap();
        let request = peer.join().unwrap().to_ascii_lowercase();
        assert!(request.starts_with("get http://127.9.8.7:1/data http/1.1"));
        assert!(request.contains("proxy-authorization: basic "));
        assert!(request.contains("accept-encoding: identity"));
        assert_eq!(measurement.bytes, 256 * 1024);
        assert!(measurement.elapsed_ms >= 100);
        assert!(
            (measurement.bytes_per_second
                - measurement.bytes as f64 / (measurement.elapsed_ms as f64 / 1000.))
                .abs()
                < measurement.bytes_per_second * 0.02
        );
    }

    #[test]
    fn the_measurement_window_closes_a_stream_without_waiting_for_the_whole_file() {
        let (port, peer) = server(vec![0; 1024 * 1024], Duration::from_millis(100));
        let measurement = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(download(
                port,
                "fixture",
                "http://download.example/data",
                &AtomicBool::new(false),
                Duration::from_millis(350),
            ))
            .unwrap();
        assert!(measurement.bytes >= MIN_BYTES && measurement.bytes < 1024 * 1024);
        assert!(measurement.elapsed_ms >= 300 && measurement.elapsed_ms < 1500);
        peer.join().unwrap();
    }
    #[test]
    fn cancellation_interrupts_a_waiting_body_and_small_pages_are_not_speed_results() {
        let (port, peer) = server(vec![0; 1024], Duration::ZERO);
        assert!(test(
            port,
            "fixture",
            "http://download.example/data",
            &AtomicBool::new(false)
        )
        .unwrap_err()
        .message
        .contains("too small"));
        peer.join().unwrap();
        let (port, peer) = server(vec![0; 1024 * 1024], Duration::from_millis(100));
        let stop = Arc::new(AtomicBool::new(false));
        let cancel = stop.clone();
        let timer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(170));
            cancel.store(true, Ordering::SeqCst);
        });
        let start = Instant::now();
        assert!(test(port, "fixture", "http://download.example/data", &stop)
            .unwrap_err()
            .message
            .contains("cancelled"));
        assert!(start.elapsed() < Duration::from_secs(2));
        timer.join().unwrap();
        peer.join().unwrap();
    }
}
