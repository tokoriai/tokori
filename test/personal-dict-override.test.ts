import { beforeEach, describe, expect, it } from "vitest";
import {
  deletePersonalDictOverride,
  getOrCreatePersonalDict,
  hasPersonalDictOverride,
  installDictionary,
  listDictEntries,
  lookupDict,
  lookupDictBatch,
  resetFallbackStore,
  upsertPersonalDictEntry,
} from "@/lib/db";

/**
 * The click-to-define popover lets a learner edit a CC-CEDICT / JMdict
 * entry. The edit is stored as an override in the per-language Personal
 * dictionary rather than mutating the shipped pack — so it survives a
 * pack re-install and works the same in cloud. For that to actually
 * change what the popover shows, the Personal dict must WIN the lookup
 * over the packaged pack for the same word. These tests pin that
 * precedence (the load-bearing behaviour), plus the upsert + revert
 * round-trip, against the in-memory fallback store.
 */
describe("personal-dict overrides shadow packaged dictionaries", () => {
  beforeEach(() => {
    resetFallbackStore();
  });

  it("an edited entry wins over the packaged pack in lookupDict + lookupDictBatch", async () => {
    const lang = "zh";
    await installDictionary({
      lang,
      name: "CC-CEDICT",
      entries: [{ word: "好", altWord: null, reading: "hǎo", gloss: "good" }],
    });

    // Baseline: the packaged gloss is what resolves.
    expect((await lookupDict(lang, "好"))?.gloss).toBe("good");
    expect((await lookupDictBatch(lang, ["好"])).get("好")?.gloss).toBe("good");

    await upsertPersonalDictEntry({
      lang,
      word: "好",
      reading: "hǎo",
      gloss: "good; well; my own note",
    });

    // The override now shadows the pack on both lookup paths.
    expect((await lookupDict(lang, "好"))?.gloss).toBe("good; well; my own note");
    expect((await lookupDictBatch(lang, ["好"])).get("好")?.gloss).toBe(
      "good; well; my own note",
    );
  });

  it("the override wins even through the case-insensitive lookup path", async () => {
    const lang = "de";
    await installDictionary({
      lang,
      name: "Ding",
      entries: [{ word: "gehen", altWord: null, reading: null, gloss: "to go" }],
    });
    await upsertPersonalDictEntry({ lang, word: "gehen", gloss: "to walk / to go (edited)" });

    // Sentence-initial capitalisation falls through to the
    // case-insensitive stage — the personal row must still win there.
    expect((await lookupDict(lang, "Gehen"))?.gloss).toBe("to walk / to go (edited)");
    expect((await lookupDictBatch(lang, ["Gehen"])).get("Gehen")?.gloss).toBe(
      "to walk / to go (edited)",
    );
  });

  it("editing the same word twice updates one row instead of duplicating", async () => {
    const lang = "zh";
    await installDictionary({
      lang,
      name: "CC-CEDICT",
      entries: [{ word: "猫", altWord: null, reading: "māo", gloss: "cat" }],
    });

    await upsertPersonalDictEntry({ lang, word: "猫", gloss: "kitty" });
    await upsertPersonalDictEntry({ lang, word: "猫", gloss: "feline" });

    const personal = await getOrCreatePersonalDict(lang);
    const rows = await listDictEntries(personal.id, "猫", 50, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].gloss).toBe("feline");
    expect((await lookupDict(lang, "猫"))?.gloss).toBe("feline");
  });

  it("tracks whether an override exists and reverts back to the packaged entry", async () => {
    const lang = "zh";
    await installDictionary({
      lang,
      name: "CC-CEDICT",
      entries: [{ word: "书", altWord: null, reading: "shū", gloss: "book" }],
    });

    expect(await hasPersonalDictOverride(lang, "书")).toBe(false);

    await upsertPersonalDictEntry({ lang, word: "书", gloss: "tome (edited)" });
    expect(await hasPersonalDictOverride(lang, "书")).toBe(true);
    expect((await lookupDict(lang, "书"))?.gloss).toBe("tome (edited)");

    await deletePersonalDictOverride(lang, "书");
    expect(await hasPersonalDictOverride(lang, "书")).toBe(false);
    // The packaged entry is visible again.
    expect((await lookupDict(lang, "书"))?.gloss).toBe("book");
  });

  it("lets a learner author a definition for a word missing from every pack", async () => {
    const lang = "zh";
    await installDictionary({
      lang,
      name: "CC-CEDICT",
      entries: [{ word: "好", altWord: null, reading: "hǎo", gloss: "good" }],
    });

    expect(await lookupDict(lang, "测试")).toBeNull();

    await upsertPersonalDictEntry({ lang, word: "测试", reading: "cèshì", gloss: "a test" });

    const hit = await lookupDict(lang, "测试");
    expect(hit?.gloss).toBe("a test");
    expect(hit?.reading).toBe("cèshì");
  });
});
