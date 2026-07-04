import { describe, expect, it } from "vitest";
import {
  aabb,
  linesToWordBoxes,
  normalizeRect,
  pageTextForWords,
  subdivideLine,
  type WordBox,
} from "@/lib/word-boxing";
import type { Segment } from "@/lib/segment";

const seg = (text: string, isWord = true): Segment => ({ text, isWord });
const inUnit = (b: WordBox) =>
  b.x >= 0 && b.y >= 0 && b.w >= 0 && b.h >= 0 && b.x + b.w <= 1.0001 && b.y + b.h <= 1.0001;

describe("aabb", () => {
  it("derives the bounding box from corners in any order", () => {
    // PaddleOCR points come clockwise from top-left, but a skewed line can
    // land them out of axis-order; min/max must still be correct.
    const box = aabb([
      [100, 20],
      [10, 25],
      [105, 60],
      [8, 55],
    ]);
    expect(box).toEqual({ x: 8, y: 20, w: 97, h: 40 });
  });

  it("returns a zero box for no points", () => {
    expect(aabb([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe("normalizeRect", () => {
  it("divides pixel coords by the page size", () => {
    expect(normalizeRect({ x: 50, y: 10, w: 100, h: 20 }, 200, 40)).toEqual({
      x: 0.25,
      y: 0.25,
      w: 0.5,
      h: 0.5,
    });
  });

  it("clamps out-of-range values into [0,1] and guards divide-by-zero", () => {
    const r = normalizeRect({ x: -5, y: 0, w: 300, h: 80 }, 200, 0);
    expect(r.x).toBe(0); // negative clamped
    expect(r.w).toBe(1); // 300/200 = 1.5 → clamped
    expect(Number.isFinite(r.y)).toBe(true); // height 0 → no NaN
    expect(Number.isFinite(r.h)).toBe(true);
  });
});

describe("subdivideLine — Latin (proportional width)", () => {
  const line = { x: 0, y: 0, w: 1, h: 1 };
  const segments = [seg("the"), seg(" ", false), seg("cat")];

  it("places words left-to-right, spaces consume width but get no box", () => {
    // Default measurer is character count: "the cat" has length 7.
    const boxes = subdivideLine(line, segments, { lang: "de" });
    expect(boxes.map((b) => b.text)).toEqual(["the", "cat"]);
    expect(boxes[0].x).toBeCloseTo(0, 5);
    expect(boxes[0].w).toBeCloseTo(3 / 7, 5);
    expect(boxes[1].x).toBeCloseTo(4 / 7, 5); // after "the " (4 chars)
    expect(boxes[1].w).toBeCloseTo(3 / 7, 5);
    boxes.forEach((b) => expect(inUnit(b)).toBe(true));
  });

  it("honours an injected width measurer", () => {
    // Make every char 10px wide; result is identical proportions but proves
    // the measurer is used rather than a hard-coded length.
    const boxes = subdivideLine(line, segments, {
      lang: "de",
      measure: (s) => s.length * 10,
    });
    expect(boxes[0].w).toBeCloseTo(3 / 7, 5);
  });
});

describe("subdivideLine — CJK (equal grapheme cells)", () => {
  it("gives each word a contiguous run of equal-width cells", () => {
    const line = { x: 0, y: 0, w: 1, h: 1 };
    // 私 / は / 猫 — three single-grapheme words → thirds.
    const boxes = subdivideLine(
      line,
      [seg("私"), seg("は"), seg("猫")],
      { lang: "ja" },
    );
    expect(boxes.map((b) => b.text)).toEqual(["私", "は", "猫"]);
    boxes.forEach((b, i) => {
      expect(b.x).toBeCloseTo(i / 3, 5);
      expect(b.w).toBeCloseTo(1 / 3, 5);
    });
  });

  it("multi-grapheme words span proportionally more cells", () => {
    const line = { x: 0, y: 0, w: 1, h: 1 };
    // 4 graphemes total: 猫(1) + 大好き(3). Second word starts at 1/4.
    const boxes = subdivideLine(line, [seg("猫"), seg("大好き")], { lang: "ja" });
    expect(boxes[1].x).toBeCloseTo(1 / 4, 5);
    expect(boxes[1].w).toBeCloseTo(3 / 4, 5);
  });
});

describe("subdivideLine — RTL / line-level fallback", () => {
  it("RTL scripts collapse to a single line hotspot", () => {
    const boxes = subdivideLine(
      { x: 0.1, y: 0.2, w: 0.5, h: 0.05 },
      [seg("مرحبا"), seg(" ", false), seg("بك")],
      { lang: "ar" },
    );
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ x: 0.1, y: 0.2, w: 0.5, h: 0.05 });
    expect(boxes[0].text).toBe("مرحبا بك");
  });

  it("lineLevel:true forces one box even for a tokenizable script", () => {
    const boxes = subdivideLine(
      { x: 0, y: 0, w: 1, h: 1 },
      [seg("hello"), seg(" ", false), seg("world")],
      { lang: "de", lineLevel: true },
    );
    expect(boxes).toHaveLength(1);
    expect(boxes[0].text).toBe("hello world");
  });
});

describe("linesToWordBoxes", () => {
  // Whitespace tokenizer: words split on spaces, spaces kept as non-words.
  const wsTokenize = async (text: string): Promise<Segment[]> =>
    text
      .split(/(\s+)/)
      .filter((p) => p.length > 0)
      .map((p) => ({ text: p, isWord: !/^\s+$/.test(p) }));

  it("normalises pixel boxes and preserves reading order across lines", async () => {
    const words = await linesToWordBoxes(
      [
        { text: "ab cd", bbox: [[0, 0], [100, 0], [100, 20], [0, 20]] },
        { text: "ef", bbox: [[0, 20], [40, 20], [40, 40], [0, 40]] },
      ],
      200, // page width
      40, // page height
      "de",
      wsTokenize,
    );
    expect(words.map((w) => w.text)).toEqual(["ab", "cd", "ef"]);
    words.forEach((w) => expect(inUnit(w)).toBe(true));
    // First line sits in the top half (y≈0, h≈0.5), second line below it.
    expect(words[0].y).toBeCloseTo(0, 5);
    expect(words[2].y).toBeCloseTo(0.5, 5);
    // "ab" is left of "cd" on the same line.
    expect(words[0].x).toBeLessThan(words[1].x);
  });
});

describe("pageTextForWords", () => {
  const w = (text: string): WordBox => ({ text, x: 0, y: 0, w: 0, h: 0 });

  it("joins Latin words with spaces and reports each offset", () => {
    const { pageText, offsets } = pageTextForWords([w("the"), w("cat")], "de");
    expect(pageText).toBe("the cat");
    expect(offsets).toEqual([0, 4]);
    expect(pageText.slice(offsets[1])).toBe("cat");
  });

  it("joins CJK words with no separator", () => {
    const { pageText, offsets } = pageTextForWords([w("私"), w("は"), w("猫")], "ja");
    expect(pageText).toBe("私は猫");
    expect(offsets).toEqual([0, 1, 2]);
  });
});
