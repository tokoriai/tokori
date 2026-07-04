import { describe, expect, it } from "vitest";
import {
  ALL_VOCAB_STATUSES,
  filterVocab,
  intervalDays,
  isOverdue,
  sortVocab,
  type BrowseFilter,
} from "@/lib/vocab-browse";
import type { VocabEntry, VocabStatus } from "@/lib/db";

const NOW = 1_700_000_000;

function card(overrides: Partial<VocabEntry> = {}): VocabEntry {
  return {
    id: Math.floor(Math.random() * 1e9),
    workspaceId: 1,
    word: "字",
    reading: null,
    gloss: null,
    source: "test",
    status: "new",
    kind: "vocab",
    stability: 0,
    difficulty: 5,
    learningStep: 0,
    dueAt: null,
    lastReview: null,
    reviewCount: 0,
    createdAt: NOW,
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

const baseFilter: BrowseFilter = {
  search: "",
  statuses: new Set(ALL_VOCAB_STATUSES),
  kind: "all",
};

describe("vocab-browse — isOverdue", () => {
  it("flags an active, seen card past its due date", () => {
    expect(isOverdue(card({ status: "review", dueAt: NOW - 86_400 }), NOW)).toBe(true);
  });
  it("never flags new / unseen / library cards", () => {
    expect(isOverdue(card({ status: "new", dueAt: NOW - 86_400 }), NOW)).toBe(false);
    expect(isOverdue(card({ status: "unseen", dueAt: NOW - 86_400 }), NOW)).toBe(false);
    expect(isOverdue(card({ status: "review", dueAt: NOW - 86_400, isActive: false }), NOW)).toBe(false);
  });
  it("is not overdue when due is in the future", () => {
    expect(isOverdue(card({ status: "review", dueAt: NOW + 86_400 }), NOW)).toBe(false);
  });
});

describe("vocab-browse — intervalDays", () => {
  it("rounds FSRS stability to whole days, floored at 0", () => {
    expect(intervalDays(card({ stability: 12.4 }))).toBe(12);
    expect(intervalDays(card({ stability: 0 }))).toBe(0);
    expect(intervalDays(card({ stability: -3 }))).toBe(0);
  });
});

describe("vocab-browse — filterVocab", () => {
  const rows = [
    card({ word: "你好", reading: "nǐ hǎo", gloss: "hello", status: "mastered", kind: "vocab" }),
    card({ word: "句子", reading: "jùzi", gloss: "a sentence example", status: "new", kind: "sentence" }),
    card({ word: "写", reading: "xiě", gloss: "to write", status: "learning", kind: "writing" }),
  ];
  it("shows only the statuses in the set", () => {
    expect(
      filterVocab(rows, { ...baseFilter, statuses: new Set<VocabStatus>(["mastered"]) }).map((r) => r.word),
    ).toEqual(["你好"]);
  });
  it("hides excluded statuses (e.g. known + unseen)", () => {
    const shown = new Set<VocabStatus>(["new", "learning", "review"]);
    expect(
      filterVocab(rows, { ...baseFilter, statuses: shown }).map((r) => r.word).sort(),
    ).toEqual(["写", "句子"].sort());
  });
  it("filters by kind/type", () => {
    expect(filterVocab(rows, { ...baseFilter, kind: "sentence" }).map((r) => r.word)).toEqual(["句子"]);
  });
  it("searches word, reading, and gloss case-insensitively", () => {
    expect(filterVocab(rows, { ...baseFilter, search: "HELLO" }).map((r) => r.word)).toEqual(["你好"]);
    expect(filterVocab(rows, { ...baseFilter, search: "xiě" }).map((r) => r.word)).toEqual(["写"]);
    expect(filterVocab(rows, { ...baseFilter, search: "sentence" }).map((r) => r.word)).toEqual(["句子"]);
  });
  it("combines filters (AND)", () => {
    expect(filterVocab(rows, { ...baseFilter, kind: "vocab", search: "to write" })).toHaveLength(0);
  });
});

describe("vocab-browse — sortVocab", () => {
  it("sorts by due ascending with new/no-due cards sinking to the bottom", () => {
    const rows = [
      card({ word: "later", status: "review", dueAt: NOW + 86_400 }),
      card({ word: "new", status: "new", dueAt: null }),
      card({ word: "overdue", status: "review", dueAt: NOW - 86_400 }),
    ];
    expect(sortVocab(rows, "due", "asc").map((r) => r.word)).toEqual(["overdue", "later", "new"]);
  });
  it("keeps no-due cards at the bottom even when descending", () => {
    const rows = [
      card({ word: "new", dueAt: null, status: "new" }),
      card({ word: "soon", dueAt: NOW + 100, status: "review" }),
      card({ word: "far", dueAt: NOW + 999, status: "review" }),
    ];
    // desc → far, soon, then null last (not first).
    expect(sortVocab(rows, "due", "desc").map((r) => r.word)).toEqual(["far", "soon", "new"]);
  });
  it("sorts by status in learning-progression order, not alphabetically", () => {
    const rows = [
      card({ word: "c", status: "mastered" }),
      card({ word: "a", status: "new" }),
      card({ word: "b", status: "learning" }),
    ];
    expect(sortVocab(rows, "status", "asc").map((r) => r.status)).toEqual(["new", "learning", "mastered"]);
  });
  it("sorts by added (createdAt) descending = newest first", () => {
    const rows = [
      card({ word: "old", createdAt: NOW - 1000 }),
      card({ word: "newest", createdAt: NOW }),
      card({ word: "mid", createdAt: NOW - 500 }),
    ];
    expect(sortVocab(rows, "added", "desc").map((r) => r.word)).toEqual(["newest", "mid", "old"]);
  });
  it("is stable: ties break on word ascending regardless of direction", () => {
    const rows = [
      card({ word: "b", reviewCount: 5 }),
      card({ word: "a", reviewCount: 5 }),
    ];
    expect(sortVocab(rows, "reviews", "asc").map((r) => r.word)).toEqual(["a", "b"]);
    expect(sortVocab(rows, "reviews", "desc").map((r) => r.word)).toEqual(["a", "b"]);
  });
  it("does not mutate the input array", () => {
    const rows = [card({ word: "b" }), card({ word: "a" })];
    const before = rows.map((r) => r.word);
    sortVocab(rows, "word", "asc");
    expect(rows.map((r) => r.word)).toEqual(before);
  });
});
