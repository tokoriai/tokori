use std::io::Read;

use flate2::read::GzDecoder;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio_tungstenite::tungstenite::Message;

use crate::providers::{stream_chat, ChatEvent, ChatMessage, ProviderConfig};

#[tauri::command]
pub async fn chat_send(
    config: ProviderConfig,
    messages: Vec<ChatMessage>,
    on_event: Channel<ChatEvent>,
) -> Result<String, String> {
    stream_chat(config, messages, &on_event).await
}

#[tauri::command]
pub async fn provider_test(config: ProviderConfig) -> Result<String, String> {
    let messages = vec![ChatMessage {
        role: "user".to_string(),
        content: "Reply with the single word 'ok'.".to_string(),
    }];
    let channel: Channel<ChatEvent> = Channel::new(|_event| Ok(()));
    stream_chat(config, messages, &channel).await
}

// ── Addon discovery ─────────────────────────────────────────────────
//
// Enumerates `<app-data>/addons/<folder>/manifest.json`. The Rust side
// is intentionally dumb: it reads file contents and reports them back.
// All schema validation lives in the TypeScript `parseManifest` so the
// rule stays in one place (and unit tests run without a Rust round-
// trip). Loading the addon's JS entry point happens later, under the
// frontend's sandboxed evaluation surface.

#[derive(Serialize)]
pub struct AddonFolderEntry {
    pub folder: String,
    pub path: String,
    #[serde(rename = "manifestText")]
    pub manifest_text: Option<String>,
    #[serde(rename = "readError")]
    pub read_error: Option<String>,
}

#[tauri::command]
pub async fn list_addons(app: tauri::AppHandle) -> Result<Vec<AddonFolderEntry>, String> {
    use tauri::Manager;

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join("addons");

    // Missing folder is the expected "no addons installed" state. We
    // create it on first call so the "Open addons folder" button has
    // something to reveal even on a fresh install.
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        return Err(format!("create addons dir: {e}"));
    }

    let mut read = match tokio::fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(e) => return Err(format!("read addons dir: {e}")),
    };

    let mut out = Vec::new();
    while let Ok(Some(entry)) = read.next_entry().await {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let folder = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if folder.is_empty() || folder.starts_with('.') {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        let (text, err) = match tokio::fs::read_to_string(&manifest_path).await {
            Ok(t) => (Some(t), None),
            Err(e) => (None, Some(format!("read manifest.json: {e}"))),
        };
        out.push(AddonFolderEntry {
            folder,
            path: path.to_string_lossy().to_string(),
            manifest_text: text,
            read_error: err,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn reveal_addons_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    use tauri_plugin_opener::OpenerExt;

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join("addons");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("create addons dir: {e}"))?;
    let dir_str = dir.to_string_lossy().to_string();
    app.opener()
        .open_path(dir_str.clone(), None::<&str>)
        .map_err(|e| format!("open addons dir: {e}"))?;
    Ok(dir_str)
}

/// Read an addon's entry-point source so the frontend can run it inside a
/// sandbox worker (Stage 2). `folder` + `entry` come from `list_addons` and
/// the addon's `manifest.json`; both are re-validated here because this
/// command reads arbitrary files off disk and must never be tricked into
/// path traversal.
#[tauri::command]
pub async fn read_addon_entry(
    app: tauri::AppHandle,
    folder: String,
    entry: String,
) -> Result<String, String> {
    use tauri::Manager;

    if folder.is_empty() || folder.contains('/') || folder.contains('\\') || folder.starts_with('.')
    {
        return Err("invalid addon folder".to_string());
    }
    if entry.is_empty() || entry.contains("..") || entry.starts_with('/') || entry.starts_with('\\')
    {
        return Err("invalid entry path".to_string());
    }

    let addons = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join("addons");
    let base = addons.join(&folder);
    let target = base.join(&entry);

    // Canonicalise and confirm the resolved path is still inside the addon
    // folder — defence-in-depth against symlink / traversal tricks the
    // string checks above might miss.
    let canon_base = tokio::fs::canonicalize(&base)
        .await
        .map_err(|e| format!("resolve addon folder: {e}"))?;
    let canon_target = tokio::fs::canonicalize(&target)
        .await
        .map_err(|e| format!("resolve entry: {e}"))?;
    if !canon_target.starts_with(&canon_base) {
        return Err("entry path escapes the addon folder".to_string());
    }

    tokio::fs::read_to_string(&canon_target)
        .await
        .map_err(|e| format!("read entry: {e}"))
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DictDownloadEvent {
    Progress {
        stage: String,
        downloaded: u64,
        total: Option<u64>,
    },
    Parsed {
        entries: usize,
    },
}

#[derive(Serialize)]
pub struct CedictEntry {
    pub word: String,     // simplified
    pub alt_word: String, // traditional
    pub reading: String,  // pinyin
    pub gloss: String,
}

// MDBG renamed the gz file to include `_mdbg` somewhere along the way; the
// older URL we used for a while now 404s.
const CEDICT_DEFAULT_URL: &str =
    "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz";

const CEDICT_FALLBACK_URLS: &[&str] = &[
    "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8.zip",
    "https://raw.githubusercontent.com/wenlin-society/wenlin-data/master/cc-cedict_ts.u8",
];

#[tauri::command]
pub async fn dict_fetch_cedict(
    url: Option<String>,
    on_event: Channel<DictDownloadEvent>,
) -> Result<Vec<CedictEntry>, String> {
    let primary = url
        .clone()
        .unwrap_or_else(|| CEDICT_DEFAULT_URL.to_string());

    // Try the user-supplied URL (or the default), then fall back to a couple of
    // known mirrors when the primary returns a non-2xx — the most common
    // failure mode is just one host being down.
    let mut last_err = String::new();
    let mut tried: Vec<String> = Vec::new();
    let mut candidates: Vec<String> = vec![primary];
    if url.is_none() {
        for u in CEDICT_FALLBACK_URLS {
            candidates.push(u.to_string());
        }
    }

    for candidate in candidates {
        tried.push(candidate.clone());
        match fetch_and_parse_cedict(&candidate, &on_event).await {
            Ok(entries) => return Ok(entries),
            Err(e) => {
                last_err = format!("{candidate}: {e}");
            }
        }
    }
    Err(format!(
        "All sources failed. Tried: {}\nLast error: {last_err}",
        tried.join(", ")
    ))
}

async fn fetch_and_parse_cedict(
    url: &str,
    on_event: &Channel<DictDownloadEvent>,
) -> Result<Vec<CedictEntry>, String> {
    let _ = on_event.send(DictDownloadEvent::Progress {
        stage: format!("downloading from {}", short_host(url)),
        downloaded: 0,
        total: None,
    });

    let resp = reqwest::Client::new()
        .get(url)
        .header("user-agent", "Tokori/0.1")
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length();
    let bytes = resp.bytes().await.map_err(|e| format!("body: {e}"))?;
    let _ = on_event.send(DictDownloadEvent::Progress {
        stage: "downloaded".to_string(),
        downloaded: bytes.len() as u64,
        total,
    });

    // Detect compression. Plain `.u8` / `.txt` are passed through; `.gz` is
    // gunzipped; `.zip` reads the first member.
    let lower = url.to_lowercase();
    let text = if lower.ends_with(".gz") || is_gzip_magic(&bytes) {
        let _ = on_event.send(DictDownloadEvent::Progress {
            stage: "decompressing (gzip)".to_string(),
            downloaded: bytes.len() as u64,
            total,
        });
        let mut decoder = GzDecoder::new(&bytes[..]);
        let mut text = String::new();
        decoder
            .read_to_string(&mut text)
            .map_err(|e| format!("gunzip: {e}"))?;
        text
    } else if lower.ends_with(".zip") || is_zip_magic(&bytes) {
        return Err(
            "ZIP archives aren't supported yet — paste a .txt.gz or plain .u8/.txt mirror URL"
                .to_string(),
        );
    } else {
        String::from_utf8_lossy(&bytes).to_string()
    };

    let _ = on_event.send(DictDownloadEvent::Progress {
        stage: "parsing".to_string(),
        downloaded: bytes.len() as u64,
        total,
    });
    let entries = parse_cedict(&text);
    if entries.is_empty() {
        return Err("Parsed 0 entries — does the file follow CC-CEDICT format?".into());
    }
    let _ = on_event.send(DictDownloadEvent::Parsed {
        entries: entries.len(),
    });
    Ok(entries)
}

fn is_gzip_magic(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b
}

fn is_zip_magic(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && bytes[0] == b'P' && bytes[1] == b'K' && bytes[2] == 0x03 && bytes[3] == 0x04
}

fn short_host(url: &str) -> String {
    if let Some(rest) = url.split_once("://").map(|x| x.1) {
        rest.split('/').next().unwrap_or(rest).to_string()
    } else {
        url.to_string()
    }
}

// JMdict (Japanese) and Beolingus DE-EN (German) reuse the same fetch logic
// as CC-CEDICT but need different parsers — and JMdict ships as `.json.tgz`,
// so we also need a tar extractor on top of gunzip.

#[derive(Serialize)]
pub struct LangDictEntry {
    pub word: String,     // primary headword (kanji / german / korean)
    pub alt_word: String, // alternate form (kana / hanja / "" if none)
    pub reading: String,  // pronunciation hint (kana, ipa, etc.) — "" if none
    pub gloss: String,    // semicolon-joined senses
}

#[tauri::command]
pub async fn dict_fetch_lang(
    url: String,
    format: String,
    on_event: Channel<DictDownloadEvent>,
) -> Result<Vec<LangDictEntry>, String> {
    let _ = on_event.send(DictDownloadEvent::Progress {
        stage: format!("downloading from {}", short_host(&url)),
        downloaded: 0,
        total: None,
    });

    let resp = reqwest::Client::new()
        .get(&url)
        .header("user-agent", "Tokori/0.1")
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length();
    let bytes = resp.bytes().await.map_err(|e| format!("body: {e}"))?;
    let _ = on_event.send(DictDownloadEvent::Progress {
        stage: "downloaded".to_string(),
        downloaded: bytes.len() as u64,
        total,
    });

    // Yomitan archives are raw .zip — bypass the text decode below
    // (utf8-lossy on a 25 MB zip would just produce junk) and read the
    // zip directly. Same fork as the tgz path, just earlier so we keep
    // the original byte buffer.
    if format == "yomitan" {
        let _ = on_event.send(DictDownloadEvent::Progress {
            stage: "parsing (yomitan zip)".to_string(),
            downloaded: bytes.len() as u64,
            total,
        });
        let entries = parse_yomitan_zip(&bytes)?;
        if entries.is_empty() {
            return Err(format!(
                "Parsed 0 entries — does the file follow the {format} format?"
            ));
        }
        let _ = on_event.send(DictDownloadEvent::Parsed {
            entries: entries.len(),
        });
        return Ok(entries);
    }

    let lower = url.to_lowercase();
    // .json.tgz: gunzip then untar (JMdict releases ship this way).
    let text = if lower.ends_with(".tgz") || lower.ends_with(".tar.gz") {
        let _ = on_event.send(DictDownloadEvent::Progress {
            stage: "decompressing (tgz)".to_string(),
            downloaded: bytes.len() as u64,
            total,
        });
        let decoder = GzDecoder::new(&bytes[..]);
        let mut archive = tar::Archive::new(decoder);
        let mut out = String::new();
        let mut found = false;
        for entry in archive.entries().map_err(|e| format!("tar: {e}"))? {
            let mut e = entry.map_err(|e| format!("tar entry: {e}"))?;
            let path = e.path().map_err(|e| format!("tar path: {e}"))?;
            let path_str = path.to_string_lossy().to_lowercase();
            if path_str.ends_with(".json") || path_str.ends_with(".txt") {
                e.read_to_string(&mut out)
                    .map_err(|e| format!("read tar entry: {e}"))?;
                found = true;
                break;
            }
        }
        if !found {
            return Err("No .json or .txt found inside the .tgz archive".into());
        }
        out
    } else if lower.ends_with(".gz") || is_gzip_magic(&bytes) {
        let _ = on_event.send(DictDownloadEvent::Progress {
            stage: "decompressing (gzip)".to_string(),
            downloaded: bytes.len() as u64,
            total,
        });
        let mut decoder = GzDecoder::new(&bytes[..]);
        let mut text = String::new();
        decoder
            .read_to_string(&mut text)
            .map_err(|e| format!("gunzip: {e}"))?;
        text
    } else {
        String::from_utf8_lossy(&bytes).to_string()
    };

    let _ = on_event.send(DictDownloadEvent::Progress {
        stage: "parsing".to_string(),
        downloaded: bytes.len() as u64,
        total,
    });

    let entries = match format.as_str() {
        "jmdict" => parse_jmdict(&text)?,
        "jmdict-xml" => parse_jmdict_xml(&text)?,
        "kanjidic-xml" => parse_kanjidic_xml(&text)?,
        "ding" | "beolingus" => parse_ding(&text),
        "kengdic" => parse_kengdic(&text),
        "tei-bilingual" => parse_tei_bilingual(&text)?,
        "wiktionary-data" => parse_wiktionary_data(&text),
        // Handled in the early-return fork above — text is empty here.
        "yomitan" => unreachable!("yomitan is handled before text decode"),
        "cedict" => parse_cedict(&text)
            .into_iter()
            .map(|e| LangDictEntry {
                word: e.word,
                alt_word: e.alt_word,
                reading: e.reading,
                gloss: e.gloss,
            })
            .collect(),
        other => return Err(format!("Unknown dictionary format: {other}")),
    };

    if entries.is_empty() {
        return Err(format!(
            "Parsed 0 entries — does the file follow the {format} format?"
        ));
    }
    let _ = on_event.send(DictDownloadEvent::Parsed {
        entries: entries.len(),
    });
    Ok(entries)
}

fn parse_jmdict(text: &str) -> Result<Vec<LangDictEntry>, String> {
    // jmdict-simplified shape:
    // { "words": [{ "kanji": [{"text":"日本"}], "kana":[{"text":"にほん"}],
    //               "sense":[{"gloss":[{"text":"Japan"}]}] }, ... ] }
    let v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("jmdict json: {e}"))?;
    let words = v
        .get("words")
        .and_then(|w| w.as_array())
        .ok_or_else(|| "jmdict: missing 'words' array".to_string())?;
    let mut out = Vec::with_capacity(words.len());
    for w in words {
        let kanji = w
            .get("kanji")
            .and_then(|k| k.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|k| k.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let kana = w
            .get("kana")
            .and_then(|k| k.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|k| k.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        // Headword: prefer first kanji, fall back to first kana (some entries are kana-only).
        let (word, alt_word) = if let Some(k) = kanji.first() {
            (
                k.to_string(),
                kana.first().copied().unwrap_or("").to_string(),
            )
        } else if let Some(k) = kana.first() {
            (k.to_string(), String::new())
        } else {
            continue;
        };
        let reading = kana.first().copied().unwrap_or("").to_string();
        let mut glosses: Vec<String> = Vec::new();
        if let Some(senses) = w.get("sense").and_then(|s| s.as_array()) {
            for s in senses {
                if let Some(gs) = s.get("gloss").and_then(|g| g.as_array()) {
                    for g in gs {
                        if let Some(t) = g.get("text").and_then(|t| t.as_str()) {
                            glosses.push(t.to_string());
                        }
                    }
                }
            }
        }
        if glosses.is_empty() {
            continue;
        }
        out.push(LangDictEntry {
            word,
            alt_word,
            reading,
            gloss: glosses.join("; "),
        });
    }
    Ok(out)
}

/// Parser for the official EDRDG JMdict_e XML release. Streaming via quick-xml
/// so memory stays constant for the ~80 MB file.
fn parse_jmdict_xml(text: &str) -> Result<Vec<LangDictEntry>, String> {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;

    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);
    // JMdict declares many entities (gai1, ichi1, P, etc.) and quick-xml's
    // strict mode would throw on every encounter. We don't care about them
    // — they're tags inside <ke_pri> and the like — so allow unresolved.
    reader.config_mut().allow_unmatched_ends = true;

    let mut buf = Vec::new();
    let mut out: Vec<LangDictEntry> = Vec::new();

    // Per-entry accumulators. Reset on each <entry>.
    let mut in_entry = false;
    let mut current_text = String::new();
    let mut state = JmdictState::None;
    let mut kanji_forms: Vec<String> = Vec::new();
    let mut kana_forms: Vec<String> = Vec::new();
    let mut glosses: Vec<String> = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = e.local_name();
                let n = name.as_ref();
                match n {
                    b"entry" => {
                        in_entry = true;
                        kanji_forms.clear();
                        kana_forms.clear();
                        glosses.clear();
                    }
                    b"keb" => state = JmdictState::Keb,
                    b"reb" => state = JmdictState::Reb,
                    b"gloss" => state = JmdictState::Gloss,
                    _ => {}
                }
                current_text.clear();
            }
            Ok(Event::Text(t)) => {
                if state != JmdictState::None {
                    let raw = t.unescape().unwrap_or_default().to_string();
                    current_text.push_str(&raw);
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name();
                let n = name.as_ref();
                match n {
                    b"keb" => {
                        if !current_text.is_empty() {
                            kanji_forms.push(current_text.clone());
                        }
                        state = JmdictState::None;
                    }
                    b"reb" => {
                        if !current_text.is_empty() {
                            kana_forms.push(current_text.clone());
                        }
                        state = JmdictState::None;
                    }
                    b"gloss" => {
                        if !current_text.is_empty() {
                            glosses.push(current_text.clone());
                        }
                        state = JmdictState::None;
                    }
                    b"entry" => {
                        // Build one row. Same precedence rules as parse_jmdict
                        // (JSON variant) so installed entries look identical
                        // regardless of source.
                        if !glosses.is_empty() {
                            let (word, alt_word) = if let Some(k) = kanji_forms.first() {
                                (k.clone(), kana_forms.first().cloned().unwrap_or_default())
                            } else if let Some(k) = kana_forms.first() {
                                (k.clone(), String::new())
                            } else {
                                in_entry = false;
                                continue;
                            };
                            let reading = kana_forms.first().cloned().unwrap_or_default();
                            out.push(LangDictEntry {
                                word,
                                alt_word,
                                reading,
                                // Cap to first ~5 senses; full JMdict has long
                                // entries that bloat the row.
                                gloss: glosses
                                    .iter()
                                    .take(5)
                                    .cloned()
                                    .collect::<Vec<_>>()
                                    .join("; "),
                            });
                        }
                        in_entry = false;
                    }
                    _ => {}
                }
                current_text.clear();
            }
            Ok(Event::Eof) => break,
            // Skip GDF entities + any other unknown construct that quick-xml
            // doesn't understand without aborting the whole parse.
            Ok(_) => {}
            Err(e) => {
                // Surface the byte offset to make the error actionable, but
                // don't abort if there's still useful data parsed already —
                // we'd rather ship a partial dict than nothing.
                if out.is_empty() {
                    return Err(format!(
                        "jmdict xml at byte {}: {e}",
                        reader.buffer_position()
                    ));
                }
                break;
            }
        }
        buf.clear();
        let _ = in_entry; // silence unused-write warning under some builds
    }

    Ok(out)
}

#[derive(PartialEq, Eq)]
enum JmdictState {
    None,
    Keb,
    Reb,
    Gloss,
}

/// Parser for the EDRDG KANJIDIC2 XML release — per-character kanji
/// dictionary, companion to JMdict. Streamed via quick-xml so memory
/// stays constant for the ~14 MB uncompressed file.
///
/// We capture, per `<character>`:
///   - `<literal>` → `word` (the kanji itself)
///   - `<reading r_type="ja_on">` → On reading (Chinese-derived, katakana)
///   - `<reading r_type="ja_kun">` → Kun reading (native Japanese, hiragana; `.` marks the okurigana cut)
///   - `<meaning>` with no `m_lang` attr → English meaning (`m_lang="fr"/"es"/"pt"` entries are skipped since this pack is "(English)")
///
/// Reading column is the On readings + Kun readings joined with `; ` so
/// the click-to-define popover renders them inline. Each kanji
/// becomes one row whether or not it has both reading types — every
/// EDRDG character has at least one.
fn parse_kanjidic_xml(text: &str) -> Result<Vec<LangDictEntry>, String> {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;

    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);
    reader.config_mut().allow_unmatched_ends = true;

    let mut buf = Vec::new();
    let mut out: Vec<LangDictEntry> = Vec::new();

    let mut state = KanjidicState::None;
    let mut current_text = String::new();
    let mut literal = String::new();
    let mut on_readings: Vec<String> = Vec::new();
    let mut kun_readings: Vec<String> = Vec::new();
    let mut meanings: Vec<String> = Vec::new();
    // Whether the currently-open <meaning> tag has an m_lang attr.
    // KANJIDIC2 omits m_lang for English; "fr"/"es"/"pt" entries do
    // carry it. We want English only.
    let mut meaning_is_english = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = e.local_name();
                let n = name.as_ref();
                match n {
                    b"character" => {
                        literal.clear();
                        on_readings.clear();
                        kun_readings.clear();
                        meanings.clear();
                    }
                    b"literal" => state = KanjidicState::Literal,
                    b"reading" => {
                        let r_type = e
                            .attributes()
                            .filter_map(Result::ok)
                            .find(|a| a.key.local_name().as_ref() == b"r_type")
                            .and_then(|a| String::from_utf8(a.value.to_vec()).ok());
                        state = match r_type.as_deref() {
                            Some("ja_on") => KanjidicState::OnReading,
                            Some("ja_kun") => KanjidicState::KunReading,
                            _ => KanjidicState::None, // pinyin / korean / vietnam skipped
                        };
                    }
                    b"meaning" => {
                        // No m_lang attribute → English by default.
                        meaning_is_english = !e
                            .attributes()
                            .filter_map(Result::ok)
                            .any(|a| a.key.local_name().as_ref() == b"m_lang");
                        state = if meaning_is_english {
                            KanjidicState::Meaning
                        } else {
                            KanjidicState::None
                        };
                    }
                    _ => {}
                }
                current_text.clear();
            }
            Ok(Event::Text(t)) => {
                if state != KanjidicState::None {
                    current_text.push_str(&t.unescape().unwrap_or_default());
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name();
                let n = name.as_ref();
                match n {
                    b"literal" => {
                        if !current_text.is_empty() {
                            literal = current_text.clone();
                        }
                        state = KanjidicState::None;
                    }
                    b"reading" => {
                        if !current_text.is_empty() {
                            match state {
                                KanjidicState::OnReading => on_readings.push(current_text.clone()),
                                KanjidicState::KunReading => {
                                    kun_readings.push(current_text.clone())
                                }
                                _ => {}
                            }
                        }
                        state = KanjidicState::None;
                    }
                    b"meaning" => {
                        if meaning_is_english && !current_text.is_empty() {
                            meanings.push(current_text.clone());
                        }
                        state = KanjidicState::None;
                        meaning_is_english = false;
                    }
                    b"character" => {
                        if !literal.is_empty() && !meanings.is_empty() {
                            let mut reading_parts: Vec<String> = Vec::new();
                            if !on_readings.is_empty() {
                                reading_parts.push(on_readings.join(", "));
                            }
                            if !kun_readings.is_empty() {
                                reading_parts.push(kun_readings.join(", "));
                            }
                            out.push(LangDictEntry {
                                word: std::mem::take(&mut literal),
                                alt_word: String::new(),
                                reading: reading_parts.join(" · "),
                                gloss: meanings
                                    .iter()
                                    .take(8)
                                    .cloned()
                                    .collect::<Vec<_>>()
                                    .join("; "),
                            });
                        }
                        literal.clear();
                        on_readings.clear();
                        kun_readings.clear();
                        meanings.clear();
                    }
                    _ => {}
                }
                current_text.clear();
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => {
                if out.is_empty() {
                    return Err(format!(
                        "kanjidic xml at byte {}: {e}",
                        reader.buffer_position()
                    ));
                }
                break;
            }
        }
        buf.clear();
    }

    Ok(out)
}

#[derive(PartialEq, Eq)]
enum KanjidicState {
    None,
    Literal,
    OnReading,
    KunReading,
    Meaning,
}

fn parse_ding(text: &str) -> Vec<LangDictEntry> {
    // Beolingus / Ding format:
    //   "Apfel {m} | Äpfel {pl} :: apple | apples"
    //   "gern; gerne; mit Freuden [geh.] {adv} | ... :: gladly; happily | ..."
    //   "ich {ppron}; icke [Berlin] ~mir ~mich | ... :: I; me | ..."
    //
    // Pipes separate senses; LHS is German, RHS is English. Semicolons
    // inside the FIRST pipe segment separate German synonyms that
    // share the same meaning (gern/gerne, ich/icke). We emit one row
    // per synonym so each surface form is independently lookup-able.
    //
    // We strip {m}/{n}/{pl}/etc. annotations from the headword for
    // cleaner storage, and we drop "synonyms" that are obviously not
    // dictionary headwords (tildes mark grammatical case slots like
    // "~mir ~mich", brackets carry register notes).
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((lhs, rhs)) = line.split_once(" :: ") else {
            continue;
        };

        // Take just the first '|'-segment of the LHS as the headword
        // group — later segments are example sentences, not headwords.
        let head_group = lhs.split('|').next().unwrap_or(lhs);

        // Build the gloss once per line: all RHS senses, joined with
        // "; ". Every synonym row gets the same gloss.
        let glosses: Vec<String> = rhs
            .split('|')
            .flat_map(|s| s.split(';'))
            .map(|s| strip_ding_annotations(s.trim()))
            .filter(|s| !s.is_empty())
            .collect();
        if glosses.is_empty() {
            continue;
        }
        let gloss = glosses.join("; ");

        // One row per German synonym. The same English gloss is
        // attached to each so the popover stays informative whichever
        // surface form the learner clicked.
        for raw_syn in head_group.split(';') {
            let cleaned = strip_ding_annotations(raw_syn.trim());
            if !is_dictionary_headword(&cleaned) {
                continue;
            }
            out.push(LangDictEntry {
                word: cleaned,
                alt_word: String::new(),
                reading: String::new(),
                gloss: gloss.clone(),
            });
        }
    }
    out
}

/// True for strings that look like real dictionary headwords. Filters
/// out Ding's case-slot markers (`~mir`, `~mich`), reference-only
/// pointers, and anything starting with punctuation. Whole-word
/// matching only — we already stripped annotations.
fn is_dictionary_headword(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let first = s.chars().next().unwrap();
    if first == '~' || first == '(' || first == '[' {
        return false;
    }
    // Reject strings consisting entirely of punctuation / digits.
    s.chars().any(|c| c.is_alphabetic())
}

fn strip_ding_annotations(s: &str) -> String {
    // Remove {m}, {n}, {f}, {pl}, [sl.], (etw.) etc. — anything in {} or []
    // (but leave parentheses since they often carry meaning).
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '{' | '[' => {
                let close = if c == '{' { '}' } else { ']' };
                for next in chars.by_ref() {
                    if next == close {
                        break;
                    }
                }
            }
            _ => out.push(c),
        }
    }
    // Collapse repeated whitespace.
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn parse_kengdic(text: &str) -> Vec<LangDictEntry> {
    // Kengdic TSV: id\tkorean\thanja\tpos\tdefinition\tgrade\t...
    // We only need: korean (col 1), hanja (col 2, optional), definition (col 4).
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if i == 0 && line.to_lowercase().contains("korean") {
            continue; // skip header if present
        }
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 5 {
            continue;
        }
        let korean = cols[1].trim();
        let hanja = cols[2].trim();
        let definition = cols[4].trim();
        if korean.is_empty() || definition.is_empty() {
            continue;
        }
        out.push(LangDictEntry {
            word: korean.to_string(),
            alt_word: if hanja.is_empty() {
                String::new()
            } else {
                hanja.to_string()
            },
            reading: String::new(),
            gloss: definition.to_string(),
        });
    }
    out
}

// The Kaikki JSONL parser trio (`parse_kaikki_jsonl`,
// `extract_kaikki_reading`, `strip_pinyin_paren_suffix`) used to live
// here. They were removed alongside the zh/ja/ko/de/es Kaikki packs
// in the registry — the Yomitan-Wiktionary path below covers the same
// upstream data through `parse_yomitan_zip`, with much smaller
// downloads and cleaner inflected-form rows.

/// Parser for the Yomitan dictionary archive format (the
/// kaikki-to-yomitan / wiktionary-to-yomitan zips for German, Spanish,
/// and other European languages). A Yomitan zip contains:
///
///   index.json         — pack metadata (title, format version, ...)
///   tag_bank_N.json    — definition / inflection tag dictionaries
///   term_bank_N.json   — arrays of 8-tuple term entries
///   term_meta_bank_N.json — frequency / pitch (ignored here)
///   kanji_bank_N.json     — Japanese kanji entries (ignored)
///
/// Each term-bank entry is shaped as
///   [expression, reading, definitionTags, rules, score, glossary,
///    sequence, termTags]
/// where `glossary` is an array whose items are either plain strings
/// (legacy v1/v2 dicts) or `{ "type": "structured-content", "content":
/// ... }` / `{ "type": "text", "text": ... }` objects (v3+; what
/// kaikki-to-yomitan emits).
///
/// We flatten `glossary` into one "; "-joined string per term, picking
/// out the gloss text from the structured-content tree and dropping
/// the meta subtrees Wiktionary wraps around each sense (Wiktionary
/// backlinks, tag pills, headword lines). The output has the same
/// `LangDictEntry` shape every other parser produces, so the popover
/// and search code don't need to know which format the row came from.
///
/// Yomitan dicts ship sequenced rows for inflected forms cross-
/// referenced to their lemma (e.g. `geht` → "third-person singular
/// present of gehen"), so installing a Yomitan-Wiktionary pack covers
/// a good chunk of what Tokori's lemmatizer fallback handles. The
/// lemmatizer still runs as a backstop for words the pack doesn't
/// surface a row for.
fn parse_yomitan_zip(bytes: &[u8]) -> Result<Vec<LangDictEntry>, String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(cursor).map_err(|e| format!("yomitan zip: {e}"))?;
    let mut out: Vec<LangDictEntry> = Vec::new();

    // We don't know which file is term_bank_N up-front, but the names
    // are stable so we just probe every entry. Index-by-index avoids
    // an upfront iteration over names + a second pass.
    for i in 0..zip.len() {
        let mut file = zip
            .by_index(i)
            .map_err(|e| format!("yomitan zip entry {i}: {e}"))?;
        let name = file.name().to_string();
        if !is_yomitan_term_bank(&name) {
            continue;
        }
        let mut text = String::new();
        file.read_to_string(&mut text)
            .map_err(|e| format!("yomitan {name}: {e}"))?;
        let value: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            // A single malformed term bank shouldn't tank the whole
            // install — Wiktionary is a moving target. Skip and keep
            // collecting from the rest of the zip.
            Err(_) => continue,
        };
        let Some(arr) = value.as_array() else {
            continue;
        };
        for entry in arr {
            let Some(tuple) = entry.as_array() else {
                continue;
            };
            if tuple.len() < 6 {
                continue;
            }
            let word = tuple[0].as_str().unwrap_or("").trim();
            if word.is_empty() {
                continue;
            }
            let reading = tuple[1].as_str().unwrap_or("").trim();
            let glosses = extract_yomitan_glosses(&tuple[5]);
            if glosses.is_empty() {
                continue;
            }
            out.push(LangDictEntry {
                word: word.to_string(),
                alt_word: String::new(),
                reading: reading.to_string(),
                // Cap the joined gloss the same way JMdict does so
                // verbose Wiktionary entries don't bloat the row.
                gloss: glosses.into_iter().take(8).collect::<Vec<_>>().join("; "),
            });
        }
    }

    Ok(out)
}

fn is_yomitan_term_bank(name: &str) -> bool {
    // Names look like `term_bank_1.json` or, for zips that nest, like
    // `kty-de-en/term_bank_1.json`. Match on the basename.
    let base = name.rsplit('/').next().unwrap_or(name);
    base.starts_with("term_bank_") && base.ends_with(".json")
}

/// Pull the gloss strings out of a Yomitan `glossary` array. Each item
/// is independent and can be one of four shapes:
///   1. A plain string (legacy v1/v2 dicts).
///   2. `{ "type": "text", "text": "..." }` — the v3 single-line shape.
///   3. `{ "type": "structured-content", "content": [...] }` — the v3
///      HTML-as-JSON tree kaikki-to-yomitan emits for full lemmas.
///   4. A 2-element array `[lemma, [tag1, tag2, ...]]` — the compact
///      "non-lemma" shape used for inflected-form rows. We render this
///      as `"<joined-tags> of <lemma>"` so a click on `geht` produces
///      `"third-person singular present of gehen"` in the popover.
fn extract_yomitan_glosses(value: &serde_json::Value) -> Vec<String> {
    let Some(arr) = value.as_array() else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for item in arr {
        match item {
            serde_json::Value::String(s) => {
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    out.push(trimmed.to_string());
                }
            }
            serde_json::Value::Object(o) => {
                let typ = o.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match typ {
                    "text" => {
                        if let Some(t) = o.get("text").and_then(|x| x.as_str()) {
                            let trimmed = t.trim();
                            if !trimmed.is_empty() {
                                out.push(trimmed.to_string());
                            }
                        }
                    }
                    "structured-content" => {
                        if let Some(content) = o.get("content") {
                            out.extend(flatten_yomitan_structured(content));
                        }
                    }
                    // image / audio entries carry no gloss text; skip.
                    _ => {}
                }
            }
            serde_json::Value::Array(tuple) => {
                // Non-lemma shape: `[lemma_string, [sense_tag, ...]]`.
                if let Some(rendered) = render_yomitan_inflection(tuple) {
                    out.push(rendered);
                }
            }
            _ => {}
        }
    }
    out
}

fn render_yomitan_inflection(tuple: &[serde_json::Value]) -> Option<String> {
    if tuple.len() < 2 {
        return None;
    }
    let lemma = tuple[0].as_str()?.trim();
    if lemma.is_empty() {
        return None;
    }
    let tags = tuple[1].as_array()?;
    let joined_tags = tags
        .iter()
        .filter_map(|t| t.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    if joined_tags.is_empty() {
        Some(format!("inflection of {lemma}"))
    } else {
        Some(format!("{joined_tags} of {lemma}"))
    }
}

/// Walk a Yomitan structured-content tree and emit one cleaned gloss
/// string per `<li>` it contains. If the tree has no list items we
/// fall back to one flat join of every text node — this covers older
/// or non-kaikki dicts that lay their senses out as plain prose.
fn flatten_yomitan_structured(value: &serde_json::Value) -> Vec<String> {
    let mut items: Vec<String> = Vec::new();
    collect_list_item_text(value, &mut items);
    if !items.is_empty() {
        return items;
    }
    let mut buf = String::new();
    collect_text_nodes(value, &mut buf);
    let collapsed = buf.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        Vec::new()
    } else {
        vec![collapsed]
    }
}

fn collect_list_item_text(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::Array(arr) => {
            for child in arr {
                collect_list_item_text(child, out);
            }
        }
        serde_json::Value::Object(obj) => {
            let tag = obj.get("tag").and_then(|t| t.as_str()).unwrap_or("");
            // Yomitan convention: `<details>` wraps collapsible "See
            // More" content (example sentences, related forms, etc.).
            // Never the primary gloss. KRDICT-style dicts park their
            // Korean example-word lists inside one of these; without
            // this skip, the gloss column ends up reading "친동생;
            // 친딸; …" instead of the actual English meaning.
            if tag == "details" {
                return;
            }
            if tag == "li" {
                let mut buf = String::new();
                if let Some(content) = obj.get("content") {
                    collect_text_nodes(content, &mut buf);
                }
                let collapsed = buf.split_whitespace().collect::<Vec<_>>().join(" ");
                if !collapsed.is_empty() {
                    out.push(collapsed);
                }
                return;
            }
            if let Some(content) = obj.get("content") {
                collect_list_item_text(content, out);
            }
        }
        _ => {}
    }
}

fn collect_text_nodes(value: &serde_json::Value, out: &mut String) {
    match value {
        serde_json::Value::String(s) => {
            out.push_str(s);
            out.push(' ');
        }
        serde_json::Value::Array(arr) => {
            for child in arr {
                collect_text_nodes(child, out);
            }
        }
        serde_json::Value::Object(obj) => {
            let tag = obj.get("tag").and_then(|t| t.as_str()).unwrap_or("");
            // Same `<details>` skip as `collect_list_item_text`. The
            // fallback "collect everything" path runs for dicts whose
            // glosses live in `<div>` rather than `<ol>` / `<li>`
            // (KRDICT, STDICT) — without this skip those dicts would
            // surface their example sentences as part of the gloss.
            if tag == "details" {
                return;
            }
            // Skip subtrees that carry meta-text Wiktionary wraps
            // around each sense — these are render hints, not gloss
            // content, and including them would clutter the popover
            // with things like "Wiktionary" backlinks or "txt-msg" tag
            // labels. The marker is the `data.content` attribute the
            // Yomitan CSS uses for styling.
            let data_content = obj
                .get("data")
                .and_then(|d| d.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or("");
            if matches!(
                data_content,
                "tag"
                    | "tags"
                    | "backlink"
                    | "headword-line"
                    | "headword"
                    | "headword-info"
                    | "headword-info-line"
                    | "footer"
            ) {
                return;
            }
            if let Some(content) = obj.get("content") {
                collect_text_nodes(content, out);
            }
        }
        _ => {}
    }
}

/// Parser for the doozan/spanish_data Wiktionary export format
/// (see https://github.com/doozan/spanish_data). One entry per
/// `_____` separator line:
///
///   _____
///   esta
///   pos: pron
///     meta: {{head|es|pronoun}}
///     gloss: this (feminine singular)
///   pos: adj
///     meta: {{head|es|adjective}}
///     gloss: this (feminine singular)
///
/// We emit one `LangDictEntry` per headword, joining every `gloss:`
/// line (across all `pos:` blocks) into one "; "-separated string —
/// same shape the popover already renders for CC-CEDICT and JMdict.
/// `meta:`, `etymology:`, and other key lines are ignored.
fn parse_wiktionary_data(text: &str) -> Vec<LangDictEntry> {
    let mut out = Vec::new();
    let mut word: Option<String> = None;
    let mut glosses: Vec<String> = Vec::new();
    let mut pos_seen = false;

    let flush = |word: &mut Option<String>,
                 glosses: &mut Vec<String>,
                 pos_seen: &mut bool,
                 out: &mut Vec<LangDictEntry>| {
        if let Some(w) = word.take() {
            if !glosses.is_empty() {
                out.push(LangDictEntry {
                    word: w,
                    alt_word: String::new(),
                    reading: String::new(),
                    gloss: glosses.join("; "),
                });
            }
        }
        glosses.clear();
        *pos_seen = false;
    };

    for raw in text.lines() {
        let line = raw.trim_end();
        if line == "_____" {
            flush(&mut word, &mut glosses, &mut pos_seen, &mut out);
            continue;
        }
        // First non-empty line after the separator is the headword.
        if word.is_none() {
            if line.is_empty() {
                continue;
            }
            word = Some(line.trim().to_string());
            continue;
        }
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("pos:") {
            pos_seen = !rest.trim().is_empty() || pos_seen;
        } else if let Some(rest) = trimmed.strip_prefix("gloss:") {
            let g = rest.trim();
            if !g.is_empty() {
                glosses.push(unquote_data_gloss(g));
            }
        }
    }
    flush(&mut word, &mut glosses, &mut pos_seen, &mut out);
    out
}

/// Wiktionary glosses arrive with embedded double quotes around
/// referenced terms (`pronunciation spelling of "estás"`). Keep them
/// — they look right in the popover — but trim wrapping pairs of
/// outer quotes that some exports add.
fn unquote_data_gloss(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        return s[1..s.len() - 1].to_string();
    }
    s.to_string()
}

// `parse_kedict` and `unquote_yaml_scalar` used to live here. The
// CC-KEDICT YAML pack was replaced by the KRDICT Yomitan zip, which
// goes through `parse_yomitan_zip` like the German + Spanish packs.

/// Parser for FreeDict-flavoured TEI bilingual dictionaries
/// (WikDict and FreeDict both emit this shape). One `<entry>` contains
/// `<form><orth>` (headword), optional `<form><pron>` (IPA), and one or
/// more `<sense><cit type="trans"><quote>` (target-language glosses).
/// Streamed via quick-xml so memory stays constant for the larger
/// (German-sized) dictionaries.
fn parse_tei_bilingual(text: &str) -> Result<Vec<LangDictEntry>, String> {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;

    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);
    reader.config_mut().allow_unmatched_ends = true;

    let mut buf = Vec::new();
    let mut out: Vec<LangDictEntry> = Vec::new();

    let mut state = TeiState::None;
    let mut current_text = String::new();
    let mut in_translation_cit = false;
    let mut headword = String::new();
    let mut pron = String::new();
    let mut glosses: Vec<String> = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = e.local_name();
                let n = name.as_ref();
                match n {
                    b"entry" => {
                        headword.clear();
                        pron.clear();
                        glosses.clear();
                    }
                    b"orth" => state = TeiState::Orth,
                    b"pron" => state = TeiState::Pron,
                    b"cit" => {
                        // Only collect translation citations — the type="trans"
                        // attribute distinguishes glosses from example sentences.
                        let is_trans = e.attributes().filter_map(Result::ok).any(|a| {
                            a.key.local_name().as_ref() == b"type" && a.value.as_ref() == b"trans"
                        });
                        in_translation_cit = is_trans;
                    }
                    b"quote" if in_translation_cit => {
                        state = TeiState::Quote;
                    }
                    _ => {}
                }
                current_text.clear();
            }
            Ok(Event::Text(t)) => {
                if state != TeiState::None {
                    current_text.push_str(&t.unescape().unwrap_or_default());
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name();
                let n = name.as_ref();
                match n {
                    b"orth" => {
                        if headword.is_empty() && !current_text.is_empty() {
                            headword = current_text.clone();
                        }
                        state = TeiState::None;
                    }
                    b"pron" => {
                        if pron.is_empty() && !current_text.is_empty() {
                            pron = current_text.clone();
                        }
                        state = TeiState::None;
                    }
                    b"quote" => {
                        if state == TeiState::Quote && !current_text.is_empty() {
                            glosses.push(current_text.clone());
                        }
                        state = TeiState::None;
                    }
                    b"cit" => {
                        in_translation_cit = false;
                    }
                    b"entry" => {
                        if !headword.is_empty() && !glosses.is_empty() {
                            out.push(LangDictEntry {
                                word: std::mem::take(&mut headword),
                                alt_word: String::new(),
                                reading: std::mem::take(&mut pron),
                                gloss: glosses
                                    .iter()
                                    .take(8)
                                    .cloned()
                                    .collect::<Vec<_>>()
                                    .join("; "),
                            });
                        }
                        glosses.clear();
                    }
                    _ => {}
                }
                current_text.clear();
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => {
                if out.is_empty() {
                    return Err(format!("tei xml at byte {}: {e}", reader.buffer_position()));
                }
                break;
            }
        }
        buf.clear();
    }

    Ok(out)
}

#[derive(PartialEq, Eq)]
enum TeiState {
    None,
    Orth,
    Pron,
    Quote,
}

fn parse_cedict(text: &str) -> Vec<CedictEntry> {
    let mut out = Vec::new();
    for line in text.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        // Format: "TRAD SIMP [pinyin] /gloss1/gloss2/.../"
        let Some(bracket_open) = line.find('[') else {
            continue;
        };
        let Some(bracket_close) = line.find(']') else {
            continue;
        };
        if bracket_close <= bracket_open {
            continue;
        }
        let head = line[..bracket_open].trim();
        let pinyin = line[bracket_open + 1..bracket_close].trim().to_string();
        let after = line[bracket_close + 1..].trim();
        let mut parts = head.split_whitespace();
        let Some(trad) = parts.next() else { continue };
        let Some(simp) = parts.next() else { continue };
        let gloss = after.trim_matches('/').replace('/', "; ");
        out.push(CedictEntry {
            word: simp.to_string(),
            alt_word: trad.to_string(),
            reading: pinyin,
            gloss,
        });
    }
    out
}

#[derive(Deserialize)]
struct OllamaTags {
    models: Vec<OllamaModel>,
}

#[derive(Deserialize, Serialize)]
pub struct OllamaModel {
    pub name: String,
    #[serde(default)]
    pub size: u64,
}

use std::sync::OnceLock;

#[derive(Serialize)]
pub struct ZhToken {
    pub text: String,
    pub is_word: bool,
}

static JIEBA: OnceLock<jieba_rs::Jieba> = OnceLock::new();

#[tauri::command]
pub fn tokenize_zh(text: String) -> Vec<ZhToken> {
    let jieba = JIEBA.get_or_init(jieba_rs::Jieba::new);
    // `cut(&text, true)` enables jieba's HMM (Viterbi) pass for
    // out-of-vocabulary words — proper nouns (李雷, 北京市兴业区), modern
    // slang (拼多多, 代码作家), technical terms not in the built-in
    // dictionary all get marked as single tokens instead of being
    // split character-by-character. ~10-30% slower per call but
    // segmentation runs once per chat bubble (cached downstream),
    // so the cost is invisible at the user level and the
    // click-to-define popover stops landing on single characters
    // when the underlying word is a name or neologism.
    jieba
        .cut(&text, true)
        .into_iter()
        .map(|seg| {
            let s = seg.to_string();
            // A segment is "word-like" if it contains any CJK or Latin letter.
            let is_word = s.chars().any(|c| {
                c.is_alphabetic()
                    || (0x4E00..=0x9FFF).contains(&(c as u32))
                    || (0x3400..=0x4DBF).contains(&(c as u32))
            });
            ZhToken { text: s, is_word }
        })
        .collect()
}

// Stroke + median data for Chinese characters and CJK kanji, served from the
// bundled `hanzi-writer-data` tree so the app works offline. Returns None for
// characters not in the dataset (kana, latin, etc.).
#[tauri::command]
pub async fn hanzi_stroke(
    app: tauri::AppHandle,
    char: String,
) -> Result<Option<serde_json::Value>, String> {
    use tauri::Manager;
    // Sanity: the dataset stores one file per char, with the char
    // itself as the filename. Reject anything that isn't a single
    // codepoint so we don't try to read e.g. "../../etc/passwd".
    let mut chars = char.chars();
    let single = match (chars.next(), chars.next()) {
        (Some(c), None) => c,
        _ => return Err("expected single character".to_string()),
    };
    let filename = format!("{single}.json");
    let path = app
        .path()
        .resolve(
            format!("assets/hanzi-writer-data/{filename}"),
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("resolve resource path: {e}"))?;
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let v: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|e| format!("parse {filename}: {e}"))?;
            Ok(Some(v))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {filename}: {e}")),
    }
}

// The Tauri webview blocks `fetch()` to other localhost ports as a cross-origin
// request, so calling AnkiConnect on :8765 from the renderer fails with
// "failed to fetch". Proxying through Rust sidesteps that.
#[tauri::command]
pub async fn anki_invoke(
    endpoint: String,
    action: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({
        "action": action,
        "version": 6,
        "params": params,
    });
    let resp = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("client: {e}"))?
        .post(&endpoint)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("anki request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "anki {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }
    let parsed: serde_json::Value = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    if let Some(err) = parsed.get("error") {
        if !err.is_null() {
            return Err(err.as_str().unwrap_or("anki error").to_string());
        }
    }
    Ok(parsed
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
pub async fn ollama_list_models(host: String) -> Result<Vec<OllamaModel>, String> {
    let url = format!("{}/api/tags", host.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("ollama not reachable at {host}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "ollama {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }
    let tags: OllamaTags = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    Ok(tags.models)
}

#[derive(Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub label: Option<String>,
    pub family: Option<String>,
}

#[tauri::command]
pub async fn provider_list_models(config: ProviderConfig) -> Result<Vec<ModelInfo>, String> {
    match config {
        ProviderConfig::Ollama { host, .. } => list_ollama(&host).await,
        ProviderConfig::Openai {
            api_key, base_url, ..
        } => {
            let base = base_url.as_deref().unwrap_or("https://api.openai.com");
            list_openai_compat(&api_key, base, "openai").await
        }
        ProviderConfig::Anthropic { api_key, .. } => list_anthropic(&api_key).await,
        ProviderConfig::Gemini { api_key, .. } => list_gemini(&api_key).await,
        ProviderConfig::Minimax {
            api_key, base_url, ..
        } => {
            let base = base_url.as_deref().unwrap_or("https://api.minimax.io");
            list_openai_compat(&api_key, base, "minimax").await
        }
    }
}

async fn list_ollama(host: &str) -> Result<Vec<ModelInfo>, String> {
    let url = format!("{}/api/tags", host.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("ollama not reachable at {host}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "ollama {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }
    let tags: OllamaTags = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    Ok(tags
        .models
        .into_iter()
        .map(|m| ModelInfo {
            id: m.name,
            label: None,
            family: Some("ollama".into()),
        })
        .collect())
}

#[derive(Deserialize)]
struct OpenAIModelsResp {
    data: Vec<OpenAIModelEntry>,
}

#[derive(Deserialize)]
struct OpenAIModelEntry {
    id: String,
    #[serde(default)]
    owned_by: Option<String>,
}

async fn list_openai_compat(
    api_key: &str,
    base_url: &str,
    family: &str,
) -> Result<Vec<ModelInfo>, String> {
    let base = base_url.trim_end_matches('/');
    // Same guard as stream_openai: if the user's base_url already
    // ends with `/v1` (Groq, OpenRouter, etc. typically do) skip
    // the redundant prefix; otherwise append it (vanilla OpenAI).
    let models_path = if base.ends_with("/v1")
        || base.rsplit_once('/').is_some_and(|(_, last)| {
            last.starts_with('v') && last.len() > 1 && last[1..].chars().all(|c| c.is_ascii_digit())
        }) {
        "/models"
    } else {
        "/v1/models"
    };
    let url = format!("{base}{models_path}");
    let resp = reqwest::Client::new()
        .get(&url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| format!("{family} request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("{family} {status}: {text}"));
    }
    let parsed: OpenAIModelsResp = resp
        .json()
        .await
        .map_err(|e| format!("{family} parse: {e}"))?;
    let mut out: Vec<ModelInfo> = parsed
        .data
        .into_iter()
        .map(|m| ModelInfo {
            id: m.id,
            label: m.owned_by.clone(),
            family: Some(family.to_string()),
        })
        .collect();
    // Heuristic: filter to chat-capable IDs for the canonical OpenAI host.
    if family == "openai" && base_url.contains("api.openai.com") {
        out.retain(|m| {
            let id = m.id.to_lowercase();
            id.starts_with("gpt-")
                || id.starts_with("o1")
                || id.starts_with("o3")
                || id.starts_with("o4")
                || id.starts_with("chatgpt-")
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[derive(Deserialize)]
struct AnthropicModelsResp {
    data: Vec<AnthropicModelEntry>,
}

#[derive(Deserialize)]
struct AnthropicModelEntry {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
}

async fn list_anthropic(api_key: &str) -> Result<Vec<ModelInfo>, String> {
    let resp = reqwest::Client::new()
        .get("https://api.anthropic.com/v1/models")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|e| format!("anthropic request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("anthropic {status}: {text}"));
    }
    let parsed: AnthropicModelsResp = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    let mut out: Vec<ModelInfo> = parsed
        .data
        .into_iter()
        .map(|m| ModelInfo {
            id: m.id,
            label: m.display_name,
            family: Some("anthropic".into()),
        })
        .collect();
    out.sort_by(|a, b| b.id.cmp(&a.id)); // newest-ish first when version-suffixed
    Ok(out)
}

#[derive(Deserialize)]
struct GeminiModelsResp {
    models: Vec<GeminiModelEntry>,
}

#[derive(Deserialize)]
struct GeminiModelEntry {
    name: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    supported_generation_methods: Option<Vec<String>>,
}

async fn list_gemini(api_key: &str) -> Result<Vec<ModelInfo>, String> {
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models?key={api_key}");
    let resp = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("gemini request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("gemini {status}: {text}"));
    }
    let parsed: GeminiModelsResp = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    let mut out: Vec<ModelInfo> = parsed
        .models
        .into_iter()
        .filter(|m| {
            // Only keep chat-capable models.
            m.supported_generation_methods
                .as_ref()
                .map(|v| v.iter().any(|x| x == "generateContent"))
                .unwrap_or(true)
        })
        .map(|m| ModelInfo {
            id: m
                .name
                .strip_prefix("models/")
                .unwrap_or(&m.name)
                .to_string(),
            label: m.display_name,
            family: Some("gemini".into()),
        })
        .collect();
    out.sort_by(|a, b| b.id.cmp(&a.id)); // newer Gemini versions sort higher lexicographically
    Ok(out)
}

// Microsoft's Edge browser uses an undocumented WebSocket TTS service that's
// effectively free for end users: no key, multiple Neural voices per language,
// good quality. We proxy through Rust because the protocol needs custom HTTP
// headers and binary frame parsing that browsers don't expose comfortably.
// Reference protocol: edge-tts (Python) by rany2.
const EDGE_TTS_TRUSTED_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
/// User-Agent + Sec-MS-GEC-Version values. Microsoft rejects WebSocket
/// upgrades whose UA doesn't look like a recent Edge build — the value here
/// is bumped periodically to track current rany2/edge-tts upstream. If you
/// see "edge-tts connect: HTTP error: 403 Forbidden" again, that's the
/// likely cause; bump these to a current Edge stable release.
const EDGE_TTS_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.2957.140";
const EDGE_TTS_GEC_VERSION: &str = "1-132.0.2957.140";

/// Compute the `Sec-MS-GEC` URL parameter the way Edge does it, with an
/// optional `clock_skew` offset so we can retry after a 403 with the
/// server's reported time. Without skew, this matches rany2/edge-tts.
///
/// Algorithm:
///   1. Take the current time as Windows file-time (100 ns ticks since
///      1601-01-01 UTC), with `clock_skew` (seconds) added on first.
///   2. Round down to a 5-minute boundary — Microsoft's server validates
///      the same window so close-by clients produce identical tokens.
///   3. SHA-256 of the rounded ticks concat'd with the TrustedClientToken,
///      uppercase hex.
fn edge_tts_sec_ms_gec(clock_skew_secs: i64) -> String {
    use sha2::{Digest, Sha256};
    // 100-ns ticks between 1601-01-01 and 1970-01-01 (Unix epoch).
    const WIN_EPOCH_OFFSET: i64 = 11_644_473_600;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let adjusted = secs + clock_skew_secs;
    let win_ticks = (adjusted + WIN_EPOCH_OFFSET) * 10_000_000;
    // Round down to 5-minute boundary (3 * 10^9 ticks = 5 minutes in
    // 100-ns units). Saturating math because tick counts can't be negative.
    let bucket = win_ticks - win_ticks.rem_euclid(3_000_000_000);
    let mut hasher = Sha256::new();
    hasher.update(format!("{bucket}{EDGE_TTS_TRUSTED_TOKEN}").as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(hex, "{:02X}", byte);
    }
    hex
}

/// Build a fresh Sec-MS-GEC token, prepare the request with the full set
/// of headers Microsoft expects, and open the WebSocket. Extracted so we
/// can call it twice — first with local clock, then with a server-derived
/// skew if the first attempt 403s.
async fn edge_tts_connect(
    connection_id: &str,
    clock_skew_secs: i64,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    String,
> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let url = format!(
        "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken={}&Sec-MS-GEC={}&Sec-MS-GEC-Version={}&ConnectionId={}",
        EDGE_TTS_TRUSTED_TOKEN,
        edge_tts_sec_ms_gec(clock_skew_secs),
        EDGE_TTS_GEC_VERSION,
        connection_id
    );

    // Mirror rany2/edge-tts's WSS_HEADERS exactly. Microsoft's CDN refuses
    // upgrades that don't look like a current Edge browser; missing any of
    // these is a typical 403 cause.
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("request: {e}"))?;
    let headers = request.headers_mut();
    headers.insert("User-Agent", EDGE_TTS_UA.parse().unwrap());
    headers.insert("Accept-Encoding", "gzip, deflate, br".parse().unwrap());
    headers.insert("Accept-Language", "en-US,en;q=0.9".parse().unwrap());
    headers.insert("Pragma", "no-cache".parse().unwrap());
    headers.insert("Cache-Control", "no-cache".parse().unwrap());
    headers.insert(
        "Origin",
        "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"
            .parse()
            .unwrap(),
    );
    let (ws, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| e.to_string())?;
    Ok(ws)
}

/// Fetch the server's clock from a cheap HTTPS HEAD request and return the
/// skew in seconds (server_time - local_time). Best-effort: returns 0 on
/// any error so we fall back to local time.
async fn edge_tts_clock_skew_secs() -> i64 {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return 0,
    };
    // Pick the same host the WebSocket talks to. Any HTTPS endpoint there
    // returns a Date header.
    let resp = match client
        .head("https://speech.platform.bing.com/")
        .header("User-Agent", EDGE_TTS_UA)
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return 0,
    };
    let date = match resp.headers().get(reqwest::header::DATE) {
        Some(d) => d,
        None => return 0,
    };
    let date_str = match date.to_str() {
        Ok(s) => s,
        Err(_) => return 0,
    };
    let server = match chrono::DateTime::parse_from_rfc2822(date_str) {
        Ok(d) => d.timestamp(),
        Err(_) => return 0,
    };
    let local = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    server - local
}

/// One word-boundary entry from Edge TTS. `offset_ms` / `duration_ms`
/// are derived from the 100-nanosecond ticks the service emits
/// (divided by 10_000). `text` is the literal word that was spoken at
/// that point in the audio — the JS side matches it back to the source
/// passage to compute character ranges for the karaoke-highlight.
#[derive(serde::Serialize, Clone, Debug)]
pub struct EdgeWordBoundary {
    pub offset_ms: u64,
    pub duration_ms: u64,
    pub text: String,
}

#[derive(serde::Serialize, Debug)]
pub struct EdgeTtsResult {
    pub audio: Vec<u8>,
    pub boundaries: Vec<EdgeWordBoundary>,
}

// Internal types for parsing the JSON payload Microsoft sends in
// `Path:audio.metadata` text frames. The wire format is documented at
// https://learn.microsoft.com/azure/ai-services/speech-service/how-to-speech-synthesis-viseme
// — we only care about `WordBoundary` here.
#[derive(serde::Deserialize)]
struct EdgeMetaPayload {
    #[serde(rename = "Metadata")]
    metadata: Vec<EdgeMetaItem>,
}
#[derive(serde::Deserialize)]
struct EdgeMetaItem {
    #[serde(rename = "Type")]
    kind: String,
    #[serde(rename = "Data")]
    data: EdgeMetaData,
}
#[derive(serde::Deserialize)]
struct EdgeMetaData {
    #[serde(rename = "Offset")]
    offset: u64,
    #[serde(rename = "Duration")]
    duration: u64,
    text: EdgeMetaText,
}
#[derive(serde::Deserialize)]
struct EdgeMetaText {
    #[serde(rename = "Text")]
    text: String,
}

#[tauri::command]
pub async fn edge_tts(
    text: String,
    voice: String,
    rate: Option<String>,
    pitch: Option<String>,
) -> Result<EdgeTtsResult, String> {
    let connection_id = uuid::Uuid::new_v4().simple().to_string();
    let request_id = uuid::Uuid::new_v4().simple().to_string();

    // Try with local clock first; if Microsoft rejects (the most common
    // cause of which is the user's PC clock being off by more than a few
    // minutes from the server's), fetch the server's clock from a cheap
    // HEAD probe and retry with the corrected skew. Single retry — if it
    // still fails after correction the issue isn't time.
    let mut ws = match edge_tts_connect(&connection_id, 0).await {
        Ok(ws) => ws,
        Err(e) if e.contains("403") => {
            let skew = edge_tts_clock_skew_secs().await;
            // No reliable skew → don't bother retrying with the same value.
            if skew == 0 {
                return Err(format!("edge-tts connect: {e}"));
            }
            edge_tts_connect(&connection_id, skew)
                .await
                .map_err(|e2| format!("edge-tts connect (after clock fix, skew={skew}s): {e2}"))?
        }
        Err(e) => return Err(format!("edge-tts connect: {e}")),
    };

    let now = current_time_string();

    // 1. speech.config — sets output format. mp3 24kHz 48kbps mono is widely supported.
    //    `wordBoundaryEnabled:true` makes the service interleave
    //    `Path:audio.metadata` text frames with per-word timing — the
    //    reader uses these for karaoke-style highlighting.
    let config_msg = format!(
        "X-Timestamp:{now}\r\n\
         Content-Type:application/json; charset=utf-8\r\n\
         Path:speech.config\r\n\r\n\
         {{\"context\":{{\"synthesis\":{{\"audio\":{{\"metadataoptions\":{{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"true\"}},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}}}}}"
    );
    ws.send(Message::Text(config_msg))
        .await
        .map_err(|e| format!("edge-tts config: {e}"))?;

    // 2. SSML payload. The voice name carries the language (e.g. zh-CN-XiaoxiaoNeural).
    let lang = extract_lang_from_voice(&voice);
    let rate_s = rate.unwrap_or_else(|| "+0%".to_string());
    let pitch_s = pitch.unwrap_or_else(|| "+0Hz".to_string());
    let ssml = format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='{lang}'>\
            <voice name='{voice}'>\
                <prosody rate='{rate_s}' pitch='{pitch_s}'>{}</prosody>\
            </voice>\
         </speak>",
        escape_xml(&text)
    );
    let ssml_msg = format!(
        "X-RequestId:{request_id}\r\n\
         Content-Type:application/ssml+xml\r\n\
         X-Timestamp:{now}\r\n\
         Path:ssml\r\n\r\n\
         {ssml}"
    );
    ws.send(Message::Text(ssml_msg))
        .await
        .map_err(|e| format!("edge-tts ssml: {e}"))?;

    // 3. Read until turn.end. Binary frames carry audio after a 2-byte big-endian
    //    header length + plain-text headers + \r\n\r\n separator. Text
    //    frames carry status (turn.start/end) plus, when word boundary
    //    metadata is enabled, JSON payloads at `Path:audio.metadata`.
    let mut audio: Vec<u8> = Vec::new();
    let mut boundaries: Vec<EdgeWordBoundary> = Vec::new();
    while let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| format!("edge-tts recv: {e}"))?;
        match msg {
            Message::Binary(data) => {
                if data.len() < 2 {
                    continue;
                }
                let header_len = u16::from_be_bytes([data[0], data[1]]) as usize;
                if 2 + header_len > data.len() {
                    continue;
                }
                let body = &data[2 + header_len..];
                audio.extend_from_slice(body);
            }
            Message::Text(t) => {
                if t.contains("Path:turn.end") {
                    let _ = ws.close(None).await;
                    break;
                }
                // Audio metadata frame: headers \r\n\r\n JSON. Parse the
                // JSON tail for WordBoundary entries; ignore the rest.
                // 100-nanosecond ticks → ms via /10_000.
                if t.contains("Path:audio.metadata") {
                    if let Some(sep) = t.find("\r\n\r\n") {
                        let json = &t[sep + 4..];
                        if let Ok(payload) = serde_json::from_str::<EdgeMetaPayload>(json) {
                            for item in payload.metadata {
                                if item.kind == "WordBoundary" {
                                    boundaries.push(EdgeWordBoundary {
                                        offset_ms: item.data.offset / 10_000,
                                        duration_ms: item.data.duration / 10_000,
                                        text: item.data.text.text,
                                    });
                                }
                            }
                        }
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    if audio.is_empty() {
        return Err("edge-tts returned no audio (voice id wrong?)".into());
    }
    Ok(EdgeTtsResult { audio, boundaries })
}

fn extract_lang_from_voice(voice: &str) -> String {
    // "zh-CN-XiaoxiaoNeural" → "zh-CN". Defaults to en-US if the input is unusual.
    let parts: Vec<&str> = voice.split('-').collect();
    if parts.len() >= 2 {
        format!("{}-{}", parts[0], parts[1])
    } else {
        "en-US".to_string()
    }
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn current_time_string() -> String {
    // The service accepts any reasonable date string in the JS Date.toString()
    // shape; it doesn't validate strictly. We send something close to the format
    // the official client uses.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{now} GMT+0000 (Coordinated Universal Time)")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headwords(entries: &[LangDictEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.word.as_str()).collect()
    }

    /// Build a minimal in-memory Yomitan zip with the given term-bank
    /// JSON payload, so the parser exercise touches the real ZIP path
    /// without us shipping a binary fixture.
    fn build_yomitan_zip(term_bank_json: &str) -> Vec<u8> {
        use std::io::Write as _;
        let mut buf = std::io::Cursor::new(Vec::<u8>::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            w.start_file("index.json", opts).unwrap();
            w.write_all(br#"{"title":"test","format":3,"revision":"x","sequenced":true}"#)
                .unwrap();
            w.start_file("term_bank_1.json", opts).unwrap();
            w.write_all(term_bank_json.as_bytes()).unwrap();
            w.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn yomitan_parses_legacy_and_structured_glosses() {
        // Two-entry term bank:
        //   1. Legacy v1/v2 shape — glossary is a plain string array.
        //   2. v3 kaikki-to-yomitan shape — structured-content tree
        //      with an `<ol data.content="glosses">` containing two
        //      `<li>` items, plus a tag pill and a Wiktionary
        //      backlink that must NOT leak into the gloss column.
        let term_bank = r#"[
            ["hallo","","intj","",0,["hello (greeting)"],0,""],
            ["gehen","ˈɡeːən","v","",0,[
              {"type":"structured-content","content":[
                {"tag":"ol","data":{"content":"glosses"},"content":[
                  {"tag":"li","content":[
                    {"tag":"div","data":{"content":"tags"},
                     "content":[{"tag":"span","content":"intr"}]},
                    "to go, to walk"
                  ]},
                  {"tag":"li","content":["to leave"]}
                ]},
                {"tag":"div","data":{"content":"backlink"},
                 "content":[{"tag":"a","content":"Wiktionary"}]}
              ]}
            ],0,""]
          ]"#;
        let bytes = build_yomitan_zip(term_bank);
        let entries = parse_yomitan_zip(&bytes).expect("parse_yomitan_zip");
        assert_eq!(entries.len(), 2);

        // Legacy plain-string entry passes through unchanged.
        assert_eq!(entries[0].word, "hallo");
        assert_eq!(entries[0].reading, "");
        assert_eq!(entries[0].gloss, "hello (greeting)");

        // Structured-content entry: each <li> becomes its own gloss,
        // joined by "; ". The reading column carries IPA from tuple[1].
        assert_eq!(entries[1].word, "gehen");
        assert_eq!(entries[1].reading, "ˈɡeːən");
        assert!(
            entries[1].gloss.contains("to go, to walk"),
            "got: {}",
            entries[1].gloss
        );
        assert!(entries[1].gloss.contains("to leave"));
        // Meta subtrees stay out of the user-visible gloss column.
        assert!(
            !entries[1].gloss.contains("intr"),
            "tag pill leaked: {}",
            entries[1].gloss
        );
        assert!(
            !entries[1].gloss.contains("Wiktionary"),
            "backlink leaked: {}",
            entries[1].gloss
        );
    }

    /// End-to-end smoke against a real kaikki-to-yomitan zip. Disabled
    /// by default — point `TOKORI_YOMITAN_SMOKE_ZIP` at a downloaded
    /// archive (e.g. `kty-de-en.zip`) and run
    ///   `cargo test -p tokori --lib yomitan_smoke -- --ignored --nocapture`
    /// to verify the parser handles the real Wiktionary shape without
    /// committing a multi-megabyte fixture to the repo.
    #[test]
    #[ignore = "requires TOKORI_YOMITAN_SMOKE_ZIP env var pointing at a downloaded zip"]
    fn yomitan_smoke_against_real_zip() {
        let Ok(path) = std::env::var("TOKORI_YOMITAN_SMOKE_ZIP") else {
            return;
        };
        let bytes = std::fs::read(&path).expect("read smoke zip");
        let entries = parse_yomitan_zip(&bytes).expect("parse smoke zip");
        eprintln!("yomitan smoke: {} entries from {}", entries.len(), path);
        // Sanity floor: a real Yomitan dict has at least several tens
        // of thousands of entries (KRDICT is ~90k, the kty-de-en /
        // kty-es-en zips are ~1M including inflected forms). Below
        // that, we're probably silently dropping a term-bank shape.
        assert!(
            entries.len() > 50_000,
            "expected >50k rows from a real Yomitan zip, got {}",
            entries.len()
        );
        for sample in entries.iter().take(5) {
            eprintln!(
                "  {} | {} | {}",
                sample.word,
                sample.reading,
                sample.gloss.chars().take(120).collect::<String>()
            );
        }
    }

    #[test]
    fn yomitan_skips_details_subtrees() {
        // KRDICT shape: English gloss lives in plain <div lang="en">
        // siblings; example sentences and related-word lists are
        // tucked inside <details>. Walking <details> would surface
        // those Korean example words ("친동생", "친딸", …) as the
        // gloss — the parser must skip the whole <details> tree.
        let term_bank = r#"[
            ["친","","Noun","",0,[
              {"type":"structured-content","content":[
                {"tag":"span","content":"친-","lang":"ko"},
                {"tag":"div","content":[
                  {"tag":"div","content":[
                    {"tag":"span","content":"1. ","style":{"fontWeight":"bold"}},
                    {"tag":"span","content":"chin-","lang":"en"}
                  ],"lang":"en"},
                  {"tag":"div","content":"A prefix meaning related by blood.","lang":"en"},
                  {"tag":"details","content":[
                    {"tag":"summary","content":"See More","lang":"en"},
                    {"tag":"ul","content":[
                      {"tag":"li","content":"친동생","lang":"ko"},
                      {"tag":"li","content":"친딸","lang":"ko"}
                    ]}
                  ]}
                ]}
              ]}
            ],0,""]
          ]"#;
        let bytes = build_yomitan_zip(term_bank);
        let entries = parse_yomitan_zip(&bytes).expect("parse_yomitan_zip");
        assert_eq!(entries.len(), 1);
        let gloss = &entries[0].gloss;
        assert!(gloss.contains("chin-"), "missing English gloss: {gloss}");
        assert!(
            gloss.contains("related by blood"),
            "missing English definition: {gloss}"
        );
        // The collapsed <details> example words must not leak in.
        assert!(
            !gloss.contains("친동생") && !gloss.contains("친딸"),
            "details examples leaked into gloss: {gloss}"
        );
    }

    #[test]
    fn yomitan_renders_compact_inflection_rows() {
        // kty-de-en's term_bank_5+ shape — each glossary item is a
        // 2-tuple `[lemma, [sense_tag, ...]]` rather than a string or
        // structured-content object. These rows are what makes click-
        // to-define work on inflected forms ("geht" → "third-person
        // singular present of gehen"), so they have to parse cleanly.
        let term_bank = r#"[
            ["geht","","non-lemma","",0,[["gehen",["third-person singular present"]]],0,""],
            ["voy","","non-lemma","",0,[["ir",["first-person singular present"]]],0,""]
          ]"#;
        let bytes = build_yomitan_zip(term_bank);
        let entries = parse_yomitan_zip(&bytes).expect("parse_yomitan_zip");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].word, "geht");
        assert_eq!(entries[0].gloss, "third-person singular present of gehen");
        assert_eq!(entries[1].word, "voy");
        assert_eq!(entries[1].gloss, "first-person singular present of ir");
    }

    #[test]
    fn yomitan_skips_entries_with_no_glosses() {
        let term_bank = r#"[
            ["","","",""],
            ["x","","","",0,[],0,""],
            ["y","","","",0,[""],0,""]
          ]"#;
        let bytes = build_yomitan_zip(term_bank);
        let entries = parse_yomitan_zip(&bytes).expect("parse_yomitan_zip");
        assert!(
            entries.is_empty(),
            "expected zero rows, got {} entries",
            entries.len()
        );
    }

    #[test]
    fn ding_emits_one_row_per_synonym() {
        // Real-shape sample: closed-class words live inside synonym groups.
        let sample = "gern; gerne; mit Freuden [geh.] {adv} | Ich verschiebe gern Ihren Termin. :: gladly; happily; with pleasure | I'll happily postpone your appointment.\n\
            ich {ppron}; icke [Berlin] ~mir ~mich | ich bin :: I; me | I am\n";
        let entries = parse_ding(sample);
        let words = headwords(&entries);
        assert!(words.contains(&"gern"), "expected 'gern' in {words:?}");
        assert!(words.contains(&"gerne"), "expected 'gerne' in {words:?}");
        assert!(
            words.contains(&"mit Freuden"),
            "expected 'mit Freuden' in {words:?}"
        );
        assert!(words.contains(&"ich"), "expected 'ich' in {words:?}");
        // Ding's case-slot markers (~mir, ~mich) must not become headwords.
        assert!(!words.iter().any(|w| w.starts_with('~')));
    }

    #[test]
    fn ding_shares_gloss_across_synonyms() {
        let sample =
            "Auto {n}; Wagen {m}; Kfz {n} | das rote Auto :: car; automobile | the red car\n";
        let entries = parse_ding(sample);
        assert_eq!(entries.len(), 3);
        for e in &entries {
            assert!(e.gloss.contains("car"), "gloss missing 'car': {}", e.gloss);
        }
    }

    #[test]
    fn ding_skips_lines_without_separator() {
        let entries = parse_ding("not a ding line\n# comment\n");
        assert!(entries.is_empty());
    }

    #[test]
    fn wiktionary_data_parses_lemma_with_multiple_pos_blocks() {
        let sample = "_____\nesta\npos: pron\n  meta: {{head|es|pronoun}}\n  gloss: this (feminine singular)\npos: adj\n  meta: {{head|es|adjective}}\n  gloss: this (feminine singular)\n_____\ncasa\npos: n\n  gloss: house\n  gloss: home\n";
        let entries = parse_wiktionary_data(sample);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].word, "esta");
        assert!(entries[0].gloss.contains("this"));
        assert_eq!(entries[1].word, "casa");
        assert!(entries[1].gloss.contains("house"));
        assert!(entries[1].gloss.contains("home"));
    }

    #[test]
    fn kanjidic_xml_parses_a_character_entry() {
        // Trimmed shape from the real EDRDG dump:
        //   - English meanings have no m_lang attr (must keep)
        //   - French / Spanish / Portuguese meanings carry m_lang (must drop)
        //   - pinyin / korean / vietnam readings ignored
        //   - ja_on + ja_kun joined into `reading`
        let sample = concat!(
            "<?xml version=\"1.0\"?>",
            "<kanjidic2>",
            "<character>",
            "<literal>亜</literal>",
            "<reading_meaning><rmgroup>",
            "<reading r_type=\"pinyin\">ya4</reading>",
            "<reading r_type=\"ja_on\">ア</reading>",
            "<reading r_type=\"ja_kun\">つ.ぐ</reading>",
            "<meaning>Asia</meaning>",
            "<meaning>rank next</meaning>",
            "<meaning m_lang=\"fr\">Asie</meaning>",
            "</rmgroup></reading_meaning>",
            "</character>",
            "<character>",
            "<literal>食</literal>",
            "<reading_meaning><rmgroup>",
            "<reading r_type=\"ja_on\">ショク</reading>",
            "<reading r_type=\"ja_on\">ジキ</reading>",
            "<reading r_type=\"ja_kun\">く.う</reading>",
            "<reading r_type=\"ja_kun\">た.べる</reading>",
            "<meaning>eat</meaning>",
            "<meaning>food</meaning>",
            "</rmgroup></reading_meaning>",
            "</character>",
            // Entry with no English meaning is dropped.
            "<character>",
            "<literal>X</literal>",
            "<reading_meaning><rmgroup>",
            "<reading r_type=\"ja_on\">エックス</reading>",
            "<meaning m_lang=\"fr\">non-english-only</meaning>",
            "</rmgroup></reading_meaning>",
            "</character>",
            "</kanjidic2>",
        );
        let entries = parse_kanjidic_xml(sample).expect("parse ok");
        let words: Vec<&str> = entries.iter().map(|e| e.word.as_str()).collect();
        assert_eq!(words, vec!["亜", "食"]);

        assert_eq!(entries[0].reading, "ア · つ.ぐ");
        assert_eq!(entries[0].gloss, "Asia; rank next");

        // Multi-reading kanji: On and Kun each join with ", ", separated by " · ".
        assert_eq!(entries[1].reading, "ショク, ジキ · く.う, た.べる");
        assert_eq!(entries[1].gloss, "eat; food");
    }

    #[test]
    fn wiktionary_data_drops_entries_without_glosses() {
        // Headword present but no gloss → no row. Keeps the index clean.
        let sample = "_____\nfoo\npos: n\n  meta: {{noun}}\n";
        let entries = parse_wiktionary_data(sample);
        assert!(entries.is_empty());
    }
}
