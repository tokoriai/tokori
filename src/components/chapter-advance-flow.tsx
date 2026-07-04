/**
 * Shared "mark a chapter done + maybe push vocab" flow used by every
 * surface that lets the user advance through a textbook (Library list,
 * Dashboard widget, future deep-links from the chat). Lives in its
 * own file so the three modal states + dialogs only exist in one
 * place.
 *
 * The hook returns:
 *   • startAdvance(chapter)   — call when the user clicks Next/Mark
 *                                done. Either silently advances (when
 *                                there's no vocab to push) or opens
 *                                the pre-advance prompt.
 *   • pushChapterVocab(ch)    — call when the user clicks the per-
 *                                chapter "Add to flashcards" button.
 *                                Pushes due then opens the study
 *                                follow-up prompt.
 *   • dialogs                 — JSX to render somewhere in the tree.
 *                                Always renders; the AlertDialogs are
 *                                gated by their own state.
 *   • launchCustomStudy(col, {drill}) — exposed so callers can wire
 *                                other "study now" affordances to the
 *                                same handoff (matches the Library and
 *                                Collections views). `drill: true`
 *                                opens the session with drill mode on
 *                                (grades don't touch SRS) — the right
 *                                default for "drill this chapter"
 *                                buttons; flows that just pushed the
 *                                words due pass false for a real
 *                                review pass.
 */

import { useState } from "react";
import { Check, GraduationCap, Sparkles } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  listChapters,
  pushCollectionToDue,
  setChapterCompleted,
  type Collection,
  type LibraryChapter,
} from "@/lib/db";
import { queueCustomStudy } from "@/lib/study/custom-study";
import type { TabId } from "@/components/shell/shell";

export type ChapterAdvanceArgs = {
  /** The library_item id this flow operates on. We re-fetch chapters
   *  from this id after an advance so the post-advance "arrive" modal
   *  can reason about the *new* current chapter. */
  itemId: number;
  collections: Collection[];
  /** Vocab pushes are only meaningful for textbooks. Other kinds
   *  (novels, articles, etc.) just track completion. */
  isTextbook: boolean;
  onNavigate?: (tab: TabId) => void;
  onChange: () => void | Promise<void>;
};

export function useChapterAdvanceFlow({
  itemId,
  collections,
  isTextbook,
  onNavigate,
  onChange,
}: ChapterAdvanceArgs) {
  const [advancePrompt, setAdvancePrompt] = useState<{
    chapter: LibraryChapter;
    collection: Collection | null;
  } | null>(null);
  const [arrivePrompt, setArrivePrompt] = useState<{
    chapter: LibraryChapter;
    collection: Collection;
    nudged: number;
  } | null>(null);
  const [studyPrompt, setStudyPrompt] = useState<{
    collection: Collection;
    chapterTitle: string;
    nudged: number;
  } | null>(null);

  const launchCustomStudy = (
    collection: Collection,
    opts: { drill: boolean },
  ) => {
    queueCustomStudy(collection, opts);
    if (onNavigate) onNavigate("flashcards");
    else
      toast.success(
        `Queued "${collection.name}" — open Flashcards to study.`,
      );
  };

  function startAdvance(current: LibraryChapter | null) {
    if (!current) return;
    const linked = current.collectionId
      ? collections.find((c) => c.id === current.collectionId) ?? null
      : null;
    // No linked vocab → advance silently. We still mark complete so
    // the progress bar moves and the next chapter becomes current.
    if (!linked || (linked.wordCount ?? 0) === 0) {
      void completeAndAdvance(current, false);
      return;
    }
    setAdvancePrompt({ chapter: current, collection: linked });
  }

  async function completeAndAdvance(
    chapter: LibraryChapter,
    pushVocab: boolean,
  ) {
    const { vocabNudged } = await setChapterCompleted(chapter.id, true, {
      dueVocab: pushVocab && isTextbook,
    });
    if (pushVocab && vocabNudged > 0) {
      toast.success(
        `${vocabNudged.toLocaleString()} word${vocabNudged === 1 ? "" : "s"} now due`,
        {
          description: `From "${chapter.title}". Open Flashcards to drill them.`,
        },
      );
    }
    await onChange();
    if (!isTextbook) return;
    // Arrive prompt — fires when the next-current lesson has its own
    // linked vocab, so the user can pre-load it before reading.
    try {
      const fresh = await listChapters(itemId);
      const nextLesson = fresh
        .sort((a, b) => a.position - b.position)
        .find((c) => c.completedAt == null);
      if (!nextLesson || nextLesson.collectionId == null) return;
      const linked = collections.find((c) => c.id === nextLesson.collectionId);
      if (!linked || (linked.wordCount ?? 0) === 0) return;
      setArrivePrompt({
        chapter: nextLesson,
        collection: linked,
        nudged: linked.wordCount ?? 0,
      });
    } catch {
      /* network/db hiccup — silently skip the arrive prompt */
    }
  }

  async function pushChapterVocab(chapter: LibraryChapter) {
    if (chapter.collectionId == null) return;
    const linked = collections.find((c) => c.id === chapter.collectionId);
    if (!linked) return;
    try {
      const { vocabNudged } = await pushCollectionToDue(linked.id);
      // Surface the count even when 0 — silent success looks broken.
      setStudyPrompt({
        collection: linked,
        chapterTitle: chapter.title,
        nudged: vocabNudged,
      });
    } catch (err) {
      toast.error("Couldn't push vocabulary to due", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // All three modals use shadcn Dialog with a vertical button stack
  // instead of AlertDialog. AlertDialog's footer collapses three+
  // buttons into a horizontal row that overflows on narrower modals
  // (the dashboard widget surface in particular). Vertical lists scale
  // cleanly to any number of choices and read like a clear menu —
  // primary CTA at the top, secondary actions below, dismissive at
  // the bottom. The Dialog's Portal still mounts to body so the modal
  // is centered relative to the viewport, not whichever widget tree
  // owns the trigger.
  const dialogs = (
    <>
      {/* Pre-advance prompt — fires when the user clicks Next/Mark
          done on a chapter that has linked vocab. */}
      <Dialog
        open={advancePrompt != null}
        onOpenChange={(v) => {
          if (!v) setAdvancePrompt(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Add &ldquo;{advancePrompt?.chapter.title}&rdquo; vocab to flashcards?
            </DialogTitle>
            <DialogDescription>
              {advancePrompt?.collection
                ? `${(advancePrompt.collection.wordCount ?? 0).toLocaleString()} word${(advancePrompt.collection.wordCount ?? 0) === 1 ? "" : "s"} from "${advancePrompt.collection.name}" will be marked due so they show up in your next study session. The lecture will also be marked complete.`
                : "Mark this lecture complete and move to the next."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Button
              size="lg"
              onClick={async () => {
                const target = advancePrompt;
                setAdvancePrompt(null);
                if (!target) return;
                await completeAndAdvance(target.chapter, true);
                // Words were just pushed due — open a real review pass.
                if (target.collection)
                  launchCustomStudy(target.collection, { drill: false });
              }}
              disabled={!advancePrompt?.collection}
              className="justify-center gap-2"
            >
              <GraduationCap className="size-4" />
              Add &amp; study now
            </Button>
            <Button
              variant="secondary"
              onClick={async () => {
                const target = advancePrompt;
                setAdvancePrompt(null);
                if (target) await completeAndAdvance(target.chapter, true);
              }}
              className="justify-center gap-2"
            >
              <Sparkles className="size-4" />
              Add to flashcards
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                const target = advancePrompt;
                setAdvancePrompt(null);
                if (target) await completeAndAdvance(target.chapter, false);
              }}
              className="justify-center"
            >
              <Check className="size-4" />
              Just advance
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAdvancePrompt(null)}
              className="justify-center text-muted-foreground"
            >
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Post-advance prompt — fires when the user lands on a new
          lesson with its own linked vocab. Pre-load before reading. */}
      <Dialog
        open={arrivePrompt != null}
        onOpenChange={(v) => {
          if (!v) setArrivePrompt(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Pre-load &ldquo;{arrivePrompt?.chapter.title}&rdquo; vocab?
            </DialogTitle>
            <DialogDescription>
              {arrivePrompt
                ? `You're now on this lecture. It links ${arrivePrompt.nudged.toLocaleString()} word${arrivePrompt.nudged === 1 ? "" : "s"} from "${arrivePrompt.collection.name}". Want to add them to flashcards before you start reading?`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Button
              size="lg"
              onClick={async () => {
                const target = arrivePrompt;
                setArrivePrompt(null);
                if (!target) return;
                try {
                  await pushCollectionToDue(target.collection.id);
                } catch {
                  /* still navigate — user can retry from the chapter row */
                }
                launchCustomStudy(target.collection, { drill: false });
              }}
              className="justify-center gap-2"
            >
              <GraduationCap className="size-4" />
              Study now
            </Button>
            <Button
              variant="secondary"
              onClick={async () => {
                const target = arrivePrompt;
                setArrivePrompt(null);
                if (!target) return;
                try {
                  const { vocabNudged } = await pushCollectionToDue(
                    target.collection.id,
                  );
                  if (vocabNudged > 0) {
                    toast.success(
                      `${vocabNudged.toLocaleString()} word${vocabNudged === 1 ? "" : "s"} now due`,
                      { description: `Open Flashcards when you're ready.` },
                    );
                  }
                } catch (err) {
                  toast.error("Couldn't push vocabulary to due", {
                    description:
                      err instanceof Error ? err.message : String(err),
                  });
                }
              }}
              className="justify-center gap-2"
            >
              <Sparkles className="size-4" />
              Add for later
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setArrivePrompt(null)}
              className="justify-center text-muted-foreground"
            >
              Skip
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Per-chapter "Add to flashcards" follow-up. Push has already
          happened — these buttons only choose between navigating to
          study and not. */}
      <Dialog
        open={studyPrompt != null}
        onOpenChange={(v) => {
          if (!v) setStudyPrompt(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {studyPrompt?.nudged === 0
                ? "Vocab already in rotation"
                : `${(studyPrompt?.nudged ?? 0).toLocaleString()} word${(studyPrompt?.nudged ?? 0) === 1 ? "" : "s"} added to flashcards`}
            </DialogTitle>
            <DialogDescription>
              {studyPrompt?.nudged === 0
                ? `Every word in "${studyPrompt?.collection.name}" was already due or mastered. Want to drill them anyway?`
                : `From "${studyPrompt?.chapterTitle}" → "${studyPrompt?.collection.name}". Drill them now or pick this up later?`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Button
              size="lg"
              onClick={() => {
                const target = studyPrompt;
                setStudyPrompt(null);
                // nudged === 0 → nothing entered the due queue ("all
                // already due or mastered — drill them anyway?"), so
                // honor the drill wording; otherwise it's a real pass
                // over the freshly-due words.
                if (target)
                  launchCustomStudy(target.collection, {
                    drill: target.nudged === 0,
                  });
              }}
              className="justify-center gap-2"
            >
              <GraduationCap className="size-4" />
              Study now
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStudyPrompt(null)}
              className="justify-center text-muted-foreground"
            >
              Later
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );

  return { startAdvance, pushChapterVocab, dialogs, launchCustomStudy };
}
