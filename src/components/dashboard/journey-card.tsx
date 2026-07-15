/**
 * Dashboard widget: Learning Journey snapshot.
 *
 * One card showing:
 *   - Current level → target level (gradient progress bar)
 *   - Live vocab + immersion counts
 *   - The latest AI coach nudge (cached in localStorage per-workspace,
 *     auto-refreshes once per calendar day, refresh-on-demand button)
 *   - A "Plan view →" button that navigates to the Journey tab
 *
 * Reads:
 *   - `useProfile().profile.goalLevel`     → target level id
 *   - `useJourneySettings(workspaceId)`    → deadline, weekly minutes,
 *                                            milestone overrides
 *   - `ctx.vocab` / `ctx.sessions`         → live vocab / hours
 *   - `useProviderConfigs().sendChat`      → coach LLM call
 *
 * Cache key: `journey.coach.lastNudge.<workspaceId>`. The cached
 * blob is `{ ymd: "YYYY-MM-DD", reply: CoachReply }` — when ymd ≠
 * today the next dashboard mount refreshes. Manual ↻ forces a
 * refresh regardless.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCcw, Sparkles, Target } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  computeLearningJourney,
  type LearningJourney,
} from "@/lib/learning-journey";
import { askCoach, type CoachReply } from "@/lib/journey-coach";
import { scaleFor } from "@/lib/level";
import { useJourneySettings } from "@/lib/use-journey-settings";
import { useProfile } from "@/lib/profile-context";
import { useProviderConfigs } from "@/lib/provider-context";
import type { WidgetContext } from "@/lib/widget-registry";

/** Persistent per-workspace cache of the latest coach nudge. */
type CachedNudge = {
  /** YYYY-MM-DD in the user's local timezone. When it differs from
   *  today's ymd, the card auto-refreshes. */
  ymd: string;
  reply: CoachReply;
};

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nudgeKey(workspaceId: number): string {
  return `journey.coach.lastNudge.${workspaceId}`;
}

function loadNudge(workspaceId: number): CachedNudge | null {
  try {
    const raw = localStorage.getItem(nudgeKey(workspaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedNudge;
    if (parsed && typeof parsed.ymd === "string" && parsed.reply) {
      return parsed;
    }
  } catch {
    /* corrupt — drop */
  }
  return null;
}

function storeNudge(workspaceId: number, nudge: CachedNudge): void {
  try {
    localStorage.setItem(nudgeKey(workspaceId), JSON.stringify(nudge));
  } catch {
    /* private mode / quota — non-fatal */
  }
}

export function JourneyCard({ ctx }: { ctx: WidgetContext }) {
  const { profile } = useProfile();
  const { sendChat } = useProviderConfigs();
  const { settings: jSettings, ready: settingsReady } = useJourneySettings(
    ctx.workspace.id,
  );

  // Resolve scale (honour the profile's manual scale choice, then the
  // workspace's language default).
  const scale = useMemo(() => {
    if (profile.levelScale === "auto") return scaleFor(ctx.workspace.targetLang);
    if (profile.levelScale === "custom") return "custom" as const;
    return profile.levelScale;
  }, [profile.levelScale, ctx.workspace.targetLang]);

  // The journey snapshot. Recomputed any time the underlying inputs
  // change — cheap pure function, no memo needed beyond the inputs.
  const journey: LearningJourney | null = useMemo(() => {
    if (!settingsReady) return null;
    const targetLevelId =
      jSettings.targetLevelId ?? profile.goalLevel ?? "";
    if (!targetLevelId) return null;
    return computeLearningJourney({
      workspace: ctx.workspace,
      vocab: ctx.vocab,
      reviews: ctx.reviews,
      sessions: ctx.sessions,
      scale,
      targetLevelId,
      deadline: jSettings.deadline,
      weeklyMinutesTarget: jSettings.weeklyMinutesTarget,
      manualOverrides: jSettings.manualOverrides,
      customLevels: profile.customScale ?? undefined,
    });
  }, [
    settingsReady,
    jSettings,
    profile.goalLevel,
    profile.customScale,
    scale,
    ctx.workspace,
    ctx.vocab,
    ctx.reviews,
    ctx.sessions,
  ]);

  // Cached coach nudge state.
  const [nudge, setNudge] = useState<CachedNudge | null>(() =>
    loadNudge(ctx.workspace.id),
  );
  const [refreshing, setRefreshing] = useState(false);

  // Auto-refresh when the cached nudge is stale (different ymd) and
  // we have a journey to feed in. Runs once per mount per workspace.
  useEffect(() => {
    if (!journey || !sendChat) return;
    const cached = loadNudge(ctx.workspace.id);
    if (cached && cached.ymd === todayYmd()) {
      setNudge(cached);
      return;
    }
    void refreshNudge();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journey?.workspaceId, journey?.currentLevelId, journey?.targetLevelId]);

  async function refreshNudge() {
    if (!journey || refreshing) return;
    setRefreshing(true);
    try {
      const reply = await askCoach({
        journey,
        todayStats: todayStatsFromCtx(ctx),
        weekStats: weekStatsFromCtx(ctx),
        streakDays: 0,             // widget doesn't have streak handy; coach treats 0 as not-known
        activeHabits: [],
        habitsHit: {},
        recentSessions: ctx.sessions.slice(-5),
        targetLang: ctx.workspace.targetLang,
        nativeLang: ctx.workspace.nativeLang,
        sendChat,
      });
      const next: CachedNudge = { ymd: todayYmd(), reply };
      setNudge(next);
      storeNudge(ctx.workspace.id, next);
    } catch (err) {
      toast.error("Coach didn't respond", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRefreshing(false);
    }
  }

  if (!journey) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-6 text-center">
        <Target className="size-5 text-muted-foreground" />
        <p className="text-[12.5px] text-muted-foreground">
          Set a target level to start your journey.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => ctx.onNavigate("journey")}
        >
          Open Journey
        </Button>
      </div>
    );
  }

  const targetMilestone =
    journey.milestones.find((m) => m.levelId === journey.targetLevelId) ??
    journey.milestones[journey.milestones.length - 1];
  const startMilestone =
    journey.milestones.find((m) => m.levelId === journey.currentLevelId) ??
    journey.milestones[0];

  const scoreSpan = Math.max(
    1,
    (targetMilestone?.vocabTarget ?? 0) - (startMilestone?.vocabTarget ?? 0),
  );
  const pct = Math.min(
    1,
    Math.max(
      0,
      (journey.currentVocab - (startMilestone?.vocabTarget ?? 0)) / scoreSpan,
    ),
  );

  return (
    <div className="flex h-full flex-col gap-3 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          <Target className="size-3" />
          Your journey
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[11.5px]"
          onClick={() => ctx.onNavigate("journey")}
        >
          Plan view →
        </Button>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-serif text-lg tracking-tight">
            {journey.currentLevelId}
          </span>
          <span className="text-[11px] text-muted-foreground">
            target {journey.targetLevelId}
          </span>
        </div>
        <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-sky-500 to-violet-500 transition-all"
            style={{ width: `${Math.round(pct * 100)}%` }}
          />
        </div>
        <p className="text-[11.5px] text-muted-foreground">
          {journey.currentVocab} words · {journey.currentHours.toFixed(1)}h
          immersion · target {targetMilestone?.vocabTarget ?? 0} words ·{" "}
          {targetMilestone?.hoursTarget ?? 0}h
        </p>
      </div>

      <div className="mt-auto rounded-md border border-border bg-muted/30 px-3 py-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            <Sparkles className="size-3" />
            Coach
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => void refreshNudge()}
            disabled={refreshing || !sendChat}
            className="h-6 w-6"
            title="Refresh nudge"
          >
            {refreshing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCcw className="size-3" />
            )}
          </Button>
        </div>
        {nudge ? (
          <p className="text-[12.5px] leading-relaxed text-foreground/90">
            {nudge.reply.message}
          </p>
        ) : (
          <p className="text-[12.5px] italic text-muted-foreground">
            {refreshing
              ? "Generating your nudge…"
              : "No suggestion yet — pick a target level + active provider."}
          </p>
        )}
        {nudge && nudge.reply.suggestedActions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {nudge.reply.suggestedActions.map((a, i) => (
              <Button
                key={i}
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[11px]"
                onClick={() => dispatchCoachIntent(a.intent, ctx)}
              >
                {a.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function todayStatsFromCtx(ctx: WidgetContext) {
  const now = Math.floor(Date.now() / 1000);
  const start = startOfDayEpoch(now);
  const today = ctx.sessions.filter((s) => s.startedAt >= start);
  const minutes = today.reduce((acc, s) => acc + (s.durationSecs ?? 0), 0) / 60;
  // wordsReviewed approximated from reviews log; widget doesn't carry
  // a per-day reviews count today. Pass 0 when unavailable — the
  // coach treats it as "unknown".
  return {
    sessionsCount: today.length,
    minutesPracticed: Math.round(minutes),
    wordsReviewed: 0,
    wordsAdded: ctx.vocab.filter((v) => v.createdAt >= start).length,
  };
}

function weekStatsFromCtx(ctx: WidgetContext) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 7 * 86_400;
  const week = ctx.sessions.filter((s) => s.startedAt >= start);
  const minutes = week.reduce((acc, s) => acc + (s.durationSecs ?? 0), 0) / 60;
  const perKind: Record<string, number> = {};
  for (const s of week) {
    perKind[s.kind] = (perKind[s.kind] ?? 0) + (s.durationSecs ?? 0) / 60;
  }
  return {
    sessionsCount: week.length,
    minutesPracticed: Math.round(minutes),
    perKindMinutes: perKind,
  };
}

function startOfDayEpoch(now: number): number {
  const d = new Date(now * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function dispatchCoachIntent(
  intent: CoachReply["suggestedActions"][number]["intent"],
  ctx: WidgetContext,
) {
  switch (intent) {
    case "open-chat":
      ctx.onNavigate("chat");
      return;
    case "open-flashcards":
      ctx.onNavigate("flashcards");
      return;
    case "open-reader":
      ctx.onNavigate("reader");
      return;
    case "open-journal":
      ctx.onNavigate("journal");
      return;
    case "open-library":
      ctx.onNavigate("library");
      return;
    case "open-vocab":
      ctx.onNavigate("vocab");
      return;
    case "log-session":
      ctx.openLogActivity();
      return;
    case "open-study-guide":
      // Docs site is external; the dashboard doesn't deep-link out
      // (Tauri can but the routing is owned by the shell). Toast as
      // a placeholder so the action does *something* — a future
      // pass can plumb a docs deep-link.
      toast.message("Study guide", {
        description: "See docs/guides/study-guide.md in the project tree.",
      });
      return;
  }
}
