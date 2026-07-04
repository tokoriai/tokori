import { describe, expect, it } from "vitest";
import { sentenceAround, splitSentences } from "@/lib/sentence-segment";

describe("sentence-segment — sentenceAround", () => {
  it("returns empty for empty input", () => {
    expect(sentenceAround("", 0)).toEqual({ sentence: "", start: 0, end: 0 });
  });

  it("returns the only sentence for single-sentence text", () => {
    const r = sentenceAround("Hello world.", 4);
    expect(r.sentence).toBe("Hello world.");
    expect(r.start).toBe(0);
    expect(r.end).toBe(12);
  });

  it("picks the middle sentence when the index sits inside it", () => {
    const text = "First. Second sentence here. Third.";
    const idx = text.indexOf("Second");
    const r = sentenceAround(text, idx + 2);
    expect(r.sentence).toBe("Second sentence here.");
  });

  it("trims leading whitespace and adjusts start", () => {
    const text = "First. Second.";
    const r = sentenceAround(text, 8);
    expect(r.sentence).toBe("Second.");
    expect(text.slice(r.start, r.end)).toBe("Second.");
  });

  it("works with CJK sentence enders", () => {
    const text = "你好。今天天气很好！再见。";
    const idx = text.indexOf("今天");
    const r = sentenceAround(text, idx + 1);
    expect(r.sentence).toBe("今天天气很好！");
  });

  it("treats hard line breaks as sentence enders", () => {
    const text = "Line one\nLine two\nLine three";
    const idx = text.indexOf("two");
    const r = sentenceAround(text, idx + 1);
    expect(r.sentence).toBe("Line two");
  });

  it("clamps an out-of-range index to the text bounds", () => {
    const text = "Only sentence.";
    expect(sentenceAround(text, -5).sentence).toBe("Only sentence.");
    expect(sentenceAround(text, 999).sentence).toBe("Only sentence.");
  });

  it("handles ellipsis as a sentence ender", () => {
    const text = "I was thinking… maybe we should go.";
    const r = sentenceAround(text, 5);
    expect(r.sentence).toBe("I was thinking…");
  });

  it("returns indices that re-index back into the source text", () => {
    const text = "First. Middle one. Last.";
    const r = sentenceAround(text, 10);
    expect(text.slice(r.start, r.end)).toBe(r.sentence);
  });
});

describe("sentence-segment — splitSentences", () => {
  it("splits multi-sentence text in order with re-indexable ranges", () => {
    const text = "First. Second sentence here. Third.";
    const out = splitSentences(text);
    expect(out.map((s) => s.sentence)).toEqual([
      "First.",
      "Second sentence here.",
      "Third.",
    ]);
    for (const s of out) {
      expect(text.slice(s.start, s.end)).toBe(s.sentence);
    }
  });

  it("handles CJK enders and newlines", () => {
    const out = splitSentences("你好。今天怎么样？\n我很好");
    expect(out.map((s) => s.sentence)).toEqual([
      "你好。",
      "今天怎么样？",
      "我很好",
    ]);
  });

  it("skips punctuation-only runs (stray '!!' tails)", () => {
    const out = splitSentences("Wow!! Nice.");
    expect(out.map((s) => s.sentence)).toEqual(["Wow!", "Nice."]);
  });

  it("returns empty for empty / whitespace input", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   \n  ")).toEqual([]);
  });
});
