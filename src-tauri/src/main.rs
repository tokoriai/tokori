// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK on Linux defaults to a DMA-BUF / GPU-compositing renderer that
    // many setups (Wayland, NVIDIA, some Intel) can't drive — the symptom is a
    // black or never-painting WebView. Forcing it off before the WebView
    // initialises is the ecosystem-standard fix. We respect an explicit
    // override so power users can re-enable it. No-op on macOS / Windows.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tokori_lib::run();
}
