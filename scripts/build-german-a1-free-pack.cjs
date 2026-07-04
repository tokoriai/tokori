/**
 * Builds packs/german-a1-free.json from patsytau/anki_german_a1_vocab.
 *
 * Source: https://github.com/patsytau/anki_german_a1_vocab (CC BY-SA
 * 4.0). The TSV columns are:
 *   id  german  german_example  english  english_example  formality  audio_tag
 * We collapse repeated headwords (Goethe lists multiple senses on
 * separate rows, e.g. "all-(1)", "all-(2)") into a single row whose
 * gloss is the joined English meanings.
 *
 * Run: `node scripts/build-german-a1-free-pack.cjs`
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const SOURCE_URL =
  "https://raw.githubusercontent.com/patsytau/anki_german_a1_vocab/master/Goethe%20Institute%20A1%20Wordlist.txt";
const OUT = path.join(__dirname, "..", "packs", "german-a1-free.json");

// Hand-curated thematic groupings — exact-headword filters against
// the source list (with case-insensitive matching, since Goethe stores
// nouns with articles like "die Adresse"). Topical sub-collections
// give the learner targeted decks for the first few weeks.
const TOPICS = [
  {
    id: "a1-greetings",
    name: "German A1 · Greetings & courtesy",
    description: "Hellos, please, thank-you, sorry.",
    matchers: [
      "guten Tag", "guten Morgen", "guten Abend", "gute Nacht",
      "Hallo", "Tschüss", "auf Wiedersehen",
      "danke", "bitte", "Entschuldigung", "ja", "nein", "ok",
    ],
  },
  {
    id: "a1-pronouns",
    name: "German A1 · Pronouns & people",
    description: "I / you / we / them and the people who fill those slots.",
    matchers: [
      "ich", "du", "er", "sie", "wir", "ihr", "Sie",
      "Mann", "Frau", "Kind", "Junge", "Mädchen", "Familie",
      "Vater", "Mutter", "Sohn", "Tochter", "Bruder", "Schwester",
      "Freund", "Freundin", "Eltern",
    ],
  },
  {
    id: "a1-numbers",
    name: "German A1 · Numbers",
    description: "Zero to one hundred.",
    matchers: [
      "null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn",
      "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn",
      "zwanzig", "dreißig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig", "hundert",
    ],
  },
  {
    id: "a1-time",
    name: "German A1 · Time & days",
    description: "Mornings, weekdays, seasons.",
    matchers: [
      "Tag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag",
      "Morgen", "Mittag", "Abend", "Nacht", "heute", "gestern", "morgen",
      "Woche", "Monat", "Jahr", "Stunde", "Minute", "Uhr",
    ],
  },
  {
    id: "a1-food",
    name: "German A1 · Food & drink",
    description: "Markt and Mensa essentials.",
    matchers: [
      "Brot", "Käse", "Butter", "Wurst", "Fleisch", "Fisch", "Ei",
      "Apfel", "Kartoffel", "Tomate", "Salat", "Milch", "Wasser",
      "Kaffee", "Tee", "Bier", "Wein", "Saft", "Essen", "Frühstück",
      "Mittagessen", "Abendessen",
    ],
  },
];

// Goethe A1 doesn't include casual greetings like "Hallo" or "Tschüss"
// (the official list is exam-aligned, formal-skewed) but learners want
// them on day one. Hand-keyed; sits alongside the Goethe-derived
// collection rather than replacing it.
const DAY_ONE_GREETINGS = [
  { word: "Hallo", reading: null, gloss: "hello (informal)" },
  { word: "Guten Morgen", reading: null, gloss: "good morning" },
  { word: "Guten Tag", reading: null, gloss: "good day, hello (formal)" },
  { word: "Guten Abend", reading: null, gloss: "good evening" },
  { word: "Gute Nacht", reading: null, gloss: "good night" },
  { word: "Tschüss", reading: null, gloss: "bye (informal)" },
  { word: "Auf Wiedersehen", reading: null, gloss: "goodbye (formal)" },
  { word: "Bis später", reading: null, gloss: "see you later" },
  { word: "Bis morgen", reading: null, gloss: "see you tomorrow" },
  { word: "Wie geht es dir?", reading: null, gloss: "how are you? (informal)" },
  { word: "Wie geht es Ihnen?", reading: null, gloss: "how are you? (formal)" },
  { word: "Mir geht es gut", reading: null, gloss: "I'm doing well" },
  { word: "Danke schön", reading: null, gloss: "thank you very much" },
  { word: "Bitte schön", reading: null, gloss: "you're welcome / here you go" },
  { word: "Entschuldigung", reading: null, gloss: "excuse me, sorry" },
  { word: "Montag", reading: null, gloss: "Monday" },
  { word: "Dienstag", reading: null, gloss: "Tuesday" },
  { word: "Mittwoch", reading: null, gloss: "Wednesday" },
  { word: "Donnerstag", reading: null, gloss: "Thursday" },
  { word: "Freitag", reading: null, gloss: "Friday" },
  { word: "Samstag", reading: null, gloss: "Saturday" },
  { word: "Sonntag", reading: null, gloss: "Sunday" },
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

/** Normalise Goethe headwords:
 *   - "all-(1)" / "all-(2)" → "all"  (sense disambiguators collapse)
 *   - "der Apfel, -Ä" → "der Apfel"  (plural marker dropped — readable
 *     gloss carries the meaning, our lemmatizer handles plural forms)
 *   - "die Adresse, -n" → "die Adresse"
 *  Multiple-sense rows merge under one headword. */
function normaliseHeadword(s) {
  return s
    .replace(/\(\d+\)$/, "")
    .replace(/,\s*-[A-Za-zÄÖÜäöüß]+$/, "")
    .replace(/,\s*-$/, "")
    .trim();
}

/** Drop bracketed grammatical / register annotations from glosses
 *  so the popover doesn't render `(coll.)` everywhere. */
function cleanGloss(s) {
  return s.replace(/\s*\[[^\]]*\]\s*/g, " ").replace(/\s+/g, " ").trim();
}

(async () => {
  console.log(`Fetching ${SOURCE_URL}…`);
  const tsv = await fetchText(SOURCE_URL);

  /** @type {Map<string, {word:string, gloss:Set<string>}>} */
  const byHead = new Map();

  for (const rawLine of tsv.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const cols = rawLine.split("\t");
    if (cols.length < 4) continue;
    const german = (cols[1] || "").trim();
    const english = (cols[3] || "").trim();
    if (!german || !english) continue;
    const head = normaliseHeadword(german);
    const gloss = cleanGloss(english);
    const cur = byHead.get(head) ?? { word: head, gloss: new Set() };
    cur.gloss.add(gloss);
    byHead.set(head, cur);
  }

  const words = [...byHead.values()]
    .map((e) => ({ word: e.word, reading: null, gloss: [...e.gloss].join("; ") }))
    .sort((a, b) =>
      a.word.localeCompare(b.word, "de") || a.gloss.localeCompare(b.gloss, "de"),
    );

  // Sub-collections.
  const subCollections = TOPICS.map((t) => {
    const matched = words.filter((w) => {
      const head = w.word.replace(/^(der|die|das)\s+/i, "").toLowerCase();
      return t.matchers.some((m) => {
        const ml = m.toLowerCase();
        return head === ml || head.startsWith(ml + " ") || head === ml.replace(/^(der|die|das)\s+/i, "");
      });
    });
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      words: matched,
    };
  }).filter((c) => c.words.length > 0);

  const pack = {
    schema: "tokori-pack/v1",
    id: "free:german-a1",
    name: "German A1 vocabulary — Free",
    language: "de",
    description:
      `${words.length} German A1 vocabulary items in one drillable collection ` +
      `plus thematic sub-decks (greetings, numbers, family, food, time). ` +
      `Source: Goethe-Institut A1 Wortliste via patsytau/anki_german_a1_vocab (CC BY-SA 4.0).`,
    version: "1.0.0",
    license:
      "Vocabulary data: CC BY-SA 4.0 (patsytau, github.com/patsytau/anki_german_a1_vocab). " +
      "Underlying word list courtesy of the Goethe-Institut A1 Wortliste. " +
      "Sub-collection grouping by Tokori. Free for everyone.",
    collections: [
      {
        id: "a1-day-one",
        name: "German · Day-one greetings",
        description:
          "Hallo, Tschüss, danke schön — everyday phrases not on the Goethe A1 list but you want them anyway.",
        words: DAY_ONE_GREETINGS,
      },
      {
        id: "a1-all",
        name: `German A1 · all ${words.length} words`,
        description: "Every vocabulary item on the Goethe A1 word list.",
        words,
      },
      ...subCollections,
    ],
  };

  fs.writeFileSync(OUT, JSON.stringify(pack, null, 2) + "\n");
  console.log(
    `Wrote ${OUT}\n  ${words.length} words · ${subCollections.length} sub-collections`,
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
