import { describe, expect, it } from "vitest";
import {
  DICTIONARY_PACKS,
  formatForUrl,
  packById,
  packsForLanguage,
} from "@/lib/dictionaries/registry";
import { ALL_LANGUAGES } from "@/lib/language-profiles";

describe("DICTIONARY_PACKS", () => {
  it("has unique stable ids", () => {
    const ids = DICTIONARY_PACKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every pack lists its defaultUrl in its presets (if presets exist)", () => {
    for (const p of DICTIONARY_PACKS) {
      if (!p.presets) continue;
      const urls = p.presets.map((s) => s.url);
      expect(urls).toContain(p.defaultUrl);
    }
  });

  it("every language profile's recommendedDict points at a real pack", () => {
    for (const lang of ALL_LANGUAGES) {
      if (!lang.recommendedDict) continue;
      const pack = packById(lang.recommendedDict);
      expect(pack, `${lang.code} -> ${lang.recommendedDict}`).not.toBeNull();
      expect(pack?.lang).toBe(lang.code);
    }
  });
});

describe("packsForLanguage", () => {
  it("returns the packs for a given language", () => {
    expect(packsForLanguage("zh").map((p) => p.id)).toContain("cc-cedict");
    expect(packsForLanguage("ko").map((p) => p.id)).toContain("ko-krdict-yomitan");
    expect(packsForLanguage("es").map((p) => p.id)).toContain("es-wiktionary");
    expect(packsForLanguage("es").map((p) => p.id)).toContain("es-yomitan-wiktionary");
    expect(packsForLanguage("de").map((p) => p.id)).toContain("de-yomitan-wiktionary");
  });

  it("does not ship any Kaikki JSONL packs", () => {
    // The zh/ja/ko/de/es Kaikki packs used to live here; we removed
    // them in favour of curated defaults + Yomitan-Wiktionary. Catch
    // an accidental re-add by name shape.
    for (const p of DICTIONARY_PACKS) {
      expect(p.id, p.id).not.toMatch(/-kaikki$/);
    }
  });

  it("Korean default pack is the KRDICT Yomitan zip", () => {
    const pack = packById("ko-krdict-yomitan");
    expect(pack).not.toBeNull();
    expect(pack?.format).toBe("yomitan");
    expect(pack?.defaultUrl).toMatch(/KRDICT\.zip$/);
  });

  it("Yomitan packs declare the yomitan format and a .zip URL", () => {
    for (const id of ["de-yomitan-wiktionary", "es-yomitan-wiktionary"]) {
      const pack = packById(id);
      expect(pack, id).not.toBeNull();
      expect(pack?.format).toBe("yomitan");
      expect(pack?.defaultUrl.endsWith(".zip"), pack?.defaultUrl).toBe(true);
    }
  });

  it("returns [] for languages with no packaged dictionary", () => {
    expect(packsForLanguage("en")).toEqual([]);
  });
});

describe("formatForUrl", () => {
  it("routes JMdict JSON URLs to the json parser", () => {
    const jmdict = packById("jmdict-eng")!;
    expect(
      formatForUrl(
        jmdict,
        "https://github.com/scriptin/jmdict-simplified/releases/latest/download/jmdict-eng.json.tgz",
      ),
    ).toBe("jmdict");
  });

  it("routes JMdict XML URLs to the xml parser", () => {
    const jmdict = packById("jmdict-eng")!;
    expect(formatForUrl(jmdict, "http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz"))
      .toBe("jmdict-xml");
  });

  it("returns the pack's declared format for non-JMdict packs", () => {
    const ding = packById("ding-de-en")!;
    expect(formatForUrl(ding, ding.defaultUrl)).toBe("ding");
  });
});
