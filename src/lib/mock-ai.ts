/**
 * Mock AI used in non-Tauri builds (browser dev + the marketing-site demo).
 *
 * No network calls, no API keys — just a small bank of plausible Chinese-tutor
 * replies the chat picks from based on the user's last message. Streams
 * character-by-character so the streaming UI behaves the same as a real
 * provider.
 *
 * Real providers always win when running under Tauri. This module only fires
 * when `isTauri()` is false.
 */

type Pattern = {
  /** Test against the user's last message. */
  match: RegExp;
  /** Pick one at random. */
  replies: string[];
};

const PATTERNS: Pattern[] = [
  {
    match: /把|grammar|particle|construction|disposal/i,
    replies: [
      "好问题!The **把** construction (`把字句`) brings the *thing acted on* to the front of the sentence so the focus shifts to what happens to it.\n\n" +
        "Pattern: **Subject + 把 + Object + Verb + (extra info)**\n\n" +
        "- 我吃了苹果 — *I ate the apple* (neutral)\n" +
        "- 我把苹果吃了 — *I ate up the apple* (focus: the apple is gone)\n\n" +
        "The verb usually has a result attached — 了, 完, 给, or a complement. You wouldn't use it with feeling/perception verbs like 喜欢 or 看见.",
    ],
  },
  {
    match: /了|le|aspect|tense|change/i,
    replies: [
      "了 has two distinct jobs that look similar:\n\n" +
        "1. **Verb-了** = the action is complete. 我吃了三个饺子 = I ate three dumplings.\n" +
        "2. **Sentence-final 了** = a change of state, or new information. 我饿了 = I'm hungry now (I wasn't before).\n\n" +
        "Both can show up together: 我吃了三个饺子了 — *I've eaten three dumplings (and that's the latest count).*\n\n" +
        "Want me to drill you on a few examples?",
    ],
  },
  {
    match: /tone|声调|pinyin|pronunciation|sandhi/i,
    replies: [
      "Mandarin tones change in two important sandhi rules you'll meet daily:\n\n" +
        "- **Two 3rd tones in a row** → first becomes a 2nd tone. 你好 (nǐ hǎo) is pronounced *ní hǎo*.\n" +
        "- **不 (bù) before a 4th tone** → becomes bú. 不是 → bú shì, 不要 → bú yào.\n\n" +
        "Dictionaries usually keep the lexical (written) tone, but pronunciation follows the sandhi rule.",
    ],
  },
  {
    match: /^(hi|hello|hey|你好|您好|嗨)\b/i,
    replies: [
      "你好!很高兴见到你。我们今天想练什么?\n\n" +
        "We could:\n" +
        "- review some 词汇 from your collection\n" +
        "- read a short 故事 together\n" +
        "- work through a 语法 point you've been stuck on\n\n" +
        "Just tell me what feels useful right now.",
      "嗨!Welcome back. Pick anything: vocabulary drills, a reading passage, grammar questions — I'll match the level you're at.",
    ],
  },
  {
    match: /vocab|word|drill|practice|review|学|词/i,
    replies: [
      "好的!Let's drill. Translate these into English. Try without looking them up first:\n\n" +
        "1. 朋友\n2. 学习\n3. 时间\n4. 工作\n5. 因为…所以…\n\n" +
        "When you're done, say *check* and I'll go through them with you.",
      "Pick five 词 from your **HSK 2 sample** collection and put each one in a sentence. I'll fix the grammar and suggest a more natural phrasing where it helps. Take your time.",
    ],
  },
  {
    match: /story|read|passage|reading|阅读/i,
    replies: [
      "Here's a short passage at your level. Hover any word for a definition.\n\n" +
        "今天是周末,天气很好。我和朋友决定去公园散步。\n" +
        "公园里有很多花,也有很多人在跑步。我们坐在长椅上聊天,喝咖啡。\n" +
        "我朋友说她下个月要去北京工作。我有点羡慕,但是我也很为她高兴。\n\n" +
        "After you've read it, tell me one new word you learned and I'll give you another sentence using it.",
    ],
  },
  {
    match: /thank|thanks|谢谢|感谢/i,
    replies: [
      "不客气!你做得很好,继续加油 💪 — what's next?",
    ],
  },
];

const FALLBACKS = [
  "好的!Let's work on that. 你想用中文练习,还是先用英文搞清楚概念?\n\n" +
    "If you tell me a bit more about what you're stuck on — a grammar point, a phrase you don't trust, a sentence you want to say — I can give you a more targeted drill.",
  "Got it. We can take this one of two ways: either I explain the underlying rule and we test it with examples, or I give you 3-5 sentences right now and you translate them. 你选?",
  "好。Before I answer, let's anchor it: do you remember seeing this in your reader / textbook recently? If so I'll connect the explanation to the passage you saw it in.",
];

/** Pick a plausible reply for the user's last message. Side-effect free. */
export function mockReply(
  messages: { role: string; content: string }[],
): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = lastUser?.content ?? "";
  for (const p of PATTERNS) {
    if (p.match.test(text)) {
      return p.replies[Math.floor(Math.random() * p.replies.length)];
    }
  }
  return FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
}

/** Stream the reply char-by-char with a slightly varying cadence. */
export async function streamMockReply(
  reply: string,
  onToken: (delta: string) => void,
): Promise<void> {
  // Slight head pause so the "thinking" indicator has time to render — mirrors
  // real providers which take ~150-300 ms before the first token.
  await new Promise((r) => setTimeout(r, 220));
  for (let i = 0; i < reply.length; i++) {
    const ch = reply[i];
    onToken(ch);
    // Punctuation pause makes streaming feel more natural.
    const pause = /[。.!?,,;\n]/.test(ch) ? 60 : 14;
    await new Promise((r) => setTimeout(r, pause));
  }
}
