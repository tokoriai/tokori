import { describe, expect, it } from "vitest";
import {
  orderCustomQueue,
  parseCustomStudyHandoff,
} from "@/lib/study/custom-study";
import {
  buildStudySessionQueue,
  UNCAPPED_DAILY_LIMITS,
} from "@/lib/study-config";
import { createWorkspace, listVocabByIds, saveVocab } from "@/lib/db";

const now = 1_750_000_000;

describe("parseCustomStudyHandoff", () => {
  it("parses the current shape", () => {
    const raw = JSON.stringify({ id: 7, name: "Lektion 3", drill: false });
    expect(parseCustomStudyHandoff(raw)).toEqual({
      collectionId: 7,
      name: "Lektion 3",
      drill: false,
    });
  });

  it("accepts the legacy {id, name} shape and defaults to drill", () => {
    // Pre-drill builds wrote only {id, name}. Defaulting drill ON means
    // a stale payload can never silently move the user's SRS schedule.
    const raw = JSON.stringify({ id: 3, name: "Chapter 1" });
    expect(parseCustomStudyHandoff(raw)).toEqual({
      collectionId: 3,
      name: "Chapter 1",
      drill: true,
    });
  });

  it("falls back to a generic name when missing", () => {
    expect(parseCustomStudyHandoff(JSON.stringify({ id: 1 }))?.name).toBe(
      "Custom",
    );
  });

  it("rejects null, malformed JSON, and payloads without a numeric id", () => {
    expect(parseCustomStudyHandoff(null)).toBeNull();
    expect(parseCustomStudyHandoff("not json")).toBeNull();
    expect(parseCustomStudyHandoff(JSON.stringify({ name: "x" }))).toBeNull();
    expect(parseCustomStudyHandoff(JSON.stringify({ id: "7" }))).toBeNull();
  });
});

describe("orderCustomQueue", () => {
  type Card = { status: string; dueAt: number | null; createdAt: number };
  const card = (
    status: string,
    dueAt: number | null,
    createdAt = 0,
  ): Card => ({ status, dueAt, createdAt });

  it("orders due → fresh → future-scheduled → mastered", () => {
    const due = card("review", now - 100);
    const fresh = card("new", null);
    const unseen = card("unseen", null);
    const future = card("review", now + 86_400);
    const known = card("mastered", now + 86_400);

    const out = orderCustomQueue([known, future, fresh, unseen, due], now);
    expect(out.map((c) => c.status)).toEqual([
      "review",
      "new",
      "unseen",
      "review",
      "mastered",
    ]);
    expect(out[0]).toBe(due);
    expect(out[3]).toBe(future);
  });

  it("treats a learning card with no due date as due now", () => {
    const nullDue = card("learning", null, 5);
    const overdue = card("learning", now - 50);
    const out = orderCustomQueue([nullDue, overdue], now);
    // Both rank 0; tie-break by (dueAt ?? createdAt): 5 < now - 50.
    expect(out[0]).toBe(nullDue);
    expect(out[1]).toBe(overdue);
  });

  it("tie-breaks within a rank by due date, keeping import order for fresh cards", () => {
    const a = card("new", null, 10);
    const b = card("new", null, 20);
    const c = card("unseen", null, 15);
    expect(orderCustomQueue([b, c, a], now)).toEqual([a, c, b]);
  });

  it("does not mutate the input", () => {
    const input = [card("mastered", null), card("new", null)];
    const snapshot = [...input];
    orderCustomQueue(input, now);
    expect(input).toEqual(snapshot);
  });
});

describe("buildStudySessionQueue — UNCAPPED_DAILY_LIMITS", () => {
  it("keeps the whole scope where workspace limits would clip it", () => {
    type Card = { id: number; status: string };
    // A 40-word fresh chapter — the shape right after a pack import.
    const chapter: Card[] = Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      status: "new",
    }));
    const capped = buildStudySessionQueue(chapter, chapter, {
      dailyNewLimit: 20,
      dailyReviewLimit: 200,
    });
    const uncapped = buildStudySessionQueue(
      chapter,
      chapter,
      UNCAPPED_DAILY_LIMITS,
    );
    expect(capped).toHaveLength(20);
    expect(uncapped).toHaveLength(40);
  });
});

describe("listVocabByIds", () => {
  it("returns every requested row regardless of status, due date, or active flag", async () => {
    const ws = await createWorkspace({ targetLang: "de", nativeLang: "en" });

    const fresh = await saveVocab({ workspaceId: ws.id, word: "neu", gloss: "x" });
    const future = await saveVocab({
      workspaceId: ws.id,
      word: "später",
      gloss: "x",
      srsState: { status: "review", dueAt: Math.floor(Date.now() / 1000) + 86_400 },
    });
    const known = await saveVocab({
      workspaceId: ws.id,
      word: "fertig",
      gloss: "x",
      srsState: { status: "mastered" },
    });
    const library = await saveVocab({
      workspaceId: ws.id,
      word: "regal",
      gloss: "x",
      isActive: false,
    });
    // Not requested — must not leak into the result.
    const other = await saveVocab({ workspaceId: ws.id, word: "anders", gloss: "x" });

    const ids = new Set([fresh.id, future.id, known.id, library.id]);
    const rows = await listVocabByIds(ws.id, ids);

    expect(rows.map((v) => v.id).sort()).toEqual([...ids].sort());
    expect(rows.map((v) => v.id)).not.toContain(other.id);
  });

  it("returns [] for an empty id set instead of widening to the workspace", async () => {
    const ws = await createWorkspace({ targetLang: "de", nativeLang: "en" });
    await saveVocab({ workspaceId: ws.id, word: "wort", gloss: "x" });
    expect(await listVocabByIds(ws.id, new Set())).toEqual([]);
  });
});
