use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, PhysicalSize,
};

// ── macOS: the popover is a non-activating NSPanel (floats over full-screen
//    apps, hides on blur). Elsewhere it's a regular borderless top window. ──
#[cfg(target_os = "macos")]
#[allow(clippy::unused_unit)] // tauri_panel!'s grammar requires `-> ()`
mod macos_panel {
    use super::*;
    use tauri_nspanel::{
        objc2_app_kit::{NSWindowCollectionBehavior, NSWindowStyleMask},
        tauri_panel, ManagerExt, PanelLevel, WebviewWindowExt as PanelWindowExt,
    };

    tauri_panel! {
        panel!(PopoverPanel {
            config: {
                can_become_key_window: true,
                can_become_main_window: false
            }
        })

        panel_event!(PopoverEventHandler {
            window_did_resign_key(notification: &NSNotification) -> ()
        })
    }

    pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        let window = app.get_webview_window("popover").ok_or("popover window missing")?;
        let panel = window.to_panel::<PopoverPanel>().map_err(|e| format!("to_panel failed: {e:?}"))?;

        panel.set_level(PanelLevel::Status.value());
        panel.set_style_mask(NSWindowStyleMask::NonactivatingPanel);
        panel.set_collection_behavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );

        // hide on blur; opt out with WTM_NO_BLUR_HIDE=1 (e.g. while using devtools)
        let handler = PopoverEventHandler::new();
        let h = app.clone();
        handler.window_did_resign_key(move |_| {
            if std::env::var("WTM_NO_BLUR_HIDE").is_err() {
                if let Ok(p) = h.get_webview_panel("popover") {
                    p.hide();
                }
            }
        });
        panel.set_event_handler(Some(handler.as_ref()));
        Ok(())
    }

    pub fn toggle(app: &AppHandle, tray_pos: PhysicalPosition<f64>, tray_size: PhysicalSize<f64>) {
        let Ok(panel) = app.get_webview_panel("popover") else { return };
        if panel.is_visible() {
            panel.hide();
            return;
        }
        super::position_popover(app, tray_pos, tray_size);
        panel.show_and_make_key();
    }
}

#[cfg(not(target_os = "macos"))]
mod window_popover {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// ms timestamp of the last blur-hide, to disambiguate "tray click while
    /// open": the click blurs → hides the popover *before* the tray event
    /// arrives, so a naive toggle would instantly re-show it.
    static LAST_BLUR_HIDE_MS: AtomicU64 = AtomicU64::new(0);

    fn now_ms() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
    }

    pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        // hide the popover on blur, mirroring the macOS panel behavior
        if let Some(window) = app.get_webview_window("popover") {
            let win = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(false) = event {
                    if std::env::var("WTM_NO_BLUR_HIDE").is_err() {
                        LAST_BLUR_HIDE_MS.store(now_ms(), Ordering::Relaxed);
                        let _ = win.hide();
                    }
                }
            });
        }
        Ok(())
    }

    pub fn toggle(app: &AppHandle, tray_pos: PhysicalPosition<f64>, tray_size: PhysicalSize<f64>) {
        let Some(window) = app.get_webview_window("popover") else { return };
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            return;
        }
        // the tray click itself just blur-hid the popover → treat as "close"
        if now_ms().saturating_sub(LAST_BLUR_HIDE_MS.load(Ordering::Relaxed)) < 300 {
            return;
        }
        super::position_popover(app, tray_pos, tray_size);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn init(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // ── convert / prepare the popover window for this platform ──
    #[cfg(target_os = "macos")]
    macos_panel::setup(app)?;
    #[cfg(not(target_os = "macos"))]
    window_popover::setup(app)?;

    // ── tray icon (shared across platforms) ──
    let app2 = app.clone();
    let builder = TrayIconBuilder::with_id("main")
        .icon(fork_template_icon())
        .icon_as_template(true)
        .show_menu_on_left_click(false)
        .tooltip("Canopy")
        .on_tray_icon_event(move |_tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = &event
            {
                // tray-icon emits physical coords; treat scale as 1.0 like the positioner
                let pos = rect.position.to_physical::<f64>(1.0);
                let size = rect.size.to_physical::<f64>(1.0);
                toggle_popover(&app2, pos, size);
            }
        });

    // Linux trays (appindicator/StatusNotifier) deliver NO click events — a menu
    // is the only reliable entry point, so attach one there. macOS keeps the
    // native click-toggles-popover behavior with no menu.
    #[cfg(not(target_os = "macos"))]
    let builder = {
        use tauri::menu::{MenuBuilder, MenuItemBuilder};
        let open = MenuItemBuilder::with_id("open", "Open Canopy").build(app)?;
        let quit = MenuItemBuilder::with_id("quit", "Quit Canopy").build(app)?;
        let menu = MenuBuilder::new(app).item(&open).separator().item(&quit).build()?;
        builder.menu(&menu).show_menu_on_left_click(true).on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
                // On Linux the tray MENU is the only entry point (appindicator
                // delivers no click events), so this — not the popover toggle —
                // is the path back from a hidden window. Without the catch-up
                // the user would stare at up to 60s-stale git data.
                catch_up_refresh(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
    };

    builder.build(app)?;

    Ok(())
}

/// Toggle the popover's visibility, dispatching to the platform implementation.
pub fn toggle_popover(app: &AppHandle, tray_pos: PhysicalPosition<f64>, tray_size: PhysicalSize<f64>) {
    #[cfg(target_os = "macos")]
    macos_panel::toggle(app, tray_pos, tray_size);
    #[cfg(not(target_os = "macos"))]
    window_popover::toggle(app, tray_pos, tray_size);
    // if the toggle just made the popover visible, catch up on the git refresh
    // that pauses while every window is hidden
    let visible = app
        .get_webview_window("popover")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if visible {
        catch_up_refresh(app);
    }
}

/// Re-run the git refresh that the background loop skips while every window is
/// hidden. Every path that brings a window back on screen must call this —
/// tray click (macOS), tray menu (Linux/Windows), and `show_main_window`.
/// Collapses with any refresh already in flight (see `state::refresh_all`).
pub(crate) fn catch_up_refresh(app: &AppHandle) {
    // eager visibility hint: emit gating must not swallow the first events
    // after a show while the 1s poll catches up
    crate::note_window_shown();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        crate::state::refresh_all(app.state::<crate::runtime::RuntimeContext>().inner()).await;
    });
}

/// Center the popover window under the tray icon, hanging below the menu/task
/// bar with a small gap — like a native menu-bar popover.
fn position_popover(app: &AppHandle, tray_pos: PhysicalPosition<f64>, tray_size: PhysicalSize<f64>) {
    if let Some(window) = app.get_webview_window("popover") {
        let win_w = window.outer_size().map(|s| s.width as f64).unwrap_or(316.0);
        let scale = window.scale_factor().unwrap_or(2.0);
        let gap = 6.0 * scale; // physical px below the bar
        let x = tray_pos.x + tray_size.width / 2.0 - win_w / 2.0;
        let y = tray_pos.y + tray_size.height + gap;
        let _ = window.set_position(PhysicalPosition::new(x.max(0.0), y));
    }
}

/// 44×44 template icon (22pt @2x) — the handoff's fork glyph, drawn at runtime
/// so no asset pipeline is needed. Black with alpha; macOS recolors templates.
fn fork_template_icon() -> Image<'static> {
    const S: usize = 44;
    let scale = S as f32 / 24.0; // glyph designed on the 24×24 Tabler grid
    let mut rgba = vec![0u8; S * S * 4];

    // Canopy mark (canopy-brand.jsx): two parents (7,6)(17,6) → child (12,18),
    // joined by a rounded bar + stem. Solid nodes for the small tray size.
    let nodes = [(7.0, 6.0, 2.05f32), (17.0, 6.0, 2.05), (12.0, 18.0, 2.05)];
    // connector approximated as segments (the bar's rounded path + center stem)
    let segments = [
        (7.0, 8.0, 7.0, 9.6),    // left stub
        (7.0, 9.6, 9.6, 12.0),   // left curve → bar
        (9.6, 12.0, 14.4, 12.0), // bar
        (14.4, 12.0, 17.0, 9.6), // right curve
        (17.0, 9.6, 17.0, 8.0),  // right stub
        (12.0, 12.0, 12.0, 16.0), // stem
    ];
    let stroke = 1.0f32; // half-width of the 2u stroke

    for py in 0..S {
        for px in 0..S {
            let x = (px as f32 + 0.5) / scale;
            let y = (py as f32 + 0.5) / scale;

            // solid node discs (signed distance inside)
            let mut node_in = f32::MIN;
            for (cx, cy, r) in nodes {
                let inside = r - ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
                node_in = node_in.max(inside);
            }
            // stroked connector
            let mut seg_d = f32::MAX;
            for (x1, y1, x2, y2) in segments {
                seg_d = seg_d.min(dist_to_segment(x, y, x1, y1, x2, y2));
            }

            let node_a = (node_in / 0.5 + 0.5).clamp(0.0, 1.0);
            let seg_a = ((stroke - seg_d) / 0.5 + 0.5).clamp(0.0, 1.0);
            let a = node_a.max(seg_a);

            let i = (py * S + px) * 4;
            rgba[i] = 0;
            rgba[i + 1] = 0;
            rgba[i + 2] = 0;
            rgba[i + 3] = (a * 255.0) as u8;
        }
    }
    Image::new_owned(rgba, S as u32, S as u32)
}

fn dist_to_segment(px: f32, py: f32, x1: f32, y1: f32, x2: f32, y2: f32) -> f32 {
    let (dx, dy) = (x2 - x1, y2 - y1);
    let len2 = dx * dx + dy * dy;
    let t = if len2 == 0.0 {
        0.0
    } else {
        (((px - x1) * dx + (py - y1) * dy) / len2).clamp(0.0, 1.0)
    };
    let (cx, cy) = (x1 + t * dx, y1 + t * dy);
    ((px - cx).powi(2) + (py - cy).powi(2)).sqrt()
}
