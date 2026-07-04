import { beforeEach, describe, expect, it } from "vitest";
import {
  applyCloudVocab,
  cloudIsFresher,
  cloudVocabWins,
  listVocab,
  resetFallbackStore,
  saveVocab,
} from "@/lib/db";

// These tests run in the non-Tauri / non-HOSTED branch — `applyCloudVocab`
// mutates the in-memory fallback store. We reset it between tests so
// each case starts clean.

beforeEach(() => {
  resetFallbackStore();
});

describe("cloudIsFresher", () => {
  it("returns true when cloud's lastReview is more recent", () => {
    expect(
      cloudIsFresher(
        { lastReview: 1000, dueAt: 2000 },
        { lastReview: 2000, dueAt: 2000 },
      ),
    ).toBe(true);
  });

  it("returns false when local's lastReview is more recent", () => {
    expect(
      cloudIsFresher(
        { lastReview: 2000, dueAt: 3000 },
        { lastReview: 1000, dueAt: 9000 },
      ),
    ).toBe(false);
  });

  it("breaks ties on dueAt — a pure reschedule still propagates", () => {
    expect(
      cloudIsFresher(
        { lastReview: 1000, dueAt: 2000 },
        { lastReview: 1000, dueAt: 3000 },
      ),
    ).toBe(true);
  });

  it("treats a NULL on either side as 0 (never-reviewed)", () => {
    expect(
      cloudIsFresher(
        { lastReview: null, dueAt: null },
        { lastReview: 500, dueAt: 1000 },
      ),
    ).toBe(true);
    expect(
      cloudIsFresher(
        { lastReview: 500, dueAt: 1000 },
        { lastReview: null, dueAt: null },
      ),
    ).toBe(false);
  });

  it("returns true when both sides match so pull is idempotent", () => {
    expect(
      cloudIsFresher(
        { lastReview: 100, dueAt: 200 },
        { lastReview: 100, dueAt: 200 },
      ),
    ).toBe(true);
  });
});

describe("cloudVocabWins", () => {
  it("lets the cloud win when the local card was never reviewed", () => {
    // The mismatch fix: a never-reviewed local card (even one with a future
    // dueAt, which the bare watermark would have protected) must adopt the
    // cloud's state so a cloud deactivation (active → unseen) converges.
    expect(
      cloudVocabWins(
        { lastReview: null, dueAt: 5000 },
        { lastReview: null, dueAt: null },
      ),
    ).toBe(true);
  });

  it("protects a locally-reviewed card from a stale never-reviewed cloud row", () => {
    expect(
      cloudVocabWins(
        { lastReview: 2000, dueAt: 3000 },
        { lastReview: null, dueAt: null },
      ),
    ).toBe(false);
  });

  it("still lets fresher cloud reviews win (watermark path)", () => {
    expect(
      cloudVocabWins(
        { lastReview: 1000, dueAt: 2000 },
        { lastReview: 2000, dueAt: 2000 },
      ),
    ).toBe(true);
  });
});

describe("applyCloudVocab", () => {
  const baseCloudRow = {
    workspaceId: 1,
    word: "你好",
    reading: "nǐ hǎo",
    gloss: "hello",
    source: "cloud",
    kind: "vocab" as const,
    isActive: true,
    status: "review" as const,
    stability: 12.5,
    difficulty: 6.2,
    learningStep: 0,
    dueAt: 2_000_000_000,
    lastReview: 1_500_000_000,
    reviewCount: 4,
  };

  it("inserts a missing row with the full SRS snapshot", async () => {
    const r = await applyCloudVocab(baseCloudRow);
    expect(r).toBe("inserted");
    const vocab = await listVocab(1);
    expect(vocab).toHaveLength(1);
    expect(vocab[0]).toMatchObject({
      status: "review",
      stability: 12.5,
      difficulty: 6.2,
      learningStep: 0,
      dueAt: 2_000_000_000,
      lastReview: 1_500_000_000,
      reviewCount: 4,
    });
  });

  it("promotes a stale local row from 'new' to cloud's 'review'", async () => {
    // Pre-existing local row, never reviewed (status=new). This is the
    // bug behind "cloud has more known words than local" — `saveVocab`
    // alone would leave the row stuck on status=new forever.
    await saveVocab({ workspaceId: 1, word: "你好" });
    let v = await listVocab(1);
    expect(v[0]?.status).toBe("new");

    const r = await applyCloudVocab(baseCloudRow);
    expect(r).toBe("updated");

    v = await listVocab(1);
    expect(v[0]?.status).toBe("review");
    expect(v[0]?.stability).toBe(12.5);
    expect(v[0]?.lastReview).toBe(1_500_000_000);
    expect(v[0]?.reviewCount).toBe(4);
  });

  it("does NOT overwrite a locally-fresher row", async () => {
    // Local was reviewed AFTER the cloud snapshot — pull shouldn't
    // wipe newer local progress.
    await applyCloudVocab(baseCloudRow);
    const r = await applyCloudVocab({
      ...baseCloudRow,
      lastReview: 1_400_000_000,
      stability: 3.0,
      status: "learning",
    });
    expect(r).toBe("skipped");
    const v = await listVocab(1);
    expect(v[0]?.status).toBe("review");
    expect(v[0]?.stability).toBe(12.5);
  });

  it("preserves cloud's lastReview rather than stamping nowSec()", async () => {
    // saveVocab stamped lastReview=now when stability>0, which
    // corrupted the dashboard vocab-growth chart on pull. The
    // pull-side function must round-trip the cloud's timestamp.
    await applyCloudVocab(baseCloudRow);
    const v = await listVocab(1);
    expect(v[0]?.lastReview).toBe(1_500_000_000);
  });

  it("propagates the full status set including 'mastered'", async () => {
    await saveVocab({ workspaceId: 1, word: "你好" });
    await applyCloudVocab({ ...baseCloudRow, status: "mastered" });
    const v = await listVocab(1);
    expect(v[0]?.status).toBe("mastered");
  });

  it("converges a cloud deactivation: active 'new' → unseen (the sync mismatch fix)", async () => {
    // Local: an active 'new' card that was never reviewed — e.g. a pack word
    // activated locally. Old behaviour MAX-ed is_active (never deactivating)
    // and skipped the status, so it stayed active + 'new' + due.
    await applyCloudVocab({
      ...baseCloudRow,
      word: "苹果",
      isActive: true,
      status: "new",
      stability: 0,
      difficulty: 5,
      learningStep: 0,
      dueAt: null,
      lastReview: null,
      reviewCount: 0,
    });
    let row = (await listVocab(1)).find((v) => v.word === "苹果");
    expect(row?.isActive).toBe(true);
    expect(row?.status).toBe("new");

    // Cloud has since deactivated it back to library (unseen / inactive).
    const r = await applyCloudVocab({
      ...baseCloudRow,
      word: "苹果",
      isActive: false,
      status: "unseen",
      stability: 0,
      difficulty: 5,
      learningStep: 0,
      dueAt: null,
      lastReview: null,
      reviewCount: 0,
    });
    expect(r).toBe("updated");
    row = (await listVocab(1)).find((v) => v.word === "苹果");
    expect(row?.status).toBe("unseen");
    expect(row?.isActive).toBe(false);
  });

  it("does NOT deactivate a locally-reviewed card from a stale cloud unseen", async () => {
    // Reviewed locally (lastReview set) — a stale cloud 'unseen' must not
    // wipe out a card you're actively studying.
    await applyCloudVocab(baseCloudRow); // review, active, lastReview = 1.5e9
    const r = await applyCloudVocab({
      ...baseCloudRow,
      isActive: false,
      status: "unseen",
      stability: 0,
      dueAt: null,
      lastReview: null,
      reviewCount: 0,
    });
    expect(r).toBe("skipped");
    const v = await listVocab(1);
    expect(v[0]?.isActive).toBe(true);
    expect(v[0]?.status).toBe("review");
  });

  it("merges reading/gloss even when SRS state is skipped", async () => {
    // User reviewed locally (SRS fresher) but edited a richer
    // reading/gloss on the web app. Text fields should always merge,
    // even on the skipped branch.
    await applyCloudVocab({
      ...baseCloudRow,
      reading: null,
      gloss: null,
      stability: 99,
      lastReview: 9_999_999_999,
    });
    const r = await applyCloudVocab(baseCloudRow);
    expect(r).toBe("skipped");
    const v = await listVocab(1);
    expect(v[0]?.reading).toBe("nǐ hǎo");
    expect(v[0]?.gloss).toBe("hello");
  });
});
