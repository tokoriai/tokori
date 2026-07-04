import { describe, expect, it } from "vitest";
import { computeLevel, levelsFor, scaleFor, scaleLabel } from "@/lib/level";

describe("level — scaleFor", () => {
  it("picks the canonical certification scale per language", () => {
    expect(scaleFor("zh")).toBe("hsk");
    expect(scaleFor("ja")).toBe("jlpt");
    expect(scaleFor("ko")).toBe("topik");
    expect(scaleFor("de")).toBe("cefr");
    expect(scaleFor("es")).toBe("cefr");
  });
});

describe("level — scaleLabel", () => {
  it("renders human labels for each scale", () => {
    expect(scaleLabel("hsk")).toBe("HSK");
    expect(scaleLabel("cefr")).toBe("CEFR");
    expect(scaleLabel("custom")).toBe("Custom");
  });
});

describe("level — levelsFor", () => {
  it("returns ascending vocab thresholds", () => {
    const cefr = levelsFor("de");
    for (let i = 1; i < cefr.length; i++) {
      expect(cefr[i].minVocab).toBeGreaterThan(cefr[i - 1].minVocab);
    }
    const hsk = levelsFor("zh");
    for (let i = 1; i < hsk.length; i++) {
      expect(hsk[i].minVocab).toBeGreaterThan(hsk[i - 1].minVocab);
    }
  });
});

describe("level — computeLevel", () => {
  it("starts at the lowest level for a fresh learner", () => {
    const r = computeLevel("zh", 0, 0);
    expect(r.scale).toBe("hsk");
    expect(r.current.id).toBe("HSK 1");
    expect(r.score).toBe(0);
    expect(r.progress).toBe(0);
    expect(r.manualOverride).toBe(false);
  });

  it("counts immersion hours at 1.5x toward score, capped at 1500h", () => {
    const r = computeLevel("de", 100, 200);
    expect(r.score).toBe(100 + 200 * 1.5);
  });

  it("caps immersion contribution at 1500 hours", () => {
    const r = computeLevel("de", 0, 5000);
    expect(r.score).toBe(1500 * 1.5);
  });

  it("places the learner at the right CEFR rung based on score", () => {
    expect(computeLevel("de", 1500, 0).current.id).toBe("B1");
    expect(computeLevel("de", 3000, 0).current.id).toBe("B2");
    expect(computeLevel("de", 6000, 0).current.id).toBe("C1");
    expect(computeLevel("de", 10_000, 0).current.id).toBe("C2");
  });

  it("places the learner at the right HSK rung based on score", () => {
    expect(computeLevel("zh", 0, 0).current.id).toBe("HSK 1");
    expect(computeLevel("zh", 1272, 0).current.id).toBe("HSK 3");
    expect(computeLevel("zh", 4316, 0).current.id).toBe("HSK 6");
  });

  it("computes progress 0..1 toward the next level", () => {
    const r = computeLevel("de", 750, 0);
    expect(r.current.id).toBe("A2");
    expect(r.next.id).toBe("B1");
    // A2 starts at 500, B1 at 1500 → progress = (750-500)/1000 = 0.25
    expect(r.progress).toBeCloseTo(0.25, 5);
    expect(r.toNext).toBe(750);
  });

  it("clamps progress at 1 once the user reaches the top of the scale", () => {
    const r = computeLevel("de", 50_000, 0);
    expect(r.current.id).toBe("C2");
    expect(r.next.id).toBe("C2");
    expect(r.progress).toBe(1);
  });

  it("honors a manual score override", () => {
    const r = computeLevel("de", 100, 100, undefined, { manualScore: 5000 });
    expect(r.score).toBe(5000);
    expect(r.current.id).toBe("B2");
    expect(r.manualOverride).toBe(true);
  });

  it("honors a manual current-level override", () => {
    const r = computeLevel("de", 100, 0, undefined, { manualLevelId: "C1" });
    expect(r.current.id).toBe("C1");
    expect(r.next.id).toBe("C2");
    expect(r.manualOverride).toBe(true);
  });

  it("honors a forced scale override", () => {
    const r = computeLevel("zh", 0, 0, undefined, { scale: "cefr" });
    expect(r.scale).toBe("cefr");
    expect(r.current.id).toBe("A1");
  });

  it("falls back to the auto scale when custom is requested without rungs", () => {
    const r = computeLevel("de", 0, 0, undefined, { scale: "custom" });
    expect(r.scale).toBe("cefr");
  });

  it("uses the supplied custom scale when one is provided", () => {
    const r = computeLevel("de", 25, 0, undefined, {
      scale: "custom",
      customLevels: [
        { id: "Rookie", label: "Rookie", minVocab: 0 },
        { id: "Pro", label: "Pro", minVocab: 50 },
      ],
    });
    expect(r.scale).toBe("custom");
    expect(r.current.id).toBe("Rookie");
    expect(r.next.id).toBe("Pro");
  });

  it("computes goal progress against the goal level's threshold", () => {
    const r = computeLevel("de", 750, 0, "B2");
    expect(r.goal.id).toBe("B2");
    // score 750, goal threshold 3000 → 0.25
    expect(r.goalProgress).toBeCloseTo(0.25, 5);
    expect(r.toGoal).toBe(2250);
  });

  it("ignores a non-finite manual score", () => {
    const r = computeLevel("de", 100, 0, undefined, { manualScore: NaN });
    expect(r.score).toBe(100);
    expect(r.manualOverride).toBe(false);
  });
});
