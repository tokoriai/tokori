# Quickstart

Get Tokori installed, point it at a model, and have your first
target-language conversation in two minutes.

## Install

Download a release for your OS from the
[Releases page](https://github.com/tokoriai/tokori/releases) and
run the installer. See the [full install guide](/guides/install)
for per-platform notes.

## Pick a workspace

On first launch you'll be asked for your **target language** (the
one you're studying) and your **native language** (the one
explanations should appear in). Pick the pair, name your workspace
if you want — done. You can add more later for other languages.

## Add a provider

Settings → Providers → Add. Pick the provider that matches your
setup:

- **Ollama** if you're running models locally. Default host is
  `http://localhost:11434`. Tokori will list the models you've
  pulled and let you pick one.
- **OpenAI / Anthropic / Gemini / OpenRouter** if you want a cloud
  model. Paste your API key; pick a model from the dropdown.
- **MiniMax** for cheap fast Chinese-tuned chat.

Whichever you pick, click **Use** to set it as the active provider.

::: tip
Keys never leave your machine — they're stored locally in SQLite
and only sent to the provider you configured them for.
:::

## Have a conversation

Click **Conversation** in the sidebar (or press the keyboard
shortcut for the chat tab). Type something in your target
language. The tutor replies in target language with click-to-define
words: hover or click any character to see its reading + meaning.

Click the **+** next to a word to save it to your vocabulary list —
it'll appear in your next flashcards session.

## Review your vocab

Click **Flashcards** → pick **Vocab Recall** (or whatever the
default is for your language). You'll see your saved words
spaced-repetition-scheduled by FSRS.

After you finish the recall round, the optional
[production round](/guides/vocabulary#production-round) drills the
same words in the other direction (gloss → word).

## What's next?

- Set up the [reader](/guides/reader) to ingest a book or article
  with click-to-define on every word.
- Wire your [dictionaries](/guides/dictionaries) — bundled
  CC-CEDICT for Chinese, JMdict for Japanese, plus user imports.
- Connect [an MCP client](/reference/api) to
  script your workspace.
