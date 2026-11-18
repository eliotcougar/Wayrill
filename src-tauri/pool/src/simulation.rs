use crate::pool_access::{self, Source};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent};
use wayrill_protocol::ApiError;

const WINDOW: &str = "pool-simulation";

#[derive(Clone, Deserialize, Serialize)]
pub struct Setup {
    user: String,
    source: Source,
}

#[derive(Default)]
pub struct Invitation(Mutex<Option<Setup>>);

fn simulation_only(window: &WebviewWindow) -> Result<(), &'static str> {
    if window.label() == WINDOW {
        Ok(())
    } else {
        Err("Open a Pool simulation first.")
    }
}

#[tauri::command]
pub async fn pool_simulation_open(window: WebviewWindow, setup: Setup) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Open the simulation from Pool administration.".into());
    }
    setup.source.parts().map_err(|error| error.message)?;
    let app = window.app_handle();
    if let Some(existing) = app.get_webview_window(WINDOW) {
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Err("Close the open simulation to test another invitation.".into());
    }
    let state = app.state::<Invitation>();
    {
        let mut pending = state
            .0
            .lock()
            .map_err(|_| "Pool simulation is unavailable.")?;
        if pending.is_some() {
            return Err("A Pool simulation is opening.".into());
        }
        *pending = Some(setup);
    }
    let result =
        WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("pool-preview.html".into()))
            .title("Wayrill · Pool simulation")
            .inner_size(1160.0, 760.0)
            .min_inner_size(720.0, 540.0)
            .center()
            .build();
    if let Err(error) = result {
        *state
            .0
            .lock()
            .map_err(|_| "Pool simulation is unavailable.")? = None;
        return Err(format!("Could not open the Pool simulation: {error}"));
    }
    Ok(())
}

pub fn window_event(window: &Window, event: &WindowEvent) {
    if window.label() == WINDOW && matches!(event, WindowEvent::Destroyed) {
        if let Ok(mut setup) = window.state::<Invitation>().0.lock() {
            *setup = None;
        }
    }
}

#[tauri::command]
pub fn pool_simulation_invitation(window: WebviewWindow) -> Result<Setup, String> {
    simulation_only(&window)?;
    window
        .state::<Invitation>()
        .0
        .lock()
        .map_err(|_| "Pool simulation is unavailable.")?
        .clone()
        .ok_or_else(|| "The simulation has no invitation.".into())
}

#[tauri::command]
pub async fn pool_simulation_download(
    window: WebviewWindow,
    source: Source,
) -> Result<Value, ApiError> {
    simulation_only(&window).map_err(|error| ApiError::new("POOL", error))?;
    tauri::async_runtime::spawn_blocking(move || {
        let recipient = source.parts()?.0;
        let text = pool_access::download_if_changed(&source, None)?
            .text
            .ok_or_else(|| ApiError::new("POOL", "No Pool publication was returned."))?;
        let (bundle, _, digest) = pool_access::publication(&text)?;
        Ok(json!({ "bundle": bundle, "digest": digest, "recipient": recipient }))
    })
    .await
    .map_err(|_| ApiError::new("POOL", "The invitation download ended unexpectedly."))?
}

#[tauri::command]
pub async fn pool_simulation_route(
    window: WebviewWindow,
    method: String,
    params: Value,
) -> Result<Value, ApiError> {
    simulation_only(&window).map_err(|error| ApiError::new("POOL", error))?;
    match method.as_str() {
        "routing.diagnosticStart" if params["mode"] == "route" => {}
        "routing.diagnosticGet" | "routing.diagnosticCancel" => {}
        _ => {
            return Err(ApiError::new(
                "POOL",
                "Simulation supports route evaluation only.",
            ))
        }
    }
    wayrill_ipc::windows::request(&method, params).await
}
