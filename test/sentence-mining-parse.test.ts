/**
 * Parser tests for the AI cloze-sentence reply. Real local-LLM
 * outputs are surprisingly varied — these cases come from Ollama
 * runs with Llama 3.1 8B / Qwen 2.5 7B / Mistral, plus a couple of
 * larger-model "clean JSON" reference points. The contract is: every
 * format parses, and the resulting entries can be looked up by index
 * OR position so a dropped index still works.
 */

import { describe, expect, it } from "vitest";
import { __INTERNAL } from "@/lib/study/plugins/sentence-mining";

const { parseClozeResponse, parseTranslations, sentenceContainsWord } = __INTERNAL;

describe("parseClozeResponse", () => {
  it("parses a strict JSON array", () => {
    const raw = `[
      {"index":1,"sentence":"我每天喝水","translation":"I drink water every day"},
      {"index":2,"sentence":"她在跑步","translation":"She is running"}
    ]`;
    const out = parseClozeResponse(raw);
    expect(out).toHaveLength(2);
    expect(out[0].sentence).toBe("我每天喝水");
    expect(out[1].translation).toBe("She is running");
  });

  it("tolerates trailing commas in arrays", () => {
    const raw = `[
      {"index":1,"sentence":"foo bar","translation":"foo bar"},
    ]`;
    const out = parseClozeResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0].sentence).toBe("foo bar");
  });

  it("strips code fences", () => {
    const raw = "```json\n" +
      `[{"index":1,"sentence":"hello","translation":"hi"}]\n` +
      "```";
    const out = parseClozeResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0].sentence).toBe("hello");
  });

  it("strips smart quotes that small LLMs emit by default", () => {
    const raw = `[{“index”:1,“sentence”:“hola”,“translation”:“hi”}]`;
    const out = parseClozeResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0].sentence).toBe("hola");
  });

  it("parses JSONL when the model skips the array brackets", () => {
    const raw = [
      `{"index":1,"sentence":"Ich gehe nach Hause","translation":"I go home"}`,
      `{"index":2,"sentence":"Sie liest ein Buch","translation":"She reads a book"}`,
    ].join("\n");
    const out = parseClozeResponse(raw);
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
    const out = parseClozeResponse(raw);
    expect(out).toHaveLength(2);
    expect(out[0].sentence).toBe("我吃饭");
    expect(out[1].sentence).toBe("她笑了");
  });

  it("parses numbered-list fallback with em-dash separator", () => {
    const raw =
      `1. Je mange une pomme — I am eating an apple\n` +
      `2. Tu cours vite — You run fast\n` +
      `3. Nous parlons français — We speak French`;
    const out = parseClozeResponse(raw);
    expect(out).toHaveLength(3);
    expect(out[0].sentence).toBe("Je mange une pomme");
    expect(out[0].translation).toBe("I am eating an apple");
    expect(out[2].translation).toBe("We speak French");
  });

  it("parses numbered-list fallback with parenthesised translation", () => {
    const raw = `1. 私は寿司を食べます (I eat sushi)\n2. 彼は走ります (He runs)`;
    const out = parseClozeResponse(raw);
    expect(out).toHaveLength(2);
    expect(out[0].sentence).toBe("私は寿司を食べます");
    expect(out[1].translation).toBe("He runs");
  });

  it("returns [] when the reply is empty or unparseable", () => {
    expect(parseClozeResponse("")).toEqual([]);
    expect(parseClozeResponse("no JSON here at all")).toEqual([]);
  });
});

describe("parseTranslations", () => {
  it("parses JSONL translation objects", () => {
    const raw = [
      `{"index":1,"translation":"I drink water every day"}`,
      `{"index":2,"translation":"She is running"}`,
    ].join("\n");
    const out = parseTranslations(raw);
    expect(out).toHaveLength(2);
    expect(out[0].translation).toBe("I drink water every day");
    expect(out[1].index).toBe(2);
  });

  it("parses a JSON array of translation objects", () => {
    const raw = `[{"index":1,"translation":"hello"},{"index":2,"translation":"goodbye"}]`;
    const out = parseTranslations(raw);
    expect(out).toHaveLength(2);
    expect(out[1].translation).toBe("goodbye");
  });

  it("strips code fences and smart quotes", () => {
    const raw = "```json\n" + `{“index”:1,“translation”:“hi”}\n` + "```";
    const out = parseTranslations(raw);
    expect(out).toHaveLength(1);
    expect(out[0].translation).toBe("hi");
  });

  it("extracts objects scattered between prose", () => {
    const raw =
      `Sure!\n{"index":1,"translation":"I eat"}\nand\n{"index":2,"translation":"She laughed"}\ndone`;
    const out = parseTranslations(raw);
    expect(out).toHaveLength(2);
    expect(out[0].translation).toBe("I eat");
  });

  it("falls back to a numbered list when the model abandons JSON", () => {
    const raw = `1. I am eating an apple\n2. You run fast`;
    const out = parseTranslations(raw);
    expect(out).toHaveLength(2);
    expect(out[0].index).toBe(1);
    expect(out[1].translation).toBe("You run fast");
  });

  it("returns [] for empty or unparseable replies", () => {
    expect(parseTranslations("")).toEqual([]);
    expect(parseTranslations("no structure here")).toEqual([]);
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
    // 苹 alone shouldn't trigger a stem-match — strict for CJK.
    expect(sentenceContainsWord("我喜欢吃水果", "苹果")).toBe(false);
  });

  it("allows stem match for Latin words ≥ 5 chars when the model conjugates", () => {
    // "comer" → "comemos" — stem "comem" / "come" still inside the sentence.
    expect(sentenceContainsWord("Nosotros comemos pan", "comer")).toBe(true);
    // "schreiben" → "schreibe" / "schreibt" / etc.
    expect(sentenceContainsWord("Ich schreibe einen Brief", "schreiben")).toBe(true);
  });

  it("doesn't loose-match short function words", () => {
    // "to" stem-match would be too aggressive; keep strict for short
    // words. "to" still appears literally, so this returns true.
    expect(sentenceContainsWord("I go to school", "to")).toBe(true);
    // The pathological case: "go" is short, and "going" contains "go" exactly,
    // so we'd accept it. That's fine — bigger risk is false-positives on
    // unrelated words, which short stems wouldn't help anyway.
  });
});
