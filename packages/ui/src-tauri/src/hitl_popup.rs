use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "hitl-popup";

pub fn open_or_focus(app: &AppHandle) -> Result<(), tauri::Error> {
    if let Some(win) = app.get_webview_window(LABEL) {
        win.show()?;
        win.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html#/hitl-popup".into()))
        .title("Nimbus — Approve action")
        .inner_size(480.0, 360.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .build()?;
    Ok(())
}

pub fn close(app: &AppHandle) -> Result<(), tauri::Error> {
    if let Some(win) = app.get_webview_window(LABEL) {
        win.close()?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_hitl_popup(app: AppHandle) -> Result<(), String> {
    open_or_focus(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn close_hitl_popup(app: AppHandle) -> Result<(), String> {
    close(&app).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn label_is_hitl_popup() {
        assert_eq!(super::LABEL, "hitl-popup");
    }
}
