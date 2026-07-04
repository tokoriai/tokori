/**
 * Demo data seeder.
 *
 * When the app is loaded with `?demo=1` in the URL (i.e. the marketing site
 * iframe at /demo/), this module pre-fills the in-memory fallback store so
 * the visitor sees a populated app — workspace, vocab, chats, reader docs,
 * library entries — without ever touching their real data or the SQLite file.
 *
 * Only runs in non-Tauri mode. The desktop build never sees demo data.
 */

import { isTauri } from "@tauri-apps/api/core";
import * as db from "./db";

export const DEMO_FLAG = "demo";

export function isDemoRequested(): boolean {
  if (isTauri()) return false;
  if (typeof window === "undefined") return false;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has(DEMO_FLAG)) return true;
    // Also fire when the bundle is being served from a /demo/ path
    // — `npm run demo:build` copies the bundle under
    // `tokori-cloud/public/demo/`, and direct navigation to
    // `tokori.ai/demo` should produce the same seeded experience the
    // marketing iframe shows (which appends `?demo=1` explicitly).
    // Without this, hitting /demo directly drops the visitor into
    // the auth-gated cloud welcome screen.
    const path = url.pathname;
    if (path === "/demo" || path === "/demo/" || path.startsWith("/demo/")) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Seed the in-memory fallback store. Idempotent — calling it twice is a no-op.
 */
export async function seedDemoData(): Promise<void> {
  if (isTauri()) return;
  // Reach into the fallback store directly. db.ts exports its CRUD functions
  // and types, but the `fb` constant isn't exported — instead we use the
  // public APIs which all hit the in-memory store when isTauri() is false.

  // 0. Profile — give the demo a friendly placeholder name so the
  //    sidebar / dashboard greet the visitor with "Welcome back,
  //    Tokori" instead of an empty avatar. The profile-context
  //    reads this from the `profile.name` setting.
  await db.setSetting("profile.name", "Tokori");

  // Theme override: the marketing iframe is loaded with
  // `?theme=dark|light` matching the parent page's theme. Apply it
  // BOTH ways before React mounts:
  //   1. Set the `profile.theme` setting so ProfileProvider keeps
  //      the desktop's normal control flow consistent.
  //   2. Toggle `<html class="dark">` synchronously here so the
  //      first paint is already in the right palette — without this
  //      step the user sees a brief light-flash before
  //      ProfileProvider's effect runs.
  if (typeof window !== "undefined") {
    try {
      const params = new URLSearchParams(window.location.search);
      const theme = params.get("theme");
      if (theme === "dark" || theme === "light") {
        await db.setSetting("profile.theme", theme);
        const root = document.documentElement;
        root.classList.toggle("dark", theme === "dark");
        root.style.colorScheme = theme;
      }
    } catch {
      /* malformed URL — non-fatal */
    }
  }

  // Display: pinyin OFF by default in the demo. The bundled demo dict
  // doesn't always have readings aligned to multi-character words and
  // the ruby renders unevenly, which is more distracting than helpful
  // on first impression. Visitors can flip the PN toggle on if they
  // want to see it. Stored in localStorage because that's where
  // DisplayProvider reads from on mount; seed runs before the React
  // tree, so the very first render sees the off state.
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem("display.showPinyin", "0");
    } catch {
      /* private mode / quota — non-fatal */
    }
  }

  // 1. Workspace
  const ws = await db.createWorkspace({
    targetLang: "zh",
    nativeLang: "en",
    name: "Chinese · Demo",
  });

  // 2. Vocab — ~70 entries spread across the last 5 months so the
  //    growth chart on the dashboard climbs naturally instead of
  //    spiking on day 0. Words deliberately overlap with the chat /
  //    reader content seeded below so click-to-define hover-cards
  //    have hits AND each token in the chat picks up a coloured
  //    underline matching its review state. `daysAgo` distributes
  //    them roughly: bigger batches in earlier months (when the
  //    learner ramped up) tapering to recent intentional saves.
  const SECS_PER_DAY = 24 * 60 * 60;
  const NOW_S = Math.floor(Date.now() / 1000);
  type Seed = {
    word: string;
    reading: string;
    gloss: string;
    status: "mastered" | "review" | "learning" | "new";
    daysAgo: number;
  };
  const vocab: Seed[] = [
    // ─ 5 months ago: heavy intake during the initial burst
    { word: "你好", reading: "nǐ hǎo", gloss: "hello; hi", status: "mastered", daysAgo: 145 },
    { word: "谢谢", reading: "xiè xie", gloss: "thanks; thank you", status: "mastered", daysAgo: 145 },
    { word: "再见", reading: "zài jiàn", gloss: "goodbye", status: "mastered", daysAgo: 144 },
    { word: "我", reading: "wǒ", gloss: "I; me", status: "mastered", daysAgo: 143 },
    { word: "你", reading: "nǐ", gloss: "you", status: "mastered", daysAgo: 143 },
    { word: "他", reading: "tā", gloss: "he; him", status: "mastered", daysAgo: 142 },
    { word: "她", reading: "tā", gloss: "she; her", status: "mastered", daysAgo: 142 },
    { word: "是", reading: "shì", gloss: "to be", status: "mastered", daysAgo: 140 },
    { word: "不", reading: "bù", gloss: "not; no", status: "mastered", daysAgo: 138 },
    { word: "有", reading: "yǒu", gloss: "to have", status: "mastered", daysAgo: 137 },
    { word: "好", reading: "hǎo", gloss: "good; well", status: "mastered", daysAgo: 135 },
    { word: "中国", reading: "zhōng guó", gloss: "China", status: "mastered", daysAgo: 132 },
    { word: "中文", reading: "zhōng wén", gloss: "Chinese language", status: "mastered", daysAgo: 130 },
    // ─ 4 months ago
    { word: "学习", reading: "xué xí", gloss: "to study; learning", status: "mastered", daysAgo: 120 },
    { word: "今天", reading: "jīn tiān", gloss: "today", status: "mastered", daysAgo: 115 },
    { word: "明天", reading: "míng tiān", gloss: "tomorrow", status: "review", daysAgo: 112 },
    { word: "昨天", reading: "zuó tiān", gloss: "yesterday", status: "review", daysAgo: 110 },
    { word: "老师", reading: "lǎo shī", gloss: "teacher", status: "review", daysAgo: 108 },
    { word: "学生", reading: "xué shēng", gloss: "student", status: "review", daysAgo: 106 },
    { word: "朋友", reading: "péng you", gloss: "friend", status: "review", daysAgo: 100 },
    { word: "工作", reading: "gōng zuò", gloss: "work; job", status: "review", daysAgo: 98 },
    { word: "时间", reading: "shí jiān", gloss: "time", status: "review", daysAgo: 95 },
    { word: "桌子", reading: "zhuō zi", gloss: "table; desk", status: "review", daysAgo: 92 },
    { word: "书", reading: "shū", gloss: "book", status: "mastered", daysAgo: 90 },
    // ─ 3 months ago
    { word: "苹果", reading: "píng guǒ", gloss: "apple", status: "review", daysAgo: 82 },
    { word: "门", reading: "mén", gloss: "door", status: "review", daysAgo: 80 },
    { word: "妈妈", reading: "mā ma", gloss: "mom", status: "review", daysAgo: 78 },
    { word: "爸爸", reading: "bà ba", gloss: "dad", status: "review", daysAgo: 78 },
    { word: "家", reading: "jiā", gloss: "home; family", status: "review", daysAgo: 75 },
    { word: "吃", reading: "chī", gloss: "to eat", status: "mastered", daysAgo: 70 },
    { word: "喝", reading: "hē", gloss: "to drink", status: "review", daysAgo: 70 },
    { word: "去", reading: "qù", gloss: "to go", status: "mastered", daysAgo: 68 },
    { word: "来", reading: "lái", gloss: "to come", status: "review", daysAgo: 67 },
    { word: "做", reading: "zuò", gloss: "to do; to make", status: "review", daysAgo: 65 },
    { word: "喜欢", reading: "xǐ huan", gloss: "to like", status: "review", daysAgo: 60 },
    // ─ 2 months ago
    { word: "练习", reading: "liàn xí", gloss: "to practise", status: "review", daysAgo: 55 },
    { word: "什么", reading: "shén me", gloss: "what", status: "review", daysAgo: 52 },
    { word: "看", reading: "kàn", gloss: "to look; to read", status: "learning", daysAgo: 48 },
    { word: "听", reading: "tīng", gloss: "to listen", status: "learning", daysAgo: 47 },
    { word: "说", reading: "shuō", gloss: "to speak", status: "learning", daysAgo: 46 },
    { word: "读", reading: "dú", gloss: "to read", status: "learning", daysAgo: 45 },
    { word: "写", reading: "xiě", gloss: "to write", status: "learning", daysAgo: 45 },
    { word: "咖啡", reading: "kā fēi", gloss: "coffee", status: "learning", daysAgo: 42 },
    { word: "作业", reading: "zuò yè", gloss: "homework", status: "learning", daysAgo: 40 },
    { word: "房间", reading: "fáng jiān", gloss: "room", status: "learning", daysAgo: 38 },
    { word: "干净", reading: "gān jìng", gloss: "clean", status: "learning", daysAgo: 35 },
    // ─ 1 month ago
    { word: "打扫", reading: "dǎ sǎo", gloss: "to clean; to sweep", status: "learning", daysAgo: 28 },
    { word: "周末", reading: "zhōu mò", gloss: "weekend", status: "learning", daysAgo: 25 },
    { word: "上海", reading: "shàng hǎi", gloss: "Shanghai", status: "learning", daysAgo: 23 },
    { word: "高铁", reading: "gāo tiě", gloss: "high-speed rail", status: "learning", daysAgo: 22 },
    { word: "飞机", reading: "fēi jī", gloss: "airplane", status: "learning", daysAgo: 21 },
    { word: "外滩", reading: "wài tān", gloss: "the Bund", status: "new", daysAgo: 20 },
    { word: "夜景", reading: "yè jǐng", gloss: "night view", status: "new", daysAgo: 18 },
    { word: "南京路", reading: "nán jīng lù", gloss: "Nanjing Road", status: "new", daysAgo: 17 },
    { word: "希望", reading: "xī wàng", gloss: "to hope", status: "learning", daysAgo: 15 },
    { word: "听说", reading: "tīng shuō", gloss: "it's said; to hear", status: "learning", daysAgo: 14 },
    // ─ Last 2 weeks: recent saves, still new / learning
    { word: "因为", reading: "yīn wèi", gloss: "because", status: "learning", daysAgo: 12 },
    { word: "所以", reading: "suǒ yǐ", gloss: "therefore", status: "learning", daysAgo: 11 },
    { word: "可能", reading: "kě néng", gloss: "possible; might", status: "new", daysAgo: 10 },
    { word: "重要", reading: "zhòng yào", gloss: "important", status: "new", daysAgo: 8 },
    { word: "经验", reading: "jīng yàn", gloss: "experience", status: "new", daysAgo: 7 },
    { word: "决定", reading: "jué dìng", gloss: "to decide", status: "new", daysAgo: 5 },
    { word: "地道", reading: "dì dao", gloss: "authentic; genuine", status: "new", daysAgo: 4 },
    { word: "小笼包", reading: "xiǎo lóng bāo", gloss: "soup dumpling", status: "new", daysAgo: 3 },
    { word: "书店", reading: "shū diàn", gloss: "bookstore", status: "new", daysAgo: 2 },
    { word: "好看", reading: "hǎo kàn", gloss: "nice; good-looking", status: "new", daysAgo: 1 },
    // Words referenced in the seeded chat about the 把 construction —
    // mixed statuses so the chat shows multiple highlight colours.
    { word: "把", reading: "bǎ", gloss: "(disposal preposition); handle", status: "review", daysAgo: 50 },
    { word: "了", reading: "le", gloss: "(perfective particle)", status: "mastered", daysAgo: 100 },
    { word: "完", reading: "wán", gloss: "to finish; complete", status: "review", daysAgo: 60 },
    { word: "光", reading: "guāng", gloss: "light; only; up entirely", status: "learning", daysAgo: 30 },
    { word: "关上", reading: "guān shàng", gloss: "to close", status: "learning", daysAgo: 28 },
    { word: "做完", reading: "zuò wán", gloss: "to finish doing", status: "learning", daysAgo: 27 },
  ];
  // Capture each created vocab so we can replay realistic FSRS-ish
  // reviews against it below — that's what the dashboard's
  // Vocabulary Growth chart walks to compute Known / Learning /
  // Leeches over time.
  const vocabRows: { entry: typeof vocab[number]; id: number; createdAt: number }[] = [];
  for (const v of vocab) {
    const createdAt = NOW_S - v.daysAgo * SECS_PER_DAY;
    const row = await db.setVocabStatus({
      workspaceId: ws.id,
      word: v.word,
      reading: v.reading,
      gloss: v.gloss,
      status: v.status,
      createdAt,
    });
    vocabRows.push({ entry: v, id: row.id, createdAt });
  }

  // Replay a plausible review timeline per word so
  // `listWorkspaceReviews` returns rich history. Without this the
  // Vocabulary Growth chart's empty state ("Review some cards…")
  // never goes away — the chart needs at least one review event per
  // visible word to count anything as "Known".
  //
  // FSRS-shaped intervals: stability roughly doubles per "good", drops
  // to ~0.4× on "again". Picked deterministically (same `rand` seed
  // as the session generator) so the chart is reproducible.
  let revPrng = 0x243f6a88;
  const rrand = () => {
    revPrng = (revPrng * 1664525 + 1013904223) >>> 0;
    return revPrng / 0xffffffff;
  };
  // Target review counts by status. Mastered words have been reviewed
  // most; new words have at most one review (the initial grade).
  const REVIEWS_BY_STATUS = { mastered: 8, review: 5, learning: 3, new: 1 };
  const GRADES = ["good", "good", "good", "good", "easy", "hard", "again"] as const;
  type GradeT = (typeof GRADES)[number];
  for (const r of vocabRows) {
    const target = REVIEWS_BY_STATUS[r.entry.status];
    if (target <= 0) continue;
    let stability = 1; // days
    let difficulty = 5;
    let when = r.createdAt + 60; // first review just after creation
    let stepStatus: "new" | "learning" | "review" | "mastered" = "learning";
    for (let i = 0; i < target; i++) {
      const grade: GradeT = GRADES[Math.floor(rrand() * GRADES.length)];
      const factor =
        grade === "easy" ? 2.5 : grade === "good" ? 2.0 : grade === "hard" ? 1.3 : 0.45;
      stability = Math.max(0.5, stability * factor);
      difficulty = Math.min(10, Math.max(1, difficulty + (grade === "again" ? 0.6 : -0.1)));
      // Step status forward — matches what FSRS-real does loosely.
      if (grade === "again") stepStatus = "learning";
      else if (stability >= 21 && i >= 4) stepStatus = "mastered";
      else if (stability >= 5) stepStatus = "review";
      else stepStatus = "learning";
      const dueAt = when + Math.round(stability * SECS_PER_DAY);
      await db.reviewVocab({
        id: r.id,
        status: stepStatus,
        stability,
        difficulty,
        learningStep: stepStatus === "learning" ? Math.min(i, 2) : 0,
        dueAt,
        grade,
        reviewedAt: when,
      });
      // Next review lands roughly when the card was due, with a bit
      // of jitter so reviews don't all line up at integer day
      // boundaries.
      const jitter = (rrand() - 0.5) * SECS_PER_DAY * 0.4;
      when = Math.min(NOW_S - SECS_PER_DAY, dueAt + jitter);
      if (when >= NOW_S) break;
    }
    // Pin the final status to whatever the seed declared, so the
    // chart and the vocab list agree on this word's bucket.
    const last = vocabRows.find((x) => x.id === r.id);
    if (last) {
      const v = await db.lookupVocabBatch(ws.id, [r.entry.word]);
      const found = v.get(r.entry.word);
      if (found) found.status = r.entry.status;
    }
  }

  // 3. A chat with realistic tutor messages — Chinese-rich so click-to-define
  // is on display the moment the visitor opens the Conversation tab.
  const chat = await db.createChat(ws.id, "Why 把字句?");
  await db.addMessage({
    chatId: chat.id,
    role: "user",
    content: "Can you explain the 把 sentence pattern with an example?",
  });
  await db.addMessage({
    chatId: chat.id,
    role: "assistant",
    content:
      "The **把** construction (`把字句`) lets you bring the *thing acted on* to the front so you can focus on what happens to it.\n\n" +
      "Pattern:\n\n" +
      "**Subject + 把 + Object + Verb + (extra info)**\n\n" +
      "Compare:\n\n" +
      "- 我吃了苹果。 — *I ate the apple.* (neutral)\n" +
      "- 我把苹果吃了。 — *I ate up the apple.* (focus on what happened to the apple — it's gone)\n\n" +
      "It needs the verb to feel \"done to\" the object — so the verb usually has 了, 完, 给, or some result complement. " +
      "You wouldn't use it with feelings or perception verbs like 喜欢 or 看见.",
  });
  await db.addMessage({
    chatId: chat.id,
    role: "user",
    content: "Got it. Can you give me five 把 sentences to translate?",
  });
  await db.addMessage({
    chatId: chat.id,
    role: "assistant",
    content:
      "好的!试着翻译这五个句子 — hover any word for a quick definition:\n\n" +
      "1. 我把作业做完了。\n" +
      "2. 老师把书放在桌子上。\n" +
      "3. 你把门关上,好吗?\n" +
      "4. 他把咖啡喝光了。\n" +
      "5. 妈妈把房间打扫得很干净。\n\n" +
      "Notice the pattern: every one of these has a clear *result* on the object — 做完了, 放在桌子上, 关上, 喝光了, 打扫得很干净。 That's why 把 fits naturally.\n\n" +
      "When you're ready, paste your translations and I'll go through them.",
  });

  // 4. Reader doc.
  await db.saveReaderDoc({
    workspaceId: ws.id,
    title: "周末计划",
    body:
      "下个周末我打算去上海玩。\n\n" +
      "我和我朋友会一起坐高铁,因为飞机太贵了。\n" +
      "我们想去外滩看夜景,然后再去南京路买东西。\n" +
      "我也希望吃很多地道的小笼包!\n\n" +
      "如果有时间,我们还想去一家小书店,听说那里有很多很好看的中文书。",
  });

  // 5. Library — a textbook with chapters and an active video.
  const tb = await db.saveLibraryItem({
    workspaceId: ws.id,
    kind: "textbook",
    title: "New Practical Chinese Reader 1",
    author: "Liu Xun",
    totalUnits: 14,
    unitLabel: "chapters",
    completedUnits: 4,
    status: "active",
  });
  const chapters = [
    "Lesson 1 — 你好",
    "Lesson 2 — 你忙吗?",
    "Lesson 3 — 她是哪国人?",
    "Lesson 4 — 认识你很高兴",
    "Lesson 5 — 餐厅在哪儿?",
    "Lesson 6 — 我们去游泳,好吗?",
  ];
  for (let i = 0; i < chapters.length; i++) {
    await db.createChapter({
      itemId: tb.id,
      title: chapters[i],
      position: i,
    });
  }
  // Mark the first 4 as done.
  const all = await db.listChapters(tb.id);
  for (const c of all.slice(0, 4)) {
    await db.updateChapter(c.id, { completedAt: Math.floor(Date.now() / 1000) - 86400 });
  }

  await db.saveLibraryItem({
    workspaceId: ws.id,
    kind: "video",
    title: "Slow Chinese Podcast — Episode 12: 中国的茶文化",
    unitLabel: "minutes",
    totalSeconds: 22 * 60,
    status: "active",
  });

  // 6. Notes — a couple of grammar finds.
  await db.createNote({
    workspaceId: ws.id,
    title: "了 — completion vs change",
    body:
      "Two distinct functions:\n\n" +
      "1. **Verb + 了** = completed action (吃了 = ate)\n" +
      "2. **Sentence-final 了** = change of state / new info (我饿了 = I'm hungry now)\n\n" +
      "Don't conflate. Both can appear in one sentence: 我吃了三个饺子了 = I've eaten three dumplings (and I'm signalling that's the latest count).",
  });
  await db.createNote({
    workspaceId: ws.id,
    title: "Tone sandhi: 不",
    body:
      "不 (bù) becomes bú when followed by another 4th tone:\n\n" +
      "- 不是 → bú shì\n" +
      "- 不要 → bú yào\n" +
      "- 不去 → bú qù\n\n" +
      "This is automatic — pinyin in dictionaries usually keeps the lexical tone (bù), but you should pronounce it as bú in those cases.",
  });

  // 7. Five months of study sessions. Generated procedurally so the
  //    heatmap fills out, the skills radar has volume, and the streak
  //    math stays plausible — most days hit, a sprinkle of skipped
  //    days, intensity slightly higher near the present. Each kind
  //    has its own preferred frequency so the radar isn't a perfect
  //    pentagon: reading + chat dominate, listening is steady,
  //    writing is occasional, review is most days.
  const KINDS = ["chat", "review", "reading", "writing", "listening"] as const;
  type Kind = (typeof KINDS)[number];
  // Per-kind probability of appearing on a given day, plus a typical
  // duration window. Tuned so totals feel like a serious-but-realistic
  // learner: ~6h/week.
  const KIND_PROFILE: Record<Kind, { p: number; minMin: number; maxMin: number }> = {
    review: { p: 0.85, minMin: 6, maxMin: 14 },
    reading: { p: 0.55, minMin: 12, maxMin: 30 },
    chat: { p: 0.45, minMin: 14, maxMin: 35 },
    listening: { p: 0.4, minMin: 10, maxMin: 28 },
    writing: { p: 0.25, minMin: 10, maxMin: 22 },
  };
  // Deterministic PRNG so every demo render shows the same
  // dashboard. Seed the value, never `Math.random()` — otherwise the
  // heatmap reshuffles on every reload and screenshots are unstable.
  let prngState = 0x9e3779b9;
  const rand = (): number => {
    prngState = (prngState * 1664525 + 1013904223) >>> 0;
    return prngState / 0xffffffff;
  };
  const pickHour = () => 8 + Math.floor(rand() * 13); // 8-20 local time
  const pickMinutes = (k: Kind) => {
    const p = KIND_PROFILE[k];
    return p.minMin + Math.floor(rand() * (p.maxMin - p.minMin + 1));
  };
  const TOTAL_DAYS = 150; // ~5 months
  for (let d = TOTAL_DAYS; d >= 0; d--) {
    // 12% of days are skipped so the heatmap has gaps and longest-streak
    // is meaningfully different from current-streak.
    if (rand() < 0.12) continue;
    for (const kind of KINDS) {
      const profile = KIND_PROFILE[kind];
      // Slightly higher session probability close to the present so
      // the chart visually trends up — matches a learner who's
      // building momentum.
      const recencyBoost = 1 + (TOTAL_DAYS - d) / TOTAL_DAYS / 2;
      if (rand() > profile.p * recencyBoost) continue;
      const hour = pickHour();
      const when = NOW_S - d * SECS_PER_DAY + (hour - 12) * 3600;
      await db.logSession({
        workspaceId: ws.id,
        kind,
        durationSecs: pickMinutes(kind) * 60,
        when,
      });
    }
  }

  // 8. Goal — vocab target so the goals card has something to show.
  await db.createGoal({
    workspaceId: ws.id,
    title: "Reach 200 known words by spring",
    kind: "vocab",
    target: 200,
    deadline: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90,
  });

  // 9. A mock provider so the chat top-bar dropdown isn't empty. The demo
  //    chat goes through `mockReply` when isTauri() is false, so this provider
  //    never gets called for real — its model name is just for show.
  const provider = await db.saveProvider({
    kind: "ollama",
    label: "Demo (mock)",
    model: "demo-tutor",
    host: "http://localhost:0",
    isDefault: true,
  });
  // ProviderConfigProvider reads the active id from settings. Persist there.
  await db.setSetting("providers.activeId", String(provider.id));

  // 10. Install a chunky dictionary so click-to-define + per-character ruby
  //     pinyin work over every word in the seeded chat / reader / vocab. The
  //     desktop app's bundled cedict-mini only has ~50 entries; the dict
  //     installed here gets us to a few hundred and covers everything in the
  //     demo content. Real users install full CC-CEDICT from Settings.
  await db.installDictionary({
    lang: "zh",
    name: "Demo dictionary",
    entries: DEMO_DICT_ENTRIES,
  });

  // 11. Default collection + a curated one.
  const defaultColl = await db.getOrCreateDefaultCollection(ws.id);
  await db.bulkAddToCollection({
    workspaceId: ws.id,
    collectionId: defaultColl.id,
    words: vocab.map((v) => ({ word: v.word, reading: v.reading, gloss: v.gloss })),
  });
  const hsk2 = await db.createCollection({
    workspaceId: ws.id,
    name: "HSK 2 sample",
    description: "First few rows from the HSK 2 starter pack.",
    source: "preset",
    presetId: "hsk-2",
  });
  await db.bulkAddToCollection({
    workspaceId: ws.id,
    collectionId: hsk2.id,
    words: [
      { word: "因为", reading: "yīn wèi", gloss: "because" },
      { word: "所以", reading: "suǒ yǐ", gloss: "therefore" },
      { word: "可能", reading: "kě néng", gloss: "possible; might" },
      { word: "重要", reading: "zhòng yào", gloss: "important" },
      { word: "经验", reading: "jīng yàn", gloss: "experience" },
    ],
  });
}

/**
 * A small CC-CEDICT-shaped corpus — covers everything the demo content
 * references, plus enough common surrounding vocabulary that hover-cards land
 * naturally when a visitor experiments. Format mirrors what installDictionary
 * stores: word, altWord (traditional, mostly ""), reading (pinyin), gloss.
 */
const DEMO_DICT_ENTRIES: { word: string; altWord: string | null; reading: string; gloss: string }[] = [
  // Multi-char words first — Tokenized prefers longer matches via jieba.
  { word: "你好", altWord: "", reading: "nǐ hǎo", gloss: "hello; hi" },
  { word: "再见", altWord: "", reading: "zài jiàn", gloss: "goodbye" },
  { word: "谢谢", altWord: "", reading: "xiè xie", gloss: "thanks; thank you" },
  { word: "学习", altWord: "", reading: "xué xí", gloss: "to study; learning" },
  { word: "练习", altWord: "", reading: "liàn xí", gloss: "to practise; exercise" },
  { word: "朋友", altWord: "", reading: "péng you", gloss: "friend" },
  { word: "时间", altWord: "", reading: "shí jiān", gloss: "time" },
  { word: "工作", altWord: "", reading: "gōng zuò", gloss: "work; job" },
  { word: "中文", altWord: "", reading: "zhōng wén", gloss: "Chinese language" },
  { word: "中国", altWord: "", reading: "zhōng guó", gloss: "China" },
  { word: "今天", altWord: "", reading: "jīn tiān", gloss: "today" },
  { word: "明天", altWord: "", reading: "míng tiān", gloss: "tomorrow" },
  { word: "昨天", altWord: "", reading: "zuó tiān", gloss: "yesterday" },
  { word: "因为", altWord: "", reading: "yīn wèi", gloss: "because" },
  { word: "所以", altWord: "", reading: "suǒ yǐ", gloss: "therefore; so" },
  { word: "可能", altWord: "", reading: "kě néng", gloss: "possible; might" },
  { word: "重要", altWord: "", reading: "zhòng yào", gloss: "important" },
  { word: "经验", altWord: "", reading: "jīng yàn", gloss: "experience" },
  { word: "老师", altWord: "", reading: "lǎo shī", gloss: "teacher" },
  { word: "学生", altWord: "", reading: "xué shēng", gloss: "student" },
  { word: "什么", altWord: "", reading: "shén me", gloss: "what" },
  { word: "喜欢", altWord: "", reading: "xǐ huan", gloss: "to like" },
  { word: "看见", altWord: "", reading: "kàn jiàn", gloss: "to see" },
  { word: "苹果", altWord: "", reading: "píng guǒ", gloss: "apple" },
  { word: "桌子", altWord: "", reading: "zhuō zi", gloss: "table; desk" },
  { word: "作业", altWord: "", reading: "zuò yè", gloss: "homework" },
  { word: "做完", altWord: "", reading: "zuò wán", gloss: "to finish doing" },
  { word: "做完了", altWord: "", reading: "zuò wán le", gloss: "finished doing" },
  { word: "放在", altWord: "", reading: "fàng zài", gloss: "to place at" },
  { word: "关上", altWord: "", reading: "guān shàng", gloss: "to close (a door etc.)" },
  { word: "咖啡", altWord: "", reading: "kā fēi", gloss: "coffee" },
  { word: "喝光", altWord: "", reading: "hē guāng", gloss: "to drink up entirely" },
  { word: "妈妈", altWord: "", reading: "mā ma", gloss: "mom; mother" },
  { word: "房间", altWord: "", reading: "fáng jiān", gloss: "room" },
  { word: "打扫", altWord: "", reading: "dǎ sǎo", gloss: "to clean; to sweep" },
  { word: "干净", altWord: "", reading: "gān jìng", gloss: "clean" },
  { word: "周末", altWord: "", reading: "zhōu mò", gloss: "weekend" },
  { word: "下个", altWord: "", reading: "xià ge", gloss: "next" },
  { word: "上海", altWord: "", reading: "shàng hǎi", gloss: "Shanghai" },
  { word: "高铁", altWord: "", reading: "gāo tiě", gloss: "high-speed rail" },
  { word: "飞机", altWord: "", reading: "fēi jī", gloss: "airplane" },
  { word: "外滩", altWord: "", reading: "wài tān", gloss: "the Bund (Shanghai)" },
  { word: "夜景", altWord: "", reading: "yè jǐng", gloss: "night view" },
  { word: "南京路", altWord: "", reading: "nán jīng lù", gloss: "Nanjing Road" },
  { word: "东西", altWord: "", reading: "dōng xi", gloss: "thing(s)" },
  { word: "地道", altWord: "", reading: "dì dao", gloss: "authentic; genuine" },
  { word: "小笼包", altWord: "", reading: "xiǎo lóng bāo", gloss: "soup dumpling" },
  { word: "书店", altWord: "", reading: "shū diàn", gloss: "bookstore" },
  { word: "好看", altWord: "", reading: "hǎo kàn", gloss: "good-looking; nice" },
  { word: "希望", altWord: "", reading: "xī wàng", gloss: "to hope; hope" },
  { word: "听说", altWord: "", reading: "tīng shuō", gloss: "to hear; it's said" },
  { word: "决定", altWord: "", reading: "jué dìng", gloss: "to decide" },
  { word: "天气", altWord: "", reading: "tiān qì", gloss: "weather" },
  { word: "公园", altWord: "", reading: "gōng yuán", gloss: "park" },
  { word: "散步", altWord: "", reading: "sàn bù", gloss: "to take a walk" },
  { word: "跑步", altWord: "", reading: "pǎo bù", gloss: "to run; jogging" },
  { word: "长椅", altWord: "", reading: "cháng yǐ", gloss: "bench" },
  { word: "聊天", altWord: "", reading: "liáo tiān", gloss: "to chat" },
  { word: "下个月", altWord: "", reading: "xià ge yuè", gloss: "next month" },
  { word: "北京", altWord: "", reading: "běi jīng", gloss: "Beijing" },
  { word: "羡慕", altWord: "", reading: "xiàn mù", gloss: "to envy" },
  { word: "高兴", altWord: "", reading: "gāo xìng", gloss: "happy; glad" },

  // Single-char characters used by the seeded sentences. Listed AFTER the
  // multi-char entries so longer matches are preferred when both apply.
  { word: "你", altWord: "", reading: "nǐ", gloss: "you" },
  { word: "好", altWord: "", reading: "hǎo", gloss: "good; well" },
  { word: "我", altWord: "", reading: "wǒ", gloss: "I; me" },
  { word: "他", altWord: "", reading: "tā", gloss: "he; him" },
  { word: "她", altWord: "", reading: "tā", gloss: "she; her" },
  { word: "是", altWord: "", reading: "shì", gloss: "to be" },
  { word: "的", altWord: "", reading: "de", gloss: "(possessive / modifier particle)" },
  { word: "把", altWord: "", reading: "bǎ", gloss: "(disposal preposition); handle" },
  { word: "了", altWord: "", reading: "le", gloss: "(perfective / change-of-state particle)" },
  { word: "在", altWord: "", reading: "zài", gloss: "at; in; to be (located) at" },
  { word: "要", altWord: "", reading: "yào", gloss: "to want; will" },
  { word: "想", altWord: "", reading: "xiǎng", gloss: "to want; to think; to miss" },
  { word: "去", altWord: "", reading: "qù", gloss: "to go" },
  { word: "来", altWord: "", reading: "lái", gloss: "to come" },
  { word: "做", altWord: "", reading: "zuò", gloss: "to do; to make" },
  { word: "吃", altWord: "", reading: "chī", gloss: "to eat" },
  { word: "喝", altWord: "", reading: "hē", gloss: "to drink" },
  { word: "看", altWord: "", reading: "kàn", gloss: "to look; to watch; to read" },
  { word: "听", altWord: "", reading: "tīng", gloss: "to listen" },
  { word: "说", altWord: "", reading: "shuō", gloss: "to speak; to say" },
  { word: "读", altWord: "", reading: "dú", gloss: "to read" },
  { word: "写", altWord: "", reading: "xiě", gloss: "to write" },
  { word: "学", altWord: "", reading: "xué", gloss: "to study; to learn" },
  { word: "玩", altWord: "", reading: "wán", gloss: "to play" },
  { word: "买", altWord: "", reading: "mǎi", gloss: "to buy" },
  { word: "卖", altWord: "", reading: "mài", gloss: "to sell" },
  { word: "给", altWord: "", reading: "gěi", gloss: "to give; for" },
  { word: "完", altWord: "", reading: "wán", gloss: "complete; finish" },
  { word: "请", altWord: "", reading: "qǐng", gloss: "please; to invite" },
  { word: "问", altWord: "", reading: "wèn", gloss: "to ask" },
  { word: "叫", altWord: "", reading: "jiào", gloss: "to be called" },
  { word: "坐", altWord: "", reading: "zuò", gloss: "to sit" },
  { word: "站", altWord: "", reading: "zhàn", gloss: "to stand; station" },
  { word: "走", altWord: "", reading: "zǒu", gloss: "to walk; to leave" },
  { word: "跑", altWord: "", reading: "pǎo", gloss: "to run" },
  { word: "苹", altWord: "", reading: "píng", gloss: "apple (in 苹果)" },
  { word: "果", altWord: "", reading: "guǒ", gloss: "fruit; result" },
  { word: "书", altWord: "", reading: "shū", gloss: "book" },
  { word: "门", altWord: "", reading: "mén", gloss: "door" },
  { word: "桌", altWord: "", reading: "zhuō", gloss: "table" },
  { word: "子", altWord: "", reading: "zi", gloss: "(noun suffix); child" },
  { word: "上", altWord: "", reading: "shàng", gloss: "on; up; above" },
  { word: "下", altWord: "", reading: "xià", gloss: "under; down; below" },
  { word: "里", altWord: "", reading: "lǐ", gloss: "inside" },
  { word: "外", altWord: "", reading: "wài", gloss: "outside" },
  { word: "光", altWord: "", reading: "guāng", gloss: "light; only" },
  { word: "关", altWord: "", reading: "guān", gloss: "to close" },
  { word: "扫", altWord: "", reading: "sǎo", gloss: "to sweep; to clean" },
  { word: "打", altWord: "", reading: "dǎ", gloss: "to hit; to do" },
  { word: "得", altWord: "", reading: "dé", gloss: "to get; (complement marker)" },
  { word: "不", altWord: "", reading: "bù", gloss: "not; no" },
  { word: "也", altWord: "", reading: "yě", gloss: "also; too" },
  { word: "和", altWord: "", reading: "hé", gloss: "and; with" },
  { word: "都", altWord: "", reading: "dōu", gloss: "all; both" },
  { word: "很", altWord: "", reading: "hěn", gloss: "very" },
  { word: "有", altWord: "", reading: "yǒu", gloss: "to have; there is" },
  { word: "没", altWord: "", reading: "méi", gloss: "not (have)" },
  { word: "会", altWord: "", reading: "huì", gloss: "will; can; be able to" },
  { word: "可", altWord: "", reading: "kě", gloss: "can; may" },
  { word: "以", altWord: "", reading: "yǐ", gloss: "with; by" },
  { word: "因", altWord: "", reading: "yīn", gloss: "because; cause" },
  { word: "为", altWord: "", reading: "wèi", gloss: "for; on behalf of" },
  { word: "所", altWord: "", reading: "suǒ", gloss: "place; (relative particle)" },
  { word: "这", altWord: "", reading: "zhè", gloss: "this" },
  { word: "那", altWord: "", reading: "nà", gloss: "that" },
  { word: "什", altWord: "", reading: "shén", gloss: "what" },
  { word: "么", altWord: "", reading: "me", gloss: "(question suffix)" },
  { word: "吗", altWord: "", reading: "ma", gloss: "(yes/no question particle)" },
  { word: "呢", altWord: "", reading: "ne", gloss: "(question / follow-up particle)" },
  { word: "啊", altWord: "", reading: "a", gloss: "(exclamation particle)" },
  { word: "今", altWord: "", reading: "jīn", gloss: "now; today" },
  { word: "天", altWord: "", reading: "tiān", gloss: "day; sky; heaven" },
  { word: "明", altWord: "", reading: "míng", gloss: "bright; clear; tomorrow" },
  { word: "周", altWord: "", reading: "zhōu", gloss: "week; cycle" },
  { word: "末", altWord: "", reading: "mò", gloss: "end" },
  { word: "月", altWord: "", reading: "yuè", gloss: "month; moon" },
  { word: "年", altWord: "", reading: "nián", gloss: "year" },
  { word: "时", altWord: "", reading: "shí", gloss: "time; hour" },
  { word: "间", altWord: "", reading: "jiān", gloss: "between; room" },
  { word: "高", altWord: "", reading: "gāo", gloss: "tall; high" },
  { word: "兴", altWord: "", reading: "xìng", gloss: "interest; mood (in 高兴)" },
  { word: "妈", altWord: "", reading: "mā", gloss: "mom" },
  { word: "爸", altWord: "", reading: "bà", gloss: "dad" },
  { word: "家", altWord: "", reading: "jiā", gloss: "home; family" },
  { word: "人", altWord: "", reading: "rén", gloss: "person" },
  { word: "中", altWord: "", reading: "zhōng", gloss: "middle; China" },
  { word: "国", altWord: "", reading: "guó", gloss: "country" },
  { word: "城", altWord: "", reading: "chéng", gloss: "city; wall" },
  { word: "市", altWord: "", reading: "shì", gloss: "city; market" },
  { word: "店", altWord: "", reading: "diàn", gloss: "shop" },
  { word: "茶", altWord: "", reading: "chá", gloss: "tea" },
  { word: "水", altWord: "", reading: "shuǐ", gloss: "water" },
  { word: "饭", altWord: "", reading: "fàn", gloss: "rice; meal" },
  { word: "钱", altWord: "", reading: "qián", gloss: "money" },
  { word: "贵", altWord: "", reading: "guì", gloss: "expensive" },
  { word: "便", altWord: "", reading: "pián", gloss: "cheap (in 便宜)" },
  { word: "宜", altWord: "", reading: "yí", gloss: "suitable (in 便宜)" },
  { word: "太", altWord: "", reading: "tài", gloss: "too; very" },
  { word: "对", altWord: "", reading: "duì", gloss: "correct; right" },
  { word: "错", altWord: "", reading: "cuò", gloss: "wrong; mistake" },
  { word: "知", altWord: "", reading: "zhī", gloss: "to know" },
  { word: "道", altWord: "", reading: "dào", gloss: "road; way; principle" },
  { word: "地", altWord: "", reading: "dì", gloss: "ground; earth" },
  { word: "认", altWord: "", reading: "rèn", gloss: "to recognise" },
  { word: "识", altWord: "", reading: "shí", gloss: "to know; recognise" },
  { word: "话", altWord: "", reading: "huà", gloss: "speech; words" },
  { word: "电", altWord: "", reading: "diàn", gloss: "electric" },
  { word: "影", altWord: "", reading: "yǐng", gloss: "shadow; movie" },
  { word: "听说", altWord: "", reading: "tīng shuō", gloss: "to hear (it said)" },
  { word: "回", altWord: "", reading: "huí", gloss: "to return; (measure word)" },
];

