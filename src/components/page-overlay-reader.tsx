import { useEffect, useMemo, useState } from "react";
import { ImageOff, Loader2 } from "lucide-react";
import { WordPopover } from "@/components/word-popover";
import {
  type DictEntry,
  type VocabStatus,
  getPageLayout,
  getSourceDocumentBytes,
} from "@/lib/db";
import { lookupDictCached, lookupVocabStatus } from "@/lib/word-lookup";
import { type LookupResult, fromDict, fromMini } from "@/lib/lookup-result";
import { type WordBox, pageTextForWords } from "@/lib/word-boxing";
import type { LanguageCode } from "@/lib/languages";
import { useWorkspace } from "@/lib/workspace-context";
import { cn } from "@/lib/utils";

/**
 * A page image with clickable word hotspots laid over it. Words are
 * page-relative `[0..1]`, so the hotspots track the rendered size with `%`
 * — zoom/DPI-independent, no resize maths. Each hotspot reuses `WordPopover`
 * (overlay variant), so hover-to-define, the SRS underline, save-to-vocab,
 * and the sentence analyzer all work exactly as they do in flowing text.
 */
export function PageOverlay({
  imageUrl,
  words,
  lang,
  className,
}: {
  imageUrl: string;
  words: WordBox[];
  lang: LanguageCode;
  className?: string;
}) {
  const { active: workspace } = useWorkspace();
  const [entries, setEntries] = useState<Map<string, LookupResult | null>>(
    () => new Map(),
  );
  const [statuses, setStatuses] = useState<Map<string, VocabStatus>>(
    () => new Map(),
  );

  // Running page text + each word's offset into it, so the analyzer / cloze
  // get the surrounding sentence (same contract as Tokenized's sourceText).
  const { pageText, offsets } = useMemo(
    () => pageTextForWords(words, lang),
    [words, lang],
  );

  // Key on the word set, not the array identity, so a re-render with an
  // equivalent `words` prop doesn't re-fire the batch lookup.
  const wordsKey = useMemo(() => words.map((w) => w.text).join(""), [words]);

  useEffect(() => {
    const uniq = Array.from(new Set(words.map((w) => w.text)));
    if (uniq.length === 0) return;
    let cancelled = false;
    // Same coalescing caches as Tokenized: dict entries are session-cached,
    // vocab status is fetched fresh so the underline reflects latest SRS.
    Promise.all([
      lookupDictCached(lang, uniq).catch(() => new Map<string, DictEntry>()),
      workspace
        ? lookupVocabStatus(workspace.id, uniq).catch(
            () => new Map<string, VocabStatus>(),
          )
        : Promise.resolve(new Map<string, VocabStatus>()),
    ]).then(([dictMap, statusMap]) => {
      if (cancelled) return;
      const next = new Map<string, LookupResult | null>();
      for (const w of uniq) {
        const hit = dictMap.get(w);
        next.set(w, hit ? fromDict(hit) : lang === "zh" ? fromMini(w) : null);
      }
      setEntries(next);
      setStatuses(statusMap);
    });
    return () => {
      cancelled = true;
    };
    // Keyed on the word set (not array identity) so an equivalent `words`
    // prop doesn't re-fire the batch lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wordsKey, lang, workspace?.id]);

  return (
    <div className={cn("relative w-full select-none", className)}>
      <img
        src={imageUrl}
        alt=""
        draggable={false}
        className="block w-full rounded-md"
      />
      {/* Overlay layer: transparent except the hotspots, so gaps fall
          through to the image (future zoom/pan). */}
      <div className="pointer-events-none absolute inset-0">
        {words.map((w, i) => {
          const entry =
            entries.get(w.text) ?? (lang === "zh" ? fromMini(w.text) : null);
          const status = statuses.get(w.text) ?? null;
          return (
            <div
              key={`${i}:${w.text}`}
              className="pointer-events-auto absolute"
              style={{
                left: `${w.x * 100}%`,
                top: `${w.y * 100}%`,
                width: `${w.w * 100}%`,
                height: `${w.h * 100}%`,
              }}
            >
              <WordPopover
                variant="overlay"
                word={w.text}
                entry={entry}
                status={status}
                lang={lang}
                sourceText={pageText}
                sourceOffset={offsets[i] ?? 0}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; url: string; words: WordBox[] };

/**
 * DB-backed single page: loads the stored image bytes + its word layout and
 * renders a {@link PageOverlay}. Used for a saved note's attached capture.
 * (Multi-page PDF navigation is Phase 2.)
 */
export function SourceDocPageOverlay({
  sourceDocumentId,
  pageIndex = 0,
  lang,
  className,
}: {
  sourceDocumentId: number;
  pageIndex?: number;
  lang: LanguageCode;
  className?: string;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const [doc, layout] = await Promise.all([
          getSourceDocumentBytes(sourceDocumentId),
          getPageLayout(sourceDocumentId, pageIndex),
        ]);
        if (cancelled) return;
        if (!doc) {
          setState({ kind: "error" });
          return;
        }
        // Copy into a fresh ArrayBuffer — Blob's typing rejects a
        // Uint8Array that might be backed by a SharedArrayBuffer.
        const buf = new ArrayBuffer(doc.bytes.byteLength);
        new Uint8Array(buf).set(doc.bytes);
        objectUrl = URL.createObjectURL(new Blob([buf], { type: doc.mime }));
        setState({ kind: "ready", url: objectUrl, words: layout?.words ?? [] });
      } catch {
        if (!cancelled) setState({ kind: "error" });
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sourceDocumentId, pageIndex]);

  if (state.kind === "loading") {
    return (
      <div
        className={cn(
          "flex min-h-32 w-full items-center justify-center rounded-md border border-border/60 bg-muted/30",
          className,
        )}
      >
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div
        className={cn(
          "flex min-h-32 w-full flex-col items-center justify-center gap-1.5 rounded-md border border-border/60 bg-muted/30 text-muted-foreground",
          className,
        )}
      >
        <ImageOff className="size-5" />
        <span className="text-[12.5px]">Couldn't load the attached image.</span>
      </div>
    );
  }
  return (
    <PageOverlay
      imageUrl={state.url}
      words={state.words}
      lang={lang}
      className={className}
    />
  );
}
