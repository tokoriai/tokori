//! Local Whisper dictation — whisper.cpp (via whisper-rs) running
//! in-process, CPU-only.
//!
//! The webview records 16 kHz mono int16 PCM through an AudioWorklet
//! (see `startPcmRecording` in src/lib/stt.ts) and ships it here as
//! base64, so no audio container/codec decoding happens on the Rust
//! side at all. Models are ggml files fetched on demand from the
//! official `ggerganov/whisper.cpp` Hugging Face repo into
//! `<app-data>/whisper-models/`; download progress streams to the
//! frontend as `tokori:whisper-dl` events so Settings → Voice can show
//! a live bar.
//!
//! The loaded `WhisperContext` is cached across takes (keyed on model
//! id) — reloading a ggml file per dictation would add 0.5–2 s of
//! latency for nothing. Transcription runs on a blocking thread; the
//! context mutex also serialises concurrent takes, which is what we
//! want on CPU anyway.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use base64::Engine as _;
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const HF_BASE: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

struct ModelSpec {
    id: &'static str,
    label: &'static str,
    file: &'static str,
    /// Approximate size for the picker UI; the download's
    /// Content-Length overrides it for progress math.
    bytes: u64,
    blurb: &'static str,
}

/// Multilingual models only — this is a language-learning app, so the
/// English-only `.en` variants would be a trap. Order = the order the
/// Settings card lists them, smallest first.
const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "tiny",
        label: "Tiny",
        file: "ggml-tiny.bin",
        bytes: 77_700_000,
        blurb: "Fastest, rough — fine for short notes on weak hardware.",
    },
    ModelSpec {
        id: "base",
        label: "Base",
        file: "ggml-base.bin",
        bytes: 148_000_000,
        blurb: "Good default — quick and accurate enough for dictation.",
    },
    ModelSpec {
        id: "small",
        label: "Small",
        file: "ggml-small.bin",
        bytes: 488_000_000,
        blurb: "Solid accuracy, noticeably better for CJK languages.",
    },
    ModelSpec {
        id: "large-v3-turbo-q5_0",
        label: "Large v3 Turbo (q5)",
        file: "ggml-large-v3-turbo-q5_0.bin",
        bytes: 574_000_000,
        blurb: "Best accuracy; quantised turbo decoder keeps it usable on CPU.",
    },
];

fn spec_for(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("can't resolve app data dir: {e}"))?
        .join("whisper-models"))
}

#[derive(Default)]
pub struct LocalWhisperInner {
    /// Loaded model cache: (model id, context). Also the transcription
    /// serialisation point — see module docs.
    ctx: StdMutex<Option<(String, WhisperContext)>>,
    /// Model ids with a download in flight, so a double-click on the
    /// Settings button can't interleave two writers on one .part file.
    downloading: StdMutex<HashSet<String>>,
}

#[derive(Default)]
pub struct LocalWhisperState(pub Arc<LocalWhisperInner>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperModelInfo {
    id: String,
    label: String,
    blurb: String,
    bytes: u64,
    downloaded: bool,
    downloading: bool,
}

/// Download progress event payload (`tokori:whisper-dl`). `done` fires
/// exactly once per successful download; `error` once per failed one.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WhisperDlProgress {
    model: String,
    received: u64,
    total: u64,
    done: bool,
    error: Option<String>,
}

#[tauri::command]
pub async fn whisper_local_models(
    app: AppHandle,
    state: tauri::State<'_, LocalWhisperState>,
) -> Result<Vec<WhisperModelInfo>, String> {
    let dir = models_dir(&app)?;
    let downloading = state.0.downloading.lock().unwrap().clone();
    Ok(MODELS
        .iter()
        .map(|m| WhisperModelInfo {
            id: m.id.to_string(),
            label: m.label.to_string(),
            blurb: m.blurb.to_string(),
            bytes: m.bytes,
            downloaded: dir.join(m.file).exists(),
            downloading: downloading.contains(m.id),
        })
        .collect())
}

#[tauri::command]
pub async fn whisper_local_download(
    app: AppHandle,
    state: tauri::State<'_, LocalWhisperState>,
    model: String,
) -> Result<(), String> {
    let spec = spec_for(&model).ok_or_else(|| format!("unknown whisper model: {model}"))?;
    let dir = models_dir(&app)?;
    let dest = dir.join(spec.file);
    if dest.exists() {
        return Ok(());
    }
    {
        let mut dl = state.0.downloading.lock().unwrap();
        if !dl.insert(model.clone()) {
            return Err("This model is already downloading.".into());
        }
    }

    let result = download_model(&app, spec, &dir, &dest, &model).await;

    state.0.downloading.lock().unwrap().remove(&model);
    if let Err(e) = &result {
        // Leave no half-written .part behind, and tell the UI.
        let _ = tokio::fs::remove_file(dir.join(format!("{}.part", spec.file))).await;
        let _ = app.emit(
            "tokori:whisper-dl",
            WhisperDlProgress {
                model: model.clone(),
                received: 0,
                total: spec.bytes,
                done: false,
                error: Some(e.clone()),
            },
        );
    }
    result
}

async fn download_model(
    app: &AppHandle,
    spec: &ModelSpec,
    dir: &PathBuf,
    dest: &PathBuf,
    model: &str,
) -> Result<(), String> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("create models dir: {e}"))?;
    let url = format!("{HF_BASE}/{}", spec.file);
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download failed: {e}"))?;
    let total = resp.content_length().unwrap_or(spec.bytes);

    let tmp = dir.join(format!("{}.part", spec.file));
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| format!("create {}: {e}", tmp.display()))?;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download interrupted: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write model file: {e}"))?;
        received += chunk.len() as u64;
        // ~7 events/second is plenty for a progress bar and keeps the
        // IPC channel quiet during a multi-hundred-MB pull.
        if last_emit.elapsed().as_millis() >= 150 {
            last_emit = std::time::Instant::now();
            let _ = app.emit(
                "tokori:whisper-dl",
                WhisperDlProgress {
                    model: model.to_string(),
                    received,
                    total,
                    done: false,
                    error: None,
                },
            );
        }
    }
    file.flush().await.map_err(|e| format!("flush model file: {e}"))?;
    drop(file);
    tokio::fs::rename(&tmp, dest)
        .await
        .map_err(|e| format!("finalise model file: {e}"))?;
    let _ = app.emit(
        "tokori:whisper-dl",
        WhisperDlProgress {
            model: model.to_string(),
            received,
            total,
            done: true,
            error: None,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn whisper_local_delete(
    app: AppHandle,
    state: tauri::State<'_, LocalWhisperState>,
    model: String,
) -> Result<(), String> {
    let spec = spec_for(&model).ok_or_else(|| format!("unknown whisper model: {model}"))?;
    let dir = models_dir(&app)?;
    // Drop the cached context first so Windows can actually unlink the
    // file (open handles block deletion there).
    {
        let mut guard = state.0.ctx.lock().unwrap();
        if guard.as_ref().is_some_and(|(id, _)| id == &model) {
            *guard = None;
        }
    }
    let path = dir.join(spec.file);
    if path.exists() {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| format!("delete model: {e}"))?;
    }
    let _ = tokio::fs::remove_file(dir.join(format!("{}.part", spec.file))).await;
    Ok(())
}

#[tauri::command]
pub async fn whisper_local_transcribe(
    app: AppHandle,
    state: tauri::State<'_, LocalWhisperState>,
    model: String,
    pcm_b64: String,
    lang: Option<String>,
) -> Result<String, String> {
    let spec = spec_for(&model).ok_or_else(|| format!("unknown whisper model: {model}"))?;
    let path = models_dir(&app)?.join(spec.file);
    if !path.exists() {
        return Err(format!(
            "Local model \"{}\" isn't downloaded yet — grab it under Settings → Voice → Dictation.",
            spec.label
        ));
    }
    let pcm = base64::engine::general_purpose::STANDARD
        .decode(pcm_b64)
        .map_err(|e| format!("bad PCM payload: {e}"))?;

    let inner = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        // int16 LE → f32 in [-1, 1], the format whisper.cpp wants.
        let mut audio = vec![0.0f32; pcm.len() / 2];
        for (i, chunk) in pcm.chunks_exact(2).enumerate() {
            audio[i] = i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 32768.0;
        }
        // whisper.cpp rejects clips under ~1 s ("input is too short") —
        // pad short takes with trailing silence instead of erroring.
        const MIN_SAMPLES: usize = 16_000 + 3_200; // 1.2 s @ 16 kHz
        if audio.len() < MIN_SAMPLES {
            audio.resize(MIN_SAMPLES, 0.0);
        }

        let mut guard = inner.ctx.lock().unwrap();
        let needs_load = match guard.as_ref() {
            Some((id, _)) => id != &model,
            None => true,
        };
        if needs_load {
            let ctx = WhisperContext::new_with_params(
                path.to_str().ok_or("model path isn't valid UTF-8")?,
                WhisperContextParameters::default(),
            )
            .map_err(|e| format!("load whisper model: {e}"))?;
            *guard = Some((model.clone(), ctx));
        }
        let (_, ctx) = guard.as_ref().expect("context loaded above");

        let mut wstate = ctx
            .create_state()
            .map_err(|e| format!("whisper state: {e}"))?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        let threads = std::thread::available_parallelism()
            .map(|n| n.get() as i32)
            .unwrap_or(4)
            .min(8);
        params.set_n_threads(threads);
        params.set_translate(false);
        // ISO 639-1 hint from the caller; "auto" runs language detection.
        params.set_language(Some(lang.as_deref().unwrap_or("auto")));
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);

        wstate
            .full(params, &audio)
            .map_err(|e| format!("transcribe: {e}"))?;

        let n = wstate.full_n_segments();
        let mut out = String::new();
        for i in 0..n {
            if let Some(segment) = wstate.get_segment(i) {
                out.push_str(
                    &segment
                        .to_str_lossy()
                        .map_err(|e| format!("read segment: {e}"))?,
                );
            }
        }
        Ok(out.trim().to_string())
    })
    .await
    .map_err(|e| format!("transcription task failed: {e}"))?
}
