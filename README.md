# Tokori

[![CI](https://github.com/tokoriai/tokori/actions/workflows/ci.yml/badge.svg)](https://github.com/tokoriai/tokori/actions/workflows/ci.yml)
[![Docs](https://github.com/tokoriai/tokori/actions/workflows/docs.yml/badge.svg)](https://tokori.ai/docs/)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)

A local-first desktop tutor for language learners. Chat with a model in
your target language, click any word to define it, save vocab, and
review it with spaced repetition — all running on your machine, against
the model provider of your choice.

- **Local-first.** Your workspaces, vocab, and chat history live in a
  SQLite file on disk. No account required.
- **Bring your own model.** Ollama, OpenAI, Anthropic, Gemini,
  OpenRouter, or MiniMax. Keys stay in local storage and only leave
  your machine for the provider you configured them for.
- **Click-to-define on every word.** Hover or click any character in
  the chat or reader for reading, gloss, and POS. Backed by
  CC-CEDICT, JMdict, and other open dictionaries (plus user imports).
- **FSRS spaced repetition.** Words saved from chat or the reader flow
  into a flashcard deck scheduled by FSRS-5.
- **Reader.** Import a book, article, or YouTube transcript and read
  it with click-to-define everywhere.
- **Scriptable.** A local HTTP API and bundled MCP server expose
  workspace reads + writes to external tools.

Built on Tauri 2 (Rust shell) + React 19 + TypeScript. AGPL-3.0 licensed.

## Demo

<!--
  DEMO VIDEO — replace the line below with an uploaded clip.
  How to host it on GitHub (no external service needed): open this file
  in the web editor (github.com/tokoriai/tokori/edit/main/README.md) and
  drag a short MP4 (H.264, ~30–60 s, ideally <10 MB) into the editor.
  GitHub uploads it and inserts a `https://github.com/user-attachments/
  assets/<uuid>` URL that renders as an inline <video> player on the repo
  page. A plain link to a raw .mp4 does NOT auto-embed — the drag-and-drop
  upload flow is what produces the player. Keep this comment for whoever
  refreshes the clip later.
-->

> 📹 _Demo video coming soon — drag an MP4 here (see the comment above)._

Prefer to click around yourself? **[Try the live demo →](https://tokori.ai)**
— the homepage embeds a sandbox that runs entirely in your browser on
seeded sample data, no install or account required.

## Install

Pre-built binaries for macOS, Windows, and Linux are on the
[Releases page](https://github.com/tokoriai/tokori/releases) — `.dmg` for
macOS, a setup `.exe` for Windows, and `.deb`/`.rpm`/`.AppImage` for Linux.

On Linux, install via your package manager:

```sh
sudo apt install ./tokori_*.deb     # Debian / Ubuntu
sudo dnf install ./tokori-*.rpm     # Fedora / RHEL
yay -S tokori-bin                   # Arch (AUR)
```

…or the one-line installer (auto-detects `.deb` on apt systems and `.rpm`
on dnf/zypper, else falls back to the portable AppImage):

```sh
curl -fsSL https://tokori.ai/install.sh | bash
```

Per-platform notes (first-launch quarantine bypass, AppImage, data
location) live in the [install guide](https://tokori.ai/docs/guides/install).

## Quickstart

1. Launch Tokori and pick your **target language** + **native
   language**.
2. Open **Settings → Providers**, add a provider (e.g. Ollama at
   `http://localhost:11434`), and click **Use**.
3. Open **Conversation**, type something in your target language, and
   click any word in the reply to define it. Click **+** to save it.
4. Open **Flashcards** to review saved words on the FSRS schedule.

The full walk-through is in the [quickstart guide](https://tokori.ai/docs/guides/quickstart).

## Build from source

Prerequisites:

- Node 20+
- Rust stable (1.85 or newer)
- Tauri's platform dependencies — see <https://tauri.app/start/prerequisites/>

```sh
git clone https://github.com/tokoriai/tokori.git
cd tokori
npm install

npm run tauri dev      # full desktop app (slow first compile)
npm run dev            # browser-only UI on http://localhost:5173

npm run tauri build    # produce a release bundle
```

The bundled installer ends up in `src-tauri/target/release/bundle/`.

More detail in the [build-from-source guide](https://tokori.ai/docs/guides/build-from-source)
and the [architecture overview](https://tokori.ai/docs/guides/architecture).

## Documentation

- [Quickstart](https://tokori.ai/docs/guides/quickstart)
- [Install](https://tokori.ai/docs/guides/install)
- [Architecture](https://tokori.ai/docs/guides/architecture)
- [Providers](https://tokori.ai/docs/guides/providers)
- [Dictionaries](https://tokori.ai/docs/guides/dictionaries)
- [Vocabulary & SRS](https://tokori.ai/docs/guides/vocabulary)
- [Reader](https://tokori.ai/docs/guides/reader)
- [HTTP API reference](https://tokori.ai/docs/reference/api)
- [MCP server](https://tokori.ai/docs/guides/mcp)
- [Addons](https://tokori.ai/docs/guides/addons)

The full table of contents lives at <https://tokori.ai/docs/>.

## Project layout

```
src/                    React 19 + TypeScript frontend
  components/             UI (shadcn/ui + Tailwind 4)
  lib/                    State, providers, dict, FSRS, sync
src-tauri/              Rust shell (Tauri 2)
  src/commands.rs         Tauri IPC handlers
  src/api_server.rs       Local HTTP API (axum, bearer auth)
  src/providers.rs        LLM streaming pipeline
mcp-server/             MCP companion (Node, agent-facing)
docs/                   VitePress site (tokori.ai/docs)
test/                   Vitest suite
```

See the [architecture guide](https://tokori.ai/docs/guides/architecture)
for the longer tour.

## Contributing

Issues and pull requests are welcome. Before opening a PR, run:

```sh
npm test
npm run build
cargo fmt --all -- --check       # in src-tauri/
cargo clippy --all-targets -- -D warnings
```

The contribution flow, coding conventions, and PR expectations live in
[CONTRIBUTING.md](./CONTRIBUTING.md).

To report a security issue privately, see [SECURITY.md](./SECURITY.md).
The community guidelines live in
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

Tokori's own source is [AGPL-3.0-or-later](./LICENSE). It bundles CJK stroke-order data
and downloads dictionaries that carry their own licenses — see
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
