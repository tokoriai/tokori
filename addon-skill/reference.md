# Tokori addon — contract reference

Everything an addon author (or an agent acting as one) needs. The manifest
schema and per-kind contracts are **frozen** — they won't change shape when
sandboxed execution (Stage 2) ships.

## Manifest (`manifest.json`)

```json
{
  "id": "markdown-vocab-list",
  "name": "Markdown vocab list",
  "version": "1.0.0",
  "description": "Import 'word (reading) — meaning' lines.",
  "kind": "vocab-import",
  "entry": "entry.js",
  "author": "you@example.com",
  "homepage": "https://github.com/you/markdown-vocab-list",
  "license": "MIT",
  "minAppVersion": "0.1.0"
}
```

| Field | Required | Rule |
| --- | --- | --- |
| `id` | ✅ | `^[a-z][a-z0-9-]{2,63}$` — kebab-case, starts with a letter. **Stable install key; never rename.** |
| `name` | ✅ | Non-empty display name. |
| `version` | ✅ | Semver: `1.0.0`, `2.1.3-beta.1`. |
| `description` | ✅ | One-line pitch. |
| `kind` | ✅ | `study` \| `translate` \| `vocab-import` \| `card-enrichment`. |
| `entry` | ✅ | Relative path to the JS entry inside the folder. No `..`, no leading `/`. `.js`/`.mjs` both fine. |
| `author` | – | Free-form byline. |
| `homepage` | – | URL, shown as "More info". |
| `license` | – | SPDX string, e.g. `MIT`. |
| `minAppVersion` | – | Warn-only if the app is older. |

## Entry point shape

The entry file is an ES module. Its **default export** is an object matching the
contract for the manifest's `kind`. The host never reads named exports.

```js
export default { meta, /* + the kind's method(s) */ };
```

Hard boundary: an addon gets **no** direct access to the database, `fetch`, or the
DOM. Pure kinds (`vocab-import`) are pure functions; the others receive a
capability object (`ctx` / request) from the host. Don't import from the app.

---

## kind: `vocab-import`  ⭐ easiest

```ts
type ImportRow = {
  word: string;                 // required, the headword
  altWord?: string | null;      // traditional form / kanji fallback
  reading?: string | null;      // pinyin / furigana / romanisation
  gloss?: string | null;        // definition / translation
  source?: string;              // provenance, written to vocab_entries.source
  srsHint?: { status: "new"|"learning"|"review"|"mastered"; intervalDays?: number };
};

type VocabImporter = {
  meta: {
    id: string;                 // matches manifest.id
    name: string;
    description: string;
    fileExt: string[];          // accepted extensions, NO leading dot: ["txt","md"]
    supportedLangs?: string[];  // ISO codes; omit = every language
    excludedLangs?: string[];
  };
  parse: (text: string) => ImportRow[];   // PURE: no IO, no side effects
};
export default /* VocabImporter */;
```

The host handles dictionary lookup, translation fallback, preview, and writing to
the DB. Your `parse` only turns file text into rows. See `templates/vocab-import/`.

---

## kind: `translate`  ⭐⭐

```ts
type TranslateRequest = {
  source: string;               // workspace target-lang code
  target: string;               // workspace native-lang code
  texts: string[];              // words/phrases to translate, in order
  config: { apiKey: string|null; baseUrl: string|null; /* …per-engine row */ };
};

type TranslateEngine = {
  meta: {
    kind: string;               // engine id (matches manifest.id by convention)
    name: string;
    description: string;
    fields: ("apiKey"|"secondaryKey"|"baseUrl"|"provider"|"model")[]; // inputs to show
    zeroConfig?: boolean;       // true if it works with no user config
  };
  // MUST return an array the SAME length as texts. Missing entries → "" (don't
  // throw for the whole batch).
  translate: (req: TranslateRequest) => Promise<string[]>;
};
export default /* TranslateEngine */;
```

---

## kind: `card-enrichment`  ⭐⭐⭐

Fills in fields on a card draft (an example sentence, a cloze, audio, …). Returns
a **patch** of only the fields it changed (`undefined` = leave alone, `null` =
clear). Never overwrite a non-empty user field unless explicitly forced.

```ts
type CardDraft = {
  workspaceId: number; targetLang: string; nativeLang: string;
  word: string; kind: "vocab"|"sentence"|"writing";
  reading: string|null; gloss: string|null;
  frontExtra: string|null;   // cloze "{{c1::word}}"
  cardNotes: string|null;    // serialised example sentences
  imageData: string|null; audioBytes: Uint8Array|null; audioMime: string|null;
};
type CardPatch = Partial<Omit<CardDraft,
  "workspaceId"|"targetLang"|"nativeLang"|"word"|"kind">>;

type EnricherContext = {
  sendChat: ((args) => Promise<string>) | null;     // route through the user's LLM
  synthesize: ((text, lang) => Promise<{bytes,mime}>) | null;  // TTS
  lookupDict: (lang, word) => Promise<DictEntry|null>;
  knownVocab: () => Promise<VocabEntry[]>;
  translateFallback?: (src, tgt, text) => Promise<string|null>;
};

type CardEnricher = {
  meta: {
    id: string; name: string; description: string;
    targets: (keyof CardPatch)[];          // fields it writes
    trigger: "auto" | "manual";            // auto on word change, or manual button
    languages?: string[] | "*";
    priority?: number;
  };
  run: (draft: CardDraft, ctx: EnricherContext) => Promise<CardPatch>;
};
export default /* CardEnricher */;
```

Rule: `run` must be resilient — catch internal errors and return `{}` rather than
throwing.

---

## kind: `study`  ⭐⭐⭐⭐ (most involved — owns a React UI)

```ts
type StudyPlugin = {
  meta: { id: string; name: string; description: string;
          supportedLangs?: string[]; excludedLangs?: string[] };
  StudyView: ReactComponent<{ ctx: StudyContext }>;
  Settings?: ReactComponent;   // optional, mounted under Settings → Study
};
```

`StudyContext` gives the view: `workspace`, `vocab`, `dueVocab`,
`reviewVocab(cardId, grade)`, `setStatus(cardId, status)`, `speak(text, lang?)`,
`ensureSessionStarted(kind)`, `bump(counter)`, `onSessionEnd(stats)`, plus
`drillMode`/`setDrillMode` and `srsAnchorState`. Render one card at a time, call
`reviewVocab` on each grade, and `onSessionEnd` when finished. Because this needs
React in a sandbox, it's the hardest kind — prefer the others unless a custom
study UI is the whole point.

---

## How the app reads addons (so you know what "working" means)

1. On launch / Settings → Addons open, the app scans `addons/*/manifest.json`.
2. Each manifest is validated (the rules above). Failures show their reason in the
   UI; valid ones are listed with an enable toggle. Enable state is saved as
   `addon.<id>.enabled`.
3. (Stage 2, not yet shipped) Enabled addons' `entry` JS is loaded in a sandbox,
   its default export validated against the `kind`'s contract, and merged into the
   matching built-in registry (`STUDY_PLUGINS`, importers, translate engines, …).
