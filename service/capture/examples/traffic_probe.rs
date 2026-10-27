// SPDX-License-Identifier: GPL-3.0-only
//! Synthetic QA traffic only. This executable is never packaged with Wayrill.
use serde_json::json;
use std::{
    collections::HashSet,
    io::Write,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream, UdpSocket},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
// Per-handle high-resolution waits avoid the guest's coarse 15.6-ms sleep tick.
// They do not change the host or guest's global timer resolution.
struct Pacer(windows_sys::Win32::Foundation::HANDLE);
impl Pacer {
    fn new() -> std::io::Result<Self> {
        // SAFETY: create an unnamed, noninheritable timer owned by this QA thread.
        let handle = unsafe {
            windows_sys::Win32::System::Threading::CreateWaitableTimerExW(
                std::ptr::null(),
                std::ptr::null(),
                2,
                0x1f0003,
            )
        };
        if handle.is_null() {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(Self(handle))
        }
    }
    fn wait(&self) -> std::io::Result<()> {
        let due = -10_000_i64;
        // SAFETY: the owned live timer gets a one-ms relative wait, no APC or resume.
        unsafe {
            if windows_sys::Win32::System::Threading::SetWaitableTimer(
                self.0,
                &due,
                0,
                None,
                std::ptr::null(),
                0,
            ) == 0
                || windows_sys::Win32::System::Threading::WaitForSingleObject(self.0, 1000) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
        }
        Ok(())
    }
}
impl Drop for Pacer {
    fn drop(&mut self) {
        // SAFETY: sole owned timer handle, never shared or transferred.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
fn argument<T: std::str::FromStr>(args: &[String], index: usize) -> Result<T> {
    args.get(index)
        .ok_or("Missing argument")?
        .parse()
        .map_err(|_| "Invalid argument".into())
}
fn endpoint(port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(10, 0, 2, 2)), port)
}
async fn serve_tcp(mut stream: TcpStream) -> Result<()> {
    let mut header = [0; 9];
    stream.read_exact(&mut header).await?;
    if &header[..4] != b"WRCP" {
        return Err("Invalid request".into());
    }
    let seconds = u32::from_be_bytes(header[5..].try_into()?);
    if !(1..=60).contains(&seconds) {
        return Err("Invalid duration".into());
    }
    stream.set_nodelay(true)?;
    let mut block = vec![0x5a; 65536];
    if header[4] == b'D' {
        let deadline = Instant::now() + Duration::from_secs(u64::from(seconds));
        while Instant::now() < deadline {
            stream.write_all(&block).await?;
        }
        stream.shutdown().await?;
    } else if header[4] == b'U' {
        let expected = u64::from(seconds) * 32 * 1024 * 1024;
        let mut total = 0_u64;
        while total < expected {
            let capacity = (expected - total).min(block.len() as u64) as usize;
            let count = stream.read(&mut block[..capacity]).await?;
            if count == 0 {
                return Err("Upload ended before its declared length".into());
            }
            total += count as u64;
        }
        stream.write_all(&total.to_be_bytes()).await?;
        stream.shutdown().await?;
    } else {
        return Err("Invalid direction".into());
    }
    Ok(())
}
async fn server() -> Result<()> {
    let tcp = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let udp = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let options = socket2::SockRef::from(&udp);
    options.set_recv_buffer_size(4 * 1024 * 1024)?;
    options.set_send_buffer_size(4 * 1024 * 1024)?;
    println!(
        "{}",
        json!({"tcp":tcp.local_addr()?.port(),"udp":udp.local_addr()?.port(),"bound":"127.0.0.1"})
    );
    std::io::stdout().flush()?;
    let tcp_loop = async {
        loop {
            let (stream, _) = tcp.accept().await?;
            tokio::spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(70), serve_tcp(stream)).await;
            });
        }
        #[allow(unreachable_code)]
        Ok::<(), std::io::Error>(())
    };
    let udp_loop = async {
        let mut bytes = vec![0; 65535];
        loop {
            let (count, peer) = udp.recv_from(&mut bytes).await?;
            if count >= 20 && &bytes[..4] == b"WRUD" {
                udp.send_to(&bytes[..count], peer).await?;
            }
        }
        #[allow(unreachable_code)]
        Ok::<(), std::io::Error>(())
    };
    tokio::select! {r=tcp_loop=>r?,r=udp_loop=>r?,_=tokio::time::sleep(Duration::from_secs(3600))=>{}}
    Ok(())
}
async fn tcp_client(port: u16, seconds: u32, direction: u8) -> Result<()> {
    let mut stream = TcpStream::connect(endpoint(port)).await?;
    stream.set_nodelay(true)?;
    let mut header = b"WRCPD\0\0\0\0".to_vec();
    header[4] = direction;
    header[5..].copy_from_slice(&seconds.to_be_bytes());
    stream.write_all(&header).await?;
    let start = Instant::now();
    let mut bytes = vec![0x5a; 65536];
    let mut total = 0_u64;
    if direction == b'D' {
        loop {
            let count = stream.read(&mut bytes).await?;
            if count == 0 {
                break;
            }
            total += count as u64;
        }
    } else {
        let expected = u64::from(seconds) * 32 * 1024 * 1024;
        while total < expected {
            stream.write_all(&bytes).await?;
            total += bytes.len() as u64;
        }
        let confirmed = stream.read_u64().await?;
        if confirmed != total {
            return Err("Upload byte accounting mismatch".into());
        }
    }
    let elapsed = start.elapsed().as_secs_f64();
    println!(
        "{}",
        json!({"protocol":"tcp","direction":if direction==b'D'{"download"}else{"upload"},"seconds":elapsed,"bytes":total,"mbps":total as f64*8.0/elapsed/1e6})
    );
    Ok(())
}
async fn udp_client(port: u16, seconds: u32, mbps: u32, size: usize) -> Result<()> {
    if !(64..=60000).contains(&size)
        || !(1..=1000).contains(&mbps)
        || u64::from(seconds) * u64::from(mbps) * 1_000_000 / 8 / size as u64 > 2_000_000
    {
        return Err("Invalid UDP workload".into());
    }
    let socket = Arc::new(UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await?);
    let options = socket2::SockRef::from(socket.as_ref());
    options.set_recv_buffer_size(4 * 1024 * 1024)?;
    options.set_send_buffer_size(4 * 1024 * 1024)?;
    socket.connect(endpoint(port)).await?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos() as u64;
    let mut bytes = vec![0x5a; size];
    bytes[..4].copy_from_slice(b"WRUD");
    bytes[4..12].copy_from_slice(&nonce.to_be_bytes());
    bytes[12..20].copy_from_slice(&u64::MAX.to_be_bytes());
    // Warm the same association, excluding startup queue/ownership latency.
    let mut warm = vec![0; 65535];
    let mut ready = false;
    for _ in 0..20 {
        socket.send(&bytes).await?;
        if let Ok(Ok(n)) =
            tokio::time::timeout(Duration::from_millis(250), socket.recv(&mut warm)).await
        {
            if warm[..n] == bytes {
                ready = true;
                break;
            }
        }
    }
    if !ready {
        return Err("UDP association did not warm up".into());
    }
    let received_socket = socket.clone();
    let sent = Arc::new(AtomicU64::new(0));
    let receiver_sent = sent.clone();
    let (done, mut closed) = tokio::sync::watch::channel(false);
    let receiver = tokio::spawn(async move {
        let mut seen = HashSet::new();
        let mut duplicates = 0_u64;
        let mut reordered = 0_u64;
        let mut highest = 0_u64;
        let mut packet = vec![0; 65535];
        loop {
            let n = tokio::select! {_=closed.changed()=>break,result=received_socket.recv(&mut packet)=>result?};
            if n != size || &packet[..4] != b"WRUD" || packet[4..12] != nonce.to_be_bytes() {
                continue;
            }
            let seq = u64::from_be_bytes(packet[12..20].try_into().unwrap());
            if seq == u64::MAX {
                continue;
            }
            if seq >= receiver_sent.load(Ordering::Acquire) {
                return Err(std::io::Error::other("Invalid echo sequence"));
            }
            if !seen.insert(seq) {
                duplicates += 1;
            } else if seq < highest {
                reordered += 1;
            }
            highest = highest.max(seq);
            // Hard bound even if the endpoint misbehaves.
            if seen.len() > 2_000_000 {
                return Err(std::io::Error::other("Receive accounting limit"));
            }
        }
        Ok::<_, std::io::Error>((seen.len() as u64, duplicates, reordered))
    });
    let runtime = tokio::runtime::Handle::current();
    let (count, elapsed) = tokio::task::spawn_blocking(move || -> std::io::Result<_> {
        let timer = Pacer::new()?;
        let start = Instant::now();
        let duration = Duration::from_secs(u64::from(seconds));
        let mut count = 0_u64;
        let mut tokens = 0_f64;
        let packets_per_second = f64::from(mbps) * 1e6 / 8.0 / size as f64;
        let mut previous = start;
        while start.elapsed() < duration {
            let now = Instant::now();
            tokens += (now - previous).as_secs_f64() * packets_per_second;
            previous = now;
            // Cap catch-up bursts after host/guest scheduling stalls.
            tokens = tokens.min(packets_per_second * 0.05);
            while tokens >= 1.0 {
                bytes[12..20].copy_from_slice(&count.to_be_bytes());
                sent.store(count + 1, Ordering::Release);
                loop {
                    match socket.try_send(&bytes) {
                        Ok(n) if n == bytes.len() => break,
                        Ok(_) => return Err(std::io::Error::other("Incomplete datagram")),
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            runtime.block_on(socket.writable())?
                        }
                        Err(e) => return Err(e),
                    }
                }
                count += 1;
                tokens -= 1.0;
            }
            timer.wait()?;
        }
        Ok((count, start.elapsed().as_secs_f64()))
    })
    .await??;
    // Signal accounting closure after draining replies; no post-measure sends.
    tokio::time::sleep(Duration::from_secs(2)).await;
    done.send_replace(true);
    let (received, duplicates, reordered) = receiver.await??;
    println!(
        "{}",
        json!({"protocol":"udp","seconds":elapsed,"sent":count,"received":received,"lost":count.saturating_sub(received),"lossPercent":count.saturating_sub(received) as f64*100.0/count.max(1) as f64,"duplicates":duplicates,"reordered":reordered,"packetBytes":size,"offeredMbps":count as f64*size as f64*8.0/elapsed/1e6,"deliveredMbps":received as f64*size as f64*8.0/elapsed/1e6})
    );
    Ok(())
}
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
    match args.get(1).map(String::as_str) {
        Some("serve")=>server().await,
        Some("tcp-download"|"tcp-upload")=>{
            let seconds:u32=argument(&args,3)?;if !(1..=60).contains(&seconds){return Err("Invalid duration".into());}
            tokio::time::timeout(Duration::from_secs(u64::from(seconds)+15),tcp_client(argument(&args,2)?,seconds,if args[1]=="tcp-download"{b'D'}else{b'U'})).await?
        },
        Some("udp")=>{let seconds:u32=argument(&args,3)?;if !(1..=60).contains(&seconds){return Err("Invalid duration".into());}udp_client(argument(&args,2)?,seconds,argument(&args,4)?,argument(&args,5)?).await},
        _=>Err("Usage: traffic_probe serve | tcp-download/tcp-upload PORT SECONDS | udp PORT SECONDS MBPS SIZE".into())
    }
}
