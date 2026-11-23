//! Desktop shutdown is independent of the networking service.
use std::sync::{Mutex, MutexGuard};
use tauri::{Emitter, Manager, WebviewWindow};

const EXIT_EVENT: &str = "wayrill-desktop-exit";
type Attempt = u32;

#[derive(Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Idle,
    Saving(Attempt),
    Prompting(Attempt),
    Waiting(Attempt),
    Closing(Attempt),
    Closed,
}

#[derive(Default)]
struct Exit {
    phase: Phase,
    sequence: Attempt,
    renderer_ready: bool,
}

impl Exit {
    fn request(&mut self) -> Option<Attempt> {
        let attempt = match self.phase {
            Phase::Idle => {
                self.sequence += 1;
                self.sequence
            }
            // The user declined a forced close. Another request can offer it
            // again, while the renderer continues saving for the same attempt.
            Phase::Waiting(attempt) => attempt,
            _ => return None,
        };
        self.phase = Phase::Saving(attempt);
        Some(attempt)
    }

    fn pending(&self) -> Option<Attempt> {
        match self.phase {
            Phase::Saving(attempt) | Phase::Prompting(attempt) | Phase::Waiting(attempt) => {
                Some(attempt)
            }
            _ => None,
        }
    }

    fn prompt(&mut self, attempt: Attempt) -> bool {
        if self.phase != Phase::Saving(attempt) {
            return false;
        }
        self.phase = Phase::Prompting(attempt);
        true
    }

    fn prompt_reply(&mut self, attempt: Attempt, close: bool) -> bool {
        if self.phase != Phase::Prompting(attempt) {
            return false;
        }
        self.phase = if close {
            Phase::Closing(attempt)
        } else {
            Phase::Waiting(attempt)
        };
        true
    }

    fn saved(&mut self, attempt: Attempt, ok: bool) -> bool {
        if self.pending() != Some(attempt) {
            return false;
        }
        self.phase = if ok {
            Phase::Closing(attempt)
        } else {
            Phase::Idle
        };
        true
    }

    fn destroy_failed(&mut self, attempt: Attempt) {
        if self.phase == Phase::Closing(attempt) {
            self.phase = Phase::Idle;
        }
    }
}

#[derive(Default)]
pub struct Shutdown {
    exit: Mutex<Exit>,
    events: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl Shutdown {
    fn exit(&self) -> MutexGuard<'_, Exit> {
        self.exit.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn start_events(&self, task: impl FnOnce() -> tauri::async_runtime::JoinHandle<()>) {
        let mut events = self.events.lock().unwrap_or_else(|e| e.into_inner());
        if events.is_none() {
            *events = Some(task());
        }
    }

    pub fn stop(&self) {
        self.exit().phase = Phase::Closed;
        if let Some(task) = self.events.lock().unwrap_or_else(|e| e.into_inner()).take() {
            task.abort();
        }
    }
}

fn destroy(
    app: &tauri::AppHandle,
    window: Option<WebviewWindow>,
    attempt: Attempt,
) -> Result<(), String> {
    let result = window
        .ok_or_else(|| "Cannot find the Wayrill window.".to_owned())
        .and_then(|window| window.destroy().map_err(|error| error.to_string()));
    if let Err(error) = &result {
        app.state::<Shutdown>().exit().destroy_failed(attempt);
        wayrill_diagnostics::log("shutdown", "error", error);
    }
    result
}

#[tauri::command]
pub fn desktop_close_complete(
    app: tauri::AppHandle,
    attempt: Attempt,
    error: Option<String>,
) -> Result<bool, String> {
    if !app
        .state::<Shutdown>()
        .exit()
        .saved(attempt, error.is_none())
    {
        return Ok(false);
    }
    if let Some(error) = error {
        crate::tray::show(&app);
        wayrill_diagnostics::log(
            "shutdown",
            "error",
            &format!("Save-on-close failed: {error}"),
        );
    } else {
        destroy(&app, app.get_webview_window("main"), attempt)?;
    }
    Ok(true)
}

// A close request can precede renderer startup or registration of the listener.
#[tauri::command]
pub fn desktop_ready(app: tauri::AppHandle) -> Result<(), String> {
    let attempt = {
        let state = app.state::<Shutdown>();
        let mut exit = state.exit();
        exit.renderer_ready = true;
        exit.pending()
    };
    if let Some(attempt) = attempt {
        app.emit_to("main", EXIT_EVENT, attempt)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_exit(app: tauri::AppHandle) -> Result<(), String> {
    crate::tray::show(&app);
    let window = app
        .get_webview_window("main")
        .ok_or("Cannot find the Wayrill window.")?;
    let (attempt, renderer_ready) = {
        let state = app.state::<Shutdown>();
        let mut exit = state.exit();
        let Some(attempt) = exit.request() else {
            return Ok(());
        };
        (attempt, exit.renderer_ready)
    };
    if renderer_ready {
        if let Err(error) = app.emit_to("main", EXIT_EVENT, attempt) {
            wayrill_diagnostics::log("shutdown", "error", &error.to_string());
        }
    }
    wayrill_diagnostics::log(
        "shutdown",
        "info",
        "Close requested; waiting for saved documents.",
    );
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
        if !app.state::<Shutdown>().exit().prompt(attempt) {
            return;
        }
        let owner = window.hwnd().ok().map(|handle| handle.0 as usize);
        let close = if let Some(owner) = owner {
            wayrill_diagnostics::log(
                "shutdown",
                "warning",
                "Save-on-close has not completed; offering native recovery.",
            );
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if app.state::<Shutdown>().exit().phase != Phase::Prompting(attempt) {
                    return false;
                }
                force_close_prompt(owner)
            })
            .await
            .unwrap_or(false)
        } else {
            false
        };
        if !app.state::<Shutdown>().exit().prompt_reply(attempt, close) {
            return;
        }
        if close {
            wayrill_diagnostics::log(
                "shutdown",
                "warning",
                "User chose to close using the last saved documents.",
            );
            let _ = destroy(&app, Some(window), attempt);
        }
    });
    Ok(())
}

fn force_close_prompt(owner: usize) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    let message: Vec<u16> = "Wayrill has not finished saving and closing.\n\nClose using the last saved graph and Stash? Unsaved changes will be lost.\n\nChoose No to keep waiting.\0".encode_utf16().collect();
    let title: Vec<u16> = "Close Wayrill\0".encode_utf16().collect();
    // SAFETY: fixed, terminated UTF-16 strings and a borrowed app-owned HWND.
    unsafe {
        MessageBoxW(
            owner as _,
            message.as_ptr(),
            title.as_ptr(),
            MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2,
        ) == IDYES
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declining_force_close_keeps_the_same_save_in_progress() {
        let mut exit = Exit::default();
        let attempt = exit.request().unwrap();
        assert!(exit.prompt(attempt));
        assert_eq!(exit.request(), None);
        assert!(exit.prompt_reply(attempt, false));
        assert_eq!(exit.request(), Some(attempt));
        assert!(exit.saved(attempt, true));
        assert_eq!(exit.request(), None);
        assert!(!exit.prompt(attempt));
    }

    #[test]
    fn a_stale_renderer_or_prompt_cannot_complete_a_new_attempt() {
        let mut exit = Exit::default();
        let first = exit.request().unwrap();
        assert!(exit.prompt(first));
        assert!(exit.saved(first, false));
        let second = exit.request().unwrap();
        assert!(!exit.saved(first, true));
        assert!(!exit.saved(first, false));
        assert!(!exit.prompt_reply(first, true));
        assert_eq!(exit.pending(), Some(second));
        assert!(exit.saved(second, true));
    }

    #[test]
    fn forced_close_wins_over_late_save_and_destroy_failure_allows_retry() {
        let mut exit = Exit::default();
        let attempt = exit.request().unwrap();
        assert!(exit.prompt(attempt));
        assert!(exit.prompt_reply(attempt, true));
        assert!(!exit.saved(attempt, true));
        assert!(!exit.saved(attempt, false));
        exit.destroy_failed(attempt);
        assert_ne!(exit.request(), Some(attempt));
    }
}
