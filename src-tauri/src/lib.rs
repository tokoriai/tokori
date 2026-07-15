mod api_server;
mod commands;
mod media_url;
mod ocr;
mod providers;
mod tunnel;
mod whisper_local;

use std::sync::{Arc, Mutex as StdMutex};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent, TrayIconId};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_sql::{Migration, MigrationKind};
use tauri_plugin_window_state::StateFlags;

use crate::api_server::ApiServer;
use crate::commands::{
    anki_invoke, chat_send, dict_fetch_cedict, dict_fetch_lang, edge_tts, hanzi_stroke,
    list_addons, media_probe, ollama_list_models, provider_list_models, provider_test,
    read_addon_entry, reveal_addons_dir, tokenize_zh,
};
use crate::ocr::{ocr_image, ocr_image_layout, read_image_file};
use crate::whisper_local::{
    whisper_local_delete, whisper_local_download, whisper_local_models, whisper_local_transcribe,
};

/// Wrapped in an `Arc` and stuffed into Tauri state so the start/stop
/// commands can reach it. The struct itself owns its shutdown channel and
/// is cheap to clone.
struct ApiServerState(Arc<ApiServer>);

#[tauri::command]
async fn api_server_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, ApiServerState>,
) -> Result<serde_json::Value, String> {
    // Resolve the same on-disk SQLite file the SQL plugin opens. On Linux the
    // plugin resolves a relative `sqlite:tokori.db` path against the app
    // *config* dir (~/.config/<id>/), not the data dir — so we have to match
    // that or the API server's `mode=rwc` pool happily creates a brand-new
    // empty DB next to the real one and every query trips on
    // `no such table: dict_entries`.
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("can't resolve app config dir: {e}"))?;
    let db_path = dir.join("tokori.db");
    let info = state
        .0
        .start(&db_path, app.clone())
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
      "addr":  info.addr,
      "token": info.token,
    }))
}

/// Resolve a pending pair request from the local API server.
///
/// The pair-request modal in the frontend calls this with the request id
/// it received from the `tokori:pair-request` event and the user's
/// approve/deny choice. The Rust side wakes the long-polling HTTP handler
/// in `api_server::pair_request` so it can return the bearer token (or a
/// 403) to the extension/CLI client.
#[tauri::command]
async fn pair_resolve(
    state: tauri::State<'_, ApiServerState>,
    id: String,
    approved: bool,
) -> Result<bool, String> {
    Ok(state.0.resolve_pair(&id, approved))
}

#[tauri::command]
async fn api_server_stop(state: tauri::State<'_, ApiServerState>) -> Result<(), String> {
    state.0.stop().await;
    Ok(())
}

/// Persisted "start automatically on app launch" preference. Backed by
/// a marker file at `~/.tokori/api-autostart` so the Rust side can
/// read it during `setup()` without needing the SQL plugin online.
#[tauri::command]
async fn api_server_get_autostart() -> Result<bool, String> {
    Ok(api_server::read_autostart())
}

#[tauri::command]
async fn api_server_set_autostart(enabled: bool) -> Result<(), String> {
    api_server::write_autostart(enabled).map_err(|e| e.to_string())
}

#[tauri::command]
async fn api_server_status(state: tauri::State<'_, ApiServerState>) -> Result<bool, String> {
    Ok(state.0.is_running().await)
}

/// Begin a desktop OAuth sign-in. Mints a fresh `state` value, hands
/// it to the api_server's pending-state broker, and returns it
/// (together with the loopback redirect URL) to the frontend. The
/// frontend then opens the browser at the cloud's `/auth/oauth/<p>/
/// start?redirect=…&state=…` and waits for the matching
/// `tokori:oauth-complete` event.
///
/// State is 32 random hex chars — long enough that the
/// `isLoopbackRedirect` regex (`^[A-Za-z0-9_-]{16,128}$`) accepts it
/// and short enough to fit in any URL parser.
#[tauri::command]
async fn oauth_begin(
    app: tauri::AppHandle,
    state: tauri::State<'_, ApiServerState>,
) -> Result<serde_json::Value, String> {
    // The OAuth dance bounces the browser back to the local API server's
    // loopback callback (`http://127.0.0.1:53210/oauth/callback`). That
    // route only answers while the server is listening — and on a fresh
    // install the "start on launch" marker (~/.tokori/api-autostart)
    // doesn't exist, so `setup()` never brought it up. Without this the
    // browser lands on a dead port and the sign-in silently times out
    // after 60s. Bring it up on demand before we hand out the redirect;
    // `start` short-circuits with `AlreadyRunning` when it's already up,
    // so this is a cheap no-op on the common path and race-free if two
    // sign-ins overlap. We deliberately don't write the autostart marker
    // — this is a session-scoped listener for the sign-in, not an opt-in
    // to the always-on MCP bridge.
    let db_path = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("can't resolve app config dir: {e}"))?
        .join("tokori.db");
    match state.0.start(&db_path, app.clone()).await {
        Ok(_) | Err(api_server::ApiError::AlreadyRunning) => {}
        Err(e) => return Err(format!("couldn't start local API server: {e}")),
    }

    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let state_value: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
    state.0.register_oauth_state(state_value.clone());
    let redirect = format!(
        "http://{}/oauth/callback?state={}",
        api_server::DEFAULT_BIND,
        state_value
    );
    Ok(serde_json::json!({
        "state":    state_value,
        "redirect": redirect,
    }))
}

/// Returns the API server's bind address, bearer token, and whether
/// it's currently running. Lets sections other than Local API (e.g.
/// Remote access) render their pairing UI without coupling to the
/// session-scoped `StartedInfo` from `api_server_start`.
#[tauri::command]
async fn api_server_info(
    state: tauri::State<'_, ApiServerState>,
) -> Result<serde_json::Value, String> {
    let running = state.0.is_running().await;
    let token = api_server::ensure_token().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
      "running": running,
      "addr":    api_server::DEFAULT_BIND,
      "token":   token,
    }))
}

// ── Cloudflare quick-tunnel ─────────────────────────────────────────
//
// Frontend invokes start to spin up a tunnel pointing at the local API
// server. The Rust side spawns `cloudflared`, parses the URL it prints,
// and returns it so the UI can auto-fill the pairing card + QR. Status
// keeps polling cheap; stop is idempotent.

#[tauri::command]
async fn remote_tunnel_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, tunnel::TunnelState>,
) -> Result<tunnel::TunnelStatus, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("can't resolve app data dir: {e}"))?;
    let binary = tunnel::resolve_binary(&dir);
    state.start(api_server::DEFAULT_BIND, &binary).await
}

#[tauri::command]
async fn remote_tunnel_stop(state: tauri::State<'_, tunnel::TunnelState>) -> Result<(), String> {
    state.stop().await;
    Ok(())
}

#[tauri::command]
async fn remote_tunnel_status(
    state: tauri::State<'_, tunnel::TunnelState>,
) -> Result<tunnel::TunnelStatus, String> {
    Ok(state.status().await)
}

/// Returns `{installed: bool, path: string?}` so the frontend knows
/// whether to show the "Download cloudflared" CTA before the user
/// clicks Start. Cheap — just a filesystem stat.
#[tauri::command]
async fn remote_tunnel_installed(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("can't resolve app data dir: {e}"))?;
    let path = tunnel::installed_path(&dir);
    Ok(serde_json::json!({
      "installed": path.is_some(),
      "path": path.map(|p| p.display().to_string()),
    }))
}

#[tauri::command]
async fn remote_tunnel_install(app: tauri::AppHandle) -> Result<tunnel::DownloadResult, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("can't resolve app data dir: {e}"))?;
    tunnel::install(&dir).await
}

// ─── Global search feature ────────────────────────────────────────────────
//
// Optional desktop feature. When the user enables it from
// Settings → Desktop:
//   1. A system tray icon appears (left-click shows the main window;
//      menu offers Show / Open spotlight / Quit).
//   2. Closing the main window hides it instead of quitting, so the
//      app keeps running for the global shortcut.
//   3. A configurable global shortcut (default Ctrl/Cmd+Shift+F) opens
//      the small spotlight popup window from anywhere in the OS.
//
// State lives in the Tauri-managed `GlobalSearchState`. The frontend
// reads its persisted settings on boot and calls
// `set_global_search_enabled` to apply the toggle; turning it off
// reverses every step above.

const TRAY_ID: &str = "tokori-tray";

#[derive(Default)]
struct GlobalSearchState {
    /// When true, the main window's close-requested event hides instead
    /// of quitting. Read by the window-event handler.
    close_to_tray: StdMutex<bool>,
    /// The currently-registered global shortcut, if any. Tracked so we
    /// can unregister it before re-registering with a new value.
    current_shortcut: StdMutex<Option<String>>,
    /// Global shortcut for the voice-ask popup — registered/unregistered
    /// independently of the search shortcut. Either one being active
    /// keeps the tray + close-to-tray behaviour alive.
    voice_shortcut: StdMutex<Option<String>>,
    /// The active tray icon id, if one has been built. Tracked so we
    /// can drop it when the user disables the feature.
    tray_id: StdMutex<Option<TrayIconId>>,
    /// Set by the tray "Quit" menu item right before calling `app.exit`.
    /// The `ExitRequested` handler honours an exit when this is true,
    /// even if `close_to_tray` is on — otherwise the handler would
    /// loop and the user could never close the app from the tray.
    quitting: StdMutex<bool>,
}

fn focus_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn show_spotlight(app: &AppHandle) -> tauri::Result<()> {
    // Created/reused window — we run the same focus dance either way.
    // The dance:
    //   1. show + set_focus inline (covers macOS / Windows where it's
    //      enough on its own).
    //   2. Schedule a follow-up set_focus + emit on a short delay. On
    //      Linux/WebKit2GTK, a single set_focus from a global-shortcut
    //      callback often raises the window without granting keyboard
    //      focus — the WM expects an XDG activation token that Tauri
    //      doesn't pass along when the trigger came from the global
    //      shortcut hot-path. Re-requesting focus once the WM has
    //      finished mapping the window almost always succeeds.
    //   3. The emitted `tokori:spotlight-shown` event is what the
    //      SpotlightApp listens for to re-focus its <input>, so even
    //      when DOM focus drifted (window was already mounted from a
    //      previous summon, focus event didn't propagate) the caret
    //      ends up where the user expects.
    let exists = app.get_webview_window("spotlight").is_some();
    if exists {
        if let Some(w) = app.get_webview_window("spotlight") {
            w.show()?;
            w.set_focus()?;
        }
    } else {
        // Frontend reads `?spotlight=1` from window.location and renders
        // the minimal SpotlightApp instead of the full shell.
        //
        // Initial size has to fit the WHOLE card up-front (header + ~12
        // result rows + footer + padding ≈ 620px). We used to ship 76px
        // and rely on a JS-side setSize call to grow once results
        // arrived, but on Linux with `transparent + frameless + always-on-top`
        // the runtime resize is silently dropped on most compositors, so
        // the user only ever saw the input row. Sizing once at creation
        // is robust everywhere; the dead transparent area below the card
        // is invisible and Esc dismisses the popup.
        WebviewWindowBuilder::new(
            app,
            "spotlight",
            WebviewUrl::App("index.html?spotlight=1".into()),
        )
        .title("Tokori Spotlight")
        .inner_size(640.0, 620.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .visible(true)
        .focused(true)
        .build()?;
    }
    // Focus dance — the part that actually makes typing work after a
    // global-shortcut summon.
    //
    // Two reliability hazards on Linux specifically:
    //   • GTK UI calls (set_focus → gtk_window_present) MUST happen on
    //     the main loop thread. A bare tokio::spawn dispatches them on
    //     the runtime worker, where they silently no-op on some WMs.
    //     `run_on_main_thread` ferries the call back onto GTK's loop.
    //   • Window managers with focus-stealing prevention (KDE Plasma,
    //     newer Mutter) ignore activation requests that arrive without
    //     a fresh user-interaction timestamp. The global-shortcut
    //     callback runs before GDK has propagated the event time, so
    //     the first set_focus is often dropped. A staircase of retries
    //     gives the WM a chance to settle and accept a later request.
    //
    // The schedule below has worked across Plasma 5/6, GNOME/Mutter on
    // both X11 and Wayland, and macOS/Windows (where the very first
    // set_focus already wins, so the later attempts are harmless
    // no-ops). The final emit doubles as the signal the SpotlightApp
    // listens for to re-focus its <input>.
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        for delay_ms in [40u64, 120, 280, 500] {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            let app_inner = app_clone.clone();
            let _ = app_clone.run_on_main_thread(move || {
                if let Some(w) = app_inner.get_webview_window("spotlight") {
                    let _ = w.set_focus();
                }
            });
        }
        let _ = app_clone.emit("tokori:spotlight-shown", ());
    });
    Ok(())
}

/// Linux-only: auto-grant WebKit permission requests (microphone,
/// media devices) on a webview window. WebKit2GTK 4.1's
/// `permission-request` signal has no default listener, and an
/// unanswered request resolves to *deny* — getUserMedia rejects with
/// "The request is not allowed by the user agent…" without the user
/// ever seeing a prompt. The main window gets this in setup(); every
/// runtime-created window that touches the mic (the voice-ask popup)
/// must get it too, at creation time.
#[cfg(target_os = "linux")]
fn grant_webview_media_permissions(window: &tauri::WebviewWindow) {
    use webkit2gtk::{PermissionRequestExt, WebViewExt};
    let _ = window.with_webview(|webview| {
        // `webview.inner()` is `&webkit2gtk::WebView` on Linux. The
        // closure leaks via the signal handler — fine, the webview
        // lives as long as the app.
        webview.inner().connect_permission_request(|_w, req| {
            req.allow();
            true
        });
    });
}

#[cfg(not(target_os = "linux"))]
fn grant_webview_media_permissions(_window: &tauri::WebviewWindow) {}

fn show_voice_ask(app: &AppHandle) -> tauri::Result<()> {
    // Same created-or-reused + focus-dance pattern as show_spotlight —
    // see the walkthrough there for why the staircase of set_focus
    // retries exists (Linux WMs with focus-stealing prevention drop
    // activation requests that arrive from a global-shortcut hot-path).
    let exists = app.get_webview_window("voiceask").is_some();
    if exists {
        if let Some(w) = app.get_webview_window("voiceask") {
            w.show()?;
            w.set_focus()?;
        }
    } else {
        // Frontend reads `?voiceask=1` from window.location and renders
        // the minimal VoiceAskApp instead of the full shell. Sized once
        // at creation to fit the whole pill — runtime resizes are
        // dropped on Linux compositors for transparent frameless
        // always-on-top windows.
        const W: f64 = 560.0;
        const H: f64 = 180.0;
        let mut builder = WebviewWindowBuilder::new(
            app,
            "voiceask",
            WebviewUrl::App("index.html?voiceask=1".into()),
        )
        .title("Tokori Voice Ask")
        .inner_size(W, H)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(true)
        .focused(true);
        // Wispr-Flow-style placement: a slim pill floating bottom-center
        // of the primary monitor, clear of taskbar/dock. The card inside
        // anchors to the window's bottom edge (items-end), so the
        // transparent slack sits above it. Falls back to plain centering
        // when the monitor can't be resolved (odd Wayland setups).
        if let Ok(Some(monitor)) = app.primary_monitor() {
            let scale = monitor.scale_factor();
            let msize = monitor.size().to_logical::<f64>(scale);
            let mpos = monitor.position().to_logical::<f64>(scale);
            let x = mpos.x + (msize.width - W) / 2.0;
            let y = mpos.y + msize.height - H - 48.0;
            builder = builder.position(x, y);
        } else {
            builder = builder.center();
        }
        let window = builder.build()?;
        // Without this, getUserMedia in the popup dies with
        // NotAllowedError on Linux — see the helper's docs.
        grant_webview_media_permissions(&window);
    }
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        for delay_ms in [40u64, 120, 280, 500] {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            let app_inner = app_clone.clone();
            let _ = app_clone.run_on_main_thread(move || {
                if let Some(w) = app_inner.get_webview_window("voiceask") {
                    let _ = w.set_focus();
                }
            });
        }
        // VoiceAskApp listens for this to reset state + start recording.
        let _ = app_clone.emit("tokori:voiceask-shown", ());
    });
    Ok(())
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let state: tauri::State<GlobalSearchState> = app.state();
    // Hold the tray_id lock across the ENTIRE check-and-build, not just the
    // check. `applyGlobalSearchOnBoot` and `applyVoiceAskOnBoot` fire
    // back-to-back at boot (shell.tsx) and arrive as two concurrent async
    // commands on separate runtime threads; when both features are enabled
    // both reach `sync_tray_state` → here. A check-then-release-then-build
    // guard lets both callers observe `None`, release, and each build a
    // second `TrayIconBuilder` under the same TRAY_ID — which on Linux
    // double-registers the StatusNotifierItem D-Bus object ("An object is
    // already exported…") and paints a duplicate tray icon. Holding the
    // guard serialises them: the loser blocks until the winner stores the
    // id, then sees `is_some()` and bails. Safe to hold across `.build()`
    // because this fn is synchronous (no await point) and the main thread
    // never locks `tray_id`, so the GTK dispatch inside `.build()` cannot
    // deadlock against us.
    let mut tray_id = state.tray_id.lock().unwrap();
    if tray_id.is_some() {
        return Ok(());
    }
    let show_item = MenuItem::with_id(app, "tray-show", "Show Tokori", true, None::<&str>)?;
    let search_item = MenuItem::with_id(
        app,
        "tray-search",
        "Open spotlight search",
        true,
        None::<&str>,
    )?;
    let voice_item = MenuItem::with_id(app, "tray-voice", "Ask by voice", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &search_item, &voice_item, &quit_item])?;

    let icon = app
        .default_window_icon()
        .ok_or_else(|| tauri::Error::AssetNotFound("window icon".into()))?
        .clone();

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        .tooltip("Tokori")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => focus_main_window(app),
            "tray-search" => {
                if let Err(e) = show_spotlight(app) {
                    log::warn!("show_spotlight failed: {e}");
                }
            }
            "tray-voice" => {
                if let Err(e) = show_voice_ask(app) {
                    log::warn!("show_voice_ask failed: {e}");
                }
            }
            "tray-quit" => {
                let state: tauri::State<GlobalSearchState> = app.state();
                *state.quitting.lock().unwrap() = true;
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
                focus_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    // `tray_id` is the guard acquired at the top of this fn — still held.
    *tray_id = Some(tray.id().clone());
    Ok(())
}

fn destroy_tray(app: &AppHandle) {
    let state: tauri::State<GlobalSearchState> = app.state();
    let mut tray_id = state.tray_id.lock().unwrap();
    if let Some(id) = tray_id.take() {
        let _ = app.remove_tray_by_id(&id);
    }
}

/// Native menu bar — installed on macOS only (see setup()), but
/// compiled on every platform so `cargo check` on a Linux/Windows dev
/// box still type-checks it.
///
/// Structure follows the macOS HIG: app menu (About / Settings… ⌘, /
/// Services / Hide / Quit), a full Edit menu — replacing Tauri's
/// default menu means re-supplying it, and without an Edit menu
/// ⌘C/⌘V/⌘X stop working inside the webview — then View (sidebar
/// toggle + native fullscreen) and Window (minimize / zoom / close).
/// The two custom items emit `tokori:menu` to the main window via the
/// builder-level on_menu_event; shell.tsx routes them into React.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn build_app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{
        AboutMetadata, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
    };

    let pkg = app.package_info();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        ..Default::default()
    };

    let settings = MenuItemBuilder::with_id("menu-settings", "Settings…")
        .accelerator("Cmd+,")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Tokori")
        .about(Some(about))
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let toggle_sidebar = MenuItemBuilder::with_id("menu-toggle-sidebar", "Toggle Sidebar")
        .accelerator("Alt+Cmd+S")
        .build(app)?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&toggle_sidebar)
        .separator()
        .fullscreen()
        .build()?;

    // "Zoom" is the HIG name for maximize — the predefined item's
    // default label says "Maximize", which reads Windows-y on a Mac.
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .item(&PredefinedMenuItem::maximize(app, Some("Zoom"))?)
        .separator()
        .close_window()
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &view_menu, &window_menu])
        .build()
}

/// Recompute the tray + close-to-tray state from which global-shortcut
/// features are currently on. Either feature alone needs the app to
/// keep running in the tray after the main window closes; only when
/// BOTH are off does closing the window quit again.
fn sync_tray_state(app: &AppHandle) -> Result<(), String> {
    let state: tauri::State<GlobalSearchState> = app.state();
    let any_enabled = state.current_shortcut.lock().unwrap().is_some()
        || state.voice_shortcut.lock().unwrap().is_some();
    *state.close_to_tray.lock().unwrap() = any_enabled;
    if any_enabled {
        build_tray(app).map_err(|e| format!("build tray: {e}"))
    } else {
        destroy_tray(app);
        Ok(())
    }
}

#[tauri::command]
async fn set_global_search_enabled(
    app: AppHandle,
    enabled: bool,
    shortcut: Option<String>,
) -> Result<(), String> {
    let state: tauri::State<GlobalSearchState> = app.state();
    // Always unregister any previously-bound shortcut so flipping the
    // toggle off (or changing the keys) frees the OS-level binding.
    {
        let mut current = state.current_shortcut.lock().unwrap();
        if let Some(prev) = current.take() {
            let _ = app.global_shortcut().unregister(prev.as_str());
        }
    }

    if enabled {
        let s = shortcut.unwrap_or_else(|| "CmdOrCtrl+Shift+F".to_string());
        app.global_shortcut()
            .on_shortcut(s.as_str(), |handle, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    if let Err(e) = show_spotlight(handle) {
                        log::warn!("show_spotlight failed: {e}");
                    }
                }
            })
            .map_err(|e| format!("register shortcut: {e}"))?;
        {
            let mut current = state.current_shortcut.lock().unwrap();
            *current = Some(s);
        }
    } else if let Some(w) = app.get_webview_window("spotlight") {
        let _ = w.close();
    }
    sync_tray_state(&app)
}

#[tauri::command]
async fn set_voice_ask_enabled(
    app: AppHandle,
    enabled: bool,
    shortcut: Option<String>,
) -> Result<(), String> {
    let state: tauri::State<GlobalSearchState> = app.state();
    {
        let mut current = state.voice_shortcut.lock().unwrap();
        if let Some(prev) = current.take() {
            let _ = app.global_shortcut().unregister(prev.as_str());
        }
    }

    if enabled {
        let s = shortcut.unwrap_or_else(|| "CmdOrCtrl+Shift+Space".to_string());
        app.global_shortcut()
            .on_shortcut(s.as_str(), |handle, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    if let Err(e) = show_voice_ask(handle) {
                        log::warn!("show_voice_ask failed: {e}");
                    }
                }
            })
            .map_err(|e| format!("register shortcut: {e}"))?;
        {
            let mut current = state.voice_shortcut.lock().unwrap();
            *current = Some(s);
        }
    } else if let Some(w) = app.get_webview_window("voiceask") {
        let _ = w.close();
    }
    sync_tray_state(&app)
}

/// Payload for `tokori:voice-ask` — the transcript handed from the
/// voice-ask popup to the main window's chat.
#[derive(Clone, serde::Serialize)]
struct VoiceAskPayload {
    text: String,
    speak: bool,
}

#[tauri::command]
async fn focus_main_with_ask(app: AppHandle, question: String, speak: bool) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("voiceask") {
        let _ = w.hide();
    }
    focus_main_window(&app);
    let _ = app.emit(
        "tokori:voice-ask",
        VoiceAskPayload {
            text: question,
            speak,
        },
    );
    Ok(())
}

#[tauri::command]
async fn hide_voice_ask(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("voiceask") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn focus_main_with_query(app: AppHandle, query: Option<String>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("spotlight") {
        let _ = w.hide();
    }
    focus_main_window(&app);
    if let Some(q) = query {
        let _ = app.emit("tokori:open-search", q);
    }
    Ok(())
}

#[tauri::command]
async fn hide_spotlight(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("spotlight") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

const V31_SQL: &str = r#"
-- Trigram FTS shadow index over dict_entries — removes the last dict
-- full-table scan (`searchDict`'s OR of five LIKE '%q%' predicates).
--
-- A LIKE with a leading wildcard can never use a btree index, so every
-- spotlight / dict-search / notes-@mention keystroke scanned the
-- language's whole dictionary (~125k rows for CC-CEDICT ≈ 1s, surfaced
-- as sqlx slow-statement WARNs; bursts of those tie up pooled
-- connections and the click-to-define batch lookups queue behind
-- them). FTS5's trigram tokenizer implements LIKE against its inverted
-- index directly: any pattern with ≥3 consecutive codepoints becomes
-- an index probe (~7ms worst-case on the same dict). Queries under 3
-- codepoints can't use trigrams; `searchDict` keeps a bounded scan
-- fallback for those.
--
--   • content='dict_entries': external-content table — FTS stores only
--     the trigram index and reads rows back from dict_entries by rowid.
--   • detail='none', columnsize=0: postings keep just the rowid. The
--     LIKE optimisation still applies and the index shrinks ~5x
--     (measured +7MB on a 31MB dict db, vs +40MB with full detail).
--   • trigram is codepoint-based, so CJK words and readings index the
--     same way latin glosses do.
--
-- The triggers keep the index in sync through every mutation path:
-- pack installs (bulk INSERT), reinstalls/uninstalls (bulk DELETE,
-- including the FK cascade from deleting the dictionaries row), and
-- the personal dictionary's row-level add/edit/delete. External-
-- content FTS5 needs the *old* row values on delete, and they must be
-- byte-identical to what was inserted — hence raw columns (NULLs
-- included) on both sides, no coalesce.
CREATE VIRTUAL TABLE IF NOT EXISTS dict_fts USING fts5(
  word, alt_word, reading, reading_norm, gloss,
  content='dict_entries', content_rowid='id',
  tokenize='trigram', detail='none', columnsize=0
);

INSERT INTO dict_fts(rowid, word, alt_word, reading, reading_norm, gloss)
  SELECT id, word, alt_word, reading, reading_norm, gloss FROM dict_entries;

CREATE TRIGGER IF NOT EXISTS trg_dict_fts_insert
AFTER INSERT ON dict_entries BEGIN
  INSERT INTO dict_fts(rowid, word, alt_word, reading, reading_norm, gloss)
  VALUES (new.id, new.word, new.alt_word, new.reading, new.reading_norm, new.gloss);
END;

CREATE TRIGGER IF NOT EXISTS trg_dict_fts_delete
AFTER DELETE ON dict_entries BEGIN
  INSERT INTO dict_fts(dict_fts, rowid, word, alt_word, reading, reading_norm, gloss)
  VALUES ('delete', old.id, old.word, old.alt_word, old.reading, old.reading_norm, old.gloss);
END;

CREATE TRIGGER IF NOT EXISTS trg_dict_fts_update
AFTER UPDATE ON dict_entries BEGIN
  INSERT INTO dict_fts(dict_fts, rowid, word, alt_word, reading, reading_norm, gloss)
  VALUES ('delete', old.id, old.word, old.alt_word, old.reading, old.reading_norm, old.gloss);
  INSERT INTO dict_fts(rowid, word, alt_word, reading, reading_norm, gloss)
  VALUES (new.id, new.word, new.alt_word, new.reading, new.reading_norm, new.gloss);
END;
"#;

const V29_SQL: &str = r#"
-- Composite expression indexes on (dict_id, LOWER(word/alt_word)).
--
-- The standalone LOWER() indexes from V20 aren't enough on their own: the
-- case-insensitive batch lookup in `lookupDictBatch` filters on BOTH
-- `dict_id IN (...)` AND `LOWER(word) IN (...)`. Facing two candidate
-- indexes that both lead with dict_id — `(dict_id, word)` (V24) and the
-- standalone `LOWER(word)` (V20) — SQLite's planner picks the dict_id one,
-- which can't satisfy the LOWER() predicate, then scans every row for the
-- workspace's dictionaries (~150k for CC-CEDICT / Beolingus = ~1.5s,
-- surfaced as sqlx "slow statement" WARNs, one per chat bubble → pool
-- starvation). Keying the EXPRESSION index by dict_id first lets a single
-- index satisfy both IN constraints, turning the scan into O(log n) seeks.
CREATE INDEX IF NOT EXISTS idx_dict_entries_dict_lower_word
  ON dict_entries(dict_id, LOWER(word));
CREATE INDEX IF NOT EXISTS idx_dict_entries_dict_lower_alt
  ON dict_entries(dict_id, LOWER(alt_word));
"#;

const V27_SQL: &str = r#"
-- Japanese pitch accent (the JA analogue of pinyin tone colours):
-- a single integer per dictionary headword indicating the *drop*
-- position. 0 = heiban (no drop), 1 = atamadaka (drop after first
-- mora), N>=2 = nakadaka/odaka (drop after Nth mora). Null = no
-- accent data for this word (kanjium's coverage is partial; popover
-- + ruby renderer gracefully degrade to plain reading).
--
-- Augmented post-install by `scripts/dicts/augment-pitch.ts` on the
-- cloud side; the desktop ships the JMdict pack without accent, then
-- gets it joined in via the same script when the operator re-runs
-- the seeder. Column-only addition — no index needed, since this is
-- a read-by-rowid attribute, not a filter key.
ALTER TABLE dict_entries ADD COLUMN pitch_accent INTEGER;
"#;

const V26_SQL: &str = r#"
-- Per-card flashcard customisation:
--   • `translation` holds a natural / native translation that's
--     separate from the dictionary-style `gloss` (Definition). A
--     learner can carry both on one card.
--   • `layout` is a JSON `{ front: FieldId[], back: FieldId[] }`
--     overriding which fields appear on each face of the card in the
--     classic flip surfaces. NULL keeps the per-kind default, so
--     existing cards read back unchanged.
ALTER TABLE vocab_entries ADD COLUMN translation TEXT;
ALTER TABLE vocab_entries ADD COLUMN layout TEXT;
"#;

const V25_SQL: &str = r#"
-- Rename internal POLOT_* storage markers to TOKORI_* to match the
-- product name. These markers live inside string columns:
--   • `vocab_entries.card_notes` is JSON prefixed with the example
--     sentinel (POLOT_EXAMPLES_V1 → TOKORI_EXAMPLES_V1).
--   • `messages.content` carries POLOT_VOICE_SESSION on the system
--     row stamped at the top of each persisted live-voice session.
--
-- Idempotent: the LIKE/=  guards mean re-running the migration is a
-- no-op once the rows have been rewritten.
UPDATE vocab_entries
   SET card_notes = 'TOKORI_EXAMPLES_V1' || substr(card_notes, length('POLOT_EXAMPLES_V1') + 1)
 WHERE card_notes LIKE 'POLOT_EXAMPLES_V1%';

UPDATE messages
   SET content = 'TOKORI_VOICE_SESSION'
 WHERE role = 'system' AND content = 'POLOT_VOICE_SESSION';
"#;

const V24_SQL: &str = r#"
-- Spotlight / dict-search hot path: the WHERE-clause was running a
-- chained REPLACE() per row to strip pinyin tone digits + spaces +
-- middle-dot before LIKE-matching, plus an OR LIKE across word /
-- alt_word / reading / gloss with `'%foo%'` patterns. On a 150k-row
-- CC-CEDICT install this fell into a full table scan with ~10µs of
-- per-row work — telemetry was logging >1s slow-query warnings.
--
-- Fix is two-part:
--   1. A virtual generated `reading_norm` column makes the strip
--      result available as a column lookup rather than recomputed
--      per row. Generated VIRTUAL means the value is computed on
--      read; the index below stores it once and the planner can do
--      O(log n) seeks for prefix matches.
--   2. Composite indexes keyed `(dict_id, ...)` so the planner can
--      narrow to the active workspace's dictionary first, then do a
--      range scan. dict_id is always part of the WHERE via the
--      JOIN, so prefixing it cuts the scan range by orders of
--      magnitude even for queries that fall back to LIKE '%…%'.
ALTER TABLE dict_entries ADD COLUMN reading_norm TEXT
  GENERATED ALWAYS AS (
    lower(replace(replace(replace(replace(replace(replace(replace(
      coalesce(reading, ''),
      ' ', ''),
      '1', ''),
      '2', ''),
      '3', ''),
      '4', ''),
      '5', ''),
      '·', ''))
  ) VIRTUAL;
CREATE INDEX IF NOT EXISTS idx_dict_entries_dict_word
  ON dict_entries(dict_id, word);
CREATE INDEX IF NOT EXISTS idx_dict_entries_dict_alt
  ON dict_entries(dict_id, alt_word);
CREATE INDEX IF NOT EXISTS idx_dict_entries_dict_reading_norm
  ON dict_entries(dict_id, reading_norm);
"#;

const V23_SQL: &str = r#"
-- Per-word audio timing for the reader's karaoke highlight. Stored
-- as JSON next to the audio bytes so a cache hit can drive the
-- highlight without re-synthesising. Shape: `[{ "offsetMs": int,
-- "durationMs": int, "text": "..." }, ...]`. Null when the audio came
-- from a backend without per-word timing (everything that isn't Edge
-- TTS today) — the reader falls back to a sentence-level estimate in
-- that case.
ALTER TABLE reader_documents ADD COLUMN audio_boundaries TEXT;
"#;

const V22_SQL: &str = r#"
-- Track a card's position in the learning / relearning ladder. New
-- cards graduate through `learningSteps` (e.g. 1 min → 10 min →
-- review); lapsed review cards drop into `relearningSteps` (e.g.
-- 10 min → review). Without an explicit step counter the scheduler
-- can't decide "am I on step 0 or step 1?", so we'd have to infer
-- from stability — brittle and breaks the moment the user changes
-- their step list. Defaults to 0 (the first step) so existing rows
-- remain consistent with their current `status` field.
ALTER TABLE vocab_entries ADD COLUMN learning_step INTEGER NOT NULL DEFAULT 0;
"#;

const V21_SQL: &str = r#"
-- Per-passage cached TTS audio. Mirrors V17 (vocab_audio): once a
-- reader doc has been synthesised we keep the bytes inline so
-- re-opening the player is instant + offline. Cache is invalidated
-- on body edits (handled in saveReaderDoc).
ALTER TABLE reader_documents ADD COLUMN audio_data BLOB;
ALTER TABLE reader_documents ADD COLUMN audio_mime TEXT;
"#;

const V20_SQL: &str = r#"
-- Expression indexes on the lowercased dict columns. Without these,
-- the case-insensitive fallback in `lookupDictBatch`
-- (`LOWER(word) IN (...)`) does a full table scan over the whole
-- dict — ~150k rows for Beolingus = 1.8s per chat bubble on a hot
-- connection, longer on contended ones. SQLite uses expression
-- indexes the same way it uses column indexes, so the IN-against-
-- LOWER becomes an O(log n) lookup.
CREATE INDEX IF NOT EXISTS idx_dict_entries_lower_word
  ON dict_entries(LOWER(word));
CREATE INDEX IF NOT EXISTS idx_dict_entries_lower_alt
  ON dict_entries(LOWER(alt_word));
"#;

const V19_SQL: &str = r#"
-- Pack-as-library: vocab can now sit in a workspace as part of an
-- imported pack WITHOUT being part of active SRS. The user opts each
-- word into "active learning" explicitly (via a button on the
-- collection, by clicking the word in a reader, by completing the
-- chapter that introduces it, etc.).
--
-- Default value 1: every existing row in every existing install was
-- "active" before this migration, so we don't sandbag a long-time
-- user's review queue. New pack imports flip this to 0; the existing
-- "Add to my learning" UX (and chapter completion, click-to-define)
-- promotes them to 1.
ALTER TABLE vocab_entries ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_vocab_active
  ON vocab_entries(workspace_id, is_active, due_at);
"#;

const V18_SQL: &str = r#"
-- Per-review history for the card detail page. One row per FSRS
-- grade event so the user can see "you've reviewed 餐馆 7 times: 4
-- Good, 1 Hard, 2 Again" plus a sparkline of stability over time.
--
-- Why a separate table instead of denormalising on `vocab_entries`:
-- the row count grows linearly with reviews (a 5-year veteran has
-- thousands per word), and we want O(1) writes on the hot path
-- (review session) plus cheap aggregates per card. Indexed on
-- (vocab_id, reviewed_at) so the per-card history query stays fast.
CREATE TABLE IF NOT EXISTS vocab_reviews (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  vocab_id        INTEGER NOT NULL REFERENCES vocab_entries(id) ON DELETE CASCADE,
  grade           TEXT    NOT NULL,           -- 'again' | 'hard' | 'good' | 'easy'
  prev_status     TEXT,                       -- snapshot before this review (for diff displays)
  new_status      TEXT    NOT NULL,
  prev_stability  REAL,
  new_stability   REAL    NOT NULL,
  prev_due_at     INTEGER,
  new_due_at      INTEGER,
  reviewed_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_vocab_reviews_card
  ON vocab_reviews(vocab_id, reviewed_at DESC);
"#;

const V17_SQL: &str = r#"
-- Per-flashcard cached TTS audio. Lets the user pre-generate audio
-- for a vocab entry once (via the configured TTS provider) and have
-- review play instantly + offline thereafter.
--
-- Storage:
--   • audio_data is the raw bytes returned by whichever provider
--     synthesised it (OpenAI, Edge, ElevenLabs, MiniMax). All four
--     emit mp3 today, but we record the mime explicitly so a future
--     provider returning Opus / WebM / WAV doesn't require a
--     migration.
--   • Lives directly on `vocab_entries` (not a side table) because
--     it's strictly 1:1 with the row and we already do this for
--     `image_data`. List queries continue to skip the BLOB via a
--     dedicated `getVocabAudio(id)` fetch — same pattern as images.
--
-- Both columns are nullable; absence of audio is the default state
-- for every existing card.
ALTER TABLE vocab_entries ADD COLUMN audio_data BLOB;
ALTER TABLE vocab_entries ADD COLUMN audio_mime TEXT;
"#;

const V16_SQL: &str = r#"
-- Local-embedding RAG (Phase 2 of the knowledge base). The v7
-- `knowledge_chunks` + `knowledge_fts` tables already model chunked
-- content; this layer adds a parallel embedding cache so the same
-- chunks can be retrieved by semantic similarity, not just keyword
-- match.
--
-- Design notes:
--   • One row per (chunk, model). The model name is part of the PK so
--     a user can switch from `nomic-embed-text` to `bge-m3` without
--     blowing away the old vectors — the rebuilder just walks chunks
--     missing a row for the active model.
--   • `vector` is a little-endian f32 BLOB (dim * 4 bytes). SQLite has
--     no first-class vector type and we only need top-K cosine over a
--     few hundred candidates, so an in-process scan in JS is plenty
--     fast for the workloads this app sees (a workspace with even
--     50k chunks scans in well under 100 ms with FTS5 prefiltering).
--   • ON DELETE CASCADE so reindexing a source (which deletes &
--     reinserts chunks) cleans the embeddings automatically — no
--     orphaned vectors.
--
-- The hybrid retrieval mode reads from this table when present and
-- falls back to keyword-only when not, so the feature is fully
-- additive: existing workspaces keep working untouched until the user
-- opts in via Settings → Knowledge.
CREATE TABLE IF NOT EXISTS knowledge_embeddings (
  chunk_id   INTEGER NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
  model      TEXT    NOT NULL,
  dim        INTEGER NOT NULL,
  vector     BLOB    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (chunk_id, model)
);
-- The hot query is "give me all embeddings for these N candidate
-- chunks under the active model" — composite index matches that
-- access pattern.
CREATE INDEX IF NOT EXISTS idx_kemb_model_chunk
  ON knowledge_embeddings(model, chunk_id);
"#;

const V15_SQL: &str = r#"
-- Card categories. The flashcard surface used to assume every card was
-- a single-word "vocab" card; we now model three flavours so the
-- dashboard can show split due-counts and so the AI card generator can
-- emit cards of different shapes:
--
--   'vocab'    — a word/phrase. Front = word, back = reading + gloss.
--                Default for everything that already exists.
--   'sentence' — a full sentence. Front = sentence, back = translation
--                (stored in `gloss`). Generated by AI or hand-added.
--   'writing'  — a writing prompt or, for zh, a single hanzi to draw.
--                Used by the hanzi-writing plugin.
--
-- Adding the column with a DEFAULT keeps existing rows valid (they all
-- become 'vocab'), so saveVocab/listVocab/etc keep working unchanged
-- when callers don't pass a kind. The composite index supports the
-- dashboard's per-kind due-count query without a full table scan.
ALTER TABLE vocab_entries ADD COLUMN kind TEXT NOT NULL DEFAULT 'vocab';
CREATE INDEX IF NOT EXISTS idx_vocab_kind_due
  ON vocab_entries(workspace_id, kind, due_at);
"#;

const V14_SQL: &str = r#"
-- Translation engines. Mirrors `provider_configs` shape so the user can
-- configure one row per (engine, account) pair: e.g. a "DeepL Free" and
-- a "DeepL Pro" alongside a "Google (free)" fallback. The dialog reads
-- these to populate the engine picker; one row at a time can be marked
-- `is_default` so "Translate missing" knows which engine to call.
--
-- `kind` is one of: 'google-free' | 'google-cloud' | 'deepl' | 'baidu' | 'ai'.
-- For `kind = 'ai'`, `provider_id` points at a row in provider_configs and
-- `model` optionally overrides the provider's default model. Other kinds
-- leave both columns NULL.
CREATE TABLE IF NOT EXISTS translate_configs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL,
  label         TEXT    NOT NULL,
  api_key       TEXT,
  secondary_key TEXT,
  base_url      TEXT,
  provider_id   INTEGER REFERENCES provider_configs(id) ON DELETE SET NULL,
  model         TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Seed the zero-config Google fallback so "Translate" works on a fresh
-- install with no further setup. Subsequent runs hit the OR IGNORE and
-- skip the insert; the user can edit / delete it like any other row.
INSERT OR IGNORE INTO translate_configs (id, kind, label, is_default)
VALUES (1, 'google-free', 'Google (free)', 1);
"#;

const V13_SQL: &str = r#"
-- Journal entries — guided writing practice. Each entry pairs a
-- topic (free text or AI-suggested or pulled from a textbook chapter)
-- with the user's prose and, after the user submits for correction,
-- a JSON blob of per-sentence corrections from the LLM.
--
-- `state` walks 'draft' → 'corrected'. `source` records where the
-- topic came from (manual / ai / textbook:<chapterId> / vocab) so we
-- can show provenance and re-suggest similar topics later. The
-- corrections column holds an array of
--   { original, corrected, explanation, severity }
-- objects produced by the LLM correction pass.
CREATE TABLE IF NOT EXISTS journal_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  topic         TEXT,
  body          TEXT NOT NULL DEFAULT '',
  state         TEXT NOT NULL DEFAULT 'draft',
  corrections   TEXT,
  source        TEXT,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_journal_workspace
  ON journal_entries(workspace_id, updated_at DESC);
"#;

const V12_SQL: &str = r#"
-- Each library_chapter (textbook lesson) can carry its own vocabulary
-- list as a Collection. When the user marks a chapter complete, the
-- words in this collection get nudged into active rotation
-- (status='learning', due_at=now) so they show up in the next
-- Flashcards session — that's the textbook → SRS bridge.
-- ON DELETE SET NULL so deleting a Collection doesn't cascade to wipe
-- the chapter row; the chapter just unlinks.
ALTER TABLE library_chapters ADD COLUMN collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_chapter_collection ON library_chapters(collection_id);
"#;

const V11_SQL: &str = r#"
-- Subcollections. A collection can now nest under another collection
-- via parent_collection_id, forming a tree rooted at NULL. Used to model
-- "HSK 3 → Lesson 1 / Lesson 2 / ..." or "Genki I → Vocab / Grammar / Kanji"
-- without flattening the hierarchy.
ALTER TABLE collections ADD COLUMN parent_collection_id INTEGER REFERENCES collections(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_collections_parent ON collections(parent_collection_id);
"#;

const V10_SQL: &str = r#"
-- Habits. Each row is one repeating goal scoped to a workspace: e.g.
-- "Study 30 min/day" or "Read for 2h/week". The user can use the
-- built-in activity kinds (chat / review / reading / writing / speaking)
-- or invent their own — `activity_kind` is free-text so a user-defined
-- kind ("listening", "shadowing") slots into the same time-tracking
-- pipeline study_sessions already powers.
CREATE TABLE IF NOT EXISTS habits (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id    INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- Filter for which study_sessions count toward this habit. NULL = any kind.
  activity_kind   TEXT,
  -- Target the user picked. Always stored as seconds for arithmetic; the
  -- UI converts to minutes / hours.
  target_secs     INTEGER NOT NULL,
  -- 'daily' | 'weekly' — the cadence the target resets on.
  frequency       TEXT NOT NULL DEFAULT 'daily',
  -- Optional one-char emoji or letter for the dashboard chip. Purely
  -- cosmetic; null is fine.
  glyph           TEXT,
  -- Soft-delete-style archive flag so deleted habits keep their history
  -- attached without showing up on the dashboard.
  archived_at     INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_habits_workspace ON habits(workspace_id, archived_at);
"#;

const V9_SQL: &str = r#"
-- Reader-doc level variants. A "book" lives as a library_item (kind='ebook' or
-- 'textbook') whose chapters are separate reader_documents linked via
-- library_item_id + chapter_position. Each chapter can have child rows that
-- represent simplified versions ('beginner', 'intermediate'); parent_id points
-- back to the original. The 'original' row has parent_id = NULL.
ALTER TABLE reader_documents ADD COLUMN parent_id INTEGER REFERENCES reader_documents(id) ON DELETE CASCADE;
ALTER TABLE reader_documents ADD COLUMN level TEXT NOT NULL DEFAULT 'original';
ALTER TABLE reader_documents ADD COLUMN library_item_id INTEGER REFERENCES library_items(id) ON DELETE SET NULL;
ALTER TABLE reader_documents ADD COLUMN chapter_position INTEGER;
CREATE INDEX IF NOT EXISTS idx_reader_parent ON reader_documents(parent_id);
CREATE INDEX IF NOT EXISTS idx_reader_library ON reader_documents(library_item_id, chapter_position);
"#;

const V8_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS collections (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0,
  -- 'user' | 'preset' | 'imported' — preset is reserved for paid/published packs.
  source        TEXT NOT NULL DEFAULT 'user',
  -- Stable id for license / preset lookup later (e.g. "hsk-1", "genki-l3").
  preset_id     TEXT,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_collections_workspace ON collections(workspace_id, updated_at DESC);
-- Each workspace can have at most one default collection.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_collections_default
  ON collections(workspace_id) WHERE is_default = 1;

CREATE TABLE IF NOT EXISTS collection_words (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  vocab_id      INTEGER NOT NULL REFERENCES vocab_entries(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  added_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (collection_id, vocab_id)
);
CREATE INDEX IF NOT EXISTS idx_cw_vocab ON collection_words(vocab_id);
CREATE INDEX IF NOT EXISTS idx_cw_position ON collection_words(collection_id, position);
"#;

const V7_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_kind   TEXT NOT NULL,           -- 'reader' | 'chapter' | 'note' | 'chat' | 'library'
  source_id     INTEGER NOT NULL,
  source_title  TEXT,                    -- denormalized for fast result rendering
  position      INTEGER NOT NULL DEFAULT 0,
  content       TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_chunks_workspace ON knowledge_chunks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON knowledge_chunks(source_kind, source_id);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  content,
  content='knowledge_chunks',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ai AFTER INSERT ON knowledge_chunks BEGIN
  INSERT INTO knowledge_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ad AFTER DELETE ON knowledge_chunks BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_chunks_au AFTER UPDATE ON knowledge_chunks BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO knowledge_fts(rowid, content) VALUES (new.id, new.content);
END;
"#;

const V6_SQL: &str = r#"
ALTER TABLE vocab_entries ADD COLUMN image_data TEXT;
ALTER TABLE vocab_entries ADD COLUMN card_notes TEXT;
ALTER TABLE vocab_entries ADD COLUMN front_extra TEXT;
"#;

const V5_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS library_chapters (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      INTEGER NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  title        TEXT NOT NULL,
  completed_at INTEGER,
  notes        TEXT,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_chapters_item ON library_chapters(item_id, position);
"#;

const V4_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS goals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL,                 -- 'vocab' | 'minutes' | 'sessions'
  skill         TEXT,                          -- 'reading' | 'writing' | 'speaking' | 'listening' | null
  target        INTEGER NOT NULL,
  deadline      INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  completed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_goals_workspace ON goals(workspace_id, created_at);
"#;

const V3_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        TEXT NOT NULL DEFAULT 'Untitled',
  body         TEXT NOT NULL DEFAULT '',
  pinned       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_workspace ON notes(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS library_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id    INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  author          TEXT,
  source          TEXT,
  total_units     INTEGER,
  unit_label      TEXT NOT NULL DEFAULT 'pages',
  completed_units INTEGER NOT NULL DEFAULT 0,
  total_seconds   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',
  cover_url       TEXT,
  notes           TEXT,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_library_workspace ON library_items(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS system_prompts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS reader_documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  source_url   TEXT,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_reader_workspace ON reader_documents(workspace_id, updated_at DESC);
"#;

const V32_SQL: &str = r#"
-- Sync v2 change tracking (see docs/sync-protocol.md).
--
-- Every synced table gets three columns maintained by triggers:
--   guid  TEXT    — stable cross-device identity (backfilled from the
--                   legacy cloud-sync clientId format where the old
--                   sync pushed one, so first v2 sync adopts existing
--                   cloud rows instead of duplicating them)
--   mtime INTEGER — epoch-ms last-modified, drives last-write-wins
--   dirty INTEGER — 0 clean | 1 needs push | 2 being deleted by the
--                   sync engine (suppresses the grave trigger)
--
-- Triggers (not db.ts instrumentation) so ANY writer — db.ts, the
-- Rust api_server (MCP), future code — is tracked. The engine's own
-- writes are distinguishable because they always set mtime/dirty/guid
-- explicitly, which the WHEN clauses treat as "not an app write".

-- Grave log: one row per locally-deleted synced entity, pushed on the
-- next sync then removed. gid formats: plain guid for guid-bearing
-- kinds; composed natural keys for the rest (review = vocabGuid @ ts,
-- collectionWord = colGuid ~ vocabGuid, pdictEntry = lang \x1f word).
CREATE TABLE IF NOT EXISTS sync_graves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  gid        TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(kind, gid)
);

-- ── workspaces (kind 'workspace') ─────
ALTER TABLE workspaces ADD COLUMN guid TEXT;
ALTER TABLE workspaces ADD COLUMN mtime INTEGER;
ALTER TABLE workspaces ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;
UPDATE workspaces SET
  guid  = lower(hex(randomblob(16))),
  mtime = (created_at) * 1000,
  dirty = 1;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_workspaces_guid ON workspaces(guid);
CREATE INDEX IF NOT EXISTS idx_workspaces_dirty ON workspaces(dirty) WHERE dirty = 1;
CREATE TRIGGER IF NOT EXISTS ts_workspaces_ai AFTER INSERT ON workspaces
WHEN NEW.guid IS NULL
BEGIN
  UPDATE workspaces SET guid = lower(hex(randomblob(16))), mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_workspaces_au AFTER UPDATE ON workspaces
WHEN NEW.mtime IS OLD.mtime AND NEW.dirty IS OLD.dirty AND NEW.guid IS OLD.guid
BEGIN
  UPDATE workspaces SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_workspaces_ad AFTER DELETE ON workspaces
WHEN OLD.dirty IS NOT 2 AND OLD.guid IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO sync_graves(kind, gid) VALUES ('workspace', OLD.guid);
END;

-- ── collections (kind 'collection') ─────
ALTER TABLE collections ADD COLUMN guid TEXT;
ALTER TABLE collections ADD COLUMN mtime INTEGER;
ALTER TABLE collections ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;
UPDATE collections SET
  guid  = CASE WHEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') IS NOT NULL
       THEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') || ':collection:' || id
       ELSE lower(hex(randomblob(16))) END,
  mtime = (COALESCE(updated_at, created_at)) * 1000,
  dirty = 1;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_collections_guid ON collections(guid);
CREATE INDEX IF NOT EXISTS idx_collections_dirty ON collections(dirty) WHERE dirty = 1;
CREATE TRIGGER IF NOT EXISTS ts_collections_ai AFTER INSERT ON collections
WHEN NEW.guid IS NULL
BEGIN
  UPDATE collections SET guid = lower(hex(randomblob(16))), mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_collections_au AFTER UPDATE ON collections
WHEN NEW.mtime IS OLD.mtime AND NEW.dirty IS OLD.dirty AND NEW.guid IS OLD.guid
BEGIN
  UPDATE collections SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_collections_ad AFTER DELETE ON collections
WHEN OLD.dirty IS NOT 2 AND OLD.guid IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO sync_graves(kind, gid) VALUES ('collection', OLD.guid);
END;

-- ── vocab_entries (kind 'vocab') ─────
ALTER TABLE vocab_entries ADD COLUMN guid TEXT;
ALTER TABLE vocab_entries ADD COLUMN mtime INTEGER;
ALTER TABLE vocab_entries ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;
UPDATE vocab_entries SET
  guid  = lower(hex(randomblob(16))),
  mtime = (COALESCE(last_review, created_at)) * 1000,
  dirty = 1;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_vocab_entries_guid ON vocab_entries(guid);
CREATE INDEX IF NOT EXISTS idx_vocab_entries_dirty ON vocab_entries(dirty) WHERE dirty = 1;
CREATE TRIGGER IF NOT EXISTS ts_vocab_entries_ai AFTER INSERT ON vocab_entries
WHEN NEW.guid IS NULL
BEGIN
  UPDATE vocab_entries SET guid = lower(hex(randomblob(16))), mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_vocab_entries_au AFTER UPDATE ON vocab_entries
WHEN NEW.mtime IS OLD.mtime AND NEW.dirty IS OLD.dirty AND NEW.guid IS OLD.guid
BEGIN
  UPDATE vocab_entries SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_vocab_entries_ad AFTER DELETE ON vocab_entries
WHEN OLD.dirty IS NOT 2 AND OLD.guid IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO sync_graves(kind, gid) VALUES ('vocab', OLD.guid);
END;

-- ── library_items (kind 'libraryItem') ─────
ALTER TABLE library_items ADD COLUMN guid TEXT;
ALTER TABLE library_items ADD COLUMN mtime INTEGER;
ALTER TABLE library_items ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;
UPDATE library_items SET
  guid  = CASE WHEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') IS NOT NULL
       THEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') || ':library:' || id
       ELSE lower(hex(randomblob(16))) END,
  mtime = (COALESCE(updated_at, created_at)) * 1000,
  dirty = 1;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_library_items_guid ON library_items(guid);
CREATE INDEX IF NOT EXISTS idx_library_items_dirty ON library_items(dirty) WHERE dirty = 1;
CREATE TRIGGER IF NOT EXISTS ts_library_items_ai AFTER INSERT ON library_items
WHEN NEW.guid IS NULL
BEGIN
  UPDATE library_items SET guid = lower(hex(randomblob(16))), mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_library_items_au AFTER UPDATE ON library_items
WHEN NEW.mtime IS OLD.mtime AND NEW.dirty IS OLD.dirty AND NEW.guid IS OLD.guid
BEGIN
  UPDATE library_items SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_library_items_ad AFTER DELETE ON library_items
WHEN OLD.dirty IS NOT 2 AND OLD.guid IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO sync_graves(kind, gid) VALUES ('libraryItem', OLD.guid);
END;

-- ── library_chapters (kind 'chapter') ─────
ALTER TABLE library_chapters ADD COLUMN guid TEXT;
ALTER TABLE library_chapters ADD COLUMN mtime INTEGER;
ALTER TABLE library_chapters ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;
UPDATE library_chapters SET
  guid  = lower(hex(randomblob(16))),
  mtime = (COALESCE(completed_at, created_at)) * 1000,
  dirty = 1;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_library_chapters_guid ON library_chapters(guid);
CREATE INDEX IF NOT EXISTS idx_library_chapters_dirty ON library_chapters(dirty) WHERE dirty = 1;
CREATE TRIGGER IF NOT EXISTS ts_library_chapters_ai AFTER INSERT ON library_chapters
WHEN NEW.guid IS NULL
BEGIN
  UPDATE library_chapters SET guid = lower(hex(randomblob(16))), mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_library_chapters_au AFTER UPDATE ON library_chapters
WHEN NEW.mtime IS OLD.mtime AND NEW.dirty IS OLD.dirty AND NEW.guid IS OLD.guid
BEGIN
  UPDATE library_chapters SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_library_chapters_ad AFTER DELETE ON library_chapters
WHEN OLD.dirty IS NOT 2 AND OLD.guid IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO sync_graves(kind, gid) VALUES ('chapter', OLD.guid);
END;

-- ── study_sessions (kind 'session') ─────
ALTER TABLE study_sessions ADD COLUMN guid TEXT;
ALTER TABLE study_sessions ADD COLUMN mtime INTEGER;
ALTER TABLE study_sessions ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;
UPDATE study_sessions SET
  guid  = CASE WHEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') IS NOT NULL
       THEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') || ':session:' || id
       ELSE lower(hex(randomblob(16))) END,
  mtime = (COALESCE(ended_at, started_at)) * 1000,
  dirty = 1;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_study_sessions_guid ON study_sessions(guid);
CREATE INDEX IF NOT EXISTS idx_study_sessions_dirty ON study_sessions(dirty) WHERE dirty = 1;
CREATE TRIGGER IF NOT EXISTS ts_study_sessions_ai AFTER INSERT ON study_sessions
WHEN NEW.guid IS NULL
BEGIN
  UPDATE study_sessions SET guid = lower(hex(randomblob(16))), mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_study_sessions_au AFTER UPDATE ON study_sessions
WHEN NEW.mtime IS OLD.mtime AND NEW.dirty IS OLD.dirty AND NEW.guid IS OLD.guid
BEGIN
  UPDATE study_sessions SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_study_sessions_ad AFTER DELETE ON study_sessions
WHEN OLD.dirty IS NOT 2 AND OLD.guid IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO sync_graves(kind, gid) VALUES ('session', OLD.guid);
END;

-- ── notes (kind 'note') ─────
ALTER TABLE notes ADD COLUMN guid TEXT;
ALTER TABLE notes ADD COLUMN mtime INTEGER;
ALTER TABLE notes ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;
UPDATE notes SET
  guid  = CASE WHEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') IS NOT NULL
       THEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') || ':note:' || id
       ELSE lower(hex(randomblob(16))) END,
  mtime = (COALESCE(updated_at, created_at)) * 1000,
  dirty = 1;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_notes_guid ON notes(guid);
CREATE INDEX IF NOT EXISTS idx_notes_dirty ON notes(dirty) WHERE dirty = 1;
CREATE TRIGGER IF NOT EXISTS ts_notes_ai AFTER INSERT ON notes
WHEN NEW.guid IS NULL
BEGIN
  UPDATE notes SET guid = lower(hex(randomblob(16))), mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_notes_au AFTER UPDATE ON notes
WHEN NEW.mtime IS OLD.mtime AND NEW.dirty IS OLD.dirty AND NEW.guid IS OLD.guid
BEGIN
  UPDATE notes SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_notes_ad AFTER DELETE ON notes
WHEN OLD.dirty IS NOT 2 AND OLD.guid IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO sync_graves(kind, gid) VALUES ('note', OLD.guid);
END;

-- ── goals (kind 'goal') ─────
ALTER TABLE goals ADD COLUMN guid TEXT;
ALTER TABLE goals ADD COLUMN mtime INTEGER;
ALTER TABLE goals ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;
UPDATE goals SET
  guid  = CASE WHEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') IS NOT NULL
       THEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') || ':goal:' || id
       ELSE lower(hex(randomblob(16))) END,
  mtime = (COALESCE(completed_at, created_at)) * 1000,
  dirty = 1;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_goals_guid ON goals(guid);
CREATE INDEX IF NOT EXISTS idx_goals_dirty ON goals(dirty) WHERE dirty = 1;
CREATE TRIGGER IF NOT EXISTS ts_goals_ai AFTER INSERT ON goals
WHEN NEW.guid IS NULL
BEGIN
  UPDATE goals SET guid = lower(hex(randomblob(16))), mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_goals_au AFTER UPDATE ON goals
WHEN NEW.mtime IS OLD.mtime AND NEW.dirty IS OLD.dirty AND NEW.guid IS OLD.guid
BEGIN
  UPDATE goals SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_goals_ad AFTER DELETE ON goals
WHEN OLD.dirty IS NOT 2 AND OLD.guid IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO sync_graves(kind, gid) VALUES ('goal', OLD.guid);
END;

-- ── habits (kind 'habit') ─────
ALTER TABLE habits ADD COLUMN guid TEXT;
ALTER TABLE habits ADD COLUMN mtime INTEGER;
ALTER TABLE habits ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;
UPDATE habits SET
  guid  = lower(hex(randomblob(16))),
  mtime = (COALESCE(updated_at, created_at)) * 1000,
  dirty = 1;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_habits_guid ON habits(guid);
CREATE INDEX IF NOT EXISTS idx_habits_dirty ON habits(dirty) WHERE dirty = 1;
CREATE TRIGGER IF NOT EXISTS ts_habits_ai AFTER INSERT ON habits
WHEN NEW.guid IS NULL
BEGIN
  UPDATE habits SET guid = lower(hex(randomblob(16))), mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_habits_au AFTER UPDATE ON habits
WHEN NEW.mtime IS OLD.mtime AND NEW.dirty IS OLD.dirty AND NEW.guid IS OLD.guid
BEGIN
  UPDATE habits SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_habits_ad AFTER DELETE ON habits
WHEN OLD.dirty IS NOT 2 AND OLD.guid IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO sync_graves(kind, gid) VALUES ('habit', OLD.guid);
END;

-- ── chats (kind 'chat') ─────
ALTER TABLE chats ADD COLUMN guid TEXT;
ALTER TABLE chats ADD COLUMN mtime INTEGER;
ALTER TABLE chats ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;
UPDATE chats SET
  guid  = CASE WHEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') IS NOT NULL
       THEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') || ':chat:' || id
       ELSE lower(hex(randomblob(16))) END,
  mtime = (COALESCE(updated_at, created_at)) * 1000,
  dirty = 1;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_chats_guid ON chats(guid);
CREATE INDEX IF NOT EXISTS idx_chats_dirty ON chats(dirty) WHERE dirty = 1;
CREATE TRIGGER IF NOT EXISTS ts_chats_ai AFTER INSERT ON chats
WHEN NEW.guid IS NULL
BEGIN
  UPDATE chats SET guid = lower(hex(randomblob(16))), mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_chats_au AFTER UPDATE ON chats
WHEN NEW.mtime IS OLD.mtime AND NEW.dirty IS OLD.dirty AND NEW.guid IS OLD.guid
BEGIN
  UPDATE chats SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_chats_ad AFTER DELETE ON chats
WHEN OLD.dirty IS NOT 2 AND OLD.guid IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO sync_graves(kind, gid) VALUES ('chat', OLD.guid);
END;

-- ── messages (kind 'message') ─────
ALTER TABLE messages ADD COLUMN guid TEXT;
ALTER TABLE messages ADD COLUMN mtime INTEGER;
ALTER TABLE messages ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;
UPDATE messages SET
  guid  = CASE WHEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') IS NOT NULL
       THEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') || ':message:' || id
       ELSE lower(hex(randomblob(16))) END,
  mtime = (created_at) * 1000,
  dirty = 1;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_messages_guid ON messages(guid);
CREATE INDEX IF NOT EXISTS idx_messages_dirty ON messages(dirty) WHERE dirty = 1;
CREATE TRIGGER IF NOT EXISTS ts_messages_ai AFTER INSERT ON messages
WHEN NEW.guid IS NULL
BEGIN
  UPDATE messages SET guid = lower(hex(randomblob(16))), mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_messages_au AFTER UPDATE ON messages
WHEN NEW.mtime IS OLD.mtime AND NEW.dirty IS OLD.dirty AND NEW.guid IS OLD.guid
BEGIN
  UPDATE messages SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_messages_ad AFTER DELETE ON messages
WHEN OLD.dirty IS NOT 2 AND OLD.guid IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO sync_graves(kind, gid) VALUES ('message', OLD.guid);
END;

-- ── journal_entries (kind 'journal') ─────
ALTER TABLE journal_entries ADD COLUMN guid TEXT;
ALTER TABLE journal_entries ADD COLUMN mtime INTEGER;
ALTER TABLE journal_entries ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;
UPDATE journal_entries SET
  guid  = CASE WHEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') IS NOT NULL
       THEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') || ':journal:' || id
       ELSE lower(hex(randomblob(16))) END,
  mtime = (COALESCE(updated_at, created_at)) * 1000,
  dirty = 1;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_journal_entries_guid ON journal_entries(guid);
CREATE INDEX IF NOT EXISTS idx_journal_entries_dirty ON journal_entries(dirty) WHERE dirty = 1;
CREATE TRIGGER IF NOT EXISTS ts_journal_entries_ai AFTER INSERT ON journal_entries
WHEN NEW.guid IS NULL
BEGIN
  UPDATE journal_entries SET guid = lower(hex(randomblob(16))), mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_journal_entries_au AFTER UPDATE ON journal_entries
WHEN NEW.mtime IS OLD.mtime AND NEW.dirty IS OLD.dirty AND NEW.guid IS OLD.guid
BEGIN
  UPDATE journal_entries SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_journal_entries_ad AFTER DELETE ON journal_entries
WHEN OLD.dirty IS NOT 2 AND OLD.guid IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO sync_graves(kind, gid) VALUES ('journal', OLD.guid);
END;

-- ── reader_documents (kind 'readerDoc') ─────
ALTER TABLE reader_documents ADD COLUMN guid TEXT;
ALTER TABLE reader_documents ADD COLUMN mtime INTEGER;
ALTER TABLE reader_documents ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;
UPDATE reader_documents SET
  guid  = CASE WHEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') IS NOT NULL
       THEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') || ':reader:' || id
       ELSE lower(hex(randomblob(16))) END,
  mtime = (COALESCE(updated_at, created_at)) * 1000,
  dirty = 1;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_reader_documents_guid ON reader_documents(guid);
CREATE INDEX IF NOT EXISTS idx_reader_documents_dirty ON reader_documents(dirty) WHERE dirty = 1;
CREATE TRIGGER IF NOT EXISTS ts_reader_documents_ai AFTER INSERT ON reader_documents
WHEN NEW.guid IS NULL
BEGIN
  UPDATE reader_documents SET guid = lower(hex(randomblob(16))), mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_reader_documents_au AFTER UPDATE ON reader_documents
WHEN NEW.mtime IS OLD.mtime AND NEW.dirty IS OLD.dirty AND NEW.guid IS OLD.guid
BEGIN
  UPDATE reader_documents SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_reader_documents_ad AFTER DELETE ON reader_documents
WHEN OLD.dirty IS NOT 2 AND OLD.guid IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO sync_graves(kind, gid) VALUES ('readerDoc', OLD.guid);
END;

-- ── system_prompts (kind 'systemPrompt') ─────
ALTER TABLE system_prompts ADD COLUMN guid TEXT;
ALTER TABLE system_prompts ADD COLUMN mtime INTEGER;
ALTER TABLE system_prompts ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;
UPDATE system_prompts SET
  guid  = CASE WHEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') IS NOT NULL
       THEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') || ':prompt:' || id
       ELSE lower(hex(randomblob(16))) END,
  mtime = (created_at) * 1000,
  dirty = 1;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_system_prompts_guid ON system_prompts(guid);
CREATE INDEX IF NOT EXISTS idx_system_prompts_dirty ON system_prompts(dirty) WHERE dirty = 1;
CREATE TRIGGER IF NOT EXISTS ts_system_prompts_ai AFTER INSERT ON system_prompts
WHEN NEW.guid IS NULL
BEGIN
  UPDATE system_prompts SET guid = lower(hex(randomblob(16))), mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_system_prompts_au AFTER UPDATE ON system_prompts
WHEN NEW.mtime IS OLD.mtime AND NEW.dirty IS OLD.dirty AND NEW.guid IS OLD.guid
BEGIN
  UPDATE system_prompts SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_system_prompts_ad AFTER DELETE ON system_prompts
WHEN OLD.dirty IS NOT 2 AND OLD.guid IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO sync_graves(kind, gid) VALUES ('systemPrompt', OLD.guid);
END;

-- ── translate_configs (kind 'translateConfig') ─────
ALTER TABLE translate_configs ADD COLUMN guid TEXT;
ALTER TABLE translate_configs ADD COLUMN mtime INTEGER;
ALTER TABLE translate_configs ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;
UPDATE translate_configs SET
  guid  = CASE WHEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') IS NOT NULL
       THEN (SELECT value FROM settings WHERE key = 'tokori.install.uuid') || ':translate:' || id
       ELSE lower(hex(randomblob(16))) END,
  mtime = (created_at) * 1000,
  dirty = 1;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_translate_configs_guid ON translate_configs(guid);
CREATE INDEX IF NOT EXISTS idx_translate_configs_dirty ON translate_configs(dirty) WHERE dirty = 1;
CREATE TRIGGER IF NOT EXISTS ts_translate_configs_ai AFTER INSERT ON translate_configs
WHEN NEW.guid IS NULL
BEGIN
  UPDATE translate_configs SET guid = lower(hex(randomblob(16))), mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_translate_configs_au AFTER UPDATE ON translate_configs
WHEN NEW.mtime IS OLD.mtime AND NEW.dirty IS OLD.dirty AND NEW.guid IS OLD.guid
BEGIN
  UPDATE translate_configs SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_translate_configs_ad AFTER DELETE ON translate_configs
WHEN OLD.dirty IS NOT 2 AND OLD.guid IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO sync_graves(kind, gid) VALUES ('translateConfig', OLD.guid);
END;

-- ── vocab_reviews (kind 'review') — append-only, identity (vocabGuid, reviewed_at) ─────
ALTER TABLE vocab_reviews ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_vocab_reviews_dirty ON vocab_reviews(dirty) WHERE dirty = 1;
CREATE TRIGGER IF NOT EXISTS ts_vocab_reviews_ad AFTER DELETE ON vocab_reviews
WHEN OLD.dirty IS NOT 2
BEGIN
  INSERT OR IGNORE INTO sync_graves(kind, gid)
  SELECT 'review',
         (SELECT guid FROM vocab_entries WHERE id = OLD.vocab_id) || '@' || OLD.reviewed_at
  WHERE (SELECT guid FROM vocab_entries WHERE id = OLD.vocab_id) IS NOT NULL;
END;

-- ── collection_words (kind 'collectionWord') — identity (collectionGuid, vocabGuid) ─────
ALTER TABLE collection_words ADD COLUMN mtime INTEGER;
ALTER TABLE collection_words ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;
UPDATE collection_words SET mtime = added_at * 1000, dirty = 1;
CREATE INDEX IF NOT EXISTS idx_collection_words_dirty ON collection_words(dirty) WHERE dirty = 1;
CREATE TRIGGER IF NOT EXISTS ts_collection_words_au AFTER UPDATE ON collection_words
WHEN NEW.mtime IS OLD.mtime AND NEW.dirty IS OLD.dirty
BEGIN
  UPDATE collection_words SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
  WHERE collection_id = NEW.collection_id AND vocab_id = NEW.vocab_id;
END;
CREATE TRIGGER IF NOT EXISTS ts_collection_words_ad AFTER DELETE ON collection_words
WHEN OLD.dirty IS NOT 2
BEGIN
  INSERT OR IGNORE INTO sync_graves(kind, gid)
  SELECT 'collectionWord',
         (SELECT guid FROM collections WHERE id = OLD.collection_id) || '~' ||
         (SELECT guid FROM vocab_entries WHERE id = OLD.vocab_id)
  WHERE (SELECT guid FROM collections WHERE id = OLD.collection_id) IS NOT NULL
    AND (SELECT guid FROM vocab_entries WHERE id = OLD.vocab_id) IS NOT NULL;
END;

-- ── dict_entries (kind 'pdictEntry') — Personal dict rows only, identity (lang, word) ─────
-- Packaged/custom dictionary imports stay untracked (dirty stays 0),
-- so bulk installs don't spam the grave/dirty machinery.
ALTER TABLE dict_entries ADD COLUMN mtime INTEGER;
ALTER TABLE dict_entries ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;
UPDATE dict_entries SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1
WHERE dict_id IN (SELECT id FROM dictionaries WHERE name = 'Personal');
CREATE INDEX IF NOT EXISTS idx_dict_entries_dirty ON dict_entries(dirty) WHERE dirty = 1;
CREATE TRIGGER IF NOT EXISTS ts_dict_entries_ai AFTER INSERT ON dict_entries
WHEN NEW.mtime IS NULL
 AND (SELECT name FROM dictionaries WHERE id = NEW.dict_id) = 'Personal'
BEGIN
  UPDATE dict_entries SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1 WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_dict_entries_au AFTER UPDATE ON dict_entries
WHEN NEW.mtime IS OLD.mtime AND NEW.dirty IS OLD.dirty
 AND (SELECT name FROM dictionaries WHERE id = NEW.dict_id) = 'Personal'
BEGIN
  UPDATE dict_entries SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1 WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS ts_dict_entries_ad AFTER DELETE ON dict_entries
WHEN OLD.dirty IS NOT 2
 AND (SELECT name FROM dictionaries WHERE id = OLD.dict_id) = 'Personal'
BEGIN
  INSERT OR IGNORE INTO sync_graves(kind, gid)
  SELECT 'pdictEntry',
         (SELECT lang FROM dictionaries WHERE id = OLD.dict_id) || char(31) || OLD.word
  WHERE (SELECT lang FROM dictionaries WHERE id = OLD.dict_id) IS NOT NULL;
END;

-- ── settings (kind 'setting') — identity = key; engine filters to the syncable subset ─────
ALTER TABLE settings ADD COLUMN mtime INTEGER;
ALTER TABLE settings ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;
UPDATE settings SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1;
CREATE INDEX IF NOT EXISTS idx_settings_dirty ON settings(dirty) WHERE dirty = 1;
CREATE TRIGGER IF NOT EXISTS ts_settings_ai AFTER INSERT ON settings
WHEN NEW.mtime IS NULL
BEGIN
  UPDATE settings SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1 WHERE key = NEW.key;
END;
CREATE TRIGGER IF NOT EXISTS ts_settings_au AFTER UPDATE ON settings
WHEN NEW.mtime IS OLD.mtime AND NEW.dirty IS OLD.dirty
BEGIN
  UPDATE settings SET mtime = CAST(strftime('%s','now') AS INTEGER) * 1000, dirty = 1 WHERE key = NEW.key;
END;
"#;

/// One-time on-disk migrations for the app data dir.
///
/// Two legacy states are carried forward transparently so users
/// never see "move your DB" instructions:
///
/// 1. **Bundle id rename.** Pre-release builds used `com.tokori.app`
///    as the bundle identifier, which is also the OS data-dir name.
///    The current id is `ai.tokori.desktop` (the `.app` suffix
///    collided with macOS's application bundle extension). If the
///    new dir is missing but the old one exists, rename it.
/// 2. **DB filename rename.** Even older builds shipped the SQLite
///    file as `polyglot.db` (the project's original working name).
///    Recent builds use `tokori.db`.
///
/// Safe by design: only runs when the destination is absent (so no
/// clobbering on later launches), uses `rename` which is atomic on
/// POSIX + Windows, and silently logs failures so a permission
/// glitch can't brick app startup.
fn migrate_legacy_db_filename() {
    // Resolve the app data dir without booting Tauri — `dirs` gives
    // us the same paths Tauri does, just synchronously. Bundle id
    // must stay in sync with `tauri.conf.json`'s `identifier`.
    let base = match dirs::config_dir() {
        Some(p) => p,
        None => return,
    };
    let app_dir = base.join("ai.tokori.desktop");
    let legacy_app_dir = base.join("com.tokori.app");
    if !app_dir.exists() && legacy_app_dir.exists() {
        if let Err(e) = std::fs::rename(&legacy_app_dir, &app_dir) {
            eprintln!(
                "[tokori] legacy app dir rename com.tokori.app → ai.tokori.desktop failed: {e}"
            );
            // Fall back to the legacy path so we don't lose user
            // data — the SQL plugin will still find tokori.db there.
            return;
        }
    }

    let new_db = app_dir.join("tokori.db");
    if new_db.exists() {
        return; // Already migrated, or fresh install.
    }
    let legacy = app_dir.join("polyglot.db");
    if !legacy.exists() {
        return; // Fresh install — let the SQL plugin create tokori.db.
    }
    // Carry the WAL + SHM sidecars over too if they exist.
    for (from, to) in [
        ("polyglot.db", "tokori.db"),
        ("polyglot.db-wal", "tokori.db-wal"),
        ("polyglot.db-shm", "tokori.db-shm"),
    ] {
        let src = app_dir.join(from);
        let dst = app_dir.join(to);
        if src.exists() && !dst.exists() {
            if let Err(e) = std::fs::rename(&src, &dst) {
                eprintln!("[tokori] legacy DB rename {from} → {to} failed: {e}");
            }
        }
    }
}

/// Linux dev-mode dock helper.
///
/// Drops a tiny `.desktop` file in
/// `~/.local/share/applications/ai.tokori.desktop.desktop` so GNOME
/// Mutter (and other Wayland compositors) can match the running
/// window's `app_id` → `Icon=` → display the Tokori parrot in the
/// dock + overview, instead of the Tauri default fallback.
///
/// Why the file: on Wayland, `gtk_window_set_icon` only paints
/// inside the window's own decorations; the dock pulls its icon
/// from the system `.desktop` registry keyed by `app_id`. The .deb
/// / .AppImage bundler ships a real `.desktop` file at install
/// time; `tauri dev` doesn't, so dev users see the fallback.
///
/// Side files: also writes the icon PNG to
/// `~/.local/share/icons/ai.tokori.desktop.png` so the `Icon=` path
/// in the `.desktop` file resolves regardless of where the workspace
/// lives on disk.
///
/// Idempotent: rewrites both files on every launch so a change to
/// `icons/icon.png` propagates without manual cleanup. The whole
/// helper is ~1 ms of IO on a warm cache.
///
/// Dev-only: gated by `debug_assertions` so the bundled release
/// build doesn't fight its own installer-managed `.desktop` file.
#[cfg(all(target_os = "linux", debug_assertions))]
fn install_dev_desktop_file() -> std::io::Result<()> {
    let home = match dirs::home_dir() {
        Some(p) => p,
        None => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no $HOME — skipping dev .desktop install",
            ))
        }
    };
    let icon_dir = home.join(".local/share/icons");
    let apps_dir = home.join(".local/share/applications");
    std::fs::create_dir_all(&icon_dir)?;
    std::fs::create_dir_all(&apps_dir)?;

    // Write the icon to a stable path the `.desktop` file can name.
    // Using the app_id as the filename keeps it from clashing with
    // other apps' icons.
    let icon_path = icon_dir.join("ai.tokori.desktop.png");
    std::fs::write(&icon_path, include_bytes!("../icons/icon.png"))?;

    // The Exec line points at the current binary so `gnome-shell`'s
    // "launch new instance" action on the dock entry actually works
    // — not strictly required for icon matching, but harmless and
    // makes the entry behave like a normal app launcher.
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "tokori".to_string());
    let icon_path_str = icon_path.to_string_lossy();

    // `StartupWMClass` is the field GNOME Mutter matches against
    // the Wayland `app_id` / X11 `WM_CLASS` of our window. Must
    // match `tauri.conf.json::identifier` so the running window
    // pulls *this* entry's `Icon=` from the registry.
    let contents = format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Tokori (dev)\n\
         Comment=Tokori desktop — development build\n\
         Exec={exe}\n\
         Icon={icon}\n\
         Terminal=false\n\
         Categories=Education;Languages;\n\
         StartupWMClass=ai.tokori.desktop\n",
        exe = exe,
        icon = icon_path_str,
    );

    let desktop_path = apps_dir.join("ai.tokori.desktop.desktop");
    std::fs::write(&desktop_path, contents)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    migrate_legacy_db_filename();

    let migrations = vec![
    Migration {
      version: 1,
      description: "create_workspaces",
      // NOTE: byte-for-byte identical to the original v1 string. tauri-plugin-sql
      // hashes migration source — any whitespace change here breaks startup with
      // "migration 1 was previously applied but has been modified".
      sql: "\n      CREATE TABLE IF NOT EXISTS workspaces (\n        id           INTEGER PRIMARY KEY AUTOINCREMENT,\n        target_lang  TEXT    NOT NULL,\n        native_lang  TEXT    NOT NULL,\n        name         TEXT    NOT NULL,\n        created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))\n      );\n    ",
      kind: MigrationKind::Up,
    },
    Migration {
      version: 2,
      description: "core_tables",
      sql: r#"
        -- Key/value app settings (profile, default provider id, theme, etc.)
        CREATE TABLE IF NOT EXISTS settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        -- Provider configs (API keys, model picks). One per provider kind, with an active flag.
        CREATE TABLE IF NOT EXISTS provider_configs (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          kind       TEXT    NOT NULL, -- 'ollama' | 'openai' | 'anthropic'
          label      TEXT    NOT NULL,
          model      TEXT    NOT NULL,
          host       TEXT,             -- ollama host
          api_key    TEXT,             -- openai/anthropic
          base_url   TEXT,             -- openai-compat
          is_default INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );

        -- Chats (threads of messages within a workspace)
        CREATE TABLE IF NOT EXISTS chats (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          title        TEXT    NOT NULL DEFAULT 'New chat',
          created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_chats_workspace ON chats(workspace_id);

        -- Messages within a chat
        CREATE TABLE IF NOT EXISTS messages (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
          role       TEXT    NOT NULL, -- 'user' | 'assistant' | 'system'
          content    TEXT    NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);

        -- Vocabulary (per-workspace word list with FSRS-ish state)
        CREATE TABLE IF NOT EXISTS vocab_entries (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          word         TEXT    NOT NULL,
          reading      TEXT,            -- pinyin / furigana / etc.
          gloss        TEXT,
          source       TEXT NOT NULL DEFAULT 'manual', -- 'chat' | 'manual' | 'import'
          status       TEXT NOT NULL DEFAULT 'new',    -- 'new' | 'learning' | 'review' | 'mastered'
          stability    REAL NOT NULL DEFAULT 0,
          difficulty   REAL NOT NULL DEFAULT 5,
          due_at       INTEGER,
          last_review  INTEGER,
          review_count INTEGER NOT NULL DEFAULT 0,
          created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          UNIQUE(workspace_id, word)
        );
        CREATE INDEX IF NOT EXISTS idx_vocab_workspace ON vocab_entries(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_vocab_due ON vocab_entries(workspace_id, due_at);

        -- Study sessions
        CREATE TABLE IF NOT EXISTS study_sessions (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          kind         TEXT NOT NULL DEFAULT 'chat', -- 'chat' | 'review' | 'reading'
          started_at   INTEGER NOT NULL,
          ended_at     INTEGER,
          duration_secs INTEGER,
          words_seen   INTEGER NOT NULL DEFAULT 0,
          words_saved  INTEGER NOT NULL DEFAULT 0,
          notes        TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON study_sessions(workspace_id, started_at);

        -- Installed dictionaries
        CREATE TABLE IF NOT EXISTS dictionaries (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          lang         TEXT NOT NULL,
          name         TEXT NOT NULL,
          source_url   TEXT,
          installed_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          entry_count  INTEGER NOT NULL DEFAULT 0,
          UNIQUE(lang, name)
        );

        CREATE TABLE IF NOT EXISTS dict_entries (
          id       INTEGER PRIMARY KEY AUTOINCREMENT,
          dict_id  INTEGER NOT NULL REFERENCES dictionaries(id) ON DELETE CASCADE,
          word     TEXT NOT NULL,
          alt_word TEXT,                 -- trad form for zh
          reading  TEXT,
          gloss    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dict_entries_word ON dict_entries(word);
        CREATE INDEX IF NOT EXISTS idx_dict_entries_alt ON dict_entries(alt_word);

        -- Reserved for v0.3 RAG: documents + chunks. Schema is here so future migrations don't churn.
        CREATE TABLE IF NOT EXISTS documents (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          title        TEXT NOT NULL,
          source       TEXT,                          -- 'pdf' | 'epub' | 'youtube' | etc.
          path         TEXT,
          ingested_at  INTEGER
        );
        CREATE TABLE IF NOT EXISTS document_chunks (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          ord         INTEGER NOT NULL,
          text        TEXT NOT NULL,
          embedding   BLOB
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(document_id);
      "#,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 3,
      description: "notes_library_prompts_reader",
      sql: V3_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 4,
      description: "goals",
      sql: V4_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 5,
      description: "library_chapters",
      sql: V5_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 6,
      description: "vocab_card_fields",
      sql: V6_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 7,
      description: "knowledge_chunks_fts",
      sql: V7_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 8,
      description: "collections",
      sql: V8_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 9,
      description: "reader_doc_levels",
      sql: V9_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 10,
      description: "habits",
      sql: V10_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 11,
      description: "collection_subcollections",
      sql: V11_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 12,
      description: "chapter_vocabulary",
      sql: V12_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 13,
      description: "journal_entries",
      sql: V13_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 14,
      description: "translate_configs",
      sql: V14_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 15,
      description: "vocab_kind",
      sql: V15_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 16,
      description: "knowledge_embeddings",
      sql: V16_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 17,
      description: "vocab_audio",
      sql: V17_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 18,
      description: "vocab_reviews",
      sql: V18_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 19,
      description: "vocab_is_active",
      sql: V19_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 20,
      description: "dict_lower_indexes",
      sql: V20_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 21,
      description: "reader_audio",
      sql: V21_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 22,
      description: "vocab_learning_step",
      sql: V22_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 23,
      description: "reader_audio_boundaries",
      sql: V23_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 24,
      description: "dict_reading_norm_index",
      sql: V24_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 25,
      description: "rename_polot_markers_to_tokori",
      sql: V25_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 26,
      description: "vocab_translation_layout",
      sql: V26_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 27,
      description: "dict_pitch_accent",
      sql: V27_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 28,
      description: "drop_knowledge_embeddings",
      sql: "DROP TABLE IF EXISTS knowledge_embeddings;",
      kind: MigrationKind::Up,
    },
    Migration {
      version: 29,
      description: "dict_composite_lower_indexes",
      sql: V29_SQL,
      kind: MigrationKind::Up,
    },
    // Source documents (PDF/image blobs) + per-page OCR/text-layer word
    // boxes, for the interactive page-overlay reader. `reader_documents`
    // gains nullable pointers at a source doc + page range; notes link the
    // same source rows via `note_attachments`. Desktop-only — HOSTED keeps
    // its text-only path (see db.ts).
    Migration {
      version: 30,
      description: "source_documents_page_layouts",
      sql: r#"
        CREATE TABLE IF NOT EXISTS source_documents (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          kind         TEXT NOT NULL,
          file_name    TEXT NOT NULL,
          mime         TEXT NOT NULL,
          bytes        BLOB NOT NULL,
          num_pages    INTEGER NOT NULL DEFAULT 1,
          created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_source_docs_workspace
          ON source_documents(workspace_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS page_layouts (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          source_document_id INTEGER NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
          page_index         INTEGER NOT NULL,
          width              REAL NOT NULL,
          height             REAL NOT NULL,
          words_json         TEXT NOT NULL,
          ocr_done           INTEGER NOT NULL DEFAULT 0,
          created_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          UNIQUE(source_document_id, page_index)
        );

        ALTER TABLE reader_documents ADD COLUMN source_document_id INTEGER REFERENCES source_documents(id) ON DELETE SET NULL;
        ALTER TABLE reader_documents ADD COLUMN page_start INTEGER;
        ALTER TABLE reader_documents ADD COLUMN page_end INTEGER;

        CREATE TABLE IF NOT EXISTS note_attachments (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          note_id            INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          source_document_id INTEGER NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
          created_at         INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_note_attachments_note ON note_attachments(note_id);
      "#,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 31,
      description: "dict_fts_trigram_index",
      sql: V31_SQL,
      kind: MigrationKind::Up,
    },
    Migration {
      version: 32,
      description: "sync_v2_change_tracking",
      sql: V32_SQL,
      kind: MigrationKind::Up,
    },
  ];

    tauri::Builder::default()
        .manage(ApiServerState(Arc::new(ApiServer::new())))
        .manage(GlobalSearchState::default())
        .manage(whisper_local::LocalWhisperState::default())
        .manage(tunnel::TunnelState::new())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Custom window chrome — Windows + Linux only. The frontend
            // renders its own title bar (sidebar toggle, pin, settings +
            // min/max/close in `title-bar.tsx`), so the native frame
            // would double up. macOS is NOT stripped: tauri.conf.json
            // sets `titleBarStyle: Overlay` + `hiddenTitle` there, which
            // keeps the native traffic lights and floats them over the
            // same in-app bar. Edge resizing still works undecorated —
            // tao hit-tests the window borders itself on both platforms.
            //
            // Done at runtime rather than via per-platform config files
            // because JSON merge-patch replaces the whole `app.windows`
            // array — three diverging copies of the window object is a
            // worse trade than one cfg-gated line. setup() runs before
            // the event loop pumps, so the decorated frame is never
            // actually painted.
            #[cfg(not(target_os = "macos"))]
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = window.set_decorations(false) {
                    eprintln!("[chrome] set_decorations(false) failed: {e}");
                }
            }

            // Native macOS menu bar (screen-top). Replacing Tauri's
            // default menu is deliberate: it puts Settings… (⌘,) and
            // Toggle Sidebar (⌥⌘S) in the HIG-standard places.
            // Windows/Linux get no menu — the in-window title bar
            // handles chrome there, and an in-window menubar would
            // clash with it.
            #[cfg(target_os = "macos")]
            {
                let menu = build_app_menu(app.handle())?;
                app.set_menu(menu)?;
            }

            // First-launch window sizer.
            //
            // The static config in tauri.conf.json gives us a sane minimum
            // (1320×980), but on a real desktop we want to fill more of the
            // screen on the very first run so the user lands in a roomy
            // workspace instead of squinting at a small floating window.
            //
            // Strategy:
            //   • Mark this as "done" with a tiny file under app_config_dir
            //     so subsequent launches respect whatever size the user
            //     dragged the window to. We don't ship tauri-plugin-window-
            //     state yet, but a single boolean marker is enough — once
            //     we've sized once, we step out of the user's way forever.
            //   • If the primary monitor's logical size fits Full HD
            //     (≥ 1920×1080), set the window to 1920×1080 and re-center.
            //     Big enough to feel like "the app", small enough to leave
            //     other windows visible behind on a typical 2K/4K monitor.
            //   • Otherwise (laptop, smaller external) just maximize. Better
            //     than spilling off-screen.
            {
                use tauri::Manager;
                let cfg_dir = app
                    .path()
                    .app_config_dir()
                    .unwrap_or_else(|_| std::env::temp_dir());
                let marker = cfg_dir.join(".window-init.done");
                if !marker.exists() {
                    if let Some(window) = app.get_webview_window("main") {
                        // Resolve the monitor associated with the window so a
                        // multi-monitor setup uses the screen the WM placed us
                        // on, not the global primary.
                        let monitor_opt = window.current_monitor().ok().flatten();
                        if let Some(monitor) = monitor_opt {
                            let physical = monitor.size();
                            let scale = monitor.scale_factor();
                            let logical_w = (physical.width as f64 / scale).round() as u32;
                            let logical_h = (physical.height as f64 / scale).round() as u32;
                            if logical_w >= 1920 && logical_h >= 1080 {
                                let _ = window.set_size(tauri::LogicalSize::new(1920u32, 1080u32));
                                let _ = window.center();
                            } else {
                                let _ = window.maximize();
                            }
                        } else {
                            // No monitor info — fall back to maximize so we at
                            // least fill whatever the OS thinks we're on.
                            let _ = window.maximize();
                        }
                    }
                    if let Some(parent) = marker.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let _ = std::fs::write(&marker, b"1");
                }
            }
            // Explicit window icon. On Linux the GTK backend doesn't
            // always pick up the icon from `bundle.icon` in dev mode
            // (no installed `.desktop` file means the dock falls back
            // to the Tauri default). Embedding the PNG via
            // `include_bytes!` sidesteps the asset-discovery path
            // entirely — the icon bytes are baked into the binary at
            // compile time and we hand them straight to GTK.
            //
            // Wayland caveat: GNOME Mutter and other Wayland
            // compositors derive the dock/overview icon from the
            // app_id (XDG identifier) → installed `.desktop` file
            // lookup, NOT from `gtk_window_set_icon`. In dev mode
            // there is no installed `.desktop` file, so the icon
            // here will show on the window's CSD titlebar but the
            // dock/overview will keep using the compositor's
            // fallback. The fix is to install the app (or drop a
            // dev `.desktop` file at
            // `~/.local/share/applications/ai.tokori.desktop.desktop`
            // pointing to this binary + icon). On X11 it just works.
            //
            // Logging: errors here used to be swallowed silently
            // (`if let Ok`), which made "the icon didn't change"
            // impossible to debug from the dev console. We now log
            // failures so the next time something regresses the
            // breadcrumb is visible.
            if let Some(window) = app.get_webview_window("main") {
                match tauri::image::Image::from_bytes(include_bytes!(
                    "../icons/icon.png"
                )) {
                    Ok(icon) => {
                        if let Err(e) = window.set_icon(icon) {
                            eprintln!("[icon] window.set_icon failed: {e}");
                        }
                    }
                    Err(e) => {
                        eprintln!("[icon] decode icon.png failed: {e}");
                    }
                }
            }

            // Linux taskbar/dock: `window.set_icon` above covers the
            // window's own decorations on X11, but the taskbar
            // matches WM_CLASS to an entry in the system icon theme.
            // In dev mode there's no installed `.desktop` file, so
            // that lookup falls back to the Tauri default. Setting
            // the app-wide GTK default icon patches the gap on X11
            // — GNOME Shell (X11 session), KDE Plasma, libxfce4ui,
            // etc. prefer this over the theme lookup when the app
            // sets one explicitly. On Wayland it has no effect on
            // the dock/overview (see caveat above).
            #[cfg(target_os = "linux")]
            {
                use gtk::gdk_pixbuf::PixbufLoader;
                use gtk::prelude::*;
                let loader = PixbufLoader::new();
                match loader.write(include_bytes!("../icons/icon.png")) {
                    Ok(()) => {
                        let _ = loader.close();
                        match loader.pixbuf() {
                            Some(pb) => gtk::Window::set_default_icon(&pb),
                            None => eprintln!(
                                "[icon] gdk-pixbuf returned no pixbuf — is gdk-pixbuf-loaders installed?"
                            ),
                        }
                    }
                    Err(e) => eprintln!("[icon] gdk-pixbuf write failed: {e}"),
                }
            }

            // Linux dev-mode dock helper. On Wayland (GNOME default
            // since 22.04) the dock/overview icon comes from the
            // `app_id → ~/.local/share/applications/<id>.desktop`
            // lookup, NOT from `gtk_window_set_icon`. The .deb /
            // .AppImage installer drops the file in the right place;
            // `tauri dev` doesn't. This helper writes a tiny dev
            // `.desktop` file pointing at the current binary + icon
            // so the dock matches our running window to our icon
            // instead of the Tauri default.
            //
            // Idempotent: rewrites every launch (cheap, < 1 ms) so
            // changes to the icon propagate without manual cleanup.
            // Dev-only (`debug_assertions`) — the installed build
            // brings its own real `.desktop` file via the bundler.
            //
            // No error returns the user has to see — failures are
            // logged but don't block startup. Worst case the user
            // sees the Tauri default icon in the dock; the
            // titlebar still gets the right one from set_icon above.
            #[cfg(all(target_os = "linux", debug_assertions))]
            {
                if let Err(e) = install_dev_desktop_file() {
                    eprintln!("[icon] dev .desktop install failed: {e}");
                }
            }

            // Linux-only: tell the WebView to grant microphone / media
            // permission requests automatically. Granting unconditionally
            // is fine here: this is a desktop app, not a browser sandbox —
            // the user already trusted Tokori with disk and network when
            // they installed it. Runtime-created windows that use the mic
            // (the voice-ask popup) get the same treatment at creation;
            // see grant_webview_media_permissions for the full story.
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    grant_webview_media_permissions(&window);
                }
            }

            // Auto-start the local API server when the user has opted in
            // (~/.tokori/api-autostart exists). Tauri's setup() runs
            // before the webview finishes loading, so we spawn the work
            // onto the async runtime rather than blocking the closure.
            // Failures are logged but don't abort startup — the user
            // can still hit the Settings → Local API → Start button.
            if api_server::read_autostart() {
                let handle = app.handle().clone();
                let state = handle.state::<ApiServerState>();
                let server = state.0.clone();
                let app_for_task = handle.clone();
                let db_path = handle
                    .path()
                    .app_config_dir()
                    .map(|d| d.join("tokori.db"));
                tauri::async_runtime::spawn(async move {
                    let Ok(db_path) = db_path else {
                        log::warn!("api autostart: can't resolve app data dir");
                        return;
                    };
                    match server.start(&db_path, app_for_task).await {
                        Ok(info) => log::info!("api autostart: listening on {}", info.addr),
                        Err(e) => log::warn!("api autostart failed: {e}"),
                    }
                });
            }

            // In-app auto-update (desktop only). Registered here rather
            // than in the fluent chain so the `#[cfg(desktop)]` gate keeps
            // it out of the mobile scaffold, where the updater has no
            // meaningful endpoint. `process` backs the `relaunch()` the
            // frontend calls after an update is staged.
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }

            Ok(())
        })
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:tokori.db", migrations)
                .build(),
        )
        // Routes external URLs through the OS shell so Stripe Checkout,
        // billing portal, marketing links, etc. open in the user's
        // browser instead of being silently swallowed by the webview.
        .plugin(tauri_plugin_opener::init())
        // OS-level hotkeys, used by the optional Global Search feature
        // to summon the spotlight popup from outside the app.
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Header-capable WebSocket client — the Qwen realtime live-voice
        // backend needs an Authorization header the browser WebSocket
        // API can't set.
        .plugin(tauri_plugin_websocket::init())
        // Persist + restore window geometry across launches. The
        // spotlight popup is transient (always centered, fixed size),
        // so we exclude it from the save list — only the main window's
        // last size and position is remembered. DECORATIONS is masked
        // out: window chrome policy is code-owned (undecorated on
        // Windows/Linux for the custom title bar, native overlay on
        // macOS — see setup()), and a stale saved flag must never
        // override it.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all().difference(StateFlags::DECORATIONS))
                .with_denylist(&["spotlight", "voiceask"])
                .build(),
        )
        // Menu-bar items (macOS — the only platform where setup()
        // installs an app menu) → frontend bridge. Tray items have
        // their own handler on the TrayIconBuilder; predefined items
        // (copy/paste/quit…) are handled natively and never carry
        // these ids, so everything else falls through. The window is
        // surfaced first: picking a menu item while Tokori sits in
        // the tray should behave like tray-Show, not mutate a hidden
        // window.
        .on_menu_event(|app, event| {
            let payload = match event.id.as_ref() {
                "menu-settings" => Some("settings"),
                "menu-toggle-sidebar" => Some("toggle-sidebar"),
                _ => None,
            };
            if let Some(payload) = payload {
                focus_main_window(app);
                let _ = app.emit_to("main", "tokori:menu", payload);
            }
        })
        // Intercept the main window's close button when close-to-tray is
        // on so the user can re-summon Tokori via the tray / shortcut.
        // The spotlight window's close button always just hides the popup.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label();
                if label == "spotlight" || label == "voiceask" {
                    // Both popups are meant to live across the session;
                    // X just dismisses them.
                    api.prevent_close();
                    let _ = window.hide();
                    return;
                }
                if label == "main" {
                    let state: tauri::State<GlobalSearchState> = window.state();
                    let close_to_tray = *state.close_to_tray.lock().unwrap();
                    let quitting = *state.quitting.lock().unwrap();
                    // Only intercept when the user is "closing" the window
                    // to send it to the tray. A real app exit (tray Quit
                    // → app.exit()) also raises CloseRequested on each
                    // window; without the `quitting` guard we'd hide the
                    // window and prevent the process from finishing.
                    if close_to_tray && !quitting {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            chat_send,
            provider_test,
            dict_fetch_cedict,
            dict_fetch_lang,
            edge_tts,
            ollama_list_models,
            provider_list_models,
            anki_invoke,
            tokenize_zh,
            hanzi_stroke,
            media_probe,
            api_server_start,
            api_server_stop,
            api_server_status,
            api_server_info,
            api_server_get_autostart,
            api_server_set_autostart,
            pair_resolve,
            oauth_begin,
            remote_tunnel_start,
            remote_tunnel_stop,
            remote_tunnel_status,
            remote_tunnel_installed,
            remote_tunnel_install,
            ocr_image,
            ocr_image_layout,
            read_image_file,
            whisper_local_models,
            whisper_local_download,
            whisper_local_delete,
            whisper_local_transcribe,
            set_global_search_enabled,
            set_voice_ask_enabled,
            focus_main_with_query,
            focus_main_with_ask,
            hide_spotlight,
            hide_voice_ask,
            list_addons,
            reveal_addons_dir,
            read_addon_entry,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Belt-and-braces. `WindowEvent::CloseRequested` already calls
        // `prevent_close()` when close-to-tray is on, but on some Linux
        // setups (particularly Wayland + libappindicator) Tauri still
        // raises `ExitRequested` once the last window goes invisible.
        // Refusing the exit here keeps the process alive so the global
        // shortcut + tray icon stay functional after the user "closes"
        // the main window.
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, .. } = event {
                let state: tauri::State<GlobalSearchState> = app.state();
                let quitting = *state.quitting.lock().unwrap();
                let close_to_tray = *state.close_to_tray.lock().unwrap();
                // The tray "Quit" handler sets `quitting` right before
                // calling `app.exit`, so we let that through even when
                // close-to-tray is on. Without this branch the user has
                // no way to actually exit the app from the tray menu.
                if close_to_tray && !quitting {
                    api.prevent_exit();
                }
            }
        });
}
