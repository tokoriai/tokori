# Providers

Tokori is provider-agnostic. Pick whatever LLM backend you have
keys for (or run one locally) — the chat UI, flashcards, and reader
all work the same regardless.

## Built-in providers

| Provider | Local? | Streaming | Notes |
| --- | --- | --- | --- |
| [Ollama](#ollama) | ✓ | ✓ | Easiest local setup. Pulls models from <https://ollama.com>. |
| [OpenAI](#openai) | – | ✓ | GPT-4o, GPT-4 mini, etc. |
| [Anthropic](#anthropic) | – | ✓ | Claude Sonnet 4.6, Opus 4.7. |
| [Gemini](#gemini) | – | ✓ | Gemini 1.5 Pro / Flash. |
| [OpenRouter](#openrouter) | – | ✓ | Aggregates 200+ models behind one key. |
| [MiniMax](#minimax) | – | ✓ | Cheap, fast Chinese-tuned. |

## Switching the active provider

Settings → Providers → click **Use** on a configured row. The
active provider applies immediately to chat, the reader's "Explain
this" button, and the flashcards AI helper.

## Ollama

1. Install Ollama from <https://ollama.com/download>.
2. `ollama pull llama3.1` (or any model).
3. In Tokori: Settings → Providers → Add → **Ollama**.
4. Host: `http://localhost:11434` (default — change if you're
   reaching a remote daemon).
5. Pick the model from the dropdown (Tokori queries `/api/tags` to
   list pulled models).

::: tip Cold-start latency
Ollama lazy-loads weights on the first real request. Tokori warms
the model the moment you click **Use** on an Ollama provider — the
first chat after a session start should be hot. Subsequent restarts
re-pay the cold load on the first message.
:::

## OpenAI

1. Get a key from <https://platform.openai.com/api-keys>.
2. Settings → Providers → Add → **OpenAI**.
3. Paste the key. Pick a model.
4. Optional: set a custom `base_url` to point at any
   OpenAI-compatible endpoint (DeepSeek, Together, vLLM, …).

## Anthropic

1. Get a key from <https://console.anthropic.com/>.
2. Add as **Anthropic** with model id like `claude-sonnet-4-6`.
3. The streaming uses the Messages API + Anthropic-version header
   under the hood.

## Gemini

1. Get a key from <https://aistudio.google.com/apikey>.
2. Add as **Gemini** with model `gemini-1.5-pro` or `-flash`.

## OpenRouter

1. Get a key from <https://openrouter.ai/keys>.
2. Add as **OpenAI** (it's OpenAI-compatible) with
   `base_url: https://openrouter.ai/api/v1`.
3. Model id can be any of OpenRouter's catalog
   (e.g. `anthropic/claude-sonnet-4-6`).

## MiniMax

1. Get a key from <https://www.minimaxi.com>.
2. Add as **MiniMax** with model `MiniMax-M2-7B-Instruct` or
   whichever you've selected.

## Adding a new provider

The provider abstraction lives in
`src-tauri/src/providers.rs` — one `ProviderConfig` enum variant +
a streaming function per kind. New providers are usually a 100-line
PR. See [Contributing](/guides/contributing) for the full process.
