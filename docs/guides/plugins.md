# Plugin SDK

The flashcards screen is plugin-backed: every "study mode" the
picker offers (Vocab Recall, Anki Classic, Sentence Mining, Hanzi
Writing, …) is a self-contained plugin under
`src/lib/study/plugins/`.

## Plugin shape

```ts
import type { StudyPlugin } from "@/lib/study/api";

const myPlugin: StudyPlugin = {
  meta: {
    id: "my-plugin",                  // stable kebab-case
    name: "My plugin",
    description: "What it does, in one line.",
    icon: SomeLucideIcon,
    supportedLangs: ["zh", "ja"],     // or omit for "every language"
  },
  StudyView: MyView,                  // the React component
  Settings: MySettings,               // optional per-plugin settings panel
};

export default myPlugin;
```

Then add the import to `src/lib/study/registry.ts`. That's the
entire registration step — no plugin manifest, no separate config.

## What `ctx` gives you

Every `StudyView` receives `{ ctx }: StudyViewProps`. The
`StudyContext` shape (defined in `src/lib/study/api.ts`):

| Field | Description |
| --- | --- |
| `ctx.workspace` | Active workspace (id + language pair). |
| `ctx.vocab` | Full vocab snapshot at session start. |
| `ctx.dueVocab` | Cards FSRS marked due today. |
| `ctx.reviewVocab(id, grade)` | Push an FSRS review back to the DB. |
| `ctx.setStatus(id, status)` | Manually set status (no FSRS impact). |
| `ctx.speak(text, lang?)` | Route text through the user's TTS provider. |
| `ctx.ensureSessionStarted(kind)` | Open a `study_sessions` row (counts toward streak). |
| `ctx.bump(kind)` | Increment a per-session counter. |
| `ctx.onSessionEnd(stats)` | **Required** — fire when done; host shows summary. |

Treat `ctx` as the only allowed coupling between plugins and the
rest of the app. Don't import `lib/db.ts` directly from a plugin —
the host owns the DB lifecycle.

## Persisting plugin settings

Use `usePluginSetting` for any pref you want to survive a reload:

```ts
import { usePluginSetting } from "@/lib/study/api";

function MySettings() {
  const [value, setValue, loaded] =
    usePluginSetting<boolean>("my-plugin", "showTooltips", true);
  return (
    <input
      type="checkbox"
      checked={value}
      onChange={(e) => setValue(e.target.checked)}
      disabled={!loaded}
    />
  );
}
```

Storage key is auto-namespaced as `plugin.<pluginId>.<key>` so two
plugins can't collide on the same field name.

The host renders `Settings` automatically under
**Settings → Study → Mode-specific settings**.

## Lifecycle

1. User opens **Flashcards** → plugin picker.
2. User taps a plugin → host mounts `<StudyView ctx={…} />`.
3. Plugin builds its own queue from `ctx.dueVocab` + `ctx.vocab`.
4. For each card: render → user grades → `ctx.reviewVocab(...)`.
5. Plugin runs out of cards → `ctx.onSessionEnd({stats})`.
6. Host unmounts plugin + renders the `SessionSummary` screen.

The plugin doesn't pick when to start a session —
`ctx.ensureSessionStarted("review")` in a `useEffect` on mount is
the convention. The host's session-context owns the actual DB
write.

## Helpers worth knowing

- `applyDailyLimits(pool, config)` — slices a card pool by the
  workspace's `dailyReviewLimit` + `dailyNewLimit`.
- `buildStudySessionQueue(due, allVocab, config)` — full pipeline
  used by the recall plugin AND the dashboard's "X cards due"
  badge, so the two surfaces never disagree.
- `useStudyConfig(workspaceId, lang)` — read/write the
  per-workspace study config (FSRS knobs, default plugin, audio
  prefs).

## Worked example — minimal plugin

```tsx
import { useState } from "react";
import type { StudyPlugin, StudyViewProps } from "@/lib/study/api";
import { Button } from "@/components/ui/button";

function StudyView({ ctx }: StudyViewProps) {
  const [idx, setIdx] = useState(0);
  const card = ctx.dueVocab[idx];

  if (!card) {
    return (
      <Button
        onClick={() =>
          ctx.onSessionEnd({
            cardsReviewed: idx,
            durationSecs: 0,
          })
        }
      >
        Done
      </Button>
    );
  }

  return (
    <div className="p-6">
      <p className="text-3xl">{card.word}</p>
      <Button
        onClick={async () => {
          await ctx.reviewVocab(card.id, "good");
          setIdx((i) => i + 1);
        }}
      >
        I knew it
      </Button>
    </div>
  );
}

const minimalPlugin: StudyPlugin = {
  meta: {
    id: "minimal-demo",
    name: "Minimal demo",
    description: "Tap the button if you knew the word.",
  },
  StudyView,
};

export default minimalPlugin;
```

Add `import minimalPlugin from "./plugins/minimal";` to
`src/lib/study/registry.ts` and the plugin appears in the picker.
