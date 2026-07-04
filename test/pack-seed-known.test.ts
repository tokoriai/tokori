import { beforeEach, describe, expect, it } from "vitest";
import { resetFallbackStore, saveVocab } from "@/lib/db";

/**
 * Regression test for the "I know chapter N → almost nothing marked
 * known" bug.
 *
 * The HSK free pack ships a flat "all 461 words" collection AND a
 * textbook that covers the same vocabulary. The importer runs the flat
 * collection first, so by the time "previous-known" seeding reaches a
 * chapter word the row already exists. The seed used to apply on INSERT
 * only, so the mastered/known status was silently dropped for every
 * overlapping word — leaving just the handful of words unique to the
 * textbook actually seeded.
 *
 * The fix: a pristine (never-reviewed) row adopts the seed; a row with
 * real review history keeps its schedule. These tests run against the
 * in-memory fallback store, which mirrors the SQLite ON CONFLICT logic.
 */
describe("saveVocab — pack previous-known seeding onto pre-inserted rows", () => {
  beforeEach(() => {
    resetFallbackStore();
  });

  it("adopts a mastered seed onto a pristine row the flat collection inserted first", async () => {
    const workspaceId = 1;
    // 1. Flat "all words" collection inserts the word as reference
    //    (inactive, never reviewed) — no SRS seed.
    await saveVocab({
      workspaceId,
      word: "你",
      reading: "nǐ",
      gloss: "you",
      source: "collection",
      isActive: false,
    });
    // 2. Textbook "previous-known" pass seeds the same word as mastered.
    const seeded = await saveVocab({
      workspaceId,
      word: "你",
      source: "collection",
      isActive: true,
      srsState: {
        status: "mastered",
        stability: 180,
        dueAt: Math.floor(Date.now() / 1000) + 180 * 86_400,
      },
    });
    expect(seeded.status).toBe("mastered");
    expect(seeded.isActive).toBe(true);
    expect(seeded.stability).toBe(180);
    // Stamped so the row counts as studied and shows on the growth chart.
    expect(seeded.lastReview).not.toBeNull();
  });

  it("tops up reading/gloss from the seed when the flat row lacked them", async () => {
    const workspaceId = 1;
    await saveVocab({ workspaceId, word: "好", source: "collection", isActive: false });
    const seeded = await saveVocab({
      workspaceId,
      word: "好",
      reading: "hǎo",
      gloss: "good; well",
      source: "collection",
      isActive: true,
      srsState: { status: "mastered", stability: 180 },
    });
    expect(seeded.reading).toBe("hǎo");
    expect(seeded.gloss).toBe("good; well");
    expect(seeded.status).toBe("mastered");
  });

  it("does not overwrite a row that already has real review history", async () => {
    const workspaceId = 2;
    // A row the user actually studied: a seed with stability stamps
    // lastReview = now, so this row is no longer pristine.
    await saveVocab({
      workspaceId,
      word: "学习",
      source: "manual",
      isActive: true,
      srsState: { status: "review", stability: 10 },
    });
    // A later pack re-import must NOT bump it to mastered.
    const after = await saveVocab({
      workspaceId,
      word: "学习",
      isActive: true,
      srsState: { status: "mastered", stability: 180 },
    });
    expect(after.status).toBe("review");
    expect(after.stability).toBe(10);
  });
});
