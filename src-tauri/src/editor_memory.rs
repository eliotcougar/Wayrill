//! Keep the document alive while requesting a smaller WebView2 working set.
use serde_json::json;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use wayrill_protocol::{ApiError, Message};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
};
use windows::core::Interface;

#[derive(Default)]
pub struct EditorMemory(Mutex<State>);

#[derive(Default)]
struct State {
    backgrounded: bool,
    deferred: Option<Message>,
}

fn emit(app: &AppHandle, message: Message) {
    let _ = app.emit("wayrill-service-event", message);
}

pub fn forward(app: &AppHandle, message: Message) {
    let editor = app.clone();
    let _ = app.run_on_main_thread(move || {
        crate::tray::message(&editor, &message);
        let memory = editor.state::<EditorMemory>();
        let connected = matches!(message, Message::Response { ok: true, .. });
        let deferred = {
            let mut state = memory.0.lock().unwrap();
            match &message {
                Message::Event { kind, .. } if kind == "service.snapshot" && state.backgrounded => {
                    state.deferred = Some(message);
                    return;
                }
                Message::Event { kind, .. } if kind == "core.log" => None,
                Message::Response { .. } => {
                    state.deferred = None;
                    None
                }
                // State events advance the renderer's cursor. Deliver any older
                // deferred snapshot before them so it can still be applied.
                _ => state.deferred.take(),
            }
        };
        if connected {
            let _ = editor.emit("wayrill-service-transport", json!({"connected":true}));
        }
        if let Some(snapshot) = deferred {
            emit(&editor, snapshot);
        }
        emit(&editor, message);
    });
}

pub fn disconnected(app: &AppHandle, error: Option<ApiError>) {
    let editor = app.clone();
    let _ = app.run_on_main_thread(move || {
        editor.state::<EditorMemory>().0.lock().unwrap().deferred = None;
        crate::tray::disconnected(&editor);
        let _ = editor.emit(
            "wayrill-service-transport",
            json!({"connected":false,"error":error}),
        );
    });
}

/// Called on the UI thread before issuing a tray command to the renderer.
pub fn flush(app: &AppHandle) {
    let snapshot = app
        .state::<EditorMemory>()
        .0
        .lock()
        .unwrap()
        .deferred
        .take();
    if let Some(snapshot) = snapshot {
        emit(app, snapshot);
    }
}

pub fn refresh(window: &WebviewWindow) {
    let editor = window.clone();
    let _ = window.app_handle().run_on_main_thread(move || {
        // Read actual native state on the UI thread, in order with hide/show.
        let low = editor.is_minimized().unwrap_or(false) || editor.is_visible().ok() == Some(false);
        let memory = editor.state::<EditorMemory>();
        let changed = {
            let mut state = memory.0.lock().unwrap();
            std::mem::replace(&mut state.backgrounded, low) != low
        };
        if !changed {
            return;
        }
        let target = if low {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
        } else {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
        };
        let _ = editor.with_webview(move |view| {
            // SAFETY: Tauri supplies the live controller on its owning UI thread.
            let Ok(webview) = (unsafe { view.controller().CoreWebView2() }) else {
                return;
            };
            // Older WebView2 runtimes can still run the editor without this hint.
            if let Ok(webview) = webview.cast::<ICoreWebView2_19>() {
                // SAFETY: the interface is live on its owning thread and the target is a valid enum.
                if let Err(error) = unsafe { webview.SetMemoryUsageTargetLevel(target) } {
                    wayrill_diagnostics::log(
                        "desktop",
                        "warning",
                        &format!("WebView memory target: {error}"),
                    );
                }
            }
        });
        if !low {
            // Wry holds its WebView lock during with_webview; event emission
            // evaluates JavaScript and needs the same dispatcher afterward.
            flush(editor.app_handle());
        }
    });
}
