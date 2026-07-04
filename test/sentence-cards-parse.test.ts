/**
 * Parser tests for the sentence-cards AI reply. Mirrors the
 * sentence-mining parse suite — both plugins share the same JSONL-first
 * format with the same four-stage fallback (strict array → JSONL →
 * regex objects → numbered list). The two parsers are duplicated rather
 * than shared so neither plugin depends on the other's internals; this
 * test guards the duplicate against drift.
 */

import { describe, expect, it } from "vitest";
import { __INTERNAL } from "@/lib/study/plugins/sentence-cards";

const { parseSentenceResponse, sentenceContainsWord } = __INTERNAL;

describe("parseSentenceResponse", () => {
  it("parses a strict JSON array", () => {
    const raw = `[
      {"index":1,"sentence":"我每天喝水","translation":"I drink water every day"},
      {"index":2,"sentence":"她在跑步","translation":"She is running"}
    ]`;
    const out = parseSentenceResponse(raw);
    expect(out).toHaveLength(2);
    expect(out[0].sentence).toBe("我每天喝水");
    expect(out[1].translation).toBe("She is running");
  });

  it("tolerates trailing commas in arrays", () => {
    const raw = `[
      {"index":1,"sentence":"foo bar","translation":"foo bar"},
    ]`;
    const out = parseSentenceResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0].sentence).toBe("foo bar");
  });

  it("strips code fences", () => {
    const raw =
      "```json\n" +
      `[{"index":1,"sentence":"hello","translation":"hi"}]\n` +
      "```";
    const out = parseSentenceResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0].sentence).toBe("hello");
  });

  it("strips smart quotes that small LLMs emit", () => {
    const raw = `[{“index”:1,“sentence”:“hola”,“translation”:“hi”}]`;
    const out = parseSentenceResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0].sentence).toBe("hola");
  });

  it("parses JSONL when the model skips the array brackets", () => {
    const raw = [
      `{"index":1,"sentence":"Ich gehe nach Hause","translation":"I go home"}`,
      `{"index":2,"sentence":"Sie liest ein Buch","translation":"She reads a book"}`,
    ].join("\n");
    const out = parseSentenceResponse(raw);
    expect(out).toHaveLength(2);
    expect(out[1].sentence).toBe("Sie liest ein Buch");
  });

  it("extracts JSON objects scattered between prose", () => {
    const raw =
      `Sure! Here are your sentences:\n` +
      `{"index":1,"sentence":"我吃饭","translation":"I eat"}\n` +
      `And one more:\n` +
      `{"index":2,"sentence":"她笑了","translation":"She laughed"}\n` +
      `Hope these help!`;
    const out = parseSentenceResponse(raw);
    expect(out).toHaveLength(2);
    expect(out[0].sentence).toBe("我吃饭");
    expect(out[1].sentence).toBe("她笑了");
  });

  it("parses numbered-list fallback with em-dash separator", () => {
    const raw =
      `1. Je mange une pomme — I am eating an apple\n` +
      `2. Tu cours vite — You run fast\n` +
      `3. Nous parlons français — We speak French`;
    const out = parseSentenceResponse(raw);
    expect(out).toHaveLength(3);
    expect(out[0].sentence).toBe("Je mange une pomme");
    expect(out[0].translation).toBe("I am eating an apple");
    expect(out[2].translation).toBe("We speak French");
  });

  it("parses numbered-list fallback with parenthesised translation", () => {
    const raw = `1. 私は寿司を食べます (I eat sushi)\n2. 彼は走ります (He runs)`;
    const out = parseSentenceResponse(raw);
    expect(out).toHaveLength(2);
    expect(out[0].sentence).toBe("私は寿司を食べます");
    expect(out[1].translation).toBe("He runs");
  });

  it("returns [] when the reply is empty or unparseable", () => {
    expect(parseSentenceResponse("")).toEqual([]);
    expect(parseSentenceResponse("no JSON here at all")).toEqual([]);
  });
});

describe("sentenceContainsWord", () => {
  it("matches exact substring", () => {
    expect(sentenceContainsWord("I love sushi", "sushi")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(sentenceContainsWord("WE GO HOME", "go")).toBe(true);
  });

  it("matches CJK exactly without stem fallback", () => {
    expect(sentenceContainsWord("我喜欢吃苹果", "苹果")).toBe(true);
    expect(sentenceContainsWord("我喜欢吃水果", "苹果")).toBe(false);
  });

  it("allows stem match for Latin words ≥ 5 chars when the model conjugates", () => {
    expect(sentenceContainsWord("Nosotros comemos pan", "comer")).toBe(true);
    expect(sentenceContainsWord("Ich schreibe einen Brief", "schreiben")).toBe(true);
  });
});
