//! Bounded, best-effort diagnostic files. Never log configurations or IPC bodies.
use serde_json::json;
use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const FILE_BYTES: u64 = 1024 * 1024;
pub const COPIES: usize = 4;
const MESSAGE_BYTES: usize = 4096;
static LOGGER: OnceLock<Logger> = OnceLock::new();
static INITIALIZE: std::sync::Mutex<()> = std::sync::Mutex::new(());
struct Logger {
    tx: mpsc::SyncSender<Command>,
    dropped: Arc<AtomicU64>,
}
enum Command {
    Record(Vec<u8>, bool),
    Flush(mpsc::SyncSender<()>),
}

pub fn service_directory() -> PathBuf {
    PathBuf::from(std::env::var_os("ProgramData").unwrap_or_else(|| "C:\\ProgramData".into()))
        .join("Wayrill/Logs")
}
pub fn filename(stem: &str, copy: usize) -> String {
    if copy == 0 {
        format!("{stem}.jsonl")
    } else {
        format!("{stem}.{copy}.jsonl")
    }
}
fn regular(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(value) if value.is_file() && !value.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(io::Error::other("Diagnostic path is not a regular file.")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}
struct Writer {
    _lease: File,
    directory: PathBuf,
    stem: String,
    file: Option<BufWriter<File>>,
    bytes: u64,
    rotation: Option<usize>,
}
impl Writer {
    fn open(directory: &Path, stem: &str) -> io::Result<Self> {
        if !matches!(stem, "service" | "sharing" | "desktop") {
            return Err(io::Error::other("Unknown diagnostic source."));
        }
        let metadata = fs::symlink_metadata(directory)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(io::Error::other(
                "Diagnostic folder is not a regular directory.",
            ));
        }
        let lock_path = directory.join(format!("{stem}.lock"));
        regular(&lock_path)?;
        let lease = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)?;
        lease.try_lock().map_err(|error| {
            io::Error::other(format!(
                "Diagnostic writer already active or unavailable: {error}"
            ))
        })?;
        let mut writer = Self {
            _lease: lease,
            directory: directory.into(),
            stem: stem.into(),
            file: None,
            bytes: 0,
            rotation: None,
        };
        writer.reopen()?;
        Ok(writer)
    }
    fn path(&self, copy: usize) -> PathBuf {
        self.directory.join(filename(&self.stem, copy))
    }
    fn reopen(&mut self) -> io::Result<()> {
        let path = self.path(0);
        regular(&path)?;
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(path)?;
        self.bytes = file.metadata()?.len();
        if self.bytes > 0 {
            file.seek(SeekFrom::End(-1))?;
            let mut last = [0];
            file.read_exact(&mut last)?;
            if last[0] != b'\n' {
                file.write_all(b"\n")?;
                self.bytes += 1;
            }
        }
        self.file = Some(BufWriter::new(file));
        Ok(())
    }
    fn write(&mut self, bytes: &[u8], urgent: bool) -> io::Result<()> {
        if self.rotation.is_none() && self.file.is_none() {
            self.reopen()?;
        }
        if self.rotation.is_none() && self.bytes + bytes.len() as u64 > FILE_BYTES {
            self.flush()?;
            self.file = None;
            self.rotation = Some(COPIES - 1);
        }
        // A reader can temporarily deny a rename on Windows. Resume that step
        // rather than shifting the completed archives again on every retry.
        while let Some(copy) = self.rotation {
            let source = self.path(copy - 1);
            let destination = self.path(copy);
            regular(&source)?;
            regular(&destination)?;
            match fs::rename(source, destination) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
            self.rotation = copy.checked_sub(1).filter(|copy| *copy > 0);
        }
        if self.file.is_none() {
            self.reopen()?;
        }
        self.file.as_mut().unwrap().write_all(bytes)?;
        self.bytes += bytes.len() as u64;
        if urgent {
            self.flush()?;
        }
        Ok(())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.as_mut().map_or(Ok(()), Write::flush)
    }
}

/// The caller creates the folder with its intended Windows permissions first.
pub fn initialize(directory: &Path, stem: &str) -> io::Result<()> {
    let _guard = INITIALIZE
        .lock()
        .map_err(|_| io::Error::other("Diagnostic initialization failed."))?;
    if LOGGER.get().is_some() {
        return Ok(());
    }
    let mut writer = Writer::open(directory, stem)?;
    let (tx, rx) = mpsc::sync_channel(512);
    let dropped = Arc::new(AtomicU64::new(0));
    let overflow = dropped.clone();
    std::thread::Builder::new()
        .name("wayrill-diagnostics".into())
        .spawn(move || {
            let mut last_flush = std::time::Instant::now();
            loop {
                let mut result = match rx.recv_timeout(Duration::from_millis(500)) {
                    Ok(Command::Record(bytes, urgent)) => {
                        let count = overflow.swap(0, Ordering::Relaxed);
                        if count > 0 {
                            let note = record(
                                "logger",
                                "warning",
                                &format!(
                                    "Dropped {count} diagnostic messages while the queue was full."
                                ),
                            );
                            let _ = writer.write(&note, true);
                        }
                        writer.write(&bytes, urgent)
                    }
                    Ok(Command::Flush(ack)) => {
                        let result = writer.flush();
                        let _ = ack.send(());
                        result
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => writer.flush(),
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        let _ = writer.flush();
                        break;
                    }
                };
                // Flush on elapsed time even when records keep arriving. A
                // recv timeout alone can starve buffered writes indefinitely.
                if result.is_ok() && last_flush.elapsed() >= Duration::from_millis(500) {
                    result = writer.flush();
                    last_flush = std::time::Instant::now();
                }
                if result.is_err() {
                    // Disk failures must not affect routing, block producers or spin.
                    writer.file = None;
                    std::thread::sleep(Duration::from_millis(500));
                }
            }
        })?;
    let _ = LOGGER.set(Logger { tx, dropped });
    log(
        "logger",
        "info",
        &format!(
            "Diagnostic logging started; app {}.",
            env!("CARGO_PKG_VERSION")
        ),
    );
    Ok(())
}
fn bounded(text: &str) -> &str {
    let mut end = text.len().min(MESSAGE_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}
/// Read only Xray's logger header, never bracketed words in a message body.
pub fn xray_level(text: &str) -> Option<&'static str> {
    let (prefix, rest) = text.split_once('[')?;
    if !prefix
        .chars()
        .all(|c| c.is_ascii_digit() || " /:.".contains(c))
    {
        return None;
    }
    match rest.split_once(']')?.0 {
        "Debug" => Some("debug"),
        "Info" => Some("info"),
        "Warning" => Some("warning"),
        "Error" => Some("error"),
        _ => None,
    }
}

pub fn sanitize(text: &str) -> String {
    static PATTERNS: OnceLock<[regex::Regex; 3]> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| [
        regex::Regex::new(r#"(?i)\b(?:https?|socks5?|vless|vmess|trojan|ss)://[^\s\"<>]+"#).unwrap(),
        regex::Regex::new(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b").unwrap(),
        regex::Regex::new(r#"(?i)\b(password|passwd|secret|token|authorization|privatekey|uuid|api_key|apikey|access_token|refresh_token|cookie)\\?["']?\s*[:=]\s*(\\?"(?:\\.|[^"\\])*(?:\\?"|$)|'[^']*(?:'|$)|(?:Bearer|Basic)\s+[^\s,;}]+|[^\s,;}]+)"#).unwrap(),
    ]);
    let text = patterns[0].replace_all(bounded(text), "[URL]");
    let text = patterns[1].replace_all(&text, "[ID]");
    patterns[2].replace_all(&text, "$1=[redacted]").into_owned()
}
fn record(component: &str, level: &str, message: &str) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(&json!({
        "timeMs":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
        "pid":std::process::id(), "component":component, "level":level, "message":sanitize(message)
    })).unwrap_or_default();
    bytes.push(b'\n');
    bytes
}
pub fn log(component: &str, level: &str, message: &str) {
    if let Some(logger) = LOGGER.get() {
        if logger
            .tx
            .try_send(Command::Record(
                record(component, level, message),
                level == "error",
            ))
            .is_err()
        {
            logger.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}
pub fn flush() {
    if let Some(logger) = LOGGER.get() {
        let (tx, rx) = mpsc::sync_channel(1);
        if logger.tx.try_send(Command::Flush(tx)).is_ok() {
            let _ = rx.recv_timeout(Duration::from_secs(1));
        }
    }
}
pub fn panic_hook(component: &'static str) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log(component, "error", &format!("Panic: {info}"));
        flush();
        previous(info);
    }));
}
/// Fixed-source callers use this bounded tail even when the service is offline.
pub fn tail(path: &Path, limit: usize) -> io::Result<String> {
    regular(path)?;
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    let start = length.saturating_sub(limit as u64);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(limit as u64).read_to_end(&mut bytes)?;
    if start > 0 {
        if let Some(end) = bytes.iter().position(|&c| c == b'\n') {
            bytes.drain(..=end);
        } else {
            bytes.clear();
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn locked_current_log_does_not_rotate_archives_again_on_each_retry() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = std::env::temp_dir().join(format!(
            "wayrill-log-lock-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        let mut full = vec![b'x'; FILE_BYTES as usize];
        *full.last_mut().unwrap() = b'\n';
        fs::write(directory.join("service.jsonl"), &full).unwrap();
        for (copy, text) in [(1, "one\n"), (2, "two\n"), (3, "three\n")] {
            fs::write(directory.join(filename("service", copy)), text).unwrap();
        }
        let mut writer = Writer::open(&directory, "service").unwrap();
        let locked = OpenOptions::new()
            .read(true)
            .share_mode(3) // FILE_SHARE_READ | FILE_SHARE_WRITE, without DELETE.
            .open(writer.path(0))
            .unwrap();
        let next = record("test", "info", "after unlock");
        for _ in 0..4 {
            assert!(writer.write(&next, true).is_err());
            assert_eq!(fs::read(writer.path(0)).unwrap(), full);
            assert_eq!(fs::read(writer.path(2)).unwrap(), b"one\n");
            assert_eq!(fs::read(writer.path(3)).unwrap(), b"two\n");
        }
        drop(locked);
        writer.write(&next, true).unwrap();
        assert_eq!(fs::read(writer.path(0)).unwrap(), next);
        assert_eq!(fs::read(writer.path(1)).unwrap(), full);
        assert_eq!(fs::read(writer.path(2)).unwrap(), b"one\n");
        assert_eq!(fs::read(writer.path(3)).unwrap(), b"two\n");
        drop(writer);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn redaction_and_utf8_bounds_keep_credentials_out_of_files() {
        let text = sanitize("failed https://user:pass@server/sub?token=abc password=hello secret=\"hidden words\" uuid=0d4571cc-14c8-4cf9-bc1a-264898d4b152");
        for secret in ["user", "pass@", "token=abc", "hello", "hidden", "0d4571cc"] {
            assert!(!text.contains(secret), "{text}");
        }

        for text in [
            r#"{"password":"secret words","token":"sensitive"}"#,
            r#"{\"privateKey\":\"secret words\"}"#,
            "authorization: Bearer sensitive",
            "password=\"secret words",
        ] {
            let sanitized = sanitize(text);
            assert!(!sanitized.contains("secret words"), "{sanitized}");
            assert!(!sanitized.contains("sensitive"), "{sanitized}");
        }
        let text = "🌍".repeat(MESSAGE_BYTES);
        assert_eq!(bounded(&text).len(), MESSAGE_BYTES);
    }
    #[test]
    fn writer_lease_and_partial_record_recovery_survive_reopen() {
        let directory = std::env::temp_dir().join(format!(
            "wayrill-log-reopen-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("service.jsonl"), b"partial previous record").unwrap();
        let mut writer = Writer::open(&directory, "service").unwrap();
        assert!(Writer::open(&directory, "service").is_err());
        writer
            .write(&record("test", "error", "new record"), true)
            .unwrap();
        drop(writer);
        let writer = Writer::open(&directory, "service").unwrap();
        let text = tail(&writer.path(0), 8192).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        let entry: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(entry["message"], "new record");
        drop(writer);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn rotation_is_bounded_and_tail_keeps_complete_utf8_records() {
        let directory = std::env::temp_dir().join(format!(
            "wayrill-log-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        let mut writer = Writer::open(&directory, "service").unwrap();
        let bytes = record("test", "info", &"🌍".repeat(800));
        for _ in 0..1600 {
            writer.write(&bytes, false).unwrap();
        }
        writer.flush().unwrap();
        for file in fs::read_dir(&directory).unwrap() {
            assert!(file.unwrap().metadata().unwrap().len() <= FILE_BYTES);
        }
        assert_eq!(
            fs::read_dir(&directory)
                .unwrap()
                .filter(|entry| entry
                    .as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .is_some_and(|ext| ext == "jsonl"))
                .count(),
            COPIES
        );
        let tail = tail(&writer.path(0), 7000).unwrap();
        for line in tail.lines() {
            let value: serde_json::Value = serde_json::from_str(line).unwrap();
            assert!(value["message"].as_str().unwrap().starts_with('🌍'));
        }
        drop(writer);
        fs::remove_dir_all(directory).unwrap();
    }
}

#[cfg(test)]
mod core_level_tests {
    use super::xray_level;
    #[test]
    fn preserves_core_severity_without_matching_brackets_in_message_bodies() {
        for (header, level) in [
            ("Debug", "debug"),
            ("Info", "info"),
            ("Warning", "warning"),
            ("Error", "error"),
        ] {
            assert_eq!(
                xray_level(&format!(
                    "2026/10/21 12:34:56.123 [{header}] [123] app/router: message [Info]"
                )),
                Some(level)
            );
        }
        assert_eq!(xray_level("[Error] failed"), Some("error"));
        assert_eq!(xray_level("text mentions [Error]"), None);
        assert_eq!(
            xray_level("2026/10/21 12:00:00 [Warning] message [Info]"),
            Some("warning")
        );
        assert_eq!(xray_level("2026/10/21 12:00:00 [Unknown] message"), None);
        assert_eq!(xray_level("Xray 26.10.17"), None);
    }
}
