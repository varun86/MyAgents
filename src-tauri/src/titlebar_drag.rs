#[cfg(target_os = "macos")]
use crate::ulog_warn;
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSApp, NSEvent, NSEventType, NSWindow};
#[cfg(target_os = "macos")]
use objc2_foundation::{MainThreadMarker, NSInteger, NSTimeInterval};
#[cfg(target_os = "macos")]
use tauri::{Runtime, WebviewWindow};

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn cmd_macos_safe_drag_window(window: tauri::WebviewWindow) -> Result<(), String> {
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            if let Err(error) = perform_safe_drag(&target) {
                ulog_warn!("[titlebar] macOS safe drag skipped: {}", error);
            }
        })
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn cmd_macos_safe_drag_window(_window: tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn perform_safe_drag<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let ns_window_ptr = window.ns_window().map_err(|e| e.to_string())?;
    if ns_window_ptr.is_null() {
        return Err("ns_window() returned null".to_string());
    }

    // SAFETY: this function only runs through `run_on_main_thread`; the
    // NSWindow pointer belongs to the live Tauri WebviewWindow and is used
    // synchronously without escaping this function.
    let ns_window: &NSWindow = unsafe { &*(ns_window_ptr as *const NSWindow) };
    let mtm = unsafe { MainThreadMarker::new_unchecked() };
    let app = NSApp(mtm);
    let source_event = app.currentEvent().or_else(|| ns_window.currentEvent());
    let drag_event = match source_event {
        Some(event) if is_reusable_drag_event(&event) => event,
        _ => synthesize_left_mouse_down(ns_window)
            .ok_or_else(|| "failed to synthesize left-mouse-down drag event".to_string())?,
    };

    ns_window.performWindowDragWithEvent(&drag_event);
    Ok(())
}

#[cfg(target_os = "macos")]
fn is_reusable_drag_event(event: &NSEvent) -> bool {
    is_reusable_drag_event_type(event.r#type())
}

#[cfg(target_os = "macos")]
fn is_reusable_drag_event_type(event_type: NSEventType) -> bool {
    event_type == NSEventType::LeftMouseDown
}

#[cfg(target_os = "macos")]
fn synthesize_left_mouse_down(window: &NSWindow) -> Option<Retained<NSEvent>> {
    // `currentEvent` can be a key, system, or tracking event by the time this
    // command reaches AppKit. Mouse-only selectors such as `clickCount` throw
    // Objective-C exceptions for those event types, which aborts the process.
    let timestamp: NSTimeInterval = 0.0;
    let window_number: NSInteger = window.windowNumber();

    NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        NSEventType::LeftMouseDown,
        NSEvent::mouseLocation(),
        NSEvent::modifierFlags_class(),
        timestamp,
        window_number,
        None,
        0,
        1,
        0.0,
    )
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn only_left_mouse_down_is_reused_for_window_drag() {
        assert!(is_reusable_drag_event_type(NSEventType::LeftMouseDown));
        assert!(!is_reusable_drag_event_type(NSEventType::LeftMouseUp));
        assert!(!is_reusable_drag_event_type(NSEventType::KeyDown));
    }
}
