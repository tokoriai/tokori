import { useEffect, useState } from "react";
import { ClipboardPaste, Loader2 } from "lucide-react";
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
import { useWorkspace } from "@/lib/workspace-context";

/**
 * Lingq-style "paste any text" import. The user drops in a passage they found
 * elsewhere — an article, song lyrics, a transcript — and we save it as a
 * reader doc with click-to-define on every word.
 *
 * No AI involved, no API costs. The body is stored verbatim.
 */
export function PasteTextDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: (title: string, body: string, sourceUrl: string | null) => void | Promise<void>;
}) {
  const { active: workspace } = useWorkspace();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setTitle("");
      setBody("");
      setSourceUrl("");
      setBusy(false);
    }
  }, [open]);

  if (!workspace) return null;

  async function tryFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setBody(text);
        if (!title.trim()) {
          // Derive a default title from the first non-empty line, capped at ~60 chars.
          const firstLine = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
          setTitle(firstLine.trim().slice(0, 60));
        }
        toast(`Pasted ${text.length.toLocaleString()} characters`);
      }
    } catch {
      toast.error("Clipboard access blocked", {
        description: "Paste manually with ⌘V / Ctrl+V into the box below.",
      });
    }
  }

  async function importNow() {
    const trimmedBody = body.trim();
    if (!trimmedBody) return;
    setBusy(true);
    try {
      const finalTitle =
        title.trim() ||
        trimmedBody.split(/\r?\n/).find((l) => l.trim())?.slice(0, 60) ||
        "Pasted passage";
      await onImported(finalTitle, trimmedBody, sourceUrl.trim() || null);
      toast.success("Saved to reader");
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const charCount = body.length;
  const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardPaste className="size-5" />
            Paste text
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <p className="text-[12.5px] text-muted-foreground">
            Drop in any passage you want to read with click-to-define — articles, lyrics,
            transcripts, book chapters. Stays local, no AI calls, no quota.
          </p>

          <div className="grid gap-1.5">
            <Label htmlFor="paste-title">Title</Label>
            <Input
              id="paste-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="optional — first line is used if blank"
              disabled={busy}
            />
          </div>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="paste-body">Body</Label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={tryFromClipboard}
                disabled={busy}
                className="h-6 px-2 text-[11px]"
              >
                <ClipboardPaste className="size-3" />
                Paste from clipboard
              </Button>
            </div>
            <textarea
              id="paste-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              placeholder={`Paste your passage here…\n\nClick-to-define and TTS work on every word once saved.`}
              className="resize-y rounded-md border border-input bg-background px-3 py-2 text-[14px] leading-relaxed shadow-xs focus:outline-none focus:ring-2 focus:ring-ring"
              disabled={busy}
              autoFocus
            />
            {charCount > 0 && (
              <p className="text-[11px] text-muted-foreground">
                {charCount.toLocaleString()} chars · {wordCount.toLocaleString()} words
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="paste-url">Source URL (optional)</Label>
            <Input
              id="paste-url"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://… (where this came from)"
              disabled={busy}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={importNow} disabled={busy || !body.trim()}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            Save to reader
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
