import { useEffect, useRef, useState } from "react";
import { BookOpen, FileUp, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseBook, type ParsedBook } from "@/lib/book-import";
import {
  saveLibraryItem,
  saveReaderDoc,
} from "@/lib/db";
import { useWorkspace } from "@/lib/workspace-context";

/**
 * Book import — upload a PDF / .txt, parse into chapters, save.
 *
 * Flow:
 *   1. User picks a file. We parse client-side via book-import.ts.
 *   2. We show a chapter preview so the user can confirm the split worked.
 *   3. On import, we create a `LibraryItem (kind="ebook")` plus one
 *      `reader_document` per chapter with chapter_position + library_item_id.
 *   4. The first chapter becomes the active reader doc so the user lands
 *      directly on something readable.
 */
export function BookImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: (firstChapterId: number, libraryItemId: number) => void | Promise<void>;
}) {
  const { active: workspace } = useWorkspace();
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedBook | null>(null);
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setFile(null);
      setParsed(null);
      setTitle("");
      setAuthor("");
      setError(null);
      setParsing(false);
      setImporting(false);
    }
  }, [open]);

  async function handleFile(f: File | null | undefined) {
    if (!f) return;
    setFile(f);
    setError(null);
    setParsing(true);
    try {
      const book = await parseBook(f);
      setParsed(book);
      if (!title.trim()) setTitle(book.title);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setParsed(null);
    } finally {
      setParsing(false);
    }
  }

  async function importNow() {
    if (!workspace || !parsed || parsed.chapters.length === 0) return;
    setImporting(true);
    try {
      // 1. Create the parent library item so the chapters have something to
      //    hang off — that drives "next/prev chapter" UI in the reader.
      const item = await saveLibraryItem({
        workspaceId: workspace.id,
        kind: "ebook",
        title: title.trim() || parsed.title,
        author: author.trim() || null,
        totalUnits: parsed.chapters.length,
        unitLabel: "chapters",
        completedUnits: 0,
        status: "active",
      });

      // 2. One reader_document per chapter.
      const savedIds: number[] = [];
      for (const ch of parsed.chapters) {
        const saved = await saveReaderDoc({
          workspaceId: workspace.id,
          title: ch.title,
          body: ch.body,
          libraryItemId: item.id,
          chapterPosition: ch.position,
          level: "original",
        });
        savedIds.push(saved.id);
      }

      toast.success(
        `Imported "${item.title}" — ${parsed.chapters.length} chapter${
          parsed.chapters.length === 1 ? "" : "s"
        }`,
      );
      await onImported(savedIds[0], item.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !importing && !parsing && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="size-5" />
            Import a book
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <p className="text-[12.5px] text-muted-foreground">
            Drop in a PDF or .txt file. The text gets split into chapters and saved as a book —
            click any word for a definition, switch the difficulty level later, drill the vocab
            in flashcards. Stays local; no upload.
          </p>

          <div>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.txt,.md,.markdown,.epub"
              className="hidden"
              onChange={(e) => {
                void handleFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              onClick={() => fileRef.current?.click()}
              disabled={parsing || importing}
            >
              <FileUp className="size-4" />
              Choose file
            </Button>
            {file && (
              <span className="ml-3 text-[12.5px] text-muted-foreground">
                {file.name} · {(file.size / 1024).toFixed(0)} KB
              </span>
            )}
          </div>

          {parsing && (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Parsing chapters…
            </div>
          )}

          {parsed && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="book-title">Title</Label>
                  <Input
                    id="book-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    disabled={importing}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="book-author">Author (optional)</Label>
                  <Input
                    id="book-author"
                    value={author}
                    onChange={(e) => setAuthor(e.target.value)}
                    placeholder="e.g. 鲁迅"
                    disabled={importing}
                  />
                </div>
              </div>

              <div className="rounded-md border border-border bg-muted/30 px-3 py-3 text-[12.5px]">
                <p className="font-medium text-foreground">
                  {parsed.chapters.length} chapter{parsed.chapters.length === 1 ? "" : "s"}{" "}
                  · {Math.round(parsed.totalChars / 1000)}k characters
                </p>
                <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto">
                  {parsed.chapters.slice(0, 30).map((c) => (
                    <li
                      key={c.position}
                      className="flex items-center justify-between gap-3 truncate text-muted-foreground"
                    >
                      <span className="truncate">
                        {c.position + 1}. {c.title}
                      </span>
                      <span className="shrink-0 text-[11px] opacity-70">
                        {Math.round(c.body.length / 100) / 10}k chars
                      </span>
                    </li>
                  ))}
                  {parsed.chapters.length > 30 && (
                    <li className="italic opacity-70">
                      …and {parsed.chapters.length - 30} more.
                    </li>
                  )}
                </ul>
                {parsed.chapters.length === 1 && (
                  <p className="mt-2 text-[11.5px] text-muted-foreground/80">
                    Couldn't detect chapter headings — saving as a single chapter. You can edit
                    the file (add "Chapter 1", "第一章" etc.) and re-import to split.
                  </p>
                )}
              </div>
            </>
          )}

          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive whitespace-pre-line">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={importing || parsing}>
            Cancel
          </Button>
          <Button
            onClick={importNow}
            disabled={!parsed || importing || parsing || !title.trim()}
          >
            {importing && <Loader2 className="size-3.5 animate-spin" />}
            Import book
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
