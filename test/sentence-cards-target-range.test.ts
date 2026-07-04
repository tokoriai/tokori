/**
 * `findWordRange` powers the target-word highlight inside each sentence
 * card. The returned range goes straight into `Tokenized`'s
 * `activeRange` prop, so the contract is: the half-open `[start, end)`
 * character range must point at *one* occurrence of the headword
 * inside the sentence — or `null` if no occurrence exists.
 */

import { describe, expect, it } from "vitest";
import { __INTERNAL } from "@/lib/study/plugins/sentence-cards";

const { findWordRange } = __INTERNAL;

describe("findWordRange", () => {
  it("returns the [start, end) range of an exact Latin match", () => {
    const r = findWordRange("I love sushi", "sushi");
    expect(r).toEqual([7, 12]);
    expect("I love sushi".slice(7, 12)).toBe("sushi");
  });

  it("matches case-insensitively when the surface form differs", () => {
    const r = findWordRange("We Are Going Home", "going");
    expect(r).toEqual([7, 12]);
    expect("We Are Going Home".slice(7, 12)).toBe("Going");
  });

  it("returns the first occurrence when the word appears multiple times", () => {
    const r = findWordRange("the cat sat on the cat", "cat");
    expect(r).toEqual([4, 7]);
  });

  it("works for CJK substring matches", () => {
    const sentence = "我喜欢吃苹果";
    const r = findWordRange(sentence, "苹果");
    expect(r).not.toBeNull();
    expect(sentence.slice(r![0], r![1])).toBe("苹果");
  });

  it("returns null when the word isn't in the sentence", () => {
    expect(findWordRange("I love sushi", "ramen")).toBeNull();
    expect(findWordRange("我喜欢吃苹果", "香蕉")).toBeNull();
  });

  it("returns null for empty inputs", () => {
    expect(findWordRange("", "anything")).toBeNull();
    expect(findWordRange("anything", "")).toBeNull();
  });

  it("normalises NFC so composed and decomposed forms still match", () => {
    // "café" — combining-acute composition. Both forms should resolve to
    // the same NFC sequence before searching.
    const composed = "I love café";
    const decomposed = "café";
    const r = findWordRange(composed, decomposed);
    expect(r).not.toBeNull();
  });
});
