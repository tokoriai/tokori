# Architecture

A 30,000-foot view of how the pieces fit together.

## High level

```
                       ┌─────────────────────────────┐
                       │      Tauri WebView          │
                       │  (React 19 + Vite bundle)   │
                       └──────────────┬──────────────┘
                                      │
     ┌────────────────────────────────┼────────────────────────────┐
     │ IPC (invoke + Channel)         │ window.fetch (provider     │
     │                                │  HTTP, when bypassing Rust │
     │                                │  makes sense)              │
     ▼                                ▼
┌─────────────────────┐      ┌─────────────────────────────────┐
│  Rust shell         │      │   Local HTTP API (axum)         │
│  src-tauri/src/     │ ────►│   127.0.0.1:53210, bearer-auth  │
│   lib.rs            │      │   src-tauri/src/api_server.rs   │
│   commands.rs       │      └─────────────────────────────────┘
│   providers.rs      │                ▲
│   …                 │                │
└─────────┬───────────┘                │
          │                            │
          ▼                            │
┌─────────────────────┐                │
│  SQLite             │ ◄──────────────┘
│  ~/.config/         │   (read-only by default; write requires
│  ai.tokori.desktop/    │    the bearer token)
│  tokori.db          │
└─────────────────────┘
```

The webview owns UI state; the Rust shell brokers anything that
needs filesystem / network / native access. The local HTTP server
is a separate surface — it's how external tools (MCP clients,
custom scripts) read your workspace.

## Frontend

### Routing — there isn't one

There's no router. The shell is a single-screen app with a tab
switcher in the sidebar. Each tab is a top-level component under
`src/components/views/`.

Why no router? URLs don't matter for a desktop app — the user
isn't deep-linking — and skipping React Router saves a dependency.
The hosted variant might add a router shim later if it needs deep
links.

### Provider abstraction

Every LLM call goes through one interface (`ChatProvider` in
`src/lib/provider-context.tsx`). Concrete implementations:

| Kind | Where | Notes |
| --- | --- | --- |
| `ollama` | `src-tauri/src/providers.rs` | Streams via Rust → IPC channel |
| `openai` | `src-tauri/src/providers.rs` | Same shape |
| `anthropic` | `src-tauri/src/providers.rs` | Same shape |
| `gemini` | `src-tauri/src/providers.rs` | Same shape |
| `minimax` | `src-tauri/src/providers.rs` | OpenAI-compatible endpoint |
| `tokori-cloud` | `src/lib/provider-context.tsx` | JS-side fetch + SSE; bypasses Rust |

Switching the active provider in Settings → Providers immediately
routes the next message to the new backend without app reload.

### Build-time feature flags

`src/lib/build-flags.ts` exports `HOSTED`, a `boolean` constant
sourced from `VITE_HOSTED_MODE`. Two consequences:

1. Anything inside `if (HOSTED) { … }` (or `if (!HOSTED) { … }`)
   gets dead-code-eliminated by terser in the *other* build's
   bundle. The hosted bundle never ships FastEmbed bindings, the
   PDF importer, or the knowledge-FTS module.
2. `HOSTED=true` triggers `<AuthGate>` at the root, which blocks
   the tree from mounting until the user signs in to Tokori Cloud
   and has an active Pro subscription.

A third runtime mode — `?demo=1` — bypasses the AuthGate and seeds
the in-memory store with sample data. That's what the marketing
demo iframe uses.

## Rust shell

### Tauri commands

`#[tauri::command]` handlers live in `src-tauri/src/commands.rs`
and the streaming pipeline in `src-tauri/src/providers.rs`.
Frontend calls them with `invoke()` — typed via
`@tauri-apps/api/core`.

Streaming chats use a `tauri::ipc::Channel` rather than a one-shot
return, so each token reaches the UI as it lands.

### Local HTTP API

`src-tauri/src/api_server.rs` runs an axum server on
`127.0.0.1:53210` from app start. Bearer-token auth, token written
to `~/.tokori/api-token` on first launch. The MCP companion server
(`mcp-server/`) reads the token and proxies the API to MCP clients.

See [API reference](/reference/api).

### Native dependencies

| Crate | Used for | Why this one |
| --- | --- | --- |
| `tauri-plugin-sql` | SQLite access from JS | Standard Tauri pattern |
| `paddle-ocr-rs` | OCR on screenshot imports | ONNX, no Python runtime |
| `fastembed` | Local embedding generation | Same — pure Rust + ONNX |
| `jieba-rs` | Chinese tokenisation | Standard implementation |
| `quick-xml` | JMdict / dictionary XML parsing | Faster than `xml-rs` |

## Storage

The app DB is created lazily via `tauri-plugin-sql`'s preload +
runtime migrations. Schema details: [Storage & data](/guides/data).

## Sync

Cloud sync is opt-in. `src/lib/sync.ts` handles backup + restore
against the cloud's `/api/v1/sync/{push,pull}` endpoints. The
hosted variant uses the same plumbing in a tighter loop —
debounced ~1.5s per mutation.
