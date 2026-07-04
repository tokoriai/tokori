import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkspace,
  listDueVocab,
  listStudyVocab,
  saveVocab,
} from "@/lib/db";

/**
 * Regression: "Add & study now" from a textbook chapter used to land
 * the user on an empty Flashcards view when the workspace already had
 * more cards due workspace-wide than the queue limit. The custom-
 * collection filter ran *after* the SQL LIMIT, so freshly-nudged
 * cards (all sharing `due_at = now`) got clipped before the filter
 * saw them. Pushing the filter into the SQL via `restrictToIds`
 * keeps the LIMIT honest to the constraint.
 */

const now = Math.floor(Date.now() / 1000);

async function seedDue(workspaceId: number, word: string, dueAt: number): Promise<number> {
  const v = await saveVocab({
    workspaceId,
    word,
    gloss: "x",
    srsState: { status: "learning", dueAt },
  });
  return v.id;
}

describe("listDueVocab — restrictToIds", () => {
  it("returns target cards even when the global queue would clip them", async () => {
    const ws = await createWorkspace({ targetLang: "de", nativeLang: "en" });

    // Older-due "distraction" cards — these would fill the top of the
    // global queue and starve a post-filter intersection.
    for (let i = 0; i < 50; i++) {
      await seedDue(ws.id, `distract-${i}`, now - 1000 - i);
    }

    // 5 freshly-nudged target cards all sharing `due_at = now` — the
    // shape you get after `pushCollectionToDue` flips a chapter's
    // words to learning at the same instant.
    const targetIds: number[] = [];
    for (let i = 0; i < 5; i++) {
      targetIds.push(await seedDue(ws.id, `target-${i}`, now));
    }

    const restrict = new Set(targetIds);
    const due = await listDueVocab(ws.id, 20, restrict);
    expect(due.map((v) => v.id).sort()).toEqual([...targetIds].sort());
  });

  it("falls back to global behaviour when restrictToIds is null or empty", async () => {
    const ws = await createWorkspace({ targetLang: "de", nativeLang: "en" });
    const id = await seedDue(ws.id, "only", now);

    const noFilter = await listDueVocab(ws.id, 10);
    const emptyFilter = await listDueVocab(ws.id, 10, new Set());

    expect(noFilter.map((v) => v.id)).toContain(id);
    expect(emptyFilter.map((v) => v.id)).toContain(id);
  });
});

describe("listStudyVocab — restrictToIds", () => {
  it("returns target cards regardless of `new` vs `learning` mix", async () => {
    const ws = await createWorkspace({ targetLang: "de", nativeLang: "en" });

    for (let i = 0; i < 30; i++) {
      await saveVocab({
        workspaceId: ws.id,
        word: `noise-${i}`,
        gloss: "x",
      });
    }

    const learn = await seedDue(ws.id, "target-learning", now);
    const fresh = await saveVocab({
      workspaceId: ws.id,
      word: "target-new",
      gloss: "x",
    });

    const restrict = new Set([learn, fresh.id]);
    const pool = await listStudyVocab(ws.id, 5, restrict);
    expect(pool.map((v) => v.id).sort()).toEqual([learn, fresh.id].sort());
  });
});

afterEach(() => {
  // The in-memory `fb` store leaks across tests; we don't reset it
  // because every `createWorkspace` mints a fresh id and the helpers
  // above only ever query by that id. Listed for visibility, no-op.
});
