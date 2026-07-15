import { describe, expect, it } from "vitest";
import { consumeVoiceAsk, requestVoiceAsk } from "@/lib/ask-intent";

describe("ask-intent", () => {
  it("hands a queued ask over exactly once", () => {
    requestVoiceAsk({ text: "怎么说 hello?", speak: true });
    expect(consumeVoiceAsk()).toEqual({ text: "怎么说 hello?", speak: true });
    // One-shot: a second consume finds the buffer empty.
    expect(consumeVoiceAsk()).toBeNull();
  });

  it("returns null when nothing is queued", () => {
    expect(consumeVoiceAsk()).toBeNull();
  });

  it("keeps only the most recent ask", () => {
    requestVoiceAsk({ text: "first", speak: false });
    requestVoiceAsk({ text: "second", speak: true });
    // ChatView consumes on its own schedule — if two asks land before
    // it wakes up, the newer one wins rather than replaying both.
    expect(consumeVoiceAsk()).toEqual({ text: "second", speak: true });
    expect(consumeVoiceAsk()).toBeNull();
  });
});
