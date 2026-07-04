//! Cloudflare quick-tunnel spawner.
//!
//! Runs `cloudflared tunnel --url http://127.0.0.1:53210 --no-autoupdate`
//! as a child process and parses the printed `*.trycloudflare.com` URL
//! out of its stderr so the desktop UI can render a QR code without the
//! user ever touching a terminal. Process handle is held in app state;
//! `stop()` SIGKILLs it (cloudflared cleans up its own connections on
//! drop).
//!
//! We don't ship cloudflared ourselves yet — the binary has to be on
//! the user's PATH. Bundling it as a Tauri sidecar is a follow-up; the
//! shape below is agnostic to where the binary comes from.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use futures_util::StreamExt;
use serde::Serialize;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
};

/// Public status report consumed by the frontend.
#[derive(Serialize, Clone, Default)]
pub struct TunnelStatus {
    pub running: bool,
    /// `Some` once cloudflared has printed its quick-tunnel URL. `None`
    /// during the first few seconds after start while the handshake is
    /// in progress, or when no tunnel is running at all.
    pub url: Option<String>,
    /// Best-effort error from the last failed start attempt. Cleared on
    /// successful start. UI surfaces this when running=false + err=Some.
    pub err: Option<String>,
}

/// Holds the running child + the most-recently-seen URL. Wrapped in
/// `Arc<Mutex<_>>` so the spawned stderr-reader task can poke at it.
#[derive(Default, Clone)]
pub struct TunnelState {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    status: TunnelStatus,
}

impl TunnelState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn cloudflared. Idempotent — if a tunnel is already running,
    /// returns the existing status instead of spawning a second copy.
    /// Returns once the URL has been parsed (typically <2s) or after
    /// a 30s timeout if cloudflared never prints one.
    ///
    /// `binary` is the cloudflared executable to run — either a path to
    /// a Tokori-managed install or the plain string `"cloudflared"`
    /// which leans on PATH resolution.
    pub async fn start(&self, local_addr: &str, binary: &Path) -> Result<TunnelStatus, String> {
        // Bail fast if already running. Locking briefly + dropping the
        // guard before awaiting anything else avoids holding the mutex
        // across awaits — important so concurrent `status()` reads from
        // the UI don't block.
        {
            let inner = self.inner.lock().await;
            if inner.child.is_some() && inner.status.url.is_some() {
                return Ok(inner.status.clone());
            }
        }

        let mut cmd = Command::new(binary);
        cmd.args([
            "tunnel",
            "--no-autoupdate",
            "--url",
            &format!("http://{local_addr}"),
        ]);
        // cloudflared writes the banner + URL to stderr, not stdout.
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::piped());
        // Kill the child if our task gets dropped — no zombie tunnels.
        cmd.kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| {
            // ENOENT → "No such file or directory" → cloudflared isn't
            // on PATH. Surface a UX-tier message so the UI can render
            // an install hint without parsing OS errno.
            if e.kind() == std::io::ErrorKind::NotFound {
                "cloudflared not found on PATH. Install it from cloudflare.com/cloudflared and restart Tokori.".to_string()
            } else {
                format!("Failed to spawn cloudflared: {e}")
            }
        })?;

        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "cloudflared stderr handle missing".to_string())?;

        // Park the child so we can collect its exit code later if it
        // dies on its own (e.g. Cloudflare rate-limits the quick tunnel
        // account). The reader task below also has a clone of the state
        // so it can update `running=false` + `err=...` in that case.
        {
            let mut inner = self.inner.lock().await;
            inner.child = Some(child);
            inner.status = TunnelStatus {
                running: true,
                url: None,
                err: None,
            };
        }

        // URL discovery happens off the main path — the spawned reader
        // task watches stderr forever (a single URL line, then
        // diagnostics) and updates state when it sees the canonical
        // quick-tunnel URL.
        let state = self.clone();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let tx_arc = Arc::new(Mutex::new(Some(tx)));
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                // cloudflared prints the URL inside a banner like
                //   |  https://salty-sea-9437.trycloudflare.com  |
                // Stripping non-https slices to the URL substring.
                if let Some(url) = extract_trycloudflare_url(&line) {
                    let mut inner = state.inner.lock().await;
                    inner.status.url = Some(url);
                    inner.status.running = true;
                    drop(inner);
                    if let Some(tx) = tx_arc.lock().await.take() {
                        let _ = tx.send(());
                    }
                }
            }
            // stderr closed → process exited. Drop status to "not
            // running" so the UI shows a stop pill. We don't try to
            // surface the exit code — the UI is best served by "the
            // tunnel went away, start it again."
            let mut inner = state.inner.lock().await;
            inner.status.running = false;
            inner.child = None;
        });

        // Wait for the URL or time out at 30s. We choose 30s because
        // cloudflared usually prints within 2s; anything past 10s is
        // already a sign something's wrong (DNS, no internet), and 30s
        // gives a slow user a chance to recover before we say "no URL".
        match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
            Ok(Ok(_)) => {
                let inner = self.inner.lock().await;
                Ok(inner.status.clone())
            }
            _ => {
                // Timeout or sender dropped — tear down and report.
                self.stop().await;
                let mut inner = self.inner.lock().await;
                inner.status = TunnelStatus {
                    running: false,
                    url: None,
                    err: Some(
                        "cloudflared didn't print a tunnel URL within 30s. Check your internet connection.".to_string(),
                    ),
                };
                Err(inner.status.err.clone().unwrap_or_default())
            }
        }
    }

    /// Kill the tunnel. No-op if not running.
    pub async fn stop(&self) {
        let mut inner = self.inner.lock().await;
        if let Some(mut child) = inner.child.take() {
            // start_kill + try_wait is the polite way; if it lingers,
            // `kill_on_drop` from spawn time will finish the job.
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        inner.status = TunnelStatus::default();
    }

    pub async fn status(&self) -> TunnelStatus {
        self.inner.lock().await.status.clone()
    }
}

// ── cloudflared distribution ────────────────────────────────────────
//
// We try to make "do I have cloudflared?" invisible:
//   1. If the user installed it themselves (Homebrew, apt, an installer
//      from cloudflare.com), `cloudflared` is on PATH — we use that.
//   2. Otherwise the Settings UI offers "Download cloudflared" which
//      pulls the right binary from GitHub releases into app_data_dir.
//      Subsequent starts use that copy.
//
// We don't bundle the binary inside the Tauri installer because:
//   • The binary is ~30MB, and most users won't enable remote chat.
//   • Cross-platform sidecar wiring forces us to commit five binaries
//     to the repo (or fetch at build time) — heavy churn on a feature
//     used by a minority.
//   • Auto-download lets us track cloudflared releases on the user's
//     machine without re-shipping Tokori.

/// Filename of the Tokori-managed cloudflared binary inside the app
/// data dir. Windows gets `.exe`; everything else is bare. Picked up
/// at `resolve_binary` and `installed_path`.
pub fn binary_filename() -> &'static str {
    if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    }
}

/// Path where the Tokori-managed binary lives. Caller resolves the app
/// data dir via Tauri's `path()` API.
pub fn managed_binary_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(binary_filename())
}

/// `Some(path)` when a Tokori-managed binary exists at the expected
/// location. The Settings UI uses this to decide whether to show the
/// "Download cloudflared" CTA.
pub fn installed_path(app_data_dir: &Path) -> Option<PathBuf> {
    let p = managed_binary_path(app_data_dir);
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

/// Pick the best cloudflared to spawn. Tokori-managed copy wins (the
/// user explicitly asked for it via Settings); falls back to the plain
/// name so PATH-installed binaries still work for power users.
pub fn resolve_binary(app_data_dir: &Path) -> PathBuf {
    if let Some(p) = installed_path(app_data_dir) {
        p
    } else {
        PathBuf::from(binary_filename())
    }
}

#[derive(Serialize)]
pub struct DownloadResult {
    pub path: String,
    pub bytes: u64,
}

/// Download the right cloudflared binary for the current platform from
/// GitHub releases into `app_data_dir/cloudflared(.exe)`. macOS users
/// get a hard error explaining `brew install cloudflared` — the macOS
/// release is shipped as a tarball and we don't want to drag in a tar
/// implementation for one platform.
pub async fn install(app_data_dir: &Path) -> Result<DownloadResult, String> {
    let asset = release_asset_name()
        .ok_or_else(|| {
            "Auto-download isn't available on this OS/arch. Install cloudflared from cloudflare.com/cloudflared (or `brew install cloudflared` on macOS) and restart Tokori.".to_string()
        })?;
    let url = format!("https://github.com/cloudflare/cloudflared/releases/latest/download/{asset}");

    tokio::fs::create_dir_all(app_data_dir)
        .await
        .map_err(|e| format!("Couldn't create app data dir: {e}"))?;
    let dest = managed_binary_path(app_data_dir);

    // Stream straight to disk — 30MB easily fits in memory but streaming
    // makes the progress story easier later (and avoids two copies of
    // the bytes lingering on slow machines).
    let resp = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("HTTP client init: {e}"))?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Download returned HTTP {}. Try again, or install cloudflared manually.",
            resp.status()
        ));
    }
    let mut file = tokio::fs::File::create(&dest)
        .await
        .map_err(|e| format!("Couldn't open {}: {e}", dest.display()))?;
    let mut stream = resp.bytes_stream();
    let mut total: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download interrupted: {e}"))?;
        total += chunk.len() as u64;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Disk write failed: {e}"))?;
    }
    file.flush()
        .await
        .map_err(|e| format!("Disk flush failed: {e}"))?;

    // Make it executable on Unix. Windows uses file extension for the
    // same purpose so this step is a no-op there.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = tokio::fs::metadata(&dest)
            .await
            .map_err(|e| format!("Couldn't stat downloaded binary: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        tokio::fs::set_permissions(&dest, perms)
            .await
            .map_err(|e| format!("Couldn't chmod downloaded binary: {e}"))?;
    }

    Ok(DownloadResult {
        path: dest.display().to_string(),
        bytes: total,
    })
}

/// GitHub release asset name for the current OS/arch, or None when the
/// platform isn't supported by the auto-download path (macOS).
fn release_asset_name() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("cloudflared-linux-amd64"),
        ("linux", "aarch64") => Some("cloudflared-linux-arm64"),
        ("linux", "x86") => Some("cloudflared-linux-386"),
        ("linux", "arm") => Some("cloudflared-linux-arm"),
        ("windows", "x86_64") => Some("cloudflared-windows-amd64.exe"),
        ("windows", "x86") => Some("cloudflared-windows-386.exe"),
        // macOS releases are tarballs (cloudflared-darwin-{amd64,arm64}.tgz).
        // Auto-download here means "single binary in a single GET" — we
        // refuse rather than half-handle the tar.
        _ => None,
    }
}

/// Pull a `https://*.trycloudflare.com` URL out of a cloudflared log
/// line. The banner format has surrounding pipes + whitespace; this
/// finds the substring without committing to a regex dep.
fn extract_trycloudflare_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let tail = &line[start..];
    // Take everything until the first whitespace or pipe character.
    // Quick-tunnel URLs are always all-ASCII so byte-indexing is safe.
    let end = tail
        .find(|c: char| c.is_whitespace() || c == '|')
        .unwrap_or(tail.len());
    let candidate = &tail[..end];
    if candidate.ends_with(".trycloudflare.com") {
        Some(candidate.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_url_from_banner_line() {
        let line = "2024-01-01T00:00:00Z INF |  https://salty-fish-9437.trycloudflare.com  |";
        assert_eq!(
            extract_trycloudflare_url(line).as_deref(),
            Some("https://salty-fish-9437.trycloudflare.com")
        );
    }

    #[test]
    fn ignores_other_https_urls() {
        let line = "Visit https://developers.cloudflare.com/ for docs";
        assert_eq!(extract_trycloudflare_url(line), None);
    }

    #[test]
    fn handles_url_at_end_of_line() {
        let line = "tunnel ready: https://abc.trycloudflare.com";
        assert_eq!(
            extract_trycloudflare_url(line).as_deref(),
            Some("https://abc.trycloudflare.com")
        );
    }
}
