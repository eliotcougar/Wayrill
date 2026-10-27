//! Service-backed routing controls remain available while the desktop is hidden.
mod icon;
mod quick_switch;
mod state;
use icon::Icons;
use state::{Action, Model};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use wayrill_protocol::{ApiError, Message};

pub const ID: &str = "wayrill";
struct Controller {
    model: Mutex<Model>,
    status: MenuItem<tauri::Wry>,
    start: MenuItem<tauri::Wry>,
    stop: MenuItem<tauri::Wry>,
    replace: Submenu<tauri::Wry>,
    quick: Mutex<quick_switch::State>,
    icons: Icons,
}
pub fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        for result in [window.show(), window.unminimize(), window.set_focus()] {
            if let Err(error) = result {
                wayrill_diagnostics::log("desktop", "error", &error.to_string());
            }
        }
    }
}
fn render(app: &tauri::AppHandle) {
    let target = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let Some(controller) = target.try_state::<Controller>() else {
            return;
        };
        let (view, can_switch) = {
            let model = controller.model.lock().unwrap_or_else(|e| e.into_inner());
            (model.view(), model.can_switch())
        };
        let quick_enabled = controller
            .quick
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .view
            .enabled();
        // Never hold the state lock while entering Tauri's main-thread APIs.
        let Some(tray) = target.tray_by_id(ID) else {
            return;
        };
        for result in [
            controller.status.set_text(view.label),
            controller.start.set_enabled(view.start),
            controller.stop.set_enabled(view.stop),
            controller.replace.set_enabled(can_switch && quick_enabled),
            tray.set_icon(Some(controller.icons.get(view.shade))),
            tray.set_tooltip(Some(format!(
                "Wayrill {}\n{}",
                target.package_info().version,
                view.label
            ))),
        ] {
            if let Err(error) = result {
                wayrill_diagnostics::log("tray", "error", &error.to_string());
            }
        }
    }) {
        wayrill_diagnostics::log("tray", "error", &error.to_string());
    }
}

#[tauri::command]
pub(crate) async fn tray_quick_switch(
    app: tauri::AppHandle,
    view: quick_switch::View,
) -> Result<(), String> {
    view.validate()?;
    let (send, receive) = tokio::sync::oneshot::channel();
    let target = app.clone();
    app.run_on_main_thread(move || {
        let _ = send.send(configure_quick_switch(&target, view).map_err(|e| e.to_string()));
    })
    .map_err(|e| e.to_string())?;
    receive
        .await
        .map_err(|_| "Could not update the tray menu.".to_owned())?
}

fn configure_quick_switch(app: &tauri::AppHandle, view: quick_switch::View) -> tauri::Result<()> {
    let Some(controller) = app.try_state::<Controller>() else {
        return Ok(());
    };
    let generation = {
        let quick = controller.quick.lock().unwrap_or_else(|e| e.into_inner());
        if quick.view == view {
            return Ok(());
        }
        quick.generation + 1
    };
    // Build items before changing the visible menu. The old generation stays
    // authoritative until all native operations finish on this same UI thread.
    let items = view
        .entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            MenuItem::with_id(
                app,
                format!("replace-{generation}-{index}"),
                quick_switch::label(&entry.label),
                entry.available,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let browse = MenuItem::with_id(
        app,
        format!("replace-{generation}-stash"),
        "Select from Stash…",
        true,
        None::<&str>,
    )?;
    controller.replace.set_enabled(false)?;
    while controller.replace.remove_at(0)?.is_some() {}
    for item in &items {
        controller.replace.append(item)?;
    }
    if !items.is_empty() {
        controller
            .replace
            .append(&PredefinedMenuItem::separator(app)?)?;
    }
    controller.replace.append(&browse)?;
    *controller.quick.lock().unwrap_or_else(|e| e.into_inner()) =
        quick_switch::State { generation, view };
    render(app);
    Ok(())
}

fn choose_outbound(app: &tauri::AppHandle, id: &str) {
    let Some(controller) = app.try_state::<Controller>() else {
        return;
    };
    if !controller
        .model
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .can_switch()
    {
        return;
    }
    let selection = controller
        .quick
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .selection(id);
    let Some(selection) = selection else {
        return;
    };
    if id.ends_with("-stash") {
        show(app);
    }
    if let Err(error) = app.emit_to("main", "wayrill-tray-replace", selection) {
        wayrill_diagnostics::log("tray", "error", &error.to_string());
        show(app);
    }
}
fn update(app: &tauri::AppHandle, change: impl FnOnce(&mut Model)) {
    let Some(controller) = app.try_state::<Controller>() else {
        return;
    };
    let changed = {
        let mut model = controller.model.lock().unwrap_or_else(|e| e.into_inner());
        let old = model.view();
        change(&mut model);
        old != model.view()
    };
    if changed {
        render(app);
    }
}
pub fn message(app: &tauri::AppHandle, message: &Message) {
    update(app, |m| m.message(message));
}
pub fn disconnected(app: &tauri::AppHandle) {
    update(app, Model::disconnected);
}

fn routing(app: &tauri::AppHandle, action: Action) {
    let mut request = None;
    update(app, |m| request = m.begin(action));
    let Some((revision, epoch)) = request else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let params = if action == Action::Start {
            serde_json::json!({"revision":revision})
        } else {
            serde_json::json!({})
        };
        let result = crate::service_request(action.method().into(), params).await;
        if let Ok(snapshot) = &result {
            update(&app, |m| m.finish(epoch, Some(snapshot)));
        } else {
            // A lost reply is not permission to repeat a mutation. Reconcile
            // once, without replacing any newer event or reconnect snapshot.
            let mut refresh_epoch = 0;
            update(&app, |m| refresh_epoch = m.epoch());
            let refreshed =
                crate::service_request("service.status".into(), serde_json::json!({})).await;
            update(&app, |m| {
                if refreshed.is_err() && m.epoch() == refresh_epoch {
                    m.disconnected();
                }
                m.finish(refresh_epoch, refreshed.as_ref().ok());
            });
        }
        if let Err(error) = result {
            report_error(&app, action, error).await;
        }
    });
}
async fn report_error(app: &tauri::AppHandle, action: Action, error: ApiError) {
    wayrill_diagnostics::log(
        "tray",
        "error",
        &format!("{} ({}): {}", action.label(), error.code, error.message),
    );
    show(app);
    let Some(owner) = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as usize)
    else {
        return;
    };
    let message = format!(
        "{} failed ({}).\n\n{}",
        action.label(),
        error.code,
        error.message
    );
    let _ = tauri::async_runtime::spawn_blocking(move || {
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        let text: Vec<u16> = message
            .replace('\0', " ")
            .chars()
            .take(4096)
            .collect::<String>()
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let title: Vec<u16> = "Wayrill\0".encode_utf16().collect();
        // SAFETY: fixed/terminated UTF-16 buffers live through the modal call;
        // the borrowed HWND identifies the app window, not the host service.
        unsafe {
            MessageBoxW(
                owner as _,
                text.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    })
    .await;
}

pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "Show Wayrill", true, None::<&str>)?;
    let status = MenuItem::with_id(
        app,
        "routing-state",
        "Connecting to service…",
        false,
        None::<&str>,
    )?;
    let start = MenuItem::with_id(app, "start-routing", "Start routing", false, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop-routing", "Stop routing", false, None::<&str>)?;
    let replace = Submenu::with_id_and_items(
        app,
        "replace-main",
        "Replace",
        false,
        &[&MenuItem::with_id(
            app,
            "replace-0-stash",
            "Select from Stash…",
            false,
            None::<&str>,
        )?],
    )?;
    let close = MenuItem::with_id(app, "close", "Close Wayrill", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &PredefinedMenuItem::separator(app)?,
            &status,
            &start,
            &stop,
            &replace,
            &PredefinedMenuItem::separator(app)?,
            &close,
        ],
    )?;
    let base = app
        .default_window_icon()
        .ok_or_else(|| std::io::Error::other("The Wayrill tray icon is missing."))?;
    let icons = Icons::new(base);
    TrayIconBuilder::with_id(ID)
        .icon(icons.get(state::Shade::Offline))
        .tooltip(format!(
            "Wayrill {}\nConnecting to service…",
            app.package_info().version
        ))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show(app),
            "start-routing" => routing(app, Action::Start),
            "stop-routing" => routing(app, Action::Stop),
            "close" => {
                if let Err(error) = crate::shutdown::desktop_exit(app.clone()) {
                    wayrill_diagnostics::log("shutdown", "error", &error);
                }
            }
            id if id.starts_with("replace-") => choose_outbound(app, id),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show(tray.app_handle());
            }
        })
        .build(app)?;
    app.manage(Controller {
        model: Mutex::new(Model::default()),
        status,
        start,
        stop,
        replace,
        quick: Mutex::new(quick_switch::State::default()),
        icons,
    });
    Ok(())
}
