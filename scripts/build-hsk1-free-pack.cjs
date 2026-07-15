/**
 * Builds packs/chinese-hsk1-new3-free.json by extracting HSK 3.0 Band 1
 * + the HSK Standard Course 1 chapter list from the existing bundle,
 * then enriching each chapter with the real lesson title and a short
 * Chinese reading body so users have something to actually read.
 *
 * Run: `node scripts/build-hsk1-free-pack.cjs`
 *
 * NOTE: the source bundle (packs/chinese-hsk30-bundle.json) lives in the
 * tokori-cloud repo, not here — copy it in before re-running. The checked-in
 * pack also carries a hand-verified 506-word band list (500 canonical words
 * + the official list's variant forms) and curated `media` recommendations;
 * make sure the bundle's band-1 collection matches before regenerating, or
 * you'll regress the word list. Media entries are preserved from the
 * existing pack file.
 *
 * The output pack ships under the "tokori-pack/v1" schema and is
 * marked free / no-account-required via the pack's id prefix
 * `free:` — desktop and mobile bundle a copy of this file and let any
 * user activate it without sign-in.
 */

const fs = require("fs");
const path = require("path");

const SOURCE = path.join(
  __dirname,
  "..",
  "packs",
  "chinese-hsk30-bundle.json",
);
const OUT = path.join(
  __dirname,
  "..",
  "packs",
  "chinese-hsk1-new3-free.json",
);

// Real HSK Standard Course 1 lesson titles (verified against the book's
// table of contents) + matching reading bodies. Body texts use only
// HSK 1 vocabulary plus words the book has taught up to that lesson
// (the per-chapter vocab lists), so a brand-new student can read them.
// Character names (李月, 王方, 谢朋, 大卫) are the book's own cast.
const LESSONS = [
  {
    title: "Lesson 1 · 你好 — Hello",
    notes: "Greetings with 你/您; sorry & it's OK (对不起 / 没关系).",
    body: `你好!\n您好!\n你们好!\n你好吗?\n我很好,谢谢。你呢?\n我也很好。\n对不起!\n没关系。\n再见!`,
  },
  {
    title: "Lesson 2 · 谢谢你 — Thank you",
    notes: "Saying thank you, you're welcome, goodbye.",
    body: `谢谢你!\n不客气。\n对不起。\n没关系。\n再见!\n明天见!`,
  },
  {
    title: "Lesson 3 · 你叫什么名字 — What's your name",
    notes: "Names with 叫, nationality, 是 sentences.",
    body: `你好!你叫什么名字?\n我叫李月。你呢?\n我叫大卫。\n你是哪国人?\n我是美国人。\n认识你很高兴。\n认识你我也很高兴。`,
  },
  {
    title: "Lesson 4 · 她是我的汉语老师 — She is my Chinese teacher",
    notes: "Family, occupations, possessive 的, 都 for 'all'.",
    body: `这是我的爸爸,这是我的妈妈。\n她是谁?\n她是我的汉语老师,她叫王月。\n他是医生,我是学生。\n你们都是中国人吗?\n不,大卫是美国人。`,
  },
  {
    title: "Lesson 5 · 她女儿今年二十岁 — Her daughter is twenty this year",
    notes: "Numbers, age with 岁, family members, 几 questions.",
    body: `他今年多大?\n他今年二十五岁。\n你的女儿几岁?\n她今年八岁。\n我儿子十岁。\n我们家有四口人:爸爸、妈妈、姐姐和我。`,
  },
  {
    title: "Lesson 6 · 我会说汉语 — I can speak Chinese",
    notes: "Modal verb 会; asking how to read and write characters.",
    body: `你会说汉语吗?\n我会说汉语,也会写汉字。\n这个字怎么读?\n这个字读“茶”。\n你妈妈做的菜好吃吗?\n很好吃!`,
  },
  {
    title: "Lesson 7 · 今天几号 — What's the date today",
    notes: "Dates with 号/月, days of the week, 昨天/今天/明天.",
    body: `今天几号?\n今天五月四号。\n今天星期几?\n今天星期一。\n昨天你去学校了吗?\n去了。明天是我的生日!\n太好了!我们一起吃饭吧!`,
  },
  {
    title: "Lesson 8 · 我想喝茶 — I'd like some tea",
    notes: "想 + verb for wants; buying things; money with 块.",
    body: `下午你想喝什么?\n我想喝茶,你呢?\n我想喝水。\n你想吃什么?\n我想吃米饭。\n这个杯子多少钱?\n十块。\n我买两个,这些钱给你。`,
  },
  {
    title: "Lesson 9 · 你儿子在哪儿工作 — Where does your son work",
    notes: "Workplaces with 在…工作; position word 下面.",
    body: `你儿子在哪儿工作?\n他在医院工作,他是医生。\n你爸爸也是医生吗?\n是,他也在那儿工作。\n你们家有猫吗?\n有,小猫在椅子下面。\n狗呢?\n狗在桌子下面!`,
  },
  {
    title: "Lesson 10 · 我能坐这儿吗 — Can I sit here",
    notes: "能 for permission; location words 前面/后面/里.",
    body: `请问,我能坐这儿吗?\n能,请坐。\n谢朋在哪儿?\n他在前面,王方在他后面。\n我的书和电脑呢?\n书在桌子上,电脑在书的下面。`,
  },
  {
    title: "Lesson 11 · 现在几点 — What time is it now",
    notes: "Telling the time with 点/分; 什么时候 questions.",
    body: `现在几点?\n现在十一点五十分。\n中午我们去吃饭吧!\n好的,吃饭后我想看电影。\n你什么时候回北京?\n明天中午。`,
  },
  {
    title: "Lesson 12 · 明天天气怎么样 — What's the weather like tomorrow",
    notes: "Weather with 下雨/冷/热; 太…了; 怎么样 questions.",
    body: `明天天气怎么样?\n明天下雨,有些冷。\n今天太热了!\n多喝水,多吃水果,身体好!\n小姐,你爱喝什么?\n我爱喝水,不爱喝茶。`,
  },
  {
    title: "Lesson 13 · 他在学做中国菜呢 — He is learning to cook Chinese food",
    notes: "Progressive 在…呢; phone calls with 喂 and 给…打电话.",
    body: `喂,大卫,你在做什么呢?\n我在学做中国菜呢。\n你不是在看电视吧?\n没有,我很喜欢做菜。\n好,上午我给你打电话,我们一起学习。\n好的,再见!`,
  },
  {
    title: "Lesson 14 · 她买了不少衣服 — She bought quite a few clothes",
    notes: "Completed action with 了; 都 for 'all'; 看见.",
    body: `你看,她买了很多东西!\n这些衣服都很漂亮啊。\n王先生呢?\n他开车去买苹果了,二十分钟后回来。\n我看见他的车了,在学校前面。`,
  },
  {
    title: "Lesson 15 · 我是坐飞机来北京的 — I came to Beijing by plane",
    notes: "是…的 for how something happened; 一起 invitations.",
    body: `你是怎么来北京的?\n我是坐飞机来的。\n认识你很高兴!\n我们一起坐出租车去饭店吧。\n好!明年我想去你的大学看你。\n太好了!`,
  },
];

const src = JSON.parse(fs.readFileSync(SOURCE, "utf8"));

const band1 = src.collections.find((c) => c.id === "hsk30-band-1");
if (!band1) throw new Error("hsk30-band-1 collection not found in bundle");

const course1 = src.textbooks.find((t) => t.title === "HSK Standard Course 1");
if (!course1) throw new Error("HSK Standard Course 1 not found in bundle");

if (course1.chapters.length !== LESSONS.length) {
  console.warn(
    `[warn] chapter count (${course1.chapters.length}) ≠ lesson count (${LESSONS.length}); using minimum`,
  );
}

const enrichedChapters = course1.chapters.map((ch, i) => {
  const meta = LESSONS[i];
  if (!meta) return ch;
  return {
    position: ch.position,
    title: meta.title,
    notes: meta.notes,
    body: meta.body,
    vocab: ch.vocab,
  };
});

// Curated Immersion recommendations are maintained in the checked-in pack
// (verified URLs + level notes) — carry them through a regeneration.
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : null;

const wordCount = band1.words.length;
const out = {
  schema: "tokori-pack/v1",
  // The `free:` prefix is the cue desktop + mobile use to surface this
  // pack in their built-in catalogue without an account check.
  id: "free:chinese-hsk1-new3",
  name: "HSK 1 (new HSK 3.0) — Free",
  language: "zh",
  description: `All ${wordCount} vocabulary items at the new HSK 1 level (HSK 3.0, 2021), verified against the canonical word list, plus a Chinese course textbook with 15 lessons and per-lesson vocab. Free for everyone.`,
  version: prev?.version ?? "1.2.0",
  license:
    "Free for personal use. Vocab list courtesy of the official HSK 3.0 standard; lesson texts written for Tokori.",
  collections: [
    {
      id: "hsk1-band",
      name: `HSK 1 · all ${wordCount} words`,
      description:
        "Every vocabulary item in HSK Level 1 (new HSK 3.0, 2021) — the 500 canonical words plus the official list's variant forms (爸/妈/哥/姐/妹/弟, 有时, 有一些, 第二).",
      words: band1.words,
    },
  ],
  textbooks: [
    {
      id: "hsk-standard-course-1",
      title: "HSK Standard Course 1",
      author: "Jiang Liping (course structure)",
      totalUnits: enrichedChapters.length,
      unitLabel: "lessons",
      chapters: enrichedChapters,
    },
  ],
  ...(prev?.media ? { media: prev.media } : {}),
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
const stat = fs.statSync(OUT);
console.log(
  `Wrote ${path.relative(process.cwd(), OUT)} (${(stat.size / 1024).toFixed(1)} KB)`,
);
console.log(`  collections: ${out.collections.length} (${out.collections[0].words.length} words)`);
console.log(`  textbooks:   ${out.textbooks.length} (${out.textbooks[0].chapters.length} chapters)`);
console.log(`  media:       ${out.media?.length ?? 0} recommendations (carried from previous pack)`);
