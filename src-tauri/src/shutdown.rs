//! Desktop shutdown is independent of the networking service.
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use tauri::{Emitter, Manager};

const EXIT_EVENT: &str = "wayrill-desktop-exit";

#[derive(Default)]
pub struct Shutdown {
    attempt: AtomicU64,
    exiting: AtomicBool,
    ready: AtomicBool,
    events: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}
impl Shutdown {
    pub fn start_events(&self, task: impl FnOnce() -> tauri::async_runtime::JoinHandle<()>) {
        let mut events = self.events.lock().unwrap_or_else(|e| e.into_inner());
        if events.is_none() {
            *events = Some(task());
        }
    }
    fn begin_exit(&self) -> Option<u64> {
        if self.exiting.swap(true, Ordering::SeqCst) {
            return None;
        }
        Some(self.attempt.fetch_add(1, Ordering::SeqCst) + 1)
    }
    fn is_current(&self, attempt: u64) -> bool {
        self.exiting.load(Ordering::SeqCst) && self.attempt.load(Ordering::SeqCst) == attempt
    }
    pub fn cancel(&self) {
        self.attempt.fetch_add(1, Ordering::SeqCst);
        self.exiting.store(false, Ordering::SeqCst);
    }
    pub fn stop(&self) {
        self.cancel();
        if let Some(task) = self.events.lock().unwrap_or_else(|e| e.into_inner()).take() {
            task.abort();
        }
    }
}

#[tauri::command]
pub fn desktop_close_cancel(app: tauri::AppHandle, message: String) {
    app.state::<Shutdown>().cancel();
    crate::tray::show(&app);
    wayrill_diagnostics::log(
        "shutdown",
        "error",
        &format!("Save-on-close failed: {message}"),
    );
}

// Register after the renderer's listener so a tray/installer exit during
// startup cannot lose the save request. Duplicate deliveries are coalesced
// by the renderer, and duplicate native requests do not start more timers.
#[tauri::command]
pub fn desktop_ready(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Shutdown>();
    state.ready.store(true, Ordering::SeqCst);
    if state.exiting.load(Ordering::SeqCst) {
        app.emit_to("main", EXIT_EVENT, ())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_exit(app: tauri::AppHandle) -> Result<(), String> {
    crate::tray::show(&app);
    let state = app.state::<Shutdown>();
    let Some(attempt) = state.begin_exit() else {
        return Ok(());
    };
    let Some(window) = app.get_webview_window("main") else {
        state.cancel();
        return Err("Cannot find the Wayrill window.".into());
    };
    if state.ready.load(Ordering::SeqCst) {
        if let Err(error) = app.emit_to("main", EXIT_EVENT, ()) {
            state.cancel();
            return Err(error.to_string());
        }
    }
    let label = window.label().to_owned();
    wayrill_diagnostics::log(
        "shutdown",
        "info",
        "Close requested; waiting for saved documents.",
    );
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
        if !app.state::<Shutdown>().is_current(attempt) {
            return;
        }
        let Some(window) = app.get_webview_window(&label) else {
            return;
        };
        let Ok(owner) = window.hwnd() else {
            return;
        };
        let owner = owner.0 as usize;
        wayrill_diagnostics::log(
            "shutdown",
            "warning",
            "Save-on-close has not completed; offering native recovery.",
        );
        // The renderer may have crashed: this prompt must not depend on JavaScript.
        // Never discard an edit or kill the desktop automatically.
        let close = tauri::async_runtime::spawn_blocking(move || {
            use windows_sys::Win32::UI::WindowsAndMessaging::*;
            let message: Vec<u16> = "Wayrill has not finished saving and closing.\n\nClose using the last saved graph and Stash? Unsaved changes will be lost.\n\nChoose No to keep waiting.\0".encode_utf16().collect();
            let title: Vec<u16> = "Close Wayrill\0".encode_utf16().collect();
            // SAFETY: fixed, terminated UTF-16 strings and a borrowed app-owned HWND.
            unsafe { MessageBoxW(owner as _, message.as_ptr(), title.as_ptr(), MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2) == IDYES }
        }).await.unwrap_or(false);
        if !app.state::<Shutdown>().is_current(attempt) {
            return;
        }
        if close {
            wayrill_diagnostics::log(
                "shutdown",
                "warning",
                "User chose to close using the last saved documents.",
            );
            if let Err(error) = window.destroy() {
                wayrill_diagnostics::log("shutdown", "error", &error.to_string());
            }
        } else {
            app.state::<Shutdown>().cancel();
            wayrill_diagnostics::log(
                "shutdown",
                "info",
                "Close recovery declined; window remains open.",
            );
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_exit_requests_share_one_save_and_recovery_attempt() {
        let state = Shutdown::default();
        let first = state.begin_exit().unwrap();
        assert!(state.is_current(first));
        assert_eq!(state.begin_exit(), None);
        state.cancel();
        assert!(!state.is_current(first));
        let second = state.begin_exit().unwrap();
        assert_ne!(first, second);
        assert!(state.is_current(second));
    }

    #[test]
    fn window_destruction_invalidates_pending_native_recovery() {
        let state = Shutdown::default();
        let attempt = state.begin_exit().unwrap();
        state.stop();
        assert!(!state.is_current(attempt));
    }
}
