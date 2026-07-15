//! Local HTTP API server.
//!
//! Bound to 127.0.0.1:53210 (loopback only). Bearer-token auth — the token is
//! generated on first start and stored at `~/.tokori/api-token` (mode 0600 on
//! Unix). Routes are versioned under `/v1/`. List endpoints return
//! `{ data: [...], next_cursor?: string }`; errors share
//! `{ error: { code, message, request_id } }`.

use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    extract::{DefaultBodyLimit, Query, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, patch, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use futures_util::stream::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use std::convert::Infallible;
use tauri::{AppHandle, Emitter};
use tokio::{net::TcpListener, sync::oneshot};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::commands::tokenize_zh;
use crate::media_url::canonical_media_key;
use crate::providers::{stream_chat, ChatEvent, ChatMessage, ProviderConfig};

/// Default loopback bind address. Hard-coded — the API is local-only by
/// design. Users who want a different port can recompile.
pub const DEFAULT_BIND: &str = "127.0.0.1:53210";

#[derive(Clone)]
pub struct ApiServer {
    /// Set when the server is running; consumed by `stop()` to signal shutdown.
    shutdown_tx: Arc<tokio::sync::Mutex<Option<oneshot::Sender<()>>>>,
    /// Shared with `AppState` so the `pair_resolve` Tauri command (which
    /// lives in lib.rs and only has access to `ApiServerState`) can find
    /// the pending oneshot sender and complete the pairing request.
    pair_broker: PairBroker,
    /// Pending OAuth `state` values minted before the user is bounced to
    /// the browser. The /oauth/finish handler consumes them on completion
    /// so a forged token POST without a matching state is rejected. See
    /// `OAuthStateBroker` for the storage semantics.
    oauth_broker: OAuthStateBroker,
}

impl ApiServer {
    pub fn new() -> Self {
        Self {
            shutdown_tx: Arc::new(tokio::sync::Mutex::new(None)),
            pair_broker: PairBroker::default(),
            oauth_broker: OAuthStateBroker::default(),
        }
    }

    /// Resolve a pending pair request. Returns true when there was a
    /// matching request id and it was completed; false when the id is
    /// unknown (already resolved or timed out).
    pub fn resolve_pair(&self, id: &str, approved: bool) -> bool {
        self.pair_broker.resolve(id, approved)
    }

    /// Register a freshly-minted OAuth `state` value. Called from the
    /// `oauth_begin` Tauri command right before the frontend opens the
    /// browser. The state is one-shot: `/oauth/finish` removes it on
    /// validation, and the broker discards anything older than 5 minutes
    /// so an abandoned sign-in attempt can't accumulate forever.
    pub fn register_oauth_state(&self, state: String) {
        self.oauth_broker.register(state);
    }

    /// Spawn the server in the background. Idempotent — calling start while
    /// running is a no-op. Returns the bind address and the bearer token so
    /// the caller can show them in the UI.
    pub async fn start(&self, db_path: &Path, app: AppHandle) -> Result<StartedInfo, ApiError> {
        let mut guard = self.shutdown_tx.lock().await;
        if guard.is_some() {
            return Err(ApiError::AlreadyRunning);
        }
        let token = ensure_token()?;
        let state = AppState::open(
            db_path,
            token.clone(),
            app,
            self.pair_broker.clone(),
            self.oauth_broker.clone(),
        )
        .await?;
        let addr: SocketAddr = DEFAULT_BIND.parse().expect("bind address parses");
        let listener = TcpListener::bind(addr)
            .await
            .map_err(|e| ApiError::Bind(e.to_string()))?;
        let local_addr = listener
            .local_addr()
            .map_err(|e| ApiError::Bind(e.to_string()))?;

        let app = build_router(state);
        let (tx, rx) = oneshot::channel();
        *guard = Some(tx);
        drop(guard);

        tokio::spawn(async move {
            let server = axum::serve(listener, app).with_graceful_shutdown(async {
                let _ = rx.await;
            });
            if let Err(e) = server.await {
                log::error!("api server error: {e}");
            }
        });

        Ok(StartedInfo {
            addr: local_addr.to_string(),
            token,
        })
    }

    pub async fn stop(&self) {
        if let Some(tx) = self.shutdown_tx.lock().await.take() {
            let _ = tx.send(());
        }
    }

    pub async fn is_running(&self) -> bool {
        self.shutdown_tx.lock().await.is_some()
    }
}

#[derive(Serialize)]
pub struct StartedInfo {
    pub addr: String,
    pub token: String,
}

#[derive(thiserror::Error, Debug)]
pub enum ApiError {
    #[error("api server already running")]
    AlreadyRunning,
    #[error("bind error: {0}")]
    Bind(String),
    #[error("database error: {0}")]
    Db(String),
    #[error("io error: {0}")]
    Io(String),
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        ApiError::Db(e.to_string())
    }
}

impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        ApiError::Io(e.to_string())
    }
}

#[derive(Clone)]
struct AppState {
    pool: SqlitePool,
    token: String,
    app: AppHandle,
    pair_broker: PairBroker,
    oauth_broker: OAuthStateBroker,
}

impl AppState {
    async fn open(
        db_path: &Path,
        token: String,
        app: AppHandle,
        pair_broker: PairBroker,
        oauth_broker: OAuthStateBroker,
    ) -> Result<Self, ApiError> {
        // Same on-disk file the Tauri SQL plugin manages. SQLite handles multi-
        // process readers cleanly; concurrent writes will block briefly via the
        // built-in lock — fine for our scale.
        let url = format!("sqlite://{}?mode=rwc", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect(&url)
            .await?;
        Ok(Self {
            pool,
            token,
            app,
            pair_broker,
            oauth_broker,
        })
    }
}

/// In-memory ledger of pending pair requests. The browser extension hits
/// `POST /v1/pair/request`, which inserts a oneshot sender here and emits
/// a Tauri event so the desktop UI can render an approval modal. When the
/// user clicks approve/deny, the frontend invokes `pair_resolve` (a
/// `#[tauri::command]` defined in `lib.rs`) which finds this map by id
/// and sends the outcome. Requests not resolved within 60s time out and
/// the sender is dropped.
#[derive(Default, Clone)]
pub struct PairBroker {
    inner: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
}

impl PairBroker {
    fn register(&self, id: String, tx: oneshot::Sender<bool>) {
        if let Ok(mut g) = self.inner.lock() {
            g.insert(id, tx);
        }
    }
    fn resolve(&self, id: &str, approved: bool) -> bool {
        let tx = self.inner.lock().ok().and_then(|mut g| g.remove(id));
        if let Some(tx) = tx {
            let _ = tx.send(approved);
            true
        } else {
            false
        }
    }
    fn discard(&self, id: &str) {
        if let Ok(mut g) = self.inner.lock() {
            g.remove(id);
        }
    }
}

/// In-memory pending-state map for OAuth sign-ins. The frontend calls
/// the `oauth_begin` Tauri command which `register`s a fresh state,
/// then opens the browser with that state in the redirect URL. When
/// the cloud bounces the user back to `/oauth/callback`, the bouncer
/// page POSTs the parsed fragment + state to `/oauth/finish`, which
/// `consume`s the state and emits the Tauri event.
///
/// One-shot: a state can only be consumed once. Stale entries older
/// than `OAUTH_STATE_TTL` are pruned on every `register` / `consume`
/// so an abandoned sign-in attempt doesn't pin memory.
const OAUTH_STATE_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Default, Clone)]
pub struct OAuthStateBroker {
    inner: Arc<Mutex<HashMap<String, std::time::Instant>>>,
}

impl OAuthStateBroker {
    fn register(&self, state: String) {
        if let Ok(mut g) = self.inner.lock() {
            Self::prune(&mut g);
            g.insert(state, std::time::Instant::now());
        }
    }
    /// Remove the entry if present + still within TTL. Returns true on
    /// match (= "this token POST came from a sign-in we started"),
    /// false otherwise.
    fn consume(&self, state: &str) -> bool {
        let mut g = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        Self::prune(&mut g);
        match g.remove(state) {
            Some(when) => when.elapsed() <= OAUTH_STATE_TTL,
            None => false,
        }
    }
    fn prune(g: &mut HashMap<String, std::time::Instant>) {
        let now = std::time::Instant::now();
        g.retain(|_, when| now.duration_since(*when) <= OAUTH_STATE_TTL);
    }
}

fn build_router(state: AppState) -> Router {
    // Permissive CORS for loopback origins so browser-based local tools can
    // hit the API. The bearer token is what actually keeps us safe.
    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        // Allow loopback web origins, app.tokori.ai, and browser
        // extensions. The Companion extension's background worker
        // makes fetches with `Origin: chrome-extension://<id>` — those
        // were silently being CORS-rejected before, which surfaced in
        // the popup as "Failed to fetch / open settings".
        .allow_origin(AllowOrigin::predicate(|origin, _req| {
            let s = origin.to_str().unwrap_or("");
            s.starts_with("http://localhost")
                || s.starts_with("http://127.0.0.1")
                || s.starts_with("https://localhost")
                || s.starts_with("https://tokori.ai")
                || s.starts_with("chrome-extension://")
                || s.starts_with("moz-extension://")
                || s.starts_with("safari-web-extension://")
        }));

    let v1 = Router::new()
        .route("/health", get(health))
        .route("/pair/request", post(pair_request))
        .route("/remote/info", get(remote_info))
        .route("/chat/stream", post(chat_stream))
        .route("/ai/explain", post(ai_explain))
        .route("/workspaces", get(list_workspaces))
        .route("/workspaces/:id/vocab", get(list_vocab).post(create_vocab))
        .route("/workspaces/:id/sessions", post(log_session))
        .route("/workspaces/:id/sessions/start", post(start_live_session))
        .route("/sessions/:id/heartbeat", post(heartbeat_session))
        .route("/sessions/:id/finish", post(finish_session))
        .route("/workspaces/:id/media", get(list_media).post(create_media))
        .route("/media/:id", patch(update_media))
        .route("/media/lookup", get(lookup_media))
        .route("/media/progress", post(report_media_progress))
        .route("/ocr", post(ocr_frame))
        .route("/vocab/status", post(set_vocab_status))
        .route("/translate", post(translate_text))
        .route(
            "/workspaces/:id/collections",
            get(list_collections).post(create_collection),
        )
        .route(
            "/workspaces/:id/collections/import",
            post(import_collection),
        )
        .route(
            "/collections/:id/words",
            get(list_collection_words).post(add_words_to_collection),
        )
        .route("/dict/search", get(search_dict))
        .route("/tokenize", post(tokenize))
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(state.clone(), auth_layer))
        .layer(cors.clone())
        // Axum's default request-body cap is 2 MB, which a mined card
        // with a recorded A/V clip (base64 audio_data) blows straight
        // past — the extension's clip saves were 413ing before the
        // handler ever ran. Loopback-only + bearer auth, so a generous
        // cap is safe.
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024));

    // OAuth loopback routes — public (no bearer auth) because the
    // browser hitting these has no API token. Security comes from the
    // state-binding in `oauth_finish` (a forged POST without a state
    // we minted gets dropped) and the loopback-only bind address.
    let oauth = Router::new()
        .route("/callback", get(oauth_callback_page))
        .route("/finish", post(oauth_finish))
        .route("/logo.png", get(oauth_logo))
        .with_state(state)
        .layer(cors);

    Router::new().nest("/v1", v1).nest("/oauth", oauth)
}

async fn auth_layer(
    State(state): State<AppState>,
    headers: HeaderMap,
    req: axum::http::Request<axum::body::Body>,
    next: Next,
) -> Response {
    // /v1/health is public so external monitors can probe without a token.
    // /v1/pair/request is public so a fresh extension/CLI client can ask
    // the user to approve a pairing — that's the point of pairing.
    let path = req.uri().path();
    if path.ends_with("/health") || path.ends_with("/pair/request") {
        return next.run(req).await;
    }

    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.trim().to_string());

    match presented {
        Some(t) if constant_time_eq(t.as_bytes(), state.token.as_bytes()) => next.run(req).await,
        Some(_) => err_response(
            StatusCode::UNAUTHORIZED,
            "auth.invalid_token",
            "Invalid bearer token.",
        ),
        None => err_response(
            StatusCode::UNAUTHORIZED,
            "auth.missing_token",
            "Missing Authorization: Bearer <token> header.",
        ),
    }
}

/// Constant-time byte comparison so token validation isn't timing-attackable.
/// Plain `==` would early-exit on the first mismatching byte.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[derive(Serialize)]
struct ErrorBody {
    error: ErrorEnvelope,
}
#[derive(Serialize)]
struct ErrorEnvelope {
    code: &'static str,
    message: String,
    request_id: String,
}

fn err_response(status: StatusCode, code: &'static str, msg: &str) -> Response {
    let request_id = new_request_id();
    let body = Json(ErrorBody {
        error: ErrorEnvelope {
            code,
            message: msg.to_string(),
            request_id: request_id.clone(),
        },
    });
    let mut resp = (status, body).into_response();
    if let Ok(v) = HeaderValue::from_str(&request_id) {
        resp.headers_mut().insert("X-Tokori-Request-Id", v);
    }
    resp
}

fn new_request_id() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut buf);
    // 16-char hex; readable in logs.
    let mut s = String::with_capacity(16);
    for b in buf {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

async fn health() -> Json<serde_json::Value> {
    Json(
        serde_json::json!({ "status": "ok", "service": "tokori", "version": env!("CARGO_PKG_VERSION") }),
    )
}

#[derive(Serialize, sqlx::FromRow)]
struct Workspace {
    id: i64,
    target_lang: String,
    native_lang: String,
    name: String,
    goal_level: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize)]
struct Page<T> {
    data: Vec<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
}

async fn list_workspaces(State(state): State<AppState>) -> Result<Json<Page<Workspace>>, Response> {
    // The live schema (lib.rs migrations) has no goal_level / updated_at
    // columns yet — alias them so the wire shape stays stable for clients
    // that already deserialize these fields.
    let rows = sqlx::query_as::<_, Workspace>(
        "SELECT id, target_lang, native_lang, name,
            NULL AS goal_level, created_at, created_at AS updated_at
     FROM workspaces
     ORDER BY created_at ASC",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| {
        log::error!("list_workspaces: {e}");
        err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal.unexpected",
            "Failed to list workspaces.",
        )
    })?;

    Ok(Json(Page {
        data: rows,
        next_cursor: None,
    }))
}

#[derive(Deserialize)]
struct VocabQuery {
    status: Option<String>,
    q: Option<String>,
    limit: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
struct VocabEntry {
    id: i64,
    workspace_id: i64,
    word: String,
    reading: Option<String>,
    gloss: Option<String>,
    status: String,
    added_at: i64,
}

async fn list_vocab(
    State(state): State<AppState>,
    axum::extract::Path(ws_id): axum::extract::Path<i64>,
    Query(q): Query<VocabQuery>,
) -> Result<Json<Page<VocabEntry>>, Response> {
    // Cap limits server-side. A buggy client asking for limit=1_000_000 should
    // not cause us to allocate a giant Vec.
    let limit = q.limit.unwrap_or(50).clamp(1, 500);

    // Build a small dynamic WHERE — kept inline (and parameterised) rather than
    // pulled into a query builder. sqlx requires constant SQL strings for the
    // `query_as!` macro, so we use the runtime variant.
    // NOTE: the on-disk column is `created_at`; the wire field stays
    // `added_at` (aliased) because the Chrome extension + MCP clients
    // already consume that name. Same schema-drift class as the old
    // `list_workspaces` goal_level bug — keep SELECTs aligned with the
    // real vocab_entries schema in lib.rs.
    let mut sql = String::from(
        "SELECT id, workspace_id, word, reading, gloss, status, created_at AS added_at
     FROM vocab_entries
     WHERE workspace_id = ?",
    );
    if q.status.is_some() {
        sql.push_str(" AND status = ?");
    }
    if q.q.is_some() {
        sql.push_str(" AND (word LIKE ? OR gloss LIKE ? OR reading LIKE ?)");
    }
    sql.push_str(" ORDER BY created_at DESC LIMIT ?");

    let mut query = sqlx::query_as::<_, VocabEntry>(&sql).bind(ws_id);
    if let Some(s) = &q.status {
        query = query.bind(s);
    }
    if let Some(needle) = &q.q {
        let like = format!("%{}%", needle);
        query = query.bind(like.clone()).bind(like.clone()).bind(like);
    }
    query = query.bind(limit);

    let rows = query.fetch_all(&state.pool).await.map_err(|e| {
        log::error!("list_vocab: {e}");
        err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal.unexpected",
            "Failed to list vocabulary.",
        )
    })?;
    Ok(Json(Page {
        data: rows,
        next_cursor: None,
    }))
}

#[derive(Deserialize)]
struct DictQuery {
    lang: String,
    q: String,
    limit: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
struct DictEntry {
    word: String,
    alt_word: Option<String>,
    reading: Option<String>,
    gloss: String,
}

async fn search_dict(
    State(state): State<AppState>,
    Query(q): Query<DictQuery>,
) -> Result<Json<Page<DictEntry>>, Response> {
    if q.q.trim().is_empty() {
        return Ok(Json(Page {
            data: vec![],
            next_cursor: None,
        }));
    }
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let like = format!("%{}%", q.q);
    // Candidate source for the substring tier below. Queries of ≥3
    // codepoints probe the trigram FTS shadow table (migration V31);
    // shorter queries fall back to a plain scan, which trigrams can't
    // index. Both are expensive on big dictionaries — the German
    // Wiktionary alone is ~1M rows, and the FTS index spans *all*
    // installed dictionaries, so even an indexed probe verifies
    // candidates from every language (measured 1–3s cold for common
    // substrings).
    let substring_candidates = if q.q.chars().count() >= 3 {
        "SELECT rowid FROM dict_fts WHERE word LIKE ?4
         UNION SELECT rowid FROM dict_fts WHERE alt_word LIKE ?4
         UNION SELECT rowid FROM dict_fts WHERE reading LIKE ?4
         UNION SELECT rowid FROM dict_fts WHERE gloss LIKE ?4"
    } else {
        "SELECT e2.id FROM dict_entries e2
         JOIN dictionaries d2 ON d2.id = e2.dict_id
         WHERE d2.lang = ?1
           AND (e2.word LIKE ?4 OR e2.alt_word LIKE ?4
                OR e2.reading LIKE ?4 OR e2.gloss LIKE ?4)"
    };
    // Tiered search with early exit: exact word match, then word-prefix
    // (both pure b-tree probes — the prefix tier is a range on the
    // (dict_id, LOWER(word)) expression index from V29), then the
    // substring tier. UNION ALL arms evaluate left to right and the
    // outer LIMIT short-circuits, so the expensive substring probe never
    // runs when the cheap tiers already fill the page — which is the
    // common case for search-as-you-type. Ordering matches the old
    // single query's CASE ranking: exact, prefix, substring, each by
    // word length. Later tiers exclude earlier tiers' rows in place of
    // a dedup b-tree.
    let sql = format!(
        "SELECT word, alt_word, reading, gloss FROM (
       SELECT e.word, e.alt_word, e.reading, e.gloss
       FROM dict_entries e JOIN dictionaries d ON d.id = e.dict_id
       WHERE d.lang = ?1 AND e.word = ?2
       LIMIT ?3
     )
     UNION ALL
     SELECT word, alt_word, reading, gloss FROM (
       SELECT e.word, e.alt_word, e.reading, e.gloss
       FROM dict_entries e JOIN dictionaries d ON d.id = e.dict_id
       WHERE d.lang = ?1
         AND LOWER(e.word) >= LOWER(?2)
         AND LOWER(e.word) < LOWER(?2) || CHAR(1114111)
         AND e.word <> ?2
       ORDER BY length(e.word) ASC
       LIMIT ?3
     )
     UNION ALL
     SELECT word, alt_word, reading, gloss FROM (
       SELECT e.word, e.alt_word, e.reading, e.gloss
       FROM dict_entries e JOIN dictionaries d ON d.id = e.dict_id
       WHERE d.lang = ?1
         AND e.id IN ({substring_candidates})
         AND NOT (LOWER(e.word) >= LOWER(?2)
                  AND LOWER(e.word) < LOWER(?2) || CHAR(1114111))
       ORDER BY length(e.word) ASC
       LIMIT ?3
     )
     LIMIT ?3"
    );
    let rows = sqlx::query_as::<_, DictEntry>(&sql)
        .bind(&q.lang)
        .bind(&q.q)
        .bind(limit)
        .bind(&like)
        .fetch_all(&state.pool)
        .await
        .map_err(|e| {
            log::error!("search_dict: {e}");
            err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal.unexpected",
                "Dictionary search failed.",
            )
        })?;

    Ok(Json(Page {
        data: rows,
        next_cursor: None,
    }))
}

// ── Tokenize ─────────────────────────────────────────────────────────
//
// Exposes the same jieba-backed segmenter the desktop frontend uses
// (`commands::tokenize_zh`) so the browser Companion extension can split
// captions into proper words instead of falling back to per-character
// chunks. Only zh today — other languages fall through to a tokens=words
// echo so the client can choose: use the response or apply its own
// Intl.Segmenter fallback.

#[derive(Deserialize)]
struct TokenizeRequest {
    lang: String,
    text: String,
}

#[derive(Serialize)]
struct TokenizeResponse {
    tokens: Vec<String>,
}

async fn tokenize(Json(req): Json<TokenizeRequest>) -> Json<TokenizeResponse> {
    let tokens: Vec<String> = match req.lang.as_str() {
        "zh" => tokenize_zh(req.text).into_iter().map(|t| t.text).collect(),
        _ => vec![req.text],
    };
    Json(TokenizeResponse { tokens })
}

// Collection + write endpoints used by the MCP server for automated
// scrape→import workflows.
#[derive(Serialize, sqlx::FromRow)]
struct Collection {
    id: i64,
    workspace_id: i64,
    name: String,
    description: Option<String>,
    is_default: i64,
    source: String,
    preset_id: Option<String>,
    parent_collection_id: Option<i64>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Deserialize)]
struct CreateCollectionBody {
    name: String,
    description: Option<String>,
    parent_collection_id: Option<i64>,
}

async fn list_collections(
    State(state): State<AppState>,
    axum::extract::Path(ws_id): axum::extract::Path<i64>,
) -> Result<Json<Page<Collection>>, Response> {
    let rows = sqlx::query_as::<_, Collection>(
        "SELECT id, workspace_id, name, description, is_default, source,
            preset_id, parent_collection_id, created_at, updated_at
     FROM collections
     WHERE workspace_id = ?
     ORDER BY updated_at DESC",
    )
    .bind(ws_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| {
        log::error!("list_collections: {e}");
        err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal.unexpected",
            "Failed to list collections.",
        )
    })?;
    Ok(Json(Page {
        data: rows,
        next_cursor: None,
    }))
}

async fn create_collection(
    State(state): State<AppState>,
    axum::extract::Path(ws_id): axum::extract::Path<i64>,
    Json(body): Json<CreateCollectionBody>,
) -> Result<(StatusCode, Json<Collection>), Response> {
    if body.name.trim().is_empty() {
        return Err(err_response(
            StatusCode::BAD_REQUEST,
            "validation.empty_name",
            "Collection name cannot be empty.",
        ));
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO collections (workspace_id, name, description, source, parent_collection_id)
     VALUES (?, ?, ?, 'user', ?)
     RETURNING id",
    )
    .bind(ws_id)
    .bind(body.name.trim())
    .bind(body.description.as_deref())
    .bind(body.parent_collection_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| {
        log::error!("create_collection: {e}");
        err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal.unexpected",
            "Failed to create collection.",
        )
    })?;

    let row = fetch_collection(&state.pool, id).await?;
    Ok((StatusCode::CREATED, Json(row)))
}

async fn fetch_collection(pool: &SqlitePool, id: i64) -> Result<Collection, Response> {
    sqlx::query_as::<_, Collection>(
        "SELECT id, workspace_id, name, description, is_default, source,
            preset_id, parent_collection_id, created_at, updated_at
     FROM collections WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .map_err(|e| {
        log::error!("fetch_collection({id}): {e}");
        err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal.unexpected",
            "Failed to fetch collection.",
        )
    })
}

#[derive(Deserialize)]
struct CreateVocabBody {
    word: String,
    reading: Option<String>,
    gloss: Option<String>,
    /// Optional: link the new (or matched) entry into this collection in the
    /// same call. Saves a round-trip for the common scrape-and-import pattern.
    collection_id: Option<i64>,
    /// Provenance — defaults to "api" so dashboard filters can distinguish
    /// MCP-imported words from chat-tagged or hand-typed ones.
    source: Option<String>,
    // ── Mining fields ───────────────────────────────────────────────
    // The Chrome extension's `CreateVocabInput` and the in-app composer
    // both produce these; without them the desktop drops the richest
    // half of a card on the way in. Optional — a minimal `{word}`
    // request still works.
    /// Card kind: "vocab" (default), "sentence", or "writing".
    kind: Option<String>,
    /// Cloze sentence with `{{c1::word}}` markers. Used by the
    /// sentence-mining study plugin and the composer's cloze field.
    front_extra: Option<String>,
    /// Free-form notes (mnemonics, translations, etymology) shown on
    /// the back of the card.
    card_notes: Option<String>,
    /// Card image. Accepts either a data URL (`data:image/png;base64,…`)
    /// or a bare base64 string — the handler keeps whatever's sent
    /// since the desktop's `vocab_entries.image_data` is a TEXT column
    /// that stores data URLs verbatim.
    image_data: Option<String>,
    /// Card audio. Base64-encoded raw bytes (no data URL). Decoded on
    /// arrival into the `vocab_entries.audio_data` BLOB column.
    audio_data: Option<String>,
    /// MIME type for the audio, e.g. "audio/mpeg" or "audio/wav".
    /// Defaulted to "audio/mpeg" when audio_data is present but mime
    /// is missing.
    audio_mime: Option<String>,
}

#[derive(Serialize)]
struct CreatedVocab {
    id: i64,
    workspace_id: i64,
    word: String,
    reading: Option<String>,
    gloss: Option<String>,
    /// True when the row already existed (UNIQUE(workspace_id, word) collision)
    /// and we returned the existing id rather than a fresh insert. Lets the
    /// client display "added 12 new, 3 already known" after a batch import.
    existed: bool,
}

async fn create_vocab(
    State(state): State<AppState>,
    axum::extract::Path(ws_id): axum::extract::Path<i64>,
    Json(body): Json<CreateVocabBody>,
) -> Result<(StatusCode, Json<CreatedVocab>), Response> {
    let word = body.word.trim();
    if word.is_empty() {
        return Err(err_response(
            StatusCode::BAD_REQUEST,
            "validation.empty_word",
            "Vocab word cannot be empty.",
        ));
    }
    let source = body.source.as_deref().unwrap_or("api");
    let result = upsert_vocab(
        &state.pool,
        ws_id,
        word,
        body.reading.as_deref(),
        body.gloss.as_deref(),
        source,
    )
    .await?;
    if let Some(cid) = body.collection_id {
        link_vocab_to_collection(&state.pool, cid, result.id).await?;
    }
    // Mining fields — apply after the upsert because the columns
    // they target (kind, front_extra, card_notes, image_data,
    // audio_data, audio_mime) are NOT touched by `upsert_vocab` and
    // need their own UPDATE pass. Each is independent — a request
    // with only `image_data` doesn't disturb the others. We treat
    // empty strings the same as a missing field so the Chrome
    // extension's serialised payload (which often sends "" for
    // unattached fields) doesn't wipe existing data.
    apply_vocab_mining_fields(&state.pool, result.id, &body).await?;
    let status = if result.existed {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(result)))
}

/// Persists the optional "mining" fields on the row identified by
/// `vocab_id`. Each non-empty field is patched in a single UPDATE;
/// callers that omit every field pay no DB cost. Audio data arrives
/// base64-encoded and is decoded into the BLOB column.
async fn apply_vocab_mining_fields(
    pool: &SqlitePool,
    vocab_id: i64,
    body: &CreateVocabBody,
) -> Result<(), Response> {
    fn non_empty(s: &Option<String>) -> Option<&str> {
        s.as_deref().map(str::trim).filter(|t| !t.is_empty())
    }

    let kind = non_empty(&body.kind);
    let front_extra = non_empty(&body.front_extra);
    let card_notes = non_empty(&body.card_notes);
    let image_data = non_empty(&body.image_data);
    let audio_data_b64 = non_empty(&body.audio_data);
    let audio_mime = non_empty(&body.audio_mime);

    // Fast path: nothing to patch.
    if kind.is_none()
        && front_extra.is_none()
        && card_notes.is_none()
        && image_data.is_none()
        && audio_data_b64.is_none()
    {
        return Ok(());
    }

    if let Some(k) = kind {
        // Whitelist the kind to match the desktop schema's CHECK
        // constraint. Anything outside the allowed set silently
        // downgrades to "vocab" rather than failing the whole call.
        let safe = match k {
            "vocab" | "sentence" | "writing" => k,
            _ => "vocab",
        };
        sqlx::query("UPDATE vocab_entries SET kind = ? WHERE id = ?")
            .bind(safe)
            .bind(vocab_id)
            .execute(pool)
            .await
            .map_err(|e| {
                log::error!("apply_vocab_mining_fields kind: {e}");
                err_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal.unexpected",
                    "Failed to patch vocab kind.",
                )
            })?;
    }

    if let Some(v) = front_extra {
        sqlx::query("UPDATE vocab_entries SET front_extra = ? WHERE id = ?")
            .bind(v)
            .bind(vocab_id)
            .execute(pool)
            .await
            .map_err(|e| {
                log::error!("apply_vocab_mining_fields front_extra: {e}");
                err_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal.unexpected",
                    "Failed to patch front_extra.",
                )
            })?;
    }

    if let Some(v) = card_notes {
        sqlx::query("UPDATE vocab_entries SET card_notes = ? WHERE id = ?")
            .bind(v)
            .bind(vocab_id)
            .execute(pool)
            .await
            .map_err(|e| {
                log::error!("apply_vocab_mining_fields card_notes: {e}");
                err_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal.unexpected",
                    "Failed to patch card_notes.",
                )
            })?;
    }

    if let Some(v) = image_data {
        sqlx::query("UPDATE vocab_entries SET image_data = ? WHERE id = ?")
            .bind(v)
            .bind(vocab_id)
            .execute(pool)
            .await
            .map_err(|e| {
                log::error!("apply_vocab_mining_fields image_data: {e}");
                err_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal.unexpected",
                    "Failed to patch image_data.",
                )
            })?;
    }

    if let Some(b64) = audio_data_b64 {
        // Strip a possible data-URL prefix the Chrome extension might
        // include. The desktop stores raw bytes in the BLOB column.
        let payload = b64
            .strip_prefix("data:audio/")
            .and_then(|rest| rest.split_once(",").map(|(_, body)| body))
            .unwrap_or(b64);
        let bytes = match BASE64_STANDARD.decode(payload) {
            Ok(b) => b,
            Err(e) => {
                log::warn!("apply_vocab_mining_fields audio_data decode: {e}");
                return Err(err_response(
                    StatusCode::BAD_REQUEST,
                    "validation.audio_data",
                    "audio_data is not valid base64.",
                ));
            }
        };
        let mime = audio_mime.unwrap_or("audio/mpeg");
        sqlx::query("UPDATE vocab_entries SET audio_data = ?, audio_mime = ? WHERE id = ?")
            .bind(bytes)
            .bind(mime)
            .bind(vocab_id)
            .execute(pool)
            .await
            .map_err(|e| {
                log::error!("apply_vocab_mining_fields audio_data: {e}");
                err_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal.unexpected",
                    "Failed to patch audio_data.",
                )
            })?;
    }

    Ok(())
}

#[derive(Deserialize)]
struct LogSessionBody {
    /// Session kind. Defaults to "immersion" — that's what the Companion
    /// extension logs for tracked video-watching time. Free-form so
    /// future clients can log e.g. "podcast" without a server release.
    kind: Option<String>,
    duration_secs: i64,
    /// Epoch seconds of the session END. Defaults to now. Mirrors the
    /// frontend's `logSession`: started_at is back-derived so the
    /// session lands in the right heatmap / streak day.
    when: Option<i64>,
    notes: Option<String>,
}

#[derive(Serialize)]
struct LoggedSession {
    id: i64,
    workspace_id: i64,
    kind: String,
    started_at: i64,
    ended_at: i64,
    duration_secs: i64,
}

/// One-shot logger for a completed study session (`POST
/// /v1/workspaces/:id/sessions`). The Companion extension pushes its
/// tracked immersion time here so the dashboard's immersion KPIs,
/// heatmap, and streak include time spent outside the app. Non-null
/// `notes` (defaulted to "") marks the row as an external/manual log —
/// same convention as the in-app activity logger.
async fn log_session(
    State(state): State<AppState>,
    axum::extract::Path(ws_id): axum::extract::Path<i64>,
    Json(body): Json<LogSessionBody>,
) -> Result<(StatusCode, Json<LoggedSession>), Response> {
    if body.duration_secs <= 0 {
        return Err(err_response(
            StatusCode::BAD_REQUEST,
            "validation.duration_secs",
            "duration_secs must be a positive number of seconds.",
        ));
    }
    let now = chrono::Utc::now().timestamp();
    // Clamp a bogus future end-time back to now, and the duration to a
    // day — a buggy client must not be able to mint year-long sessions.
    let ended_at = body.when.unwrap_or(now).min(now);
    let duration = body.duration_secs.min(24 * 3600);
    let started_at = (ended_at - duration).max(0);
    let kind = body
        .kind
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty());
    let kind = kind.unwrap_or("immersion");
    let notes = body.notes.unwrap_or_default();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO study_sessions
           (workspace_id, kind, started_at, ended_at, duration_secs, notes)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING id",
    )
    .bind(ws_id)
    .bind(kind)
    .bind(started_at)
    .bind(ended_at)
    .bind(duration)
    .bind(notes)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| {
        log::error!("log_session insert: {e}");
        err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal.unexpected",
            "Failed to record the session.",
        )
    })?;
    Ok((
        StatusCode::CREATED,
        Json(LoggedSession {
            id,
            workspace_id: ws_id,
            kind: kind.to_string(),
            started_at,
            ended_at,
            duration_secs: duration,
        }),
    ))
}

// ── Live sessions ───────────────────────────────────────────────────
//
// The Companion extension's immersion timer drives these so a tracked
// video session runs as a real `study_sessions` row while the user
// watches — the same tracking the in-app timer produces, hence the
// dashboard / heatmap / streak / Activities all pick it up natively.
//
// Crash-safety invariant: the row is ALWAYS closed as of its last
// write (`ended_at` set on start and refreshed by every heartbeat).
// A client that dies mid-session simply leaves the last-heartbeat
// state behind, and `finalizeStaleSessions` (which only repairs
// ended_at-IS-NULL rows) can never clobber or inflate it.

#[derive(Deserialize)]
struct StartSessionBody {
    /// Session kind. Defaults to "video" — the Companion's tracked
    /// YouTube time. Free-form for future clients.
    kind: Option<String>,
}

#[derive(Serialize)]
struct StartedSession {
    id: i64,
    workspace_id: i64,
    kind: String,
    started_at: i64,
}

/// `POST /v1/workspaces/:id/sessions/start` → 201 `{id, …}`.
async fn start_live_session(
    State(state): State<AppState>,
    axum::extract::Path(ws_id): axum::extract::Path<i64>,
    Json(body): Json<StartSessionBody>,
) -> Result<(StatusCode, Json<StartedSession>), Response> {
    let now = chrono::Utc::now().timestamp();
    let kind = body
        .kind
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .unwrap_or("video");
    // notes stays NULL while live — the Activities view only lists
    // rows with non-null notes, so an in-flight (or abandoned
    // zero-length) session doesn't show up as a logged activity.
    // `finish` sets the label.
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO study_sessions
           (workspace_id, kind, started_at, ended_at, duration_secs)
         VALUES (?, ?, ?, ?, 0)
         RETURNING id",
    )
    .bind(ws_id)
    .bind(kind)
    .bind(now)
    .bind(now)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| {
        log::error!("start_live_session insert: {e}");
        err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal.unexpected",
            "Failed to start the session.",
        )
    })?;
    emit_live_session(&state.app, "start", id, ws_id, kind, now, 0);
    Ok((
        StatusCode::CREATED,
        Json(StartedSession {
            id,
            workspace_id: ws_id,
            kind: kind.to_string(),
            started_at: now,
        }),
    ))
}

/// Push live-session state to the desktop UI (`tokori:live-session`).
/// The sidebar's session chip mirrors Companion-driven sessions from
/// these — start shows the "Immersing" indicator, beats re-anchor its
/// timer, finish (or beat silence) clears it. Best-effort: a session
/// is never failed over a UI event.
fn emit_live_session(
    app: &AppHandle,
    phase: &str,
    id: i64,
    workspace_id: i64,
    kind: &str,
    started_at: i64,
    duration_secs: i64,
) {
    let _ = app.emit(
        "tokori:live-session",
        serde_json::json!({
            "phase": phase,
            "id": id,
            "workspaceId": workspace_id,
            "kind": kind,
            "startedAt": started_at,
            "durationSecs": duration_secs,
        }),
    );
}

#[derive(Deserialize)]
struct SessionProgressBody {
    /// Total accrued ACTIVE seconds so far (not a delta). May lag wall
    /// clock — paused time doesn't count unless the client says so.
    duration_secs: i64,
    /// Only used by /finish: human-readable label (video title). Makes
    /// the session appear in the Activities view.
    notes: Option<String>,
}

async fn update_live_session(
    state: &AppState,
    phase: &str,
    id: i64,
    duration_secs: i64,
    notes: Option<&str>,
) -> Result<(), Response> {
    if duration_secs < 0 {
        return Err(err_response(
            StatusCode::BAD_REQUEST,
            "validation.duration_secs",
            "duration_secs cannot be negative.",
        ));
    }
    let now = chrono::Utc::now().timestamp();
    let duration = duration_secs.min(24 * 3600);
    let r = sqlx::query(
        "UPDATE study_sessions
         SET duration_secs = ?, ended_at = ?, notes = COALESCE(?, notes)
         WHERE id = ?",
    )
    .bind(duration)
    .bind(now)
    .bind(notes)
    .bind(id)
    .execute(&state.pool)
    .await
    .map_err(|e| {
        log::error!("update_live_session: {e}");
        err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal.unexpected",
            "Failed to update the session.",
        )
    })?;
    if r.rows_affected() == 0 {
        return Err(err_response(
            StatusCode::NOT_FOUND,
            "not_found.session",
            "No session with that id.",
        ));
    }
    // Keep the sidebar's mirror ticking (beat) / cleared (finish).
    if let Ok(Some((kind, ws_id, started_at))) = sqlx::query_as::<_, (String, i64, i64)>(
        "SELECT kind, workspace_id, started_at FROM study_sessions WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    {
        emit_live_session(&state.app, phase, id, ws_id, &kind, started_at, duration);
    }
    Ok(())
}

/// `POST /v1/sessions/:id/heartbeat` `{duration_secs}` — refresh the
/// live row to "now" with the client's accrued active time.
async fn heartbeat_session(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<i64>,
    Json(body): Json<SessionProgressBody>,
) -> Result<Json<serde_json::Value>, Response> {
    update_live_session(&state, "beat", id, body.duration_secs, None).await?;
    Ok(Json(serde_json::json!({ "id": id, "ok": true })))
}

/// `POST /v1/sessions/:id/finish` `{duration_secs, notes?}` — final
/// numbers + the label that surfaces the session in Activities.
async fn finish_session(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<i64>,
    Json(body): Json<SessionProgressBody>,
) -> Result<Json<serde_json::Value>, Response> {
    // A finish with no label still marks the row as a completed manual
    // log ("" = the same marker the in-app activity logger writes).
    let notes = body.notes.unwrap_or_default();
    update_live_session(&state, "finish", id, body.duration_secs, Some(&notes)).await?;
    Ok(Json(serde_json::json!({ "id": id, "ok": true })))
}

// ── Media (Immersion watch library) ─────────────────────────────────
//
// Media items are `library_items` rows with a watch/listen kind — the
// same lens the Immersion view renders (src/lib/media/kinds.ts). The
// by-URL endpoints canonicalize both the stored `source` and the
// incoming URL (media_url.rs) so the Companion extension can ask "is
// the video I'm playing on this user's list?" without knowing row ids.

const MEDIA_KINDS: [&str; 3] = ["video", "series", "podcast"];
const MEDIA_KIND_SQL: &str = "kind IN ('video','series','podcast')";
const MEDIA_STATUSES: [&str; 5] = ["planned", "active", "paused", "finished", "dropped"];
const MEDIA_COLS: &str = "id, workspace_id, kind, title, author, source, total_units, \
     unit_label, completed_units, total_seconds, status, cover_url, notes, created_at, updated_at";

#[derive(Serialize, sqlx::FromRow)]
struct MediaItem {
    id: i64,
    workspace_id: i64,
    kind: String,
    title: String,
    author: Option<String>,
    source: Option<String>,
    total_units: Option<i64>,
    unit_label: String,
    completed_units: i64,
    total_seconds: i64,
    status: String,
    cover_url: Option<String>,
    notes: Option<String>,
    created_at: i64,
    updated_at: i64,
}

fn validate_media_kind(kind: &str) -> Result<(), Response> {
    if MEDIA_KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(err_response(
            StatusCode::BAD_REQUEST,
            "validation.kind",
            "kind must be one of: video, series, podcast.",
        ))
    }
}

fn validate_media_status(status: &str) -> Result<(), Response> {
    if MEDIA_STATUSES.contains(&status) {
        Ok(())
    } else {
        Err(err_response(
            StatusCode::BAD_REQUEST,
            "validation.status",
            "status must be one of: planned, active, paused, finished, dropped.",
        ))
    }
}

/// Progress denominator per medium — mirrors MEDIA_DEFAULT_UNIT in
/// src/lib/media/kinds.ts.
fn default_media_unit(kind: &str) -> &'static str {
    match kind {
        "video" => "minutes",
        _ => "episodes",
    }
}

/// Mirrors `isMinutesUnit` (src/lib/library-units.ts): when the unit
/// itself is time, playback position maps directly onto units.
fn is_minutes_unit(label: &str) -> bool {
    matches!(label.trim().to_lowercase().as_str(), "min" | "mins" | "minute" | "minutes")
}

fn internal_media_error(context: &str, e: sqlx::Error) -> Response {
    log::error!("{context}: {e}");
    err_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal.unexpected",
        "Media operation failed.",
    )
}

async fn fetch_media_item(pool: &SqlitePool, id: i64) -> Result<MediaItem, Response> {
    sqlx::query_as::<_, MediaItem>(&format!(
        "SELECT {MEDIA_COLS} FROM library_items WHERE id = ? AND {MEDIA_KIND_SQL}"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| internal_media_error("fetch_media_item", e))?
    .ok_or_else(|| {
        err_response(
            StatusCode::NOT_FOUND,
            "not_found.media",
            "No media item with that id.",
        )
    })
}

/// Find the row whose stored `source` URL canonicalizes to `key`.
/// Linear over the (small) media list — most recently touched wins so
/// a re-added duplicate resolves to the live row.
async fn find_media_by_key(
    pool: &SqlitePool,
    workspace_id: Option<i64>,
    key: &str,
) -> Result<Option<MediaItem>, Response> {
    let mut sql = format!(
        "SELECT {MEDIA_COLS} FROM library_items WHERE {MEDIA_KIND_SQL} AND source IS NOT NULL"
    );
    if workspace_id.is_some() {
        sql.push_str(" AND workspace_id = ?");
    }
    sql.push_str(" ORDER BY updated_at DESC");
    let mut query = sqlx::query_as::<_, MediaItem>(&sql);
    if let Some(ws) = workspace_id {
        query = query.bind(ws);
    }
    let rows = query
        .fetch_all(pool)
        .await
        .map_err(|e| internal_media_error("find_media_by_key", e))?;
    Ok(rows.into_iter().find(|item| {
        item.source
            .as_deref()
            .and_then(canonical_media_key)
            .is_some_and(|k| k == key)
    }))
}

fn require_media_key(url: &str) -> Result<String, Response> {
    canonical_media_key(url).ok_or_else(|| {
        err_response(
            StatusCode::BAD_REQUEST,
            "validation.url",
            "url must be an http(s) link.",
        )
    })
}

#[derive(Deserialize)]
struct MediaQuery {
    status: Option<String>,
    kind: Option<String>,
    limit: Option<i64>,
}

/// `GET /v1/workspaces/:id/media?status=&kind=&limit=` — the watch list.
async fn list_media(
    State(state): State<AppState>,
    axum::extract::Path(ws_id): axum::extract::Path<i64>,
    Query(q): Query<MediaQuery>,
) -> Result<Json<Page<MediaItem>>, Response> {
    if let Some(kind) = q.kind.as_deref() {
        validate_media_kind(kind)?;
    }
    if let Some(status) = q.status.as_deref() {
        validate_media_status(status)?;
    }
    let limit = q.limit.unwrap_or(200).clamp(1, 500);
    let mut sql = format!(
        "SELECT {MEDIA_COLS} FROM library_items WHERE workspace_id = ? AND {MEDIA_KIND_SQL}"
    );
    if q.kind.is_some() {
        sql.push_str(" AND kind = ?");
    }
    if q.status.is_some() {
        sql.push_str(" AND status = ?");
    }
    sql.push_str(" ORDER BY updated_at DESC LIMIT ?");
    let mut query = sqlx::query_as::<_, MediaItem>(&sql).bind(ws_id);
    if let Some(kind) = q.kind.as_deref() {
        query = query.bind(kind.to_string());
    }
    if let Some(status) = q.status.as_deref() {
        query = query.bind(status.to_string());
    }
    let rows = query
        .bind(limit)
        .fetch_all(&state.pool)
        .await
        .map_err(|e| internal_media_error("list_media", e))?;
    Ok(Json(Page {
        data: rows,
        next_cursor: None,
    }))
}

#[derive(Deserialize)]
struct CreateMediaBody {
    title: String,
    url: Option<String>,
    kind: Option<String>,
    author: Option<String>,
    total_units: Option<i64>,
    unit_label: Option<String>,
    status: Option<String>,
    notes: Option<String>,
}

/// `POST /v1/workspaces/:id/media` — add to the watch list. Idempotent
/// on the canonical URL: re-adding a link that's already on the list
/// returns the existing row with 200 instead of minting a duplicate
/// (same contract as the pack importer's upsert-by-source).
async fn create_media(
    State(state): State<AppState>,
    axum::extract::Path(ws_id): axum::extract::Path<i64>,
    Json(body): Json<CreateMediaBody>,
) -> Result<(StatusCode, Json<MediaItem>), Response> {
    let title = body.title.trim();
    if title.is_empty() {
        return Err(err_response(
            StatusCode::BAD_REQUEST,
            "validation.empty_title",
            "title cannot be empty.",
        ));
    }
    let url = body
        .url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty());
    let key = url.map(require_media_key).transpose()?;
    if let Some(key) = key.as_deref() {
        if let Some(existing) = find_media_by_key(&state.pool, Some(ws_id), key).await? {
            return Ok((StatusCode::OK, Json(existing)));
        }
    }
    let kind = match body.kind.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        Some(k) => {
            validate_media_kind(k)?;
            k.to_string()
        }
        // No explicit kind: infer the medium from the canonical key.
        None => match key.as_deref() {
            Some(k) if k.starts_with("yt:pl:") => "series".to_string(),
            Some(k) if k.starts_with("sp:") || k.starts_with("ap:") => "podcast".to_string(),
            _ => "video".to_string(),
        },
    };
    let status = match body.status.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => {
            validate_media_status(s)?;
            s.to_string()
        }
        None => "planned".to_string(),
    };
    let unit_label = body
        .unit_label
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| default_media_unit(&kind))
        .to_string();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO library_items
           (workspace_id, kind, title, author, source, total_units, unit_label, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id",
    )
    .bind(ws_id)
    .bind(&kind)
    .bind(title)
    .bind(body.author.as_deref().map(str::trim).filter(|a| !a.is_empty()))
    .bind(url)
    .bind(body.total_units.filter(|t| *t > 0))
    .bind(&unit_label)
    .bind(&status)
    .bind(body.notes.as_deref())
    .fetch_one(&state.pool)
    .await
    .map_err(|e| internal_media_error("create_media insert", e))?;
    let item = fetch_media_item(&state.pool, id).await?;
    Ok((StatusCode::CREATED, Json(item)))
}

#[derive(Deserialize)]
struct UpdateMediaBody {
    title: Option<String>,
    author: Option<String>,
    source: Option<String>,
    kind: Option<String>,
    status: Option<String>,
    total_units: Option<i64>,
    unit_label: Option<String>,
    completed_units: Option<i64>,
    total_seconds: Option<i64>,
    notes: Option<String>,
    /// Relative progress bumps — the MCP-friendly way to say "one more
    /// episode" without knowing the current count. Mutually exclusive
    /// with the absolute fields above.
    delta_units: Option<i64>,
    delta_seconds: Option<i64>,
}

/// `PATCH /v1/media/:id` — partial update. Only media-kind rows are
/// reachable here; the print library keeps its own surface.
async fn update_media(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<i64>,
    Json(body): Json<UpdateMediaBody>,
) -> Result<Json<MediaItem>, Response> {
    if body.delta_units.is_some() && body.completed_units.is_some()
        || body.delta_seconds.is_some() && body.total_seconds.is_some()
    {
        return Err(err_response(
            StatusCode::BAD_REQUEST,
            "validation.conflicting_progress",
            "Send either absolute progress (completed_units / total_seconds) or deltas, not both.",
        ));
    }
    if let Some(kind) = body.kind.as_deref() {
        validate_media_kind(kind)?;
    }
    if let Some(status) = body.status.as_deref() {
        validate_media_status(status)?;
    }
    if let Some(title) = body.title.as_deref() {
        if title.trim().is_empty() {
            return Err(err_response(
                StatusCode::BAD_REQUEST,
                "validation.empty_title",
                "title cannot be empty.",
            ));
        }
    }

    // SET clauses and their binds are built in lockstep so the two can
    // never drift out of order.
    enum Bind {
        Text(String),
        Int(i64),
    }
    let mut sets: Vec<&str> = Vec::new();
    let mut args: Vec<Bind> = Vec::new();
    let mut set_text = |set: &'static str, v: &str| {
        sets.push(set);
        args.push(Bind::Text(v.to_string()));
    };
    if let Some(v) = body.title.as_deref() {
        set_text("title = ?", v.trim());
    }
    // NULLIF: an explicit empty string clears the field (there's no
    // other way to express "remove the link" through a PATCH).
    if let Some(v) = body.author.as_deref() {
        set_text("author = NULLIF(?, '')", v.trim());
    }
    if let Some(v) = body.source.as_deref() {
        set_text("source = NULLIF(?, '')", v.trim());
    }
    if let Some(v) = body.kind.as_deref() {
        set_text("kind = ?", v);
    }
    if let Some(v) = body.status.as_deref() {
        set_text("status = ?", v);
    }
    if let Some(v) = body.unit_label.as_deref() {
        set_text("unit_label = ?", v.trim());
    }
    if let Some(v) = body.notes.as_deref() {
        set_text("notes = ?", v);
    }
    let mut set_int = |set: &'static str, v: i64| {
        sets.push(set);
        args.push(Bind::Int(v));
    };
    if let Some(v) = body.total_units {
        set_int("total_units = MAX(0, ?)", v);
    }
    if let Some(v) = body.completed_units {
        set_int("completed_units = MAX(0, ?)", v);
    }
    if let Some(v) = body.total_seconds {
        set_int("total_seconds = MAX(0, ?)", v);
    }
    if let Some(v) = body.delta_units {
        set_int("completed_units = MAX(0, completed_units + ?)", v);
    }
    if let Some(v) = body.delta_seconds {
        set_int("total_seconds = MAX(0, total_seconds + ?)", v);
    }
    if sets.is_empty() {
        return Err(err_response(
            StatusCode::BAD_REQUEST,
            "validation.empty_patch",
            "Provide at least one field to update.",
        ));
    }

    let sql = format!(
        "UPDATE library_items SET {}, updated_at = strftime('%s','now') WHERE id = ? AND {MEDIA_KIND_SQL}",
        sets.join(", ")
    );
    let mut query = sqlx::query(&sql);
    for arg in args {
        query = match arg {
            Bind::Text(s) => query.bind(s),
            Bind::Int(i) => query.bind(i),
        };
    }
    let result = query
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(|e| internal_media_error("update_media", e))?;
    if result.rows_affected() == 0 {
        return Err(err_response(
            StatusCode::NOT_FOUND,
            "not_found.media",
            "No media item with that id.",
        ));
    }
    Ok(Json(fetch_media_item(&state.pool, id).await?))
}

#[derive(Deserialize)]
struct MediaLookupQuery {
    url: String,
    workspace_id: Option<i64>,
}

/// `GET /v1/media/lookup?url=&workspace_id=` — "is this on the list?"
/// The extension probes this to badge the player without writing.
async fn lookup_media(
    State(state): State<AppState>,
    Query(q): Query<MediaLookupQuery>,
) -> Result<Json<serde_json::Value>, Response> {
    let key = require_media_key(&q.url)?;
    let item = find_media_by_key(&state.pool, q.workspace_id, &key).await?;
    Ok(Json(match item {
        Some(item) => serde_json::json!({ "matched": true, "item": item }),
        None => serde_json::json!({ "matched": false }),
    }))
}

#[derive(Deserialize)]
struct MediaProgressBody {
    url: String,
    workspace_id: Option<i64>,
    /// Current playback position, seconds into the media.
    position_secs: Option<i64>,
    /// Total media length, seconds. Fills/expands the item's minute
    /// denominator so percent works without manual entry.
    duration_secs: Option<i64>,
    /// Active watch/listen seconds since the previous beat (clamped —
    /// a buggy client can't mint hours per beat).
    delta_secs: Option<i64>,
    /// The player finished (or the client decided it's done).
    ended: Option<bool>,
}

/// `POST /v1/media/progress` — the Companion extension's beat. Soft
/// no-match (`{"matched": false}`, 200) because the extension probes
/// speculatively for every video the user plays; only list members
/// accrue progress.
async fn report_media_progress(
    State(state): State<AppState>,
    Json(body): Json<MediaProgressBody>,
) -> Result<Json<serde_json::Value>, Response> {
    let key = require_media_key(&body.url)?;
    let Some(item) = find_media_by_key(&state.pool, body.workspace_id, &key).await? else {
        return Ok(Json(serde_json::json!({ "matched": false })));
    };

    let mut completed = item.completed_units;
    let mut total = item.total_units;
    let mut seconds = item.total_seconds;
    if let Some(delta) = body.delta_secs {
        seconds += delta.clamp(0, 3600);
    }

    // Position → minute progress only where minutes ARE the unit (single
    // videos). Episodic items keep manual/chapter episode counts; their
    // beats still accrue listened time above.
    if is_minutes_unit(&item.unit_label) {
        if let Some(duration) = body.duration_secs.filter(|d| *d > 0) {
            let minutes = (duration + 59) / 60;
            total = Some(total.unwrap_or(0).max(minutes));
        }
        if let Some(position) = body.position_secs.filter(|p| *p > 0) {
            // Furthest-watched semantics: scrubbing backwards never
            // loses progress.
            completed = completed.max(position / 60);
            if let Some(t) = total {
                completed = completed.min(t);
            }
        }
    }

    let reached_end = matches!(
        (body.position_secs, body.duration_secs),
        (Some(p), Some(d)) if d > 0 && p * 10 >= d * 9
    );
    let status = if item.status == "finished" {
        // Rewatching never un-finishes; the extra minutes still count.
        "finished".to_string()
    } else if body.ended == Some(true) || reached_end {
        if let Some(t) = total.filter(|_| is_minutes_unit(&item.unit_label)) {
            completed = t;
        }
        "finished".to_string()
    } else if item.status == "planned" || item.status == "dropped" {
        // A beat means it's playing — promote it onto the watching shelf.
        "active".to_string()
    } else {
        item.status.clone()
    };

    sqlx::query(
        "UPDATE library_items
         SET completed_units = ?, total_units = ?, total_seconds = ?, status = ?,
             updated_at = strftime('%s','now')
         WHERE id = ?",
    )
    .bind(completed)
    .bind(total)
    .bind(seconds)
    .bind(&status)
    .bind(item.id)
    .execute(&state.pool)
    .await
    .map_err(|e| internal_media_error("report_media_progress", e))?;

    let updated = fetch_media_item(&state.pool, item.id).await?;
    Ok(Json(serde_json::json!({ "matched": true, "item": updated })))
}

#[derive(Deserialize)]
struct OcrFrameBody {
    /// Base64 (standard alphabet) PNG/JPEG bytes — typically a video
    /// frame's subtitle band captured by the Companion extension.
    image_b64: String,
    /// OCR language ("zh" | "ja" | "ko" | Latin fallback for the rest).
    lang: Option<String>,
}

/// `POST /v1/ocr` `{image_b64, lang}` → `{lines: [string]}` — the HTTP
/// door to the desktop's PaddleOCR engine (ocr.rs). Powers burned-in
/// subtitle recognition in the extension's player: the models and the
/// warm engine cache live here, so the browser never ships an OCR
/// runtime. First call per language downloads models (seconds); after
/// that a subtitle-band frame recognises in tens of milliseconds.
async fn ocr_frame(
    State(state): State<AppState>,
    Json(body): Json<OcrFrameBody>,
) -> Result<Json<serde_json::Value>, Response> {
    if body.image_b64.is_empty() {
        return Err(err_response(
            StatusCode::BAD_REQUEST,
            "validation.empty_image",
            "image_b64 is required.",
        ));
    }
    let lang = body.lang.as_deref().map(str::trim).filter(|l| !l.is_empty()).unwrap_or("en");
    let lines = crate::ocr::ocr_plain(&state.app, body.image_b64, lang)
        .await
        .map_err(|e| {
            log::error!("ocr_frame: {e}");
            err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal.ocr_failed",
                "OCR failed on this frame.",
            )
        })?;
    Ok(Json(serde_json::json!({ "lines": lines })))
}

/// INSERT … ON CONFLICT keeps the existing row (preserving its FSRS state and
/// review history) but tops up `gloss`/`reading` if the caller supplied a
/// non-empty value and the existing row didn't have one. Returns the row id
/// either way.
async fn upsert_vocab(
    pool: &SqlitePool,
    ws_id: i64,
    word: &str,
    reading: Option<&str>,
    gloss: Option<&str>,
    source: &str,
) -> Result<CreatedVocab, Response> {
    // Try the insert first; if it succeeds we know the row is fresh.
    let inserted: Option<i64> = sqlx::query_scalar(
        "INSERT INTO vocab_entries (workspace_id, word, reading, gloss, source)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, word) DO NOTHING
     RETURNING id",
    )
    .bind(ws_id)
    .bind(word)
    .bind(reading)
    .bind(gloss)
    .bind(source)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        log::error!("upsert_vocab insert: {e}");
        err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal.unexpected",
            "Failed to create vocab.",
        )
    })?;

    if let Some(id) = inserted {
        return Ok(CreatedVocab {
            id,
            workspace_id: ws_id,
            word: word.to_string(),
            reading: reading.map(String::from),
            gloss: gloss.map(String::from),
            existed: false,
        });
    }

    // Existing row — fetch its id and (best-effort) backfill missing fields.
    let row: (i64, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT id, reading, gloss FROM vocab_entries WHERE workspace_id = ? AND word = ?",
    )
    .bind(ws_id)
    .bind(word)
    .fetch_one(pool)
    .await
    .map_err(|e| {
        log::error!("upsert_vocab fetch existing: {e}");
        err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal.unexpected",
            "Failed to look up existing vocab.",
        )
    })?;
    let (id, existing_reading, existing_gloss) = row;
    // Only fill in fields that are currently NULL/empty — never clobber data
    // a human curated.
    let new_reading = pick_fill(&existing_reading, reading);
    let new_gloss = pick_fill(&existing_gloss, gloss);
    if new_reading.is_some() || new_gloss.is_some() {
        let _ = sqlx::query("UPDATE vocab_entries SET reading = COALESCE(?, reading), gloss = COALESCE(?, gloss) WHERE id = ?")
      .bind(new_reading.as_deref())
      .bind(new_gloss.as_deref())
      .bind(id)
      .execute(pool)
      .await;
    }
    Ok(CreatedVocab {
        id,
        workspace_id: ws_id,
        word: word.to_string(),
        reading: existing_reading.or_else(|| reading.map(String::from)),
        gloss: existing_gloss.or_else(|| gloss.map(String::from)),
        existed: true,
    })
}

fn pick_fill(existing: &Option<String>, incoming: Option<&str>) -> Option<String> {
    match (existing.as_deref(), incoming) {
        (Some(s), _) if !s.trim().is_empty() => None, // already set, leave alone
        (_, Some(s)) if !s.trim().is_empty() => Some(s.to_string()),
        _ => None,
    }
}

#[derive(Deserialize)]
struct AddWordsBody {
    /// Either pass existing vocab ids …
    vocab_ids: Option<Vec<i64>>,
    /// … or full word objects to upsert into the workspace and then link.
    /// `workspace_id` is required when using this form so we know which
    /// workspace to upsert into; the collection's own workspace is used as
    /// the default if omitted.
    words: Option<Vec<NewWord>>,
}
#[derive(Deserialize)]
struct NewWord {
    word: String,
    reading: Option<String>,
    gloss: Option<String>,
}

#[derive(Serialize)]
struct AddWordsResult {
    added: usize,
    skipped: usize,
    existed: usize,
}

async fn list_collection_words(
    State(state): State<AppState>,
    axum::extract::Path(cid): axum::extract::Path<i64>,
) -> Result<Json<Page<VocabEntry>>, Response> {
    let rows = sqlx::query_as::<_, VocabEntry>(
        "SELECT v.id, v.workspace_id, v.word, v.reading, v.gloss, v.status, v.created_at AS added_at
     FROM collection_words cw
     JOIN vocab_entries v ON v.id = cw.vocab_id
     WHERE cw.collection_id = ?
     ORDER BY cw.position ASC, cw.added_at ASC",
    )
    .bind(cid)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| {
        log::error!("list_collection_words: {e}");
        err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal.unexpected",
            "Failed to list collection words.",
        )
    })?;
    Ok(Json(Page {
        data: rows,
        next_cursor: None,
    }))
}

async fn add_words_to_collection(
    State(state): State<AppState>,
    axum::extract::Path(cid): axum::extract::Path<i64>,
    Json(body): Json<AddWordsBody>,
) -> Result<Json<AddWordsResult>, Response> {
    // Need the collection's workspace so the upsert path knows where to put
    // newly created vocab.
    let ws_id: i64 = sqlx::query_scalar("SELECT workspace_id FROM collections WHERE id = ?")
        .bind(cid)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| {
            log::error!("add_words_to_collection lookup: {e}");
            err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal.unexpected",
                "Failed to look up collection.",
            )
        })?
        .ok_or_else(|| {
            err_response(
                StatusCode::NOT_FOUND,
                "not_found.collection",
                "Collection not found.",
            )
        })?;

    let mut added = 0usize;
    let mut skipped = 0usize;
    let mut existed = 0usize;

    if let Some(ids) = body.vocab_ids {
        for id in ids {
            match link_vocab_to_collection(&state.pool, cid, id).await {
                Ok(true) => added += 1,
                Ok(false) => skipped += 1,
                Err(_) => skipped += 1,
            }
        }
    }
    if let Some(words) = body.words {
        for w in words {
            let trimmed = w.word.trim();
            if trimmed.is_empty() {
                skipped += 1;
                continue;
            }
            let v = match upsert_vocab(
                &state.pool,
                ws_id,
                trimmed,
                w.reading.as_deref(),
                w.gloss.as_deref(),
                "api",
            )
            .await
            {
                Ok(v) => v,
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            };
            if v.existed {
                existed += 1;
            }
            match link_vocab_to_collection(&state.pool, cid, v.id).await {
                Ok(true) => added += 1,
                Ok(false) => {}
                Err(_) => skipped += 1,
            }
        }
    }
    Ok(Json(AddWordsResult {
        added,
        skipped,
        existed,
    }))
}

/// Returns true if the link was newly created, false if it already existed.
async fn link_vocab_to_collection(
    pool: &SqlitePool,
    collection_id: i64,
    vocab_id: i64,
) -> Result<bool, Response> {
    let res = sqlx::query(
        "INSERT OR IGNORE INTO collection_words (collection_id, vocab_id) VALUES (?, ?)",
    )
    .bind(collection_id)
    .bind(vocab_id)
    .execute(pool)
    .await
    .map_err(|e| {
        log::error!("link_vocab_to_collection: {e}");
        err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal.unexpected",
            "Failed to link word to collection.",
        )
    })?;
    Ok(res.rows_affected() > 0)
}

#[derive(Deserialize)]
struct ImportCollectionBody {
    name: String,
    description: Option<String>,
    words: Vec<NewWord>,
}

#[derive(Serialize)]
struct ImportCollectionResult {
    collection: Collection,
    added: usize,
    existed: usize,
    skipped: usize,
}

async fn import_collection(
    State(state): State<AppState>,
    axum::extract::Path(ws_id): axum::extract::Path<i64>,
    Json(body): Json<ImportCollectionBody>,
) -> Result<(StatusCode, Json<ImportCollectionResult>), Response> {
    if body.name.trim().is_empty() {
        return Err(err_response(
            StatusCode::BAD_REQUEST,
            "validation.empty_name",
            "Collection name cannot be empty.",
        ));
    }
    // Composite operation. Done sequentially rather than in a single
    // transaction because each upsert + link can independently fail (bad
    // word, FK mismatch) and we'd rather report partial success than nuke
    // the collection on the first hiccup. The MCP layer relies on the
    // returned counts to give the user accurate feedback.
    let cid: i64 = sqlx::query_scalar(
        "INSERT INTO collections (workspace_id, name, description, source)
     VALUES (?, ?, ?, 'imported')
     RETURNING id",
    )
    .bind(ws_id)
    .bind(body.name.trim())
    .bind(body.description.as_deref())
    .fetch_one(&state.pool)
    .await
    .map_err(|e| {
        log::error!("import_collection create: {e}");
        err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal.unexpected",
            "Failed to create collection.",
        )
    })?;

    let mut added = 0usize;
    let mut existed = 0usize;
    let mut skipped = 0usize;
    for w in body.words {
        let trimmed = w.word.trim();
        if trimmed.is_empty() {
            skipped += 1;
            continue;
        }
        let v = match upsert_vocab(
            &state.pool,
            ws_id,
            trimmed,
            w.reading.as_deref(),
            w.gloss.as_deref(),
            "api",
        )
        .await
        {
            Ok(v) => v,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        if v.existed {
            existed += 1;
        }
        match link_vocab_to_collection(&state.pool, cid, v.id).await {
            Ok(true) => added += 1,
            Ok(false) => {}
            Err(_) => skipped += 1,
        }
    }
    let collection = fetch_collection(&state.pool, cid).await?;
    Ok((
        StatusCode::CREATED,
        Json(ImportCollectionResult {
            collection,
            added,
            existed,
            skipped,
        }),
    ))
}

// ── Remote chat (mobile-via-tunnel) ─────────────────────────────────
//
// Two endpoints power the "phone uses my PC's chat" flow. The phone
// reaches the desktop through a Cloudflare Tunnel (or Tailscale Funnel,
// or LAN if same network) — neither of those is our concern; we just
// expose the routes and let the tunnel agent on the desktop publish the
// loopback port to the internet.
//
//   GET  /v1/remote/info   — cheap health probe used by the mobile
//                            client to validate a pasted URL + token.
//                            Returns the hostname so the user can see
//                            "Connected to flo-laptop".
//   POST /v1/chat/stream   — SSE: forwards a chat completion through
//                            the desktop's currently-active provider.
//                            The phone never sees API keys.

#[derive(Serialize)]
struct RemoteInfo {
    service: &'static str,
    version: &'static str,
    hostname: String,
    /// True when the desktop has a non-cloud provider selected and we
    /// can actually serve chat completions to a remote client.
    provider_configured: bool,
    workspaces: i64,
}

async fn remote_info(State(state): State<AppState>) -> Json<RemoteInfo> {
    let workspaces: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workspaces")
        .fetch_one(&state.pool)
        .await
        .unwrap_or(0);
    let provider_configured = load_active_provider(&state.pool).await.is_ok();
    let hostname = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "tokori-desktop".to_string());
    Json(RemoteInfo {
        service: "tokori",
        version: env!("CARGO_PKG_VERSION"),
        hostname,
        provider_configured,
        workspaces,
    })
}

#[derive(Deserialize)]
struct ChatStreamRequest {
    messages: Vec<ChatMessage>,
}

/// POST /v1/chat/stream — SSE.
///
/// The desktop's currently-active provider drives the completion;
/// remote callers don't pass provider config so API keys never leave
/// the PC. Cloud (`tokori-cloud`) is rejected — remote callers should
/// hit the cloud directly instead of round-tripping through here.
async fn chat_stream(
    State(state): State<AppState>,
    Json(req): Json<ChatStreamRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, Response> {
    let cfg = load_active_provider(&state.pool)
        .await
        .map_err(|e| err_response(StatusCode::PRECONDITION_FAILED, "chat.no_provider", &e))?;

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<ChatEvent>();
    let messages = req.messages;

    // Run the streamer in the background so the HTTP handler can return
    // the SSE stream immediately. The sender is moved into the task; when
    // stream_chat finishes (Done or Error already emitted), `tx` drops
    // and the receiver naturally closes the SSE stream.
    tokio::spawn(async move {
        let _ = stream_chat(cfg, messages, &tx).await;
    });

    // Bridge mpsc → SSE. Each ChatEvent becomes one `data: {json}` frame.
    // Serialization errors fall through as a default empty event rather
    // than tearing down the stream — practically unreachable, but
    // `json_data` returns Result so the type system asks.
    let rx_stream = tokio_stream_recv(rx).map(|event| {
        let ev = Event::default()
            .json_data(&event)
            .unwrap_or_else(|_| Event::default());
        Ok::<Event, Infallible>(ev)
    });

    Ok(Sse::new(rx_stream).keep_alive(KeepAlive::default()))
}

/// Wrap an unbounded mpsc receiver as a `Stream`. Inlined instead of
/// pulling `tokio-stream` because we only need this one shape.
fn tokio_stream_recv<T>(rx: tokio::sync::mpsc::UnboundedReceiver<T>) -> impl Stream<Item = T> {
    futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|v| (v, rx)) })
}

/// One `provider_configs` row as selected below: (kind, model, host,
/// api_key, base_url). Aliased so the `query_as` type annotation stays
/// readable.
type ProviderConfigRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// Load the currently-active provider from settings. Errors describe the
/// problem in user-facing language so the mobile app can surface it.
async fn load_active_provider(pool: &SqlitePool) -> Result<ProviderConfig, String> {
    let active: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'providers.activeId'")
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("settings lookup failed: {e}"))?;

    let id = active
        .as_deref()
        .and_then(|s| s.parse::<i64>().ok())
        .ok_or_else(|| {
            "No active provider on the desktop. Open Settings → Providers and pick one.".to_string()
        })?;

    // `-1` is the synthetic Tokori Cloud row (see CLOUD_PROVIDER_ID in
    // provider-context.tsx). Cloud chat is brokered server-side and
    // doesn't need to round-trip through the desktop.
    if id < 0 {
        return Err(
            "Active provider is Tokori Cloud. Switch to a local provider (Ollama / OpenAI / Anthropic / Gemini / Minimax) to enable remote PC chat."
                .to_string(),
        );
    }

    let row: Option<ProviderConfigRow> = sqlx::query_as(
        "SELECT kind, model, host, api_key, base_url FROM provider_configs WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("provider row lookup failed: {e}"))?;

    let (kind, model, host, api_key, base_url) =
        row.ok_or_else(|| "Active provider row not found.".to_string())?;

    match kind.as_str() {
        "ollama" => Ok(ProviderConfig::Ollama {
            host: host.unwrap_or_else(|| "http://localhost:11434".to_string()),
            model,
        }),
        "openai" => Ok(ProviderConfig::Openai {
            api_key: api_key.unwrap_or_default(),
            model,
            base_url,
        }),
        "anthropic" => Ok(ProviderConfig::Anthropic {
            api_key: api_key.unwrap_or_default(),
            model,
        }),
        "gemini" => Ok(ProviderConfig::Gemini {
            api_key: api_key.unwrap_or_default(),
            model,
        }),
        "minimax" => Ok(ProviderConfig::Minimax {
            api_key: api_key.unwrap_or_default(),
            model,
            base_url,
        }),
        // DashScope's chat surface is OpenAI-compatible — reuse the OpenAI
        // provider with the DashScope base URL, mirroring the frontend's
        // toRustConfig (chat-providers.ts). The row's base_url wins so
        // mainland-China keys keep working.
        "qwen" => Ok(ProviderConfig::Openai {
            api_key: api_key.unwrap_or_default(),
            model,
            base_url: base_url
                .or_else(|| Some("https://dashscope-intl.aliyuncs.com/compatible-mode/v1".into())),
        }),
        other => Err(format!("Unsupported provider kind: {other}")),
    }
}

// ── Pairing ──────────────────────────────────────────────────────────
//
// Browser-extension / CLI clients that don't have a token yet hit
// `/v1/pair/request` to ask for one. The handler:
//   1. allocates a request id, stores a oneshot sender in the broker,
//   2. emits `tokori:pair-request` to the frontend with the metadata,
//   3. awaits the oneshot with a 60s timeout.
// The desktop UI renders an approval modal and calls the `pair_resolve`
// Tauri command (lib.rs) with approve/deny.
//
// Returning the actual bearer token here is fine: it's the same token
// the user could read from Settings → Local API, and the user just
// explicitly approved this sharing.

#[derive(Deserialize)]
struct PairRequestBody {
    /// Identifier the requesting client wants displayed in the dialog.
    /// Free-form — e.g. "Tokori Companion (Chrome)". Sanitised before
    /// being shown to the user.
    client: Option<String>,
}

#[derive(Serialize, Clone)]
struct PairRequestEvent {
    id: String,
    client: String,
    created_at: i64,
}

#[derive(Serialize)]
struct PairResponse {
    token: String,
    device_name: String,
}

async fn pair_request(
    State(state): State<AppState>,
    Json(req): Json<PairRequestBody>,
) -> Result<Json<PairResponse>, Response> {
    let id = new_request_id();
    let client = sanitise_client(req.client.as_deref().unwrap_or("Unknown client"));
    let (tx, rx) = oneshot::channel::<bool>();
    state.pair_broker.register(id.clone(), tx);

    let payload = PairRequestEvent {
        id: id.clone(),
        client: client.clone(),
        created_at: chrono::Utc::now().timestamp_millis(),
    };
    if let Err(e) = state.app.emit("tokori:pair-request", payload) {
        state.pair_broker.discard(&id);
        log::error!("pair_request: failed to emit event: {e}");
        return Err(err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "pair.no_frontend",
            "Could not reach the desktop UI to ask for approval.",
        ));
    }

    // Block up to 60s waiting for the user. The `oneshot` sender lives in
    // the broker until either the user resolves it (lib.rs::pair_resolve)
    // or the timeout fires.
    match tokio::time::timeout(Duration::from_secs(60), rx).await {
        Ok(Ok(true)) => Ok(Json(PairResponse {
            token: state.token.clone(),
            device_name: hostname(),
        })),
        Ok(Ok(false)) => {
            // The user clicked Deny — surface as 403, not 401, so the
            // client distinguishes "rejected" from "token wrong".
            Err(err_response(
                StatusCode::FORBIDDEN,
                "pair.denied",
                "Pair request was denied by the user.",
            ))
        }
        Ok(Err(_)) => {
            // Sender was dropped without being used — shouldn't happen
            // because resolve takes the sender out of the map first.
            Err(err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "pair.cancelled",
                "Pair request was cancelled.",
            ))
        }
        Err(_) => {
            // Timeout: nobody clicked. Clean up our broker entry.
            state.pair_broker.discard(&id);
            Err(err_response(
                StatusCode::REQUEST_TIMEOUT,
                "pair.timeout",
                "No response from the desktop app — try again.",
            ))
        }
    }
}

fn sanitise_client(s: &str) -> String {
    // Keep only printable ASCII + a few accents, cap at 80 chars. The
    // string lands in a Tauri event payload and then a React modal —
    // we want to avoid surprises (control chars, huge strings) in the
    // dialog.
    let trimmed: String = s.chars().filter(|c| !c.is_control()).take(80).collect();
    if trimmed.is_empty() {
        "Unknown client".into()
    } else {
        trimmed
    }
}

fn hostname() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "tokori-desktop".into())
}

// ── AI explain (non-streaming, single-shot) ─────────────────────────
//
// Companion-extension callers want a 1-2 sentence explanation of a
// foreign-language sentence. Reuses the same provider routing as
// `/v1/chat/stream` — we just collect the streamed tokens into a
// single string before responding, so the extension doesn't have to
// implement SSE.

#[derive(Deserialize)]
struct AiExplainRequest {
    text: String,
    /// Two-letter language code (zh, ja, …). Used to phrase the prompt.
    /// Optional; falls back to "the source language".
    lang: Option<String>,
}

#[derive(Serialize)]
struct AiExplainResponse {
    explanation: String,
    /// "openai/gpt-4o-mini", "anthropic/claude-haiku-…", etc. Echoed
    /// back so the caller can show "answered by Tokori desktop (gpt-…)".
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
}

async fn ai_explain(
    State(state): State<AppState>,
    Json(req): Json<AiExplainRequest>,
) -> Result<Json<AiExplainResponse>, Response> {
    let text = req.text.trim();
    if text.is_empty() {
        return Err(err_response(
            StatusCode::BAD_REQUEST,
            "ai.empty_text",
            "Provide a non-empty `text` field.",
        ));
    }
    let cfg = load_active_provider(&state.pool)
        .await
        .map_err(|e| err_response(StatusCode::PRECONDITION_FAILED, "ai.no_provider", &e))?;

    let lang_label = req
        .lang
        .as_deref()
        .map(language_label)
        .unwrap_or("the source language");
    let prompt = format!(
        "Explain this {lang_label} sentence in clear, simple English. Cover what it means and any tricky grammar or words. Keep it under 4 sentences.\n\nSentence: {text}"
    );
    let messages = vec![ChatMessage {
        role: "user".into(),
        content: prompt,
    }];

    // Collect the streamed tokens into a single buffer. We use an mpsc
    // channel the same way `/v1/chat/stream` does, but instead of
    // forwarding events to the wire we drain them into a string.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ChatEvent>();
    let stream_task = tokio::spawn(async move { stream_chat(cfg, messages, &tx).await });

    let mut buffer = String::new();
    let mut err: Option<String> = None;
    while let Some(event) = rx.recv().await {
        match event {
            ChatEvent::Token { delta } => buffer.push_str(&delta),
            ChatEvent::Done { content } => {
                if !content.is_empty() {
                    buffer = content;
                }
            }
            ChatEvent::Error { message } => err = Some(message),
        }
    }
    let _ = stream_task.await;

    if let Some(message) = err {
        return Err(err_response(
            StatusCode::BAD_GATEWAY,
            "ai.provider_error",
            &message,
        ));
    }
    if buffer.trim().is_empty() {
        return Err(err_response(
            StatusCode::BAD_GATEWAY,
            "ai.empty_response",
            "Provider returned an empty response.",
        ));
    }

    Ok(Json(AiExplainResponse {
        explanation: buffer.trim().to_string(),
        model: None,
    }))
}

// ── Vocab status upsert ──────────────────────────────────────────────
//
// `POST /v1/vocab/status` — the browser extension's word popovers set a
// word's SRS status (new / learning / review / mastered) without going
// through the full create_vocab body. Upserts the row (so an unseen
// word can be marked directly) and mirrors the semantics of the
// frontend's `setVocabStatus`: "new" wipes SRS history so the card
// schedules fresh; every other status stamps `last_review = now` so
// the dashboard's growth chart picks it up.

#[derive(Deserialize)]
struct VocabStatusBody {
    workspace_id: i64,
    word: String,
    reading: Option<String>,
    gloss: Option<String>,
    status: String,
}

#[derive(Serialize)]
struct VocabStatusResponse {
    id: i64,
    status: String,
    existed: bool,
}

async fn set_vocab_status(
    State(state): State<AppState>,
    Json(body): Json<VocabStatusBody>,
) -> Result<Json<VocabStatusResponse>, Response> {
    let word = body.word.trim();
    if word.is_empty() {
        return Err(err_response(
            StatusCode::BAD_REQUEST,
            "validation.empty_word",
            "Vocab word cannot be empty.",
        ));
    }
    let status = body.status.as_str();
    if !matches!(status, "new" | "learning" | "review" | "mastered") {
        return Err(err_response(
            StatusCode::BAD_REQUEST,
            "validation.bad_status",
            "status must be one of: new, learning, review, mastered.",
        ));
    }
    let row = upsert_vocab(
        &state.pool,
        body.workspace_id,
        word,
        body.reading.as_deref(),
        body.gloss.as_deref(),
        "api",
    )
    .await?;
    let query = if status == "new" {
        sqlx::query(
            "UPDATE vocab_entries SET status = 'new', last_review = NULL, review_count = 0,
                stability = 0, difficulty = 5, learning_step = 0, due_at = NULL
             WHERE id = ?",
        )
        .bind(row.id)
    } else {
        sqlx::query(
            "UPDATE vocab_entries SET status = ?, last_review = strftime('%s','now') WHERE id = ?",
        )
        .bind(status)
        .bind(row.id)
    };
    query.execute(&state.pool).await.map_err(|e| {
        log::error!("set_vocab_status: {e}");
        err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal.unexpected",
            "Failed to update vocab status.",
        )
    })?;
    Ok(Json(VocabStatusResponse {
        id: row.id,
        status: status.to_string(),
        existed: row.existed,
    }))
}

// ── Translate ────────────────────────────────────────────────────────
//
// `POST /v1/translate` — LLM-backed translation through the active
// provider, so remote clients (browser extension, mobile) can reuse the
// user's configured AI instead of shipping their own keys. The richer
// engine registry (DeepL, Google-paid, …) lives in the TS frontend and
// isn't reachable from this process; the AI path is the surface every
// configured desktop already has.

#[derive(Deserialize)]
struct TranslateRequest {
    text: String,
    /// Two-letter source language code; falls back to auto-detect
    /// phrasing when absent.
    source: Option<String>,
    /// Two-letter target language code; defaults to English.
    target: Option<String>,
}

#[derive(Serialize)]
struct TranslateResponse {
    translation: String,
}

async fn translate_text(
    State(state): State<AppState>,
    Json(req): Json<TranslateRequest>,
) -> Result<Json<TranslateResponse>, Response> {
    let text = req.text.trim();
    if text.is_empty() {
        return Err(err_response(
            StatusCode::BAD_REQUEST,
            "translate.empty_text",
            "Provide a non-empty `text` field.",
        ));
    }
    let cfg = load_active_provider(&state.pool)
        .await
        .map_err(|e| err_response(StatusCode::PRECONDITION_FAILED, "ai.no_provider", &e))?;

    let source_label = req.source.as_deref().map(language_label);
    let target_label = req
        .target
        .as_deref()
        .map(language_label)
        .unwrap_or("English");
    let prompt = match source_label {
        Some(src) => format!(
            "Translate the following {src} text into {target_label}. Reply with ONLY the translation — no explanations, notes, or quotation marks.\n\n{text}"
        ),
        None => format!(
            "Translate the following text into {target_label}. Reply with ONLY the translation — no explanations, notes, or quotation marks.\n\n{text}"
        ),
    };
    let messages = vec![ChatMessage {
        role: "user".into(),
        content: prompt,
    }];

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ChatEvent>();
    let stream_task = tokio::spawn(async move { stream_chat(cfg, messages, &tx).await });

    let mut buffer = String::new();
    let mut err: Option<String> = None;
    while let Some(event) = rx.recv().await {
        match event {
            ChatEvent::Token { delta } => buffer.push_str(&delta),
            ChatEvent::Done { content } => {
                if !content.is_empty() {
                    buffer = content;
                }
            }
            ChatEvent::Error { message } => err = Some(message),
        }
    }
    let _ = stream_task.await;

    if let Some(message) = err {
        return Err(err_response(
            StatusCode::BAD_GATEWAY,
            "ai.provider_error",
            &message,
        ));
    }
    if buffer.trim().is_empty() {
        return Err(err_response(
            StatusCode::BAD_GATEWAY,
            "ai.empty_response",
            "Provider returned an empty response.",
        ));
    }

    Ok(Json(TranslateResponse {
        translation: buffer.trim().to_string(),
    }))
}

fn language_label(code: &str) -> &'static str {
    match code.to_ascii_lowercase().as_str() {
        "zh" | "zh-cn" | "zh-tw" => "Chinese",
        "ja" => "Japanese",
        "ko" => "Korean",
        "es" => "Spanish",
        "fr" => "French",
        "de" => "German",
        "it" => "Italian",
        "pt" => "Portuguese",
        "ru" => "Russian",
        "ar" => "Arabic",
        "hi" => "Hindi",
        "vi" => "Vietnamese",
        "th" => "Thai",
        _ => "the source language",
    }
}

/// Read or generate the bearer token. Stored at `~/.tokori/api-token`. We
/// generate a 32-byte random value, base64-url-encoded (44 chars, no
/// padding) — enough entropy that brute force is infeasible even on
/// localhost where there's no rate limiter.
pub fn ensure_token() -> Result<String, ApiError> {
    let dir = token_dir()?;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("api-token");
    if let Ok(s) = std::fs::read_to_string(&path) {
        let trimmed = s.trim();
        if trimmed.len() >= 32 {
            return Ok(trimmed.to_string());
        }
        // Otherwise: file was empty or corrupted. Regenerate.
    }
    let token = generate_token();
    write_token(&path, &token)?;
    Ok(token)
}

fn generate_token() -> String {
    use base64::Engine;
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

fn write_token(path: &Path, token: &str) -> std::io::Result<()> {
    std::fs::write(path, token)?;
    // Best-effort: tighten permissions on Unix. Windows ACLs default to
    // current-user-only for files in the user profile, which is fine.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(path, perms)?;
    }
    Ok(())
}

fn token_dir() -> Result<PathBuf, ApiError> {
    let home = dirs::home_dir().ok_or_else(|| ApiError::Io("no home dir".into()))?;
    Ok(home.join(".tokori"))
}

/// Autostart flag. A tiny presence-marker file at
/// `~/.tokori/api-autostart` — when it exists the API server is
/// launched during app `setup()`. Kept as a flat file rather than
/// going through the SQLite settings table so the Rust side can read
/// it before the SQL plugin has had a chance to open the DB.
pub fn read_autostart() -> bool {
    let Ok(dir) = token_dir() else {
        return false;
    };
    dir.join("api-autostart").exists()
}

pub fn write_autostart(enabled: bool) -> Result<(), ApiError> {
    let dir = token_dir()?;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("api-autostart");
    if enabled {
        std::fs::write(&path, b"1")?;
    } else if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

// ── OAuth loopback routes ────────────────────────────────────────────
//
// The flow (see `src/lib/oauth-desktop.ts` on the frontend side):
//   1. Frontend calls `oauth_begin` (a Tauri command in lib.rs) which
//      mints a `state` and registers it on the api_server's
//      OAuthStateBroker.
//   2. Frontend opens the browser at the cloud's
//      `/api/auth/oauth/{provider}/start?redirect=...&state=...`.
//   3. Cloud runs the standard OAuth dance, then 302s the browser to
//      `http://127.0.0.1:53210/oauth/callback?state=...#token=...&...`.
//   4. Our GET /oauth/callback returns a small HTML bouncer that
//      parses location.search (`state`) + location.hash (token + user
//      fields), then same-origin POSTs the parsed payload to
//      /oauth/finish.
//   5. POST /oauth/finish validates `state` against the broker,
//      emits `tokori:oauth-complete` for the frontend listener, and
//      returns 204.
//   6. The browser page swaps its message to "✓ Signed in — you can
//      close this window."
//
// Both routes are mounted OUTSIDE `/v1` so the bearer-token middleware
// doesn't apply (the browser hitting them has no token). The bearer
// check would be wrong here anyway: the security boundary is the
// state-binding + the loopback-only bind.

/// The bouncer page returned by GET /oauth/callback. Pure static HTML
/// with no template substitution — keeps the surface as small as
/// possible. The JS reads its inputs from the URL the browser already
/// has and POSTs them right back to the same origin.
const OAUTH_BOUNCER_HTML: &str = r##"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Tokori — signing you in…</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/oauth/logo.png">
<style>
  /* Mirrors the app's theme tokens (src/index.css @theme + .dark) so
     this page — the one out-of-app surface every desktop sign-in walks
     through — reads as the same product. Keep the two in sync. */
  :root {
    color-scheme: light dark;
    --background: oklch(1 0 0);
    --foreground: oklch(0.16 0.005 250);
    --card: oklch(1 0 0);
    --muted-foreground: oklch(0.51 0.01 250);
    --border: oklch(0.93 0.006 250);
    --primary: oklch(0.21 0.01 250);
    --primary-foreground: oklch(0.985 0 0);
    --ring: oklch(0.62 0.16 280);
    --brand: oklch(0.55 0.2 280);
    --ok: oklch(0.6 0.15 155);
    --destructive: oklch(0.585 0.225 27);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --background: oklch(0.13 0.006 250);
      --foreground: oklch(0.97 0.005 250);
      --card: oklch(0.165 0.007 250);
      --muted-foreground: oklch(0.71 0.012 250);
      --border: oklch(1 0 0 / 0.08);
      --primary: oklch(0.97 0.005 250);
      --primary-foreground: oklch(0.21 0.01 250);
      --ring: oklch(0.66 0.17 280);
      --brand: oklch(0.7 0.18 280);
      --ok: oklch(0.72 0.16 155);
      --destructive: oklch(0.7 0.2 22);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    display: grid; place-items: center; padding: 24px;
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px; line-height: 1.5;
    font-feature-settings: "cv11", "ss01", "ss03";
    -webkit-font-smoothing: antialiased;
    color: var(--foreground);
    background: var(--background);
  }
  /* Same recipe as the app's sign-in card: bg-card, 1px border,
     rounded-2xl, shadow-sm — no gradients, no glow. */
  .card {
    width: 100%; max-width: 24rem;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 1rem;
    padding: 28px;
    box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  }
  .brand { display: flex; align-items: center; gap: 8px; margin-bottom: 20px; }
  .brand img { width: 28px; height: 28px; }
  .brand span {
    font-family: "Charter", "Iowan Old Style", "Apple Garamond", Baskerville, Georgia, "Times New Roman", serif;
    font-size: 18px; font-weight: 600; letter-spacing: -0.025em;
  }
  .status { display: flex; align-items: center; gap: 8px; min-height: 24px; }
  .spin {
    width: 16px; height: 16px; flex: none; border-radius: 50%;
    border: 2px solid var(--border); border-top-color: var(--brand);
    animation: r .7s linear infinite;
  }
  @keyframes r { to { transform: rotate(360deg); } }
  .glyph { width: 20px; height: 20px; flex: none; border-radius: 50%;
           display: none; align-items: center; justify-content: center;
           color: #fff; font-size: 12px; font-weight: 700; }
  h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
  p { margin: 8px 0 0; color: var(--muted-foreground); font-size: 13px; word-break: break-word; }
  .btn {
    display: none; width: 100%; height: 36px; margin-top: 20px; padding: 0 16px;
    font: inherit; font-weight: 500; font-size: 14px; cursor: pointer;
    color: var(--primary-foreground); background: var(--primary);
    border: 0; border-radius: 10px;
  }
  .btn:hover { opacity: .9; }
  .btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  /* State accents */
  .card.is-ok .glyph { display: inline-flex; background: var(--ok); }
  .card.is-ok .spin { display: none; }
  .card.is-ok .btn { display: block; }
  .card.is-err .glyph { display: inline-flex; background: var(--destructive); }
  .card.is-err .spin { display: none; }
  .card.is-err h1 { color: var(--destructive); }
</style>
</head>
<body>
<div class="card" id="card">
  <div class="brand">
    <img src="/oauth/logo.png" alt="" width="28" height="28">
    <span>Tokori</span>
  </div>
  <div aria-live="polite">
    <div class="status">
      <span class="spin" id="spin"></span>
      <span class="glyph" id="glyph"></span>
      <h1 id="title">Signing you in…</h1>
    </div>
    <p id="hint">Hold on while we hand the result back to Tokori.</p>
  </div>
  <button class="btn" id="closeBtn" type="button">Close window</button>
</div>
<script>
(async () => {
  const card = document.getElementById("card");
  const titleEl = document.getElementById("title");
  const hintEl = document.getElementById("hint");
  const glyphEl = document.getElementById("glyph");
  const set = (kind, title, hint) => {
    card.classList.remove("is-ok", "is-err");
    if (kind === "ok") { card.classList.add("is-ok"); glyphEl.textContent = "✓"; }
    else if (kind === "err") { card.classList.add("is-err"); glyphEl.textContent = "!"; }
    titleEl.textContent = title;
    hintEl.textContent = hint;
  };
  const closeBtn = document.getElementById("closeBtn");
  closeBtn.addEventListener("click", () => {
    // This tab was opened by the OS (the desktop app launched the
    // browser), not by a script — so a bare window.close() is refused
    // by Firefox always and by Chrome whenever the tab accumulated
    // history through the OAuth redirects. Try the plain close, then
    // the legacy self-open trick that still satisfies some engines,
    // and if the page is still alive after a beat, swap the dead
    // button for an honest instruction instead of silently no-opping.
    window.close();
    try { window.open("", "_self"); window.close(); } catch {}
    setTimeout(() => {
      closeBtn.style.display = "none";
      hintEl.textContent =
        "Your browser doesn't let pages close this tab themselves — press Ctrl+W (⌘W on Mac) and you're done.";
    }, 300);
  });
  try {
    const search = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.slice(1));
    const state = search.get("state");
    const token = hash.get("token");
    if (!state) throw new Error("Missing state.");
    if (!token) throw new Error("Missing token. Did sign-in finish?");
    const body = {
      state,
      token,
      user_id: Number(hash.get("user_id")) || null,
      email: hash.get("email") || null,
      expires_at: Number(hash.get("expires_at")) || null,
    };
    const r = await fetch("/oauth/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error("Server rejected sign-in (" + r.status + "): " + t.slice(0, 200));
    }
    set("ok", "Signed in", "You're all set — close this window and return to Tokori.");
    // Clear sensitive params from history so a "show all tabs" view
    // doesn't display the token in the URL bar. Best-effort: sign-in
    // already completed, so a history quirk must not repaint the card
    // as a failure.
    try { history.replaceState(null, "", "/oauth/callback"); } catch {}
  } catch (e) {
    set("err", "Sign-in failed", String(e && e.message ? e.message : e));
  }
})();
</script>
</body>
</html>"##;

async fn oauth_callback_page() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        // Defensive cache headers — the page contains zero secrets, but
        // we don't want a stale bouncer reused if we ship a fix.
        .header(header::CACHE_CONTROL, "no-store")
        .body(OAUTH_BOUNCER_HTML.into())
        .unwrap_or_else(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, "page build failed").into_response()
        })
}

/// The app icon, embedded at compile time so the bouncer always shows
/// the exact brand mark the rest of the app carries (public/logo.png —
/// the same file the title bar and the favicon use). Can't drift, and
/// the page needs no external hosts.
const APP_LOGO_PNG: &[u8] = include_bytes!("../../public/logo.png");

async fn oauth_logo() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, "public, max-age=86400")
        .body(APP_LOGO_PNG.into())
        .unwrap_or_else(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, "logo build failed").into_response()
        })
}

#[derive(Deserialize)]
struct OAuthFinishBody {
    state: String,
    token: String,
    user_id: Option<i64>,
    email: Option<String>,
    expires_at: Option<i64>,
}

#[derive(Serialize, Clone)]
struct OAuthCompleteEvent {
    state: String,
    token: String,
    user_id: i64,
    email: Option<String>,
    expires_at: Option<i64>,
}

async fn oauth_finish(
    State(state): State<AppState>,
    Json(body): Json<OAuthFinishBody>,
) -> Response {
    // Sanity-check the inputs before touching the broker. A forged
    // POST with a missing or non-numeric user_id should fail loudly so
    // we don't emit a malformed event to the frontend.
    if body.state.is_empty() || body.token.is_empty() {
        return err_response(
            StatusCode::BAD_REQUEST,
            "oauth.bad_request",
            "Missing state or token in OAuth completion payload.",
        );
    }
    let user_id = match body.user_id {
        Some(id) if id > 0 => id,
        _ => {
            return err_response(
                StatusCode::BAD_REQUEST,
                "oauth.bad_user_id",
                "Missing or invalid user_id.",
            );
        }
    };
    // State binding: a state we minted in `oauth_begin` MUST be
    // present in the broker. Without this guard a co-resident process
    // (or a malicious page that tricks the user into clicking a link)
    // could POST a forged token to /oauth/finish while no real
    // sign-in is in flight.
    if !state.oauth_broker.consume(&body.state) {
        return err_response(
            StatusCode::FORBIDDEN,
            "oauth.unknown_state",
            "OAuth state did not match a pending sign-in.",
        );
    }
    let payload = OAuthCompleteEvent {
        state: body.state,
        token: body.token,
        user_id,
        email: body.email,
        expires_at: body.expires_at,
    };
    if let Err(e) = state.app.emit("tokori:oauth-complete", payload) {
        log::error!("oauth_finish: failed to emit event: {e}");
        return err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "oauth.no_frontend",
            "Could not reach the desktop UI.",
        );
    }
    StatusCode::NO_CONTENT.into_response()
}
