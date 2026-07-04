/**
 * Structured grammar profile for a dictionary headword — the "more
 * information" layer for Latin-script languages (German, Spanish) where
 * there's no reading or stroke order to show. Produced by the active AI
 * provider and cached per word in `localStorage` (regenerable, so no DB
 * column / migration), then rendered as clean tables on the detail page.
 *
 * The model is the least reliable input in the app, so `parseGrammarProfile`
 * is defensive: every field is optional, unknown values are coerced or
 * dropped, arrays are clamped, and a single malformed response yields
 * `null` rather than a half-built object. All pure + unit-tested.
 */

export type GrammarPos =
  | "noun"
  | "verb"
  | "adjective"
  | "adverb"
  | "preposition"
  | "conjunction"
  | "pronoun"
  | "article"
  | "numeral"
  | "interjection"
  | "phrase"
  | "other";

export type Gender = "m" | "f" | "n" | "mf";

export type Register = "neutral" | "formal" | "informal" | "vulgar" | "literary";

export type NounGrammar = {
  gender?: Gender;
  /** Definite article — "der" / "die" / "das" / "el" / "la". */
  article?: string;
  plural?: string;
};

export type VerbGrammar = {
  infinitive?: string;
  /** Perfect-tense auxiliary — "haben" / "sein" (de) or "haber" (es). */
  auxiliary?: string;
  /** Separable prefix — German only ("an", "auf", …). */
  separablePrefix?: string;
  /** Present-tense forms in canonical person order. */
  present?: string[];
  /** Simple past, 3rd person singular (Präteritum / pretérito). */
  past?: string;
  participle?: string;
};

export type AdjectiveGrammar = {
  comparative?: string;
  superlative?: string;
};

export type GrammarProfile = {
  pos: GrammarPos;
  lemma?: string;
  register?: Register;
  noun?: NounGrammar;
  verb?: VerbGrammar;
  adjective?: AdjectiveGrammar;
  synonyms?: string[];
  notes?: string[];
};

const POS_VALUES: readonly string[] = [
  "noun",
  "verb",
  "adjective",
  "adverb",
  "preposition",
  "conjunction",
  "pronoun",
  "article",
  "numeral",
  "interjection",
  "phrase",
  "other",
];

const REGISTERS: readonly string[] = [
  "neutral",
  "formal",
  "informal",
  "vulgar",
  "literary",
];

/** localStorage key for the cached profile of one word. */
export function GRAMMAR_KEY(lang: string, word: string): string {
  return `tokori.grammar.${lang}.${word}`;
}

/** Parse a model reply (possibly fenced / with preamble) into a validated
 *  profile, or `null` if it isn't recoverable JSON. */
export function parseGrammarProfile(raw: string): GrammarProfile | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;

  const pos = coercePos(o.pos);
  const profile: GrammarProfile = { pos };

  const lemma = str(o.lemma);
  if (lemma) profile.lemma = lemma;

  const register = coerceRegister(o.register);
  if (register) profile.register = register;

  // Only attach the sub-object that matches the part of speech, so a
  // model that over-shares (verb fields on a noun) gets trimmed.
  if (pos === "noun") {
    const noun = coerceNoun(o.noun);
    if (noun) profile.noun = noun;
  } else if (pos === "verb") {
    const verb = coerceVerb(o.verb);
    if (verb) profile.verb = verb;
  } else if (pos === "adjective") {
    const adjective = coerceAdjective(o.adjective);
    if (adjective) profile.adjective = adjective;
  }

  const synonyms = strArray(o.synonyms, 4);
  if (synonyms.length) profile.synonyms = synonyms;

  const notes = strArray(o.notes, 2);
  if (notes.length) profile.notes = notes;

  return profile;
}

// ── coercion helpers ────────────────────────────────────────────────

/** Strip a leading/trailing markdown fence and any prose around the JSON,
 *  then slice from the first `{` to the last `}` — same recovery the AI
 *  define / examples paths use, since the model often ignores "no fences". */
function extractJsonObject(raw: string): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return cleaned.slice(start, end + 1);
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

function strArray(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = str(item);
    if (s) out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

function coercePos(v: unknown): GrammarPos {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return POS_VALUES.includes(s) ? (s as GrammarPos) : "other";
}

function coerceRegister(v: unknown): Register | undefined {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return REGISTERS.includes(s) ? (s as Register) : undefined;
}

function coerceGender(v: unknown): Gender | undefined {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (["m", "masc", "masculine", "der", "el"].includes(s)) return "m";
  if (["f", "fem", "feminine", "die", "la"].includes(s)) return "f";
  if (["n", "neuter", "neutral", "das"].includes(s)) return "n";
  if (["mf", "m/f", "both", "common"].includes(s)) return "mf";
  return undefined;
}

function coerceNoun(v: unknown): NounGrammar | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const noun: NounGrammar = {};
  const gender = coerceGender(o.gender);
  if (gender) noun.gender = gender;
  const article = str(o.article);
  if (article) noun.article = article;
  const plural = str(o.plural);
  if (plural) noun.plural = plural;
  return Object.keys(noun).length ? noun : undefined;
}

function coerceVerb(v: unknown): VerbGrammar | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const verb: VerbGrammar = {};
  const infinitive = str(o.infinitive);
  if (infinitive) verb.infinitive = infinitive;
  const auxiliary = str(o.auxiliary);
  if (auxiliary) verb.auxiliary = auxiliary;
  const separablePrefix = str(o.separablePrefix);
  if (separablePrefix) verb.separablePrefix = separablePrefix;
  const present = strArray(o.present, 6);
  if (present.length) verb.present = present;
  const past = str(o.past);
  if (past) verb.past = past;
  const participle = str(o.participle);
  if (participle) verb.participle = participle;
  return Object.keys(verb).length ? verb : undefined;
}

function coerceAdjective(v: unknown): AdjectiveGrammar | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const adjective: AdjectiveGrammar = {};
  const comparative = str(o.comparative);
  if (comparative) adjective.comparative = comparative;
  const superlative = str(o.superlative);
  if (superlative) adjective.superlative = superlative;
  return Object.keys(adjective).length ? adjective : undefined;
}
