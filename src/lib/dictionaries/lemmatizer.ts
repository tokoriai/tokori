/**
 * Lightweight rule-based lemmatizers for click-to-define lookup.
 *
 * Bilingual dictionaries list lemmas (gehen, ir, comer) but learners
 * click inflected forms in running text (geht, voy, comimos). The
 * lookup path in `db.ts::lookupDict` already tries exact + case-
 * insensitive matches; this module is the third fallback. We trade
 * coverage for simplicity: rules catch common regular conjugations
 * cheaply, no extra data, no extra fetches. Edge cases miss; the user
 * still gets the AI fallback.
 *
 * Adding a language: register a `Lemmatizer` in `LEMMATIZERS`. Each
 * lemmatizer returns ordered lemma *candidates*; the lookup tries them
 * left-to-right and stops at the first hit. Return [] if the language
 * has no useful rules (CJK and Korean already deinflect via headword +
 * alt_word lookups in the underlying dictionaries).
 */
import type { LanguageCode } from "@/lib/languages";

export type Lemmatizer = (word: string) => string[];

/** All candidate lemmas for a word, ordered by likelihood. Empty when
 *  the language has no registered rules. The caller dedupes against
 *  the original surface form. */
export function lemmaCandidates(lang: LanguageCode, word: string): string[] {
  const fn = LEMMATIZERS[lang];
  if (!fn) return [];
  const w = word.trim();
  if (!w) return [];
  const seen = new Set<string>([w, w.toLowerCase()]);
  const out: string[] = [];
  for (const cand of fn(w)) {
    const c = cand.trim();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

// ── German ─────────────────────────────────────────────────────────
//
// Regular verb endings on the present tense: -e, -st, -t, -en, -et.
// Past tense: -te, -test, -ten, -tet, plus a participle prefix `ge-`.
// Adjective endings (attributive): -e, -er, -es, -en, -em. Plural
// nouns: -e, -en, -er, -s. We don't try to undo ablaut (ging→gehen,
// trank→trinken) — that needs a strong-verb table. Common irregulars
// get hand-coded entries below.
const DE_IRREGULAR: Record<string, string> = {
  // sein
  bin: "sein", bist: "sein", ist: "sein", sind: "sein", seid: "sein",
  war: "sein", warst: "sein", waren: "sein", wart: "sein", gewesen: "sein",
  // haben
  habe: "haben", hast: "haben", hat: "haben", habt: "haben",
  hatte: "haben", hattest: "haben", hatten: "haben", hattet: "haben", gehabt: "haben",
  // werden
  werde: "werden", wirst: "werden", wird: "werden", werdet: "werden",
  wurde: "werden", wurdest: "werden", wurden: "werden", wurdet: "werden", geworden: "werden",
  // gehen / kommen / sehen — common irregulars
  ging: "gehen", gingst: "gehen", gingen: "gehen", gingt: "gehen", gegangen: "gehen",
  kam: "kommen", kamst: "kommen", kamen: "kommen", kamt: "kommen", gekommen: "kommen",
  sah: "sehen", sahst: "sehen", sahen: "sehen", saht: "sehen", gesehen: "sehen",
  // modal verbs
  kann: "können", kannst: "können", könnt: "können", konnte: "können", konnten: "können",
  muss: "müssen", musst: "müssen", müsst: "müssen", musste: "müssen", mussten: "müssen",
  will: "wollen", willst: "wollen", wollt: "wollen", wollte: "wollen", wollten: "wollen",
  soll: "sollen", sollst: "sollen", sollt: "sollen", sollte: "sollen", sollten: "sollen",
  darf: "dürfen", darfst: "dürfen", dürft: "dürfen", durfte: "dürfen", durften: "dürfen",
  mag: "mögen", magst: "mögen", mögt: "mögen", mochte: "mögen", mochten: "mögen",
};

const DE_VERB_SUFFIXES = ["est", "et", "en", "st", "te", "t", "e"];
const DE_ADJ_SUFFIXES = ["sten", "ster", "stes", "ste", "ere", "eren", "eres", "erem", "em", "er", "es", "en", "e"];

function germanCandidates(word: string): string[] {
  const lower = word.toLowerCase();
  const irreg = DE_IRREGULAR[lower];
  if (irreg) return [irreg];

  const out: string[] = [];

  // Past participle: ge-X-t / ge-X-en → strip prefix + suffix.
  if (lower.startsWith("ge") && lower.length > 4) {
    const inner = lower.slice(2);
    if (inner.endsWith("en")) out.push(inner.slice(0, -2) + "en");
    if (inner.endsWith("t")) out.push(inner.slice(0, -1) + "en");
  }

  // Verb suffixes — append "en" to reconstruct the infinitive.
  for (const suf of DE_VERB_SUFFIXES) {
    if (lower.endsWith(suf) && lower.length > suf.length + 1) {
      const stem = lower.slice(0, -suf.length);
      out.push(stem + "en");
      out.push(stem);
    }
  }

  // Adjective inflection (nominative/accusative/dative endings).
  for (const suf of DE_ADJ_SUFFIXES) {
    if (lower.endsWith(suf) && lower.length > suf.length + 2) {
      const stem = lower.slice(0, -suf.length);
      out.push(stem);
    }
  }

  // German nouns are capitalised in text — the original-case form may
  // be the lemma already. Also try the bare lowercased form for
  // sentence-initial capitalisation.
  out.push(word);
  out.push(lower);
  return out;
}

// ── Spanish ────────────────────────────────────────────────────────
//
// Regular conjugation strips per ending class (-ar, -er, -ir). We try
// each infinitive form for each candidate stem. Cheap and broad —
// "voy" hits "ir" via the irregular table; "hablamos" → "hablar" via
// `-amos` → `-ar`.
const ES_IRREGULAR: Record<string, string> = {
  // ser / estar
  soy: "ser", eres: "ser", es: "ser", somos: "ser", sois: "ser", son: "ser",
  era: "ser", eras: "ser", éramos: "ser", erais: "ser", eran: "ser",
  fui: "ser", fuiste: "ser", fue: "ser", fuimos: "ser", fuisteis: "ser", fueron: "ser",
  estoy: "estar", estás: "estar", está: "estar", estamos: "estar", estáis: "estar", están: "estar",
  // ir
  voy: "ir", vas: "ir", va: "ir", vamos: "ir", vais: "ir", van: "ir",
  iba: "ir", ibas: "ir", íbamos: "ir", ibais: "ir", iban: "ir",
  // haber / tener
  he: "haber", has: "haber", ha: "haber", hemos: "haber", habéis: "haber", han: "haber",
  tengo: "tener", tienes: "tener", tiene: "tener", tenemos: "tener", tenéis: "tener", tienen: "tener",
  // hacer / decir / poder
  hago: "hacer", haces: "hacer", hace: "hacer", hacemos: "hacer", hacéis: "hacer", hacen: "hacer",
  hice: "hacer", hiciste: "hacer", hizo: "hacer", hicimos: "hacer", hicisteis: "hacer", hicieron: "hacer",
  digo: "decir", dices: "decir", dice: "decir", decimos: "decir", decís: "decir", dicen: "decir",
  puedo: "poder", puedes: "poder", puede: "poder", podemos: "poder", podéis: "poder", pueden: "poder",
};

// (suffix, infinitive ending) — first match wins. Ordered longest first
// so "amos" beats "as" on "hablamos".
const ES_RULES: ReadonlyArray<readonly [string, string]> = [
  // present
  ["amos", "ar"], ["áis", "ar"], ["an", "ar"], ["as", "ar"], ["a", "ar"], ["o", "ar"],
  ["emos", "er"], ["éis", "er"], ["en", "er"], ["es", "er"], ["e", "er"],
  ["imos", "ir"], ["ís", "ir"],
  // preterite
  ["aron", "ar"], ["aste", "ar"], ["asteis", "ar"], ["é", "ar"], ["ó", "ar"],
  ["ieron", "er"], ["iste", "er"], ["isteis", "er"], ["í", "ir"], ["ió", "ir"],
  // imperfect
  ["abamos", "ar"], ["abais", "ar"], ["aban", "ar"], ["aba", "ar"], ["abas", "ar"],
  ["íamos", "er"], ["íais", "er"], ["ían", "er"], ["ía", "er"], ["ías", "er"],
  // gerund / participle
  ["ando", "ar"], ["iendo", "er"], ["ado", "ar"], ["ido", "er"],
];

function spanishCandidates(word: string): string[] {
  const lower = word.toLowerCase();
  const irreg = ES_IRREGULAR[lower];
  if (irreg) return [irreg];

  const out: string[] = [];
  for (const [suf, inf] of ES_RULES) {
    if (lower.endsWith(suf) && lower.length > suf.length + 1) {
      const stem = lower.slice(0, -suf.length);
      out.push(stem + inf);
    }
  }

  // Adjective / noun plural and gender alternation: -as → -a, -os → -o,
  // -es → -e or bare.
  if (lower.endsWith("es") && lower.length > 3) out.push(lower.slice(0, -2), lower.slice(0, -1));
  if (lower.endsWith("as") && lower.length > 3) out.push(lower.slice(0, -1), lower.slice(0, -2) + "o");
  if (lower.endsWith("os") && lower.length > 3) out.push(lower.slice(0, -1), lower.slice(0, -2) + "o");
  if (lower.endsWith("a") && lower.length > 2) out.push(lower.slice(0, -1) + "o");

  return out;
}

const LEMMATIZERS: Partial<Record<LanguageCode, Lemmatizer>> = {
  de: germanCandidates,
  es: spanishCandidates,
};
