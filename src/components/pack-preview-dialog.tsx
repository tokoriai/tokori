/**
 * Pack preview — shows everything a user needs to decide whether to
 * install a pack before they commit. Used from the Browse list in
 * PacksBrowser; layered on top of whatever dialog the browser is
 * embedded in.
 *
 * Two input shapes:
 *
 *   { pack: Pack }       — full parsed pack. Free packs load via their
 *                          static import; user-supplied JSON arrives
 *                          here after drop+validate. We can render the
 *                          full preview (chapter titles, sample words).
 *
 *   { storePack }        — paid pack metadata only (server-side catalog
 *                          row). Description + counts. Full contents
 *                          are gated by purchase; redeeming after buy
 *                          reuses the `pack` path via the cloud
 *                          downloadPack endpoint.
 */

import { BookOpen, Loader2, Package } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { StorePack } from "@/lib/cloud-context";
import { summarisePack, type Pack, type PackWord } from "@/lib/pack-import";
import { languageName } from "@/lib/languages";

const MAX_CHAPTER_TITLES = 8;
const MAX_SAMPLE_WORDS = 12;

export function PackPreviewDialog({
  pack,
  storePack,
  loading,
  primaryAction,
  onClose,
}: {
  /** Parsed pack — when present, we render the rich preview. */
  pack?: Pack | null;
  /** Paid-pack catalog entry — when present (and `pack` is absent),
   *  we render the lightweight "metadata only" view. */
  storePack?: StorePack | null;
  /** Show a spinner instead of content while a free pack is loading. */
  loading?: boolean;
  /** Optional primary CTA — "Install", "Buy", "Redeem", etc. The
   *  parent owns the action; we just render the button. */
  primaryAction?: { label: string; onClick: () => void; disabled?: boolean };
  onClose: () => void;
}) {
  const open = loading || pack != null || storePack != null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="size-4" />
            {pack?.name ?? storePack?.name ?? "Pack preview"}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          {loading && (
            <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading pack preview…
            </p>
          )}

          {!loading && pack && <FullPreview pack={pack} />}

          {!loading && !pack && storePack && (
            <StoreOnlyPreview store={storePack} />
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {primaryAction && (
            <Button
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled}
            >
              {primaryAction.label}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FullPreview({ pack }: { pack: Pack }) {
  const summary = summarisePack(pack);
  // Pull a representative sample of words: first words of the first
  // collection if present, else the first chapter's vocab. Twelve
  // is enough to read the tone of the pack ("everyday vocab" vs
  // "academic register") without dumping the whole list.
  const sample = collectSample(pack);

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-2 text-[12px] text-muted-foreground">
        <Badge variant="outline" className="text-[10.5px] uppercase">
          {languageName(pack.language)}
        </Badge>
        {pack.version && <span>Version {pack.version}</span>}
        {pack.license && <span>· {pack.license}</span>}
      </div>

      {pack.description && (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {pack.description}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Words" value={summary.collectionWordCount + summary.textbookVocabCount} />
        <StatTile label="Collections" value={summary.collectionCount} />
        <StatTile label="Textbooks" value={summary.textbookCount} />
        <StatTile label="Chapters" value={summary.textbookChapterCount} />
      </div>

      {pack.textbooks && pack.textbooks.length > 0 && (
        <div className="space-y-2">
          {pack.textbooks.map((tb) => (
            <div
              key={tb.id}
              className="rounded-md border border-border bg-card px-3 py-2.5"
            >
              <div className="flex items-baseline justify-between gap-2">
                <h4 className="text-[13px] font-medium">
                  <BookOpen className="mr-1.5 inline size-3.5 text-muted-foreground" />
                  {tb.title}
                </h4>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {tb.chapters.length} chapter
                  {tb.chapters.length === 1 ? "" : "s"}
                </span>
              </div>
              <ol className="mt-2 grid grid-cols-1 gap-x-4 gap-y-0.5 text-[11.5px] text-muted-foreground sm:grid-cols-2">
                {tb.chapters.slice(0, MAX_CHAPTER_TITLES).map((c, i) => (
                  <li key={i} className="truncate">
                    <span className="tabular-nums text-foreground/60">
                      {String(i + 1).padStart(2, "0")}.
                    </span>{" "}
                    {c.title}
                  </li>
                ))}
                {tb.chapters.length > MAX_CHAPTER_TITLES && (
                  <li className="text-foreground/60">
                    + {tb.chapters.length - MAX_CHAPTER_TITLES} more…
                  </li>
                )}
              </ol>
            </div>
          ))}
        </div>
      )}

      {sample.length > 0 && (
        <div className="rounded-md border border-border bg-card px-3 py-2.5">
          <h4 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Sample words
          </h4>
          <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px]">
            {sample.map((w, i) => (
              <li key={i}>
                <span className="font-medium">{w.word}</span>
                {w.reading && (
                  <span className="ml-1 text-muted-foreground">
                    [{w.reading}]
                  </span>
                )}
                {w.gloss && (
                  <span className="ml-1 text-muted-foreground">— {w.gloss}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function StoreOnlyPreview({ store }: { store: StorePack }) {
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-2 text-[12px] text-muted-foreground">
        <Badge variant="outline" className="text-[10.5px] uppercase">
          {languageName(store.language)}
        </Badge>
        <span>${(store.priceCents / 100).toFixed(2)} USD</span>
      </div>

      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {store.description}
      </p>

      {store.meta && (
        <div className="grid grid-cols-3 gap-2">
          {store.meta.wordCount != null && (
            <StatTile label="Words" value={store.meta.wordCount} />
          )}
          {store.meta.chapterCount != null && (
            <StatTile label="Chapters" value={store.meta.chapterCount} />
          )}
          {store.meta.author && (
            <div className="rounded-md border border-border bg-background px-3 py-2">
              <div className="text-[10.5px] uppercase tracking-wider text-muted-foreground">
                Author
              </div>
              <div className="mt-0.5 truncate text-[12px] font-medium">
                {store.meta.author}
              </div>
            </div>
          )}
        </div>
      )}

      <p className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-[12px] text-muted-foreground">
        Full contents are visible after purchase — buy to redeem the pack
        with chapter activation, sample sentences, and the full word list.
      </p>
    </>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className="text-[10.5px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums tracking-tight">
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function collectSample(pack: Pack): PackWord[] {
  const out: PackWord[] = [];
  const seen = new Set<string>();
  const push = (w: PackWord) => {
    if (seen.has(w.word)) return;
    seen.add(w.word);
    out.push(w);
  };
  for (const c of pack.collections ?? []) {
    for (const w of c.words) {
      push(w);
      if (out.length >= MAX_SAMPLE_WORDS) return out;
    }
  }
  for (const tb of pack.textbooks ?? []) {
    for (const ch of tb.chapters) {
      for (const w of ch.vocab ?? []) {
        push(w);
        if (out.length >= MAX_SAMPLE_WORDS) return out;
      }
    }
  }
  return out;
}
