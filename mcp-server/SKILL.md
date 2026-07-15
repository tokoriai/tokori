---
name: tokori
description: Read and write the user's local Tokori language-learning database (workspaces, vocabulary, collections, dictionaries, immersion watch list) via the Tokori MCP server. Use whenever the user asks to add words, build a vocabulary collection, scrape vocabulary from a source, audit their study queue, look up dictionary entries, or manage their watch list of videos/series/podcasts.
---

# Tokori

Tokori is the user's local-first desktop language-learning app. This skill
gives you write access to their workspace database via MCP tools exposed by
the `tokori` MCP server (configured separately — see
`mcp-server/README.md`).

## When to invoke this skill

Trigger when the user asks to:

- **Scrape and import** vocabulary ("pull every word from this article and
  save it as a collection in my Chinese workspace")
- **Add a single word** to their vocab ("add 餐馆 to my vocab")
- **Create a themed collection** ("make a 'Travel' collection with these
  20 words")
- **Audit / inspect** their learning state ("what's in my review queue?",
  "list the collections in my Japanese workspace")
- **Look up a word** in their installed dictionary
- **Manage the immersion watch list** ("queue these five Peppa Pig
  episodes", "what am I currently watching?", "mark one more episode of
  Terrace House done")

Don't invoke it for general LLM chat about language learning — only when
the action involves reading or mutating the user's local database.

## How to use the tools

Always start by calling `list_workspaces` if you don't already know the
workspace id. A workspace pairs a target language with a native language
and owns its own vocab, collections, and notes. The user typically has one
workspace per language they study.

### Adding scraped vocabulary as a new collection (the headline workflow)

Use `import_collection`. It's a one-shot batch: creates the collection and
upserts/links every word in a single call. Returns counts so you can tell
the user "added 47 new, 8 already known, 0 skipped".

```jsonc
// import_collection
{
  "workspace_id": 3,
  "name": "Tatoeba — animals (2026-05)",
  "description": "Scraped from https://example.com/animals on 2026-05-07",
  "words": [
    { "word": "猫", "reading": "māo", "gloss": "cat" },
    { "word": "狗", "reading": "gǒu", "gloss": "dog" }
    // …
  ]
}
```

Tips:

- `reading` and `gloss` are optional but **strongly recommended** — without
  them the user has to manually fill them in later. If the source doesn't
  include them, call `search_dict` first to enrich each word.
- Idempotent: re-importing the same words against a different collection
  links the existing vocab entries (preserving FSRS state) instead of
  duplicating them. Reuse this freely.
- The `description` field is a great place to record provenance — source
  URL, date, scraper notes — so the user can trace where each batch came
  from later.

### Adding to an existing collection

Use `add_words_to_collection`. Pass `vocab_ids` to link existing entries,
or `words` to upsert + link new ones. Mix-and-match in one call:

```jsonc
{
  "collection_id": 12,
  "vocab_ids": [501, 502],
  "words": [{ "word": "馬", "reading": "mǎ", "gloss": "horse" }]
}
```

### Single-word add

Use `create_vocab`. Pass `collection_id` to drop it straight into a
collection in the same call:

```jsonc
{
  "workspace_id": 3,
  "word": "餐馆",
  "reading": "cānguǎn",
  "gloss": "restaurant",
  "collection_id": 12
}
```

### Building an immersion watch list

`list_media` / `add_media` / `update_media` manage the Immersion view —
the user's queue of videos, series, and podcasts with watch progress.

```jsonc
// add_media — queue a video for later
{
  "workspace_id": 3,
  "title": "Slow Chinese — Ep. 12: At the market",
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "author": "Slow Chinese",
  "total_units": 22          // minutes for videos, episodes for series/podcasts
}
```

Tips:

- **Always pass the `url` when you have one.** Linked items open in the
  user's browser from the app, the Companion browser extension recognises
  them and tracks watch progress automatically, and re-adding the same
  link is idempotent (you get the existing item back, never a duplicate).
- `kind` (`video` | `series` | `podcast`) is inferred from the URL when
  omitted — a YouTube playlist becomes a `series`, Spotify/Apple links
  become `podcast`s.
- New items land in status `planned` (the "Up next" queue). The list is
  Refold-style curation: when recommending content, match the user's
  level and put the easiest material first.
- Progress bumps go through `update_media` with **deltas**:
  `{ "media_id": 7, "delta_units": 1 }` marks one more episode done;
  `{ "media_id": 7, "status": "finished" }` moves it to the trophy shelf.

### Filling in readings / glosses from the dictionary

If your source only gives you headwords, call `search_dict` per word to
enrich:

```jsonc
{ "lang": "zh", "q": "餐馆", "limit": 5 }
```

Take the top match's `reading` and `gloss` and pass them to
`create_vocab` / `import_collection`.

## Conventions

- **Status filter values** for `list_vocab`: `new` | `learning` | `review`
  | `mastered`. Match the FSRS scheduler's lifecycle.
- **Language codes** are ISO 639-1 (`zh`, `ja`, `ko`, `de`, `es`, `fr`,
  `it`, `pt`, `en`). The dictionary search is per-language.
- **Source field** on vocab is auto-set to `"api"` when created via this
  skill — that's how the dashboard distinguishes scraped imports from
  hand-typed words and chat tags.
- **Counts in responses** (`added`, `existed`, `skipped`) are the source of
  truth for what to report to the user. Don't claim "added 50 words" if
  the response says `{ added: 47, existed: 3, skipped: 0 }` — say "added
  47 new words; 3 were already in your vocab".

## Failure modes to watch for

- **`network.unreachable`** → the desktop app isn't running or the local
  API is off. Tell the user to open Tokori and start the local API
  (Settings → Local API → Start). Don't keep retrying.
- **`auth.invalid_token`** → the token rotated. Tell the user to restart
  the desktop app and the MCP server.
- **`validation.empty_word` / `empty_name`** → you sent a blank string;
  filter your input.
- **`not_found.collection`** → the `collection_id` doesn't exist (or got
  deleted). Re-list collections to recover.

## Don't

- Don't bulk-delete collections or vocab without an explicit user request.
  The MCP server doesn't expose delete endpoints by design — if you need
  to remove something, ask the user to do it from the desktop UI.
- Don't fabricate readings/glosses. If `search_dict` returns nothing,
  leave the field empty rather than guessing — the user can fill it later.
- Don't dump huge JSON blobs back to the user. Summarise: "Created
  collection 'Travel' (id 14) with 23 words: 21 new, 2 already known."
