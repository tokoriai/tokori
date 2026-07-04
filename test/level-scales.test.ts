import { describe, expect, it } from "vitest";
import {
  computeLevel,
  levelsFor,
  levelsForScale,
  scaleFor,
  scaleLabel,
} from "@/lib/level";

describe("scaleFor", () => {
  it("auto-picks the right scale per language", () => {
    expect(scaleFor("zh")).toBe("hsk");
    expect(scaleFor("ja")).toBe("jlpt");
    expect(scaleFor("ko")).toBe("topik");
    expect(scaleFor("de")).toBe("cefr");
    expect(scaleFor("es")).toBe("cefr");
    expect(scaleFor("en")).toBe("cefr");
  });
});

describe("levelsFor / levelsForScale", () => {
  it("JLPT covers N5 → N1 with ascending thresholds", () => {
    const lv = levelsFor("ja");
    expect(lv.map((l) => l.id)).toEqual(["N5", "N4", "N3", "N2", "N1"]);
    for (let i = 1; i < lv.length; i++) {
      expect(lv[i].minVocab).toBeGreaterThan(lv[i - 1].minVocab);
    }
  });

  it("TOPIK covers 1 → 6 with ascending thresholds", () => {
    const lv = levelsFor("ko");
    expect(lv.map((l) => l.id)).toEqual([
      "TOPIK 1",
      "TOPIK 2",
      "TOPIK 3",
      "TOPIK 4",
      "TOPIK 5",
      "TOPIK 6",
    ]);
    for (let i = 1; i < lv.length; i++) {
      expect(lv[i].minVocab).toBeGreaterThan(lv[i - 1].minVocab);
    }
  });

  it("levelsForScale fetches by scale id directly", () => {
    expect(levelsForScale("jlpt")[0].id).toBe("N5");
    expect(levelsForScale("topik")[0].id).toBe("TOPIK 1");
    expect(levelsForScale("hsk")[0].id).toBe("HSK 1");
    expect(levelsForScale("cefr")[0].id).toBe("A1");
  });
});

describe("scaleLabel", () => {
  it("returns the short label for every scale", () => {
    expect(scaleLabel("hsk")).toBe("HSK");
    expect(scaleLabel("jlpt")).toBe("JLPT");
    expect(scaleLabel("topik")).toBe("TOPIK");
    expect(scaleLabel("cefr")).toBe("CEFR");
    expect(scaleLabel("custom")).toBe("Custom");
  });
});

describe("computeLevel with JLPT / TOPIK", () => {
  it("a Japanese learner with 1000 known words sits at N4", () => {
    const out = computeLevel("ja", 1000, 0);
    expect(out.scale).toBe("jlpt");
    expect(out.current.id).toBe("N4");
    expect(out.next.id).toBe("N3");
  });

  it("a Korean learner with 5000 known words sits at TOPIK 3", () => {
    const out = computeLevel("ko", 5000, 0);
    expect(out.scale).toBe("topik");
    expect(out.current.id).toBe("TOPIK 3");
  });

  it("respects an explicit scale override (Japanese → CEFR)", () => {
    const out = computeLevel("ja", 1000, 0, null, { scale: "cefr" });
    expect(out.scale).toBe("cefr");
    expect(out.current.id).toBe("A2");
  });
});
