# Build from source

Clone the repo, install Node + Rust + Tauri's platform deps, and
run the dev / build commands below.

## Prerequisites

| Tool | Minimum | Notes |
| --- | --- | --- |
| Node | 20 | `nvm install 20` if you don't have it. |
| Rust | 1.85 stable | The OCR pipeline needs Rust 2024 edition. |
| Tauri prerequisites | latest | <https://tauri.app/start/prerequisites/> — installs WebKitGTK on Linux, Visual Studio Build Tools on Windows. |

## Clone + install

```sh
git clone https://github.com/tokoriai/tokori.git
cd tokori
npm install
```

## Run

::: code-group

```sh [Browser only]
# Fast iteration on the UI. Vite dev server at http://localhost:5173.
# Desktop-only paths (Ollama warm-up, OCR, FastEmbed) won't work
# here — they're behind isTauri() guards — but the chat UI,
# flashcards, and most library views work against the in-memory
# fallback store.
npm run dev
```

```sh [Full desktop app]
# First run compiles ~500 Rust crates (~15 min on a fresh
# machine); subsequent runs incremental-build in seconds.
npm run tauri dev
```

:::

## Production build

```sh
npm run build           # type-check + Vite build → dist/
npm run tauri build     # full installer → src-tauri/target/release/bundle/
```

Bundle paths after `npm run tauri build`:

- macOS: `src-tauri/target/release/bundle/dmg/Tokori_*.dmg`
- Windows: `src-tauri/target/release/bundle/msi/Tokori_*.msi`
- Linux: `src-tauri/target/release/bundle/{appimage,deb}/`

## Hosted variant

There's a second flavour of the same UI — a browser-only build
that runs at `app.tokori.ai`, gated by sign-in + Pro
subscription, and talks to the cloud backend instead of local
providers.

```sh
npm run dev:hosted     # dev server
npm run build:hosted   # static bundle → dist-hosted/
```

The `HOSTED` flag in `src/lib/build-flags.ts` is a build-time
constant, so terser dead-code-eliminates anything behind
`if (HOSTED) {…}` from the desktop bundle and vice-versa.

## Common issues

::: details Linux: `error: Tauri requires WebKitGTK 4.1`
Install: `sudo apt install libwebkit2gtk-4.1-dev libssl-dev`. On
Fedora it's `webkit2gtk4.1-devel`.
:::

::: details macOS: `xcrun: error: invalid active developer path`
`xcode-select --install` to grab the command-line tools.
:::

::: details Windows: the Rust build can't find a linker
Install [Visual Studio Build Tools] with the **Desktop development
with C++** workload.
:::

::: details Cargo can't find the crate after a directory rename
`cargo clean && cargo build` — the build cache stores absolute
paths.
:::

[Visual Studio Build Tools]: https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022

## Project layout

```
tokori/
├── src/                       # React 19 + TS frontend
│   ├── components/
│   │   ├── shell/             # Sidebar + main layout
│   │   ├── settings/          # Settings panels (one per section)
│   │   ├── views/             # Top-level tab views (chat, reader, …)
│   │   └── ui/                # shadcn primitives
│   └── lib/
│       ├── db.ts              # SQLite + in-memory fallback CRUD
│       ├── study/             # SRS plugin host + plugins/
│       ├── fsrs.ts            # FSRS-5 scheduler
│       └── …
├── src-tauri/                 # Rust shell
│   ├── src/
│   │   ├── lib.rs             # Tauri entry, tray, IPC
│   │   ├── commands.rs        # #[tauri::command] handlers
│   │   ├── providers.rs       # LLM provider streaming
│   │   ├── api_server.rs      # Local HTTP API
│   │   ├── fastembed_local.rs # Local embedding model wrapper
│   │   └── ocr.rs             # ONNX Paddle-OCR pipeline
│   └── tauri.conf.json
├── docs/                      # This documentation site (VitePress)
├── mcp-server/                # MCP server exposing the local API
├── packs/                     # Free starter packs (HSK 1, …)
├── test/                      # Vitest unit tests
└── .github/workflows/         # CI + release + docs pipelines
```
