import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  ClipboardPaste,
  Gauge,
  Headphones,
  Loader2,
  Minus,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Sparkles,
  Trash2,
  Type,
  Upload,
  X,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  SidebarCollapser,
  useSidebarCollapse,
} from "@/components/sidebar-collapser";
import { toast } from "sonner";
import { useSession } from "@/lib/session-context";
import { SourceDocPageOverlay } from "@/components/page-overlay-reader";
import { HOSTED } from "@/lib/build-flags";
import {
  consumePendingReaderOpen,
  onOpenReaderDoc,
} from "@/lib/reader-open-event";
import { PasteTextDialog } from "@/components/paste-text-dialog";
import { BookImportDialog } from "@/components/book-import-dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tokenized } from "@/components/tokenized";
import {
  deleteReaderDoc,
  getReaderAudio,
  listBookChapters,
  listChapters,
  listLibrary,
  listReaderDocs,
  listReaderVariants,
  listSessions,
  listVocab,
  saveReaderAudio,
  saveReaderDoc,
  type ReaderDocument,
  type ReaderLevel,
} from "@/lib/db";
import { useProviderConfigs } from "@/lib/provider-context";
import { useWorkspace } from "@/lib/workspace-context";
import { setWorkspaceFocus } from "@/lib/focus";
import { useProfile } from "@/lib/profile-context";
import { languageName } from "@/lib/languages";
import { buildSimplifyMessages, levelTitle, studentLevelFor } from "@/lib/text-simplifier";
import { splitThinking } from "@/components/thinking-block";
import { synthesizeBytes, bcp47ForLang } from "@/lib/tts";
import { useTTS } from "@/lib/tts-context";
import { cn } from "@/lib/utils";

// "k+1" is Krashen's i+1 hypothesis adapted to vocab — text built mostly
// from words the student already knows, plus a controlled trickle of
// new ones (~1 new per 20 known). Default for the dialog because it
// produces the most useful comprehensible-input passages; the CEFR
// levels stay available for fixed-difficulty practice.
const K1_LEVEL = "k+1 (your vocab + a few new words)";

// Reader prose size — a device/eyesight preference, so it's global
// (one localStorage key, not per workspace) and persists across
// sessions. 16px matches the previous hard-coded `text-[16px]`.
const FONT_SIZE_KEY = "reader.fontSize";
const FONT_SIZE_MIN = 13;
const FONT_SIZE_MAX = 26;
const FONT_SIZE_DEFAULT = 16;

function readStoredFontSize(): number {
  try {
    const n = Number(localStorage.getItem(FONT_SIZE_KEY));
    if (Number.isFinite(n) && n >= FONT_SIZE_MIN && n <= FONT_SIZE_MAX) return n;
  } catch {
    /* localStorage may be denied */
  }
  return FONT_SIZE_DEFAULT;
}

// Decode arbitrary audio bytes via Web Audio API and re-encode them as
// PCM-WAV. We do this for the reader's audio bar specifically because
// WebKit2GTK's HTMLAudioElement decoder rejects long/concatenated MP3
// streams from edge-tts on some Linux installs (NotSupportedError /
// MEDIA_ERR_SRC_NOT_SUPPORTED) — even with all GStreamer plugins
// installed. The Web Audio API uses a different decoder pipeline that
// accepts those same bytes, so decoding once and feeding raw WAV back
// into the audio element sidesteps the issue. WAV plays via wavparse
// which is in gst-plugins-good and reliably available. The cost is a
// one-time ~50–200 ms decode + a larger Blob (PCM is ~10× MP3 by size)
// — acceptable for a one-shot reader passage, and it means the player
// "just works" without the user installing anything else.
// One unit of "currently being spoken" — a word for Edge, a sentence
// for backends without per-word timing. Times are in audio-buffer ms;
// `charStart`/`charEnd` index into the original doc body so the
// highlighter can paint over the same text the reader already
// renders (no need to re-display the cleaned text).
type ReaderHighlight = {
  startMs: number;
  endMs: number;
  charStart: number;
  charEnd: number;
};

// Walk Edge's word-boundary list and resolve each word back to a
// character range in the original (markdown-laden) body. We use a
// sequential `indexOf(word, cursor)` rather than the boundary's
// reported character offset because Edge offsets are computed against
// the cleaned SSML payload — markdown stripping shifts every
// position, so the offset is unusable for highlighting in the source
// pane. Sequential matching is robust to that shift since markdown
// chunks live *between* words, not inside them.
function buildWordHighlights(
  body: string,
  boundaries: { offsetMs: number; durationMs: number; text: string }[],
): ReaderHighlight[] {
  const out: ReaderHighlight[] = [];
  let cursor = 0;
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i];
    const word = b.text;
    if (!word) continue;
    const at = body.indexOf(word, cursor);
    if (at < 0) continue;
    // Extend each highlight to the next word's start (or its own
    // duration when it's the last) — Edge's reported `Duration`
    // sometimes ends slightly before the next word, leaving a
    // flickery un-highlighted gap between syllables.
    const next = boundaries[i + 1];
    const endMs = next ? next.offsetMs : b.offsetMs + b.durationMs;
    out.push({
      startMs: b.offsetMs,
      endMs,
      charStart: at,
      charEnd: at + word.length,
    });
    cursor = at + word.length;
  }
  return out;
}

// Sentence-level fallback for backends that don't expose word timing
// (OpenAI, ElevenLabs, MiniMax, Fish, Browser). We linearly distribute
// audio time across sentence character counts in the cleaned text,
// then map each sentence back into the source body. Less precise than
// word-level, but follows the prose well enough to be useful.
function buildSentenceHighlights(
  body: string,
  cleaned: string,
  durationMs: number,
): ReaderHighlight[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  // Split on Latin + CJK sentence terminators. The lookbehind keeps
  // the punctuation glued to the sentence preceding it.
  const sentences = cleaned
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length === 0) return [];
  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0);
  const out: ReaderHighlight[] = [];
  let cursorBody = 0;
  let cumulative = 0;
  for (const s of sentences) {
    const startMs = (cumulative / totalChars) * durationMs;
    cumulative += s.length;
    const endMs = (cumulative / totalChars) * durationMs;
    // Find this sentence in the body via a stable fingerprint — the
    // first ~24 chars are usually unique enough and survive the
    // cleaner stripping markdown / blur spans / table rows out.
    const fp = s.slice(0, Math.min(24, s.length));
    const at = body.indexOf(fp, cursorBody);
    if (at < 0) continue;
    const charEnd = Math.min(body.length, at + s.length);
    out.push({ startMs, endMs, charStart: at, charEnd });
    cursorBody = charEnd;
  }
  return out;
}

async function decodeToWavBlob(
  bytes: Uint8Array,
): Promise<{ blob: Blob; mime: string; durationMs: number }> {
  // Copy into a fresh ArrayBuffer so decodeAudioData can take ownership
  // (it transfers / detaches the buffer; using the original would
  // invalidate `bytes` for any subsequent caller).
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const Ctx =
    (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error("AudioContext unavailable");
  const ctx = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(ab);
  } finally {
    void ctx.close();
  }
  // Duration here is exact and available immediately — the audio
  // element's `loadedmetadata` event arrives later and is sometimes
  // unreliable on WebKit (NaN/Infinity) for short buffers, so we
  // surface the AudioBuffer's duration too.
  const durationMs = (decoded.length / decoded.sampleRate) * 1000;
  return {
    blob: new Blob([encodeWav(decoded)], { type: "audio/wav" }),
    mime: "audio/wav",
    durationMs,
  };
}

function encodeWav(audio: AudioBuffer): ArrayBuffer {
  const numChannels = audio.numberOfChannels;
  const sampleRate = audio.sampleRate;
  const samples = audio.length;
  // Interleave channels into a single Float32Array, then quantise to s16.
  const interleaved = new Float32Array(samples * numChannels);
  for (let ch = 0; ch < numChannels; ch++) {
    const data = audio.getChannelData(ch);
    for (let i = 0; i < samples; i++) {
      interleaved[i * numChannels + ch] = data[i];
    }
  }
  const dataLen = interleaved.length * 2; // s16 = 2 bytes
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  // RIFF header
  writeAscii(dv, 0, "RIFF");
  dv.setUint32(4, 36 + dataLen, true);
  writeAscii(dv, 8, "WAVE");
  // fmt sub-chunk
  writeAscii(dv, 12, "fmt ");
  dv.setUint32(16, 16, true); // PCM fmt size
  dv.setUint16(20, 1, true); // PCM format
  dv.setUint16(22, numChannels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * numChannels * 2, true); // byte rate
  dv.setUint16(32, numChannels * 2, true); // block align
  dv.setUint16(34, 16, true); // bits per sample
  // data sub-chunk
  writeAscii(dv, 36, "data");
  dv.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < interleaved.length; i++) {
    const s = Math.max(-1, Math.min(1, interleaved[i]));
    dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buf;
}

function writeAscii(dv: DataView, off: number, s: string) {
  for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
}
const LEVELS = [
  K1_LEVEL,
  "A1 (beginner)",
  "A2 (elementary)",
  "B1 (intermediate)",
  "B2 (upper-intermediate)",
  "C1 (advanced)",
];
const LENGTHS = [
  { id: "short", label: "Short (~80 words)", words: 80 },
  { id: "medium", label: "Medium (~200 words)", words: 200 },
  { id: "long", label: "Long (~400 words)", words: 400 },
];

export function ReaderView() {
  const { active: workspace } = useWorkspace();
  const { ensureStarted, endIfActive } = useSession();
  // End-on-unmount session id. Set when the reader's auto-start
  // creates a session; used by the cleanup effect at the bottom to
  // close it cleanly when the user navigates away. Chip-started
  // sessions return created=false and are preserved.
  const readingSessionIdRef = useRef<number | null>(null);
  const { active: provider, sendChat, providers } = useProviderConfigs();
  const { config: ttsConfig } = useTTS();
  const { profile } = useProfile();
  const [docs, setDocs] = useState<ReaderDocument[]>([]);
  const [active, setActive] = useState<ReaderDocument | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  // Saved-passages list — collapsible via the seam chevron. Persisted
  // per-view so collapsing one secondary pane doesn't affect others.
  const { open: sidebarOpen, toggle: toggleSidebar } = useSidebarCollapse(
    "reader.sidebarOpen",
  );
  // Audio listener — opens after the user clicks "Audio" on the active
  // doc. Lazy: we only synthesise when the dialog opens (to avoid
  // burning TTS credits / quota on every reader doc visit).
  const [audioOpen, setAudioOpen] = useState(false);
  // Prose size for the rendered passage. Stepper lives in the toolbar
  // (the "Aa" popover); writes through to localStorage on change.
  const [fontSize, setFontSize] = useState<number>(() => readStoredFontSize());
  function applyFontSize(next: number) {
    const clamped = Math.min(
      FONT_SIZE_MAX,
      Math.max(FONT_SIZE_MIN, Math.round(next)),
    );
    setFontSize(clamped);
    try {
      localStorage.setItem(FONT_SIZE_KEY, String(clamped));
    } catch {
      /* localStorage may be denied */
    }
  }
  // Char range in the active doc's body that the audio player is
  // currently "speaking". `null` when the player is paused, closed,
  // or before the first boundary. Drives the karaoke highlight in
  // the rendered passage below.
  const [ttsRange, setTtsRange] = useState<[number, number] | null>(null);
  const [saving, setSaving] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [showBook, setShowBook] = useState(false);
  // Variants of the current active doc (original + any beginner / intermediate
  // children). Drives the level switcher.
  const [variants, setVariants] = useState<ReaderDocument[]>([]);
  const [generatingLevel, setGeneratingLevel] = useState<ReaderLevel | null>(null);
  // Chapters of the parent book (when the active doc is part of one).
  const [bookChapters, setBookChapters] = useState<ReaderDocument[]>([]);

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    listReaderDocs(workspace.id)
      .then((rows) => {
        if (cancelled) return;
        setDocs(rows);
        // Honour a pending "open this doc" request (e.g. notes OCR → Open in
        // Reader); otherwise fall back to the most recent doc.
        const pend = consumePendingReaderOpen();
        const target = pend != null ? rows.find((d) => d.id === pend) : null;
        if (target) setActive(target);
        else if (rows.length > 0) setActive(rows[0]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace?.id]);

  // Open-by-id requests from elsewhere (notes OCR "Open in Reader"): refresh
  // so a just-created doc is present, then select it.
  useEffect(() => {
    if (!workspace) return;
    return onOpenReaderDoc((id) => {
      void listReaderDocs(workspace.id).then((rows) => {
        setDocs(rows);
        const doc = rows.find((d) => d.id === id);
        if (doc) {
          setActive(doc);
          setEditing(false);
        }
      });
    });
  }, [workspace?.id]);

  // Treat looking at a passage as a reading session.
  useEffect(() => {
    if (active && !editing) {
      void ensureStarted("reading").then(({ session: s, created }) => {
        if (created) readingSessionIdRef.current = s.id;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, editing]);

  // End the session when the user leaves the Reader view. Without
  // this, the row stays open until the 5-min idle timer fires, so
  // the dashboard's "today's hours" widget under-reports until much
  // later.
  useEffect(() => {
    return () => {
      const id = readingSessionIdRef.current;
      if (id != null) {
        void endIfActive(id).catch(() => {
          /* best-effort */
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the active doc changes, load its variant siblings + its book's
  // chapter list so the level switcher and chapter pager have data to render.
  useEffect(() => {
    if (!active) {
      setVariants([]);
      setBookChapters([]);
      return;
    }
    const parentId = active.parentId ?? active.id;
    let cancelled = false;
    void listReaderVariants(parentId).then((v) => {
      if (!cancelled) setVariants(v);
    });
    if (active.libraryItemId != null) {
      void listBookChapters(active.libraryItemId).then((c) => {
        if (!cancelled) setBookChapters(c);
      });
    } else {
      setBookChapters([]);
    }
    // Tell the chat what the student is focused on right now. The
    // tutor uses this to open with topic-relevant prompts ("want to
    // talk about restaurants?" when chapter 4 of 标准教程 is active).
    // Fire-and-forget — failure here shouldn't block opening a doc.
    if (workspace?.id) {
      void setWorkspaceFocus({
        workspaceId: workspace.id,
        readerDocId: active.id,
        libraryItemId: active.libraryItemId ?? null,
      }).catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [active?.id, active?.parentId, active?.libraryItemId, workspace?.id]);

  function startNew() {
    setActive(null);
    setEditing(true);
    setTitle("");
    setBody("");
  }

  function startEdit(d: ReaderDocument) {
    setActive(d);
    setEditing(true);
    setTitle(d.title);
    setBody(d.body);
  }

  async function refresh() {
    if (!workspace) return;
    setDocs(await listReaderDocs(workspace.id));
  }

  /**
   * Switch the reader to a different difficulty level. If the variant already
   * exists, just activate it. Otherwise generate it via the active provider,
   * save as a child reader_document, and switch.
   */
  async function switchToLevel(level: ReaderLevel) {
    if (!active || !workspace) return;
    const parentId = active.parentId ?? active.id;
    const existing = variants.find((v) => v.level === level);
    if (existing) {
      setActive(existing);
      return;
    }
    if (level === "original") {
      // Should always exist — bail safely.
      const parent = variants.find((v) => v.level === "original") ?? active;
      setActive(parent);
      return;
    }
    if (!provider) {
      toast.error("Configure a provider in Settings first", {
        description: "AI simplification needs an LLM (any provider works).",
      });
      return;
    }

    setGeneratingLevel(level);
    try {
      // Pull the original body — that's what we rewrite, not whatever the
      // current variant happens to be.
      const original = variants.find((v) => v.level === "original") ?? active;
      // Snapshot context the simplifier needs. Cap vocab — only used
      // for level computation + the prompt's known-words list, which
      // tops out at a few hundred entries.
      const [vocab, sessions] = await Promise.all([
        listVocab(workspace.id, 2000),
        listSessions(workspace.id),
      ]);
      const immersionHours =
        sessions.reduce((s, x) => s + (x.durationSecs ?? 0), 0) / 3600;
      const studentLevelId = studentLevelFor({
        lang: workspace.targetLang,
        vocab,
        immersionHours,
        goalLevelId: profile.goalLevel,
      });
      const messages = buildSimplifyMessages({
        body: original.body,
        level,
        targetLang: workspace.targetLang,
        nativeLang: workspace.nativeLang,
        vocab,
        studentLevelId,
      });
      const reply = await sendChat({ messages, onToken: () => {} });
      const cleaned = reply.trim();
      if (!cleaned) throw new Error("Provider returned an empty rewrite.");
      const saved = await saveReaderDoc({
        workspaceId: workspace.id,
        title: levelTitle(original.title, level),
        body: cleaned,
        sourceUrl: original.sourceUrl ?? null,
        parentId: original.id,
        level,
        libraryItemId: original.libraryItemId ?? null,
        chapterPosition: original.chapterPosition ?? null,
      });
      setVariants((prev) => [...prev, saved]);
      setActive(saved);
      toast.success(`Generated ${level} version`);
    } catch (err) {
      toast.error("Couldn't generate", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setGeneratingLevel(null);
    }
    void parentId;
  }

  async function save() {
    if (!workspace) return;
    if (!title.trim() && !body.trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const next = await saveReaderDoc({
        id: active?.id,
        workspaceId: workspace.id,
        title: title.trim() || "Untitled passage",
        body,
      });
      await refresh();
      setActive(next);
      setEditing(false);
      toast.success("Passage saved");
    } finally {
      setSaving(false);
    }
  }

  async function remove(d: ReaderDocument) {
    if (!workspace) return;
    await deleteReaderDoc(d.id);
    const refreshed = await listReaderDocs(workspace.id);
    setDocs(refreshed);
    if (active?.id === d.id) setActive(refreshed[0] ?? null);
  }

  async function onGenerated(generatedTitle: string, generatedBody: string) {
    if (!workspace) return;
    const next = await saveReaderDoc({
      workspaceId: workspace.id,
      title: generatedTitle,
      body: generatedBody,
    });
    await refresh();
    setActive(next);
    setEditing(false);
    setShowGenerate(false);
  }

  if (!workspace) return null;

  return (
    <div className="relative flex h-full">
      {sidebarOpen && (
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between gap-2 px-4 pt-5 pb-3">
          <div>
            <h2 className="font-serif text-xl tracking-tight">Reader</h2>
            <p className="text-[11.5px] text-muted-foreground">Saved passages</p>
          </div>
          <div className="flex gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setShowBook(true)}
              title="Upload a book (PDF or .txt)"
            >
              <Upload className="size-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setShowPaste(true)}
              title="Paste text (free, no AI)"
            >
              <ClipboardPaste className="size-4" />
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={() => setShowGenerate(true)} title="Generate with AI">
              <Sparkles className="size-4" />
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={startNew} title="New passage (blank editor)">
              <Plus className="size-4" />
            </Button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {loading ? (
            <p className="px-2 py-2 text-[12px] text-muted-foreground">Loading…</p>
          ) : docs.length === 0 ? (
            <p className="px-2 py-2 text-[12px] text-muted-foreground">
              No passages saved yet.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {docs.map((d) => (
                <li
                  key={d.id}
                  className={cn(
                    "group flex items-center gap-1 rounded-md transition-colors",
                    active?.id === d.id ? "bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  <button
                    onClick={() => {
                      setActive(d);
                      setEditing(false);
                    }}
                    className="flex-1 truncate px-2 py-1.5 text-left text-[13px]"
                  >
                    <span className="font-medium">{d.title}</span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="opacity-0 group-hover:opacity-100"
                    onClick={() => void remove(d)}
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
        visibleLabel="Hide passages"
        hiddenLabel="Show passages"
      />

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl xl:max-w-4xl 2xl:max-w-5xl px-8 py-8">
          {!editing && !active && (
            <ReaderEmpty
              onStart={startNew}
              onGenerate={() => setShowGenerate(true)}
              target={languageName(workspace.targetLang)}
            />
          )}

          {(editing || active) && (
            <>
              <div className="mb-5 flex items-center gap-3">
                <Input
                  value={editing ? title : active!.title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={!editing}
                  placeholder="Passage title"
                  className="flex-1 border-0 bg-transparent px-0 font-serif !text-3xl shadow-none focus-visible:ring-0"
                />
                {editing ? (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={save} disabled={saving}>
                      {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                      Save
                    </Button>
                  </>
                ) : (
                  <>
                    {/* Audio listener — only meaningful when there's a
                        body to read. Synth is lazy: clicking opens the
                        dialog which kicks off the TTS request, so the
                        cost is paid per click rather than per visit. */}
                    {active?.body && active.body.trim().length > 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setAudioOpen(true)}
                        title="Listen to this passage"
                      >
                        <Headphones className="size-3.5" />
                        Audio
                      </Button>
                    )}
                    {/* Prose-size stepper. A popover (not blind A−/A+
                        clicks) so the user sees the current value and
                        has a one-click way back to the default. */}
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          title="Adjust text size"
                          aria-label="Adjust text size"
                        >
                          <Type className="size-3.5" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-48 p-3">
                        <p className="mb-2 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                          Text size
                        </p>
                        <div className="flex items-center justify-between gap-2">
                          <Button
                            size="icon-sm"
                            variant="outline"
                            onClick={() => applyFontSize(fontSize - 1)}
                            disabled={fontSize <= FONT_SIZE_MIN}
                            aria-label="Smaller text"
                          >
                            <Minus className="size-3.5" />
                          </Button>
                          <span className="text-[13px] font-medium tabular-nums">
                            {fontSize}px
                          </span>
                          <Button
                            size="icon-sm"
                            variant="outline"
                            onClick={() => applyFontSize(fontSize + 1)}
                            disabled={fontSize >= FONT_SIZE_MAX}
                            aria-label="Larger text"
                          >
                            <Plus className="size-3.5" />
                          </Button>
                        </div>
                        {fontSize !== FONT_SIZE_DEFAULT && (
                          <button
                            type="button"
                            onClick={() => applyFontSize(FONT_SIZE_DEFAULT)}
                            className="mt-2 w-full cursor-pointer text-center text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                          >
                            Reset to {FONT_SIZE_DEFAULT}px
                          </button>
                        )}
                      </PopoverContent>
                    </Popover>
                    <Button size="sm" variant="outline" onClick={() => active && startEdit(active)}>
                      Edit
                    </Button>
                  </>
                )}
              </div>

              {/* Level switcher — appears whenever we have an Original to
                  rewrite from. Always shows Original + the two simplified
                  levels; existing variants load instantly, missing ones
                  generate on demand via the active provider. */}
              {!editing && active && (
                <LevelSwitcher
                  active={active}
                  variants={variants}
                  generating={generatingLevel}
                  onPick={(level) => void switchToLevel(level)}
                />
              )}

              {/* Chapter pager — only when this doc is part of a book. */}
              {!editing && active && bookChapters.length > 1 && (
                <ChapterPager
                  chapters={bookChapters}
                  active={active}
                  onPick={(d) => setActive(d)}
                />
              )}

              {editing ? (
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder={`Paste a passage in ${languageName(
                    workspace.targetLang,
                  )} — hover words in the rendered view to look them up and save them to vocabulary.`}
                  className="min-h-[60vh] w-full resize-y rounded-md border border-input bg-background px-3 py-3 text-[14.5px] leading-relaxed shadow-xs focus:outline-none focus:ring-2 focus:ring-ring"
                />
              ) : !HOSTED && active?.sourceDocumentId != null ? (
                // Image / PDF-backed doc: render the actual page with clickable
                // word hotspots over it. "Edit" toggles the OCR text instead.
                <SourceDocPageOverlay
                  sourceDocumentId={active.sourceDocumentId}
                  pageIndex={active.pageStart ?? 0}
                  lang={workspace.targetLang}
                />
              ) : (
                // Line height is unitless so it scales with the chosen
                // font size — ruby/pinyin above CJK tokens needs the
                // extra leading at every size.
                <div style={{ fontSize: `${fontSize}px`, lineHeight: 2.4 }}>
                  <Tokenized
                    text={active!.body}
                    lang={workspace.targetLang}
                    activeRange={ttsRange}
                  />
                </div>
              )}
            </>
          )}
        </div>
        </div>

        {/* Bottom media-player bar. Mounted only while the user has
            opened audio for the active doc; cached audio loads
            instantly, otherwise we synthesise + persist on first open
            so subsequent opens are free. */}
        {active && audioOpen && (
          <AudioPlayerBar
            key={active.id}
            doc={active}
            onClose={() => {
              setAudioOpen(false);
              setTtsRange(null);
            }}
            onCached={(mime) => {
              setActive((prev) =>
                prev && prev.id === active.id
                  ? { ...prev, hasAudio: true, audioMime: mime }
                  : prev,
              );
              setVariants((prev) =>
                prev.map((v) =>
                  v.id === active.id
                    ? { ...v, hasAudio: true, audioMime: mime }
                    : v,
                ),
              );
            }}
            onActiveRangeChange={setTtsRange}
            ttsConfig={ttsConfig}
            fallbackOpenaiKey={
              providers.find((p) => p.kind === "openai")?.apiKey ?? undefined
            }
            fallbackMinimaxKey={
              providers.find((p) => p.kind === "minimax")?.apiKey ?? undefined
            }
            lang={workspace.targetLang}
          />
        )}
      </div>

      <GenerateDialog
        open={showGenerate}
        onClose={() => setShowGenerate(false)}
        onGenerated={onGenerated}
      />

      <PasteTextDialog
        open={showPaste}
        onClose={() => setShowPaste(false)}
        onImported={async (genTitle, genBody, sourceUrl) => {
          if (!workspace) return;
          const next = await saveReaderDoc({
            workspaceId: workspace.id,
            title: genTitle,
            body: genBody,
            sourceUrl,
          });
          await refresh();
          setActive(next);
          setEditing(false);
          setShowPaste(false);
        }}
      />


      <BookImportDialog
        open={showBook}
        onClose={() => setShowBook(false)}
        onImported={async (firstChapterId) => {
          await refresh();
          if (workspace) {
            const all = await listReaderDocs(workspace.id);
            const first = all.find((d) => d.id === firstChapterId);
            if (first) setActive(first);
          }
          setEditing(false);
          setShowBook(false);
        }}
      />

    </div>
  );
}

/** Pill toggle for Original / Intermediate / Beginner. Always visible when a
 *  doc is open — clicking a missing level triggers AI generation. */
function LevelSwitcher({
  active,
  variants,
  generating,
  onPick,
}: {
  active: ReaderDocument;
  variants: ReaderDocument[];
  generating: ReaderLevel | null;
  onPick: (level: ReaderLevel) => void;
}) {
  const levels: { id: ReaderLevel; label: string }[] = [
    { id: "original", label: "Original" },
    { id: "intermediate", label: "Intermediate" },
    { id: "beginner", label: "Beginner" },
  ];
  const currentLevel: ReaderLevel = active.level;
  const present = new Set<ReaderLevel>();
  for (const v of variants) present.add(v.level);
  present.add(currentLevel);

  return (
    <div className="mb-4 flex items-center gap-2">
      <span className="text-[11.5px] uppercase tracking-wider text-muted-foreground">
        Level
      </span>
      <div className="inline-flex rounded-full border border-border bg-muted/40 p-0.5">
        {levels.map((lvl) => {
          const isActive = currentLevel === lvl.id;
          const isLoading = generating === lvl.id;
          const cached = present.has(lvl.id);
          return (
            <button
              key={lvl.id}
              type="button"
              disabled={generating !== null || isActive}
              onClick={() => onPick(lvl.id)}
              className={cn(
                "relative rounded-full px-3 py-1 text-[12px] font-medium transition",
                isActive
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title={
                cached
                  ? `Switch to ${lvl.label}`
                  : `Generate a ${lvl.label.toLowerCase()} version with AI`
              }
            >
              {isLoading ? (
                <span className="inline-flex items-center gap-1">
                  <Loader2 className="size-3 animate-spin" />
                  {lvl.label}
                </span>
              ) : (
                <>
                  {lvl.label}
                  {!cached && lvl.id !== "original" && (
                    <span
                      aria-hidden
                      className="ml-1 inline-block size-1 rounded-full bg-primary/60 align-middle"
                    />
                  )}
                </>
              )}
            </button>
          );
        })}
      </div>
      {generating && (
        <span className="text-[11.5px] text-muted-foreground">
          Rewriting with AI…
        </span>
      )}
    </div>
  );
}

/** Prev / Next chapter pager — only rendered when the active doc belongs to a
 *  book (i.e. `bookChapters` is populated). */
function ChapterPager({
  chapters,
  active,
  onPick,
}: {
  chapters: ReaderDocument[];
  active: ReaderDocument;
  onPick: (d: ReaderDocument) => void;
}) {
  const lookupId = active.parentId ?? active.id;
  const realIdx = chapters.findIndex((c) => c.id === lookupId);
  if (realIdx === -1) return null;
  const prev = realIdx > 0 ? chapters[realIdx - 1] : null;
  const next = realIdx < chapters.length - 1 ? chapters[realIdx + 1] : null;
  return (
    <div className="mb-5 flex items-center justify-between gap-2 rounded-md border border-border bg-card/50 px-3 py-2 text-[12.5px]">
      <button
        type="button"
        disabled={!prev}
        onClick={() => prev && onPick(prev)}
        className="max-w-[40%] truncate text-left text-muted-foreground hover:text-foreground disabled:opacity-30"
      >
        ← {prev?.title ?? "Start of book"}
      </button>
      <span className="text-[11.5px] text-muted-foreground">
        Chapter {realIdx + 1} of {chapters.length}
      </span>
      <button
        type="button"
        disabled={!next}
        onClick={() => next && onPick(next)}
        className="max-w-[40%] truncate text-right text-muted-foreground hover:text-foreground disabled:opacity-30"
      >
        {next?.title ?? "End of book"} →
      </button>
    </div>
  );
}

function ReaderEmpty({
  onStart,
  onGenerate,
  target,
}: {
  onStart: () => void;
  onGenerate: () => void;
  target: string;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card/50 px-8 py-14 text-center">
      <div className="mx-auto mb-3 inline-flex size-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <BookOpen className="size-5" />
      </div>
      <h3 className="font-serif text-2xl tracking-tight">Read with click-to-define</h3>
      <p className="mx-auto mt-2 max-w-md text-[13.5px] text-muted-foreground">
        Paste any {target} text — every word becomes hoverable for pinyin and a
        one-click save into your vocabulary list.
      </p>
      <div className="mt-5 flex justify-center gap-2">
        <Button onClick={onGenerate}>
          <Sparkles className="size-4" />
          Generate with AI
        </Button>
        <Button onClick={onStart} variant="outline">
          <Plus className="size-4" />
          Paste your own
        </Button>
      </div>
    </div>
  );
}

function GenerateDialog({
  open,
  onClose,
  onGenerated,
}: {
  open: boolean;
  onClose: () => void;
  onGenerated: (title: string, body: string) => void | Promise<void>;
}) {
  const { active: workspace } = useWorkspace();
  const { active: provider, sendChat } = useProviderConfigs();
  const [topic, setTopic] = useState("");
  // Default to k+1 — the comprehensible-input mode that uses the
  // student's actual vocabulary + textbook context. Fixed CEFR levels
  // stay available in the picker for practice at a specific level.
  const [level, setLevel] = useState(K1_LEVEL);
  const [length, setLength] = useState("medium");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setStreaming("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  async function generate() {
    if (!workspace) return;
    if (!provider) {
      setError("No provider configured. Settings → Providers.");
      return;
    }
    setBusy(true);
    setError(null);
    setStreaming("");
    const target = languageName(workspace.targetLang);
    const native = languageName(workspace.nativeLang);
    const wordTarget = LENGTHS.find((l) => l.id === length)?.words ?? 200;
    const isK1 = level === K1_LEVEL;

    let sys: string;
    let user: string;
    let derivedTopic: string | null = null;

    if (isK1) {
      // ── k+1: pull workspace context (vocab + textbook + chapters) ──
      // and build a Krashen-style "comprehensible input" prompt. We
      // load all three in parallel and only build the prompt once
      // they're back so the user doesn't sit on a stale spinner.
      const [vocab, library] = await Promise.all([
        listVocab(workspace.id, 1500).catch(() => []),
        listLibrary(workspace.id).catch(() => []),
      ]);
      // Pick the active textbook + its current chapter (first non-
      // completed) for theme alignment. If there's no active textbook
      // we just skip the textbook lines and use vocab alone.
      const activeTextbook =
        library.find((l) => l.kind === "textbook" && l.status === "active") ??
        null;
      let currentChapterTitle: string | null = null;
      if (activeTextbook) {
        const chs = await listChapters(activeTextbook.id).catch(() => []);
        const next = chs
          .sort((a, b) => a.position - b.position)
          .find((c) => c.completedAt == null);
        currentChapterTitle = next?.title ?? null;
      }

      // Mastered = use freely. Learning + recently-reviewed = sprinkle in
      // for spaced repetition. New = the few "+1" words; the model
      // chooses 0–3 to introduce so the passage stays comprehensible.
      const mastered = vocab
        .filter((v) => v.status === "mastered")
        .slice(0, 250)
        .map((v) => v.word);
      const learning = vocab
        .filter((v) => v.status === "learning" || v.status === "review")
        .slice(0, 80)
        .map((v) => v.word);
      // "Last words learned" — sort by lastReview desc, take the freshest 20.
      // Helps the model focus the passage around things the user just saw.
      const recentlyReviewed = [...vocab]
        .filter((v) => v.lastReview != null)
        .sort((a, b) => (b.lastReview ?? 0) - (a.lastReview ?? 0))
        .slice(0, 20)
        .map((v) => v.word);

      // Topic resolution: explicit user input wins; otherwise pick from
      // textbook chapter title or recent words. We surface the chosen
      // topic in the dialog after generation so the user sees what
      // theme the model used.
      if (topic.trim()) {
        derivedTopic = topic.trim();
      } else if (currentChapterTitle) {
        derivedTopic = `the theme of "${currentChapterTitle}"`;
      } else if (recentlyReviewed.length > 0) {
        derivedTopic = `something using these recently-studied words: ${recentlyReviewed.slice(0, 6).join(", ")}`;
      } else {
        derivedTopic = "any everyday topic";
      }

      // Strict prompt. Weaker / smaller models routinely
      // ignore softer instructions ("try to use mostly known words"),
      // so we lean hard on absolutes — capitalised RULES, percentage
      // thresholds, an explicit allowlist for function words, and a
      // hard cap on new vocabulary. The negative ("DO NOT use...")
      // framing is what reliably moves smaller models.
      const lines: string[] = [
        `You are a graded-reader passage generator for a ${native}-speaking learner of ${target}.`,
        `Output ONLY the passage in ${target}. No preamble, no headings, no translation, no romanisation, no markdown formatting beyond paragraph breaks.`,
        `Target length: about ${wordTarget} words. Use natural sentence variety and a clear beginning / middle / end.`,
        "",
        `## CRITICAL K+1 RULE`,
        ``,
        `**K (what the student knows):** the vocabulary lists below are the EXACT words the student has actually studied in this app. Build the passage PRIMARILY from these words.`,
        ``,
        `**+1 (new words):** introduce at most 3-5 truly new words — words the student has never seen. New words must:`,
        `- Be inferable from surrounding context.`,
        `- Be useful, high-frequency, and appropriate for the student's level.`,
        `- NOT be obscure, archaic, or specialised vocabulary.`,
        ``,
        `## ABSOLUTE RULES`,
        ``,
        `- **90%+ of content words must come from the KNOWN, LEARNING, or RECENTLY REVIEWED lists below.**`,
        `- DO NOT use vocabulary outside those lists unless it is one of your 3-5 designated new words.`,
        `- If the topic forces an unfamiliar word, either (a) make it one of the 3-5 new words, or (b) pick a simpler topic — NEVER raise the difficulty above the student's level.`,
        `- Function words / particles / pronouns / numbers / time words / measure words / common verbs are always OK even if not explicitly listed.`,
        `- If you cannot write a coherent passage at this level, write a SHORTER passage about a SIMPLER topic. Don't reach for unfamiliar words.`,
      ];
      if (mastered.length > 0) {
        lines.push(
          "",
          `### KNOWN VOCABULARY (mastered — backbone of the passage):`,
          mastered.join("、"),
        );
      }
      if (learning.length > 0) {
        lines.push(
          "",
          `### CURRENTLY LEARNING (weave 5-10 of these in for spaced reinforcement):`,
          learning.join("、"),
        );
      }
      if (recentlyReviewed.length > 0) {
        lines.push(
          "",
          `### RECENTLY REVIEWED (anchor the passage around these when natural):`,
          recentlyReviewed.join("、"),
        );
      }
      if (activeTextbook) {
        lines.push("", `### TEXTBOOK CONTEXT`, "");
        lines.push(
          `The student is currently working through "${activeTextbook.title}"${activeTextbook.author ? ` by ${activeTextbook.author}` : ""}.`,
        );
        if (currentChapterTitle) {
          lines.push(
            `They're on chapter: "${currentChapterTitle}". Keep the topic and tone broadly aligned with the chapter's theme.`,
          );
        }
      }
      if (mastered.length === 0 && learning.length === 0) {
        // Fresh workspace fallback — no vocab yet, so we can't anchor
        // to known words. Default to absolute beginner level instead
        // of letting the model freelance.
        lines.push(
          "",
          `### NOTE`,
          ``,
          `The student has no saved vocabulary yet — write at absolute-beginner (A1) level so they can start ingesting words.`,
        );
      }
      sys = lines.join("\n");
      user = `Write a passage about: ${derivedTopic}.\n\nRemember: 90%+ of content words must come from the lists above. Maximum 3-5 new words.`;
    } else {
      // Regular fixed-difficulty path — unchanged from before.
      const subject = topic.trim() || "any everyday topic";
      derivedTopic = subject;
      sys =
        `You generate short reading passages in ${target} for ${native}-speaking language learners. ` +
        `Output ONLY the passage in ${target} — no preamble, no translation, no markdown. ` +
        `Use vocabulary appropriate for level ${level}. Aim for around ${wordTarget} words. Use natural sentence variety.`;
      user = `Write a passage about: ${subject}`;
    }

    // Streaming buffer holds the raw model output (including any
    // <think>...</think> blocks). The visible preview is derived from
    // it via splitThinking on each tick so reasoning never leaks into
    // the user-visible stream.
    let raw = "";
    try {
      const reply = await sendChat({
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        onToken: (delta) => {
          raw += delta;
          // Re-derive the visible portion from the accumulated raw
          // string. splitThinking handles a partial open tag (without
          // close yet) by hiding everything after the open — so the
          // preview stops moving while the model is "thinking" and
          // resumes once the closing tag arrives. Cheap to recompute
          // at typical passage lengths.
          setStreaming(splitThinking(raw).reply);
        },
      });
      // Strip <think> / <reasoning> blocks from the final body so the
      // saved reader doc is clean prose, not the model's internal
      // chain-of-thought. Any text outside the tags is preserved.
      const body = splitThinking(reply).reply.trim();
      if (!body) {
        setError("Empty reply from provider.");
        return;
      }
      // Title preference: explicit user topic > derived topic > fallback.
      const titleSeed = topic.trim() || (derivedTopic ?? "Reading");
      const generatedTitle = titleSeed
        .replace(/^the theme of "(.*)"$/, "$1")
        .slice(0, 60)
        .replace(/^./, (c) => c.toUpperCase());
      await onGenerated(generatedTitle, body);
      toast.success("Passage generated");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!workspace) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Generate a reading passage</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="gen-topic">Topic (optional)</Label>
            <Input
              id="gen-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={
                level === K1_LEVEL
                  ? "Leave blank to use your textbook chapter / recent words"
                  : "e.g. ordering coffee, weekend hike, a fairy tale…"
              }
              disabled={busy}
            />
            {level === K1_LEVEL && (
              <p className="text-[11px] text-muted-foreground">
                k+1 builds the passage from your saved vocabulary plus a few
                new words. The topic is inferred from your active textbook
                chapter and recently-studied words when left blank.
              </p>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>Difficulty</Label>
              <Select value={level} onValueChange={setLevel} disabled={busy}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEVELS.map((l) => (
                    <SelectItem key={l} value={l}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Length</Label>
              <Select value={length} onValueChange={setLength} disabled={busy}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LENGTHS.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {(streaming || busy) && (
            <div className="rounded-lg border border-border bg-muted/40 px-3 py-3 text-[13.5px] leading-relaxed">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                {busy && <Loader2 className="size-3 animate-spin" />}
                Streaming preview
              </div>
              <p className="whitespace-pre-wrap font-serif">{streaming || "…"}</p>
            </div>
          )}

          {error && (
            <p className="text-[12.5px] text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={generate} disabled={busy || !provider}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            Generate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Audio player bar ────────────────────────────────────────────────────
//
// Bottom-pinned media bar inside the reader column. Uses the native
// <audio controls> element for play/pause/scrub/speed, but plumbs the
// TTS bytes through a cache:
//   1. If the active doc has cached audio (`hasAudio`), fetch the bytes
//      from SQLite and play immediately — no provider call.
//   2. Otherwise synthesise via the configured TTS provider, persist
//      the bytes against the doc, and notify the parent so the in-
//      memory `ReaderDocument` flips `hasAudio = true` (skips the
//      generate step on the next open).
//
// Browser-default TTS can't be captured to a buffer — `synthesizeBytes`
// throws in that case. We surface the error inline so the user can
// switch providers in Settings.

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

function AudioPlayerBar({
  doc,
  onClose,
  onCached,
  onActiveRangeChange,
  ttsConfig,
  fallbackOpenaiKey,
  fallbackMinimaxKey,
  lang,
}: {
  doc: ReaderDocument;
  onClose: () => void;
  onCached: (mime: string) => void;
  /** Emitted whenever the highlighted portion of the source body
   *  changes (each new word from Edge boundaries, or each new sentence
   *  from the interpolated fallback). `null` means "nothing active" —
   *  paused/stopped/before-first-boundary. The reader uses this to
   *  drive the karaoke highlight on the rendered prose. */
  onActiveRangeChange?: (range: [number, number] | null) => void;
  ttsConfig: import("@/lib/tts").TTSConfig;
  fallbackOpenaiKey?: string;
  fallbackMinimaxKey?: string;
  lang: string;
}) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  // True after a fresh synth was persisted — the status line says
  // "Saved" so the user knows the next open won't hit the provider.
  const [savedNow, setSavedNow] = useState(false);
  // Non-fatal persistence failure (e.g. the bytes were too large for
  // the IPC bridge). Playback still works; we warn that the audio will
  // regenerate next time instead of failing silently.
  const [cacheWarn, setCacheWarn] = useState<string | null>(null);
  // Bumped by the Regenerate button; the ref tells the (re-)running
  // load effect to skip the cache and force a fresh synth.
  const [regenNonce, setRegenNonce] = useState(0);
  const forceFreshRef = useRef(false);
  const urlRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState<number>(1);
  // Pre-resolved highlight ranges for the current audio buffer. For
  // Edge backends this is per-word; for everything else it's
  // per-sentence. Empty when no boundaries / duration are known yet.
  const [highlights, setHighlights] = useState<ReaderHighlight[]>([]);
  // Track the last emitted range so we don't fire the callback on
  // every timeupdate tick — only when the active segment actually
  // changes. React would diff the tuple by reference, but we'd still
  // do unnecessary parent renders without this.
  const lastRangeRef = useRef<[number, number] | null>(null);

  // Strip chunks the TTS shouldn't read aloud: markdown headings,
  // table rows, code fences, ((translation)) blur spans.
  function cleanForSpeech(raw: string): string {
    return raw
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\|[^\n]+\|\n\|[-\s|]+\|\n(\|[^\n]+\|\n?)*/g, "")
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\(\([^()]*\)\)/g, "")
      .trim();
  }

  useEffect(() => {
    let cancelled = false;
    const forceFresh = forceFreshRef.current;
    forceFreshRef.current = false;
    setError(null);
    setAudioUrl(null);
    setFromCache(false);
    setSavedNow(false);
    setCacheWarn(null);

    // Build a Blob URL from raw audio bytes (going through the WAV
    // re-encode path) and surface the audio's exact duration. Throws
    // if decode fails — caller surfaces the error.
    const buildUrl = async (
      bytes: Uint8Array,
    ): Promise<{ url: string; durationMs: number }> => {
      if (bytes.byteLength === 0) {
        throw new Error("audio bytes are empty");
      }
      const { blob, durationMs } = await decodeToWavBlob(bytes);
      return { url: URL.createObjectURL(blob), durationMs };
    };

    // Compute highlight ranges from whatever timing data is available
    // (per-word for Edge, sentence-interpolation otherwise). Stashes
    // them in component state so the timeupdate effect can binary-
    // search for the active one each tick.
    const installHighlights = (
      boundaries: { offsetMs: number; durationMs: number; text: string }[] | null,
      durationMs: number,
    ) => {
      if (boundaries && boundaries.length > 0) {
        setHighlights(buildWordHighlights(doc.body, boundaries));
      } else {
        const cleaned = cleanForSpeech(doc.body);
        setHighlights(buildSentenceHighlights(doc.body, cleaned, durationMs));
      }
    };

    void (async () => {
      try {
        // Cache hit: pull the stored bytes and skip the provider call.
        // Skipped entirely on Regenerate — that's the point of the
        // button (new voice, fixed pronunciation, edited config).
        if (doc.hasAudio && !forceFresh) {
          const cached = await getReaderAudio(doc.id);
          if (cancelled) return;
          if (cached && cached.bytes.byteLength > 0) {
            try {
              const { url, durationMs } = await buildUrl(cached.bytes);
              if (cancelled) {
                URL.revokeObjectURL(url);
                return;
              }
              if (urlRef.current) URL.revokeObjectURL(urlRef.current);
              urlRef.current = url;
              setAudioUrl(url);
              setFromCache(true);
              installHighlights(cached.boundaries, durationMs);
              return;
            } catch (err) {
              // Cached bytes are corrupt or unplayable. Drop the cache
              // and fall through to a fresh synth so the user gets
              // working audio without needing to manually clear state.
              // eslint-disable-next-line no-console
              console.warn("reader: cached audio decode failed, re-synthesising", err);
              try {
                await saveReaderAudio({ id: doc.id, bytes: null });
              } catch {
                /* ignore — best effort */
              }
            }
          }
          // Stale flag (cache cleared by an edit but state not yet
          // refreshed) — fall through to synth.
        }

        const cleaned = cleanForSpeech(doc.body);
        if (!cleaned) {
          setError("Nothing to read.");
          return;
        }
        setBusy(true);
        const result = await synthesizeBytes(cleaned, ttsConfig, {
          lang: bcp47ForLang(lang),
          fallbackOpenaiKey,
          fallbackMinimaxKey,
        });
        if (cancelled) return;
        // Persist the bytes (and word boundaries when the backend
        // emitted them) so re-opening the player on this doc skips the
        // provider call AND keeps the karaoke highlight working. A
        // failed save must not block playback, but it's surfaced as a
        // warning — silently dropping it meant "cached" quietly became
        // "regenerates every open" with no way to notice.
        try {
          await saveReaderAudio({
            id: doc.id,
            bytes: result.bytes,
            mime: result.mime,
            boundaries: result.boundaries ?? null,
          });
          onCached(result.mime);
          if (!cancelled) setSavedNow(true);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("reader: caching audio failed", err);
          if (!cancelled) {
            setCacheWarn(
              "Couldn't save this audio for reuse — it will be generated again next time.",
            );
          }
        }
        const { url, durationMs } = await buildUrl(result.bytes);
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setAudioUrl(url);
        installHighlights(result.boundaries ?? null, durationMs);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Audio failed: ${msg.slice(0, 240)}`);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, regenNonce]);

  // Revoke the Blob URL on unmount so we don't leak across open/close cycles.
  useEffect(() => {
    return () => {
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, []);

  // Construct the audio element imperatively via `new Audio(url)`
  // instead of rendering an <audio> JSX tag. Reason: WebKit2GTK on
  // Linux uses different GStreamer pipeline paths for JSX-mounted
  // media elements vs the detached `Audio()` constructor — the
  // mounted path rejects MP3 streams with MEDIA_ERR_SRC_NOT_SUPPORTED
  // (code 4) on some installs, while the constructor path plays the
  // exact same bytes fine. The chat's `tts.speak()` uses `new Audio()`
  // and works; this matches that.
  useEffect(() => {
    if (!audioUrl) return;
    const a = new Audio(audioUrl);
    a.preload = "auto";
    a.playbackRate = rate;
    audioRef.current = a;

    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);
    const onTimeUpdate = () => setCurrentTime(a.currentTime);
    const onLoadedMetadata = () => {
      setDuration(Number.isFinite(a.duration) ? a.duration : 0);
      a.playbackRate = rate;
    };
    const onErr = () => {
      const code = a.error?.code;
      const codeMap: Record<number, string> = {
        1: "playback aborted",
        2: "network error fetching audio",
        3: "audio decode error — bytes are corrupt",
        4: "media format not supported",
      };
      const detail = code != null ? codeMap[code] ?? `code ${code}` : "unknown error";
      setError(`Audio playback failed: ${detail}`);
    };

    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onEnded);
    a.addEventListener("timeupdate", onTimeUpdate);
    a.addEventListener("loadedmetadata", onLoadedMetadata);
    a.addEventListener("error", onErr);

    void a.play().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      // Autoplay-policy / interrupt rejections aren't real failures —
      // user can still hit the play button. Anything else surfaces.
      if (!/abort|interrupt|notallowed/i.test(msg)) {
        setError(`Playback failed: ${msg.slice(0, 200)}`);
      }
    });

    return () => {
      a.pause();
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("ended", onEnded);
      a.removeEventListener("timeupdate", onTimeUpdate);
      a.removeEventListener("loadedmetadata", onLoadedMetadata);
      a.removeEventListener("error", onErr);
      a.src = "";
      if (audioRef.current === a) audioRef.current = null;
    };
    // `rate` intentionally omitted — the dedicated rate-sync effect
    // below handles changes without rebuilding the Audio element.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl]);

  // Keep playbackRate in sync with the speed-pill state.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  // Find the highlight whose time range covers `currentTime` and emit
  // its char range up to the reader. Pauses + scrubs flow through the
  // same path because they update `currentTime`. We binary-search for
  // O(log n) lookup — long passages with edge boundaries can have
  // hundreds of entries.
  useEffect(() => {
    if (highlights.length === 0 || !playing) {
      // Clear highlight when paused or before playback starts. The
      // `playing` gate stops a stale word from sticking after pause.
      if (lastRangeRef.current != null) {
        lastRangeRef.current = null;
        onActiveRangeChange?.(null);
      }
      return;
    }
    const ms = currentTime * 1000;
    let lo = 0;
    let hi = highlights.length - 1;
    let found: ReaderHighlight | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const h = highlights[mid];
      if (ms < h.startMs) hi = mid - 1;
      else if (ms >= h.endMs) lo = mid + 1;
      else {
        found = h;
        break;
      }
    }
    const next = found ? ([found.charStart, found.charEnd] as [number, number]) : null;
    const prev = lastRangeRef.current;
    const same =
      next != null && prev != null && next[0] === prev[0] && next[1] === prev[1];
    if (same) return;
    if (next == null && prev == null) return;
    lastRangeRef.current = next;
    onActiveRangeChange?.(next);
  }, [currentTime, highlights, playing, onActiveRangeChange]);

  // Final cleanup on unmount — drop any lingering highlight so the
  // reader's prose returns to its default state when the player is
  // closed.
  useEffect(() => {
    return () => {
      if (lastRangeRef.current != null) {
        onActiveRangeChange?.(null);
        lastRangeRef.current = null;
      }
    };
    // onActiveRangeChange is stable across renders in the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function togglePlay() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      void a.play().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/abort|interrupt|notallowed/i.test(msg)) {
          setError(`Playback failed: ${msg.slice(0, 200)}`);
        }
      });
    } else {
      a.pause();
    }
  }

  function seekBy(delta: number) {
    const a = audioRef.current;
    if (!a || !Number.isFinite(a.duration)) return;
    a.currentTime = Math.max(0, Math.min(a.duration, a.currentTime + delta));
  }

  function onScrub(pct: number) {
    const a = audioRef.current;
    if (!a || !Number.isFinite(a.duration) || a.duration === 0) return;
    a.currentTime = (pct / 100) * a.duration;
  }

  function cycleRate() {
    setRate((prev) => {
      const idx = PLAYBACK_RATES.indexOf(prev as (typeof PLAYBACK_RATES)[number]);
      const nextIdx = idx === -1 ? 1 : (idx + 1) % PLAYBACK_RATES.length;
      return PLAYBACK_RATES[nextIdx];
    });
  }

  /** Drop the cached bytes and synthesise fresh — for a changed voice
   *  or provider, or simply audio the user isn't happy with. Doubles
   *  as the retry path after an error. */
  function regenerate() {
    if (busy) return;
    forceFreshRef.current = true;
    setRegenNonce((n) => n + 1);
  }

  const progressPct =
    duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const ready = audioUrl != null && !busy && !error;

  return (
    <div className="border-t border-border/60 bg-card/95 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.15)] backdrop-blur supports-[backdrop-filter]:bg-card/75">
      {/* Slim top progress bar — visible across the full width above
          the controls so it reads as a "now playing" affordance even
          when the user's eyes are on the passage. */}
      <div className="relative h-0.5 w-full bg-border/50">
        <div
          className="absolute inset-y-0 left-0 bg-foreground/70 transition-[width]"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      <div className="mx-auto flex max-w-3xl items-center gap-4 px-6 py-3 xl:max-w-4xl 2xl:max-w-5xl">
        {/* Doc info — fixed-width on the left so the controls block stays centered. */}
        <div className="flex w-[180px] min-w-0 shrink-0 items-center gap-2.5">
          <div className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-foreground/10 to-foreground/5 text-foreground/80">
            <Headphones className="size-4" />
            {playing && (
              <span className="absolute inset-0 animate-pulse bg-foreground/5" />
            )}
          </div>
          <div className="min-w-0">
            <div className="truncate text-[12.5px] font-medium leading-tight">
              {doc.title || "Audio"}
            </div>
            <div className="truncate text-[10.5px] uppercase tracking-wider text-muted-foreground">
              {busy
                ? "Generating…"
                : error
                  ? "Error"
                  : fromCache
                    ? `Cached · ${ttsConfigLabel(ttsConfig)}`
                    : savedNow
                      ? `Saved · ${ttsConfigLabel(ttsConfig)}`
                      : ttsConfigLabel(ttsConfig)}
            </div>
          </div>
        </div>

        {/* Transport controls + scrubber */}
        <div className="flex flex-1 items-center gap-3">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => seekBy(-10)}
              disabled={!ready}
              className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
              title="Back 10 s"
              aria-label="Back 10 seconds"
            >
              <RotateCcw className="size-4" />
            </button>

            <button
              type="button"
              onClick={togglePlay}
              disabled={!ready}
              className="group flex size-10 items-center justify-center rounded-full bg-foreground text-background shadow-md transition-transform hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:hover:scale-100"
              title={playing ? "Pause" : "Play"}
              aria-label={playing ? "Pause" : "Play"}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : playing ? (
                <Pause className="size-4" />
              ) : (
                <Play className="size-4 translate-x-[1px]" />
              )}
            </button>

            <button
              type="button"
              onClick={() => seekBy(10)}
              disabled={!ready}
              className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
              title="Forward 10 s"
              aria-label="Forward 10 seconds"
            >
              <RotateCw className="size-4" />
            </button>
          </div>

          {/* Scrubber + time. Native <input type=range> styled to match
              the modern look — accent colour follows the theme so dark
              and light modes both feel native. */}
          <div className="flex flex-1 items-center gap-3">
            <span className="w-10 shrink-0 text-right tabular-nums text-[11px] text-muted-foreground">
              {formatTime(currentTime)}
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={0.1}
              value={progressPct}
              onChange={(e) => onScrub(Number(e.target.value))}
              disabled={!ready}
              className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-border accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Seek"
            />
            <span className="w-10 shrink-0 tabular-nums text-[11px] text-muted-foreground">
              {duration > 0 ? formatTime(duration) : "--:--"}
            </span>
          </div>

          {/* Speed pill — cycles through the preset rates on click. */}
          <button
            type="button"
            onClick={cycleRate}
            disabled={!ready}
            className="flex items-center gap-1 rounded-full border border-border/70 bg-background/40 px-2.5 py-1 text-[11.5px] font-medium tabular-nums text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground disabled:opacity-40"
            title={`Playback speed (currently ${rate}×)`}
          >
            <Gauge className="size-3" />
            {rate}×
          </button>

          {/* Regenerate — drops the cached bytes and synthesises fresh
              with the *current* TTS config. Also the retry path when
              synthesis errored (previously that needed close + reopen). */}
          <button
            type="button"
            onClick={regenerate}
            disabled={busy}
            className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
            title={`Regenerate audio with ${ttsConfigLabel(ttsConfig)} (replaces the saved version)`}
            aria-label="Regenerate audio"
          >
            <RefreshCw className={cn("size-4", busy && "animate-spin")} />
          </button>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Close player"
          aria-label="Close player"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Inline error / warning / loading message under the bar — keeps
          the control row stable in height regardless of state. */}
      {(error || cacheWarn || (busy && !audioUrl)) && (
        <div className="border-t border-border/40 bg-background/30 px-6 py-1.5 text-center">
          {error ? (
            <span className="text-[11.5px] text-destructive">{error}</span>
          ) : busy && !audioUrl ? (
            <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Synthesising audio with {ttsConfigLabel(ttsConfig)}…
            </span>
          ) : (
            <span className="text-[11.5px] text-amber-700 dark:text-amber-400">
              {cacheWarn}
            </span>
          )}
        </div>
      )}

      {/* Hidden <audio> — drives the actual playback. Custom controls
          above just call into this element's API. */}
      {/* No <audio> JSX — the element is created imperatively via
          `new Audio()` in the effect above. See comment there for why. */}
    </div>
  );
}

function formatTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function ttsConfigLabel(c: import("@/lib/tts").TTSConfig): string {
  switch (c.kind) {
    case "minimax":
      return "MiniMax";
    case "openai":
      return "OpenAI";
    case "elevenlabs":
      return "ElevenLabs";
    case "edge":
      return "Edge TTS";
    default:
      return c.kind;
  }
}
