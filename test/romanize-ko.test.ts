import { describe, expect, it } from "vitest";
import { romanizeHangul, romanizeSyllables } from "@/lib/romanize-ko";

describe("romanizeHangul", () => {
  it("romanizes plain syllables", () => {
    expect(romanizeHangul("안녕하세요")).toBe("annyeonghaseyo");
    expect(romanizeHangul("감사")).toBe("gamsa");
    expect(romanizeHangul("김치")).toBe("gimchi");
  });

  it("re-syllabifies a coda onto a silent ㅇ onset (liaison)", () => {
    expect(romanizeHangul("한국어")).toBe("hangugeo");
    expect(romanizeHangul("음악")).toBe("eumak");
    // ㅎ coda is silent before a vowel; ㅇ coda stays ng.
    expect(romanizeHangul("좋아")).toBe("joa");
    expect(romanizeHangul("영어")).toBe("yeongeo");
  });

  it("nasalises k/t/p codas before ㄴ and ㅁ", () => {
    expect(romanizeHangul("합니다")).toBe("hamnida");
    expect(romanizeHangul("국물")).toBe("gungmul");
    expect(romanizeHangul("끝나")).toBe("kkeunna");
  });

  it("lateralises ㄴ/ㄹ clusters to ll", () => {
    expect(romanizeHangul("한라")).toBe("halla");
    expect(romanizeHangul("달라")).toBe("dalla");
    expect(romanizeHangul("신라")).toBe("silla");
    expect(romanizeHangul("실내")).toBe("sillae");
  });

  it("handles double codas in final and liaison position", () => {
    expect(romanizeHangul("닭")).toBe("dak");
    expect(romanizeHangul("삶")).toBe("sam");
    expect(romanizeHangul("읽어")).toBe("ilgeo");
  });

  it("passes non-hangul through and doesn't carry rules across it", () => {
    expect(romanizeHangul("저는 BTS 팬이에요!")).toBe("jeoneun BTS paenieyo!");
    expect(romanizeHangul("123, abc")).toBe("123, abc");
    expect(romanizeHangul("")).toBe("");
    // Word boundary (space) blocks liaison: the ㄱ coda stays k.
    expect(romanizeHangul("국 안")).toBe("guk an");
  });
});

describe("romanizeSyllables", () => {
  it("romanizes each block in isolation (no cross-syllable changes)", () => {
    // Note: per-block 'han·guk·eo', deliberately NOT the connected
    // 'hangugeo' — the card shows the connected reading separately.
    expect(romanizeSyllables("한국어")).toEqual([
      { syllable: "한", roman: "han" },
      { syllable: "국", roman: "guk" },
      { syllable: "어", roman: "eo" },
    ]);
  });

  it("skips spaces, Latin, and punctuation", () => {
    expect(romanizeSyllables("국 안")).toEqual([
      { syllable: "국", roman: "guk" },
      { syllable: "안", roman: "an" },
    ]);
    expect(romanizeSyllables("BTS 팬!")).toEqual([
      { syllable: "팬", roman: "paen" },
    ]);
  });

  it("returns an empty list when there's no hangul", () => {
    expect(romanizeSyllables("")).toEqual([]);
    expect(romanizeSyllables("hello 123")).toEqual([]);
  });
});
