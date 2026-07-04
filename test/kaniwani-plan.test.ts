/**
 * Stage-planner tests for the Kaniwani plugin.
 *
 * The planner is the bit users actually feel — it decides whether a
 * card opens with a lesson, what mix of recall stages runs after, and
 * whether a card without a reading still gets a working plan. A
 * seeded RNG keeps these tests deterministic without locking in the
 * exact shuffle order (we only assert structural properties).
 */

import { describe, expect, it } from "vitest";
import { isAcceptableAnswer, planForCard } from "@/lib/study/plugins/kaniwani";
import type { VocabEntry } from "@/lib/study/api";

/** Tiny deterministic RNG so we don't depend on Math.random's
 *  scheduling. Linear congruential, plenty random for shuffling 8
 *  entries. */
function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const ZH_PALETTE = [
  {
    kind: "promptCharacter" as const,
    answerField: "reading" as const,
    label: "pinyin",
    placeholder: "",
    stripTones: true,
  },
  {
    kind: "promptCharacter" as const,
    answerField: "gloss" as const,
    label: "meaning",
    placeholder: "",
  },
  {
    kind: "promptGloss" as const,
    answerField: "reading" as const,
    label: "pinyin from meaning",
    placeholder: "",
    stripTones: true,
  },
  {
    kind: "promptGloss" as const,
    answerField: "word" as const,
    label: "characters",
    placeholder: "",
  },
  {
    kind: "promptAudio" as const,
    answerField: "word" as const,
    label: "audio→characters",
    placeholder: "",
  },
  {
    kind: "promptAudio" as const,
    answerField: "reading" as const,
    label: "audio→pinyin",
    placeholder: "",
    stripTones: true,
  },
];

function makeCard(overrides: Partial<VocabEntry> = {}): VocabEntry {
  return {
    id: 1,
    workspaceId: 1,
    word: "你好",
    reading: "nǐ hǎo",
    gloss: "hello; hi",
    source: "manual",
    status: "review",
    kind: "vocab",
    stability: 1,
    difficulty: 5,
    learningStep: 0,
    dueAt: null,
    lastReview: null,
    reviewCount: 0,
    createdAt: 0,
    imageData: null,
    hasImage: false,
    cardNotes: null,
    frontExtra: null,
    hasAudio: false,
    audioMime: null,
    isActive: true,
    ...overrides,
  };
}

describe("planForCard", () => {
  it("prepends an intro stage for new cards", () => {
    const plan = planForCard(makeCard({ status: "new" }), ZH_PALETTE, seededRandom(1));
    expect(plan[0].kind).toBe("intro");
    expect(plan.length).toBeGreaterThan(1);
  });

  it("doesn't prepend intro for non-new cards", () => {
    const plan = planForCard(
      makeCard({ status: "review" }),
      ZH_PALETTE,
      seededRandom(1),
    );
    expect(plan[0].kind).not.toBe("intro");
  });

  it("caps recall stages at the per-card limit", () => {
    const plan = planForCard(makeCard({ status: "review" }), ZH_PALETTE, seededRandom(7));
    // STAGES_PER_CARD = 3 in production. `pickTones` stages are
    // chained extensions of a paired type-pinyin stage and not
    // counted toward the recall budget — exclude them here.
    const recallOnly = plan.filter((s) => s.kind !== "pickTones");
    expect(recallOnly.length).toBeLessThanOrEqual(3);
    expect(recallOnly.length).toBeGreaterThan(0);
  });

  it("never repeats the same (kind, answerField) pair within a plan", () => {
    const plan = planForCard(makeCard({ status: "review" }), ZH_PALETTE, seededRandom(42));
    const keys = new Set<string>();
    for (const s of plan) {
      keys.add(`${s.kind}:${s.answerField}`);
    }
    expect(keys.size).toBe(plan.length);
  });

  it("skips stages whose answer field is missing on the card", () => {
    const card = makeCard({ status: "review", reading: null });
    const plan = planForCard(card, ZH_PALETTE, seededRandom(3));
    for (const s of plan) {
      // No reading on the card → no reading-prompting stages.
      expect(s.answerField).not.toBe("reading");
    }
  });

  it("returns an empty plan when nothing in the palette is usable", () => {
    const card = makeCard({ status: "review", reading: null, gloss: null });
    // Palette entirely "reading" / "gloss" — neither field is present.
    const palette = ZH_PALETTE.filter(
      (s) => s.answerField === "reading" || s.answerField === "gloss",
    );
    const plan = planForCard(card, palette, seededRandom(99));
    expect(plan).toEqual([]);
  });

  it("includes the intro even when the recall pool is empty", () => {
    const card = makeCard({ status: "new", reading: null, gloss: null });
    const palette = ZH_PALETTE.filter(
      (s) => s.answerField === "reading" || s.answerField === "gloss",
    );
    const plan = planForCard(card, palette, seededRandom(99));
    expect(plan).toHaveLength(1);
    expect(plan[0].kind).toBe("intro");
  });

  it("is deterministic for a given (card, palette, RNG)", () => {
    const card = makeCard({ status: "review" });
    const a = planForCard(card, ZH_PALETTE, seededRandom(123));
    const b = planForCard(card, ZH_PALETTE, seededRandom(123));
    expect(a).toEqual(b);
  });
});

describe("isAcceptableAnswer", () => {
  const tonePinyin = {
    kind: "promptGloss" as const,
    answerField: "reading" as const,
    label: "",
    placeholder: "",
    stripTones: true,
  };
  const chars = {
    kind: "promptGloss" as const,
    answerField: "word" as const,
    label: "",
    placeholder: "",
  };
  const meaning = {
    kind: "promptCharacter" as const,
    answerField: "gloss" as const,
    label: "",
    placeholder: "",
  };

  it("accepts pinyin without tones when stripTones is on", () => {
    expect(isAcceptableAnswer("ni hao", "nǐ hǎo", tonePinyin)).toBe(true);
    expect(isAcceptableAnswer("nihao", "nǐ hǎo", tonePinyin)).toBe(true);
    expect(isAcceptableAnswer("nǐhǎo", "nǐ hǎo", tonePinyin)).toBe(true);
  });

  it("matches CJK ignoring whitespace", () => {
    expect(isAcceptableAnswer("你 好", "你好", chars)).toBe(true);
  });

  it("accepts any sense of a semicolon-split gloss", () => {
    expect(isAcceptableAnswer("hello", "hello; hi; how are you", meaning)).toBe(true);
    expect(isAcceptableAnswer("hi", "hello; hi; how are you", meaning)).toBe(true);
    expect(isAcceptableAnswer("goodbye", "hello; hi; how are you", meaning)).toBe(false);
  });

  it("rejects empty input", () => {
    expect(isAcceptableAnswer("", "你好", chars)).toBe(false);
    expect(isAcceptableAnswer("   ", "你好", chars)).toBe(false);
  });
});
