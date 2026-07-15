# Changelog

All notable changes to Tokori are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-alpha.2] — 2026-07-15

Immersion, on-device voice, and richer content packs.

- **Immersion** — a new watch/listen shelf for videos, series, and podcasts, with progress tracking and an "Up next" queue. Browser-extension beats and MCP deltas keep watched-minutes in sync.
- **Local speech-to-text** — on-device Whisper transcription; dictate to the tutor with no audio leaving your machine.
- **Voice "Ask" mode** — speak a question and get a streaming spoken reply, with a live mic waveform.
- **Live voice** — unified OpenAI, Qwen, and cloud voice providers on a shared streaming audio pipeline.
- **Custom title bar** — native-feeling window chrome on Windows, Linux, and macOS.
- **Content packs** can now recommend media; imported items land in the Up-next queue.
- Local HTTP API and MCP server gain media read/write (`list_media`, `add_media`, `update_media`).

## [0.1.0-alpha.1] — 2026-07-02

First public alpha.

- Local-first desktop tutor (Tauri 2 + React 19 + TypeScript).
- Bring-your-own-model chat: Ollama, OpenAI, Anthropic, Gemini, OpenRouter, MiniMax.
- Click-to-define on every word, backed by CC-CEDICT, JMdict, and user imports.
- FSRS-5 spaced repetition for words saved from chat or the reader.
- Reader for books, articles, and YouTube transcripts.
- Local HTTP API + bundled MCP server for scripting workspaces.

[Unreleased]: https://github.com/tokoriai/tokori/compare/v0.1.0-alpha.2...HEAD
[0.1.0-alpha.2]: https://github.com/tokoriai/tokori/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/tokoriai/tokori/releases/tag/v0.1.0-alpha.1
