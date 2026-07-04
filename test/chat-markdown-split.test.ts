import { describe, expect, it } from "vitest";
import { splitOnTranslations } from "@/components/chat-markdown";

/**
 * Regression test for the long-AI-response crash. The old regex used
 * nested alternation with a lazy quantifier:
 *   /\(\(([^()]+|\((?!\()[^()]*\)(?!\)))+?\)\)/g
 * Inputs with many parentheses (common in code blocks, math, or just
 * verbose tutor explanations) triggered catastrophic backtracking and
 * froze the chat tab on every streamed token. The rewrite scans
 * forward with two `indexOf` calls per match — strictly O(n).
 */
describe("chat-markdown — splitOnTranslations", () => {
  it("returns a single text part when there's no `((...))`", () => {
    expect(splitOnTranslations("just plain text")).toEqual([
      { kind: "text", value: "just plain text" },
    ]);
  });

  it("splits a simple ((translation)) run", () => {
    expect(splitOnTranslations("你好 ((hello)) 世界")).toEqual([
      { kind: "text", value: "你好 " },
      { kind: "translation", value: "hello" },
      { kind: "text", value: " 世界" },
    ]);
  });

  it("handles multiple translation runs", () => {
    expect(
      splitOnTranslations("a ((one)) b ((two)) c"),
    ).toEqual([
      { kind: "text", value: "a " },
      { kind: "translation", value: "one" },
      { kind: "text", value: " b " },
      { kind: "translation", value: "two" },
      { kind: "text", value: " c" },
    ]);
  });

  it("trims whitespace inside the translation", () => {
    expect(splitOnTranslations("(( spaced ))")).toEqual([
      { kind: "translation", value: "spaced" },
    ]);
  });

  it("leaves a half-open `((` as plain text (streaming mid-token)", () => {
    expect(splitOnTranslations("partial ((open")).toEqual([
      { kind: "text", value: "partial ((open" },
    ]);
  });

  it("is fast on input with many parentheses (catastrophic-backtracking regression)", () => {
    // The old regex went exponential on inputs like this — `(` and `)`
    // strewn through a long body. The new scan must run in
    // milliseconds, not seconds.
    const body =
      "Here's a definition: word (n.) — meaning. Then more (with extras (and inner) bits) and code(1) (2) (3). ".repeat(
        2_000,
      ); // ~ 220 KB
    const t0 = performance.now();
    const parts = splitOnTranslations(body);
    const elapsed = performance.now() - t0;
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ kind: "text", value: body });
    // Comfortable budget for 220 KB on the unit-test box. The old regex
    // didn't return in 30s on this input; the rewrite finishes in < 30 ms.
    expect(elapsed).toBeLessThan(250);
  });

  it("keeps O(n) work across many translation runs", () => {
    const body = ("normal text ((trans)) more text ").repeat(5_000); // ~ 165 KB, 5k matches
    const t0 = performance.now();
    const parts = splitOnTranslations(body);
    const elapsed = performance.now() - t0;
    // 5k translation parts + alternating text parts (one extra text at
    // either end may merge into adjacency; count loosely).
    expect(parts.filter((p) => p.kind === "translation")).toHaveLength(5_000);
    expect(elapsed).toBeLessThan(500);
  });
});
