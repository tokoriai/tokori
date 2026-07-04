/**
 * One side of a flashcard, rendered from an ordered list of field ids.
 *
 * Each card carries a `layout` ({ front, back }) and `<CardFace>` walks
 * the requested fields in order. The classic flip surfaces — the Browse
 * "open flashcard" preview and the Anki-style study mode — render
 * `layout.front` for the prompt and (on reveal) `layout.front` again
 * followed by `layout.back` for the answer, matching Anki's question +
 * answer reveal.
 *
 * Cloze handling: a card with `frontExtra` (the `{{c1::word}}` sentence)
 * masks the cloze when "word" is part of the FRONT face, and reveals it
 * everywhere else. Non-cloze cards just show the word.
 */

import { useEffect, useState } from "react";
import { GlossList } from "@/components/gloss-list";
import { Pinyin } from "@/components/pinyin";
import { SpeakButton } from "@/components/speak-button";
import type { FieldId } from "@/lib/card-layout";
import { getVocabImage, type VocabEntry } from "@/lib/db";
import { cn } from "@/lib/utils";

export type CardFaceProps = {
  /** Fields to render, in display order. */
  fields: readonly FieldId[];
  card: VocabEntry;
  /** Target language code for the Pinyin renderer + the speak button. */
  targetLang: string;
  /** Which side this face represents. On the FRONT of a cloze card the
   *  word is rendered as the masked sentence; on the BACK it's revealed
   *  (or just the plain word for non-cloze cards). Default "back". */
  side?: "front" | "back";
  /** Visual scale. Browse preview uses "lg"; study modes use "md". */
  size?: "md" | "lg";
  className?: string;
};

const CLOZE_RE = /\{\{c\d+::([^}]+)\}\}/g;

/** Strip cloze markers, revealing the answer. */
function revealCloze(s: string): string {
  return s.replace(CLOZE_RE, "$1");
}

/** Mask cloze markers — Anki-style underscored blank. */
function maskCloze(s: string): string {
  return s.replace(CLOZE_RE, "____");
}

export function CardFace({
  fields,
  card,
  targetLang,
  side = "back",
  size = "md",
  className,
}: CardFaceProps) {
  // List queries leave `imageData` null and surface only `hasImage`;
  // lazy-fetch the bytes on demand so the face renders without a
  // round-trip when the caller already has them.
  const initialImage = card.imageData ?? null;
  const [image, setImage] = useState<string | null>(initialImage);
  useEffect(() => {
    if (initialImage != null || !card.hasImage) {
      setImage(initialImage);
      return;
    }
    let cancelled = false;
    void getVocabImage(card.id)
      .then((b) => {
        if (!cancelled) setImage(b);
      })
      .catch(() => {
        /* ignore — face just renders without the image */
      });
    return () => {
      cancelled = true;
    };
  }, [card.id, card.hasImage, initialImage]);

  // Cloze cards: front masks the target word, back reveals it. Non-cloze
  // cards always show the plain word.
  const wordText = card.frontExtra
    ? side === "front"
      ? maskCloze(card.frontExtra)
      : revealCloze(card.frontExtra)
    : card.word;

  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 text-center",
        className,
      )}
    >
      {fields.map((f, i) => {
        const key = `${f}-${i}`;
        switch (f) {
          case "word":
            return (
              <div
                key={key}
                className={cn(
                  "font-serif tracking-tight",
                  size === "lg" ? "text-4xl" : "text-2xl",
                )}
              >
                {wordText}
              </div>
            );
          case "reading":
            return card.reading ? (
              <Pinyin
                key={key}
                raw={card.reading}
                className={size === "lg" ? "text-lg" : "text-sm"}
              />
            ) : null;
          case "definition":
            return card.gloss ? (
              <div
                key={key}
                className={cn(
                  "max-w-prose text-muted-foreground",
                  size === "lg" ? "text-base" : "text-[13.5px]",
                )}
              >
                <GlossList gloss={card.gloss} inline />
              </div>
            ) : null;
          case "translation":
            return card.translation ? (
              <div
                key={key}
                className={cn(
                  "max-w-prose",
                  size === "lg" ? "text-base" : "text-[13.5px]",
                )}
              >
                {card.translation}
              </div>
            ) : null;
          case "notes":
            return card.cardNotes ? (
              <p
                key={key}
                className={cn(
                  "max-w-prose italic text-muted-foreground",
                  size === "lg" ? "text-sm" : "text-xs",
                )}
              >
                {card.cardNotes}
              </p>
            ) : null;
          case "image":
            return image ? (
              <img
                key={key}
                src={image}
                alt=""
                className={cn(
                  "max-h-48 rounded-lg object-contain",
                  size === "lg" && "max-h-64",
                )}
              />
            ) : null;
          case "audio":
            return (
              <SpeakButton
                key={key}
                text={card.word}
                lang={targetLang}
                vocabId={card.id}
                cachedAudioAvailable={card.hasAudio}
              />
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
