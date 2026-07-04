import { describe, expect, it } from "vitest";
import { parsePinyin, prettyPinyin, splitPinyinSyllables } from "@/lib/pinyin";

describe("pinyin — parsePinyin", () => {
  it("returns an empty list for nullish / empty input", () => {
    expect(parsePinyin(null)).toEqual([]);
    expect(parsePinyin(undefined)).toEqual([]);
    expect(parsePinyin("")).toEqual([]);
    expect(parsePinyin("   ")).toEqual([]);
  });

  it("converts numeric pinyin to tone-marked", () => {
    const r = parsePinyin("ni3 hao3");
    expect(r).toEqual([
      { pretty: "nǐ", tone: 3 },
      { pretty: "hǎo", tone: 3 },
    ]);
  });

  it("handles each of the four primary tones", () => {
    expect(parsePinyin("ma1 ma2 ma3 ma4")).toEqual([
      { pretty: "mā", tone: 1 },
      { pretty: "má", tone: 2 },
      { pretty: "mǎ", tone: 3 },
      { pretty: "mà", tone: 4 },
    ]);
  });

  it("keeps neutral-tone (5) syllables unmarked", () => {
    const r = parsePinyin("ma5");
    expect(r).toEqual([{ pretty: "ma", tone: 5 }]);
  });

  it("normalises u: and v to ü", () => {
    expect(parsePinyin("nu:3")).toEqual([{ pretty: "nǚ", tone: 3 }]);
    expect(parsePinyin("nv3")).toEqual([{ pretty: "nǚ", tone: 3 }]);
  });

  it("places the tone mark on the dominant vowel", () => {
    // a > e > o > last of i/u/ü
    expect(parsePinyin("xiao3")).toEqual([{ pretty: "xiǎo", tone: 3 }]);
    expect(parsePinyin("hui4")).toEqual([{ pretty: "huì", tone: 4 }]);
    expect(parsePinyin("liu2")).toEqual([{ pretty: "liú", tone: 2 }]);
    expect(parsePinyin("dui4")).toEqual([{ pretty: "duì", tone: 4 }]);
  });

  it("preserves uppercase when the marked vowel was uppercase", () => {
    const r = parsePinyin("Bei3 Jing1");
    expect(r).toEqual([
      { pretty: "Běi", tone: 3 },
      { pretty: "Jīng", tone: 1 },
    ]);
  });

  it("detects tones from already tone-marked input", () => {
    expect(parsePinyin("nǐ hǎo")).toEqual([
      { pretty: "nǐ", tone: 3 },
      { pretty: "hǎo", tone: 3 },
    ]);
    // Spaceless tone-marked runs syllabify so the ruby rail aligns one
    // syllable per hanzi (māma = 妈妈).
    expect(parsePinyin("māma")).toEqual([
      { pretty: "mā", tone: 1 },
      { pretty: "ma", tone: 5 },
    ]);
  });

  it("falls back to neutral when no tone mark is found on tone-marked path", () => {
    expect(parsePinyin("de")).toEqual([{ pretty: "de", tone: 5 }]);
  });

  it("handles mixed numeric + tone-marked syllables", () => {
    const r = parsePinyin("nǐ hao3");
    expect(r).toEqual([
      { pretty: "nǐ", tone: 3 },
      { pretty: "hǎo", tone: 3 },
    ]);
  });
});

describe("pinyin — prettyPinyin", () => {
  it("returns a tone-marked string joined by spaces", () => {
    expect(prettyPinyin("ni3 hao3")).toBe("nǐ hǎo");
  });

  it("returns an empty string for nullish input", () => {
    expect(prettyPinyin(null)).toBe("");
    expect(prettyPinyin(undefined)).toBe("");
  });

  it("re-spaces a spaceless reading and stays idempotent", () => {
    expect(prettyPinyin("nǐhǎo")).toBe("nǐ hǎo");
    expect(prettyPinyin("nǐ hǎo")).toBe("nǐ hǎo");
    expect(prettyPinyin("ce4shi4")).toBe("cè shì");
  });
});

describe("pinyin — splitPinyinSyllables", () => {
  it("leaves space-separated readings one syllable per chunk", () => {
    expect(splitPinyinSyllables("ni3 hao3")).toEqual(["ni3", "hao3"]);
    expect(splitPinyinSyllables("nǐ hǎo")).toEqual(["nǐ", "hǎo"]);
  });

  it("syllabifies spaceless readings a learner types by hand", () => {
    // Tone-marked, tone-numbered, and toneless all split the same way —
    // this is the bug behind missing ruby for custom dictionary entries.
    expect(splitPinyinSyllables("nǐhǎo")).toEqual(["nǐ", "hǎo"]);
    expect(splitPinyinSyllables("ni3hao3")).toEqual(["ni3", "hao3"]);
    expect(splitPinyinSyllables("cèshì")).toEqual(["cè", "shì"]);
    expect(splitPinyinSyllables("Běijīng")).toEqual(["Běi", "jīng"]);
  });

  it("keeps a genuine single syllable whole (greedy longest-match)", () => {
    // "xian" is one syllable (先), not "xi"+"an"; an explicit apostrophe
    // is what forces the 西安 reading apart.
    expect(splitPinyinSyllables("xian")).toEqual(["xian"]);
    expect(splitPinyinSyllables("xi'an")).toEqual(["xi", "an"]);
    expect(splitPinyinSyllables("zhuang")).toEqual(["zhuang"]);
  });

  it("backtracks past a dead-end first guess", () => {
    // Greedy would take "fang" first, leaving an un-parseable "uan";
    // the segmenter recovers "fan"+"guan".
    expect(splitPinyinSyllables("fanguan")).toEqual(["fan", "guan"]);
  });

  it("leaves non-pinyin runs untouched", () => {
    // Kana / lemmas don't decompose into pinyin syllables, so they pass
    // through as a single chunk rather than getting mangled.
    expect(splitPinyinSyllables("こんにちは")).toEqual(["こんにちは"]);
    expect(splitPinyinSyllables("Tschüss")).toEqual(["Tschüss"]);
  });

  it("aligns one syllable per hanzi for multi-character words", () => {
    // The invariant the ruby rail relies on.
    const cases: [string, string][] = [
      ["你好", "nǐhǎo"],
      ["测试", "cèshì"],
      ["北京", "běijīng"],
      ["谢谢", "xièxie"],
    ];
    for (const [word, reading] of cases) {
      expect(parsePinyin(reading)).toHaveLength([...word].length);
    }
  });
});
