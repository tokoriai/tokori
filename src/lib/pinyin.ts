// Small pinyin helper. CC-CEDICT stores pinyin as numeric ("ni3 hao3", "nu:3"
// for ǚ); the bundled mini stores it tone-marked already. This normalises both
// to a list of {pretty, tone} so the UI can colour syllables by tone.

export type PinyinSyllable = { pretty: string; tone: number };

const TONE_MARKS: Record<string, string[]> = {
  // index = tone (0..5 — 0 means "no mark")
  a: ["a", "ā", "á", "ǎ", "à", "a"],
  e: ["e", "ē", "é", "ě", "è", "e"],
  i: ["i", "ī", "í", "ǐ", "ì", "i"],
  o: ["o", "ō", "ó", "ǒ", "ò", "o"],
  u: ["u", "ū", "ú", "ǔ", "ù", "u"],
  "ü": ["ü", "ǖ", "ǘ", "ǚ", "ǜ", "ü"],
};

function findVowelIndex(lower: string): number {
  if (lower.includes("a")) return lower.indexOf("a");
  if (lower.includes("e")) return lower.indexOf("e");
  if (lower.includes("o")) return lower.indexOf("o");
  for (let i = lower.length - 1; i >= 0; i--) {
    if ("iuü".includes(lower[i])) return i;
  }
  return -1;
}

function applyToneMark(body: string, tone: number): string {
  // CC-CEDICT uses 'u:' for ü; some dumps use 'v'. Normalise both.
  const normalised = body.replace(/u:/g, "ü").replace(/U:/g, "Ü").replace(/v/g, "ü").replace(/V/g, "Ü");
  if (tone < 1 || tone > 5) return normalised;
  const lower = normalised.toLowerCase();
  const idx = findVowelIndex(lower);
  if (idx === -1) return normalised;
  const ch = normalised[idx];
  const lc = ch.toLowerCase();
  const marked = TONE_MARKS[lc]?.[tone];
  if (!marked) return normalised;
  const final = ch === lc ? marked : marked.toUpperCase();
  return normalised.slice(0, idx) + final + normalised.slice(idx + 1);
}

const TONE_MARK_TO_TONE = new Map<string, number>([
  ["ā", 1], ["ē", 1], ["ī", 1], ["ō", 1], ["ū", 1], ["ǖ", 1],
  ["á", 2], ["é", 2], ["í", 2], ["ó", 2], ["ú", 2], ["ǘ", 2],
  ["ǎ", 3], ["ě", 3], ["ǐ", 3], ["ǒ", 3], ["ǔ", 3], ["ǚ", 3],
  ["à", 4], ["è", 4], ["ì", 4], ["ò", 4], ["ù", 4], ["ǜ", 4],
]);

function detectToneFromMarks(syllable: string): number {
  for (const ch of syllable) {
    const t = TONE_MARK_TO_TONE.get(ch);
    if (t) return t;
  }
  return 5; // neutral
}

// Toneless Hanyu Pinyin syllables (ü normalised to plain "u"). The
// segmenter below only uses this set to find syllable BOUNDARIES — the
// u/ü distinction never moves a boundary, so it's folded away here while
// the original spelling (tone marks and all) is preserved in the slices
// the segmenter returns. Missing a rare syllable just means that chunk
// stays un-split (graceful: same as the old whitespace-only behaviour).
const PINYIN_SYLLABLES: ReadonlySet<string> = new Set(
  (
    "a o e ai ei ao ou an en ang eng er " +
    "yi ya ye yao you yan yin yang ying yong yu yue yuan yun yo " +
    "wu wa wo wai wei wan wen wang weng " +
    "ba bo bai bei bao ban ben bang beng bi bie biao bian bin bing bu " +
    "pa po pai pei pao pou pan pen pang peng pi pie piao pian pin ping pu " +
    "ma mo me mai mei mao mou man men mang meng mi mie miao miu mian min ming mu " +
    "fa fo fei fou fan fen fang feng fu " +
    "da de dai dei dao dou dan den dang deng dong di die diao diu dian ding du duo dui duan dun " +
    "ta te tai tao tou tan tang teng tong ti tie tiao tian ting tu tuo tui tuan tun " +
    "na ne nai nei nao nou nan nen nang neng nong ni nie niao niu nian nin niang ning nu nuo nuan nun nue " +
    "la lo le lai lei lao lou lan lang leng long li lia lie liao liu lian lin liang ling lu luo luan lun lue " +
    "ga ge gai gei gao gou gan gen gang geng gong gu gua guo guai gui guan gun guang " +
    "ka ke kai kei kao kou kan ken kang keng kong ku kua kuo kuai kui kuan kun kuang " +
    "ha he hai hei hao hou han hen hang heng hong hu hua huo huai hui huan hun huang " +
    "ji jia jie jiao jiu jian jin jiang jing jiong ju jue juan jun " +
    "qi qia qie qiao qiu qian qin qiang qing qiong qu que quan qun " +
    "xi xia xie xiao xiu xian xin xiang xing xiong xu xue xuan xun " +
    "zha zhe zhi zhai zhei zhao zhou zhan zhen zhang zheng zhong zhu zhua zhuo zhuai zhui zhuan zhun zhuang " +
    "cha che chi chai chao chou chan chen chang cheng chong chu chua chuo chuai chui chuan chun chuang " +
    "sha she shi shai shei shao shou shan shen shang sheng shu shua shuo shuai shui shuan shun shuang " +
    "re ri rao rou ran ren rang reng rong ru rua ruo rui ruan run " +
    "za ze zi zai zei zao zou zan zen zang zeng zong zu zuo zui zuan zun " +
    "ca ce ci cai cao cou can cen cang ceng cong cu cuo cui cuan cun " +
    "sa se si sai sao sou san sen sang seng song su suo sui suan sun"
  ).split(" "),
);

// Longest pinyin syllable is 6 letters ("zhuang", "chuang", "shuang").
const MAX_SYLLABLE_LEN = 6;

/** Fold a chunk to lowercase, tone-less, digit-less ASCII letters for
 *  boundary-finding, keeping `map[i]` = the source index in `chunk` that
 *  produced `bare[i]`. Tone digits, `u:` colons and stray combining
 *  marks are dropped (they ride along with their syllable when we slice
 *  the original back out). */
function bareFold(chunk: string): { bare: string; map: number[] } {
  const bare: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < chunk.length; i++) {
    let base = chunk[i]
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}+/gu, "");
    if (base === "v") base = "u"; // ü written as v
    if (!/^[a-z]$/.test(base)) continue; // tone digit, ':', stray mark
    bare.push(base);
    map.push(i);
  }
  return { bare: bare.join(""), map };
}

/** Find the fewest-syllable full segmentation of a folded chunk, or null
 *  when it doesn't decompose into known syllables. Greedy longest-first
 *  (so "xian" stays one syllable, not "xi"+"an") with backtracking (so
 *  "fanguan" recovers "fan"+"guan" after "fang" dead-ends). Returns the
 *  start index of each syllable within `bare`. */
function segmentBare(bare: string): number[] | null {
  const n = bare.length;
  if (n === 0 || n > 24) return null; // cap pathological backtracking
  const dead = new Set<number>();
  const starts: number[] = [];
  const solve = (pos: number): boolean => {
    if (pos === n) return true;
    if (dead.has(pos)) return false;
    const maxLen = Math.min(MAX_SYLLABLE_LEN, n - pos);
    for (let len = maxLen; len >= 1; len--) {
      if (!PINYIN_SYLLABLES.has(bare.slice(pos, pos + len))) continue;
      starts.push(pos);
      if (solve(pos + len)) return true;
      starts.pop();
    }
    dead.add(pos);
    return false;
  };
  return solve(0) ? [...starts] : null;
}

/** Split a pinyin reading into one string per syllable, tone marks and
 *  numbers preserved. Splits on the usual hard boundaries (whitespace,
 *  apostrophe, middle dot) AND syllabifies spaceless runs so a reading a
 *  learner typed as "nǐhǎo" or "ce4shi4" lines up one syllable per hanzi
 *  for the ruby rail. CC-CEDICT readings already carry spaces, so each
 *  chunk is a single syllable and passes through untouched; anything that
 *  isn't pinyin (kana, lemmas) fails to decompose and is left as-is. */
export function splitPinyinSyllables(raw: string): string[] {
  const out: string[] = [];
  for (const chunk of raw.trim().split(/[\s'’ʼ·]+/)) {
    if (!chunk) continue;
    const { bare, map } = bareFold(chunk);
    const starts = bare.length > 1 ? segmentBare(bare) : null;
    if (!starts || starts.length < 2) {
      out.push(chunk);
      continue;
    }
    for (let k = 0; k < starts.length; k++) {
      const from = map[starts[k]];
      const to = k + 1 < starts.length ? map[starts[k + 1]] : chunk.length;
      out.push(chunk.slice(from, to));
    }
  }
  return out;
}

export function parsePinyin(raw: string | null | undefined): PinyinSyllable[] {
  if (!raw) return [];
  return splitPinyinSyllables(raw).map((syl) => {
    const numeric = syl.match(/^([A-Za-z:üÜ]+)([1-5])$/);
    if (numeric) {
      const [, body, toneStr] = numeric;
      const tone = Number(toneStr);
      return { pretty: applyToneMark(body, tone), tone };
    }
    // already tone-marked
    return { pretty: syl, tone: detectToneFromMarks(syl) };
  });
}

export function prettyPinyin(raw: string | null | undefined): string {
  return parsePinyin(raw)
    .map((s) => s.pretty)
    .join(" ");
}

type SyllableParts = { body: string; tone: number };

/** Parse a stored pinyin reading into per-syllable {body, tone}.
 *  Accepts CC-CEDICT numeric ("ni3 hao3") and tone-marked ("nǐ hǎo")
 *  forms; body normalises to toneless ASCII so `applyToneMark` can
 *  round-trip a permuted variant. Internal helper for `readingKey`
 *  and `tonePermutedReadings`. */
function parseSyllableParts(reading: string): SyllableParts[] {
  const out: SyllableParts[] = [];
  for (const syl of reading.trim().split(/\s+/).filter(Boolean)) {
    const numeric = syl.match(/^([A-Za-z:üÜ]+)([1-5])$/);
    if (numeric) {
      out.push({ body: numeric[1]!, tone: Number(numeric[2]) });
      continue;
    }
    const tone = detectToneFromMarks(syl);
    const body = syl
      .normalize("NFD")
      .replace(/\p{M}+/gu, "")
      .replace(/ü/g, "u:")
      .replace(/Ü/g, "U:");
    out.push({ body, tone });
  }
  return out;
}

/** Canonical comparison key for two readings — `body+tone` per
 *  syllable, joined by spaces. "ni3 hao3" and "nǐ hǎo" map to the
 *  same key so equality survives format differences. */
export function readingKey(reading: string | null | undefined): string {
  if (!reading) return "";
  return parseSyllableParts(reading)
    .map((p) => `${p.body}${p.tone}`)
    .join(" ");
}

/** Generate up to `count` tone-permuted variants of a Mandarin
 *  reading, returned in numeric CC-CEDICT form ("ni1 hao2"). Used by
 *  the "pick the right tones" challenge — every distractor has the
 *  same syllable bodies as the correct answer, only the tones differ,
 *  so the user can't shortcut on syllable shape. */
export function tonePermutedReadings(
  reading: string,
  count: number,
): string[] {
  const parts = parseSyllableParts(reading);
  if (parts.length === 0) return [];
  const correctKey = parts.map((p) => `${p.body}${p.tone}`).join(" ");
  const seen = new Set<string>([correctKey]);
  const out: string[] = [];
  // Worst case for a 1-syllable word: only 3 possible distractors.
  // Cap attempts well above that so we always find them.
  for (let attempts = 0; attempts < 50 && out.length < count; attempts++) {
    const variant = parts.map((p) => {
      const others = [1, 2, 3, 4].filter((t) => t !== p.tone);
      const newTone = others[Math.floor(Math.random() * others.length)]!;
      return { body: p.body, tone: newTone };
    });
    const key = variant.map((p) => `${p.body}${p.tone}`).join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Normalize a stored pinyin reading into a tone-less, space-less,
 *  diacritic-free form. Used as a search key so "nihao" matches
 *  "ni3 hao3" and "nǐ hǎo" alike. Handles CC-CEDICT alternations
 *  (`zh|zhōng` → first variant), `u:` digraphs, and the `v` alias. */
export function normalizeReading(reading: string | null | undefined): string {
  if (!reading) return "";
  const first = reading.split("|")[0] ?? "";
  return first
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/u:/g, "u")
    .replace(/ü/g, "u")
    .replace(/v/g, "u")
    .replace(/[1-5]/g, "")
    .replace(/[\[\]·'\-]/g, "")
    .replace(/\s+/g, "");
}
