//! Keep the main window's macOS traffic lights attached to AppKit layout.
//!
//! Tauri's fluent `WebviewWindowBuilder::traffic_light_position` stores the
//! inset on Wry's content-view parent. Wry reapplies it only from `drawRect:`,
//! but AppKit can resize/zoom the window and relayout its titlebar without
//! invalidating that content view for drawing. A post-build write establishes
//! the first frame but is then overwritten by the next native chrome layout.
//!
//! This module observes the exact `NSWindow` at AppKit's synchronous geometry
//! notification boundary. The callback runs on the same main-thread lifecycle
//! that just laid out the titlebar, before Tauri queues its higher-level
//! `WindowEvent`, so the invariant is restored without chasing a later frame.

use core::ffi::c_void;

use objc2::ffi::{objc_setAssociatedObject, OBJC_ASSOCIATION_RETAIN_NONATOMIC};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadOnly};
use objc2_app_kit::{
    NSView, NSWindow, NSWindowButton, NSWindowDidChangeBackingPropertiesNotification,
    NSWindowDidEnterFullScreenNotification, NSWindowDidExitFullScreenNotification,
    NSWindowDidResizeNotification,
};
use objc2_foundation::{
    MainThreadMarker, NSNotification, NSNotificationCenter, NSObject, NSObjectProtocol,
};
use tauri::{Runtime, WebviewWindow};

static TRAFFIC_LIGHT_OBSERVER_KEY: u8 = 0;

#[derive(Debug)]
struct TrafficLightObserverIvars {
    x: f64,
    y: f64,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements. The observer is
    // main-thread-only because every observed NSWindow is main-thread-only.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "MyAgentsTrafficLightLayoutObserver"]
    #[ivars = TrafficLightObserverIvars]
    struct TrafficLightObserver;

    // SAFETY: NSObjectProtocol has no additional implementation requirements.
    unsafe impl NSObjectProtocol for TrafficLightObserver {}

    impl TrafficLightObserver {
        // SAFETY: Registered only with NSNotificationCenter using this exact
        // selector and an NSWindow object filter below.
        #[unsafe(method(windowGeometryDidChange:))]
        fn window_geometry_did_change(&self, notification: &NSNotification) {
            let Some(object) = notification.object() else {
                return;
            };
            let Ok(window) = object.downcast::<NSWindow>() else {
                return;
            };

            unsafe {
                inset_traffic_lights(&window, self.ivars().x, self.ivars().y);
            }
        }
    }
);

impl TrafficLightObserver {
    fn new(mtm: MainThreadMarker, x: f64, y: f64) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(TrafficLightObserverIvars { x, y });
        // SAFETY: NSObject's `init` signature is correct for this subclass.
        unsafe { msg_send![super(this), init] }
    }
}

/// Install the one native owner for the main window's traffic-light inset.
///
/// The observer is retained as an associated object of the exact NSWindow, so
/// its lifetime matches the window without a process-global registry. Modern
/// NotificationCenter uses zeroing weak references for selector observers;
/// releasing the associated observer with the window therefore cannot leave a
/// dangling callback.
pub fn install_native_layout_owner<R: Runtime>(
    window: &WebviewWindow<R>,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "traffic-light owner must be installed on the main thread".to_owned())?;
    let ns_window_ptr = window.ns_window().map_err(|e| e.to_string())?;
    if ns_window_ptr.is_null() {
        return Err("ns_window() returned null".to_owned());
    }

    // SAFETY: Tauri's NSWindow pointer is valid while `window` is alive. This
    // function is main-thread-gated above, and neither reference escapes.
    let ns_window = unsafe { &*(ns_window_ptr as *const NSWindow) };
    let observer = TrafficLightObserver::new(mtm, x, y);
    let center = NSNotificationCenter::defaultCenter();

    // SAFETY: These are immutable notification-name constants exported by
    // AppKit and available on every supported macOS version.
    let geometry_notifications = unsafe {
        [
            NSWindowDidResizeNotification,
            NSWindowDidEnterFullScreenNotification,
            NSWindowDidExitFullScreenNotification,
            NSWindowDidChangeBackingPropertiesNotification,
        ]
    };

    for name in geometry_notifications {
        unsafe {
            center.addObserver_selector_name_object(
                &observer,
                sel!(windowGeometryDidChange:),
                Some(name),
                Some(ns_window),
            );
        }
    }

    // Retain the observer for exactly the NSWindow lifetime. Association is
    // installed before the initial inset so any immediately nested AppKit
    // layout notification already has a live receiver.
    unsafe {
        objc_setAssociatedObject(
            (ns_window as *const NSWindow)
                .cast_mut()
                .cast::<AnyObject>(),
            (&TRAFFIC_LIGHT_OBSERVER_KEY as *const u8).cast::<c_void>(),
            Retained::as_ptr(&observer).cast_mut().cast::<AnyObject>(),
            OBJC_ASSOCIATION_RETAIN_NONATOMIC,
        );
        inset_traffic_lights(ns_window, x, y);
    }

    Ok(())
}

/// Mirrors Wry/TAO's internal `inset_traffic_lights` algorithm.
unsafe fn inset_traffic_lights(window: &NSWindow, x: f64, y: f64) {
    let Some(close) = window.standardWindowButton(NSWindowButton::CloseButton) else {
        return;
    };
    let Some(miniaturize) = window.standardWindowButton(NSWindowButton::MiniaturizeButton) else {
        return;
    };
    let zoom = window.standardWindowButton(NSWindowButton::ZoomButton);

    let Some(parent) = close.superview() else {
        return;
    };
    let Some(title_bar_container_view) = parent.superview() else {
        return;
    };

    let close_rect = NSView::frame(&close);
    let title_bar_frame_height = close_rect.size.height + y;
    let mut title_bar_rect = NSView::frame(&title_bar_container_view);
    title_bar_rect.size.height = title_bar_frame_height;
    title_bar_rect.origin.y = window.frame().size.height - title_bar_frame_height;
    title_bar_container_view.setFrame(title_bar_rect);

    let space_between = NSView::frame(&miniaturize).origin.x - close_rect.origin.x;
    let mut buttons = vec![close, miniaturize];
    if let Some(zoom) = zoom {
        buttons.push(zoom);
    }

    for (index, button) in buttons.into_iter().enumerate() {
        let mut rect = NSView::frame(&button);
        rect.origin.x = x + index as f64 * space_between;
        button.setFrameOrigin(rect.origin);
    }
}
