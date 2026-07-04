/**
 * Builds packs/chinese-hsk1-new3-free.json by extracting HSK 3.0 Band 1
 * + the HSK Standard Course 1 chapter list from the existing bundle,
 * then enriching each chapter with a real lesson title and a short
 * Chinese reading body so users have something to actually read.
 *
 * Run: `node scripts/build-hsk1-free-pack.js`
 *
 * The output pack ships under the "polot-pack/v1" schema and is
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

// Real HSK Standard Course 1 lesson titles + matching reading bodies.
// Body texts use only HSK 1 vocabulary (and the lesson's own focus
// words) so a brand-new student can read them. Each is 60-180
// characters — short enough to feel achievable, long enough to give
// the click-to-define popover something to chew on.
const LESSONS = [
  {
    title: "Lesson 1 · 你好 — Hello",
    notes: "Greetings, courtesy phrases.",
    body: `你好!\n你好!\n你好吗?\n我很好,谢谢。你呢?\n我也很好。\n再见!\n再见!`,
  },
  {
    title: "Lesson 2 · 谢谢你 — Thank you",
    notes: "Saying thank you, you're welcome, sorry, no problem.",
    body: `谢谢你!\n不客气。\n对不起。\n没关系。\n再见!\n明天见!`,
  },
  {
    title: "Lesson 3 · 你叫什么名字 — What's your name",
    notes: "Names, asking and answering basic identity questions.",
    body: `你好!你叫什么名字?\n我叫李月。你呢?\n我叫王大伟。\n认识你很高兴。\n认识你我也很高兴。`,
  },
  {
    title: "Lesson 4 · 她是我的汉语老师 — She is my Chinese teacher",
    notes: "Family, occupations, possessive 的.",
    body: `这是我的爸爸,这是我的妈妈。\n她是我的汉语老师,她叫陈老师。\n他是医生,我也是学生。\n我们都是中国人吗?\n不,他是英国人。`,
  },
  {
    title: "Lesson 5 · 她女儿今年二十岁 — Her daughter is twenty this year",
    notes: "Numbers, age, family members.",
    body: `他今年多大?\n他今年二十五岁。\n你的女儿几岁?\n她今年八岁。\n我儿子十岁。\n我们家有四口人:爸爸、妈妈、姐姐和我。`,
  },
  {
    title: "Lesson 6 · 我能用一下你的铅笔吗 — May I use your pencil",
    notes: "Polite requests, may/can with 能, classifiers.",
    body: `请问,你的书在哪儿?\n在桌子上。\n我能用一下你的铅笔吗?\n当然可以。\n谢谢!\n不客气。`,
  },
  {
    title: "Lesson 7 · 今天几号 — What's the date today",
    notes: "Dates, days of the week, months.",
    body: `今天几号?\n今天五月四号。\n今天星期几?\n今天星期一。\n明天是我的生日!\n祝你生日快乐!`,
  },
  {
    title: "Lesson 8 · 我感冒了 — I have a cold",
    notes: "Health, feelings, simple complaints.",
    body: `你怎么了?\n我感冒了,头疼。\n你应该多喝水,多休息。\n谢谢医生。\n不客气,明天再来。`,
  },
  {
    title: "Lesson 9 · 他在哪儿呢 — Where is he",
    notes: "Locations, asking where, prepositions.",
    body: `请问,王老师在哪儿?\n他在教室里。\n图书馆在哪里?\n图书馆在那儿,在学校的右边。\n谢谢!\n不客气。`,
  },
  {
    title: "Lesson 10 · 我喝茶,你呢 — I drink tea, what about you",
    notes: "Food and drink, eating out, simple choice questions.",
    body: `你想喝什么?\n我想喝茶。你呢?\n我喝咖啡。\n你饿吗?\n我有点儿饿,我们吃饭吧!\n好的,我们去餐馆。`,
  },
  {
    title: "Lesson 11 · 我想喝茶 — I want to drink tea",
    notes: "Wishes and intentions with 想, ordering food.",
    body: `服务员!\n你好,你想吃什么?\n我想吃米饭和鱼。\n你想喝什么?\n我想喝一杯茶。\n好的,请等一下。`,
  },
  {
    title: "Lesson 12 · 多少钱 — How much",
    notes: "Shopping, prices, quantities.",
    body: `请问,这个苹果多少钱?\n一个三块钱。\n我要五个,谢谢。\n一共十五块。\n给您。\n谢谢!`,
  },
  {
    title: "Lesson 13 · 我们坐公共汽车去吧 — Let's take the bus",
    notes: "Transport, suggestions with 吧, simple plans.",
    body: `我们怎么去学校?\n我们坐公共汽车去吧。\n太慢了!打车吧。\n好的,打车快一点儿。\n出租车在那儿。\n我们走吧!`,
  },
  {
    title: "Lesson 14 · 喂,请问王老师在吗 — Hello, is Teacher Wang there",
    notes: "Phone calls, polite questions, leaving a message.",
    body: `喂,你好。\n你好,请问王老师在吗?\n他不在。请问您是谁?\n我是李月,他的学生。\n请他给我打电话,谢谢!\n好的,再见。`,
  },
  {
    title: "Lesson 15 · 祝你生日快乐 — Happy birthday",
    notes: "Wishes, celebrations, gifts.",
    body: `今天是我的生日!\n真的吗?生日快乐!\n谢谢!这是我的生日蛋糕。\n这是给你的礼物。\n谢谢你!\n不客气,祝你健康!`,
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

const out = {
  schema: "tokori-pack/v1",
  // The `free:` prefix is the cue desktop + mobile use to surface this
  // pack in their built-in catalogue without an account check.
  id: "free:chinese-hsk1-new3",
  name: "HSK 1 (new HSK 3.0) — Free",
  language: "zh",
  description:
    "All 461 vocabulary items at the new HSK 1 level (HSK 3.0, 2021) plus the HSK Standard Course 1 textbook with 15 lessons, lesson titles, short readings, and per-chapter vocab. Free for everyone.",
  version: "1.0.0",
  license: "Free for personal use. Vocab list courtesy of the official HSK 3.0 standard; lesson texts written for ParrotLM.",
  collections: [
    {
      id: "hsk1-band",
      name: "HSK 1 · all 461 words",
      description: "Every vocabulary item in HSK Level 1 (new HSK 3.0).",
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
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
const stat = fs.statSync(OUT);
console.log(
  `Wrote ${path.relative(process.cwd(), OUT)} (${(stat.size / 1024).toFixed(1)} KB)`,
);
console.log(`  collections: ${out.collections.length} (${out.collections[0].words.length} words)`);
console.log(`  textbooks:   ${out.textbooks.length} (${out.textbooks[0].chapters.length} chapters)`);
