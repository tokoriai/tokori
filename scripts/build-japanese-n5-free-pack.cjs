/**
 * Builds packs/japanese-n5-free.json from jamsinclair/open-anki-jlpt-decks.
 *
 * Source: https://github.com/jamsinclair/open-anki-jlpt-decks (MIT,
 * Jamie Sinclair). Each row in src/n5.csv has: expression, reading,
 * meaning, tags, guid. We strip Anki-specific bits and emit one
 * tokori-pack/v1 collection plus a few thematic sub-collections
 * extracted from the tags column so the user can drill greetings /
 * numbers / verbs in isolation.
 *
 * Run: `node scripts/build-japanese-n5-free-pack.cjs`
 *
 * Re-running is idempotent — overwrites the output file in place.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const SOURCE_URL =
  "https://raw.githubusercontent.com/jamsinclair/open-anki-jlpt-decks/main/src/n5.csv";
const OUT = path.join(__dirname, "..", "packs", "japanese-n5-free.json");

// Thematic sub-collections sourced from the N5 list itself (exact
// match against the `expression` column). Words can belong to
// multiple sub-collections; they always appear in the main "all N5"
// collection regardless.
const TOPICS = [
  {
    id: "n5-pronouns",
    name: "JLPT N5 · Pronouns & people",
    description: "Personal references.",
    words: [
      "私", "あなた", "彼", "彼女", "私たち", "皆さん",
      "誰", "人", "子供", "男", "女", "家族", "父", "母",
      "兄", "姉", "弟", "妹", "友達", "先生", "学生",
    ],
  },
  {
    id: "n5-numbers",
    name: "JLPT N5 · Numbers",
    description: "Counting to ten thousand.",
    words: [
      "一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
      "百", "千", "万", "ゼロ",
    ],
  },
  {
    id: "n5-time",
    name: "JLPT N5 · Time & days",
    description: "Mornings, weekdays, seasons.",
    words: [
      "朝", "昼", "夜", "今日", "昨日", "明日", "今",
      "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日", "日曜日",
      "春", "夏", "秋", "冬", "時間", "分", "年",
    ],
  },
  {
    id: "n5-everyday-verbs",
    name: "JLPT N5 · Everyday verbs",
    description: "The verbs that show up first.",
    words: [
      "ある", "いる", "する", "なる", "行く", "来る", "見る", "聞く",
      "読む", "書く", "話す", "言う", "食べる", "飲む", "買う", "売る",
      "立つ", "座る", "起きる", "寝る", "働く", "勉強する",
      "知る", "分かる", "好き", "嫌い", "出る", "入る",
    ],
  },
  {
    id: "n5-food",
    name: "JLPT N5 · Food & drink",
    description: "What's on the table.",
    words: [
      "水", "お茶", "コーヒー", "牛乳", "ビール", "ご飯", "パン",
      "肉", "魚", "野菜", "果物", "りんご", "卵", "塩", "砂糖",
      "朝御飯", "昼御飯", "晩御飯",
    ],
  },
];

// Day-one greetings aren't on the JLPT N5 test list (they're
// considered pre-N5 in the JLPT framework) but every learner wants
// them on day one. We add them as a separate collection so the pack
// is useful from minute zero, with hand-keyed readings + glosses.
const DAY_ONE_GREETINGS = [
  { word: "おはようございます", reading: "おはようございます", gloss: "good morning (polite)" },
  { word: "こんにちは", reading: "こんにちは", gloss: "hello, good afternoon" },
  { word: "こんばんは", reading: "こんばんは", gloss: "good evening" },
  { word: "おやすみなさい", reading: "おやすみなさい", gloss: "good night" },
  { word: "さようなら", reading: "さようなら", gloss: "goodbye (formal)" },
  { word: "ありがとうございます", reading: "ありがとうございます", gloss: "thank you (polite)" },
  { word: "すみません", reading: "すみません", gloss: "excuse me, sorry" },
  { word: "ごめんなさい", reading: "ごめんなさい", gloss: "I'm sorry" },
  { word: "お願いします", reading: "おねがいします", gloss: "please, I beg you" },
  { word: "どういたしまして", reading: "どういたしまして", gloss: "you're welcome" },
  { word: "はじめまして", reading: "はじめまして", gloss: "nice to meet you" },
  { word: "よろしくお願いします", reading: "よろしくおねがいします", gloss: "pleased to make your acquaintance" },
];

// Universal beginner Japanese vocab the jamsinclair N5 list omits
// (it's tanos-derived and a few obvious words slipped through the
// 2010-era JLPT-spec sieve). Same shape as DAY_ONE_GREETINGS — used
// only to enrich the textbook's chapter vocab so anchor lookups
// don't drop these basics on the floor.
const TEXTBOOK_EXTRAS = [
  { word: "何時", reading: "なんじ", gloss: "what time" },
  { word: "日本人", reading: "にほんじん", gloss: "Japanese person" },
  { word: "日本語", reading: "にほんご", gloss: "Japanese language" },
  { word: "寿司", reading: "すし", gloss: "sushi" },
];

// JLPT N5 starter textbook. Same pattern as the HSK 1 free pack:
// each lesson has a title, a pedagogical focus note, an original
// short reading body, and an `anchor` list of N5 headwords the
// lesson highlights. At build time the anchor words are looked up
// against the merged N5 + day-one source so the chapter's vocab
// list ships with the same readings + glosses as the bulk N5 deck —
// no hand-curation drift.
//
// Body texts use only N5 vocabulary + the day-one greetings so a
// brand-new student can read them. Polite ます-form throughout. ~80-
// 150 characters per lesson. Lesson order tracks the universal
// Genki/Minna no Nihongo/Tobira beginner curriculum without
// reproducing any one textbook's content.
const LESSONS = [
  {
    title: "Lesson 1 · はじめまして — Nice to meet you",
    notes: "Greetings and basic self-introduction. です sentences.",
    body: `はじめまして。\n私は田中です。\n学生です。\nどうぞよろしくお願いします。\n\nはじめまして。山田です。\nよろしくお願いします。`,
    anchor: ["はじめまして", "私", "学生", "よろしくお願いします", "どうぞ"],
  },
  {
    title: "Lesson 2 · これは何ですか — What is this",
    notes: "これ・それ・あれ・どれ. Identifying objects.",
    body: `これは何ですか。\nそれは本です。\nあれはペンですか。\nいいえ、あれは鉛筆です。\nどれが私の本ですか。\nこれがあなたの本です。`,
    anchor: ["これ", "それ", "あれ", "どれ", "何", "本", "ペン", "鉛筆"],
  },
  {
    title: "Lesson 3 · ここはどこですか — Where is this",
    notes: "ここ・そこ・あそこ. Asking about places.",
    body: `ここはどこですか。\nここは学校です。\nトイレはどこですか。\nトイレはあそこです。\n図書館はここですか。\nいいえ、図書館はあっちです。`,
    anchor: ["ここ", "そこ", "あそこ", "どこ", "学校", "図書館"],
  },
  {
    title: "Lesson 4 · 今、何時ですか — What time is it",
    notes: "Time, hours and minutes, daily schedule.",
    body: `今、何時ですか。\n今、八時です。\n何時に起きますか。\n七時に起きます。\n何時に寝ますか。\n十一時に寝ます。`,
    anchor: ["今", "何時", "起きる", "寝る", "～時"],
  },
  {
    title: "Lesson 5 · 何曜日に行きますか — What day do you go",
    notes: "Days of the week, particles に・で, transport.",
    body: `明日、学校に行きますか。\nはい、行きます。\n何曜日に行きますか。\n月曜日と水曜日に行きます。\n電車で行きますか。\nいいえ、バスで行きます。`,
    anchor: ["明日", "行く", "月曜日", "水曜日", "電車", "バス"],
  },
  {
    title: "Lesson 6 · 何を食べますか — What do you eat",
    notes: "を particle, ます-form for eating + drinking.",
    body: `今日、何を食べますか。\nラーメンを食べます。\n何を飲みますか。\nお茶を飲みます。\nおいしいですか。\nはい、とてもおいしいです。`,
    anchor: ["今日", "食べる", "飲む", "お茶", "美味しい", "とても"],
  },
  {
    title: "Lesson 7 · いくつありますか — How many are there",
    notes: "Counters: いくつ・何人. Existence with あります・います.",
    body: `本はいくつありますか。\n本は三つあります。\n人は何人いますか。\n五人います。\n猫もいますか。\nはい、猫が二匹います。`,
    anchor: ["いくつ", "在る", "居る", "人", "猫", "三つ", "五つ"],
  },
  {
    title: "Lesson 8 · 大きいですか、小さいですか — Big or small",
    notes: "い-adjectives. Describing things.",
    body: `この本は大きいですか。\nはい、とても大きいです。\nそれは新しいですか。\nいいえ、古いです。\n学校はどうですか。\n楽しいです。`,
    anchor: ["大きい", "小さい", "新しい", "古い", "楽しい"],
  },
  {
    title: "Lesson 9 · 何が欲しいですか — What do you want",
    notes: "欲しい and ~たい. Expressing wants.",
    body: `何が欲しいですか。\n新しい本が欲しいです。\n何を買いたいですか。\nお茶を買いたいです。\n今、お茶を飲みたいですか。\nはい、飲みたいです。`,
    anchor: ["欲しい", "買う", "新しい", "本"],
  },
  {
    title: "Lesson 10 · 教室に何がありますか — What's in the classroom",
    notes: "Existence and location: あります・います with に.",
    body: `教室に何がありますか。\n机と椅子があります。\n誰がいますか。\n先生がいます。\n学生もいますか。\nはい、学生もたくさんいます。`,
    anchor: ["教室", "机", "椅子", "先生", "学生", "沢山"],
  },
  {
    title: "Lesson 11 · 家族は何人ですか — How many in your family",
    notes: "Family terms, possession with の.",
    body: `家族は何人ですか。\n四人家族です。\n父と母と妹と私です。\nお兄さんはいますか。\nいいえ、いません。\n家族はみんな日本人です。`,
    anchor: ["家族", "父", "母", "妹", "兄", "日本人"],
  },
  {
    title: "Lesson 12 · 好きですか — Do you like it",
    notes: "が好きです・が嫌いです. Likes and dislikes.",
    body: `寿司が好きですか。\nはい、大好きです。\n何の音楽が好きですか。\nジャズが好きです。\n料理は好きですか。\nいいえ、あまり好きじゃありません。`,
    anchor: ["好き", "嫌い", "寿司", "音楽", "料理"],
  },
  {
    title: "Lesson 13 · 今、何をしていますか — What are you doing now",
    notes: "Te-form + ~ています. Ongoing actions.",
    body: `今、何をしていますか。\n本を読んでいます。\n家で何をしますか。\nテレビを見ます。\n寝る前に、お茶を飲みます。\n毎日、勉強しています。`,
    anchor: ["今", "読む", "家", "見る", "テレビ", "勉強"],
  },
  {
    title: "Lesson 14 · どちらが好きですか — Which do you prefer",
    notes: "Comparisons with ~の方が. でも.",
    body: `コーヒーとお茶と、どちらが好きですか。\nコーヒーの方が好きです。\n夏と冬と、どちらがいいですか。\n夏の方がいいです。\n日本語は難しいですか。\n少し難しいです。でも、楽しいです。`,
    anchor: ["どちら", "コーヒー", "夏", "冬", "日本語", "難しい", "少し"],
  },
  {
    title: "Lesson 15 · 昨日、何をしましたか — What did you do yesterday",
    notes: "Past tense ました. Talking about yesterday.",
    body: `昨日、何をしましたか。\n友達と映画を見ました。\nどうでしたか。\nとても面白かったです。\n晩ご飯は何を食べましたか。\n寿司を食べました。おいしかったです。`,
    anchor: ["昨日", "友達", "映画", "面白い", "晩御飯"],
  },
];

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchText(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

/** Naive CSV parser sufficient for the N5 source — it has quoted
 *  fields with embedded commas but no escaped quotes, no newlines
 *  inside quotes. */
function parseCSVLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

(async () => {
  console.log(`Fetching ${SOURCE_URL}…`);
  const csv = await fetchText(SOURCE_URL);
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const [header, ...rows] = lines;
  const cols = parseCSVLine(header);
  const idx = {
    expression: cols.indexOf("expression"),
    reading: cols.indexOf("reading"),
    meaning: cols.indexOf("meaning"),
  };
  if (idx.expression < 0 || idx.reading < 0 || idx.meaning < 0) {
    throw new Error(`Unexpected CSV header: ${header}`);
  }

  /** @type {{word:string, reading:string, gloss:string}[]} */
  const words = [];
  for (const line of rows) {
    const c = parseCSVLine(line);
    const expression = (c[idx.expression] || "").trim();
    const reading = (c[idx.reading] || "").trim();
    const meaning = (c[idx.meaning] || "").trim();
    if (!expression || !meaning) continue;
    // `expression` sometimes carries multiple kanji separated by ";"
    // ("足; 脚") — keep the first as the headword, drop the rest.
    const head = expression.split(";")[0].trim();
    words.push({ word: head, reading, gloss: meaning });
  }
  words.sort((a, b) =>
    a.reading.localeCompare(b.reading, "ja") || a.word.localeCompare(b.word, "ja"),
  );

  // Build sub-collection word lists by exact-headword filter.
  const subCollections = TOPICS.map((t) => {
    const matched = words.filter((w) => t.words.includes(w.word));
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      words: matched,
    };
  }).filter((c) => c.words.length > 0);

  // Headword → {reading, gloss} lookup, merging the three sources in
  // priority order:
  //   1. N5 vocab (jamsinclair) — canonical for words it covers.
  //   2. DAY_ONE_GREETINGS — pre-N5 hellos / thank-yous etc.
  //   3. TEXTBOOK_EXTRAS — universal beginner words tanos-era N5
  //      lists omit (日本語, 寿司, 何時, …). Hand-keyed.
  // Each lesson's anchor word list is resolved against this map at
  // build time so the textbook ships with reading/gloss data drawn
  // straight from the same source the bulk N5 deck uses — no
  // parallel hand-curation to drift.
  const lookup = new Map();
  for (const w of words) lookup.set(w.word, { reading: w.reading, gloss: w.gloss });
  for (const w of [...DAY_ONE_GREETINGS, ...TEXTBOOK_EXTRAS]) {
    if (!lookup.has(w.word)) {
      lookup.set(w.word, { reading: w.reading ?? "", gloss: w.gloss });
    }
  }

  const missingAnchors = new Set();
  const chapters = LESSONS.map((lesson, i) => {
    const vocab = [];
    for (const head of lesson.anchor) {
      const hit = lookup.get(head);
      if (!hit) {
        missingAnchors.add(`${head} (lesson ${i + 1})`);
        continue;
      }
      vocab.push({ word: head, reading: hit.reading || null, gloss: hit.gloss });
    }
    return {
      position: i,
      title: lesson.title,
      notes: lesson.notes,
      body: lesson.body,
      vocab,
    };
  });
  if (missingAnchors.size > 0) {
    console.warn(
      `[warn] ${missingAnchors.size} anchor words missing from N5 + day-one sources — ` +
        `dropping from chapter vocab:\n  ${[...missingAnchors].join("\n  ")}\n` +
        `Either add them to DAY_ONE_GREETINGS or rewrite the lesson to use words that exist.`,
    );
  }

  const pack = {
    schema: "tokori-pack/v1",
    id: "free:japanese-n5",
    name: "JLPT N5 vocabulary — Free",
    language: "ja",
    description:
      `${words.length} JLPT N5 vocabulary items in one drillable collection, ` +
      `plus thematic sub-decks (greetings, numbers, family, verbs, food) and a ` +
      `${chapters.length}-lesson starter textbook with short readings, focus notes, ` +
      `and per-chapter vocab. Vocab list courtesy of jamsinclair/open-anki-jlpt-decks ` +
      `(MIT) — Anki deck data originally sourced from tanos.co.uk; lesson texts ` +
      `written for Tokori.`,
    version: "1.0.0",
    license:
      "Vocabulary data: MIT (Jamie Sinclair, github.com/jamsinclair/open-anki-jlpt-decks). " +
      "Sub-collection grouping and lesson texts by Tokori. Free for everyone.",
    collections: [
      {
        id: "n5-day-one",
        name: "Japanese · Day-one greetings",
        description:
          "Pre-N5 hellos, thank-yous, and please/sorry — what you actually want to learn first.",
        words: DAY_ONE_GREETINGS,
      },
      {
        id: "n5-all",
        name: `JLPT N5 · all ${words.length} words`,
        description: "Every vocabulary item at JLPT Level 5 (the most basic level).",
        words,
      },
      ...subCollections,
    ],
    textbooks: [
      {
        id: "japanese-n5-starter",
        title: "JLPT N5 Starter — 15 lessons",
        author: "Tokori",
        totalUnits: chapters.length,
        unitLabel: "lessons",
        chapters,
      },
    ],
  };

  fs.writeFileSync(OUT, JSON.stringify(pack, null, 2) + "\n");
  console.log(
    `Wrote ${OUT}\n` +
      `  ${words.length} words · ${subCollections.length} sub-collections · ` +
      `${chapters.length} textbook chapters`,
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
