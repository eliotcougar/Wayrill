use std::ptr;
use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

const RELEASES: &str = "https://github.com/eliotcougar/Wayrill/releases";

#[tauri::command]
pub fn open_release_page(tag: Option<String>) -> Result<(), String> {
    let page = match tag {
        None => RELEASES.to_owned(),
        Some(tag) => {
            let version = tag.strip_prefix('v').unwrap_or(&tag);
            if tag.len() > 256
                || !version.starts_with(|c: char| c.is_ascii_digit())
                || !version
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b".-+".contains(&c))
            {
                return Err("Invalid Wayrill release tag.".into());
            }
            format!("{RELEASES}/tag/{tag}")
        }
    };
    let page: Vec<u16> = page.encode_utf16().chain(Some(0)).collect();
    // This synchronous command runs on the desktop event thread. The shell
    // opens only HTTPS pages under the project's fixed release path.
    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            windows::core::w!("open").as_ptr(),
            page.as_ptr(),
            ptr::null(),
            ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        return Err("Windows could not open the GitHub release page.".into());
    }
    Ok(())
}
