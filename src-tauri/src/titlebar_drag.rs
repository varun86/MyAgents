#[cfg(target_os = "macos")]
use core::ffi::c_float;

#[cfg(target_os = "macos")]
use crate::ulog_warn;
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSApp, NSEvent, NSEventModifierFlags, NSEventType, NSWindow};
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
        Some(event) if event.r#type() == NSEventType::LeftMouseDown => event,
        Some(event) => synthesize_left_mouse_down(ns_window, Some(&event))
            .ok_or_else(|| "failed to synthesize left-mouse-down drag event".to_string())?,
        None => synthesize_left_mouse_down(ns_window, None)
            .ok_or_else(|| "failed to synthesize left-mouse-down drag event".to_string())?,
    };

    ns_window.performWindowDragWithEvent(&drag_event);
    Ok(())
}

#[cfg(target_os = "macos")]
fn synthesize_left_mouse_down(
    window: &NSWindow,
    source: Option<&NSEvent>,
) -> Option<Retained<NSEvent>> {
    let flags = source
        .map(NSEvent::modifierFlags)
        .unwrap_or_else(NSEvent::modifierFlags_class);
    let timestamp: NSTimeInterval = source.map(NSEvent::timestamp).unwrap_or(0.0);
    let window_number: NSInteger = source
        .map(NSEvent::windowNumber)
        .filter(|value| *value != 0)
        .unwrap_or_else(|| window.windowNumber());
    let click_count: NSInteger = source
        .map(NSEvent::clickCount)
        .filter(|value| *value > 0)
        .unwrap_or(1);
    let pressure: c_float = source.map(NSEvent::pressure).unwrap_or(0.0);
    let flags: NSEventModifierFlags = flags;

    NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        NSEventType::LeftMouseDown,
        NSEvent::mouseLocation(),
        flags,
        timestamp,
        window_number,
        None,
        0,
        click_count,
        pressure,
    )
}
