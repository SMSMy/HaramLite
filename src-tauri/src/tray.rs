//! Sprint T2 — system tray icon.
//!
//! Why it exists (a real field complaint, 2026-09-11): the app can run with no
//! window at all — the browser bridge launches it hidden on purpose — and it
//! had no tray icon, so the ONLY way to reach or close the running process was
//! Task Manager. The owner said it plainly: "hard to close".
//!
//! Behaviour now:
//!   • the tray icon exists for the whole process lifetime;
//!   • left click → show + focus the window;
//!   • menu → show / open the results folder / quit for real;
//!   • closing the window (X) HIDES it instead of killing the process, so the
//!     Telegram bot, the watch folder and the browser bridge keep working —
//!     the explicit "quit" in this menu is the way out (owner's choice).

use std::sync::Mutex;
use std::sync::OnceLock;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

pub const TRAY_ID: &str = "haramlite-tray";

struct Labels {
    show: &'static str,
    results: &'static str,
    quit: &'static str,
}

/// Tray text follows the app language (`settings.lang`), like every other
/// surface. Kept tiny and pure so parity is testable without a running app.
fn labels(lang: &str) -> Labels {
    if lang == "en" {
        Labels {
            show: "Show HaramLite",
            results: "Open results folder",
            quit: "Quit HaramLite",
        }
    } else {
        Labels {
            show: "فتح النافذة",
            results: "فتح مجلد النتائج",
            quit: "إغلاق البرنامج",
        }
    }
}

/// Bring the main window back from hidden/minimised.
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn build_menu(app: &AppHandle, lang: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let l = labels(lang);
    let show = MenuItem::with_id(app, "tray_show", l.show, true, None::<&str>)?;
    let results = MenuItem::with_id(app, "tray_results", l.results, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray_quit", l.quit, true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    Menu::with_items(app, &[&show, &results, &sep, &quit])
}

/// Create the tray icon. Called once from `setup`.
pub fn init(app: &AppHandle, lang: &str) {
    let menu = match build_menu(app, lang) {
        Ok(m) => m,
        Err(e) => {
            tracing::error!(target: "app", "تعذر بناء قائمة أيقونة الشريط: {e}");
            return;
        }
    };
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("HaramLite")
        .menu(&menu)
        // Left click shows the window; the menu belongs to the right button.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray_show" => show_main(app),
            "tray_results" => {
                let dir = crate::results_dir();
                let _ = std::fs::create_dir_all(&dir);
                if let Err(e) = crate::open_in_explorer(&dir) {
                    tracing::warn!(target: "app", "تعذر فتح مجلد النتائج: {e}");
                }
            }
            "tray_quit" => {
                tracing::info!(target: "app", "إغلاق من أيقونة الشريط");
                // The graceful-exit marker is cleared here too: this path must
                // never leave a "previous session crashed" warning behind.
                crate::clear_crash_marker();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    // The window icon is already embedded from the bundle config.
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    match builder.build(app) {
        Ok(_) => {
            *last_lang().lock().unwrap_or_else(|p| p.into_inner()) = lang.to_string();
            tracing::info!(target: "app", "أيقونة الشريط جاهزة (النقر يفتح النافذة، والزر الأيمن قائمة)");
        }
        Err(e) => tracing::error!(target: "app", "تعذر إنشاء أيقونة الشريط: {e}"),
    }
}

fn last_lang() -> &'static Mutex<String> {
    static LAST: OnceLock<Mutex<String>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(String::new()))
}

/// Re-label the menu when the language changes — and do nothing otherwise, so
/// an unrelated settings save never churns the tray.
pub fn refresh_lang(app: &AppHandle, lang: &str) {
    {
        let guard = last_lang().lock().unwrap_or_else(|p| p.into_inner());
        if *guard == lang {
            return;
        }
    }
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    match build_menu(app, lang) {
        Ok(menu) => {
            if tray.set_menu(Some(menu)).is_ok() {
                *last_lang().lock().unwrap_or_else(|p| p.into_inner()) = lang.to_string();
            }
        }
        Err(e) => tracing::warn!(target: "app", "تعذر تحديث لغة قائمة الشريط: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_labels_follow_the_language_and_stay_complete() {
        for lang in ["ar", "en"] {
            let l = labels(lang);
            for s in [l.show, l.results, l.quit] {
                assert!(!s.trim().is_empty(), "empty tray label for {lang}");
            }
        }
        // Unknown/empty language falls back to Arabic, like the rest of the app.
        assert_eq!(labels("").show, "فتح النافذة");
        assert_eq!(labels("de").quit, "إغلاق البرنامج");
        assert_eq!(labels("en").quit, "Quit HaramLite");
    }
}
