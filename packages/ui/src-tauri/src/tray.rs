use serde::Deserialize;
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Listener, Manager};

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum TrayIconState {
    Normal,
    Amber,
    Red,
}

#[derive(Deserialize)]
struct TrayStateChange {
    icon: TrayIconState,
    #[serde(default)]
    badge: u32,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ConnectorMenuEntry {
    pub name: String,
    pub health: String,
}

fn icon_bytes(state: TrayIconState) -> &'static [u8] {
    match state {
        TrayIconState::Normal => include_bytes!("../icons/tray-normal.png"),
        TrayIconState::Amber => include_bytes!("../icons/tray-amber.png"),
        TrayIconState::Red => include_bytes!("../icons/tray-red.png"),
    }
}

fn health_glyph(h: &str) -> &'static str {
    match h {
        "healthy" => "●",
        "degraded" | "rate_limited" => "◐",
        "error" | "unauthenticated" => "○",
        _ => "·",
    }
}

fn handle_menu_event(app_handle: &AppHandle, id: &str) {
    match id {
        "open-dashboard" => focus_main(app_handle),
        "quick-query" => {
            let _ = crate::quick_query::spawn_or_focus(app_handle);
        }
        "settings" => {
            focus_main(app_handle);
            let _ = app_handle.emit("tray://navigate", "/settings");
        }
        "quit" => app_handle.exit(0),
        _ if id.starts_with("conn:") => {
            let name = id.trim_start_matches("conn:").to_string();
            focus_main(app_handle);
            let _ = app_handle.emit("tray://open-connector", serde_json::json!({ "name": name }));
        }
        _ => {}
    }
}

fn build_menu(
    app: &AppHandle,
    items: &[ConnectorMenuEntry],
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let open = MenuItemBuilder::with_id("open-dashboard", "Open Dashboard").build(app)?;
    let quick = MenuItemBuilder::with_id("quick-query", "Quick Query\tCtrl+Shift+N").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "Settings").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let mut connectors_sub = SubmenuBuilder::new(app, "Connectors");
    for c in items {
        let id = format!("conn:{}", c.name);
        let label = format!("{} {} — {}", health_glyph(&c.health), c.name, c.health);
        let item = MenuItemBuilder::with_id(id, label).build(app)?;
        connectors_sub = connectors_sub.item(&item);
    }
    let connectors_submenu = connectors_sub.build()?;

    MenuBuilder::new(app)
        .item(&open)
        .item(&quick)
        .separator()
        .item(&connectors_submenu)
        .separator()
        .item(&settings)
        .separator()
        .item(&quit)
        .build()
}

#[tauri::command]
pub async fn set_connectors_menu(
    app: AppHandle,
    items: Vec<ConnectorMenuEntry>,
) -> Result<(), String> {
    let menu = build_menu(&app, &items).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("nimbus-tray") {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn init_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app, &[])?;

    #[cfg(target_os = "macos")]
    let icon_is_template = true;
    #[cfg(not(target_os = "macos"))]
    let icon_is_template = false;

    let tray = TrayIconBuilder::with_id("nimbus-tray")
        .icon(Image::from_bytes(if icon_is_template {
            include_bytes!("../icons/tray-template.png")
        } else {
            icon_bytes(TrayIconState::Normal)
        })?)
        .icon_as_template(icon_is_template)
        .menu(&menu)
        .on_menu_event(|app_handle, event| handle_menu_event(app_handle, event.id().as_ref()))
        .on_tray_icon_event(|_icon, _event: TrayIconEvent| {})
        .build(app)?;

    let tray_for_listener = tray.clone();
    app.listen("tray://state-changed", move |event| {
        let Ok(change) = serde_json::from_str::<TrayStateChange>(event.payload()) else {
            return;
        };
        let bytes = icon_bytes(change.icon);
        let _ =
            tray_for_listener.set_icon(Some(Image::from_bytes(bytes).expect("invalid icon bytes")));
        let tooltip = if change.badge > 0 {
            format!("Nimbus ({} pending)", change.badge)
        } else {
            "Nimbus".to_string()
        };
        let _ = tray_for_listener.set_tooltip(Some(tooltip));
    });

    Ok(())
}

fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
