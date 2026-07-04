import type { ReactNode } from "react";
import { SpeakButton } from "@/components/speak-button";
import { GenderChip, PosChip } from "@/components/grammar-profile-panel";
import { parseGlossSenses } from "@/components/gloss-list";
import type { GrammarProfile } from "@/lib/grammar-profile";
import type { DictEntry } from "@/lib/db";

/**
 * German / Spanish right-rail "at a glance" card. Deterministic-first: it
 * always shows the headword, TTS, and a sense count even before any AI
 * runs. When a grammar profile has been generated (shared down from the
 * detail page so it stays in sync with the left-column panel), it surfaces
 * the condensed essentials — gender/article, plural, or a verb's principal
 * parts — leaving the full tables to the panel below.
 */
export function GlanceCard({
  lang,
  word,
  entry,
  profile,
}: {
  lang: string;
  word: string;
  entry: DictEntry | null;
  profile: GrammarProfile | null;
}) {
  const senseCount = parseGlossSenses(entry?.gloss).length;
  const principalParts = profile?.verb
    ? [profile.verb.infinitive, profile.verb.past, profile.verb.participle]
        .filter((p): p is string => !!p)
        .join(" · ")
    : "";
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 font-serif text-2xl leading-tight">{word}</div>
        <SpeakButton text={word} lang={lang} size="sm" />
      </div>

      {profile ? (
        <div className="flex flex-wrap gap-1.5">
          <PosChip pos={profile.pos} />
          {profile.noun?.gender && (
            <GenderChip
              gender={profile.noun.gender}
              article={profile.noun.article}
            />
          )}
          {profile.noun?.plural && <GlanceChip>pl. {profile.noun.plural}</GlanceChip>}
          {principalParts && <GlanceChip>{principalParts}</GlanceChip>}
          {profile.adjective?.comparative && (
            <GlanceChip>{profile.adjective.comparative}</GlanceChip>
          )}
        </div>
      ) : (
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          {senseCount > 0
            ? `${senseCount} sense${senseCount === 1 ? "" : "s"} · `
            : ""}
          Generate grammar details below for gender, plural, and conjugations.
        </p>
      )}
    </div>
  );
}

function GlanceChip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md border border-border bg-muted/30 px-1.5 py-0.5 text-[12px]">
      {children}
    </span>
  );
}
