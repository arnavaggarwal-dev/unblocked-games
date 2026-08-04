// Prevents an extra console window from opening alongside the app on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

// The gallery opens games with `<a target="_blank">` (index.html:419). A browser turns that
// into a new tab; a desktop webview has no tabs, so the click would otherwise do nothing at
// all. This script catches those clicks and asks Rust for a real second window instead.
//
// It lives here rather than in index.html on purpose: the game HTML is shared with `main`,
// which must keep working unmodified on GitHub Pages. Tab-vs-window is a platform difference,
// so the platform layer is where it belongs.
const OPEN_IN_WINDOW: &str = r#"
window.addEventListener('click', function (e) {
  var el = e.target;
  while (el && el !== document && !(el.tagName === 'A' && el.target === '_blank')) {
    el = el.parentNode;
  }
  if (!el || el === document || !el.getAttribute) return;

  var href = el.getAttribute('href');
  if (!href || href === '#') return;

  e.preventDefault();
  e.stopPropagation();

  // Resolve against the current document so relative hrefs work, then hand over just the path.
  var path = new URL(href, window.location.href).pathname.replace(/^\/+/, '');
  window.__TAURI_INTERNALS__.invoke('open_game', { path: path });
}, true);
"#;

fn window_label(path: &str) -> String {
    // Window labels allow only alphanumerics, dash, underscore, slash and dot.
    let slug: String = path
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    format!("game-{slug}")
}

fn window_title(path: &str) -> String {
    // "games/dancing_burger.html" -> "dancing burger"; "games/frylock/index.html" -> "frylock"
    let trimmed = path.trim_end_matches(".html");
    let name = match trimmed.rsplit_once('/') {
        Some((parent, "index")) => parent.rsplit('/').next().unwrap_or(trimmed),
        _ => trimmed.rsplit('/').next().unwrap_or(trimmed),
    };
    name.replace(['_', '-'], " ")
}

#[tauri::command]
async fn open_game(app: tauri::AppHandle, path: String) -> Result<(), String> {
    // Only ever open something that shipped inside the bundle.
    if path.contains("..") || path.starts_with('/') || path.contains("://") {
        return Err(format!("refusing to open unexpected path: {path}"));
    }

    let label = window_label(&path);

    // Clicking the same card twice should focus the window that's already open, not stack
    // a second copy of a WASM game on top of the first.
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(path.clone().into()))
        .title(window_title(&path))
        .inner_size(1280.0, 800.0)
        .min_inner_size(480.0, 360.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![open_game])
        .setup(|app| {
            // Built here rather than declared in tauri.conf.json because an initialization
            // script can only be attached at window-creation time.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("chaos alldatime")
                .inner_size(1280.0, 800.0)
                .min_inner_size(640.0, 480.0)
                .resizable(true)
                .center()
                .initialization_script(OPEN_IN_WINDOW)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running chaos alldatime");
}
