/**
 * Single source of truth for the dictionary packs Tokori ships.
 *
 * The frontend never invents URLs or formats inline — every install,
 * every pack card, every "do we have a real dictionary for this
 * language?" check reads from this registry. Adding support for a new
 * dictionary means dropping one entry below; the Settings UI and the
 * language profile picker pick it up automatically.
 *
 * If a new pack needs a parser the Rust side doesn't know yet, also
 * add a `DictFormat` branch and the corresponding `parse_*` function
 * in `src-tauri/src/commands.rs::dict_fetch_lang`.
 */
import type { LanguageCode } from "@/lib/languages";

/** Wire format identifier — must match the Rust dispatch in
 *  `dict_fetch_lang` (and `dict_fetch_cedict` for the CC-CEDICT
 *  fallback chain). Adding a new format requires both sides. */
export type DictFormat =
  | "cedict"
  | "jmdict"
  | "jmdict-xml"
  | "kanjidic-xml"
  | "ding"
  | "tei-bilingual"
  | "wiktionary-data"
  | "yomitan";

export type DictSource = {
  /** Human label shown in the "Use a different source" picker. */
  label: string;
  /** Direct download URL. May be HTTP for legacy hosts (see jmdict). */
  url: string;
};

export type DictionaryPack = {
  /** Stable id used in code (e.g. as `recommendedDict` on a language
   *  profile). Never localised. Renames break old installs since this
   *  is also the row name we write into the DB — bump with care. */
  id: string;
  /** Display name shown in the install card, the installed list, and
   *  the DB `dictionaries.name` column. */
  name: string;
  /** Target language the pack belongs to. One pack = one language. */
  lang: LanguageCode;
  /** Wire format the Rust parser handles. */
  format: DictFormat;
  /** Default URL the Install button uses. */
  defaultUrl: string;
  /** Optional alternate URLs surfaced behind "Use a different source".
   *  When the alternates use a *different* parser (e.g. JMdict XML vs
   *  JMdict JSON), the picker in `dictionaries-section.tsx` decides
   *  via `formatForUrl` — keep the formats compatible per pack. */
  presets?: DictSource[];
  /** One-line description for the card. */
  description: string;
  /** Approximate size + entry-count blurb. */
  size: string;
  /** SPDX-style license string (or a free-form note for older sources). */
  license: string;
};

/**
 * Packs Tokori ships out of the box. The order here is the order they
 * appear in the Settings → Dictionaries list when no workspace is
 * active. Workspace-scoped views filter to the matching language.
 */
export const DICTIONARY_PACKS: readonly DictionaryPack[] = [
  {
    id: "cc-cedict",
    name: "CC-CEDICT",
    lang: "zh",
    format: "cedict",
    defaultUrl:
      "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz",
    presets: [
      {
        label: "MDBG official (.txt.gz)",
        url: "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz",
      },
      {
        label: "Wenlin mirror (plain text)",
        url: "https://raw.githubusercontent.com/wenlin-society/wenlin-data/master/cc-cedict_ts.u8",
      },
    ],
    description:
      "Open-source Chinese ↔ English dictionary — ~120k entries with simplified, traditional, and pinyin.",
    size: "~7 MB compressed · ~120k entries",
    license: "CC BY-SA 4.0",
  },
  {
    id: "jmdict-eng",
    name: "JMdict (English)",
    lang: "ja",
    // The DictPack format the default URL parses as. Alternate JSON
    // presets re-route to the JSON parser via formatForUrl().
    format: "jmdict-xml",
    defaultUrl: "http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz",
    presets: [
      {
        label: "JMdict_e — official EDRDG XML (HTTP)",
        url: "http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz",
      },
      {
        label: "JMdict-eng-common (jmdict-simplified JSON, HTTPS)",
        url: "https://github.com/scriptin/jmdict-simplified/releases/latest/download/jmdict-eng-common.json.tgz",
      },
      {
        label: "JMdict-eng full (jmdict-simplified JSON, HTTPS)",
        url: "https://github.com/scriptin/jmdict-simplified/releases/latest/download/jmdict-eng.json.tgz",
      },
    ],
    description:
      "EDRDG's Japanese ↔ English dictionary (~190k entries). Default downloads the canonical XML from ftp.edrdg.org; HTTPS GitHub mirrors are offered as fallbacks.",
    size: "~10 MB compressed · ~190k entries",
    license: "JMdict / EDRDG (CC BY-SA 4.0)",
  },
  {
    // KANJIDIC2 — EDRDG's per-character kanji dictionary (companion to
    // JMdict). Same project, same license. Where JMdict gives you word
    // lookup, KANJIDIC gives you single-character lookup: On reading
    // (Chinese-derived), Kun reading (native Japanese), English
    // meanings, stroke count, JLPT level, school grade. Most useful
    // when a learner clicks a kanji that's part of a word they
    // already know — JMdict often has nothing for the bare character,
    // KANJIDIC always does.
    //
    // Install alongside JMdict, not as a replacement. The lookup walks
    // every installed dict, so kanji-only queries hit KANJIDIC while
    // word queries continue to hit JMdict.
    id: "kanjidic-eng",
    name: "KANJIDIC2 (English)",
    lang: "ja",
    format: "kanjidic-xml",
    defaultUrl: "http://ftp.edrdg.org/pub/Nihongo/kanjidic2.xml.gz",
    presets: [
      {
        label: "KANJIDIC2 — official EDRDG XML (HTTP)",
        url: "http://ftp.edrdg.org/pub/Nihongo/kanjidic2.xml.gz",
      },
    ],
    description:
      "EDRDG's character-level Japanese dictionary (~13k kanji). Each entry carries On reading (e.g. 'アア'), Kun reading ('つ.ぐ'), English meanings, stroke count, JLPT level, and Japanese-school grade. Companion to JMdict — install both so kanji-only clicks resolve as well as word clicks.",
    size: "~1.5 MB compressed · ~13k kanji",
    license: "KANJIDIC2 / EDRDG (CC BY-SA 4.0)",
  },
  {
    // Yomitan-format German Wiktionary export built by yomidevs/
    // kaikki-to-yomitan. Same data lineage as the Kaikki pack below,
    // but pre-processed into the Yomitan term-bank shape — much
    // smaller download than the raw JSONL extract and the per-sense
    // glosses are already split into separate rows, including
    // inflected forms (`geht` → "third-person singular present of
    // gehen"). Recommended default for German.
    id: "de-yomitan-wiktionary",
    name: "German Wiktionary (Yomitan)",
    lang: "de",
    format: "yomitan",
    defaultUrl:
      "https://pub-c3d38cca4dc2403b88934c56748f5144.r2.dev/releases/latest/kty-de-en.zip",
    presets: [
      {
        label: "kty-de-en (kaikki-to-yomitan, latest)",
        url: "https://pub-c3d38cca4dc2403b88934c56748f5144.r2.dev/releases/latest/kty-de-en.zip",
      },
    ],
    description:
      "German ↔ English dictionary derived from the English Wiktionary by yomidevs/kaikki-to-yomitan — ~25 MB zip with inflected-form rows and structured glosses. Imports via the standard Yomitan term-bank format.",
    size: "~25 MB zipped · ~980k entries (incl. inflected forms)",
    license: "CC BY-SA (Wiktionary)",
  },
  {
    id: "ding-de-en",
    name: "Ding DE-EN",
    lang: "de",
    format: "ding",
    defaultUrl:
      "https://ftp.tu-chemnitz.de/pub/Local/urz/ding/de-en-devel/de-en.txt.gz",
    presets: [
      {
        label: "TU Chemnitz devel (latest)",
        url: "https://ftp.tu-chemnitz.de/pub/Local/urz/ding/de-en-devel/de-en.txt.gz",
      },
      {
        label: "TU Chemnitz stable (release snapshot)",
        url: "https://ftp.tu-chemnitz.de/pub/Local/urz/ding/de-en/de-en.txt.gz",
      },
    ],
    description:
      "Frank Richter's German ↔ English dictionary — the data behind Beolingus, ~600k senses.",
    size: "~12 MB compressed · ~600k senses",
    license: "GPL v2",
  },
  {
    // Korean Learner's Dictionary (KRDICT) and the Standard Korean
    // Language Dictionary (STDICT) — both maintained by the National
    // Institute of Korean Language (국립국어원). We ship the Yomitan
    // conversion by Lyroxide because (a) it's the de facto standard
    // open Korean dict for learners, vastly more thorough than the
    // ~15k-entry CC-KEDICT that used to live here, (b) the CC BY-SA
    // licence permits redistribution including in a commercial app,
    // and (c) Tokori already has a Yomitan term-bank parser so no new
    // format code is needed.
    //
    // Default = KO-EN with examples (~16 MB, ~50k headwords). The
    // monolingual STDICT preset is offered for advanced learners
    // comfortable reading Korean definitions; it's much larger
    // (~58 MB, ~440k headwords) and the gloss column ends up in
    // Korean rather than English, which is mostly useful as a second
    // pack installed alongside the bilingual one.
    id: "ko-krdict-yomitan",
    name: "KRDICT (Korean Learner's Dictionary)",
    lang: "ko",
    format: "yomitan",
    defaultUrl:
      "https://github.com/Lyroxide/yomitan-ko-dic/releases/download/1.0.0/KO-EN.KRDICT.zip",
    presets: [
      {
        label: "KO-EN.KRDICT — bilingual, with examples (recommended)",
        url: "https://github.com/Lyroxide/yomitan-ko-dic/releases/download/1.0.0/KO-EN.KRDICT.zip",
      },
      {
        label: "KO-EN.KRDICT — bilingual, no examples (smaller)",
        url: "https://github.com/Lyroxide/yomitan-ko-dic/releases/download/1.0.0/KO-EN.KRDICT.No.Examples.zip",
      },
      {
        label: "Monolingual STDICT (표준국어대사전) — for advanced learners",
        url: "https://github.com/Lyroxide/yomitan-ko-dic/releases/download/1.0.0/Monolingual.STDICT.zip",
      },
    ],
    description:
      "Korean ↔ English dictionary published by the National Institute of Korean Language (국립국어원). Ships in Yomitan term-bank format with English glosses, Korean definitions, and example sentences. Replaces the old CC-KEDICT pack with substantially better coverage and tone.",
    size: "~16 MB zipped · ~50k headwords · ~90k entries",
    license: "CC BY-SA 2.0 KR (NIKL)",
  },
  {
    // Yomitan-format Spanish Wiktionary export, built by yomidevs/
    // kaikki-to-yomitan. Replaces es-wiktionary as the recommended
    // default — same source data (English Wiktionary), but with
    // inflected forms broken out as their own rows ("voy" →
    // "first-person singular present of ir") and structured-content
    // glosses. The plain `es-wiktionary` pack stays available below
    // for users who already installed it.
    id: "es-yomitan-wiktionary",
    name: "Spanish Wiktionary (Yomitan)",
    lang: "es",
    format: "yomitan",
    defaultUrl:
      "https://pub-c3d38cca4dc2403b88934c56748f5144.r2.dev/releases/latest/kty-es-en.zip",
    presets: [
      {
        label: "kty-es-en (kaikki-to-yomitan, latest)",
        url: "https://pub-c3d38cca4dc2403b88934c56748f5144.r2.dev/releases/latest/kty-es-en.zip",
      },
    ],
    description:
      "Spanish ↔ English dictionary derived from the English Wiktionary by yomidevs/kaikki-to-yomitan — ~23 MB zip with inflected-form rows (está, voy, comimos) and structured glosses. Imports via the standard Yomitan term-bank format.",
    size: "~23 MB zipped · ~1.25M entries (incl. inflected forms)",
    license: "CC BY-SA (Wiktionary)",
  },
  {
    id: "es-wiktionary",
    name: "Spanish Wiktionary",
    lang: "es",
    format: "wiktionary-data",
    defaultUrl:
      "https://raw.githubusercontent.com/doozan/spanish_data/master/es-en.data",
    presets: [
      {
        label: "doozan/spanish_data (en.wiktionary export)",
        url: "https://raw.githubusercontent.com/doozan/spanish_data/master/es-en.data",
      },
      // Kept around as a fallback for users on networks that block raw
      // github content but allow the regular UI host.
      {
        label: "GitHub blob URL (mirror)",
        url: "https://github.com/doozan/spanish_data/raw/master/es-en.data",
      },
    ],
    description:
      "Spanish ↔ English dictionary built from the English Wiktionary by doozan/spanish_data — ~110k lemmas with parts of speech, etymologies, and English glosses. Inflected forms (voy, hablamos, …) resolve via Tokori's per-language lemmatizer.",
    size: "~17 MB · ~110k entries",
    license: "CC BY-SA (Wiktionary)",
  },

  // The Kaikki Wiktionary full-extract packs (zh/ja/ko/de/es) used to
  // live here. They were removed: de + es got Yomitan-Wiktionary
  // replacements (same upstream data, ~25 MB instead of ~1 GB), and
  // the CJK variants were dropped to keep the catalog focused on the
  // recommended curated dictionary per language. If someone needs the
  // full Kaikki extract for niche coverage they can still import it
  // by hand via the custom-dict upload UI.
];

/** Find every pack registered for a language. */
export function packsForLanguage(lang: LanguageCode): DictionaryPack[] {
  return DICTIONARY_PACKS.filter((p) => p.lang === lang);
}

/** Look up a pack by its stable id (handy for the `recommendedDict`
 *  field on a `LanguageProfile`). */
export function packById(id: string | null | undefined): DictionaryPack | null {
  if (!id) return null;
  return DICTIONARY_PACKS.find((p) => p.id === id) ?? null;
}

/**
 * Decide which parser the Rust side should use for a given pack +
 * URL combination. Most packs are 1:1, but JMdict offers both XML
 * (EDRDG canonical) and JSON (jmdict-simplified) under different
 * URLs — we sniff the extension and pick the right parser so users
 * don't have to.
 */
export function formatForUrl(pack: DictionaryPack, url: string): DictFormat {
  if (pack.format === "jmdict" || pack.format === "jmdict-xml") {
    const u = url.toLowerCase();
    if (u.endsWith(".json.tgz") || u.endsWith(".json.gz") || u.endsWith(".json")) {
      return "jmdict";
    }
    return "jmdict-xml";
  }
  return pack.format;
}
