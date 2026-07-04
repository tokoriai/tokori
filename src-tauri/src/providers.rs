//! LLM chat providers.
//!
//! Architecture (Zed-inspired but minimal):
//!
//! 1. **`ChatProvider` trait** — the only abstraction every backend
//!    implements. It owns its config (api key, host, model), exposes a
//!    stable `id()`, and streams a chat via `stream(messages, sink)`.
//!    No giant switch statement reads provider state — each impl owns
//!    its own.
//!
//! 2. **`ProviderConfig` enum** — the wire format coming in from the
//!    JS frontend (and the api_server's loopback HTTP). Stays intact
//!    for backwards compatibility; this is what the desktop's
//!    settings UI persists in SQLite. `build_provider()` is the
//!    factory that turns one of these into a concrete `dyn
//!    ChatProvider`.
//!
//! 3. **`stream_chat()`** — the single entry point both `chat_send`
//!    (Tauri IPC) and the HTTP SSE bridge call. It dispatches through
//!    `build_provider` and emits the final `Done`/`Error` event so
//!    every provider gets the same trailing-event contract for free.
//!
//! Adding a new provider:
//!   - Add an enum variant to `ProviderConfig` (matches the JS
//!     `ProviderKind` literal you settled on).
//!   - Add a `struct FooProvider { ... }` carrying its config + an
//!     `impl ChatProvider for FooProvider` with the stream body.
//!   - Add the variant → struct mapping in `build_provider()`.
//!
//! The streamers themselves are intentionally small and self-contained
//! — SSE parsing, idle timeouts, and wire-format quirks live alongside
//! the impl that needs them, not in a shared helper module that has to
//! know about every dialect at once. That keeps each provider readable
//! in one pass.

use async_trait::async_trait;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::ipc::Channel;

// ── Wire types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProviderConfig {
    Ollama {
        host: String,
        model: String,
    },
    Openai {
        api_key: String,
        model: String,
        base_url: Option<String>,
    },
    Anthropic {
        api_key: String,
        model: String,
    },
    Gemini {
        api_key: String,
        model: String,
    },
    Minimax {
        api_key: String,
        model: String,
        base_url: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatEvent {
    Token { delta: String },
    Done { content: String },
    Error { message: String },
}

/// Transport-agnostic sink for streaming chat events. The Tauri IPC path
/// implements this for `Channel<ChatEvent>`; the HTTP SSE path on the
/// loopback API server implements it for a tokio mpsc sender. Streamers
/// stay oblivious to which one is in play.
pub trait ChatSink: Send + Sync {
    fn emit(&self, event: ChatEvent);
}

impl ChatSink for Channel<ChatEvent> {
    fn emit(&self, event: ChatEvent) {
        let _ = self.send(event);
    }
}

impl ChatSink for tokio::sync::mpsc::UnboundedSender<ChatEvent> {
    fn emit(&self, event: ChatEvent) {
        // Receiver may have hung up (client disconnected) — silently drop.
        let _ = self.send(event);
    }
}

// ── Provider trait + factory ───────────────────────────────────────────

/// Every chat backend implements this. The trait deliberately stays
/// minimal: an id for telemetry/logging, plus the single streaming
/// method. Capability flags (tools, thinking, multimodal) can be added
/// here when the surrounding code grows the matching consumers; today
/// every consumer wants plain streaming text.
#[async_trait]
pub trait ChatProvider: Send + Sync {
    /// Stable string id — matches the `kind` field in the JS
    /// `ProviderKind` union and the JSON tag in `ProviderConfig`.
    /// Currently consumed by the unit tests + future telemetry; the
    /// runtime dispatcher itself doesn't read it, so it shows up as
    /// dead code without the allow.
    #[allow(dead_code)]
    fn id(&self) -> &'static str;

    /// Run a streaming chat. Returns the full assembled reply on
    /// success so the call site can persist it without re-stitching
    /// from the sink's emitted tokens. Streamers MUST emit `Token`
    /// events for each delta; the dispatcher emits the trailing
    /// `Done`/`Error` event.
    async fn stream(&self, messages: &[ChatMessage], sink: &dyn ChatSink)
        -> Result<String, String>;
}

/// Resolve a wire-format config into a concrete provider impl. Pure
/// (no IO) — the `dyn ChatProvider` it returns owns the values from
/// the enum variant. MiniMax is a thin alias for the OpenAI streamer
/// with a MiniMax-flavoured default base URL.
pub fn build_provider(config: ProviderConfig) -> Box<dyn ChatProvider> {
    match config {
        ProviderConfig::Ollama { host, model } => Box::new(OllamaProvider { host, model }),
        ProviderConfig::Openai {
            api_key,
            model,
            base_url,
        } => Box::new(OpenAiProvider {
            api_key,
            model,
            base_url,
        }),
        ProviderConfig::Anthropic { api_key, model } => {
            Box::new(AnthropicProvider { api_key, model })
        }
        ProviderConfig::Gemini { api_key, model } => Box::new(GeminiProvider { api_key, model }),
        ProviderConfig::Minimax {
            api_key,
            model,
            base_url,
        } => {
            // MiniMax exposes an OpenAI-compatible chat-completions
            // endpoint; reuse the OpenAI streamer with the canonical
            // MiniMax host as the default base URL.
            let base = base_url.unwrap_or_else(|| "https://api.minimax.io".to_string());
            Box::new(OpenAiProvider {
                api_key,
                model,
                base_url: Some(base),
            })
        }
    }
}

/// Single entry point both `chat_send` (Tauri IPC) and the loopback
/// HTTP SSE bridge call. Resolves the provider, runs the stream, and
/// emits the trailing `Done`/`Error` event so every provider gets the
/// same finalisation contract without each impl duplicating it.
pub async fn stream_chat(
    config: ProviderConfig,
    messages: Vec<ChatMessage>,
    sink: &dyn ChatSink,
) -> Result<String, String> {
    let provider = build_provider(config);
    let result = provider.stream(&messages, sink).await;
    match &result {
        Ok(full) => sink.emit(ChatEvent::Done {
            content: full.clone(),
        }),
        Err(e) => sink.emit(ChatEvent::Error { message: e.clone() }),
    }
    result
}

// ── Shared HTTP client ─────────────────────────────────────────────────

/// Process-wide reqwest client.
///
/// `reqwest::Client` is designed to be cloned and reused — under the
/// hood it owns a connection pool, DNS cache, and TLS session cache,
/// all of which get rebuilt every time `Client::new()` is called. The
/// streaming hot path used to allocate a fresh client per chat
/// message; that's now a cheap `Arc` clone instead.
fn http_client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .user_agent("Tokori/0.1")
                .build()
                .expect("reqwest client builder cannot fail with default config")
        })
        .clone()
}

// ── Ollama ─────────────────────────────────────────────────────────────

pub struct OllamaProvider {
    pub host: String,
    pub model: String,
}

#[async_trait]
impl ChatProvider for OllamaProvider {
    fn id(&self) -> &'static str {
        "ollama"
    }

    async fn stream(
        &self,
        messages: &[ChatMessage],
        sink: &dyn ChatSink,
    ) -> Result<String, String> {
        stream_ollama(&self.host, &self.model, messages, sink).await
    }
}

#[derive(Serialize)]
struct OllamaChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
    /// Ask Ollama to expose the model's reasoning trace on the
    /// `message.thinking` field. Recent Ollama versions (≥ 0.5)
    /// REJECT the request with a 400 if the model doesn't have a
    /// `thinking` capability — qwen2.5, llama3.x, gemma3, etc. — so
    /// we only set this when `/api/show` reports the capability.
    /// Older claim that "non-thinking models silently ignore it" no
    /// longer holds. None when the field should be omitted entirely.
    #[serde(skip_serializing_if = "Option::is_none")]
    think: Option<bool>,
    options: OllamaOptions,
    /// Pin the model in (V)RAM for this duration after the request.
    /// Without it, Ollama's 5-minute idle eviction makes the next
    /// chat after a short pause pay the cold-load cost again — which
    /// is the "why is the second message slow too?" complaint we kept
    /// hearing. Mirrors the warm-up in `provider-context.tsx`.
    keep_alive: &'static str,
}

/// Per-(host, model) cache of "does this model support a thinking
/// trace?" Populated lazily on first chat against a (host, model)
/// tuple via `/api/show`. Capabilities don't change without a model
/// pull, so the entry sticks for the app's lifetime — restarting the
/// app re-probes from scratch, which is fine.
static THINKING_CAPABILITY: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();

fn thinking_cache() -> &'static Mutex<HashMap<String, bool>> {
    THINKING_CAPABILITY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(host: &str, model: &str) -> String {
    format!("{}::{}", host.trim_end_matches('/'), model)
}

#[derive(Deserialize)]
struct OllamaShowResponse {
    /// Modern Ollama (>= 0.5) declares each loaded model's capabilities
    /// here — e.g. `["completion", "tools", "thinking"]`. Older
    /// daemons omit the field entirely; we treat that as "no thinking"
    /// and never set the flag.
    #[serde(default)]
    capabilities: Vec<String>,
}

/// Resolve whether a model supports the `think` flag, with one-time
/// `/api/show` probe per (host, model). Probe failures (older Ollama,
/// network blip, model not pulled) are cached as `false` so we don't
/// retry on every chat — the user can restart the app to re-probe if
/// they fix the underlying issue.
async fn ollama_supports_thinking(host: &str, model: &str) -> bool {
    let key = cache_key(host, model);
    if let Some(v) = thinking_cache().lock().unwrap().get(&key).copied() {
        return v;
    }
    let url = format!("{}/api/show", host.trim_end_matches('/'));
    let supports = match http_client()
        .post(&url)
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => match resp.json::<OllamaShowResponse>().await {
            Ok(body) => body.capabilities.iter().any(|c| c == "thinking"),
            Err(_) => false,
        },
        _ => false,
    };
    thinking_cache().lock().unwrap().insert(key, supports);
    supports
}

/// Per-request options Ollama merges into the model defaults. The
/// only one we tune is `num_ctx` — Ollama's stock default is 2048
/// tokens *regardless of what the model actually supports*, which
/// silently truncates PDF attachments and long system prompts.
///
/// We previously forced 16384 here, which fits modern small models on
/// paper but in practice pushes the KV cache 8× past Ollama's CLI
/// default. On consumer GPUs (8–16 GB VRAM) that often spilled layers
/// off-GPU and turned chat into a fan-roaring CPU crawl. 4096 is the
/// sweet spot for chat — comfortable headroom for a system prompt +
/// a half-dozen turns + RAG snippets, fits on the GPU for almost any
/// 7–13B model, and matches what `ollama run` users see when they say
/// "it just feels fast." Larger contexts (PDF ingest, full-doc reader
/// tutoring) can override per-request later if they need to.
#[derive(Serialize)]
struct OllamaOptions {
    num_ctx: u32,
}

const OLLAMA_DEFAULT_NUM_CTX: u32 = 4096;

/// How long Ollama should keep the model resident in (V)RAM after a
/// request finishes. Stock daemon evicts after 5 minutes idle, which
/// means the SECOND request after the warm-up still pays the load
/// cost if the user paused to read. "24h" effectively pins the model
/// for the working day. Same value the JS-side warm-up uses, so the
/// numbers stay in sync; if you flip one, flip both.
const OLLAMA_DEFAULT_KEEP_ALIVE: &str = "24h";

#[derive(Deserialize)]
struct OllamaChatResponseChunk {
    message: Option<OllamaMessage>,
    done: bool,
}

#[derive(Deserialize)]
struct OllamaMessage {
    #[allow(dead_code)]
    role: String,
    #[serde(default)]
    content: String,
    /// Present only when the model + `think: true` produced reasoning
    /// output. Streamed alongside `content` and finishes before the
    /// reply text starts arriving.
    #[serde(default)]
    thinking: String,
}

async fn stream_ollama(
    host: &str,
    model: &str,
    messages: &[ChatMessage],
    sink: &dyn ChatSink,
) -> Result<String, String> {
    let url = format!("{}/api/chat", host.trim_end_matches('/'));
    // Probe (and cache) whether this model exposes a thinking trace.
    // Only set the field when supported — sending `think: true` to a
    // non-thinking model now returns 400 in modern Ollama, killing
    // the chat before the first token.
    let think = if ollama_supports_thinking(host, model).await {
        Some(true)
    } else {
        None
    };
    let body = OllamaChatRequest {
        model,
        messages,
        stream: true,
        think,
        options: OllamaOptions {
            num_ctx: OLLAMA_DEFAULT_NUM_CTX,
        },
        keep_alive: OLLAMA_DEFAULT_KEEP_ALIVE,
    };
    let resp = http_client()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("ollama request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("ollama {status}: {text}"));
    }
    let mut full = String::new();
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    // Wrap the thinking trace in `<think>…</think>` as it arrives so
    // the JS side's `splitThinking` (which already handles partial
    // open blocks for the streaming bubble) renders the collapsible
    // reasoning panel without any extra plumbing. State machine:
    //   - On the first thinking delta: emit "<think>" + delta.
    //   - On subsequent thinking deltas: emit the raw delta.
    //   - When the first content delta arrives (or the stream ends)
    //     while we're still inside a think block: emit "</think>\n"
    //     so the JS parser closes the section before the reply.
    let mut think_open = false;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("ollama stream error: {e}"))?;
        let text = String::from_utf8_lossy(&bytes);
        buf.push_str(&text);
        while let Some(idx) = buf.find('\n') {
            let line = buf[..idx].trim().to_string();
            buf = buf[idx + 1..].to_string();
            if line.is_empty() {
                continue;
            }
            let parsed: OllamaChatResponseChunk = match serde_json::from_str(&line) {
                Ok(p) => p,
                Err(_) => continue,
            };
            if let Some(msg) = parsed.message {
                if !msg.thinking.is_empty() {
                    let mut delta = String::new();
                    if !think_open {
                        delta.push_str("<think>");
                        think_open = true;
                    }
                    delta.push_str(&msg.thinking);
                    sink.emit(ChatEvent::Token {
                        delta: delta.clone(),
                    });
                    full.push_str(&delta);
                }
                if !msg.content.is_empty() {
                    let mut delta = String::new();
                    if think_open {
                        delta.push_str("</think>\n");
                        think_open = false;
                    }
                    delta.push_str(&msg.content);
                    sink.emit(ChatEvent::Token {
                        delta: delta.clone(),
                    });
                    full.push_str(&delta);
                }
            }
            if parsed.done {
                if think_open {
                    sink.emit(ChatEvent::Token {
                        delta: "</think>".to_string(),
                    });
                    full.push_str("</think>");
                }
                return Ok(full);
            }
        }
    }
    if think_open {
        sink.emit(ChatEvent::Token {
            delta: "</think>".to_string(),
        });
        full.push_str("</think>");
    }
    Ok(full)
}

// ── OpenAI (and OpenAI-compatible: Groq, Together, vLLM, MiniMax) ──────

pub struct OpenAiProvider {
    pub api_key: String,
    pub model: String,
    pub base_url: Option<String>,
}

#[async_trait]
impl ChatProvider for OpenAiProvider {
    fn id(&self) -> &'static str {
        "openai"
    }

    async fn stream(
        &self,
        messages: &[ChatMessage],
        sink: &dyn ChatSink,
    ) -> Result<String, String> {
        stream_openai(
            &self.api_key,
            self.base_url.as_deref(),
            &self.model,
            messages,
            sink,
        )
        .await
    }
}

#[derive(Serialize)]
struct OpenAIChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
}

#[derive(Deserialize)]
struct OpenAIStreamChunk {
    choices: Vec<OpenAIChoiceDelta>,
}

#[derive(Deserialize)]
struct OpenAIChoiceDelta {
    delta: OpenAIDelta,
    /// "stop" / "length" / "tool_calls" / etc. Set on the *final* chunk
    /// when the upstream knows the reply is complete. We treat any
    /// non-null value as "we're done", which catches the MiniMax case
    /// where the server sometimes never sends `data: [DONE]` and would
    /// otherwise leave us waiting on a TCP socket forever.
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct OpenAIDelta {
    content: Option<String>,
}

async fn stream_openai(
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    messages: &[ChatMessage],
    sink: &dyn ChatSink,
) -> Result<String, String> {
    let base = base_url
        .unwrap_or("https://api.openai.com")
        .trim_end_matches('/');
    // Groq's OpenAI-compat base is `https://api.groq.com/openai/v1` —
    // already contains `/v1`. OpenAI itself uses `https://api.openai.com`
    // — no `/v1`. Detect whether the user's base already ends in `/v1`
    // (or any `/v<digits>`) and skip re-adding it; otherwise append the
    // canonical `/v1` prefix. Without this guard we produced
    // `…/openai/v1/v1/chat/completions` and Groq 404'd.
    let chat_path = if base.ends_with("/v1")
        || base.rsplit_once('/').is_some_and(|(_, last)| {
            last.starts_with('v') && last.len() > 1 && last[1..].chars().all(|c| c.is_ascii_digit())
        }) {
        "/chat/completions"
    } else {
        "/v1/chat/completions"
    };
    let url = format!("{base}{chat_path}");
    let body = OpenAIChatRequest {
        model,
        messages,
        stream: true,
    };
    let resp = http_client()
        .post(&url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("openai request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("openai {status}: {text}"));
    }
    let mut full = String::new();
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    // Idle timeout: real OpenAI / MiniMax / OpenRouter all stream tokens
    // within a few seconds at most. If the socket goes silent for 60s
    // we treat it as a stall and bail rather than hang forever — this
    // is what was happening on MiniMax when its server skipped the
    // trailing `data: [DONE]` sentinel.
    const IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
    loop {
        let next = tokio::time::timeout(IDLE_TIMEOUT, stream.next()).await;
        let chunk = match next {
            Ok(Some(c)) => c,
            // Stream closed cleanly without a [DONE] / finish_reason. Some
            // upstreams do this; treat what we already collected as the
            // final reply rather than erroring out.
            Ok(None) => return Ok(full),
            Err(_) => {
                return Err(format!(
                    "openai stream idle for {}s — provider may have stalled (MiniMax sometimes drops the trailing [DONE]). Partial reply: {} chars.",
                    IDLE_TIMEOUT.as_secs(),
                    full.chars().count(),
                ));
            }
        };
        let bytes = chunk.map_err(|e| format!("openai stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(idx) = buf.find("\n\n") {
            let event = buf[..idx].to_string();
            buf = buf[idx + 2..].to_string();
            for line in event.lines() {
                let line = line.trim();
                let Some(payload) = line.strip_prefix("data:") else {
                    continue;
                };
                let payload = payload.trim();
                if payload == "[DONE]" {
                    return Ok(full);
                }
                let parsed: OpenAIStreamChunk = match serde_json::from_str(payload) {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                if let Some(choice) = parsed.choices.into_iter().next() {
                    if let Some(text) = choice.delta.content {
                        if !text.is_empty() {
                            sink.emit(ChatEvent::Token {
                                delta: text.clone(),
                            });
                            full.push_str(&text);
                        }
                    }
                    // Canonical OpenAI-compatible "we're done" signal.
                    // MiniMax sets `finish_reason: "stop"` on the last
                    // chunk even when it forgets to send [DONE]. Treat
                    // any non-null value as the end of the stream.
                    if choice.finish_reason.is_some() {
                        return Ok(full);
                    }
                }
            }
        }
    }
}

// ── Anthropic ──────────────────────────────────────────────────────────

pub struct AnthropicProvider {
    pub api_key: String,
    pub model: String,
}

#[async_trait]
impl ChatProvider for AnthropicProvider {
    fn id(&self) -> &'static str {
        "anthropic"
    }

    async fn stream(
        &self,
        messages: &[ChatMessage],
        sink: &dyn ChatSink,
    ) -> Result<String, String> {
        stream_anthropic(&self.api_key, &self.model, messages, sink).await
    }
}

#[derive(Serialize)]
struct AnthropicRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    system: Option<String>,
    messages: Vec<AnthropicMessage<'a>>,
    stream: bool,
}

#[derive(Serialize)]
struct AnthropicMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AnthropicEvent {
    ContentBlockDelta {
        delta: AnthropicDelta,
    },
    MessageStop,
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AnthropicDelta {
    TextDelta {
        text: String,
    },
    #[serde(other)]
    Other,
}

async fn stream_anthropic(
    api_key: &str,
    model: &str,
    messages: &[ChatMessage],
    sink: &dyn ChatSink,
) -> Result<String, String> {
    // Anthropic separates `system` from `messages`.
    let mut system: Option<String> = None;
    let mut chat: Vec<AnthropicMessage> = Vec::new();
    for m in messages {
        if m.role == "system" {
            system = Some(m.content.clone());
        } else {
            chat.push(AnthropicMessage {
                role: if m.role == "assistant" {
                    "assistant"
                } else {
                    "user"
                },
                content: &m.content,
            });
        }
    }
    let body = AnthropicRequest {
        model,
        max_tokens: 1024,
        system,
        messages: chat,
        stream: true,
    };
    let resp = http_client()
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("anthropic request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("anthropic {status}: {text}"));
    }
    let mut full = String::new();
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("anthropic stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(idx) = buf.find("\n\n") {
            let event = buf[..idx].to_string();
            buf = buf[idx + 2..].to_string();
            for line in event.lines() {
                let line = line.trim();
                let Some(payload) = line.strip_prefix("data:") else {
                    continue;
                };
                let payload = payload.trim();
                let parsed: AnthropicEvent = match serde_json::from_str(payload) {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                match parsed {
                    AnthropicEvent::ContentBlockDelta { delta } => {
                        if let AnthropicDelta::TextDelta { text } = delta {
                            if !text.is_empty() {
                                sink.emit(ChatEvent::Token {
                                    delta: text.clone(),
                                });
                                full.push_str(&text);
                            }
                        }
                    }
                    AnthropicEvent::MessageStop => return Ok(full),
                    AnthropicEvent::Other => {}
                }
            }
        }
    }
    Ok(full)
}

// ── Gemini ─────────────────────────────────────────────────────────────

pub struct GeminiProvider {
    pub api_key: String,
    pub model: String,
}

#[async_trait]
impl ChatProvider for GeminiProvider {
    fn id(&self) -> &'static str {
        "gemini"
    }

    async fn stream(
        &self,
        messages: &[ChatMessage],
        sink: &dyn ChatSink,
    ) -> Result<String, String> {
        stream_gemini(&self.api_key, &self.model, messages, sink).await
    }
}

#[derive(Serialize)]
struct GeminiRequest<'a> {
    contents: Vec<GeminiContent<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system_instruction: Option<GeminiContent<'a>>,
}

#[derive(Serialize)]
struct GeminiContent<'a> {
    role: &'a str,
    parts: Vec<GeminiPart<'a>>,
}

#[derive(Serialize)]
struct GeminiPart<'a> {
    text: &'a str,
}

#[derive(Deserialize)]
struct GeminiStreamChunk {
    candidates: Option<Vec<GeminiCandidate>>,
}

#[derive(Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiCandidateContent>,
}

#[derive(Deserialize)]
struct GeminiCandidateContent {
    parts: Option<Vec<GeminiPartIn>>,
}

#[derive(Deserialize)]
struct GeminiPartIn {
    text: Option<String>,
}

async fn stream_gemini(
    api_key: &str,
    model: &str,
    messages: &[ChatMessage],
    sink: &dyn ChatSink,
) -> Result<String, String> {
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse&key={api_key}"
    );

    let mut system_text: Option<String> = None;
    let mut contents: Vec<GeminiContent> = Vec::new();
    for m in messages {
        if m.role == "system" {
            system_text = Some(m.content.clone());
        } else {
            contents.push(GeminiContent {
                role: if m.role == "assistant" {
                    "model"
                } else {
                    "user"
                },
                parts: vec![GeminiPart { text: &m.content }],
            });
        }
    }
    let system_instruction = system_text.as_deref().map(|t| GeminiContent {
        role: "system",
        parts: vec![GeminiPart { text: t }],
    });

    let body = GeminiRequest {
        contents,
        system_instruction,
    };
    let resp = http_client()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("gemini request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("gemini {status}: {text}"));
    }

    let mut full = String::new();
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("gemini stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(idx) = buf.find("\n\n") {
            let event = buf[..idx].to_string();
            buf = buf[idx + 2..].to_string();
            for line in event.lines() {
                let line = line.trim();
                let Some(payload) = line.strip_prefix("data:") else {
                    continue;
                };
                let payload = payload.trim();
                if payload.is_empty() {
                    continue;
                }
                let parsed: GeminiStreamChunk = match serde_json::from_str(payload) {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                if let Some(candidates) = parsed.candidates {
                    for c in candidates {
                        let Some(content) = c.content else { continue };
                        let Some(parts) = content.parts else { continue };
                        for p in parts {
                            if let Some(text) = p.text {
                                if !text.is_empty() {
                                    sink.emit(ChatEvent::Token {
                                        delta: text.clone(),
                                    });
                                    full.push_str(&text);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(full)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `build_provider` is pure plumbing — no IO — so we can assert
    /// the wire-format enum maps to the right concrete type without
    /// network access. Catches regressions when a new variant is
    /// added but the factory match isn't updated (would otherwise
    /// fail to compile, but the id check guards against silent
    /// aliasing too — e.g. routing Anthropic through OpenAi).
    #[test]
    fn build_provider_routes_each_variant_to_the_right_id() {
        let cases: Vec<(ProviderConfig, &str)> = vec![
            (
                ProviderConfig::Ollama {
                    host: "http://localhost:11434".into(),
                    model: "llama3".into(),
                },
                "ollama",
            ),
            (
                ProviderConfig::Openai {
                    api_key: "sk-test".into(),
                    model: "gpt-4o".into(),
                    base_url: None,
                },
                "openai",
            ),
            (
                ProviderConfig::Anthropic {
                    api_key: "ant-test".into(),
                    model: "claude-3-5-sonnet".into(),
                },
                "anthropic",
            ),
            (
                ProviderConfig::Gemini {
                    api_key: "gem-test".into(),
                    model: "gemini-1.5-pro".into(),
                },
                "gemini",
            ),
            // MiniMax is intentionally routed through the OpenAI
            // streamer — same wire format, different default base.
            // The id reflects the streamer, not the config variant.
            (
                ProviderConfig::Minimax {
                    api_key: "mm-test".into(),
                    model: "MiniMax-Text-01".into(),
                    base_url: None,
                },
                "openai",
            ),
        ];
        for (cfg, expected_id) in cases {
            let provider = build_provider(cfg);
            assert_eq!(provider.id(), expected_id);
        }
    }
}
