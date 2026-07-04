import { describe, expect, it } from "vitest";
import { languagesWithRealDictionary } from "@/lib/dict-availability";
import type { Dictionary } from "@/lib/db";

function mkDict(overrides: Partial<Dictionary>): Dictionary {
  return {
    id: 1,
    lang: "zh",
    name: "CC-CEDICT",
    sourceUrl: null,
    installedAt: 0,
    entryCount: 1,
    ...overrides,
  };
}

describe("languagesWithRealDictionary", () => {
  it("returns an empty set for an empty list", () => {
    expect(languagesWithRealDictionary([])).toEqual(new Set());
  });

  it("includes languages that have at least one dict with entries", () => {
    const out = languagesWithRealDictionary([
      mkDict({ id: 1, lang: "zh", entryCount: 120000 }),
      mkDict({ id: 2, lang: "ja", entryCount: 190000 }),
    ]);
    expect(out).toEqual(new Set(["zh", "ja"]));
  });

  it("excludes empty Personal-dict placeholders", () => {
    // The per-language Personal dict is created lazily and has
    // entryCount = 0 until the user adds a word. It must not count
    // as "set up" — that would suppress the install nudge.
    const out = languagesWithRealDictionary([
      mkDict({ id: 1, lang: "de", name: "Personal", entryCount: 0 }),
    ]);
    expect(out).toEqual(new Set());
  });

  it("counts a language as set up as long as *any* of its dicts has entries", () => {
    // Mixed state: Personal is empty but CC-CEDICT is fully loaded.
    const out = languagesWithRealDictionary([
      mkDict({ id: 1, lang: "zh", name: "Personal", entryCount: 0 }),
      mkDict({ id: 2, lang: "zh", name: "CC-CEDICT", entryCount: 120000 }),
    ]);
    expect(out).toEqual(new Set(["zh"]));
  });

  it("excludes a pack that was inserted but never finished downloading", () => {
    // The Settings UI inserts a row up front and fills entries as the
    // download streams in. A pre-finish entryCount of 0 must not flip
    // the language into "set up".
    const out = languagesWithRealDictionary([
      mkDict({ id: 1, lang: "ko", name: "Kengdic", entryCount: 0 }),
    ]);
    expect(out).toEqual(new Set());
  });
});
