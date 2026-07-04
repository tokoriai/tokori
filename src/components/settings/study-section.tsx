/**
 * Per-workspace study settings.
 *
 * Surfaces `useStudyConfig` as a small form so the user can tune SRS
 * limits, pick a default study plugin per workspace, and choose whether
 * the reading is hidden until reveal. Saves on each change — no separate
 * "save" step.
 */

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStudyConfig } from "@/lib/study-config";
import {
  DEFAULT_FSRS_WEIGHTS,
  PRESET_LABEL,
  SRS_PRESETS,
  type PresetId,
  type SRSConfig,
} from "@/lib/fsrs";
import { pluginsForLanguage } from "@/lib/study/registry";
import { useWorkspace } from "@/lib/workspace-context";
import { languageName, type LanguageCode } from "@/lib/languages";

export function StudySection() {
  const { active: workspace } = useWorkspace();
  const lang = (workspace?.targetLang ?? "en") as LanguageCode;
  const { config, loaded, set } = useStudyConfig(workspace?.id ?? null, lang);

  if (!workspace) return null;

  const plugins = pluginsForLanguage(lang);
  // A stored default that's no longer registered (e.g. the retired
  // anki-classic "Spaced repetition" mode) would leave the Select blank.
  // Fall back to the first available mode so it always shows something
  // valid; the corrected value persists the next time the user picks.
  const selectedDefault = plugins.some((p) => p.meta.id === config.defaultPlugin)
    ? config.defaultPlugin
    : (plugins[0]?.meta.id ?? "");

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Study</h2>
        <p className="text-[13px] text-muted-foreground">
          Per-workspace flashcard settings. Currently configuring{" "}
          <span className="font-medium text-foreground">
            {languageName(workspace.targetLang)}
          </span>{" "}
          — switch workspaces to tune the others independently.
        </p>
      </div>

      <fieldset className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:grid-cols-2" disabled={!loaded}>
        <div className="grid gap-1.5">
          <Label>Default study mode</Label>
          <Select
            value={selectedDefault}
            onValueChange={(v) => void set("defaultPlugin", v)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {plugins.map((p) => (
                <SelectItem key={p.meta.id} value={p.meta.id}>
                  <div className="flex flex-col">
                    <span className="font-medium">{p.meta.name}</span>
                    <span className="text-[11.5px] text-muted-foreground">
                      {p.meta.description}
                    </span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            What opens when you tap Flashcards. The picker on the study page
            still lets you swap modes any time.
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label>Reading display</Label>
          <Select
            value={config.readingMode}
            onValueChange={(v) => void set("readingMode", v as "hidden" | "shown")}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hidden">
                Hidden until reveal — drill the reading too
              </SelectItem>
              <SelectItem value="shown">
                Show alongside the word — drill only the meaning
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            CJK workspaces default to hidden — you actively recall pinyin /
            romaji as part of the card. Latin-script langs default to shown
            since the script is the reading.
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="dailyNew">Daily new card limit</Label>
          <Input
            id="dailyNew"
            type="number"
            min={0}
            max={500}
            value={config.dailyNewLimit}
            onChange={(e) =>
              void set("dailyNewLimit", Math.max(0, Number(e.target.value) || 0))
            }
          />
          <p className="text-[11px] text-muted-foreground">
            New words introduced per day. 0 disables new cards entirely
            (useful when you want to clear a backlog).
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="dailyReview">Daily review limit</Label>
          <Input
            id="dailyReview"
            type="number"
            min={0}
            max={1000}
            value={config.dailyReviewLimit}
            onChange={(e) =>
              void set(
                "dailyReviewLimit",
                Math.max(0, Number(e.target.value) || 0),
              )
            }
          />
          <p className="text-[11px] text-muted-foreground">
            Caps the review queue per session. Bigger isn't better — burnout
            tomorrow is a real cost.
          </p>
        </div>

        <label className="flex items-start gap-2 sm:col-span-2">
          <input
            type="checkbox"
            checked={config.autoplayAudio}
            onChange={(e) => void set("autoplayAudio", e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="text-[13px] font-medium">Auto-play audio on flip</span>
            <span className="block text-[11.5px] text-muted-foreground">
              Speak the headword each time a new card lands. Routes through
              your TTS provider (Settings → Text-to-speech).
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 sm:col-span-2">
          <input
            type="checkbox"
            checked={config.showExamples}
            onChange={(e) => void set("showExamples", e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="text-[13px] font-medium">Show example sentences</span>
            <span className="block text-[11.5px] text-muted-foreground">
              When a card has saved example sentences, render them on the
              back. Turn off if you find them visually noisy.
            </span>
          </span>
        </label>
      </fieldset>

      <ModesSection
        lang={lang}
        hidden={config.hiddenPlugins}
        onChange={(next) => void set("hiddenPlugins", next)}
        loaded={loaded}
      />

      <SchedulingSection
        srs={config.srs}
        onChange={(next) => void set("srs", next)}
        loaded={loaded}
      />

      <PluginSettingsSection plugins={plugins} />
    </div>
  );
}

/**
 * Per-workspace mode visibility.
 *
 * Lists every plugin that's *language-available* for this workspace
 * (so a French workspace doesn't see Handwriting in the toggle list —
 * it isn't relevant anywhere). Each row is a checkbox tied to
 * `hiddenPlugins`. Unchecked = the mode disappears from the picker
 * for this workspace.
 *
 * Pairs with the auto-drill flow: the modes the user keeps on are the
 * shapes they want to practice. The first one they open today anchors
 * FSRS; the others auto-drill. Hiding modes is therefore a curation
 * choice, not an SRS-impacting one — it shapes the picker, nothing
 * else.
 */
function ModesSection({
  lang,
  hidden,
  onChange,
  loaded,
}: {
  lang: LanguageCode;
  hidden: string[];
  onChange: (next: string[]) => void;
  loaded: boolean;
}) {
  const available = pluginsForLanguage(lang);
  // Guard: never let the user hide every mode — they'd be locked out
  // of the Flashcards screen entirely. The last-visible toggle becomes
  // disabled with a hint instead.
  const visibleCount = available.length - hidden.length;
  function toggle(id: string, on: boolean) {
    const set = new Set(hidden);
    if (on) set.delete(id);
    else set.add(id);
    onChange(Array.from(set));
  }
  return (
    <fieldset className="space-y-2 rounded-xl border border-border bg-card p-4" disabled={!loaded}>
      <div>
        <h3 className="text-sm font-semibold tracking-tight">Modes</h3>
        <p className="text-[12px] text-muted-foreground">
          Pick which study modes appear in the picker for this workspace. Hidden
          modes don&apos;t affect your SRS — they&apos;re just out of the way.
          The first mode you open each day anchors today&apos;s schedule;
          opening another mode the same day auto-flips to drill so your
          intervals don&apos;t double-step.
        </p>
      </div>
      <ul className="divide-y divide-border/60">
        {available.map((p) => {
          const isHidden = hidden.includes(p.meta.id);
          const isLastVisible = !isHidden && visibleCount === 1;
          return (
            <li key={p.meta.id} className="flex items-start gap-3 py-2.5">
              <input
                type="checkbox"
                checked={!isHidden}
                disabled={isLastVisible}
                onChange={(e) => toggle(p.meta.id, e.target.checked)}
                className="mt-1 size-4"
                aria-label={`${p.meta.name} visible`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {p.meta.icon ? (
                    <p.meta.icon className="size-3.5 text-muted-foreground" />
                  ) : null}
                  <span className="text-[13px] font-medium">{p.meta.name}</span>
                  {isHidden && (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      hidden
                    </span>
                  )}
                  {isLastVisible && (
                    <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400">
                      last visible
                    </span>
                  )}
                </div>
                <p className="text-[11.5px] leading-snug text-muted-foreground">
                  {p.meta.description}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

/**
 * Per-plugin settings panel host.
 *
 * Walks the registered study plugins and mounts each one's optional
 * `Settings` component. The base settings page knows nothing about
 * what individual plugins surface here — they each manage their own
 * persistence via `usePluginSetting`. Hidden when no plugin in the
 * filtered list exposes a Settings component, so a workspace whose
 * plugins have no settings doesn't show an empty "plugin settings"
 * heading.
 */
function PluginSettingsSection({
  plugins,
}: {
  plugins: ReturnType<typeof pluginsForLanguage>;
}) {
  const withSettings = plugins.filter((p) => p.Settings);
  if (withSettings.length === 0) return null;
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold tracking-tight">
          Mode-specific settings
        </h3>
        <p className="text-[12px] text-muted-foreground">
          Each study mode can ship its own preferences. Tune them here without
          leaving the page.
        </p>
      </div>
      {withSettings.map((p) => {
        const Settings = p.Settings!;
        return (
          <fieldset
            key={p.meta.id}
            className="space-y-3 rounded-xl border border-border bg-card p-4"
          >
            <div className="flex items-center gap-2">
              {p.meta.icon ? (
                <p.meta.icon className="size-4 text-muted-foreground" />
              ) : null}
              <span className="text-[13px] font-medium">{p.meta.name}</span>
            </div>
            <Settings />
          </fieldset>
        );
      })}
    </div>
  );
}

// ─── Scheduling section (FSRS-5) ─────────────────────────────────────────
//
// Surface the per-workspace `SRSConfig` so the user can pick presets,
// edit learning ladders, tune retention, and (advanced) override
// FSRS-5 weights for personal calibration. Each control commits on
// blur / change — the parent `set('srs', next)` writes the whole
// object atomically.

function SchedulingSection({
  srs,
  onChange,
  loaded,
}: {
  srs: SRSConfig;
  onChange: (next: SRSConfig) => void;
  loaded: boolean;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Detect which preset (if any) the current settings match. Lets us
  // show a "Custom" indicator when the user has tuned anything off the
  // baseline so they know they're outside the named presets.
  const currentPreset = matchPreset(srs);

  function applyPreset(id: PresetId) {
    onChange({
      ...SRS_PRESETS[id],
      weights: [...SRS_PRESETS[id].weights],
    });
  }

  function set<K extends keyof SRSConfig>(key: K, value: SRSConfig[K]) {
    onChange({ ...srs, [key]: value });
  }

  return (
    <fieldset
      className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:grid-cols-2"
      disabled={!loaded}
    >
      <div className="sm:col-span-2">
        <h3 className="text-sm font-semibold tracking-tight">Scheduling</h3>
        <p className="mt-1 text-[12px] text-muted-foreground">
          FSRS-5 spaced-repetition algorithm — the modern replacement for
          Anki's classic SM-2. Pick a preset or tune the knobs by hand.
        </p>
      </div>

      <div className="grid gap-1.5 sm:col-span-2">
        <Label>Preset</Label>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(SRS_PRESETS) as PresetId[]).map((id) => (
            <Button
              key={id}
              type="button"
              size="sm"
              variant={currentPreset === id ? "default" : "outline"}
              onClick={() => applyPreset(id)}
            >
              {currentPreset === id && <Sparkles className="size-3.5" />}
              {PRESET_LABEL[id]}
            </Button>
          ))}
          {currentPreset === null && (
            <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-3 py-1 text-[11.5px] text-muted-foreground">
              Custom
            </span>
          )}
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="learning-steps">Learning steps (minutes)</Label>
        <Input
          id="learning-steps"
          value={srs.learningSteps.join(" ")}
          onChange={(e) => set("learningSteps", parseSteps(e.target.value))}
          placeholder="1 10"
          className="font-mono text-[12.5px]"
        />
        <p className="text-[11px] text-muted-foreground">
          Space-separated minutes new cards step through before
          graduating to review. Anki default: <code>1 10</code>.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="grad-interval">Graduating interval (days)</Label>
        <Input
          id="grad-interval"
          type="number"
          min={1}
          max={365}
          value={srs.graduatingInterval}
          onChange={(e) =>
            set("graduatingInterval", Math.max(1, Number(e.target.value) || 1))
          }
        />
        <p className="text-[11px] text-muted-foreground">
          First review interval after the learning ladder completes.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="easy-interval">Easy interval (days)</Label>
        <Input
          id="easy-interval"
          type="number"
          min={1}
          max={365}
          value={srs.easyInterval}
          onChange={(e) =>
            set("easyInterval", Math.max(1, Number(e.target.value) || 1))
          }
        />
        <p className="text-[11px] text-muted-foreground">
          First review interval when "Easy" is hit on a learning card.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="retention">
          Desired retention ({Math.round(srs.desiredRetention * 100)}%)
        </Label>
        <Input
          id="retention"
          type="range"
          min={70}
          max={97}
          step={1}
          value={Math.round(srs.desiredRetention * 100)}
          onChange={(e) => set("desiredRetention", Number(e.target.value) / 100)}
        />
        <p className="text-[11px] text-muted-foreground">
          Probability that you remember a card on review. Higher = more
          frequent reviews. 90% is the FSRS-5 default.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="max-interval">Maximum interval (days)</Label>
        <Input
          id="max-interval"
          type="number"
          min={30}
          max={36500}
          value={srs.maximumInterval}
          onChange={(e) =>
            set("maximumInterval", Math.max(30, Number(e.target.value) || 36500))
          }
        />
        <p className="text-[11px] text-muted-foreground">
          Cap on a single review interval. Set lower (e.g. 365) if you
          want to keep all cards rotating annually.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="mastered">Mastered threshold (days)</Label>
        <Input
          id="mastered"
          type="number"
          min={7}
          max={36500}
          value={srs.masteredThreshold}
          onChange={(e) =>
            set("masteredThreshold", Math.max(7, Number(e.target.value) || 365))
          }
        />
        <p className="text-[11px] text-muted-foreground">
          When a card's stability passes this, it's tagged{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
            mastered
          </code>{" "}
          and stops appearing in the active queue.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="leech-thresh">Leech threshold</Label>
        <Input
          id="leech-thresh"
          type="number"
          min={1}
          max={50}
          value={srs.leechThreshold}
          onChange={(e) =>
            set("leechThreshold", Math.max(1, Number(e.target.value) || 8))
          }
        />
        <p className="text-[11px] text-muted-foreground">
          A card with at least this many lapses is flagged a leech (the
          card detail dialog shows the badge so you can rewrite or drop it).
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label>Leech action</Label>
        <Select
          value={srs.leechAction}
          onValueChange={(v) => set("leechAction", v as "tag" | "suspend")}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="tag">Tag — keep reviewing, mark for attention</SelectItem>
            <SelectItem value="suspend">Suspend — drop from the queue until you intervene</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="sm:col-span-2 border-t border-border/60 pt-3">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground"
        >
          {advancedOpen ? "▾" : "▸"} Advanced — FSRS-5 weights
        </button>
        {advancedOpen && (
          <div className="mt-3 grid gap-2">
            <p className="text-[11.5px] text-muted-foreground">
              19 floats that control the forgetting curve. Defaults are
              the optimised average from the open-spaced-repetition
              dataset; tune for personal calibration only if you know
              what you're doing — bad weights wreck scheduling. Click
              "Reset to defaults" any time.
            </p>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {srs.weights.map((w, i) => (
                <Input
                  key={i}
                  type="number"
                  step={0.0001}
                  value={w}
                  onChange={(e) => {
                    const next = [...srs.weights];
                    next[i] = Number(e.target.value);
                    set("weights", next);
                  }}
                  className="font-mono text-[11.5px]"
                />
              ))}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => set("weights", [...DEFAULT_FSRS_WEIGHTS])}
              className="self-start"
            >
              Reset weights to FSRS-5 defaults
            </Button>
          </div>
        )}
      </div>
    </fieldset>
  );
}

/** Parse the "1 10" / "1, 10" / "1\n10" formats users tend to type. */
function parseSteps(raw: string): number[] {
  return raw
    .split(/[\s,;]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** Detect whether the given config matches a named preset (so the
 *  picker can highlight which one is active). Compares only the
 *  user-facing fields; weight overrides knock it out of preset land
 *  even if everything else lines up. */
function matchPreset(srs: SRSConfig): PresetId | null {
  for (const id of Object.keys(SRS_PRESETS) as PresetId[]) {
    const p = SRS_PRESETS[id];
    if (
      arrayEq(srs.learningSteps, p.learningSteps) &&
      srs.graduatingInterval === p.graduatingInterval &&
      srs.easyInterval === p.easyInterval &&
      srs.desiredRetention === p.desiredRetention &&
      srs.maximumInterval === p.maximumInterval &&
      srs.masteredThreshold === p.masteredThreshold &&
      srs.leechThreshold === p.leechThreshold &&
      srs.leechAction === p.leechAction &&
      arrayEq(srs.weights, p.weights)
    ) {
      return id;
    }
  }
  return null;
}

function arrayEq(a: number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 1e-9) return false;
  }
  return true;
}
