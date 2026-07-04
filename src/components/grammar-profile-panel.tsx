import { useEffect, useState } from "react";
import { Loader2, RotateCcw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useProviderConfigs } from "@/lib/provider-context";
import { languageName, type LanguageCode } from "@/lib/languages";
import {
  GRAMMAR_KEY,
  parseGrammarProfile,
  type AdjectiveGrammar,
  type Gender,
  type GrammarPos,
  type GrammarProfile,
  type NounGrammar,
  type VerbGrammar,
} from "@/lib/grammar-profile";
import { cn } from "@/lib/utils";

const GENDER_LABEL: Record<Gender, string> = {
  m: "masculine",
  f: "feminine",
  n: "neuter",
  mf: "common",
};

// Person labels to pair with the model's present-tense forms when the
// count lines up. Keyed by language; absent languages just show the
// forms without labels.
const PRESENT_PRONOUNS: Record<string, string[]> = {
  de: ["ich", "du", "er/sie/es", "wir", "ihr", "sie/Sie"],
  es: ["yo", "tú", "él/ella", "nosotros", "vosotros", "ellos"],
};

/**
 * AI-generated grammar breakdown for a Latin-script headword (de/es).
 * The owning detail page holds the canonical `profile` so the right-rail
 * "at a glance" card can share it; this panel loads the localStorage
 * cache on word change and runs the generation. No DB write — the profile
 * is regenerable, cached per word on the device.
 */
export function GrammarProfilePanel({
  lang,
  word,
  nativeLang,
  profile,
  onProfile,
}: {
  lang: LanguageCode;
  word: string;
  nativeLang: LanguageCode;
  profile: GrammarProfile | null;
  onProfile: (p: GrammarProfile | null) => void;
}) {
  const { active: provider, sendChat } = useProviderConfigs();
  const [busy, setBusy] = useState(false);

  // Hydrate from cache whenever the word changes; clears to null when the
  // word has no cached profile yet so the empty state shows.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(GRAMMAR_KEY(lang, word));
      onProfile(raw ? (JSON.parse(raw) as GrammarProfile) : null);
    } catch {
      onProfile(null);
    }
    // onProfile is a stable setState; re-run only on word/lang change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, word]);

  async function generate() {
    if (!provider) {
      toast.error("Configure a provider in Settings first");
      return;
    }
    setBusy(true);
    try {
      const target = languageName(lang);
      const native = languageName(nativeLang);
      const system =
        `You are a precise ${target} grammar reference. Reply with ONE JSON ` +
        `object only — no prose, no markdown fences. Include ONLY the keys ` +
        `that apply to the word's part of speech; omit empty fields. ` +
        `Conjugate verbs in canonical person order. At most two short usage ` +
        `notes (in ${native}); at most four synonyms.`;
      const reply = await sendChat({
        messages: [
          { role: "system", content: system },
          { role: "user", content: buildUserPrompt(word, target, native) },
        ],
        onToken: () => {},
      });
      const parsed = parseGrammarProfile(reply);
      if (!parsed) {
        toast.error("Couldn't read the grammar details", {
          description: "Try regenerating, or switch provider.",
        });
        return;
      }
      // Persist the re-serialised validated object (not the raw model
      // text) so the cache is always clean.
      localStorage.setItem(GRAMMAR_KEY(lang, word), JSON.stringify(parsed));
      onProfile(parsed);
      toast.success(`Grammar details for ${word}`);
    } catch (err) {
      toast.error("Couldn't generate", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Grammar
        </h3>
        <Button
          size="sm"
          variant="ghost"
          onClick={generate}
          disabled={busy || !provider}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : profile ? (
            <RotateCcw className="size-3.5" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          {profile ? "Regenerate" : "Generate"}
        </Button>
      </div>
      {profile ? (
        <GrammarBody profile={profile} lang={lang} />
      ) : (
        <p className="text-[12.5px] text-muted-foreground">
          Generate a structured breakdown — gender, plural, conjugations,
          register, and synonyms — with the active AI provider. Saved on this
          device.
        </p>
      )}
    </div>
  );
}

function buildUserPrompt(word: string, target: string, native: string): string {
  return [
    `Analyse the ${target} word "${word}" for a ${native} speaker.`,
    `Reply with a JSON object using ONLY the keys that apply:`,
    `{`,
    `  "pos": "noun|verb|adjective|adverb|preposition|conjunction|pronoun|other",`,
    `  "lemma": "<dictionary form>",`,
    `  "register": "neutral|formal|informal|vulgar|literary",`,
    `  "noun": { "gender": "m|f|n|mf", "article": "<definite article>", "plural": "<plural form>" },`,
    `  "verb": { "infinitive": "<infinitive>", "auxiliary": "<perfect auxiliary>", "separablePrefix": "<prefix, omit if none>", "present": ["<every present-tense person, in order>"], "past": "<simple past, 3rd person singular>", "participle": "<past participle>" },`,
    `  "adjective": { "comparative": "<comparative>", "superlative": "<superlative>" },`,
    `  "synonyms": ["<up to 4>"],`,
    `  "notes": ["<up to 2 short ${native} usage notes>"]`,
    `}`,
    `Omit the "noun"/"verb"/"adjective" objects that don't match the part of speech. No markdown, no commentary.`,
  ].join("\n");
}

function GrammarBody({
  profile,
  lang,
}: {
  profile: GrammarProfile;
  lang: string;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <PosChip pos={profile.pos} />
        {profile.noun?.gender && (
          <GenderChip gender={profile.noun.gender} article={profile.noun.article} />
        )}
        {profile.register && profile.register !== "neutral" && (
          <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            {profile.register}
          </span>
        )}
      </div>

      {profile.noun && <NounTable noun={profile.noun} />}
      {profile.verb && <VerbTable verb={profile.verb} lang={lang} />}
      {profile.adjective && <AdjectiveTable adjective={profile.adjective} />}

      {profile.synonyms && profile.synonyms.length > 0 && (
        <div>
          <p className="mb-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            Synonyms
          </p>
          <div className="flex flex-wrap gap-1">
            {profile.synonyms.map((s, i) => (
              <span
                key={i}
                className="rounded-md border border-border bg-muted/30 px-1.5 py-0.5 text-[12px]"
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      {profile.notes && profile.notes.length > 0 && (
        <ul className="space-y-1">
          {profile.notes.map((n, i) => (
            <li
              key={i}
              className="flex gap-1.5 text-[12.5px] leading-snug text-muted-foreground"
            >
              <span className="text-muted-foreground/50">•</span>
              <span>{n}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Part-of-speech pill. Exported so the at-a-glance card matches. */
export function PosChip({ pos }: { pos: GrammarPos }) {
  return (
    <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
      {pos}
    </span>
  );
}

/** Gender pill, colour-coded by grammatical gender (theme palette utilities,
 *  not ad-hoc hex). Exported for the at-a-glance card. */
export function GenderChip({
  gender,
  article,
}: {
  gender: Gender;
  article?: string;
}) {
  const styles: Record<Gender, string> = {
    m: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    f: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    n: "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    mf: "border-border bg-muted/40 text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider",
        styles[gender],
      )}
    >
      {article ? `${article} · ` : ""}
      {GENDER_LABEL[gender]}
    </span>
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-24 shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="text-[13.5px] text-foreground/90">{value}</span>
    </div>
  );
}

function NounTable({ noun }: { noun: NounGrammar }) {
  if (!noun.article && !noun.gender && !noun.plural) return null;
  return (
    <div className="space-y-1 rounded-lg border border-border bg-background/40 p-2.5">
      {noun.article && <FieldRow label="Article" value={noun.article} />}
      {noun.gender && <FieldRow label="Gender" value={GENDER_LABEL[noun.gender]} />}
      {noun.plural && <FieldRow label="Plural" value={noun.plural} />}
    </div>
  );
}

function VerbTable({ verb, lang }: { verb: VerbGrammar; lang: string }) {
  const pronouns = PRESENT_PRONOUNS[lang];
  const labelled =
    verb.present && pronouns && verb.present.length === pronouns.length;
  const hasParts =
    verb.infinitive || verb.past || verb.participle || verb.separablePrefix;
  return (
    <div className="space-y-2 rounded-lg border border-border bg-background/40 p-2.5">
      {verb.present && verb.present.length > 0 && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 sm:grid-cols-3">
          {verb.present.map((f, i) => (
            <div key={i} className="flex items-baseline gap-1.5 text-[13px]">
              {labelled && (
                <span className="text-[11px] text-muted-foreground">
                  {pronouns![i]}
                </span>
              )}
              <span className="font-medium">{f}</span>
            </div>
          ))}
        </div>
      )}
      {hasParts && (
        <div className="space-y-1 border-t border-border/50 pt-2">
          {verb.infinitive && <FieldRow label="Infinitive" value={verb.infinitive} />}
          {verb.past && <FieldRow label="Past" value={verb.past} />}
          {verb.participle && (
            <FieldRow
              label="Participle"
              value={
                verb.auxiliary
                  ? `${verb.auxiliary} ${verb.participle}`
                  : verb.participle
              }
            />
          )}
          {verb.separablePrefix && (
            <FieldRow label="Separable" value={verb.separablePrefix} />
          )}
        </div>
      )}
    </div>
  );
}

function AdjectiveTable({ adjective }: { adjective: AdjectiveGrammar }) {
  if (!adjective.comparative && !adjective.superlative) return null;
  return (
    <div className="space-y-1 rounded-lg border border-border bg-background/40 p-2.5">
      {adjective.comparative && (
        <FieldRow label="Comparative" value={adjective.comparative} />
      )}
      {adjective.superlative && (
        <FieldRow label="Superlative" value={adjective.superlative} />
      )}
    </div>
  );
}
