// OCR via PaddleOCR ONNX models, exposed as the `ocr_image` Tauri command.
//
// Models are downloaded lazily on first use (per language) into the app data
// directory and cached forever — keeps the bundle small and lets us add new
// language packs without a fresh build. Each language pins its own
// (det, cls, rec) triple from RapidOCR's ModelScope mirror; the cls model is
// shared across languages because direction classification is script-agnostic.
//
// Engine instances are kept warm in a process-global map keyed by language,
// so the second OCR call in a language is fast.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use once_cell::sync::Lazy;
use paddle_ocr_rs::ocr_lite::OcrLite;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::Manager;
use tokio::sync::Mutex as AsyncMutex;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OcrEvent {
    /// First-time setup for this language — models are being fetched.
    ModelsDownloading {
        downloaded: u64,
        total: u64,
        file: String,
    },
    /// Models are on disk, OCR is running.
    Recognizing,
}

struct ModelSet {
    det_url: &'static str,
    det_file: &'static str,
    cls_url: &'static str,
    cls_file: &'static str,
    rec_url: &'static str,
    rec_file: &'static str,
}

// CLS is universal — direction classifier is script-agnostic.
const CLS_URL: &str =
  "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.6.0/onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_infer.onnx";
const CLS_FILE: &str = "ch_ppocr_mobile_v2.0_cls_infer.onnx";

fn model_set_for(lang: &str) -> ModelSet {
    match lang {
    "zh" => ModelSet {
      det_url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.6.0/onnx/PP-OCRv5/det/ch_PP-OCRv5_mobile_det.onnx",
      det_file: "ch_PP-OCRv5_mobile_det.onnx",
      cls_url: CLS_URL, cls_file: CLS_FILE,
      rec_url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.6.0/onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile_infer.onnx",
      rec_file: "ch_PP-OCRv5_rec_mobile_infer.onnx",
    },
    "ja" => ModelSet {
      det_url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.6.0/onnx/PP-OCRv4/det/Multilingual_PP-OCRv3_det_infer.onnx",
      det_file: "Multilingual_PP-OCRv3_det_infer.onnx",
      cls_url: CLS_URL, cls_file: CLS_FILE,
      rec_url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.6.0/onnx/PP-OCRv4/rec/japan_PP-OCRv4_rec_infer.onnx",
      rec_file: "japan_PP-OCRv4_rec_infer.onnx",
    },
    "ko" => ModelSet {
      det_url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.6.0/onnx/PP-OCRv4/det/Multilingual_PP-OCRv3_det_infer.onnx",
      det_file: "Multilingual_PP-OCRv3_det_infer.onnx",
      cls_url: CLS_URL, cls_file: CLS_FILE,
      rec_url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.6.0/onnx/PP-OCRv4/rec/korean_PP-OCRv4_rec_infer.onnx",
      rec_file: "korean_PP-OCRv4_rec_infer.onnx",
    },
    // Latin-script languages share a recognizer trained on the joint
    // Latin charset (covers de, es, fr, it, pt, en, ...).
    _ => ModelSet {
      det_url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.6.0/onnx/PP-OCRv4/det/en_PP-OCRv3_det_infer.onnx",
      det_file: "en_PP-OCRv3_det_infer.onnx",
      cls_url: CLS_URL, cls_file: CLS_FILE,
      rec_url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.6.0/onnx/PP-OCRv4/rec/en_PP-OCRv4_rec_infer.onnx",
      rec_file: "en_PP-OCRv4_rec_infer.onnx",
    },
  }
}

// Per-language engine cache. Outer async-mutex serialises the *creation* (so
// two concurrent first-use calls don't both download), inner std-mutex
// serialises the inference (OcrLite::detect needs &mut self).
type EngineHandle = Arc<Mutex<OcrLite>>;
static ENGINES: Lazy<AsyncMutex<HashMap<String, EngineHandle>>> =
    Lazy::new(|| AsyncMutex::new(HashMap::new()));

async fn ensure_model(
    dir: &Path,
    url: &str,
    file: &str,
    on_event: &Channel<OcrEvent>,
) -> Result<PathBuf, String> {
    let path = dir.join(file);
    if path.exists() && std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > 0 {
        return Ok(path);
    }
    let resp = reqwest::Client::new()
        .get(url)
        .header("user-agent", "Tokori/0.1")
        .send()
        .await
        .map_err(|e| format!("download {file}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download {file}: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let _ = on_event.send(OcrEvent::ModelsDownloading {
        downloaded: 0,
        total,
        file: file.to_string(),
    });
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("download {file}: {e}"))?;
    let _ = on_event.send(OcrEvent::ModelsDownloading {
        downloaded: bytes.len() as u64,
        total,
        file: file.to_string(),
    });
    // Write atomically — partial writes during a crash would brick OCR for
    // that language until the user manually deletes the file.
    let tmp = path.with_extension("onnx.part");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("write {file}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename {file}: {e}"))?;
    Ok(path)
}

async fn engine_for(
    app: &tauri::AppHandle,
    lang: &str,
    on_event: &Channel<OcrEvent>,
) -> Result<EngineHandle, String> {
    let mut map = ENGINES.lock().await;
    if let Some(h) = map.get(lang) {
        return Ok(h.clone());
    }
    let set = model_set_for(lang);
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join("ocr");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    let det = ensure_model(&dir, set.det_url, set.det_file, on_event).await?;
    let cls = ensure_model(&dir, set.cls_url, set.cls_file, on_event).await?;
    let rec = ensure_model(&dir, set.rec_url, set.rec_file, on_event).await?;

    // Initialising the ONNX sessions is CPU-bound — keep it off the runtime.
    let det_s = det.to_string_lossy().to_string();
    let cls_s = cls.to_string_lossy().to_string();
    let rec_s = rec.to_string_lossy().to_string();
    let engine: OcrLite = tokio::task::spawn_blocking(move || {
        let mut e = OcrLite::new();
        e.init_models(&det_s, &cls_s, &rec_s, num_threads())?;
        Ok::<_, paddle_ocr_rs::ocr_error::OcrError>(e)
    })
    .await
    .map_err(|e| format!("init join: {e}"))?
    .map_err(|e| format!("init models: {e}"))?;

    let handle = Arc::new(Mutex::new(engine));
    map.insert(lang.to_string(), handle.clone());
    Ok(handle)
}

fn num_threads() -> usize {
    // Cap at 4 so a big OCR job doesn't starve the rest of the app.
    std::thread::available_parallelism()
        .map(|n| n.get().min(4))
        .unwrap_or(2)
}

#[tauri::command]
pub async fn ocr_image(
    app: tauri::AppHandle,
    image_b64: String,
    lang: String,
    on_event: Channel<OcrEvent>,
) -> Result<Vec<String>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image_b64.as_bytes())
        .map_err(|e| format!("decode base64: {e}"))?;

    let engine = engine_for(&app, &lang, &on_event).await?;

    let _ = on_event.send(OcrEvent::Recognizing);
    // Per-block return so the caller can filter by script (e.g. "Chinese
    // only" toggle on a poster that mixes 中文 + English captions) without
    // re-running OCR. Order is preserved.
    let blocks = tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        let img = image::load_from_memory(&bytes)
            .map_err(|e| format!("decode image: {e}"))?
            .to_rgb8();
        let mut guard = engine.lock().map_err(|e| format!("engine lock: {e}"))?;
        let res = guard
            .detect(&img, 50, 1024, 0.5, 0.3, 1.6, false, false)
            .map_err(|e| format!("ocr: {e}"))?;
        Ok(res
            .text_blocks
            .into_iter()
            .map(|b| b.text)
            .filter(|s| !s.trim().is_empty())
            .collect())
    })
    .await
    .map_err(|e| format!("ocr join: {e}"))??;

    Ok(blocks)
}

/// One recognised text line with its detection polygon. `bbox` is the four
/// corner points (image pixels, reading order from PaddleOCR) — the frontend
/// reduces it to an axis-aligned box and normalises against `width`/`height`
/// to position a clickable hotspot over the source image.
#[derive(Clone, Serialize)]
pub struct OcrLine {
    pub text: String,
    pub bbox: Vec<[f32; 2]>,
    pub score: f32,
}

/// OCR result with geometry. Unlike `ocr_image` (which flattens to text for
/// the script-filter capture flow), this keeps per-line boxes + the source
/// image dimensions so the reader can overlay interactive words on the page.
#[derive(Clone, Serialize)]
pub struct OcrLayout {
    pub width: u32,
    pub height: u32,
    pub lines: Vec<OcrLine>,
}

#[tauri::command]
pub async fn ocr_image_layout(
    app: tauri::AppHandle,
    image_b64: String,
    lang: String,
    on_event: Channel<OcrEvent>,
) -> Result<OcrLayout, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image_b64.as_bytes())
        .map_err(|e| format!("decode base64: {e}"))?;

    let engine = engine_for(&app, &lang, &on_event).await?;

    let _ = on_event.send(OcrEvent::Recognizing);
    let layout = tokio::task::spawn_blocking(move || -> Result<OcrLayout, String> {
        let img = image::load_from_memory(&bytes)
            .map_err(|e| format!("decode image: {e}"))?
            .to_rgb8();
        let (width, height) = (img.width(), img.height());
        let mut guard = engine.lock().map_err(|e| format!("engine lock: {e}"))?;
        let res = guard
            .detect(&img, 50, 1024, 0.5, 0.3, 1.6, false, false)
            .map_err(|e| format!("ocr: {e}"))?;
        let lines = res
            .text_blocks
            .into_iter()
            .filter(|b| !b.text.trim().is_empty())
            .map(|b| OcrLine {
                bbox: b
                    .box_points
                    .iter()
                    .map(|p| [p.x as f32, p.y as f32])
                    .collect(),
                score: b.text_score,
                text: b.text,
            })
            .collect();
        Ok(OcrLayout {
            width,
            height,
            lines,
        })
    })
    .await
    .map_err(|e| format!("ocr join: {e}"))??;

    Ok(layout)
}

/// Read a local image file (base64) so the Notes capture flow can OCR a file
/// the user pasted/dropped as a `file://` URI — the common case on Linux,
/// where file managers put a URI on the clipboard instead of image bytes.
/// Size-capped; the caller already restricts this to image extensions.
#[tauri::command]
pub async fn read_image_file(path: String) -> Result<String, String> {
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("open {path}: {e}"))?;
    if meta.len() > 40_000_000 {
        return Err("Image is larger than 40 MB.".into());
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("read {path}: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}
