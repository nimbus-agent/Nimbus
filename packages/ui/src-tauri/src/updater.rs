use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Listener, Manager, State};

pub struct ApplyTracker {
    pub apply_in_flight: Arc<AtomicBool>,
}

impl ApplyTracker {
    pub fn new() -> Self {
        Self {
            apply_in_flight: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[tauri::command]
pub async fn updater_apply_started(
    app: AppHandle,
    tracker: State<'_, ApplyTracker>,
) -> Result<(), String> {
    tracker.apply_in_flight.store(true, Ordering::SeqCst);
    let _ = app.emit("updater://restart-started", ());
    Ok(())
}

#[tauri::command]
pub async fn updater_apply_finished(tracker: State<'_, ApplyTracker>) -> Result<(), String> {
    tracker.apply_in_flight.store(false, Ordering::SeqCst);
    Ok(())
}

pub fn install_listener(app: &AppHandle) {
    let app_for_handler = app.clone();
    app.listen("gateway://connection-state", move |evt| {
        let payload = evt.payload();
        
        let stripped = payload.trim_matches('"');
        if stripped != "connected" {
            return;
        }
        let tracker = match app_for_handler.try_state::<ApplyTracker>() {
            Some(t) => t,
            None => return,
        };
        
        if tracker.apply_in_flight.swap(false, Ordering::SeqCst) {
            let _ = app_for_handler.emit("updater://restart-complete", ());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracker_is_initially_idle() {
        let t = ApplyTracker::new();
        assert!(!t.apply_in_flight.load(Ordering::SeqCst));
    }

    #[test]
    fn tracker_swap_returns_prior_then_clears() {
        let t = ApplyTracker::new();
        t.apply_in_flight.store(true, Ordering::SeqCst);
        let prior = t.apply_in_flight.swap(false, Ordering::SeqCst);
        assert!(prior);
        assert!(!t.apply_in_flight.load(Ordering::SeqCst));
    }

    #[test]
    fn tracker_swap_when_idle_returns_false() {
        let t = ApplyTracker::new();
        let prior = t.apply_in_flight.swap(false, Ordering::SeqCst);
        assert!(!prior);
    }
}
