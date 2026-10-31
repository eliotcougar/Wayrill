//! Launch the normal-user desktop without inheriting browser/native-message handles.
use std::{
    ffi::OsStr,
    io,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr,
};
use windows_sys::Win32::{
    Foundation::CloseHandle,
    System::Threading::{CreateProcessW, CREATE_NO_WINDOW, PROCESS_INFORMATION, STARTUPINFOW},
};

pub fn locate(directory: &Path, program_files: Option<&OsStr>) -> Option<PathBuf> {
    [
        directory.join("wayrill.exe"),
        directory.parent().unwrap_or(directory).join("wayrill.exe"),
    ]
    .into_iter()
    .chain(program_files.map(|root| Path::new(root).join("Wayrill/wayrill.exe")))
    .find(|path| path.is_file())
}

fn command_line(exe: &Path, args: &[&str]) -> Vec<u16> {
    let mut line = Vec::new();
    for argument in std::iter::once(exe.as_os_str()).chain(args.iter().map(OsStr::new)) {
        if !line.is_empty() {
            line.push(b' ' as u16);
        }
        line.push(b'"' as u16);
        let mut slashes = 0;
        for ch in argument.encode_wide() {
            if ch == b'\\' as u16 {
                slashes += 1;
                continue;
            }
            line.extend(std::iter::repeat_n(
                b'\\' as u16,
                if ch == b'"' as u16 {
                    slashes * 2 + 1
                } else {
                    slashes
                },
            ));
            line.push(ch);
            slashes = 0;
        }
        line.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
        line.push(b'"' as u16);
    }
    line.push(0);
    line
}

pub fn launch(exe: &Path, args: &[&str]) -> io::Result<()> {
    let app: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut line = command_line(exe, args);
    let startup = STARTUPINFOW {
        cb: size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut process = PROCESS_INFORMATION::default();
    // SAFETY: application/argv are live, NUL-terminated buffers; the command line
    // is writable and both structures are initialized for this synchronous call.
    // FALSE for handle inheritance is essential: replacing only stdio still leaks
    // other inheritable browser pipes. Stable std::process cannot disable it.
    if unsafe {
        CreateProcessW(
            app.as_ptr(),
            line.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0,
            CREATE_NO_WINDOW,
            ptr::null(),
            ptr::null(),
            &startup,
            &mut process,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful CreateProcess returned these owned handles. Closing our
    // references leaves the independent GUI running; no process is terminated.
    unsafe {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    Ok(())
}
