// Dictionary search ranking — the pure scoring logic behind `searchDict`.
//
// Lives in its own module (no Tauri / DB imports) so the SQLite path, the
// in-memory `fb` fallback, and the HOSTED cloud path all rank through one
// source of truth — and so the ranking is unit-testable in isolation.
//
// The hard case this solves: a *meaning* search. When a learner types an
// English word ("eye") in a Chinese workspace, the query can only match
// the `gloss` field — never the headword or pinyin. Sorting those hits by
// headword length alone buries 眼睛 ("eye") among everything whose gloss
// merely *contains* the substring "eye" (眉毛 "eyebrow", 睫毛 "eyelash",
// 盯 "to fix one's eyes on"). The fix is to score *how well* the query
// matches the gloss, and to prefer the entry where it's the primary sense.

import type { DictEntry } from "./db";

// "nǐ hǎo" / "ni3 hao3" / "ni hao" all → "nihao". Strips tone marks, tone
// digits, and whitespace so a Latin-script reading query matches however
// the user typed (or didn't type) the diacritics.
export function normaliseReading(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining diacritics
    .replace(/[\s\d]/g, "") // tone digits, whitespace
    .toLowerCase();
}

// How a query lines up with a single dictionary gloss, best → worst.
export type GlossMatchKind =
  | "exact-sense" // a whole "; "-delimited sense equals the query ("eye")
  | "word-initial" // a sense begins with the query as a word ("eye socket")
  | "word" // the query appears as a standalone word ("apple of one's eye")
  | "substring" // the query only sits inside a larger word ("eyebrow")
  | "none"; // the query isn't in the gloss at all (matched via alt form)

const GLOSS_KIND_RANK: Record<GlossMatchKind, number> = {
  "exact-sense": 0,
  "word-initial": 1,
  word: 2,
  substring: 3,
  none: 4,
};

// Glosses are senses joined with "; " by every parser (CC-CEDICT turns its
// "/"-delimited fields into "; "; JMdict / the bilingual parsers join the
// same way). Split tolerantly on either so a stray "/" still segments.
function splitSenses(gloss: string): string[] {
  return gloss
    .split(/\s*[;/]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Score `gloss` against `queryLower` (already lower-cased + trimmed),
// returning the best match kind and the index of the *earliest* sense that
// produced it — so "eye" as sense 0 of 眼睛 outranks "eye" buried as the
// fifth sense of some compound. Whole-word matching is what keeps
// "eyebrow" / "eyelash" out of the strong buckets when the user typed
// "eye": `\beye\b` doesn't match inside "eyebrow", so it lands in
// `substring`, below every entry that genuinely means "eye".
export function glossMatch(
  gloss: string,
  queryLower: string,
): { kind: GlossMatchKind; senseIndex: number } {
  if (!queryLower) return { kind: "none", senseIndex: 0 };
  const senses = splitSenses(gloss);
  const wordRe = new RegExp(`\\b${escapeRegExp(queryLower)}\\b`);
  let best: GlossMatchKind = "none";
  let bestIndex = 0;
  for (let i = 0; i < senses.length; i++) {
    const sense = senses[i].toLowerCase();
    let kind: GlossMatchKind;
    if (sense === queryLower) kind = "exact-sense";
    else if (wordRe.test(sense))
      // Inside this branch the query is a whole word; if the sense also
      // *starts* with it, that next char must already be a boundary (else
      // \b wouldn't have matched), so startsWith alone is enough.
      kind = sense.startsWith(queryLower) ? "word-initial" : "word";
    else if (sense.includes(queryLower)) kind = "substring";
    else continue;
    if (GLOSS_KIND_RANK[kind] < GLOSS_KIND_RANK[best]) {
      best = kind;
      bestIndex = i;
      if (best === "exact-sense") break; // nothing beats this
    }
  }
  return { kind: best, senseIndex: bestIndex };
}

// Rank dictionary hits for `q` (raw query, trimmed) given its normalised
// reading `normQ` and whether it looks like Latin script. Pure + stable:
// equal-key entries fall back to a lexicographic word tiebreak so results
// don't jiggle between runs.
//
// Sort key, in order of precedence:
//   1. primary  — a direct hit on the headword/reading always beats a
//                 meaning hit (0 = exact word … 5 = gloss-only).
//   2. glossKind — within the meaning bucket, exact-sense › word › substring.
//   3. senseIdx — earlier (more primary) sense first.
//   4. wordLen  — shorter headword first (a decent frequency proxy: the
//                 everyday CJK word for a concept is usually short).
//   5. word     — deterministic final tiebreak.
export function rankSearchHits(
  entries: DictEntry[],
  q: string,
  normQ: string,
  isLatinQuery: boolean,
  limit: number,
): DictEntry[] {
  const queryLower = q.toLowerCase();

  const primary = (e: DictEntry): number => {
    if (e.word === q) return 0;
    if (e.word.startsWith(q)) return 1;
    if (isLatinQuery) {
      const r = normaliseReading(e.reading);
      if (r === normQ) return 2;
      if (r.startsWith(normQ)) return 3;
    }
    if (e.reading && e.reading.toLowerCase().startsWith(queryLower)) return 4;
    return 5;
  };

  // Precompute keys once per entry — scoring inside the comparator would
  // re-run normaliseReading (NFD + regex) and the gloss scan ~log n times
  // per row. Gloss quality is only consulted for the meaning bucket (5);
  // headword/reading hits keep their existing order (by length) exactly,
  // since their gloss kind stays a constant "none".
  const keyed = entries.map((e) => {
    const p = primary(e);
    const g =
      p === 5
        ? glossMatch(e.gloss, queryLower)
        : { kind: "none" as GlossMatchKind, senseIndex: 0 };
    return { e, p, gk: GLOSS_KIND_RANK[g.kind], gi: g.senseIndex };
  });

  return keyed
    .sort(
      (a, b) =>
        a.p - b.p ||
        a.gk - b.gk ||
        a.gi - b.gi ||
        a.e.word.length - b.e.word.length ||
        (a.e.word < b.e.word ? -1 : a.e.word > b.e.word ? 1 : 0),
    )
    .slice(0, limit)
    .map((x) => x.e);
}
