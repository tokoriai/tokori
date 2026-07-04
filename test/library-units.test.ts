import { describe, expect, it } from "vitest";
import { isMinutesUnit, singularUnitLabel } from "@/lib/library-units";

describe("singularUnitLabel", () => {
  it("singularizes the built-in unit labels", () => {
    expect(singularUnitLabel("pages")).toBe("page");
    expect(singularUnitLabel("chapters")).toBe("chapter");
    expect(singularUnitLabel("episodes")).toBe("episode");
    expect(singularUnitLabel("minutes")).toBe("minute");
    expect(singularUnitLabel("units")).toBe("unit");
  });

  it("is case- and whitespace-insensitive on the lookup", () => {
    expect(singularUnitLabel("Pages")).toBe("page");
    expect(singularUnitLabel("  CHAPTERS ")).toBe("chapter");
  });

  it("passes unknown labels through untouched — no naive s-stripping", () => {
    expect(singularUnitLabel("kanji")).toBe("kanji");
    expect(singularUnitLabel("classes")).toBe("classes");
    expect(singularUnitLabel("回")).toBe("回");
  });
});

describe("isMinutesUnit", () => {
  it("matches the minute spellings", () => {
    expect(isMinutesUnit("minutes")).toBe(true);
    expect(isMinutesUnit("minute")).toBe(true);
    expect(isMinutesUnit("mins")).toBe(true);
    expect(isMinutesUnit("min")).toBe(true);
    expect(isMinutesUnit(" Minutes ")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isMinutesUnit("pages")).toBe(false);
    expect(isMinutesUnit("mining sessions")).toBe(false);
    expect(isMinutesUnit("")).toBe(false);
  });
});
