import { describe, expect, it } from "vitest";
import {
  normalizeClozeFront,
  normalizeSentenceEntries,
  parseToolCalls,
  pendingToolLabel,
  sanitizeStreamingReply,
  summarizeToolCalls,
} from "@/lib/tools";

describe("parseToolCalls — card-creation tools", () => {
  it("parses a create_flashcard block", () => {
    const content =
      "Here's a card.\n```polyglot-tool\n" +
      '{"name":"create_flashcard","args":{"word":"猫","reading":"māo","gloss":"cat"}}\n' +
      "```";
    const calls = parseToolCalls(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("create_flashcard");
    expect(calls[0].args.word).toBe("猫");
  });

  it("parses a create_sentence_cards block with entries", () => {
    const content =
      "```polyglot-tool\n" +
      '{"name":"create_sentence_cards","args":{"entries":[' +
      '{"sentence":"我喜欢猫","translation":"I like cats"}]}}\n' +
      "```";
    const calls = parseToolCalls(content);
    expect(calls[0].name).toBe("create_sentence_cards");
    expect((calls[0].args.entries as unknown[]).length).toBe(1);
  });
});

describe("summarizeToolCalls — card-creation tools", () => {
  it("names the word for a flashcard", () => {
    const s = summarizeToolCalls([
      { name: "create_flashcard", args: { word: "猫" } },
    ]);
    expect(s).toContain('flashcard for "猫"');
  });

  it("pluralizes sentence cards by entry count", () => {
    expect(
      summarizeToolCalls([
        { name: "create_sentence_cards", args: { entries: [{}, {}] } },
      ]),
    ).toContain("2 sentence cards");
    expect(
      summarizeToolCalls([
        { name: "create_sentence_cards", args: { entries: [{}] } },
      ]),
    ).toContain("1 sentence card");
  });
});

describe("sanitizeStreamingReply", () => {
  it("passes plain text through untouched", () => {
    const r = sanitizeStreamingReply("你好！今天怎么样？");
    expect(r.text).toBe("你好！今天怎么样？");
    expect(r.toolPending).toBe(false);
    expect(r.pendingToolName).toBeNull();
  });

  it("strips a complete tool block and reports it", () => {
    const r = sanitizeStreamingReply(
      'Saving that word.\n```polyglot-tool\n{"name":"add_vocab","args":{"word":"猫"}}\n```\nDone!',
    );
    expect(r.text).toBe("Saving that word.\n\nDone!");
    expect(r.toolPending).toBe(true);
    expect(r.pendingToolName).toBe("add_vocab");
  });

  it("hides an unterminated tool block mid-stream (the JSON-leak case)", () => {
    const r = sanitizeStreamingReply(
      'Saving that word.\n```polyglot-tool\n{"name":"add_vocab","args":{"wo',
    );
    expect(r.text).toBe("Saving that word.");
    expect(r.toolPending).toBe(true);
    expect(r.pendingToolName).toBe("add_vocab");
  });

  it("reports a pending tool before its name has streamed in", () => {
    const r = sanitizeStreamingReply("One sec.\n```polyglot-tool\n{\"na");
    expect(r.text).toBe("One sec.");
    expect(r.toolPending).toBe(true);
    expect(r.pendingToolName).toBeNull();
  });

  it("hides a partial fence at the streaming tail", () => {
    const r = sanitizeStreamingReply("Let me add that.\n```polyg");
    expect(r.text).toBe("Let me add that.");
    // Too early to know it's a tool block — no pulse yet, just no JSON.
    expect(r.toolPending).toBe(false);
  });

  it("leaves ordinary code fences alone", () => {
    const csv = "Here you go:\n```csv\nword,gloss\n猫,cat\n```";
    expect(sanitizeStreamingReply(csv).text).toBe(csv);
    expect(sanitizeStreamingReply(csv).toolPending).toBe(false);
  });

  it("hides vocab blocks (complete and unterminated) behind the pulse", () => {
    const complete = sanitizeStreamingReply(
      "Here are the words:\n```vocab\n猫 | māo | cat\n狗 | gǒu | dog\n```\nPractice them!",
    );
    expect(complete.text).toBe("Here are the words:\n\nPractice them!");
    expect(complete.vocabPending).toBe(true);

    const streaming = sanitizeStreamingReply(
      "Here are the words:\n```vocab\n猫 | māo | ca",
    );
    expect(streaming.text).toBe("Here are the words:");
    expect(streaming.vocabPending).toBe(true);

    expect(sanitizeStreamingReply("plain").vocabPending).toBe(false);
  });

  it("keeps passage text readable while stripping only the fence markers", () => {
    // Unterminated: the opener line vanishes, streamed content shows.
    const streaming = sanitizeStreamingReply(
      "Here's a story:\n```passage\n# 我的一天\n今天我去了公园。",
    );
    expect(streaming.text).toBe("Here's a story:\n# 我的一天\n今天我去了公园。");

    // Complete: closer goes too, and the shown prefix is unchanged —
    // the imperative typer depends on prefix stability at the moment
    // the closing fence lands.
    const complete = sanitizeStreamingReply(
      "Here's a story:\n```passage\n# 我的一天\n今天我去了公园。\n```",
    );
    expect(complete.text.startsWith(streaming.text)).toBe(true);
  });

  it("hides any partial fence tail, not just the tool one", () => {
    expect(sanitizeStreamingReply("Words below.\n```voc").text).toBe("Words below.");
    expect(sanitizeStreamingReply("A story:\n```passa").text).toBe("A story:");
  });
});

describe("pendingToolLabel", () => {
  it("maps known tools to friendly progressive labels", () => {
    expect(pendingToolLabel("add_vocab")).toBe("Adding vocabulary…");
    expect(pendingToolLabel("add_vocab_bulk")).toBe("Adding vocabulary…");
    expect(pendingToolLabel("create_flashcard")).toBe("Creating a flashcard…");
  });

  it("falls back to a generic label for unknown / unparsed names", () => {
    expect(pendingToolLabel(null)).toBe("Preparing an action…");
    expect(pendingToolLabel("future_tool")).toBe("Preparing an action…");
  });
});

describe("normalizeSentenceEntries", () => {
  it("keeps valid rows, maps field aliases, drops invalid ones", () => {
    const rows = normalizeSentenceEntries([
      { sentence: "猫がいる", translation: "There is a cat", reading: "neko ga iru" },
      { target: "犬", native: "dog" }, // alias keys
      { translation: "orphan" }, // no sentence → dropped
      "garbage", // non-object → dropped
      null,
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      sentence: "猫がいる",
      translation: "There is a cat",
      reading: "neko ga iru",
    });
    expect(rows[1]).toEqual({ sentence: "犬", translation: "dog", reading: null });
  });

  it("returns an empty array for non-array input", () => {
    expect(normalizeSentenceEntries(undefined)).toEqual([]);
    expect(normalizeSentenceEntries("nope")).toEqual([]);
    expect(normalizeSentenceEntries({})).toEqual([]);
  });
});

describe("normalizeClozeFront", () => {
  it("leaves an already-marked cloze untouched", () => {
    expect(normalizeClozeFront("猫", "我有一只{{c1::猫}}")).toBe(
      "我有一只{{c1::猫}}",
    );
  });

  it("wraps the first occurrence of the headword", () => {
    expect(normalizeClozeFront("cat", "the cat sat on the cat")).toBe(
      "the {{c1::cat}} sat on the cat",
    );
  });

  it("returns the sentence unchanged when the word is absent", () => {
    expect(normalizeClozeFront("dog", "the cat sat")).toBe("the cat sat");
  });
});
