//! One bounded HTTP download per route; retain byte counts, never the payload.
use super::{invalid, Client, HTTP_RESPONSE_TIMEOUT};
use serde::Serialize;
use std::{sync::atomic::AtomicBool, time::Duration};
use tokio::time::{timeout_at, Instant};
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
    let client = Client::new(port, password)?;
    client.run(stop, download(&client, url, WINDOW))
}

async fn download(client: &Client, text: &str, window: Duration) -> Result<Measurement> {
    let startup_deadline = Instant::now() + HTTP_RESPONSE_TIMEOUT;
    let mut response = timeout_at(
        startup_deadline,
        client
            .get(text)?
            .header("User-Agent", "Wayrill speed test")
            .header("Accept-Encoding", "identity")
            .header("Cache-Control", "no-cache, no-store")
            .send(),
    )
    .await
    .map_err(|_| invalid("Speed test timed out waiting for a response."))?
    .map_err(|_| invalid("Cannot download through this outbound."))?;
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

    let interrupted = || invalid("The speed test download was interrupted.");
    let too_small = || {
        invalid("Speed test needs at least 64 KiB of measured data. Choose a larger download file.")
    };
    let first_bytes = timeout_at(startup_deadline, async {
        while let Some(chunk) = response.chunk().await? {
            if !chunk.is_empty() {
                return Ok(chunk.len() as u64);
            }
        }
        Ok::<_, reqwest::Error>(0)
    })
    .await
    .map_err(|_| invalid("Speed test timed out waiting for download data."))?
    .map_err(|_| interrupted())?;
    if first_bytes == 0 {
        return Err(too_small());
    }
    // The first chunk establishes where to start counting. Its bytes arrived
    // before the clock started and must not inflate the measured transfer rate.
    let start = Instant::now();
    let deadline = start + window;
    let limit = MAX_BYTES.saturating_sub(first_bytes);
    let mut bytes = 0u64;
    while bytes < limit && Instant::now() < deadline {
        let Ok(chunk) = timeout_at(deadline, response.chunk()).await else {
            break;
        };
        match chunk.map_err(|_| interrupted())? {
            Some(chunk) => bytes += (chunk.len() as u64).min(limit - bytes),
            None => break,
        }
    }
    if bytes < MIN_BYTES {
        return Err(too_small());
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
        sync::{atomic::Ordering, Arc},
    };

    fn server(
        body: Vec<u8>,
        body_delay: Duration,
        delay: Duration,
    ) -> (u16, std::thread::JoinHandle<String>) {
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
                std::thread::sleep(body_delay);
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
        let (port, peer) = server(body, Duration::ZERO, Duration::from_millis(20));
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
        assert!((MIN_BYTES..256 * 1024).contains(&measurement.bytes));
        assert!(measurement.elapsed_ms >= 100);
        assert!(
            (measurement.bytes_per_second
                - measurement.bytes as f64 / (measurement.elapsed_ms as f64 / 1000.))
                .abs()
                < measurement.bytes_per_second * 0.02
        );
    }

    #[test]
    fn a_slow_first_byte_does_not_use_up_the_measurement_window() {
        let (port, peer) = server(
            vec![0; 1024 * 1024],
            Duration::from_millis(5250),
            Duration::from_millis(100),
        );
        let client = Client::new(port, "fixture").unwrap();
        let measurement = client
            .run(
                &AtomicBool::new(false),
                download(
                    &client,
                    "http://download.example/data",
                    Duration::from_millis(350),
                ),
            )
            .unwrap();
        assert!(measurement.bytes >= MIN_BYTES && measurement.bytes < 1024 * 1024);
        assert!(measurement.elapsed_ms >= 300 && measurement.elapsed_ms < 1500);
        peer.join().unwrap();
    }
    #[test]
    fn latency_accepts_a_response_that_outlasts_the_old_http_deadline() {
        let (port, peer) = server(vec![0x55; 512], Duration::from_millis(5250), Duration::ZERO);
        let body = Client::new(port, "fixture")
            .unwrap()
            .fetch("http://probe.example/check", &AtomicBool::new(false))
            .unwrap();
        assert_eq!(body, vec![0x55; 512]);
        peer.join().unwrap();
    }

    #[test]
    fn cancellation_interrupts_startup_and_small_pages_are_not_speed_results() {
        // A 64 KiB response passes the old total-byte minimum even if much of
        // it was already buffered when the measurement began.
        let (port, peer) = server(vec![0; MIN_BYTES as usize], Duration::ZERO, Duration::ZERO);
        assert!(test(
            port,
            "fixture",
            "http://download.example/data",
            &AtomicBool::new(false)
        )
        .unwrap_err()
        .message
        .contains("64 KiB of measured data"));
        peer.join().unwrap();
        let (port, peer) = server(
            vec![0; 1024 * 1024],
            Duration::from_millis(700),
            Duration::from_millis(100),
        );
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
