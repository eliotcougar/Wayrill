//! One owned WinSCP session, with bounded, independently framed requests.
use crate::{
    remote::{connection_error, Operation, RemoteError, Result},
    winscp,
};
use std::{
    io::{Read, Write},
    os::windows::{
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

const MAX_FILE: usize = 16 * 1024 * 1024;
const MAX_TEXT: usize = 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(50);
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn error(code: &'static str, message: &str) -> RemoteError {
    RemoteError::new(code, message)
}

fn contain(child: &Child) -> Result<OwnedHandle> {
    let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if raw.is_null() {
        return Err(error("PROCESS", "Cannot contain the SSH helper."));
    }
    // Job handles can be moved between threads. Closing the sole owned handle
    // also terminates the console's WinSCP child, including on application exit.
    let job = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            raw,
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&info) as u32,
        ) == 0
            || AssignProcessToJobObject(raw, child.as_raw_handle()) == 0
    } {
        return Err(error(
            "PROCESS",
            "Cannot contain the SSH helper; the connection was cancelled.",
        ));
    }
    Ok(job)
}

enum Output {
    Data(bool, Vec<u8>),
    End(bool),
    Failed,
}

pub(crate) struct Console {
    pub connection: winscp::Connection,
    child: Child,
    input: Option<ChildStdin>,
    job: Option<OwnedHandle>,
    output: Option<mpsc::Receiver<Output>>,
    readers: Vec<JoinHandle<()>>,
}
impl Console {
    pub fn open(connection: winscp::Connection) -> Result<Self> {
        let helper = winscp::console_helper(&connection.executable)?;
        let mut command = Command::new(helper);
        command.current_dir(connection.executable.parent().unwrap());
        if let Some(ini) = &connection.ini {
            command.arg(format!("/ini={}", ini.display()));
        }
        command.args([
            "/nointeractiveinput",
            "/log=nul",
            "/xmllog=nul",
            "/stdout=chunked",
            "/command",
        ]);
        // Startup arguments are Unicode. Subsequent console input is explicitly
        // UTF-8 in WinSCP's console protocol, irrespective of the Windows locale.
        for line in [
            "option batch abort",
            "option confirm off",
            "option reconnecttime 0",
            &format!(
                "open \"{}\" -timeout=15 -rawsettings FSProtocol=2 PingType=1 PingIntervalSecs=30",
                connection.name
            ),
        ] {
            command.raw_arg(format!("\"{}\"", line.replace('"', "\"\"")));
        }
        let mut child = command
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| {
                error(
                    "PROCESS",
                    "Cannot start the installed WinSCP console helper.",
                )
            })?;
        let job = match contain(&child) {
            Ok(job) => job,
            Err(reason) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(reason);
            }
        };
        let input = child.stdin.take();
        let pipes: Vec<(bool, Box<dyn Read + Send>)> = vec![
            (true, Box::new(child.stdout.take().unwrap())),
            (false, Box::new(child.stderr.take().unwrap())),
        ];
        // Backpressure bounds output memory even while the session is idle.
        let (sender, output) = mpsc::sync_channel(8);
        let readers = pipes
            .into_iter()
            .map(|(stdout, mut pipe)| {
                let sender = sender.clone();
                thread::spawn(move || {
                    let mut buffer = [0u8; 8192];
                    loop {
                        match pipe.read(&mut buffer) {
                            Ok(0) => {
                                let _ = sender.send(Output::End(stdout));
                                break;
                            }
                            Ok(size) => {
                                if sender
                                    .send(Output::Data(stdout, buffer[..size].to_vec()))
                                    .is_err()
                                {
                                    break;
                                }
                            }
                            Err(_) => {
                                let _ = sender.send(Output::Failed);
                                break;
                            }
                        }
                    }
                })
            })
            .collect();
        Ok(Self {
            connection,
            child,
            input,
            job: Some(job),
            output: Some(output),
            readers,
        })
    }

    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn close(&mut self) {
        if let Some(input) = &mut self.input {
            let _ = input.write_all(b"close\nexit\n");
            let until = Instant::now() + Duration::from_millis(200);
            while self.alive() && Instant::now() < until {
                thread::sleep(Duration::from_millis(10));
            }
        }
        self.abort();
    }

    fn abort(&mut self) {
        self.job.take();
        self.input.take();
    }

    pub fn execute(
        &mut self,
        operation: &Operation,
        commands: &[String],
        file: bool,
        deadline: Instant,
    ) -> Result<Vec<u8>> {
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let token = format!("{:x}_{sequence:x}", std::process::id());
        let begin = format!("WAYRILL_REQUEST_{token}_BEGIN");
        let end = format!("WAYRILL_REQUEST_{token}_END");
        let mut script = format!(
            "option batch abort\noption confirm off\noption reconnecttime 0\necho {begin}\n"
        );
        for line in commands {
            // The WinSCP console input structure holds 10240 UTF-16 code units.
            if line.contains(['\r', '\n', '\0']) || line.encode_utf16().count() >= 10000 {
                return Err(error(
                    "PROTOCOL",
                    "The SSH command exceeded its console input limit.",
                ));
            }
            script.push_str(line);
            script.push('\n');
        }
        script.push_str(&format!("echo {end}\n"));
        let mut input = self
            .input
            .take()
            .ok_or_else(|| error("CONNECT", "The SSH connection was closed."))?;
        let (sent, written) = mpsc::channel();
        // Writing can block during login. Keep cancellation and the total
        // timeout effective while WinSCP is not yet consuming its input pipe.
        let writer = thread::spawn(move || {
            let result = input
                .write_all(script.as_bytes())
                .and_then(|_| input.flush());
            let _ = sent.send(result.map(|_| input));
        });
        let result = self.receive(operation, &begin, &end, file, deadline, &written);
        if result.is_err() {
            self.abort();
        }
        let _ = writer.join();
        result
    }

    fn receive(
        &mut self,
        operation: &Operation,
        begin: &str,
        end: &str,
        file: bool,
        deadline: Instant,
        written: &mpsc::Receiver<std::io::Result<ChildStdin>>,
    ) -> Result<Vec<u8>> {
        let mut text = TextFrame::new(begin, end);
        let mut chunks = Chunks::default();
        let mut ended = [false; 2];
        loop {
            operation.check_cancelled()?;
            if Instant::now() >= deadline {
                return Err(error(
                    "TIMEOUT",
                    "SSH request timed out. Check the server and reconnect.",
                ));
            }
            if let Ok(result) = written.try_recv() {
                self.input = Some(result.map_err(|_| {
                    error(
                        "CONNECT",
                        "The SSH connection was closed while sending a request.",
                    )
                })?);
            }
            if text.done && (!file || chunks.done) && self.input.is_some() {
                return Ok(if file { chunks.data } else { text.data });
            }
            match self
                .output
                .as_ref()
                .unwrap()
                .recv_timeout(Duration::from_millis(25))
            {
                Ok(Output::Data(true, bytes)) => chunks.feed(&bytes)?,
                Ok(Output::Data(false, bytes)) => text.feed(&bytes)?,
                Ok(Output::End(stdout)) => ended[usize::from(stdout)] = true,
                Ok(Output::Failed) => {
                    return Err(error(
                        "CONNECT",
                        "The SSH helper output connection was lost.",
                    ))
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => ended = [true, true],
                Err(mpsc::RecvTimeoutError::Timeout) => (),
            }
            if ended.iter().all(|x| *x) {
                let reason = connection_error(&text.diagnostic);
                return Err(if reason.code == "SSH" && !text.started {
                    error(
                        "CONNECT",
                        "The SSH connection closed before the request completed.",
                    )
                } else {
                    reason
                });
            }
        }
    }
}
impl Drop for Console {
    fn drop(&mut self) {
        self.abort();
        let _ = self.child.wait();
        // Release bounded senders before joining the readers.
        self.output.take();
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
    }
}

struct TextFrame {
    begin: Vec<u8>,
    end: Vec<u8>,
    pending: Vec<u8>,
    data: Vec<u8>,
    diagnostic: Vec<u8>,
    started: bool,
    done: bool,
}
impl TextFrame {
    fn new(begin: &str, end: &str) -> Self {
        Self {
            begin: begin.as_bytes().to_vec(),
            end: end.as_bytes().to_vec(),
            pending: Vec::new(),
            data: Vec::new(),
            diagnostic: Vec::new(),
            started: false,
            done: false,
        }
    }
    fn feed(&mut self, bytes: &[u8]) -> Result<()> {
        if self.diagnostic.len() + bytes.len() > MAX_TEXT {
            return Err(error(
                "SIZE",
                "The SSH diagnostics exceeded their size limit.",
            ));
        }
        self.diagnostic.extend_from_slice(bytes);
        self.pending.extend_from_slice(bytes);
        while let Some(pos) = self.pending.iter().position(|b| *b == b'\n') {
            let line = &self.pending[..pos];
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if line == self.begin {
                self.started = true;
            } else if self.started && line == self.end {
                self.done = true;
            } else if self.started && !self.done {
                self.data.extend_from_slice(line);
                self.data.push(b'\n');
            }
            self.pending.drain(..=pos);
        }
        Ok(())
    }
}

#[derive(Default)]
struct Chunks {
    pending: Vec<u8>,
    remaining: Option<usize>,
    data: Vec<u8>,
    done: bool,
}
impl Chunks {
    fn feed(&mut self, bytes: &[u8]) -> Result<()> {
        if self.done {
            return Err(error("PROTOCOL", "Unexpected data after the SFTP file."));
        }
        self.pending.extend_from_slice(bytes);
        loop {
            let size = if let Some(size) = self.remaining {
                size
            } else {
                let Some(pos) = self.pending.windows(2).position(|w| w == b"\r\n") else {
                    if self.pending.len() > 8 {
                        return Err(error("PROTOCOL", "Unrecognized SFTP stream header."));
                    }
                    break;
                };
                if pos == 0 || pos > 8 || !self.pending[..pos].iter().all(u8::is_ascii_hexdigit) {
                    return Err(error("PROTOCOL", "Unrecognized SFTP stream header."));
                }
                let size =
                    usize::from_str_radix(std::str::from_utf8(&self.pending[..pos]).unwrap(), 16)
                        .unwrap();
                if size > MAX_FILE - self.data.len() {
                    return Err(error("SIZE", "The remote configuration exceeds 16 MiB."));
                }
                self.pending.drain(..pos + 2);
                self.remaining = Some(size);
                size
            };
            if self.pending.len() < size + 2 {
                break;
            }
            if &self.pending[size..size + 2] != b"\r\n" {
                return Err(error("PROTOCOL", "Unrecognized SFTP stream ending."));
            }
            self.data.extend_from_slice(&self.pending[..size]);
            self.pending.drain(..size + 2);
            self.remaining = None;
            if size == 0 {
                self.done = true;
                if !self.pending.is_empty() {
                    return Err(error("PROTOCOL", "Unexpected data after the SFTP file."));
                }
                break;
            }
        }
        Ok(())
    }
}

pub(crate) fn run(
    operation: &Operation,
    session: &str,
    commands: &[String],
    file: bool,
) -> Result<Vec<u8>> {
    operation.check_cancelled()?;
    let connection = winscp::resolve(session)?;
    let mut slot = operation
        .console
        .lock()
        .map_err(|_| error("PROCESS", "The SSH session manager stopped."))?;
    if slot.as_ref().is_some_and(|s| s.connection != connection) {
        if let Some(mut console) = slot.take() {
            console.close();
        }
    }
    let deadline = Instant::now() + TIMEOUT;
    for attempt in 0..2 {
        operation.check_cancelled()?;
        if slot.as_mut().is_some_and(|s| !s.alive()) {
            slot.take();
        }
        if slot.is_none() {
            *slot = Some(Console::open(connection.clone())?);
        }
        match slot
            .as_mut()
            .unwrap()
            .execute(operation, commands, file, deadline)
        {
            Ok(result) => return Ok(result),
            Err(reason) => {
                slot.take();
                // All reads are repeatable; action starts carry the same server
                // request ID, which the existing root-owned receipt deduplicates.
                if !matches!(reason.code, "CONNECT" | "SSH") || attempt == 1 {
                    return Err(reason);
                }
            }
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_frames_ignore_echoed_markers_and_split_utf8() {
        let bytes = "winscp> echo BEGIN\r\nBEGIN\r\nПример\r\nwinscp> echo END\r\nEND\r\nwinscp> "
            .as_bytes();
        let mut frame = TextFrame::new("BEGIN", "END");
        for byte in bytes {
            frame.feed(&[*byte]).unwrap();
        }
        assert!(frame.started && frame.done);
        let output = String::from_utf8(frame.data).unwrap();
        assert!(output.starts_with("Пример\n"));
        assert!(!output.contains("winscp> echo BEGIN"));
        assert!(!output.lines().any(|line| line == "END"));
    }

    #[test]
    fn text_without_final_marker_is_never_complete_and_is_bounded() {
        let mut frame = TextFrame::new("BEGIN", "END");
        frame.feed(b"BEGIN\npartial\n").unwrap();
        assert!(!frame.done);
        assert!(frame.feed(&vec![b'x'; MAX_TEXT]).is_err());
    }

    #[test]
    fn streamed_files_preserve_binary_content_across_every_boundary() {
        let body = b"8\r\n\x00\xff\r\nJSON\r\n3\r\nend\r\n0\r\n\r\n";
        for boundary in 1..body.len() {
            let mut chunks = Chunks::default();
            chunks.feed(&body[..boundary]).unwrap();
            chunks.feed(&body[boundary..]).unwrap();
            assert!(chunks.done);
            assert_eq!(chunks.data, b"\x00\xff\r\nJSONend");
        }
    }

    #[test]
    fn empty_files_and_large_split_chunks_work() {
        let mut empty = Chunks::default();
        empty.feed(b"0\r\n\r\n").unwrap();
        assert!(empty.done && empty.data.is_empty());
        let mut chunks = Chunks::default();
        chunks.feed(b"10000\r\n").unwrap();
        for _ in 0..8 {
            chunks.feed(&[b'x'; 8192]).unwrap();
        }
        chunks.feed(b"\r\n0\r\n\r\n").unwrap();
        assert!(chunks.done);
        assert_eq!(chunks.data.len(), 65536);
    }

    #[test]
    fn malformed_truncated_oversized_and_extra_file_data_fail_closed() {
        for bytes in [
            b"garbage!!".as_slice(),
            b"1000001\r\n",
            b"1\r\nx!!",
            b"0\r\n\r\nmore",
        ] {
            assert!(Chunks::default().feed(bytes).is_err());
        }
        let mut truncated = Chunks::default();
        truncated.feed(b"4\r\nxx").unwrap();
        assert!(!truncated.done);
        let mut complete = Chunks::default();
        complete.feed(b"0\r\n\r\n").unwrap();
        assert!(complete.feed(b"another file").is_err());
    }
}
