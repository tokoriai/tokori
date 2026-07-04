import { describe, expect, it } from "vitest";
import { pluginsForLanguage, pluginById } from "@/lib/study/registry";

/**
 * Vocab Recall is the single spaced-repetition flow for every workspace
 * (CJK and Latin scripts alike). The standalone "Spaced repetition"
 * (anki-classic) mode was retired in favour of it.
 */
describe("study plugin gating", () => {
  it("offers vocab-recall on every workspace language", () => {
    for (const lang of ["zh", "ja", "ko", "de", "es", "en", "fr"] as const) {
      const ids = pluginsForLanguage(lang).map((p) => p.meta.id);
      expect(ids, `${lang} should see vocab-recall`).toContain("vocab-recall");
    }
  });

  it("no longer surfaces the retired anki-classic mode anywhere", () => {
    for (const lang of ["zh", "ja", "ko", "de", "es", "en", "fr"] as const) {
      const ids = pluginsForLanguage(lang).map((p) => p.meta.id);
      expect(ids, `${lang} should not see anki-classic`).not.toContain(
        "anki-classic",
      );
    }
    expect(pluginById("anki-classic")).toBeNull();
  });

  it("hanzi-writing is gated to CJK", () => {
    expect(pluginsForLanguage("ja").map((p) => p.meta.id)).toContain("hanzi-writing");
    expect(pluginsForLanguage("zh").map((p) => p.meta.id)).toContain("hanzi-writing");
    // Korean uses hangul, not hanzi/kanji — hanzi-writing's
    // supportedLangs only lists zh and ja today.
    expect(pluginsForLanguage("ko").map((p) => p.meta.id)).not.toContain("hanzi-writing");
    expect(pluginsForLanguage("de").map((p) => p.meta.id)).not.toContain("hanzi-writing");
  });

  it("plugin ids stay stable — used as persistence keys", () => {
    expect(pluginById("vocab-recall")?.meta.id).toBe("vocab-recall");
    expect(pluginById("sentence-mining")?.meta.id).toBe("sentence-mining");
    expect(pluginById("hanzi-writing")?.meta.id).toBe("hanzi-writing");
  });
});
