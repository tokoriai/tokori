export type CedictEntry = {
  pinyin: string;
  gloss: string;
};

// Tiny CC-CEDICT subset bundled for the click-to-define demo.
// The full CEDICT (~120k entries) will land in a Tauri-side dictionary store later.
export const CEDICT_MINI: Record<string, CedictEntry> = {
  你好: { pinyin: "nǐ hǎo", gloss: "hello" },
  你: { pinyin: "nǐ", gloss: "you" },
  好: { pinyin: "hǎo", gloss: "good; well" },
  我: { pinyin: "wǒ", gloss: "I; me" },
  是: { pinyin: "shì", gloss: "to be" },
  的: { pinyin: "de", gloss: "(possessive / modifier particle)" },
  中文: { pinyin: "zhōng wén", gloss: "Chinese (language)" },
  中国: { pinyin: "zhōng guó", gloss: "China" },
  老师: { pinyin: "lǎo shī", gloss: "teacher" },
  学生: { pinyin: "xué shēng", gloss: "student" },
  想: { pinyin: "xiǎng", gloss: "to want; to think; to miss" },
  学: { pinyin: "xué", gloss: "to study; to learn" },
  学习: { pinyin: "xué xí", gloss: "to study; to learn" },
  什么: { pinyin: "shén me", gloss: "what" },
  谢谢: { pinyin: "xiè xie", gloss: "thank you" },
  再见: { pinyin: "zài jiàn", gloss: "goodbye" },
  朋友: { pinyin: "péng you", gloss: "friend" },
  不: { pinyin: "bù", gloss: "not; no" },
  喜欢: { pinyin: "xǐ huan", gloss: "to like" },
  书: { pinyin: "shū", gloss: "book" },
  读: { pinyin: "dú", gloss: "to read" },
  写: { pinyin: "xiě", gloss: "to write" },
  说: { pinyin: "shuō", gloss: "to speak; to say" },
  听: { pinyin: "tīng", gloss: "to listen" },
  看: { pinyin: "kàn", gloss: "to look; to watch; to read" },
  吗: { pinyin: "ma", gloss: "(question particle)" },
  呢: { pinyin: "ne", gloss: "(question/follow-up particle)" },
  今天: { pinyin: "jīn tiān", gloss: "today" },
  明天: { pinyin: "míng tiān", gloss: "tomorrow" },
  昨天: { pinyin: "zuó tiān", gloss: "yesterday" },
  请: { pinyin: "qǐng", gloss: "please; to invite" },
  问: { pinyin: "wèn", gloss: "to ask" },
  问题: { pinyin: "wèn tí", gloss: "question; problem" },
  名字: { pinyin: "míng zi", gloss: "name" },
  叫: { pinyin: "jiào", gloss: "to be called; to call" },
  人: { pinyin: "rén", gloss: "person" },
  家: { pinyin: "jiā", gloss: "home; family" },
  吃: { pinyin: "chī", gloss: "to eat" },
  喝: { pinyin: "hē", gloss: "to drink" },
  茶: { pinyin: "chá", gloss: "tea" },
  水: { pinyin: "shuǐ", gloss: "water" },
  会: { pinyin: "huì", gloss: "to be able to; will" },
  在: { pinyin: "zài", gloss: "at; in; to exist" },
  和: { pinyin: "hé", gloss: "and; with" },
  也: { pinyin: "yě", gloss: "also; too" },
  很: { pinyin: "hěn", gloss: "very" },
  有: { pinyin: "yǒu", gloss: "to have; there is" },
  没有: { pinyin: "méi yǒu", gloss: "to not have; there is not" },
  这: { pinyin: "zhè", gloss: "this" },
  那: { pinyin: "nà", gloss: "that" },
};

export function lookup(word: string): CedictEntry | undefined {
  return CEDICT_MINI[word];
}
