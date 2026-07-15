/**
 * Journey AI Coach.
 *
 * Reads the user's current state — journey snapshot, today's stats,
 * weekly stats, streak, active habits, recent sessions — and asks
 * the active LLM provider for a 1-3 sentence nudge in the user's
 * native language plus a list of suggested next actions.
 *
 * The Coach is intentionally lightweight:
 *   - One sendChat call per request, no streaming UI.
 *   - JSON output ({ message, suggestedActions }) parsed defensively.
 *   - No long-term memory in pass 1 — each "Ask the coach" turn is a
 *     fresh call with the current state. (Future: append the last N
 *     coach replies to the prompt for some continuity.)
 *
 * Two call modes:
 *   1. Proactive daily nudge — no userPrompt; the prompt asks for a
 *      concrete suggestion based on the state. Result is cached
 *      client-side once per workspace/day.
 *   2. User question — userPrompt set; the coach answers that
 *      question grounded in the same state.
 *
 * The system prompt encodes the recommended activity mix from the
 * Study Guide (`docs/guides/study-guide.md`) + the tone matrix
 * documented in the plan file. Keep the two in sync.
 */

import type { Habit } from "./habits";
import type { StudySession } from "./db";
import type { LanguageCode } from "./language-profiles";
import { languageName } from "./languages";
import type { LearningJourney, JourneyPace } from "./learning-journey";
import {
  defaultGoalTitle,
  suggestGoalsForJourney,
  type SuggestedGoal,
} from "./goals";
import type { GoalKind, GoalSkill } from "./db";

type SendChat = (args: {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  onToken: (delta: string) => void;
}) => Promise<string>;

export type CoachActionIntent =
  | "open-chat"
  | "open-flashcards"
  | "open-reader"
  | "open-journal"
  | "open-library"
  | "open-vocab"
  | "log-session"
  | "open-study-guide";

export type CoachSuggestedAction = {
  /** Short button label ("Open chat", "Review 10 cards"). */
  label: string;
  /** Drives which nav-event / dialog the UI fires when the user taps
   *  the action button. Any intent the host doesn't recognise renders
   *  the button disabled with a tooltip — never crashes. */
  intent: CoachActionIntent;
};

export type CoachReply = {
  /** 1-3 sentences in the user's native language. The UI renders this
   *  as the primary line of text. */
  message: string;
  /** Optional buttons the user can tap to act on the suggestion. */
  suggestedActions: CoachSuggestedAction[];
};

export type CoachInput = {
  journey: LearningJourney;
  todayStats: {
    sessionsCount: number;
    minutesPracticed: number;
    wordsReviewed: number;
    wordsAdded: number;
  };
  weekStats: {
    sessionsCount: number;
    minutesPracticed: number;
    /** Minutes per session.kind for the past 7 days — the coach uses
     *  this to decide whether the user is balanced across pillars. */
    perKindMinutes: Record<string, number>;
  };
  streakDays: number;
  activeHabits: Habit[];
  /** Habit id → met today. Drives "gentle nudge to finish today's
   *  habit" tone. */
  habitsHit: Record<number, boolean>;
  /** Last few sessions for context (the prompt mentions the most
   *  recent kind). */
  recentSessions: StudySession[];
  targetLang: LanguageCode;
  nativeLang: LanguageCode;
  /** When set, treat as a user-typed question instead of a proactive
   *  nudge. */
  userPrompt?: string;
  sendChat: SendChat;
};

/** Tone keys the prompt uses to choose its register. Exported so the
 *  test can assert on the classification logic without going through
 *  the LLM. */
export type CoachTone =
  | "on-pace-and-habits-hit"
  | "on-pace-missed-habit-today"
  | "behind-pace"
  | "way-behind"
  | "milestone-reached"
  | "early-days";

/** Classify the user's state into a tone bucket. Drives the
 *  `## TONE` line of the system prompt. */
export function classifyTone(input: CoachInput): CoachTone {
  const sevenDays = 7 * 86_400;
  const now = Math.floor(Date.now() / 1000);
  const recentSessions = input.recentSessions.filter(
    (s) => s.startedAt >= now - sevenDays,
  );
  if (recentSessions.length === 0 && input.streakDays === 0) {
    return "way-behind";
  }

  // If the most recent completed milestone was flipped in the last
  // 24h, lead with celebration.
  const completedRecently = input.journey.milestones.find(
    (m) =>
      m.status === "completed" &&
      m.completedAt != null &&
      now - m.completedAt < 86_400,
  );
  if (completedRecently) return "milestone-reached";

  // Treat a brand-new account (no history) gently.
  if (input.journey.currentVocab < 25 && input.weekStats.sessionsCount < 3) {
    return "early-days";
  }

  const habitsToday = Object.values(input.habitsHit).filter(Boolean).length;
  const totalHabits = input.activeHabits.length;
  const habitsAllHit = totalHabits > 0 && habitsToday === totalHabits;

  switch (input.journey.pace) {
    case "ahead":
    case "on":
      return habitsAllHit ? "on-pace-and-habits-hit" : "on-pace-missed-habit-today";
    case "behind":
      return "behind-pace";
    default:
      // No pace info (no deadline). Treat as on-pace; the user
      // hasn't set a deadline because they don't want pressure.
      return habitsAllHit ? "on-pace-and-habits-hit" : "on-pace-missed-habit-today";
  }
}

/** Build the system prompt. Exported for tests that want to assert
 *  on prompt content without going through the LLM. */
export function buildCoachPrompt(
  input: CoachInput,
  tone: CoachTone,
): { system: string; user: string } {
  const target = languageName(input.targetLang);
  const native = languageName(input.nativeLang);
  const j = input.journey;

  const nextMilestone = j.milestones.find(
    (m) => m.status === "in-progress" || m.status === "locked",
  );

  const habitsLine =
    input.activeHabits.length === 0
      ? "The user has no active habits."
      : input.activeHabits
          .map((h) => {
            const hit = input.habitsHit[h.id] ? "✓" : "·";
            return `${hit} ${h.name} (${Math.round(h.targetSecs / 60)} min, ${h.frequency})`;
          })
          .join(", ");

  const perKindLine =
    Object.keys(input.weekStats.perKindMinutes).length === 0
      ? "(no sessions logged this week)"
      : Object.entries(input.weekStats.perKindMinutes)
          .map(([k, m]) => `${k}=${Math.round(m)}min`)
          .join(", ");

  const paceLine = describePace(j.pace, j.deadline, j.projectedDaysRemaining);

  const toneInstructions: Record<CoachTone, string> = {
    "on-pace-and-habits-hit":
      "Celebrate the consistency in one short line, then suggest ONE stretch action that nudges the next pillar of their study mix.",
    "on-pace-missed-habit-today":
      "Acknowledge they're on track for the bigger goal, then gently point at the habit they haven't met today. Be specific about how much is left.",
    "behind-pace":
      "Empathetic but specific. Name ONE small concrete action they could take in the next 15 minutes. Avoid 'study more' platitudes.",
    "way-behind":
      "Compassionate. Lower the bar — suggest a single 5-minute action. Make it feel easy.",
    "milestone-reached":
      "Celebrate the milestone they just hit by name, then frame the next milestone (vocab + hours) without making it feel like a treadmill.",
    "early-days":
      "Welcoming and concrete. The user is just getting started. Suggest ONE foundational action (set a daily flashcard habit, save a few words from a chat, install a dictionary).",
  };

  const recommendedMix = `
## Recommended activity mix (from study-guide.md)
- Early (first quarter of the scale): review 60%, input 30%, tutor 10%, output 0%
- Building (25-55%): review 35%, input 45%, tutor 15%, output 5%
- Consolidating (55-80%): review 20%, input 50%, tutor 20%, output 10%
- Fluency (>80%): review 10%, input 55%, tutor 20%, output 15%

The user's *current* phase is implied by their level position in the scale (${j.currentLevelId} on the ${j.scale.toUpperCase()} scale).
`.trim();

  const systemLines: string[] = [
    `You are Tokori's writing tutor speaking to a ${target} learner whose native language is ${native}. You always reply in ${native}.`,
    "",
    "Your job is to write ONE concrete next-step suggestion plus optional one-tap action buttons. Be brief, specific, and grounded in the state below — do not invent stats.",
    "",
    "## TONE",
    toneInstructions[tone],
    "",
    "## OUTPUT FORMAT — STRICT JSON, no markdown fences, no preface",
    `{"message": "<1-3 sentences in ${native}>", "suggestedActions": [{"label": "<short button text>", "intent": "<one of: open-chat | open-flashcards | open-reader | open-journal | open-library | open-vocab | log-session | open-study-guide>"}]}`,
    "",
    "Rules:",
    `- "message" — 1 to 3 sentences MAX, in ${native}. Concrete, not generic. Reference an actual count or activity from the state below. Never include the word "study" without specifying which pillar.`,
    `- "suggestedActions" — 0 to 3 actions. Omit entirely (empty array) if none apply. Prefer actions that match the recommended mix at the user's current phase.`,
    `- Do NOT translate the message into ${target}. Stay in ${native}.`,
    "- Output ONLY the JSON object. No closing remarks.",
    "",
    recommendedMix,
  ];

  const userLines: string[] = [
    "## STATE",
    `Journey: ${j.scale.toUpperCase()} scale, currently ${j.currentLevelId}, target ${j.targetLevelId}.`,
    `Words known: ${j.currentVocab}. Immersion hours: ${j.currentHours.toFixed(1)}.`,
    nextMilestone
      ? `Next milestone: ${nextMilestone.label} (${nextMilestone.vocabTarget} words, ${nextMilestone.hoursTarget}h).`
      : "All milestones cleared on this journey.",
    paceLine,
    "",
    `Today: ${input.todayStats.sessionsCount} sessions, ${input.todayStats.minutesPracticed} min, +${input.todayStats.wordsAdded} new words, ${input.todayStats.wordsReviewed} reviewed.`,
    `This week: ${input.weekStats.sessionsCount} sessions, ${input.weekStats.minutesPracticed} min. Per kind: ${perKindLine}.`,
    `Streak: ${input.streakDays} days.`,
    `Habits: ${habitsLine}.`,
    "",
  ];

  if (input.userPrompt && input.userPrompt.trim()) {
    userLines.push(`## USER QUESTION`, input.userPrompt.trim());
  } else {
    userLines.push(
      "## ASK",
      "Generate today's proactive nudge. Pick the single highest-leverage next action.",
    );
  }

  return {
    system: systemLines.join("\n"),
    user: userLines.join("\n"),
  };
}

function describePace(
  pace: JourneyPace,
  deadline: number | null,
  projectedDaysRemaining: number | null,
): string {
  if (!deadline) {
    return "Pace: not set (no deadline).";
  }
  const now = Math.floor(Date.now() / 1000);
  const daysToDeadline = Math.max(0, Math.ceil((deadline - now) / 86_400));
  const paceLabel = pace ?? "unknown";
  const projection =
    projectedDaysRemaining != null
      ? ` Projected to reach target in ${projectedDaysRemaining} days at current pace.`
      : "";
  return `Pace: ${paceLabel} (${daysToDeadline} days to deadline).${projection}`;
}

/** Ask the coach. Returns a parsed reply with a fallback empty
 *  `suggestedActions` if the model omits them. */
export async function askCoach(input: CoachInput): Promise<CoachReply> {
  const tone = classifyTone(input);
  const { system, user } = buildCoachPrompt(input, tone);

  const raw = await input.sendChat({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    onToken: () => {},
  });

  return parseCoachReply(raw);
}

const VALID_INTENTS: ReadonlySet<CoachActionIntent> = new Set<CoachActionIntent>([
  "open-chat",
  "open-flashcards",
  "open-reader",
  "open-journal",
  "open-library",
  "open-vocab",
  "log-session",
  "open-study-guide",
]);

/** Parse the LLM's JSON reply, tolerating ```fences``` and trailing
 *  prose. Falls back to using the raw text as the message so the UI
 *  always has something to render. Exported for tests. */
export function parseCoachReply(raw: string): CoachReply {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  const lo = s.indexOf("{");
  const hi = s.lastIndexOf("}");
  if (lo >= 0 && hi > lo) s = s.slice(lo, hi + 1);

  try {
    const parsed = JSON.parse(s) as Record<string, unknown>;
    const message =
      typeof parsed.message === "string" && parsed.message.trim()
        ? parsed.message.trim()
        : "";
    const actionsRaw = Array.isArray(parsed.suggestedActions)
      ? (parsed.suggestedActions as unknown[])
      : [];
    const actions: CoachSuggestedAction[] = [];
    for (const a of actionsRaw) {
      if (!a || typeof a !== "object") continue;
      const obj = a as Record<string, unknown>;
      const label = typeof obj.label === "string" ? obj.label.trim() : "";
      const intent = obj.intent as CoachActionIntent;
      if (label && VALID_INTENTS.has(intent)) {
        actions.push({ label: label.slice(0, 32), intent });
      }
    }
    if (message) {
      return { message, suggestedActions: actions.slice(0, 3) };
    }
  } catch {
    /* fall through to raw-text fallback */
  }

  // Fallback path — the model emitted prose. Use it directly so the
  // UI shows something the user can read. The Coach will get a
  // second chance on the next refresh.
  return {
    message: cleanFallback(raw).slice(0, 400),
    suggestedActions: [],
  };
}

function cleanFallback(raw: string): string {
  return raw
    .trim()
    .replace(/^[*_"'“”„«»]+|[*_"'“”„«»]+$/g, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
}

// ── Goal suggestion (AI) ─────────────────────────────────────────────
//
// askCoach() tells the user what to *do* next; this turns the same
// journey state into 2-3 concrete, adoptable GOALS. The UI renders them
// with an "Adopt" button that calls `createGoal`, after which the
// existing goal → habit-plan → auto-progress pipeline takes over. Falls
// back to the heuristic `suggestGoalsForJourney` whenever the provider is
// missing or the model returns something unparseable, so the "Suggest
// goals" button is never a dead end.

export type SuggestGoalsInput = {
  journey: LearningJourney;
  sessions: StudySession[];
  targetLang: LanguageCode;
  nativeLang: LanguageCode;
  sendChat: SendChat;
};

export async function suggestGoalsWithCoach(
  input: SuggestGoalsInput,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SuggestedGoal[]> {
  const fallback = () => suggestGoalsForJourney(input.journey, input.sessions, now);
  let raw: string;
  try {
    const { system, user } = buildGoalPrompt(input, now);
    raw = await input.sendChat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      onToken: () => {},
    });
  } catch {
    return fallback();
  }
  const parsed = parseSuggestedGoals(raw, now);
  return parsed.length ? parsed.slice(0, 3) : fallback();
}

function buildGoalPrompt(
  input: SuggestGoalsInput,
  now: number,
): { system: string; user: string } {
  const target = languageName(input.targetLang);
  const native = languageName(input.nativeLang);
  const j = input.journey;
  const nextMilestone = j.milestones.find(
    (m) => m.status === "in-progress" || m.status === "locked",
  );

  const fourteenDaysAgo = now - 14 * 86_400;
  const perKind: Record<string, number> = {};
  for (const s of input.sessions) {
    if (s.startedAt < fourteenDaysAgo) continue;
    perKind[s.kind] = (perKind[s.kind] ?? 0) + (s.durationSecs ?? 0) / 60;
  }
  const perKindLine =
    Object.keys(perKind).length === 0
      ? "(no sessions in the last 14 days)"
      : Object.entries(perKind)
          .map(([k, m]) => `${k}=${Math.round(m)}min`)
          .join(", ");

  const system = [
    `You are Tokori's study planner for a ${target} learner whose native language is ${native}.`,
    "Propose concrete, measurable goals that fit the learner's current state and move them toward their target level.",
    "",
    "## OUTPUT — a STRICT JSON array, no markdown fences, no prose:",
    `[{"title": "<short title in ${native}>", "kind": "vocab" | "minutes" | "sessions", "skill": null | "reading" | "writing" | "speaking" | "listening", "target": <positive integer>, "deadlineDays": <integer days from today, or null>, "rationale": "<one short line in ${native}>"}]`,
    "",
    "Rules:",
    "- Return 2 or 3 goals, realistic for the next 2-8 weeks.",
    "- 'vocab' = words mastered; 'minutes' = minutes practiced; 'sessions' = sessions completed.",
    "- Lead with a vocab goal toward the next milestone, then a goal for the weakest / most-neglected skill.",
    "- 'skill' must be null for vocab goals.",
    "- 'target' is a number only (no units). 'deadlineDays' null means open-ended.",
    `- Write 'title' and 'rationale' in ${native}. Output ONLY the JSON array.`,
  ].join("\n");

  const user = [
    "## STATE",
    `Scale ${j.scale.toUpperCase()} — current ${j.currentLevelId}, target ${j.targetLevelId}.`,
    `Words known: ${j.currentVocab}. Immersion hours: ${j.currentHours.toFixed(1)}.`,
    nextMilestone
      ? `Next milestone: ${nextMilestone.label} needs ${nextMilestone.vocabTarget} words known.`
      : "All milestones on this journey are cleared.",
    j.deadline
      ? `A target deadline is set (${Math.max(0, Math.ceil((j.deadline - now) / 86_400))} days away).`
      : "No deadline set.",
    `Practice by kind, last 14 days: ${perKindLine}.`,
    "",
    "Propose the goals now.",
  ].join("\n");

  return { system, user };
}

const SUGGEST_VALID_KINDS: ReadonlySet<string> = new Set([
  "vocab",
  "minutes",
  "sessions",
]);
const SUGGEST_VALID_SKILLS: ReadonlySet<string> = new Set([
  "reading",
  "writing",
  "speaking",
  "listening",
]);

/** Parse the model's JSON goal array into validated `SuggestedGoal[]`.
 *  Tolerates ```fences``` and surrounding prose; drops malformed
 *  entries; converts `deadlineDays` into an absolute epoch. Exported for
 *  tests. */
export function parseSuggestedGoals(
  raw: string,
  now: number = Math.floor(Date.now() / 1000),
): SuggestedGoal[] {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  const lo = s.indexOf("[");
  const hi = s.lastIndexOf("]");
  if (lo >= 0 && hi > lo) s = s.slice(lo, hi + 1);

  let arr: unknown;
  try {
    arr = JSON.parse(s);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const out: SuggestedGoal[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = typeof o.kind === "string" ? o.kind : "";
    if (!SUGGEST_VALID_KINDS.has(kind)) continue;
    const target =
      typeof o.target === "number" && Number.isFinite(o.target)
        ? Math.round(o.target)
        : 0;
    if (target <= 0) continue;
    const skillRaw = typeof o.skill === "string" ? o.skill : null;
    const skill: GoalSkill =
      kind !== "vocab" && skillRaw && SUGGEST_VALID_SKILLS.has(skillRaw)
        ? (skillRaw as GoalSkill)
        : null;
    const dd = o.deadlineDays;
    const deadline =
      typeof dd === "number" && Number.isFinite(dd) && dd > 0
        ? now + Math.round(dd) * 86_400
        : null;
    const title =
      typeof o.title === "string" && o.title.trim()
        ? o.title.trim().slice(0, 80)
        : defaultGoalTitle(kind as GoalKind, skill, target, deadline);
    const rationale =
      typeof o.rationale === "string" ? o.rationale.trim().slice(0, 160) : "";
    out.push({ title, kind: kind as GoalKind, skill, target, deadline, rationale });
    if (out.length >= 3) break;
  }
  return out;
}
