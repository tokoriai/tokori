/**
 * ```passage block renderer — the tutor's generated reading texts
 * (stories, dialogues, essays on a topic) get a dedicated card instead
 * of running inline with the chat prose: serif target-language body
 * with the full click-to-define + ruby treatment, and an action header
 * for listening to it (TTS) or keeping it (saved into the Reader as a
 * document, then opened there).
 *
 * Block contract (taught in the chat system prompt):
 *   ```passage
 *   # 我的一天            ← optional title line
 *   target-language text …
 *   ```
 * `((…))` translations inside the body still blur like everywhere else.
 */

import { useMemo, useState } from "react";
import { BookOpenText, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { SpeakButton } from "@/components/speak-button";
import { Tokenized } from "@/components/tokenized";
import { BlurredTranslation, splitOnTranslations } from "@/components/chat-markdown";
import { saveReaderDoc } from "@/lib/db";
import { navigateToTab } from "@/lib/nav-event";
import { requestOpenReaderDoc } from "@/lib/reader-open-event";
import { useWorkspace } from "@/lib/workspace-context";
import type { LanguageCode } from "@/lib/languages";

export function parsePassage(raw: string): { title: string | null; body: string } {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  const m = text.match(/^#\s+(.+)\n+/);
  if (!m) return { title: null, body: text };
  return { title: m[1].trim(), body: text.slice(m[0].length).trim() };
}

export function PassageCard({ raw }: { raw: string }) {
  const { active: workspace } = useWorkspace();
  const lang = workspace?.targetLang ?? "en";
  const { title, body } = useMemo(() => parsePassage(raw), [raw]);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<number | null>(null);

  // TTS reads the plain passage — translations inside ((…)) are the
  // student's crutch, not part of the text.
  const speakText = useMemo(
    () =>
      splitOnTranslations(body)
        .filter((p) => p.kind === "text")
        .map((p) => p.value)
        .join(" ")
        .trim(),
    [body],
  );

  async function addToReader() {
    if (!workspace || saving) return;
    setSaving(true);
    try {
      const doc = await saveReaderDoc({
        workspaceId: workspace.id,
        title: title ?? body.slice(0, 40),
        body,
      });
      setSavedId(doc.id);
      toast.success("Added to Reader", {
        description: title ?? undefined,
        action: {
          label: "Open",
          onClick: () => {
            navigateToTab("reader");
            requestOpenReaderDoc(doc.id);
          },
        },
      });
    } catch (err) {
      toast.error("Couldn't add to Reader", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  if (!body) return null;

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-border bg-card/60">
      {/* Action header — same eyebrow style as the vocab block. */}
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5">
        <BookOpenText className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {title ?? "Reading passage"}
        </span>
        {speakText && (
          <SpeakButton text={speakText} lang={lang as LanguageCode} size="sm" title="Listen" />
        )}
        <button
          type="button"
          onClick={() => {
            if (savedId != null) {
              navigateToTab("reader");
              requestOpenReaderDoc(savedId);
            } else {
              void addToReader();
            }
          }}
          disabled={saving}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-accent/60 hover:text-foreground disabled:opacity-60"
          title={
            savedId != null
              ? "Open in the Reader"
              : "Save this passage as a Reader document"
          }
        >
          {saving ? (
            <Loader2 className="size-3 animate-spin" />
          ) : savedId != null ? (
            <Check className="size-3 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <BookOpenText className="size-3" />
          )}
          {savedId != null ? "In Reader — open" : "Add to Reader"}
        </button>
      </div>

      <div className="space-y-3 px-4 py-3 font-serif text-[16.5px] leading-loose">
        {title && <h4 className="text-[19px] font-semibold leading-snug">{title}</h4>}
        {body.split(/\n{2,}/).map((para, i) => (
          <p key={i}>
            {splitOnTranslations(para.replace(/\n/g, " ")).map((part, j) =>
              part.kind === "translation" ? (
                <BlurredTranslation key={j} text={part.value} />
              ) : (
                <Tokenized key={j} text={part.value} lang={lang} />
              ),
            )}
          </p>
        ))}
      </div>
    </div>
  );
}
