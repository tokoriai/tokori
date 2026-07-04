import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Eye,
  FileJson,
  Languages,
  Loader2,
  Package,
  ShoppingBag,
  Sparkles,
  Target,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DictionariesSection } from "@/components/settings/dictionaries-section";
import { CloudSignInDialog } from "@/components/cloud-signin-dialog";
import { PackImportDialog } from "@/components/pack-import-dialog";
import { PackPreviewDialog } from "@/components/pack-preview-dialog";
import { PacksBrowser } from "@/components/packs-browser";
import { HOSTED } from "@/lib/build-flags";
import {
  invalidateDictionaryAvailabilityCache,
  useHasDictionary,
} from "@/lib/dict-availability";
import { invalidateDictLookupCache } from "@/lib/word-lookup";
import { freePacksForLanguage, type FreePackEntry } from "@/lib/free-packs";
import { triggerCloudRefresh } from "@/lib/cloud-refresh";
import { readPackFile, validatePack, type Pack } from "@/lib/pack-import";
import {
  PICKABLE_LANGUAGES,
  languageGlyph,
  languageName,
  languageNative,
  tutorOpenerWithName,
  type LanguageCode,
} from "@/lib/languages";
import { useProfile } from "@/lib/profile-context";
import { useWorkspace } from "@/lib/workspace-context";
import { setSetting } from "@/lib/db";
import {
  estimateDailyMinutesForGap,
  estimateDaysForGap,
  journeySettingKey,
} from "@/lib/learning-journey";
import {
  levelsForScale,
  scaleFor,
  scaleLabel,
  type LevelInfo,
} from "@/lib/level";

// Hover-popover hint shown in the preview column. Pinyin is Chinese-only,
// furigana is Japanese-only; the rest of the supported languages don't
// have a separate phonetic reading layer (Hangul, Latin scripts), so the
// hint just promises a translation.
function hoverHintFor(code: LanguageCode): string {
  switch (code) {
    case "zh":
      return "Hover words for pinyin and translation.";
    case "ja":
      return "Hover words for furigana and translation.";
    default:
      return "Hover words for instant translation.";
  }
}

// Up to four steps inside one dialog. The dictionary step is
// conditional — desktop only, and only when the target language has no
// real dictionary yet — so the live step count is 3 or 4:
//
//   1. workspace   — pick the target / native language pair
//   2. dictionary  — install a real dict (desktop only; skipped when one
//                    already exists, and entirely under HOSTED where
//                    dictionaries are shared server-side)
//   3. pack        — seed starter content: free / paid / a local file
//   4. goal        — set a realistic target level + pace so the journey
//                    and AI coach have something to drive toward
//
// Every step after workspace is skippable; none block. Goal lands last
// because the user has just seen what content is available, which makes
// "what level am I shooting for?" the natural closing question.
//
// `activeSteps` (computed in OnboardingDialog) is the single source of
// truth for which steps are live and in what order; the per-step eyebrow
// renders "Step X of Y" from it so the numbering can never drift from
// what the user actually walks through.
type Step = "workspace" | "dictionary" | "pack" | "goal";

const STEP_LABEL: Record<Step, string> = {
  workspace: "Workspace",
  dictionary: "Dictionary",
  pack: "Starter content",
  goal: "Goal",
};

/** Shared step eyebrow — "Step 2 of 4 · Dictionary" with the step's
 *  icon. One renderer so every step is labelled identically and the
 *  count comes from the same `activeSteps` array. */
function StepEyebrow({
  icon: Icon,
  step,
  index,
  total,
}: {
  icon: LucideIcon;
  step: Step;
  index: number;
  total: number;
}) {
  return (
    <div className="flex items-center gap-2 text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
      <Icon className="size-3.5" />
      Step {index} of {total} · {STEP_LABEL[step]}
    </div>
  );
}

export function OnboardingDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { addWorkspace, workspaces } = useWorkspace();
  const { profile, update: updateProfile } = useProfile();
  const isFirstRun = workspaces.length === 0;
  const [step, setStep] = useState<Step>("workspace");
  const [name, setName] = useState(profile.name);
  const [target, setTarget] = useState<LanguageCode>("zh");
  const [native, setNative] = useState<LanguageCode>(profile.defaultNativeLang);
  const [submitting, setSubmitting] = useState(false);
  // Whether the dictionary step is part of this run. Null until the
  // workspace step decides (see submit): before that we derive a
  // prospective value from live dict availability so the counter reads
  // right from the first paint, then freeze it at submit so installing
  // a dict mid-flow can't retroactively renumber the later steps.
  const [dictIncluded, setDictIncluded] = useState<boolean | null>(null);
  const hasDictForTarget = useHasDictionary(target);

  // Single source of truth for which steps are live, in order. Each
  // step's eyebrow reads its "Step X of Y" from this, so the numbering
  // can't drift from the path the user actually walks.
  const activeSteps = useMemo<Step[]>(() => {
    const includeDict =
      dictIncluded != null ? dictIncluded : !HOSTED && hasDictForTarget !== true;
    return [
      "workspace",
      ...(includeDict ? (["dictionary"] as Step[]) : []),
      "pack",
      "goal",
    ];
  }, [dictIncluded, hasDictForTarget]);
  const stepPos = (s: Step) => ({
    stepIndex: activeSteps.indexOf(s) + 1,
    stepTotal: activeSteps.length,
  });

  // Reset to step 1 every time the dialog *opens* — not on every
  // profile change. Including `profile.name` / `profile.defaultNativeLang`
  // here used to race against `submit()`: the workspace step calls
  // `updateProfile(...)` mid-flow, which changes the profile fields,
  // which re-fires this effect, which resets `step` back to "workspace"
  // right after `submit()` set it to "pack". The pack picker never got
  // to render. Keying purely on `open` keeps the open-transition sync
  // without the mid-flow reset. Stale name on re-open isn't a real
  // issue: the user only edits their name from Settings (separate
  // surface), and reopening onboarding always seeds from the latest
  // profile via the initial useState.
  useEffect(() => {
    if (open) {
      setStep("workspace");
      setName(profile.name);
      setNative(profile.defaultNativeLang);
      setDictIncluded(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit() {
    if (target === native) return;
    setSubmitting(true);
    try {
      // The profile write and the workspace insert are independent, so
      // run them together — the transition then waits on the slower of
      // the two rather than their sum. (Both are separate Tauri IPC
      // round-trips; sequencing them was a big chunk of the post-"Begin"
      // lag.)
      await Promise.all([
        isFirstRun
          ? updateProfile({ name: name.trim(), defaultNativeLang: native })
          : Promise.resolve(),
        addWorkspace({ targetLang: target, nativeLang: native }),
      ]);
      // Refresh the module-level availability cache so the rest of the
      // app reflects the new workspace immediately. Cheap; safe.
      invalidateDictionaryAvailabilityCache();
      // HOSTED: dictionaries are server-side and shared across all
      // users — there's nothing to install, so skip the dict step.
      if (HOSTED) {
        setDictIncluded(false);
        setStep("pack");
        return;
      }
      // Decide the dict step from the already-warm availability cache
      // (`hasDictForTarget` has been resolved since the workspace step
      // first rendered) instead of a fresh listDictionaries() round-trip
      // on the critical path. `null` — cache not yet resolved, rare —
      // falls through to the skippable dict step, which is the safe
      // default and matches the prospective count in `activeSteps`.
      // Freezing it here also stops a dict installed on the next step
      // from renumbering pack/goal underneath the user.
      const hasReal = hasDictForTarget === true;
      setDictIncluded(!hasReal);
      setStep(hasReal ? "pack" : "dictionary");
    } catch (err) {
      console.error("Failed to create workspace", err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        // First-run can't be cancelled until at least one workspace
        // exists. Steps after that (dictionary, pack) are always
        // skippable because the workspace already exists by then.
        if (v) return;
        if (step !== "workspace" || !isFirstRun) onClose();
      }}
    >
      <DialogContent
        // Hide the close button while we're still on step 1 of first-run
        // (the user must create a workspace before doing anything).
        showCloseButton={!isFirstRun || step !== "workspace"}
        className="overflow-hidden p-0 sm:max-w-3xl"
      >
        {/* Steps draw their own visual headings; this names the dialog
            for screen readers (and silences Radix's missing-title
            warning) without altering the layout. */}
        <DialogTitle className="sr-only">Set up your workspace</DialogTitle>
        {step === "workspace" ? (
          <WorkspaceStep
            isFirstRun={isFirstRun}
            name={name}
            setName={setName}
            target={target}
            setTarget={setTarget}
            native={native}
            setNative={setNative}
            submitting={submitting}
            onSubmit={submit}
            onCancel={onClose}
            {...stepPos("workspace")}
          />
        ) : step === "dictionary" ? (
          <DictionaryStep
            target={target}
            {...stepPos("dictionary")}
            onDone={() => {
              // The user clicked Done/Skip — the workspace was already
              // created on the previous step. Flush the caches one more
              // time in case they installed mid-step (the per-word entry
              // cache may hold misses from the preview), then move on to
              // the pack picker.
              invalidateDictionaryAvailabilityCache();
              invalidateDictLookupCache();
              setStep("pack");
            }}
          />
        ) : step === "pack" ? (
          <PackStep
            target={target}
            {...stepPos("pack")}
            onDone={() => setStep("goal")}
          />
        ) : (
          <GoalStep
            target={target}
            {...stepPos("goal")}
            onDone={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function WorkspaceStep({
  isFirstRun,
  name,
  setName,
  target,
  setTarget,
  native,
  setNative,
  submitting,
  onSubmit,
  onCancel,
  stepIndex,
  stepTotal,
}: {
  isFirstRun: boolean;
  name: string;
  setName: (v: string) => void;
  target: LanguageCode;
  setTarget: (v: LanguageCode) => void;
  native: LanguageCode;
  setNative: (v: LanguageCode) => void;
  submitting: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  stepIndex: number;
  stepTotal: number;
}) {
  // Tutor opener, with the learner's name woven in live as they type.
  const opener = tutorOpenerWithName(target, name);
  return (
    <div className="grid grid-cols-1 md:grid-cols-[1.05fr_1fr]">
      {/* Form column */}
      <div className="space-y-5 px-6 py-7 md:px-8">
        <StepEyebrow
          icon={Languages}
          step="workspace"
          index={stepIndex}
          total={stepTotal}
        />
        <div>
          <h2 className="font-serif text-3xl tracking-tight">
            {isFirstRun ? "Let's set up your first workspace." : "Start a new workspace."}
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {isFirstRun
              ? "A workspace is a single language you're learning. You can have one per language."
              : "Pick a language pair. You can switch any time."}
          </p>
        </div>

        <div className="space-y-4 pt-2">
          {isFirstRun && (
            <div className="grid gap-1.5">
              <Label htmlFor="name">Your name (optional)</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="What should the tutor call you?"
              />
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="target">I want to learn</Label>
            <Select
              value={target}
              onValueChange={(v) => setTarget(v as LanguageCode)}
            >
              <SelectTrigger id="target" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PICKABLE_LANGUAGES.map((l) => (
                  <SelectItem key={l.code} value={l.code}>
                    {l.name}{" "}
                    <span className="text-muted-foreground">· {l.nativeName}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="native">Explain to me in</Label>
            <Select
              value={native}
              onValueChange={(v) => setNative(v as LanguageCode)}
            >
              <SelectTrigger id="native" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PICKABLE_LANGUAGES.map((l) => (
                  <SelectItem key={l.code} value={l.code}>
                    {l.name}{" "}
                    <span className="text-muted-foreground">· {l.nativeName}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {target === native && (
            <p className="text-[12px] text-destructive">
              Pick two different languages.
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          {!isFirstRun && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button onClick={onSubmit} disabled={submitting || target === native}>
            {submitting ? "Creating…" : isFirstRun ? "Begin" : "Create workspace"}
          </Button>
        </div>
      </div>

      {/* Preview column */}
      <div className="hidden flex-col justify-between border-l border-border bg-muted/40 px-6 py-7 md:flex md:px-7">
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <Sparkles className="size-3" />
            Preview
          </div>
          <div className="flex items-center gap-3">
            <div className="flex size-12 items-center justify-center rounded-xl bg-foreground text-lg font-medium text-background">
              {languageGlyph(target)}
            </div>
            <div>
              <div className="font-serif text-xl tracking-tight">
                {languageName(target)}
              </div>
              <div className="text-[12px] text-muted-foreground">
                {languageNative(target)} · explained in {languageName(native)}
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl bg-background p-4 shadow-sm ring-1 ring-border">
          <div className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            Tutor opener
          </div>
          <div className="mt-2 font-serif text-lg leading-snug">{opener}</div>
        </div>

        <div className="space-y-1.5 text-[12px] text-muted-foreground">
          <p>· {hoverHintFor(target)}</p>
          <p>· Save unknown words straight into vocabulary.</p>
          <p>· Track immersion hours and streaks.</p>
        </div>
      </div>
    </div>
  );
}

function DictionaryStep({
  target,
  onDone,
  stepIndex,
  stepTotal,
}: {
  target: LanguageCode;
  onDone: () => void;
  stepIndex: number;
  stepTotal: number;
}) {
  // The hook re-resolves to `true` as soon as the install path
  // invalidates the module-level cache (DictionariesSection does this
  // on every successful install). That flip is the signal that the
  // user is finished — we just relabel the primary button. They can
  // still skip explicitly via the secondary button.
  const has = useHasDictionary(target);
  const targetName = languageName(target);
  // True while a pack is downloading/installing inside the section
  // below — we grey out "Skip for now" so the user can't leave the step
  // mid-install (and lose the in-flight download).
  const [installing, setInstalling] = useState(false);

  return (
    <div className="flex max-h-[80vh] flex-col">
      <div className="space-y-2 px-6 pt-7 md:px-8">
        <StepEyebrow
          icon={BookOpen}
          step="dictionary"
          index={stepIndex}
          total={stepTotal}
        />
        <h2 className="font-serif text-3xl tracking-tight">
          Install a {targetName} dictionary?
        </h2>
        <p className="text-[13px] text-muted-foreground">
          Click-to-define popovers, search, and vocab extraction all read
          from an installed dictionary. You can skip and install one later
          from{" "}
          <span className="font-medium text-foreground">Settings → Dictionaries</span>
          {" "}— but most users want this set up before they start chatting.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 md:px-8">
        {/* Reuse the install UI from Settings rather than forking a
            slimmer variant. `scope="workspace"` filters the catalog to
            just the active workspace's language, which is exactly what
            we want here — and the section's success path already
            invalidates the availability cache, so the hook above flips
            without us threading a callback through. */}
        <DictionariesSection scope="workspace" onBusyChange={setInstalling} />
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3 md:px-8">
        <Button variant="ghost" onClick={onDone} disabled={installing}>
          {has === true ? "Continue" : "Skip for now"}
        </Button>
      </div>
    </div>
  );
}

const DEADLINE_PRESETS = [30, 90, 180, 365];
const WEEKLY_PRESETS = [70, 140, 210, 350]; // ≈ 10/20/30/50 min per day
// ≈ 20 min/day — the default we pre-select. A real, sustainable
// beginner pace, so the goal the step saves is achievable rather than
// aspirational.
const DEFAULT_WEEKLY_MINUTES = 140;

/** Pick the shortest deadline preset that still clears the estimated
 *  time-to-target, so the suggested deadline is achievable at the
 *  chosen pace. Falls back to the longest preset when even that is
 *  tight (the feedback line then flags it as ambitious). */
function recommendedDeadlinePreset(
  estDays: number | null,
  presets: number[],
): number | null {
  if (estDays == null) return null;
  return presets.find((p) => p >= estDays) ?? presets[presets.length - 1];
}

/** Plain-language duration for the time-to-target readout. Display
 *  only — the load-bearing arithmetic lives in `estimateDaysForGap`. */
function humanizeDays(days: number): string {
  if (days <= 0) return "no time at all";
  if (days < 14) return `about ${days} day${days === 1 ? "" : "s"}`;
  if (days < 56) return `about ${Math.round(days / 7)} weeks`;
  if (days < 365) return `about ${Math.round(days / 30)} months`;
  const years = days / 365;
  return years < 1.25 ? "about a year" : `about ${years.toFixed(1)} years`;
}

/** Final onboarding step — sets the journey's target level, pace, and
 *  deadline. Persists straight to the settings table under the standard
 *  `journey.<wsId>.*` keys so the Journey tab, the dashboard widget, and
 *  the AI coach all read it as if the user had typed it into Journey
 *  themselves.
 *
 *  Defaults are picked to be *realistic*: the first rung up from a
 *  cold-start learner, a sustainable ~20 min/day pace, and a deadline
 *  derived from those two via the same words-per-minute model the
 *  Journey uses to judge progress — so "Save goal" commits to something
 *  achievable, not aspirational. Skippable; all of it is editable later
 *  under Progress → Journey. */
function GoalStep({
  target,
  onDone,
  stepIndex,
  stepTotal,
}: {
  target: LanguageCode;
  onDone: () => void;
  stepIndex: number;
  stepTotal: number;
}) {
  const { active: workspace } = useWorkspace();
  const scale = useMemo(() => scaleFor(target), [target]);
  const levels: LevelInfo[] = useMemo(() => levelsForScale(scale), [scale]);
  // Default to the first rung up (level index 1 — HSK 2, A2, N4,
  // TOPIK 2). A cold-start learner sits at index 0 (minVocab 0), so
  // this is the nearest real milestone: motivating but reachable in a
  // few months at the default pace.
  const defaultLevel = levels[1]?.id ?? levels[levels.length - 1]?.id ?? "";
  const [targetLevelId, setTargetLevelId] = useState<string>(defaultLevel);
  const [weeklyMin, setWeeklyMin] = useState<number | null>(
    DEFAULT_WEEKLY_MINUTES,
  );
  // Seed the deadline from the default target + pace so the pre-filled
  // goal is internally consistent. The user can retarget it (or clear
  // it) — we don't chase later target changes, the feedback line guides
  // them instead.
  const [deadlineDays, setDeadlineDays] = useState<number | null>(() => {
    const lvl = levels[1] ?? levels[levels.length - 1];
    const gap = Math.max(0, lvl?.minVocab ?? 0);
    return recommendedDeadlinePreset(
      estimateDaysForGap(gap, DEFAULT_WEEKLY_MINUTES),
      DEADLINE_PRESETS,
    );
  });
  const [saving, setSaving] = useState(false);

  // Derived plan. New workspaces start from zero known vocab, so the
  // gap to the target is simply its vocab threshold; the estimate then
  // reuses the Journey's words-per-minute model so this preview and the
  // later "are you on track?" verdict can't disagree.
  const targetLevel = useMemo(
    () => levels.find((l) => l.id === targetLevelId) ?? null,
    [levels, targetLevelId],
  );
  const wordsGap = Math.max(0, targetLevel?.minVocab ?? 0);
  const estDays =
    weeklyMin != null ? estimateDaysForGap(wordsGap, weeklyMin) : null;
  const recommendedDeadline = recommendedDeadlinePreset(
    estDays,
    DEADLINE_PRESETS,
  );
  const dailyMin = weeklyMin != null ? Math.round(weeklyMin / 7) : null;
  // Verdict on the chosen deadline vs. the estimate at the chosen pace.
  const deadlineVerdict: "comfortable" | "on-pace" | "ambitious" | null =
    deadlineDays == null || estDays == null || wordsGap <= 0
      ? null
      : deadlineDays >= estDays * 1.1
        ? "comfortable"
        : deadlineDays >= estDays * 0.9
          ? "on-pace"
          : "ambitious";
  const ambitiousDailyMin =
    deadlineVerdict === "ambitious" && deadlineDays != null
      ? estimateDailyMinutesForGap(wordsGap, deadlineDays)
      : null;

  async function save() {
    if (!workspace) {
      onDone();
      return;
    }
    setSaving(true);
    try {
      await setSetting(
        journeySettingKey(workspace.id, "targetLevelId"),
        targetLevelId,
      );
      if (deadlineDays != null) {
        const deadline = Math.floor(Date.now() / 1000) + deadlineDays * 86_400;
        await setSetting(
          journeySettingKey(workspace.id, "deadline"),
          String(deadline),
        );
      }
      if (weeklyMin != null) {
        await setSetting(
          journeySettingKey(workspace.id, "weeklyMinutesTarget"),
          String(weeklyMin),
        );
      }
      toast.success(`Goal set: ${targetLevelId}`);
    } catch (err) {
      toast.error("Couldn't save goal", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
      onDone();
    }
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-[1.05fr_1fr]">
      {/* Form column */}
      <div className="space-y-5 px-6 py-7 md:px-8">
        <StepEyebrow
          icon={Target}
          step="goal"
          index={stepIndex}
          total={stepTotal}
        />
        <div>
          <h2 className="font-serif text-3xl tracking-tight">
            Where are you headed?
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Pick a target on the {scaleLabel(scale)} scale and a pace you can
            actually keep. The journey tab and the AI coach use both to suggest
            what to study and to tell whether you're on time. Change any of it
            later under{" "}
            <span className="font-medium text-foreground">Progress → Journey</span>.
          </p>
        </div>

        <div className="space-y-4 pt-2">
          <div className="grid gap-1.5">
            <Label>Target level</Label>
            <Select
              value={targetLevelId}
              onValueChange={(v) => setTargetLevelId(v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {levels.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.id} · {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label>Weekly pace</Label>
            <div className="flex flex-wrap gap-1.5">
              {WEEKLY_PRESETS.map((m) => (
                <Button
                  key={m}
                  type="button"
                  size="sm"
                  variant={weeklyMin === m ? "default" : "outline"}
                  className="h-7 px-2.5 text-[11.5px]"
                  onClick={() => setWeeklyMin(m)}
                >
                  {Math.round(m / 7)} min / day
                </Button>
              ))}
              <Button
                type="button"
                size="sm"
                variant={weeklyMin == null ? "default" : "outline"}
                className="h-7 px-2.5 text-[11.5px]"
                onClick={() => setWeeklyMin(null)}
              >
                No set pace
              </Button>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Target date</Label>
            <div className="flex flex-wrap gap-1.5">
              {DEADLINE_PRESETS.map((d) => (
                <Button
                  key={d}
                  type="button"
                  size="sm"
                  variant={deadlineDays === d ? "default" : "outline"}
                  className="h-7 px-2.5 text-[11.5px]"
                  onClick={() => setDeadlineDays(d)}
                >
                  {d < 365 ? `${d} days` : "1 year"}
                </Button>
              ))}
              <Button
                type="button"
                size="sm"
                variant={deadlineDays == null ? "default" : "outline"}
                className="h-7 px-2.5 text-[11.5px]"
                onClick={() => setDeadlineDays(null)}
              >
                No deadline
              </Button>
            </div>
            {/* One-click snap to a date that fits the chosen pace —
                only shown when the current pick has drifted from it. */}
            {recommendedDeadline != null &&
              weeklyMin != null &&
              deadlineDays !== recommendedDeadline && (
                <button
                  type="button"
                  onClick={() => setDeadlineDays(recommendedDeadline)}
                  className="self-start text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Suggested at this pace:{" "}
                  {recommendedDeadline < 365
                    ? `${recommendedDeadline} days`
                    : "1 year"}
                </button>
              )}
          </div>

          {/* Live realism check — ties target + pace + date together via
              the same words-per-minute model the Journey uses to judge
              progress, so the number here matches the verdict later. */}
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
            {wordsGap <= 0 ? (
              <span>You're already at this level — aim a rung higher.</span>
            ) : weeklyMin == null || estDays == null ? (
              <span>
                Reaching{" "}
                <span className="font-medium text-foreground">{targetLevelId}</span>{" "}
                means learning about {wordsGap.toLocaleString()} words. Pick a
                weekly pace to see how long that takes.
              </span>
            ) : (
              <span>
                At about{" "}
                <span className="font-medium text-foreground">
                  {dailyMin} min/day
                </span>
                ,{" "}
                <span className="font-medium text-foreground">{targetLevelId}</span>{" "}
                (~{wordsGap.toLocaleString()} words) is{" "}
                <span className="font-medium text-foreground">
                  {humanizeDays(estDays)}
                </span>{" "}
                away.
                {deadlineVerdict === "comfortable" &&
                  " Your target date leaves comfortable slack."}
                {deadlineVerdict === "on-pace" &&
                  " Your target date matches that pace."}
                {deadlineVerdict === "ambitious" &&
                  ambitiousDailyMin != null &&
                  ` Your target date is ambitious — closer to ${ambitiousDailyMin} min/day.`}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between pt-2">
          <Button variant="ghost" onClick={onDone} disabled={saving}>
            Skip
          </Button>
          <Button onClick={() => void save()} disabled={saving || !targetLevelId}>
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            Save goal
          </Button>
        </div>
      </div>

      {/* Preview column — the milestone ladder the user is committing
          to, in plain-language terms. Static (no live state), so it
          reads like a brochure rather than a duplicated dashboard. */}
      <div className="hidden border-l border-border bg-muted/30 px-6 py-7 md:block md:px-8">
        <div className="flex items-center gap-2 text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
          <Sparkles className="size-3.5" />
          What you get
        </div>
        <ul className="mt-4 space-y-3 text-[13px] text-foreground/90">
          <li className="flex items-start gap-2.5">
            <span className="mt-1 inline-block size-1.5 shrink-0 rounded-full bg-emerald-500" />
            A milestone ladder on the Journey tab showing every level between
            you and {targetLevelId || "your target"}.
          </li>
          <li className="flex items-start gap-2.5">
            <span className="mt-1 inline-block size-1.5 shrink-0 rounded-full bg-sky-500" />
            A daily nudge from the AI coach, tailored to today's stats and the
            recommended activity mix at your current phase.
          </li>
          <li className="flex items-start gap-2.5">
            <span className="mt-1 inline-block size-1.5 shrink-0 rounded-full bg-violet-500" />
            Suggested habits (review · input · tutor · output) for each phase
            of the journey — one-click adopt from Journey → milestone.
          </li>
        </ul>
        <p className="mt-6 text-[11.5px] italic text-muted-foreground">
          The journey is yours to redefine. Skip now and set it later from
          Progress → Journey, or change the target any time without losing
          progress.
        </p>
      </div>
    </div>
  );
}

function PackStep({
  target,
  onDone,
  stepIndex,
  stepTotal,
}: {
  target: LanguageCode;
  onDone: () => void;
  stepIndex: number;
  stepTotal: number;
}) {
  const targetName = languageName(target);
  const freePacks = freePacksForLanguage(target);
  // When the user picks anything (catalog, free pack, or their own
  // file) we hand the parsed Pack to PackImportDialog so they get the
  // standard activation prefs (library / current-chapter /
  // previous-known). Onboarding stays mounted underneath; the import
  // dialog layers on top via Radix stacking.
  const [redeemPack, setRedeemPack] = useState<Pack | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  // Free-pack preview + install state, parallel to the same flow in
  // PackImportDialog. We can't share because that dialog renders the
  // activation UI we don't want here.
  const [previewFree, setPreviewFree] = useState<FreePackEntry | null>(null);
  const [previewFreePack, setPreviewFreePack] = useState<Pack | null>(null);
  const [previewFreeLoading, setPreviewFreeLoading] = useState(false);
  const [installingFreeId, setInstallingFreeId] = useState<string | null>(null);
  // Local-file import (the "From file" tab).
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [importingFile, setImportingFile] = useState(false);

  /** Read a user-supplied `.json`, validate it, and confirm it matches
   *  this workspace's language before handing it to the activation
   *  dialog — so a Spanish pack dropped into a Japanese workspace fails
   *  loudly here instead of silently mixing scripts. */
  async function importFromFile(file: File | null | undefined) {
    if (!file) return;
    setImportingFile(true);
    try {
      const valid = await readPackFile(file);
      if (!valid.ok) {
        toast.error(`Pack file looks invalid: ${valid.error}`);
        return;
      }
      if (valid.pack.language !== target) {
        toast.error(
          `That pack is for ${languageName(valid.pack.language)}, but this workspace is ${targetName}.`,
        );
        return;
      }
      setRedeemPack(valid.pack);
    } finally {
      setImportingFile(false);
    }
  }

  async function installFree(entry: FreePackEntry) {
    setInstallingFreeId(entry.id);
    try {
      const raw = await entry.load();
      const valid = validatePack(raw);
      if (!valid.ok) {
        toast.error(`Pack file looks invalid: ${valid.error}`);
        return;
      }
      setRedeemPack(valid.pack);
    } catch (err) {
      toast.error(
        `Couldn't load pack: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setInstallingFreeId(null);
    }
  }

  async function openFreePreview(entry: FreePackEntry) {
    setPreviewFree(entry);
    setPreviewFreePack(null);
    setPreviewFreeLoading(true);
    try {
      const raw = await entry.load();
      const valid = validatePack(raw);
      if (valid.ok) {
        setPreviewFreePack(valid.pack);
      } else {
        toast.error(`Pack file looks invalid: ${valid.error}`);
        setPreviewFree(null);
      }
    } catch (err) {
      toast.error(
        `Couldn't load pack: ${err instanceof Error ? err.message : String(err)}`,
      );
      setPreviewFree(null);
    } finally {
      setPreviewFreeLoading(false);
    }
  }

  function closeFreePreview() {
    setPreviewFree(null);
    setPreviewFreePack(null);
    setPreviewFreeLoading(false);
  }

  return (
    <div className="flex max-h-[80vh] flex-col">
      <div className="space-y-2 px-6 pt-7 md:px-8">
        <StepEyebrow
          icon={Package}
          step="pack"
          index={stepIndex}
          total={stepTotal}
        />
        <h2 className="font-serif text-3xl tracking-tight">
          Add a {targetName} pack?
        </h2>
        <p className="text-[13px] text-muted-foreground">
          Packs install textbooks, chapters, and vocab lists as reference.
          Grab a free one, browse the catalog, or import your own{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[11.5px]">.json</code>.
          Nothing enters your Flashcards queue until you choose to activate it —
          and you can add more anytime from the Library tab.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 md:px-8">
        <Tabs defaultValue="free" className="w-full">
          <TabsList className="w-full">
            <TabsTrigger value="free" className="flex-1">
              <BookOpen className="size-3.5" />
              Free packs
            </TabsTrigger>
            <TabsTrigger value="browse" className="flex-1">
              <ShoppingBag className="size-3.5" />
              Browse
            </TabsTrigger>
            <TabsTrigger value="file" className="flex-1">
              <FileJson className="size-3.5" />
              From file
            </TabsTrigger>
          </TabsList>

          <TabsContent value="free" className="mt-3">
            {freePacks.length === 0 ? (
              <p className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-[12.5px] text-muted-foreground">
                No free {targetName} packs yet. Try the Browse tab, or skip
                and add words as you go.
              </p>
            ) : (
              <div className="grid gap-2">
                {freePacks.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-start gap-3 rounded-md border border-border bg-card px-3 py-2.5"
                  >
                    <BookOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <h4 className="truncate text-[13.5px] font-medium">
                          {p.title}
                        </h4>
                        <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
                          {p.preview.vocabCount.toLocaleString()} words
                          {p.preview.chapterCount
                            ? ` · ${p.preview.chapterCount} chapters`
                            : ""}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                        {p.pitch}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col gap-1.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void openFreePreview(p)}
                        disabled={installingFreeId != null}
                        aria-label="Preview pack contents"
                      >
                        <Eye className="size-3.5" />
                        Preview
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void installFree(p)}
                        disabled={installingFreeId != null}
                      >
                        {installingFreeId === p.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : null}
                        Install
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="browse" className="mt-3">
            <PacksBrowser
              filterLang={target}
              emptyMessage={`No paid packs for ${targetName} yet — check back soon.`}
              onSignInRequested={() => setSignInOpen(true)}
              onRedeem={(pack) => setRedeemPack(pack)}
            />
          </TabsContent>

          <TabsContent value="file" className="mt-3">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                void importFromFile(e.dataTransfer.files?.[0]);
              }}
              className={
                "flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-6 py-8 text-center transition-colors " +
                (dragOver
                  ? "border-foreground/40 bg-accent/30"
                  : "border-border bg-muted/20")
              }
            >
              <FileJson className="size-6 text-muted-foreground" />
              <p className="text-[12.5px] font-medium">
                Drop a{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                  .json
                </code>{" "}
                pack file
              </p>
              <p className="text-[11.5px] text-muted-foreground">
                Exported from Tokori, or any file in the{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                  tokori-pack/v1
                </code>{" "}
                format.
              </p>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  void importFromFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileRef.current?.click()}
                disabled={importingFile}
                className="mt-1"
              >
                {importingFile ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : null}
                Choose file
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3 md:px-8">
        <Button variant="ghost" onClick={onDone}>
          Skip for now
        </Button>
      </div>

      {/* Layered import dialog — handles activation prefs (textbook
          mode, chapter slider) and the actual write to the DB. We
          dismiss onboarding when the import completes so the user
          lands in a workspace that already has content. */}
      <PackImportDialog
        open={redeemPack != null}
        presetPack={redeemPack}
        presetTitle="Add this pack to your workspace"
        onClose={() => setRedeemPack(null)}
        onImported={() => {
          setRedeemPack(null);
          triggerCloudRefresh();
          onDone();
        }}
      />

      <PackPreviewDialog
        pack={previewFreePack}
        loading={previewFreeLoading}
        primaryAction={
          previewFree
            ? {
                label:
                  installingFreeId === previewFree.id
                    ? "Installing…"
                    : "Install",
                disabled: installingFreeId != null,
                onClick: () => {
                  const entry = previewFree;
                  closeFreePreview();
                  if (entry) void installFree(entry);
                },
              }
            : undefined
        }
        onClose={closeFreePreview}
      />

      <CloudSignInDialog
        open={signInOpen}
        onClose={() => setSignInOpen(false)}
      />
    </div>
  );
}
