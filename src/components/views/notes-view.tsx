import { Children, cloneElement, isValidElement, useEffect, useMemo, useRef, useState } from "react";
import {
  Bold,
  BookA,
  Code,
  Columns2,
  EyeOff,
  Eye,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Loader2,
  Minus,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Quote,
  ScanText,
  Sparkles,
  StickyNote,
  BookOpen,
  Table as TableIcon,
  Trash2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { toast } from "sonner";
import { Tokenized } from "@/components/tokenized";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { splitThinking } from "@/components/thinking-block";
import { useProviderConfigs } from "@/lib/provider-context";
import {
  addNoteAttachment,
  createNote,
  deleteNote,
  listNoteAttachments,
  listNotes,
  listVocab,
  savePageLayout,
  saveReaderDoc,
  saveSourceDocument,
  searchDict,
  updateNote,
  type DictEntry,
  type Note,
  type NoteAttachment,
  type VocabEntry,
} from "@/lib/db";
import type { LanguageCode } from "@/lib/languages";
import {
  blobFromFileUri,
  extractImage,
  hasScriptFilter,
  keepBlockForLang,
  ocrImageLayout,
  type OcrEvent,
} from "@/lib/ocr";
import { languageName, profileFor } from "@/lib/languages";
import { segmentText } from "@/lib/segment";
import { linesToWordBoxes, type WordBox } from "@/lib/word-boxing";
import {
  PageOverlay,
  SourceDocPageOverlay,
} from "@/components/page-overlay-reader";
import { navigateToTab } from "@/lib/nav-event";
import { requestOpenReaderDoc } from "@/lib/reader-open-event";
import { useWorkspace } from "@/lib/workspace-context";
import { cn } from "@/lib/utils";
import {
  SidebarCollapser,
  useSidebarCollapse,
} from "@/components/sidebar-collapser";

const RECENTS_KEY = (lang: string) => `tokori:notes-mention-recents:${lang}`;

/** Markdown-source / side-by-side / rendered-only editor layouts. */
type NotesViewMode = "edit" | "split" | "preview";

const NOTES_VIEW_MODE_KEY = "notes.viewMode";

function readNotesViewMode(): NotesViewMode {
  try {
    const v = localStorage.getItem(NOTES_VIEW_MODE_KEY);
    if (v === "edit" || v === "split" || v === "preview") return v;
  } catch {
    /* localStorage may be denied */
  }
  return "edit";
}

export function NotesView() {
  const { active: workspace } = useWorkspace();
  const { active: provider, sendChat } = useProviderConfigs();
  const { open: sidebarOpen, toggle: toggleSidebar } = useSidebarCollapse(
    "notes.sidebarOpen",
  );
  const [notes, setNotes] = useState<Note[]>([]);
  const [active, setActive] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  // Editor layout: markdown source only, source + live preview side by
  // side, or rendered preview only. Persisted globally — a writing-
  // style preference, not per note.
  const [viewMode, setViewModeState] = useState<NotesViewMode>(() =>
    readNotesViewMode(),
  );
  function setViewMode(next: NotesViewMode) {
    setViewModeState(next);
    try {
      localStorage.setItem(NOTES_VIEW_MODE_KEY, next);
    } catch {
      /* localStorage may be denied */
    }
  }
  /** Flows that need the textarea on screen (insert at caret, new
   *  note) bump a preview-only layout to edit; split already has it. */
  function ensureEditorVisible() {
    setViewModeState((m) => {
      const next = m === "preview" ? "edit" : m;
      try {
        localStorage.setItem(NOTES_VIEW_MODE_KEY, next);
      } catch {
        /* localStorage may be denied */
      }
      return next;
    });
  }
  // Everything downstream only cares whether the textarea exists —
  // true only in the rendered-preview-only layout.
  const previewing = viewMode === "preview";
  // Ruby readings (pinyin / furigana) in the rendered preview. A
  // notes-local toggle (persisted) rather than the global display
  // switch — study prose and personal notes are different reading
  // contexts. Only surfaced for languages that have readings.
  const [showPinyin, setShowPinyin] = useState<boolean>(() => {
    try {
      return localStorage.getItem("notes.showPinyin") !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("notes.showPinyin", showPinyin ? "1" : "0");
    } catch {
      /* localStorage may be denied */
    }
  }, [showPinyin]);

  // "Write with AI" — prompt → the active chat provider drafts a
  // markdown section, previewed in a dialog, inserted at the caret on
  // accept. The draft stays in the dialog until the user commits, so a
  // bad generation never touches the note.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiDraft, setAiDraft] = useState("");

  async function generateAiSection() {
    const ask = aiPrompt.trim();
    if (!ask || aiBusy || !workspace) return;
    if (!provider) {
      toast.error("Configure a chat provider in Settings → Providers first");
      return;
    }
    setAiBusy(true);
    setAiDraft("");
    try {
      const target = languageName(workspace.targetLang);
      const native = languageName(workspace.nativeLang);
      // The note so far gives the model continuity (terminology,
      // heading style, what's already covered). Capped so a long note
      // doesn't blow the context for a one-paragraph ask.
      const context = body.trim().slice(0, 1500);
      const reply = await sendChat({
        messages: [
          {
            role: "system",
            content:
              `You draft sections for a language-learner's personal markdown note. ` +
              `They study ${target}; their native language is ${native}.\n\n` +
              `Rules:\n` +
              `- Output ONLY the requested section as GitHub-flavoured markdown — no preamble, no code fences around the whole answer, no commentary.\n` +
              `- Use at most level-2 headings (##), bullet lists, tables where they genuinely help, and **bold** for key terms.\n` +
              `- When you write ${target} words or sentences, add a brief ${native} gloss in parentheses after them.\n` +
              `- Keep it concise and immediately useful for study.` +
              (context
                ? `\n\nThe note so far (match its tone and don't repeat it):\n---\n${context}\n---`
                : ""),
          },
          { role: "user", content: ask },
        ],
        onToken: (delta) => setAiDraft((p) => p + delta),
      });
      setAiDraft(splitThinking(reply).reply.trim());
    } catch (err) {
      toast.error("Couldn't generate", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setAiBusy(false);
    }
  }

  function insertAiDraft() {
    const text = splitThinking(aiDraft).reply.trim();
    if (!text) return;
    ensureEditorVisible();
    // Insert at the caret (replacing any selection); with the editor
    // hidden (preview mode) the caret falls back to the end of the note.
    const ta = textareaRef.current;
    const start = ta?.selectionStart ?? body.length;
    const end = ta?.selectionEnd ?? start;
    const before = body.slice(0, start);
    const after = body.slice(end);
    const pad = before && !before.endsWith("\n") ? "\n\n" : "";
    const inserted = pad + text + "\n";
    setBody(before + inserted + after);
    setDirty(true);
    setAiOpen(false);
    setAiPrompt("");
    setAiDraft("");
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const caret = (before + inserted).length;
      el.setSelectionRange(caret, caret);
    });
  }
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);

  // Inline ":query" mention popover. Type `:nihao` → dictionary suggestions
  // ranked by recency / known vocab. Also opens implicitly after Latin
  // letters following a target-script character (`你hao`).
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [mention, setMention] = useState<{
    start: number;
    query: string;
    coords: { top: number; left: number };
  } | null>(null);
  const [results, setResults] = useState<DictEntry[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const knownWordsRef = useRef<Set<string>>(new Set());
  const recentsRef = useRef<string[]>([]);

  async function refresh() {
    if (!workspace) return;
    const list = await listNotes(workspace.id);
    setNotes(list);
    if (active) {
      const updated = list.find((n) => n.id === active.id);
      if (!updated) setActive(list[0] ?? null);
      else setActive(updated);
    } else if (list.length > 0) {
      setActive(list[0]);
    }
  }

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    listNotes(workspace.id)
      .then((rows) => {
        if (cancelled) return;
        setNotes(rows);
        if (rows.length > 0) {
          setActive(rows[0]);
          setTitle(rows[0].title);
          setBody(rows[0].body);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  // Load known vocab + recents when the workspace changes. Known words boost
  // their dict hits to the top of the suggestion list.
  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    // Cap at 2000 — the notes view only needs the known-words set
    // for the `:` mention popover ranking; pulling 15k rows over
    // IPC just to build a Set is wasteful.
    listVocab(workspace.id, 2000)
      .then((v: VocabEntry[]) => {
        if (cancelled) return;
        const set = new Set<string>();
        for (const entry of v) {
          if (entry.status === "mastered" || entry.status === "review") {
            set.add(entry.word);
          }
        }
        knownWordsRef.current = set;
      })
      .catch(() => {});
    try {
      const raw = localStorage.getItem(RECENTS_KEY(workspace.targetLang));
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      recentsRef.current = Array.isArray(parsed)
        ? (parsed as string[]).filter((x) => typeof x === "string").slice(0, 30)
        : [];
    } catch {
      recentsRef.current = [];
    }
    return () => {
      cancelled = true;
    };
  }, [workspace?.id, workspace?.targetLang]);

  useEffect(() => {
    if (active) {
      setTitle(active.title);
      setBody(active.body);
      setDirty(false);
    }
  }, [active?.id]);

  useEffect(() => {
    if (!active || !dirty) return;
    const id = setTimeout(async () => {
      await updateNote(active.id, { title, body });
      setDirty(false);
      const list = await listNotes(workspace!.id);
      setNotes(list);
    }, 600);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, body, dirty, active?.id]);

  // Re-evaluates the popover whenever body changes or the caret moves.
  function evaluateMention() {
    const ta = textareaRef.current;
    if (!ta || previewing || !workspace) {
      if (mention) setMention(null);
      return;
    }
    const caret = ta.selectionStart ?? 0;
    const m = detectTrigger(body, caret, workspace.targetLang);
    if (m) {
      const coords = caretCoords(ta, caret);
      setMention({ start: m.start, query: m.query, coords });
    } else if (mention) {
      setMention(null);
    }
  }

  // Debounced dict search whenever the query changes.
  useEffect(() => {
    if (!mention || !workspace) {
      setResults([]);
      return;
    }
    const q = mention.query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        // Wider net than the popover ever shows — the search engine returns
        // up to 200, then the rank pass surfaces recents + known words.
        const raw = await searchDict(workspace.targetLang, q, 200);
        if (cancelled) return;
        const ranked = rankResults(
          raw,
          knownWordsRef.current,
          recentsRef.current,
        );
        setResults(ranked.slice(0, 12));
        setActiveIdx(0);
      } catch {
        if (!cancelled) setResults([]);
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [mention?.query, workspace?.targetLang]);

  function acceptPick(word: string) {
    const ta = textareaRef.current;
    if (!ta || !mention || !workspace) return;
    const caret = ta.selectionStart ?? mention.start + mention.query.length;
    const before = body.slice(0, mention.start);
    const after = body.slice(caret);
    const next = before + word + after;
    setBody(next);
    setDirty(true);
    setMention(null);
    setResults([]);
    // Bump the picked word to the front of recents (capped at 30).
    const list = [
      word,
      ...recentsRef.current.filter((w) => w !== word),
    ].slice(0, 30);
    recentsRef.current = list;
    try {
      localStorage.setItem(
        RECENTS_KEY(workspace.targetLang),
        JSON.stringify(list),
      );
    } catch {}
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      const pos = before.length + word.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  // Toolbar actions operate on `textareaRef` directly so caret + scroll
  // survive the React state update.
  function applyEdit(opts: {
    before?: string;
    after?: string;
    placeholder?: string;
    linePrefix?: string;
    block?: string;
  }) {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? start;
    const value = body;
    let next = value;
    let nextStart = start;
    let nextEnd = end;

    if (opts.linePrefix !== undefined) {
      // Expand to whole-line range, then prefix each line.
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const lineEnd = value.indexOf("\n", end);
      const stop = lineEnd === -1 ? value.length : lineEnd;
      const block = value.slice(lineStart, stop);
      const lines = block.split("\n");
      const prefixed = lines.map((l) => opts.linePrefix + l).join("\n");
      next = value.slice(0, lineStart) + prefixed + value.slice(stop);
      nextStart = lineStart;
      nextEnd = lineStart + prefixed.length;
    } else if (opts.block !== undefined) {
      // Drop a fresh block on its own line. Pad with newlines so the block
      // is never glued to existing prose.
      const padBefore = start > 0 && value[start - 1] !== "\n" ? "\n\n" : "";
      const padAfter = end < value.length && value[end] !== "\n" ? "\n\n" : "";
      const insertion = padBefore + opts.block + padAfter;
      next = value.slice(0, start) + insertion + value.slice(end);
      nextStart = start + padBefore.length;
      nextEnd = nextStart + opts.block.length;
    } else {
      const before = opts.before ?? "";
      const after = opts.after ?? "";
      const inner = start === end ? (opts.placeholder ?? "") : value.slice(start, end);
      next = value.slice(0, start) + before + inner + after + value.slice(end);
      nextStart = start + before.length;
      nextEnd = nextStart + inner.length;
    }

    setBody(next);
    setDirty(true);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextStart, nextEnd);
    });
  }

  // Drop in a small markdown table users can edit in place. Three columns is
  // the sweet spot — wide enough to be useful, narrow enough to not overflow
  // a default viewport.
  const TABLE_TEMPLATE = [
    "| Word | Reading | Gloss |",
    "| ---- | ------- | ----- |",
    "| ?    | ?       | ?     |",
    "| ?    | ?       | ?     |",
  ].join("\n");

  function onTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!mention || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const pick = results[activeIdx];
      if (pick) acceptPick(pick.word);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setMention(null);
    }
  }

  async function add() {
    if (!workspace) return;
    const n = await createNote({ workspaceId: workspace.id, title: "Untitled" });
    await refresh();
    setActive(n);
    ensureEditorVisible();
  }

  async function remove(n: Note) {
    if (!workspace) return;
    await deleteNote(n.id);
    const list = await listNotes(workspace.id);
    setNotes(list);
    if (active?.id === n.id) setActive(list[0] ?? null);
  }

  async function togglePin(n: Note) {
    await updateNote(n.id, { pinned: !n.pinned });
    await refresh();
  }

  // OCR drag-drop / paste flow. Default action is context-aware: insert if the
  // textarea is focused and a note is open, otherwise create a new note.
  const editorFocusedRef = useRef(false);
  type OcrTarget = "editor" | "new-note";
  type OcrStatus =
    | { kind: "downloading"; file: string; pct: number }
    | { kind: "recognizing" }
    | { kind: "ready" }
    | { kind: "error"; message: string };
  const [ocrDialog, setOcrDialog] = useState<{
    blob: Blob;
    previewUrl: string;
    name: string;
    defaultTarget: OcrTarget;
    blocks: string[];
    words: WordBox[];
    imgWidth: number;
    imgHeight: number;
    filterLang: boolean;
    text: string;
    title: string;
    status: OcrStatus;
  } | null>(null);
  // Source-doc attachments of the open note (interactive captures kept with
  // the note); rendered atop the preview.
  const [attachments, setAttachments] = useState<NoteAttachment[]>([]);

  // Per-workspace pref so users with one Chinese workspace and one Spanish
  // workspace get the right default for each. Read once on mount.
  const filterPrefKey = workspace
    ? `tokori:notes-ocr-filter-lang:${workspace.targetLang}`
    : "tokori:notes-ocr-filter-lang";
  const [filterLangPref, setFilterLangPref] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(filterPrefKey) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(filterPrefKey, filterLangPref ? "1" : "0");
    } catch {}
  }, [filterPrefKey, filterLangPref]);

  // Load the open note's interactive image attachments.
  useEffect(() => {
    if (!active) {
      setAttachments([]);
      return;
    }
    let cancelled = false;
    void listNoteAttachments(active.id)
      .then((a) => {
        if (!cancelled) setAttachments(a);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active?.id]);

  function joinBlocks(blocks: string[], lang: string, filter: boolean): string {
    const kept = filter ? blocks.filter((b) => keepBlockForLang(b, lang)) : blocks;
    return kept.join("\n");
  }

  function openOcrDialog(blob: Blob, name: string, defaultTarget: OcrTarget) {
    if (!workspace) return;
    // Object URL keeps the thumbnail rendering cheap; revoked when the
    // dialog closes (see the close handler below).
    const previewUrl = URL.createObjectURL(blob);
    const initialFilter = hasScriptFilter(workspace.targetLang) && filterLangPref;
    setOcrDialog({
      blob,
      previewUrl,
      name,
      defaultTarget,
      blocks: [],
      words: [],
      imgWidth: 0,
      imgHeight: 0,
      filterLang: initialFilter,
      text: "",
      title: niceTitleFromName(name),
      status: { kind: "recognizing" },
    });

    // Kick OCR. We update dialog state via the functional setter so an
    // in-flight close (user hits Esc before OCR finishes) is respected
    // without us writing into a stale dialog.
    const lang = workspace.targetLang;
    void (async () => {
      try {
        const layout = await ocrImageLayout(blob, lang, (e: OcrEvent) => {
          setOcrDialog((d) => {
            if (!d) return d;
            if (e.type === "models_downloading") {
              const pct = e.total > 0 ? Math.round((e.downloaded / e.total) * 100) : 0;
              return {
                ...d,
                status: {
                  kind: "downloading",
                  file: e.file.replace(/\.onnx$/, ""),
                  pct,
                },
              };
            }
            return { ...d, status: { kind: "recognizing" } };
          });
        });
        const blocks = layout.lines.map((l) => l.text);
        // Per-word hotspots for the interactive preview (clickable words on
        // the image): tokenise each detected line + distribute its box.
        const words = await linesToWordBoxes(
          layout.lines,
          layout.width,
          layout.height,
          lang,
          segmentText,
        );
        setOcrDialog((d) =>
          d
            ? {
                ...d,
                blocks,
                words,
                imgWidth: layout.width,
                imgHeight: layout.height,
                text: joinBlocks(blocks, lang, d.filterLang),
                status: { kind: "ready" },
              }
            : d,
        );
      } catch (err) {
        setOcrDialog((d) =>
          d
            ? {
                ...d,
                status: {
                  kind: "error",
                  message: err instanceof Error ? err.message : String(err),
                },
              }
            : d,
        );
      }
    })();
  }

  function setOcrFilterLang(filter: boolean) {
    if (!workspace) return;
    setFilterLangPref(filter);
    setOcrDialog((d) =>
      d
        ? {
            ...d,
            filterLang: filter,
            text: joinBlocks(d.blocks, workspace.targetLang, filter),
          }
        : d,
    );
  }

  function closeOcrDialog() {
    setOcrDialog((d) => {
      if (d) URL.revokeObjectURL(d.previewUrl);
      return null;
    });
  }

  // Persist the captured image as a source document + its page layout so a
  // saved note (or reader doc) can re-render the interactive overlay. Returns
  // the new source-document id, or null on HOSTED / browser (no blob store).
  async function persistOcrSource(): Promise<number | null> {
    if (!ocrDialog || !workspace) return null;
    const bytes = new Uint8Array(await ocrDialog.blob.arrayBuffer());
    const doc = await saveSourceDocument({
      workspaceId: workspace.id,
      kind: "image",
      fileName: ocrDialog.name,
      mime: ocrDialog.blob.type || "image/png",
      bytes,
    });
    if (!doc) return null;
    await savePageLayout({
      sourceDocumentId: doc.id,
      pageIndex: 0,
      width: ocrDialog.imgWidth,
      height: ocrDialog.imgHeight,
      words: ocrDialog.words,
      ocrDone: true,
    });
    return doc.id;
  }

  async function applyOcr(target: OcrTarget) {
    if (!ocrDialog || !workspace || !ocrDialog.text.trim()) return;
    const text = ocrDialog.text;
    // Keep the source image with the note so it stays interactive.
    const docId = await persistOcrSource();
    if (target === "editor" && active) {
      // Insert at the caret of the textarea, mirroring applyEdit's
      // post-insert focus restore so typing continues from the end of
      // the inserted block.
      const ta = textareaRef.current;
      const start = ta?.selectionStart ?? body.length;
      const end = ta?.selectionEnd ?? body.length;
      const next = body.slice(0, start) + text + body.slice(end);
      setBody(next);
      setDirty(true);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        const pos = start + text.length;
        el.focus();
        el.setSelectionRange(pos, pos);
      });
      if (docId != null) {
        await addNoteAttachment({ noteId: active.id, sourceDocumentId: docId });
        try {
          setAttachments(await listNoteAttachments(active.id));
        } catch {}
      }
      toast.success(`Inserted ${text.length} chars from image`);
    } else {
      const title = ocrDialog.title.trim() || niceTitleFromName(ocrDialog.name);
      const n = await createNote({
        workspaceId: workspace.id,
        title,
        body: text,
      });
      // Attach before activating — the attachments effect (keyed on the
      // active note) then loads it as the new note opens.
      if (docId != null) {
        await addNoteAttachment({ noteId: n.id, sourceDocumentId: docId });
      }
      await refresh();
      setActive(n);
      ensureEditorVisible();
      toast.success(`Created “${title}”`);
    }
    closeOcrDialog();
  }

  // Send a long capture to the Reader as its own document. Keeps the image +
  // layout (for the Phase-2 page overlay) and stores the body text, so it's
  // readable immediately in the meantime.
  async function sendOcrToReader() {
    if (!ocrDialog || !workspace || !ocrDialog.text.trim()) return;
    const docId = await persistOcrSource();
    const title = ocrDialog.title.trim() || niceTitleFromName(ocrDialog.name);
    const doc = await saveReaderDoc({
      workspaceId: workspace.id,
      title,
      body: ocrDialog.text,
      sourceDocumentId: docId ?? undefined,
      pageStart: docId != null ? 0 : undefined,
      pageEnd: docId != null ? 0 : undefined,
    });
    closeOcrDialog();
    navigateToTab("reader");
    requestOpenReaderDoc(doc.id);
    toast.success(`Opened “${title}” in the Reader`);
  }

  const imageInputRef = useRef<HTMLInputElement>(null);
  function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // let the same file be picked again
    if (!f || !workspace) return;
    const target: OcrTarget = active && !previewing ? "editor" : "new-note";
    openOcrDialog(f, f.name, target);
  }

  function makeDropHandler(target: OcrTarget) {
    return (e: React.DragEvent) => {
      const found = extractImage(e.dataTransfer?.files ?? null);
      if (found) {
        e.preventDefault();
        e.stopPropagation();
        openOcrDialog(found.blob, found.name, target);
        return;
      }
      // Linux file managers hand over a `file://` URI, not the file bytes.
      const fileUri = (
        e.dataTransfer?.getData("text/uri-list") ||
        e.dataTransfer?.getData("text/plain") ||
        ""
      )
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.startsWith("file://"));
      if (fileUri) {
        e.preventDefault();
        e.stopPropagation();
        void blobFromFileUri(fileUri).then((r) => {
          if (r) openOcrDialog(r.blob, r.name, target);
        });
      }
    };
  }

  // Global paste — only active while NotesView is mounted. We attach to
  // the document so an image on the clipboard works no matter where focus
  // is (sidebar, title input, textarea, or nowhere). Skip if the OCR
  // dialog itself is open and the user is just editing the preview text.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (!workspace || ocrDialog) return;
      const target: OcrTarget =
        editorFocusedRef.current && active && !previewing ? "editor" : "new-note";
      const found = extractImage(e.clipboardData?.items ?? null);
      if (found) {
        e.preventDefault();
        openOcrDialog(found.blob, found.name, target);
        return;
      }
      // Linux: file managers copy a `file://` URI (as text), not image bytes.
      const fileUri = (
        e.clipboardData?.getData("text/uri-list") ||
        e.clipboardData?.getData("text/plain") ||
        ""
      )
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.startsWith("file://"));
      if (fileUri) {
        e.preventDefault();
        void blobFromFileUri(fileUri).then((r) => {
          if (r) openOcrDialog(r.blob, r.name, target);
        });
      }
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id, active?.id, previewing, !!ocrDialog]);

  // Hint string for the editor footer — shown verbatim so users discover
  // the mention popover without having to read docs.
  const triggerHint = useMemo(() => {
    if (!workspace) return "";
    const sample = SAMPLE_QUERY[workspace.targetLang as LanguageCode] ?? "word";
    return `Type ":" then ${sample} to search the dictionary`;
  }, [workspace?.targetLang]);

  if (!workspace) return null;

  return (
    <div className="relative flex h-full">
      {sidebarOpen && (
      <aside
        className="flex w-[260px] shrink-0 flex-col border-r border-border"
        onDragOver={(e) => {
          const t = e.dataTransfer?.types;
          if (t && (t.includes("Files") || t.includes("text/uri-list")))
            e.preventDefault();
        }}
        onDrop={makeDropHandler("new-note")}
      >
        <div className="flex items-center justify-between px-4 pt-5 pb-3">
          <div>
            <h2 className="font-serif text-xl tracking-tight">Notes</h2>
            <p className="text-[11.5px] text-muted-foreground">Markdown, autosaved</p>
          </div>
          <div className="flex items-center gap-0.5">
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onPickImage}
            />
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => imageInputRef.current?.click()}
              title="Add image — extract its text (OCR)"
            >
              <ScanText className="size-4" />
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={add} title="New note">
              <Plus className="size-4" />
            </Button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {loading ? (
            <p className="px-2 py-2 text-[12px] text-muted-foreground">Loading…</p>
          ) : notes.length === 0 ? (
            <p className="px-2 py-2 text-[12px] text-muted-foreground">
              No notes yet — click + to start.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {notes.map((n) => (
                <li
                  key={n.id}
                  className={cn(
                    "group flex items-center gap-1 rounded-md transition-colors",
                    active?.id === n.id ? "bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  <button
                    onClick={() => setActive(n)}
                    className="flex-1 truncate px-2 py-1.5 text-left text-[13px]"
                  >
                    <div className="flex items-center gap-1.5">
                      {n.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" />}
                      <span className="truncate font-medium">{n.title || "Untitled"}</span>
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {new Date(n.updatedAt * 1000).toLocaleDateString()}
                    </div>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="opacity-0 group-hover:opacity-100"
                    onClick={() => void togglePin(n)}
                    title={n.pinned ? "Unpin" : "Pin"}
                  >
                    {n.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="opacity-0 group-hover:opacity-100"
                    onClick={() => void remove(n)}
                    title="Delete"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
      )}

      <SidebarCollapser
        open={sidebarOpen}
        onToggle={toggleSidebar}
        width={260}
        visibleLabel="Hide notes"
        hiddenLabel="Show notes"
      />

      <div
        className="flex flex-1 flex-col overflow-hidden"
        onDragOver={(e) => {
          const t = e.dataTransfer?.types;
          if (t && (t.includes("Files") || t.includes("text/uri-list")))
            e.preventDefault();
        }}
        onDrop={makeDropHandler(active && !previewing ? "editor" : "new-note")}
      >
        {!active ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <StickyNote className="size-7 text-muted-foreground" />
            <h2 className="font-serif text-2xl tracking-tight">No note open.</h2>
            <Button onClick={add}>
              <Plus className="size-4" />
              New note
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-border px-8 py-4">
              <Input
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setDirty(true);
                }}
                placeholder="Title"
                className="flex-1 border-0 bg-transparent px-0 font-serif !text-2xl shadow-none focus-visible:ring-0"
              />
              {/* AI section writer — prompt in a dialog, draft inserted
                  at the caret on accept. */}
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAiOpen(true)}
                title="Let the AI draft a section into this note"
              >
                <Sparkles className="size-3.5" />
                Write with AI
              </Button>
              {/* Ruby toggle for the rendered side (preview + split).
                  Only languages with a reading system get the button;
                  the label matches what the reading is called there. */}
              {viewMode !== "edit" &&
                profileFor(workspace.targetLang).hasReadings && (
                  <button
                    type="button"
                    onClick={() => setShowPinyin((v) => !v)}
                    aria-pressed={showPinyin}
                    title={
                      showPinyin
                        ? "Hide readings in the preview"
                        : "Show readings in the preview"
                    }
                    className={cn(
                      "flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                      showPinyin
                        ? "border-foreground/30 bg-foreground text-background"
                        : "border-border bg-card text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {workspace.targetLang === "ja" ? "Furigana" : "Pinyin"}
                  </button>
                )}
              {/* Edit / Split / Preview — split renders the markdown
                  live beside the source. */}
              <div className="flex gap-0.5 rounded-full border border-border bg-card p-0.5">
                {(
                  [
                    { id: "edit", icon: Pencil, label: "Edit" },
                    { id: "split", icon: Columns2, label: "Split" },
                    { id: "preview", icon: Eye, label: "Preview" },
                  ] as const
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setViewMode(m.id)}
                    aria-pressed={viewMode === m.id}
                    title={
                      m.id === "split"
                        ? "Editor and live preview side by side"
                        : m.id === "preview"
                          ? "Rendered note only"
                          : "Markdown source only"
                    }
                    className={cn(
                      "flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                      viewMode === m.id
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <m.icon className="size-3.5" />
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {(() => {
              // Shared panes, composed per layout. `split` drops the
              // centering max-width so the two columns fill their halves.
              const previewPane = (split: boolean) => (
                <div
                  className={cn(
                    "markdown-body text-[15px] leading-relaxed",
                    !split && "mx-auto max-w-3xl xl:max-w-4xl 2xl:max-w-5xl",
                  )}
                >
                  {/* Interactive image captures kept with this note: the
                      recognised words stay clickable on the page. */}
                  {attachments.length > 0 && (
                    <div className="mb-5 space-y-3">
                      {attachments.map((a) => (
                        <SourceDocPageOverlay
                          key={a.id}
                          sourceDocumentId={a.sourceDocumentId}
                          lang={workspace.targetLang}
                        />
                      ))}
                    </div>
                  )}
                  {/* remarkBreaks: render a single newline as a line break so
                      the preview matches what's typed in the editor. Without
                      it, CommonMark collapses lone "\n"s to spaces and lines
                      typed on separate rows merge into one paragraph. */}
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkBreaks]}
                    components={tokenizedMarkdownComponents(
                      workspace.targetLang,
                      showPinyin,
                    )}
                  >
                    {body ? preserveBlankLines(body) : "_(empty)_"}
                  </ReactMarkdown>
                </div>
              );
              const editorPane = (split: boolean) => (
                <div
                  className={cn(
                    "block w-full",
                    !split && "mx-auto max-w-3xl xl:max-w-4xl 2xl:max-w-5xl",
                  )}
                >
                  <EditorToolbar onAction={applyEdit} tableTemplate={TABLE_TEMPLATE} />
                  <textarea
                    ref={textareaRef}
                    value={body}
                    onChange={(e) => {
                      setBody(e.target.value);
                      setDirty(true);
                      // schedule mention re-eval after the new value lands
                      requestAnimationFrame(evaluateMention);
                    }}
                    onKeyDown={onTextareaKeyDown}
                    onKeyUp={evaluateMention}
                    onClick={evaluateMention}
                    onSelect={evaluateMention}
                    onFocus={() => {
                      editorFocusedRef.current = true;
                    }}
                    onBlur={() => {
                      editorFocusedRef.current = false;
                      // give a click on the popover a chance to fire first
                      setTimeout(() => setMention(null), 150);
                    }}
                    placeholder={`Write in markdown… ${triggerHint}`}
                    className="mt-0 block min-h-[60vh] w-full resize-y rounded-b-md rounded-t-none border border-t-0 border-input bg-background px-3 py-3 font-mono text-[13.5px] leading-relaxed shadow-xs focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                    <BookA className="size-3.5" />
                    {triggerHint}. ↑↓ to navigate, ⏎ or Tab to insert, Esc to dismiss.
                  </p>
                </div>
              );
              if (viewMode === "split") {
                // Independent scroll per column — typing at the bottom of
                // a long note shouldn't drag the preview around, and vice
                // versa.
                return (
                  <div className="min-h-0 flex-1 overflow-hidden px-8 py-6">
                    <div className="grid h-full min-h-0 grid-cols-2 gap-6">
                      <div className="min-h-0 overflow-y-auto pr-1">
                        {editorPane(true)}
                      </div>
                      <div className="min-h-0 overflow-y-auto border-l border-border/60 pl-6">
                        {previewPane(true)}
                      </div>
                    </div>
                  </div>
                );
              }
              return (
                <div className="flex-1 overflow-y-auto px-8 py-6">
                  {viewMode === "preview" ? previewPane(false) : editorPane(false)}
                </div>
              );
            })()}
            {dirty && (
              <div className="border-t border-border bg-muted/40 px-8 py-1.5 text-center text-[11px] text-muted-foreground">
                Saving…
              </div>
            )}
          </>
        )}
      </div>

      {/* AI section writer — prompt → streamed markdown draft → insert
          at the caret. The draft is markdown SOURCE (what lands in the
          editor); the note's preview renders it after insert. */}
      <Dialog
        open={aiOpen}
        onOpenChange={(open) => {
          if (!open && !aiBusy) {
            setAiOpen(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-serif">
              <Sparkles className="size-5" />
              Write with AI
            </DialogTitle>
            <DialogDescription>
              Describe the section you want — the draft is inserted at your
              cursor only when you accept it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Textarea
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void generateAiSection();
                }
              }}
              rows={3}
              autoFocus
              placeholder={`e.g. "a summary of 把-sentences with 5 examples", "a vocabulary table about cooking", "continue my packing list"…`}
            />
            {(aiDraft || aiBusy) && (
              <div className="max-h-64 overflow-y-auto rounded-md border border-border bg-muted/30 px-3 py-2.5">
                {splitThinking(aiDraft).reply ? (
                  <pre className="whitespace-pre-wrap font-mono text-[12.5px] leading-relaxed text-foreground/90">
                    {splitThinking(aiDraft).reply}
                  </pre>
                ) : (
                  <p className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    Drafting…
                  </p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setAiOpen(false)}
              disabled={aiBusy}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => void generateAiSection()}
              disabled={aiBusy || !aiPrompt.trim()}
            >
              {aiBusy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              {splitThinking(aiDraft).reply ? "Regenerate" : "Generate"}
            </Button>
            <Button
              onClick={insertAiDraft}
              disabled={aiBusy || !splitThinking(aiDraft).reply.trim()}
            >
              Insert into note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* OCR preview dialog — opens on image drop/paste. Stays mounted while
          OCR runs so the user sees the spinner; on success the textarea
          becomes editable so they can fix recognition errors before
          inserting. */}
      <Dialog
        open={!!ocrDialog}
        onOpenChange={(open) => {
          if (!open) closeOcrDialog();
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-serif">
              <ScanText className="size-5" />
              Recognise text in image
            </DialogTitle>
            <DialogDescription>
              Edit the text below if needed, then{" "}
              {ocrDialog?.defaultTarget === "editor"
                ? "insert it into the open note or save it as a new one."
                : "save it as a new note or insert it into the open note."}
            </DialogDescription>
          </DialogHeader>

          {ocrDialog && (
            <div className="flex flex-col gap-3">
              {/* Once OCR is ready, the recognised words are clickable right
                  on the image — hover to define, click to save to vocab,
                  analyse the sentence — before you ever save the note. While
                  the model downloads / runs, show a thumbnail + status. */}
              {ocrDialog.status.kind === "ready" && ocrDialog.words.length > 0 ? (
                <div className="max-h-[44vh] overflow-auto rounded-md border border-border bg-muted/20 p-2">
                  <PageOverlay
                    imageUrl={ocrDialog.previewUrl}
                    words={ocrDialog.words}
                    lang={workspace.targetLang}
                  />
                </div>
              ) : (
                <div className="flex items-start gap-3">
                  <div className="h-28 w-28 shrink-0 overflow-hidden rounded-md border border-border bg-muted/30">
                    <img
                      src={ocrDialog.previewUrl}
                      alt="Dropped image"
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    {ocrDialog.status.kind === "downloading" && (
                      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        Downloading OCR model ({ocrDialog.status.file}) {ocrDialog.status.pct}%
                      </div>
                    )}
                    {ocrDialog.status.kind === "recognizing" && (
                      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        Recognising text…
                      </div>
                    )}
                    {ocrDialog.status.kind === "error" && (
                      <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
                        {ocrDialog.status.message}
                      </div>
                    )}
                    {ocrDialog.status.kind === "ready" && (
                      <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
                        No text recognised in this image.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {ocrDialog.defaultTarget === "new-note" && (
                <Input
                  value={ocrDialog.title}
                  onChange={(e) =>
                    setOcrDialog((d) => (d ? { ...d, title: e.target.value } : d))
                  }
                  placeholder="Note title"
                  className="text-[13px]"
                />
              )}

              {hasScriptFilter(workspace.targetLang) && (
                <label className="flex items-center gap-2 text-[12px] text-muted-foreground select-none">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-foreground"
                    checked={ocrDialog.filterLang}
                    onChange={(e) => setOcrFilterLang(e.target.checked)}
                    disabled={ocrDialog.status.kind !== "ready"}
                  />
                  Only {languageName(workspace.targetLang)} text
                  {ocrDialog.status.kind === "ready" && ocrDialog.filterLang && (
                    <span className="ml-auto text-[11px]">
                      {
                        ocrDialog.blocks.filter((b) =>
                          keepBlockForLang(b, workspace.targetLang),
                        ).length
                      }
                      /{ocrDialog.blocks.length} blocks
                    </span>
                  )}
                </label>
              )}

              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Recognised text — fix any slips before saving
                </span>
                <textarea
                  value={ocrDialog.text}
                  onChange={(e) =>
                    setOcrDialog((d) => (d ? { ...d, text: e.target.value } : d))
                  }
                  placeholder={
                    ocrDialog.status.kind === "ready"
                      ? "(no text recognised)"
                      : "Recognised text will appear here…"
                  }
                  readOnly={ocrDialog.status.kind !== "ready" && ocrDialog.status.kind !== "error"}
                  rows={6}
                  className="min-h-[120px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-[12.5px] leading-relaxed shadow-xs focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" onClick={closeOcrDialog}>
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => void sendOcrToReader()}
              disabled={!ocrDialog?.text.trim()}
              title="Open as an interactive document in the Reader"
            >
              <BookOpen className="size-3.5" />
              Open in Reader
            </Button>
            {ocrDialog?.defaultTarget === "editor" ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => void applyOcr("new-note")}
                  disabled={!ocrDialog?.text.trim()}
                >
                  Create new note
                </Button>
                <Button
                  onClick={() => void applyOcr("editor")}
                  disabled={!ocrDialog?.text.trim() || !active}
                >
                  Insert into note
                </Button>
              </>
            ) : (
              <>
                {active && (
                  <Button
                    variant="outline"
                    onClick={() => void applyOcr("editor")}
                    disabled={!ocrDialog?.text.trim()}
                  >
                    Insert into open note
                  </Button>
                )}
                <Button
                  onClick={() => void applyOcr("new-note")}
                  disabled={!ocrDialog?.text.trim()}
                >
                  Create note
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mention popover — anchored to the caret via fixed positioning. The
          coords come from a textarea mirror so it sits exactly under the
          colon you typed. */}
      {mention && results.length > 0 && (
        <MentionPopover
          coords={mention.coords}
          results={results}
          activeIdx={activeIdx}
          known={knownWordsRef.current}
          recents={recentsRef.current}
          onPick={(w) => acceptPick(w)}
          onHover={(i) => setActiveIdx(i)}
        />
      )}
    </div>
  );
}

function MentionPopover({
  coords,
  results,
  activeIdx,
  known,
  recents,
  onPick,
  onHover,
}: {
  coords: { top: number; left: number };
  results: DictEntry[];
  activeIdx: number;
  known: Set<string>;
  recents: string[];
  onPick: (word: string) => void;
  onHover: (idx: number) => void;
}) {
  const recentSet = useMemo(() => new Set(recents), [recents]);
  return (
    <div
      role="listbox"
      // mousedown fires before blur — keep the popover alive long enough to
      // process the click.
      onMouseDown={(e) => e.preventDefault()}
      className="fixed z-50 max-h-[320px] w-[360px] overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
      style={{
        top: Math.min(coords.top + 4, window.innerHeight - 340),
        left: Math.min(coords.left, window.innerWidth - 380),
      }}
    >
      <ul className="py-1">
        {results.map((r, i) => {
          const isActive = i === activeIdx;
          const tag =
            recentSet.has(r.word)
              ? "Recent"
              : known.has(r.word)
                ? "Known"
                : null;
          return (
            <li key={`${r.word}-${i}`}>
              <button
                type="button"
                role="option"
                aria-selected={isActive}
                onMouseEnter={() => onHover(i)}
                onClick={() => onPick(r.word)}
                className={cn(
                  "flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-[13px]",
                  isActive ? "bg-accent" : "hover:bg-accent/60",
                )}
              >
                <span className="font-serif text-[15px] font-medium text-foreground">
                  {r.word}
                </span>
                {r.reading && (
                  <span className="text-[11.5px] text-muted-foreground">
                    {r.reading}
                  </span>
                )}
                <span className="ml-1 flex-1 truncate text-[12px] text-muted-foreground">
                  {r.gloss}
                </span>
                {tag && (
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                      tag === "Recent"
                        ? "bg-violet-500/10 text-violet-600 dark:text-violet-300"
                        : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
                    )}
                  >
                    {tag}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Turn a filename like "IMG_3942.heic" into a tidy title. Falls back to a
// timestamped "Pasted image" if there's nothing to keep.
function niceTitleFromName(name: string): string {
  const base = name.replace(/\.[a-z0-9]+$/i, "").trim();
  if (!base || base.toLowerCase() === "pasted image") {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `Pasted image ${d.toLocaleDateString()} ${hh}:${mm}`;
  }
  return base;
}

const SAMPLE_QUERY: Partial<Record<LanguageCode, string>> = {
  zh: "pinyin (e.g. nihao)",
  ja: "romaji (e.g. tabemono)",
  ko: "romanisation (e.g. annyeong)",
  de: "a German word (e.g. Tisch)",
  es: "a Spanish word (e.g. casa)",
  en: "a word",
  fr: "a French word",
  it: "an Italian word",
  pt: "a Portuguese word",
};

// Detects either `:foo` (explicit) or a Latin run after a target-script
// character (implicit, CJK/hangul only).
function detectTrigger(
  text: string,
  caret: number,
  lang: LanguageCode,
): { start: number; query: string } | null {
  let i = caret;
  while (i > 0) {
    const ch = text[i - 1];
    if (ch === ":") return { start: i - 1, query: text.slice(i, caret) };
    if (isTargetScript(ch, lang)) {
      return { start: i, query: text.slice(i, caret) };
    }
    if (!/[a-zA-Z0-9']/.test(ch)) return null;
    i--;
  }
  return null;
}

function isTargetScript(ch: string, lang: LanguageCode): boolean {
  if (!ch) return false;
  switch (lang) {
    case "zh":
      return /[㐀-鿿]/.test(ch);
    case "ja":
      return /[぀-ヿ㐀-鿿]/.test(ch);
    case "ko":
      return /[가-힯ᄀ-ᇿ㄰-㆏]/.test(ch);
    default:
      // Latin-script languages: don't implicit-trigger; the user is just
      // writing prose. They can always use the explicit `:foo` form.
      return false;
  }
}

// Recent picks first, then known vocab, then whatever order the dict returned.
function rankResults(
  raw: DictEntry[],
  known: Set<string>,
  recents: string[],
): DictEntry[] {
  const recentRank = new Map<string, number>();
  recents.forEach((w, i) => recentRank.set(w, i));
  const tier = (e: DictEntry): number => {
    if (recentRank.has(e.word)) return 0;
    if (known.has(e.word)) return 1;
    return 2;
  };
  return raw
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const ta = tier(a.e);
      const tb = tier(b.e);
      if (ta !== tb) return ta - tb;
      // Inside a tier: recents stay in pick order; known/everything-else
      // keep the searchDict order (which already ranks exact > prefix > etc).
      if (ta === 0) {
        return (recentRank.get(a.e.word) ?? 0) - (recentRank.get(b.e.word) ?? 0);
      }
      return a.i - b.i;
    })
    .map((x) => x.e);
}

// Compute viewport coordinates of a textarea caret. Builds a hidden mirror
// div with the same typography and reads the marker span's bounding rect.
function caretCoords(
  el: HTMLTextAreaElement,
  pos: number,
): { top: number; left: number } {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const cs = window.getComputedStyle(el);
  const props: Array<keyof CSSStyleDeclaration> = [
    "boxSizing",
    "width",
    "height",
    "overflowX",
    "overflowY",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "fontStyle",
    "fontVariant",
    "fontWeight",
    "fontStretch",
    "fontSize",
    "fontSizeAdjust",
    "lineHeight",
    "fontFamily",
    "textAlign",
    "textTransform",
    "textIndent",
    "textDecoration",
    "letterSpacing",
    "wordSpacing",
    "tabSize",
    "whiteSpace",
    "wordWrap",
    "wordBreak",
  ];
  for (const p of props) {
    // mirror the textarea's own styles so wrapping behaves identically
    (div.style as unknown as Record<string, string>)[p as string] =
      (cs as unknown as Record<string, string>)[p as string] ?? "";
  }
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word";
  div.style.top = "0";
  div.style.left = "-9999px";
  // Required for accurate measurement — textareas always wrap.
  div.textContent = el.value.substring(0, pos);
  const span = document.createElement("span");
  // A non-empty span is needed so offsetTop / offsetLeft return a real position
  // even when the caret is at end-of-line.
  span.textContent = el.value.substring(pos) || ".";
  div.appendChild(span);
  const rect = el.getBoundingClientRect();
  const result = {
    top: rect.top + (span.offsetTop - el.scrollTop),
    left: rect.left + (span.offsetLeft - el.scrollLeft),
  };
  document.body.removeChild(div);
  return result;
}

type EditAction = Parameters<
  (opts: {
    before?: string;
    after?: string;
    placeholder?: string;
    linePrefix?: string;
    block?: string;
  }) => void
>[0];

function EditorToolbar({
  onAction,
  tableTemplate,
}: {
  onAction: (opts: EditAction) => void;
  tableTemplate: string;
}) {
  const groups: Array<Array<ToolbarBtn>> = [
    [
      { icon: Heading1, label: "Heading 1", run: () => onAction({ linePrefix: "# " }) },
      { icon: Heading2, label: "Heading 2", run: () => onAction({ linePrefix: "## " }) },
      { icon: Heading3, label: "Heading 3", run: () => onAction({ linePrefix: "### " }) },
    ],
    [
      { icon: Bold,   label: "Bold (⌘B)",   run: () => onAction({ before: "**", after: "**", placeholder: "bold" }) },
      { icon: Italic, label: "Italic (⌘I)", run: () => onAction({ before: "*",  after: "*",  placeholder: "italic" }) },
      { icon: Code,   label: "Inline code", run: () => onAction({ before: "`",  after: "`",  placeholder: "code" }) },
    ],
    [
      { icon: List,        label: "Bulleted list",  run: () => onAction({ linePrefix: "- " }) },
      { icon: ListOrdered, label: "Numbered list",  run: () => onAction({ linePrefix: "1. " }) },
      { icon: Quote,       label: "Blockquote",     run: () => onAction({ linePrefix: "> " }) },
    ],
    [
      { icon: LinkIcon,  label: "Link",          run: () => onAction({ before: "[", after: "](https://)", placeholder: "link text" }) },
      { icon: TableIcon, label: "Insert table",  run: () => onAction({ block: tableTemplate }) },
      { icon: Minus,     label: "Divider",       run: () => onAction({ block: "---" }) },
    ],
    [
      // Blur translation — Tokori-specific. Wraps the selection in `((...))`,
      // which the chat / reader render as a hover-to-reveal translation.
      { icon: EyeOff,   label: "Blur translation", run: () => onAction({ before: "((", after: "))", placeholder: "translation" }) },
      // Code block — three-backtick fence on its own block.
      { icon: Sparkles, label: "Code block",       run: () => onAction({ block: "```\ncode\n```" }) },
    ],
  ];

  return (
    <div className="flex flex-wrap items-center gap-0.5 rounded-t-md border border-input bg-muted/30 px-1.5 py-1">
      {groups.map((group, gi) => (
        <div key={gi} className="flex items-center gap-0.5">
          {gi > 0 && <span className="mx-1 h-5 w-px bg-border" aria-hidden />}
          {group.map((btn) => (
            <button
              key={btn.label}
              type="button"
              title={btn.label}
              aria-label={btn.label}
              onClick={btn.run}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <btn.icon className="size-4" />
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

type ToolbarBtn = {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  run: () => void;
};

// Markdown collapses any run of blank lines into a single paragraph break, so
// a note typed with several blank lines for spacing looks cramped in the
// preview. Preserve the author's spacing: keep one real paragraph break and
// turn each *extra* blank line into a paragraph holding a non-breaking space
// (which renders as an empty line with height — and, being non-ASCII
// whitespace, isn't stripped by the parser). Fenced code blocks are left
// untouched, since blank lines there are real content.
export function preserveBlankLines(md: string): string {
  // split() with a capturing group keeps the fences; odd indices are the
  // captured code blocks, even indices the prose between them.
  return md
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/\n{3,}/g, (run) => "\n\n" + "\u00A0\n\n".repeat(run.length - 2)),
    )
    .join("");
}

// Wraps text nodes inside ReactMarkdown output with `<Tokenized>` so the
// preview supports hover-to-define and click-to-add. Stops at <code>/<pre>.
function tokenizeChildren(
  children: React.ReactNode,
  lang: LanguageCode,
  showRuby: boolean,
): React.ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string" || typeof child === "number") {
      const text = String(child);
      // Skip whitespace-only strings; rendering them via Tokenized adds DOM
      // overhead for no gain.
      if (!text.trim()) return text;
      return <Tokenized text={text} lang={lang} showRuby={showRuby} />;
    }
    if (isValidElement(child)) {
      const t = child.type as unknown;
      const tag = typeof t === "string" ? t : "";
      // Don't tokenize code samples — they aren't natural-language text.
      if (tag === "code" || tag === "pre") return child;
      const props = child.props as { children?: React.ReactNode };
      const next = tokenizeChildren(props.children, lang, showRuby);
      return cloneElement(child, undefined, next);
    }
    return child;
  });
}

function tokenizedMarkdownComponents(lang: LanguageCode, showRuby: boolean) {
  const wrap =
    <T extends keyof React.JSX.IntrinsicElements>(Tag: T) =>
    ({ children }: { children?: React.ReactNode }) => {
      const C = Tag as unknown as React.ElementType;
      return <C>{tokenizeChildren(children, lang, showRuby)}</C>;
    };
  return {
    p: wrap("p"),
    li: wrap("li"),
    td: wrap("td"),
    th: wrap("th"),
    blockquote: wrap("blockquote"),
    h1: wrap("h1"),
    h2: wrap("h2"),
    h3: wrap("h3"),
    h4: wrap("h4"),
    h5: wrap("h5"),
    h6: wrap("h6"),
  };
}
