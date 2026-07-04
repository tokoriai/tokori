/**
 * CardComposerDialog — the unified "Add card" + "Edit card" dialog.
 *
 * Replaces the older `CardCreateDialog` + `CardEditorDialog`. The two
 * surfaces shared 80% of their state and 100% of their preview, but
 * lived as separate files because the create flow had the dict-lookup
 * + translate-fallback baked in. That logic is now an enricher
 * (`dict-autoload`), so create and edit are the same screen with
 * different seed data and different save paths.
 *
 * Layout (80vw, max 1400px, 3 columns):
 *   ┌────────────┬────────────┬────────────┐
 *   │ Form       │ Enrichment │ Live       │
 *   │ fields     │ actions    │ preview    │
 *   └────────────┴────────────┴────────────┘
 *
 * Enrichers come from `CARD_ENRICHERS`. The composer:
 *   - Runs every `trigger: "auto"` enricher when the word changes
 *     (debounced 500 ms). Same debounce the old create dialog used.
 *   - Renders a button per `trigger: "manual"` enricher.
 *   - Offers an "Apply remaining" sweep that runs every enricher whose
 *     target field is still blank, in `priority` order.
 *
 * Save path:
 *   - mode === "create" → `saveVocab` then `updateVocabFields` for the
 *     fields saveVocab doesn't write (image, audio, frontExtra, notes).
 *   - mode === "edit"   → `updateVocabFields` directly.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import {
  ArrowLeftRight,
  Check,
  ImagePlus,
  Loader2,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import { Textarea } from "@/components/ui/textarea";
import {
  getVocabAudio,
  getVocabImage,
  listTranslateConfigs,
  listVocab,
  lookupDict,
  saveVocab,
  searchDict,
  updateVocabFields,
  type DictEntry,
  type ProviderConfig,
  type TranslateConfig,
  type VocabEntry,
  type VocabKind,
} from "@/lib/db";
import { prettyPinyin } from "@/lib/pinyin";
import { useProviderConfigs } from "@/lib/provider-context";
import { useWorkspace } from "@/lib/workspace-context";
import { useTTS } from "@/lib/tts-context";
import {
  MAX_IMAGE_KB,
  imageFromClipboardEvent,
  isOversize,
  readFileAsImage,
} from "@/lib/paste-image";
import { engineByKind, FALLBACK_ENGINE } from "@/lib/translate/registry";
import { CardAudioField } from "@/components/card-audio-field";
import type { LanguageCode } from "@/lib/language-profiles";
import {
  applyPatch,
  enrichersForLanguage,
  type CardDraft,
  type CardEnricher,
  type CardPatch,
  type EnricherContext,
} from "@/lib/card-enrich/api";
import { CARD_ENRICHERS } from "@/lib/card-enrich/registry";
import {
  CARD_STYLES,
  getCardStyle,
  type CardStyleId,
} from "@/lib/card-styles";
import { cn } from "@/lib/utils";

type ChatEvent =
  | { type: "token"; delta: string }
  | { type: "done"; content: string }
  | { type: "error"; message: string };

type Props = {
  open: boolean;
  onClose: () => void;
} & (
  | {
      mode: "create";
      initialWord?: string;
      /** Pre-fill the reading field. Use when the caller already
       *  has a dict result (e.g. the click-to-define popover).
       *  The composer's dict-autoload enricher still runs, but it
       *  respects user-input — so it won't overwrite this value. */
      initialReading?: string | null;
      /** Pre-fill the gloss field. Same "user input wins" rule. */
      initialGloss?: string | null;
      /** Pre-fill the cloze sentence. Use when the caller knows the
       *  surrounding context (the click-to-define popover wraps the
       *  clicked word's sentence as `{{c1::word}}` and ships it
       *  here so the user lands in the composer with the cloze
       *  already in place). */
      initialFrontExtra?: string | null;
      /** Pre-fill the translation field. Optional. */
      initialTranslation?: string | null;
      /** Optional collection to drop the new card into on save. */
      collectionId?: number | null;
      onSaved: (created: VocabEntry) => void;
    }
  | {
      mode: "edit";
      card: VocabEntry;
      onSaved: (updated: VocabEntry) => void;
    }
);

export function CardComposerDialog(props: Props) {
  const { active: workspace } = useWorkspace();
  const { providers, sendChat } = useProviderConfigs();
  const tts = useTTS();
  const [translateConfigs, setTranslateConfigs] = useState<TranslateConfig[]>([]);

  // ── Card style ────────────────────────────────────────────────────
  // The style controls form labels, which auto-enrichers fire on
  // word change, and how the Save button dispatches (one row vs.
  // multiple). Edit mode is always "standard" — editing a
  // sentence-kind row, you're still editing one row.
  const [styleId, setStyleId] = useState<CardStyleId>(
    props.mode === "edit"
      ? props.card.kind === "sentence"
        ? "sentence"
        : props.card.frontExtra
          ? "cloze"
          : "standard"
      : "standard",
  );
  const style = useMemo(() => getCardStyle(styleId), [styleId]);

  // ── Draft state ───────────────────────────────────────────────────
  const [word, setWord] = useState("");
  const [reading, setReading] = useState("");
  const [gloss, setGloss] = useState("");
  const [frontExtra, setFrontExtra] = useState("");
  const [cardNotes, setCardNotes] = useState("");
  // Natural / native translation, kept separate from `gloss`
  // (Definition). The Browse "open flashcard" and Anki-classic views
  // can place it on the front or back per the card's layout.
  const [translation, setTranslation] = useState("");
  const [imageData, setImageData] = useState<string | null>(null);
  const [audioBytes, setAudioBytes] = useState<Uint8Array | null>(null);
  const [audioMime, setAudioMime] = useState<string | null>(null);
  const [audioDirty, setAudioDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Which enrichers have completed at least once on the current word.
  // Drives the "✓ Ran" chip next to the enricher button.
  const [ranOnce, setRanOnce] = useState<Set<string>>(new Set());
  // Which enrichers are currently running. Drives the per-row spinner.
  const [running, setRunning] = useState<Set<string>>(new Set());

  // ── Dict typeahead (create mode only) ─────────────────────────────
  // As the user types in the word input we run a debounced searchDict
  // to surface "did you mean…" matches. Picking a suggestion fills
  // word + reading + gloss in one shot and dismisses the popover.
  // Edit mode hides this — the word is fixed there.
  const [suggestions, setSuggestions] = useState<DictEntry[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suggestionDebounceRef = useRef<number | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);
  const lastAutoWordRef = useRef<string>("");

  // ── Seed on open ──────────────────────────────────────────────────
  useEffect(() => {
    if (!props.open) return;
    // Guards the async image/audio loads in the edit branch so switching
    // cards (or closing) before they resolve can't write stale bytes.
    let cancelled = false;
    if (props.mode === "create") {
      const seedWord = props.initialWord ?? "";
      setWord(seedWord);
      setReading(props.initialReading ?? "");
      setGloss(props.initialGloss ?? "");
      setFrontExtra(props.initialFrontExtra ?? "");
      setCardNotes("");
      setTranslation(props.initialTranslation ?? "");
      setImageData(null);
      setAudioBytes(null);
      setAudioMime(null);
      setAudioDirty(false);
      // If the caller pre-filled reading/gloss (e.g. the click-to-
      // define popover seeding from dict), mark dict-autoload as
      // already-ran so the enrichment column shows ✓ and the auto
      // effect doesn't try to re-populate the same fields. Also
      // anchor lastAutoWordRef so the auto-enrichers stay quiet
      // unless the user actually changes the word.
      if (props.initialReading || props.initialGloss) {
        setRanOnce(new Set(["dict-autoload"]));
        lastAutoWordRef.current = seedWord;
      } else {
        setRanOnce(new Set());
        lastAutoWordRef.current = "";
      }
    } else {
      const c = props.card;
      setWord(c.word);
      setReading(c.reading ?? "");
      setGloss(c.gloss ?? "");
      setFrontExtra(c.frontExtra ?? "");
      setCardNotes(c.cardNotes ?? "");
      setTranslation(c.translation ?? "");
      setAudioDirty(false);
      setAudioBytes(null);
      setAudioMime(c.audioMime);
      // Edit mode: pull image + audio bytes on demand — list queries
      // strip them so we don't ship MB per row across IPC.
      if (c.imageData) {
        setImageData(c.imageData);
      } else if (c.hasImage) {
        void getVocabImage(c.id)
          .then((bytes) => !cancelled && setImageData(bytes))
          .catch(() => !cancelled && setImageData(null));
      } else {
        setImageData(null);
      }
      if (c.hasAudio) {
        void getVocabAudio(c.id)
          .then((res) => {
            if (cancelled || !res) return;
            setAudioBytes(res.bytes);
            setAudioMime(res.mime);
          })
          .catch(() => {});
      }
      // Treat the seeded word as already "auto-enriched" so we don't
      // overwrite the user's existing card on open. They can hit
      // "Apply remaining" if they want to top up.
      lastAutoWordRef.current = c.word;
      setRanOnce(new Set(CARD_ENRICHERS.filter((e) => e.meta.trigger === "auto").map((e) => e.meta.id)));
    }
    void listTranslateConfigs().then(setTranslateConfigs);
    return () => {
      cancelled = true;
    };
    // The seed effect only needs to run on open/card-change; deps
    // intentionally narrow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.mode, props.mode === "edit" ? props.card.id : props.mode === "create" ? props.initialWord : null]);

  // ── Enricher context ──────────────────────────────────────────────
  const ctx: EnricherContext = useMemo(() => {
    const pickEngine = (): { config: TranslateConfig; engine: ReturnType<typeof engineByKind> } => {
      const cfg =
        translateConfigs.find((c) => c.isDefault) ??
        translateConfigs[0] ??
        null;
      if (!cfg) {
        return {
          config: {
            id: 0,
            kind: "google-free",
            label: "Google (free)",
            apiKey: null,
            secondaryKey: null,
            baseUrl: null,
            providerId: null,
            model: null,
            isDefault: true,
            createdAt: 0,
          },
          engine: FALLBACK_ENGINE,
        };
      }
      return { config: cfg, engine: engineByKind(cfg.kind) ?? FALLBACK_ENGINE };
    };

    return {
      sendChat: sendChat ?? null,
      synthesize: tts.config.kind === "browser"
        ? null // browser TTS bytes can't be captured
        : (text: string, lang: LanguageCode) => tts.synthesize(text, lang),
      lookupDict: (lang, w) => lookupDict(lang, w),
      knownVocab: async () => {
        if (!workspace) return [];
        return listVocab(workspace.id, 500);
      },
      translateFallback: async (source, target, text) => {
        const picked = pickEngine();
        if (!picked.engine) return null;
        const out = await picked.engine.translate({
          source,
          target,
          texts: [text],
          config: picked.config,
          callAi: async ({ provider, model, messages }) => {
            if (!isTauri()) {
              let acc = "";
              await sendChat({ messages, onToken: (d) => (acc += d) });
              return acc;
            }
            const override = { ...provider, model };
            return new Promise<string>((resolve, reject) => {
              const channel = new Channel<ChatEvent>();
              let full = "";
              channel.onmessage = (event: ChatEvent) => {
                if (event.type === "token") full += event.delta;
              };
              invoke<string>("chat_send", {
                config: toRustConfig(override),
                messages,
                onEvent: channel,
              })
                .then((reply) => resolve(reply || full))
                .catch(reject);
            });
          },
          getProvider: (id) => providers.find((p) => p.id === id) ?? null,
        });
        const t = (out[0] ?? "").trim();
        return t || null;
      },
    };
    // tts.config.kind changes when user switches voice provider; sendChat
    // identity is stable.
  }, [translateConfigs, sendChat, tts, workspace, providers]);

  // ── Build the current draft from React state ──────────────────────
  const draft: CardDraft | null = useMemo(() => {
    if (!workspace) return null;
    return {
      workspaceId: workspace.id,
      targetLang: workspace.targetLang as LanguageCode,
      nativeLang: workspace.nativeLang as LanguageCode,
      word: word.trim(),
      kind: props.mode === "edit" ? props.card.kind : "vocab",
      reading: reading.trim() || null,
      gloss: gloss.trim() || null,
      frontExtra: frontExtra.trim() || null,
      cardNotes: cardNotes.trim() || null,
      translation: translation.trim() || null,
      imageData,
      audioBytes,
      audioMime,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id, word, reading, gloss, frontExtra, cardNotes, imageData, audioBytes, audioMime, props.mode, props.mode === "edit" ? props.card.kind : null]);

  // Apply a patch back to local state. The contract says undefined =
  // no change, null = explicit clear — mirror that here.
  function applyPatchToState(patch: CardPatch) {
    if (patch.reading !== undefined) setReading(patch.reading ?? "");
    if (patch.gloss !== undefined) setGloss(patch.gloss ?? "");
    if (patch.frontExtra !== undefined) setFrontExtra(patch.frontExtra ?? "");
    if (patch.cardNotes !== undefined) setCardNotes(patch.cardNotes ?? "");
    if (patch.translation !== undefined) setTranslation(patch.translation ?? "");
    if (patch.imageData !== undefined) setImageData(patch.imageData);
    if (patch.audioBytes !== undefined) {
      setAudioBytes(patch.audioBytes);
      setAudioMime(patch.audioMime ?? "audio/mpeg");
      setAudioDirty(true);
    }
  }

  /** Swap front and back — exchange the values of `word` and
   *  `gloss`. The card is saved with whatever's in those fields at
   *  save time, so this gives us "reverse direction" (meaning →
   *  target) without a schema change. Reset the dict-autoload
   *  ran-once marker too: the new "word" is now a meaning string,
   *  so re-running autos would just try (and fail) to look up
   *  English in CC-CEDICT. The user can still type a fresh word
   *  and the autos will fire normally. */
  function swapFrontBack() {
    setWord(gloss);
    setGloss(word);
    lastAutoWordRef.current = gloss;
    setRanOnce(new Set(["dict-autoload"]));
  }

  async function runEnricher(enricher: CardEnricher) {
    if (!draft) return;
    if (!draft.word) return;
    setRunning((prev) => new Set(prev).add(enricher.meta.id));
    try {
      const patch = await enricher.run(draft, ctx);
      applyPatchToState(patch);
      setRanOnce((prev) => new Set(prev).add(enricher.meta.id));
      const wrote = Object.keys(patch).length;
      if (wrote === 0) {
        toast.info(`${enricher.meta.name}: nothing to fill`);
      } else {
        toast.success(`${enricher.meta.name} ran`);
      }
    } catch (err) {
      toast.error(`${enricher.meta.name} failed`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunning((prev) => {
        const next = new Set(prev);
        next.delete(enricher.meta.id);
        return next;
      });
    }
  }

  // ── Auto enrichers — debounced run on word change ────────────────
  useEffect(() => {
    if (debounceRef.current != null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const trimmed = word.trim();
    if (!trimmed || trimmed === lastAutoWordRef.current) return;
    debounceRef.current = window.setTimeout(() => {
      lastAutoWordRef.current = trimmed;
      // Snapshot the auto enrichers for this language and fire them
      // one after the other. They're all "fill blanks only" so order
      // doesn't matter much, but we go in priority order for
      // determinism in tests.
      //
      // Style-aware gating: if the active style declares an
      // `autoEnricherIds` whitelist, only enrichers in that list
      // fire. Sentence style ships `[]` (no autos — dict-lookup
      // would try to look up the whole sentence). Cloze + bundle
      // ship `["dict-autoload", "ai-cloze"]` so a fresh word lands
      // with a generated cloze without the user clicking "Run".
      // Standard leaves the whitelist undefined → all autos run.
      if (!workspace) return;
      const allAutos = enrichersForLanguage(CARD_ENRICHERS, workspace.targetLang as LanguageCode)
        .filter((e) => e.meta.trigger === "auto" || (style.autoEnricherIds?.includes(e.meta.id) ?? false))
        .sort((a, b) => (b.meta.priority ?? 0) - (a.meta.priority ?? 0));
      const filtered = style.autoEnricherIds
        ? allAutos.filter((e) => style.autoEnricherIds!.includes(e.meta.id))
        : allAutos.filter((e) => e.meta.trigger === "auto");
      void Promise.all(filtered.map(runEnricher));
    }, 500);
    return () => {
      if (debounceRef.current != null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [word, workspace?.id, styleId]);

  // ── Dict typeahead — debounced suggestions while typing ──────────
  // Only fires in create mode (the word input only exists there).
  // 200 ms is snappy enough to feel live without spamming SQLite on
  // every keystroke. We deliberately don't share the autoEnricher
  // debounce — the typeahead and the auto-fill have different
  // cadences (suggestions: every keystroke pause; auto-fill: only
  // once the user has clearly settled on a word).
  useEffect(() => {
    if (props.mode !== "create") return;
    if (suggestionDebounceRef.current != null) {
      window.clearTimeout(suggestionDebounceRef.current);
      suggestionDebounceRef.current = null;
    }
    const q = word.trim();
    if (!q || !workspace) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    suggestionDebounceRef.current = window.setTimeout(() => {
      searchDict(workspace.targetLang, q, 8)
        .then((rows) => {
          if (cancelled) return;
          // Filter out an exact match on the typed word — there's
          // nothing useful to suggest if the user already typed the
          // exact dict headword. They can just keep typing.
          const filtered = rows.filter((r) => r.word !== q);
          setSuggestions(filtered);
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
    }, 200);
    return () => {
      // Cancel an in-flight lookup so a slow response for an old query
      // can't overwrite suggestions for what the user has since typed.
      cancelled = true;
      if (suggestionDebounceRef.current != null) {
        window.clearTimeout(suggestionDebounceRef.current);
        suggestionDebounceRef.current = null;
      }
    };
  }, [word, workspace?.id, workspace?.targetLang, props.mode]);

  // Picking a suggestion overwrites the form fields — the user
  // explicitly chose this entry, so it's the new source of truth.
  // We also reset the autoLastWord ref so the dict-autoload
  // enricher doesn't re-fire on the freshly-set word and try to
  // re-fill the same fields with a possibly-different sense.
  function pickSuggestion(entry: DictEntry) {
    setWord(entry.word);
    if (entry.reading) {
      setReading(
        workspace?.targetLang === "zh"
          ? prettyPinyin(entry.reading)
          : entry.reading,
      );
    }
    if (entry.gloss) setGloss(entry.gloss);
    setShowSuggestions(false);
    setSuggestions([]);
    lastAutoWordRef.current = entry.word;
    // Mark dict-autoload as "ran" so the auto-fill chip in the
    // enrichment column reflects that we already have a dict result.
    setRanOnce((prev) => new Set(prev).add("dict-autoload"));
  }

  // "Apply remaining" sweep — run every enricher whose target is blank.
  async function applyRemaining() {
    if (!draft || !workspace) return;
    const candidates = enrichersForLanguage(CARD_ENRICHERS, workspace.targetLang as LanguageCode)
      .sort((a, b) => (b.meta.priority ?? 0) - (a.meta.priority ?? 0));
    // Re-evaluate "blank" after each run so a freshly-filled field
    // doesn't get clobbered by the next enricher's overlap.
    let current: CardDraft = draft;
    for (const e of candidates) {
      const allBlank = e.meta.targets.every((t) => isBlank(current, t));
      if (!allBlank) continue;
      try {
        setRunning((prev) => new Set(prev).add(e.meta.id));
        const patch = await e.run(current, ctx);
        applyPatchToState(patch);
        current = applyPatch(current, patch);
        setRanOnce((prev) => new Set(prev).add(e.meta.id));
      } catch (err) {
        toast.error(`${e.meta.name} failed`, {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setRunning((prev) => {
          const next = new Set(prev);
          next.delete(e.meta.id);
          return next;
        });
      }
    }
  }

  // ── Image handlers ────────────────────────────────────────────────
  async function pickImage(file: File) {
    const img = await readFileAsImage(file);
    if (!img) return;
    if (isOversize(img)) {
      toast.error("Image too large", {
        description: `Keep under ${MAX_IMAGE_KB} KB.`,
      });
      return;
    }
    setImageData(img.dataUrl);
  }

  async function onPaste(e: React.ClipboardEvent) {
    const img = await imageFromClipboardEvent(e.nativeEvent);
    if (!img) return;
    e.preventDefault();
    if (isOversize(img)) {
      toast.error("Pasted image too large", {
        description: `Keep under ${MAX_IMAGE_KB} KB.`,
      });
      return;
    }
    setImageData(img.dataUrl);
    toast.success("Image attached");
  }

  // ── Save ──────────────────────────────────────────────────────────
  async function save() {
    if (!workspace) return;
    const trimmed = word.trim();
    if (!trimmed) {
      toast.error(
        style.id === "sentence" ? "Sentence can't be empty" : "Word can't be empty",
      );
      return;
    }
    // Cloze style needs a sentence to be meaningful; bundle wants
    // one for the second row. Block save with a clear message
    // rather than silently producing an inert card.
    if (style.id === "cloze" && !frontExtra.trim()) {
      toast.error("Cloze card needs a sentence", {
        description:
          "Add a sentence with the target word wrapped as {{c1::word}}, or run the AI cloze enricher.",
      });
      return;
    }
    setSaving(true);
    try {
      if (props.mode === "create") {
        // Build the draft once, hand it to the style's producer,
        // then save each emitted row. saveVocab is idempotent on
        // (workspaceId, word) so re-running with the same word is
        // a no-op — bundle's two rows have different `word`
        // values (the second row is the full sentence) so they
        // can't collide.
        const draft: CardDraft = {
          workspaceId: workspace.id,
          targetLang: workspace.targetLang as LanguageCode,
          nativeLang: workspace.nativeLang as LanguageCode,
          word: trimmed,
          kind: "vocab",
          reading: reading.trim() || null,
          gloss: gloss.trim() || null,
          frontExtra: frontExtra.trim() || null,
          cardNotes: cardNotes.trim() || null,
          translation: translation.trim() || null,
          imageData,
          audioBytes,
          audioMime,
        };
        const rows = style.produce(draft);
        let firstCreated: VocabEntry | null = null;
        for (const row of rows) {
          const created = await saveVocab({
            workspaceId: workspace.id,
            word: row.word,
            reading: row.reading,
            gloss: row.gloss,
            kind: row.kind,
          });
          if (firstCreated == null) firstCreated = created;
          // Apply the row's media + notes via the second-step
          // `updateVocabFields` path, same as the legacy
          // single-row save did. The audio bytes apply to the
          // current word only — bundle's second row (sentence)
          // doesn't get its own audio cached here; the study
          // surface can TTS it on the fly.
          const isFirstWord = row.word === trimmed;
          const audioForRow = isFirstWord ? row.audioBytes : null;
          if (
            row.imageData ||
            row.cardNotes ||
            row.frontExtra ||
            row.translation ||
            audioForRow
          ) {
            await updateVocabFields({
              id: created.id,
              imageData: row.imageData ?? undefined,
              cardNotes: row.cardNotes ?? undefined,
              frontExtra: row.frontExtra ?? undefined,
              translation: row.translation ?? undefined,
              ...(audioForRow
                ? { audioData: audioForRow, audioMime: row.audioMime ?? "audio/mpeg" }
                : {}),
            });
          }
        }
        if (firstCreated) {
          props.onSaved({
            ...firstCreated,
            cardNotes: cardNotes.trim() || null,
            frontExtra: frontExtra.trim() || null,
            translation: translation.trim() || null,
            imageData,
            hasImage: imageData != null && imageData !== "",
            hasAudio: audioBytes != null && audioBytes.byteLength > 0,
            audioMime,
          });
        }
        toast.success(
          rows.length > 1
            ? `${rows.length} cards added`
            : style.id === "sentence"
              ? "Sentence card added"
              : "Card added",
        );
      } else {
        const c = props.card;
        await updateVocabFields({
          id: c.id,
          reading: reading.trim() || null,
          gloss: gloss.trim() || null,
          frontExtra: frontExtra.trim() || null,
          cardNotes: cardNotes.trim() || null,
          translation: translation.trim() || null,
          imageData,
          ...(audioDirty
            ? { audioData: audioBytes, audioMime }
            : {}),
        });
        props.onSaved({
          ...c,
          reading: reading.trim() || null,
          gloss: gloss.trim() || null,
          frontExtra: frontExtra.trim() || null,
          cardNotes: cardNotes.trim() || null,
          translation: translation.trim() || null,
          imageData,
          hasImage: imageData != null && imageData !== "",
          hasAudio: audioBytes != null && audioBytes.byteLength > 0,
          audioMime,
        });
        toast.success("Card saved");
      }
      props.onClose();
    } catch (err) {
      toast.error("Couldn't save", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  if (!workspace) return null;

  const enrichers = enrichersForLanguage(
    CARD_ENRICHERS,
    workspace.targetLang as LanguageCode,
  );

  const clozePreview = (() => {
    if (!frontExtra) return null;
    const masked = frontExtra.replace(/\{\{c\d+::([^}]+)\}\}/g, "____");
    const revealed = frontExtra.replace(/\{\{c\d+::([^}]+)\}\}/g, "$1");
    return { masked, revealed };
  })();

  const headerLabel = props.mode === "create" ? "Add card" : "Edit card";
  const saveLabel = props.mode === "create" ? "Add card" : "Save";

  return (
    <Dialog open={props.open} onOpenChange={(v) => !v && !saving && props.onClose()}>
      <DialogContent
        // 80 % of the viewport width on most screens, capped at
        // 1400 px so it doesn't get unreadably wide on ultrawides.
        // `sm:max-w-[1400px]` is required to override the base
        // `sm:max-w-lg` shadcn ships on DialogContent — without it,
        // the responsive cap stays at 32 rem and the dialog looks
        // tiny on any screen ≥ 640 px.
        className="w-[80vw] max-w-[1400px] sm:max-w-[1400px] overflow-hidden p-0"
        onPaste={onPaste}
      >
        <DialogHeader className="border-b border-border px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle className="font-serif text-lg tracking-tight">
              {headerLabel}
            </DialogTitle>
            {/* Style picker — only meaningful in create mode. In
                edit mode the kind is already set on the row and
                changing it would require deleting + re-saving, so
                we just label the current kind for context. */}
            {props.mode === "create" ? (
              <div className="flex overflow-hidden rounded-md border border-border bg-muted/40 p-0.5">
                {CARD_STYLES.map((s) => {
                  const Icon = s.icon;
                  const active = s.id === styleId;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setStyleId(s.id)}
                      title={s.description}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                        active
                          ? "bg-card text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Icon className="size-3" />
                      {s.name}
                    </button>
                  );
                })}
              </div>
            ) : (
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {props.card.kind === "sentence"
                  ? "Sentence card"
                  : props.card.frontExtra
                    ? "Cloze card"
                    : "Standard card"}
              </span>
            )}
          </div>
          {/* Per-style description so the user knows what each tab
              actually creates. Dimmer + smaller — it's reassurance,
              not a primary affordance. */}
          {props.mode === "create" && (
            <p className="mt-1 text-[11.5px] text-muted-foreground">
              {style.description}
            </p>
          )}
        </DialogHeader>

        <div className="grid max-h-[80vh] grid-cols-[minmax(0,1.2fr)_minmax(0,0.7fr)_minmax(0,1fr)] gap-0 overflow-y-auto">
          {/* ── Column 1 — form ─────────────────────────────────── */}
          <div className="space-y-4 border-r border-border px-5 py-5">
            <div className="space-y-1.5">
              <Label htmlFor="word">{style.wordLabel ?? "Word"}</Label>
              {props.mode === "create" ? (
                <div className="relative">
                  <Input
                    id="word"
                    autoFocus
                    value={word}
                    onChange={(e) => {
                      setWord(e.target.value);
                      // Only fan out the typeahead suggestions on
                      // styles that actually look up dict entries.
                      // Sentence style sets showTypeahead=false; we
                      // suppress the suggestions popover there.
                      if (style.showTypeahead !== false) {
                        setShowSuggestions(true);
                      }
                    }}
                    onFocus={() => {
                      if (style.showTypeahead !== false) setShowSuggestions(true);
                    }}
                    // Delay blur-close so a click on a suggestion row
                    // fires before the popover unmounts. 150 ms beats
                    // a native click's input-blur race comfortably.
                    onBlur={() =>
                      window.setTimeout(() => setShowSuggestions(false), 150)
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Escape" && showSuggestions) {
                        e.preventDefault();
                        setShowSuggestions(false);
                      }
                    }}
                    placeholder={style.wordPlaceholder ?? "e.g. 餐馆"}
                    autoComplete="off"
                  />
                  {style.showTypeahead !== false && showSuggestions && suggestions.length > 0 && (
                    <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md">
                      {suggestions.map((s, i) => (
                        <button
                          key={`${s.word}-${i}`}
                          type="button"
                          // Mouse-down beats input-blur, so we don't
                          // need to defer state in the handler — the
                          // input's onBlur fires later and finds the
                          // popover already dismissed.
                          onMouseDown={(ev) => {
                            ev.preventDefault();
                            pickSuggestion(s);
                          }}
                          className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-accent"
                        >
                          <span className="font-serif text-[15px] font-medium leading-none">
                            {s.word}
                          </span>
                          {s.reading && (
                            <span className="text-[11.5px] text-muted-foreground">
                              {workspace.targetLang === "zh"
                                ? prettyPinyin(s.reading)
                                : s.reading}
                            </span>
                          )}
                          <span className="ml-1 flex-1 truncate text-[11.5px] text-muted-foreground/85">
                            {s.gloss}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="mt-1 font-serif text-3xl tracking-tight">{word}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reading">Reading</Label>
              <Input
                id="reading"
                value={reading}
                onChange={(e) => setReading(e.target.value)}
                placeholder="pinyin / romaji / IPA"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="gloss">{style.glossLabel ?? "Definition"}</Label>
                {/* Front/back swap — exchanges the word and gloss
                    values in-place. The card stored has gloss as
                    its front and word as its back, so vocab-recall
                    naturally drills meaning → target (a "reverse"
                    card) without needing a new schema column.
                    Hidden on sentence + cloze styles where swap
                    doesn't make sense (sentence's front IS the
                    sentence; cloze's front IS the masked sentence). */}
                {style.id !== "sentence" && style.id !== "cloze" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    onClick={swapFrontBack}
                    disabled={!word.trim() && !gloss.trim()}
                    title="Swap front and back — meaning becomes the front, word becomes the back."
                  >
                    <ArrowLeftRight className="size-3" />
                    Swap front/back
                  </Button>
                )}
              </div>
              <Textarea
                id="gloss"
                value={gloss}
                onChange={(e) => setGloss(e.target.value)}
                rows={3}
                placeholder="separate senses with ; "
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="translation" className="flex items-baseline gap-1.5">
                Translation
                <span className="text-[10.5px] font-normal text-muted-foreground">
                  optional
                </span>
              </Label>
              <Textarea
                id="translation"
                value={translation}
                onChange={(e) => setTranslation(e.target.value)}
                rows={2}
                placeholder="A natural translation in your native language — distinct from the dictionary definition above."
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cloze">Cloze sentence</Label>
              <Textarea
                id="cloze"
                value={frontExtra}
                onChange={(e) => setFrontExtra(e.target.value)}
                rows={2}
                placeholder="Wrap the target word like {{c1::word}}"
                className="font-mono text-[13px]"
              />
              <p className="text-[11px] text-muted-foreground">
                Front shows <span className="font-mono">____</span>, back reveals.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                value={cardNotes}
                onChange={(e) => setCardNotes(e.target.value)}
                rows={2}
                placeholder="mnemonics, examples, etymology…"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="flex items-baseline gap-1.5">
                Image
                <span className="text-[10.5px] font-normal text-muted-foreground">
                  optional
                </span>
              </Label>
              {imageData ? (
                <div className="flex items-start gap-2">
                  <img
                    src={imageData}
                    alt=""
                    className="h-24 w-24 rounded-md object-cover ring-1 ring-border"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setImageData(null)}
                  >
                    <Trash2 className="size-3.5" /> Remove
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="flex h-24 w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border bg-muted/40 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                >
                  <span className="flex items-center gap-2">
                    <ImagePlus className="size-4" /> Add image
                  </span>
                  <span className="text-[10.5px] text-muted-foreground/80">
                    or paste from clipboard (Ctrl/Cmd+V)
                  </span>
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void pickImage(f);
                  e.target.value = "";
                }}
              />
            </div>

            <CardAudioField
              word={word}
              lang={workspace.targetLang}
              bytes={audioBytes}
              mime={audioMime}
              onChange={(next) => {
                setAudioBytes(next.bytes);
                setAudioMime(next.mime);
                setAudioDirty(true);
              }}
            />
          </div>

          {/* ── Column 2 — enrichment actions ─────────────────────── */}
          <div className="space-y-2 border-r border-border bg-muted/20 px-4 py-5">
            <div className="mb-2 flex items-center justify-between">
              <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Enrichment
              </Label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void applyRemaining()}
                disabled={!word.trim() || running.size > 0}
                className="h-7 px-2 text-[11.5px]"
                title="Run every enricher whose target field is still blank"
              >
                <Wand2 className="size-3" />
                Apply remaining
              </Button>
            </div>
            {enrichers.length === 0 && (
              <p className="text-[12px] text-muted-foreground">
                No enrichers available for this language.
              </p>
            )}
            {enrichers.map((e) => {
              const Icon = e.meta.icon ?? Sparkles;
              const isRunning = running.has(e.meta.id);
              const ran = ranOnce.has(e.meta.id);
              return (
                <div
                  key={e.meta.id}
                  className="flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2"
                >
                  <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[12.5px] font-medium">
                        {e.meta.name}
                      </span>
                      {ran && (
                        <Badge variant="secondary" className="h-4 gap-0.5 px-1 py-0 text-[10px]">
                          <Check className="size-2.5" /> ran
                        </Badge>
                      )}
                    </div>
                    <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                      {e.meta.description}
                    </p>
                    {e.meta.trigger === "manual" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void runEnricher(e)}
                        disabled={!word.trim() || isRunning}
                        className="mt-1.5 h-6 px-2 text-[11px]"
                      >
                        {isRunning ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Wand2 className="size-3" />
                        )}
                        Run
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── Column 3 — live preview ─────────────────────────── */}
          <div className="space-y-4 px-5 py-5">
            <div>
              <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Front
              </Label>
              <CardFace
                main={clozePreview ? clozePreview.masked : word || "—"}
                imageData={imageData}
                showsBack={false}
              />
            </div>
            <div>
              <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Back
              </Label>
              <CardFace
                main={clozePreview ? clozePreview.revealed : word || "—"}
                reading={reading}
                gloss={gloss}
                imageData={imageData}
                notes={cardNotes}
                showsBack
              />
            </div>
          </div>
        </div>

        <DialogFooter className="border-t border-border px-5 py-3">
          <Button variant="ghost" onClick={props.onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !word.trim()}>
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            {saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CardFace({
  main,
  reading,
  gloss,
  imageData,
  notes,
  showsBack,
}: {
  main: string;
  reading?: string;
  gloss?: string;
  imageData: string | null;
  notes?: string;
  showsBack: boolean;
}) {
  return (
    <div className="mt-1 flex min-h-[140px] flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-5 text-center">
      {imageData && (
        <img src={imageData} alt="" className="max-h-24 rounded-md object-contain" />
      )}
      <div className="font-serif text-2xl leading-tight tracking-tight">{main}</div>
      {showsBack && reading && (
        <div className="text-[13px] font-semibold text-emerald-600 dark:text-emerald-400">
          {reading}
        </div>
      )}
      {showsBack && gloss && (
        <div className="text-[13px] leading-relaxed text-foreground/85">{gloss}</div>
      )}
      {showsBack && notes && (
        <div className="mt-1 max-w-full text-[12px] leading-relaxed text-muted-foreground whitespace-pre-line">
          {notes}
        </div>
      )}
    </div>
  );
}

function isBlank(draft: CardDraft, key: keyof CardPatch): boolean {
  switch (key) {
    case "reading":
    case "gloss":
    case "frontExtra":
    case "cardNotes":
    case "imageData":
    case "audioMime":
      return !draft[key] || (draft[key] as string).trim?.() === "";
    case "audioBytes":
      return !draft.audioBytes || draft.audioBytes.byteLength === 0;
  }
  return true;
}

// Mirrors the helper in provider-context. Inlined here (same as
// card-create-dialog used to do) to avoid an import cycle with the
// chat-send pipeline.
function toRustConfig(p: ProviderConfig): unknown {
  switch (p.kind) {
    case "ollama":
      return { kind: "ollama", host: p.host ?? "http://localhost:11434", model: p.model };
    case "openai":
      return {
        kind: "openai",
        api_key: p.apiKey ?? "",
        model: p.model,
        base_url: p.baseUrl ?? null,
      };
    case "anthropic":
      return { kind: "anthropic", api_key: p.apiKey ?? "", model: p.model };
    case "gemini":
      return { kind: "gemini", api_key: p.apiKey ?? "", model: p.model };
    case "minimax":
      return {
        kind: "minimax",
        api_key: p.apiKey ?? "",
        model: p.model,
        base_url: p.baseUrl ?? null,
      };
  }
  // Tokori Cloud and any future providers go through the JS sendChat
  // path, not the Rust IPC — translateFallback's callAi handles that
  // case in the !isTauri() branch above. We should never get a request
  // for `toRustConfig` on a non-Rust provider.
  return null;
}

// Suppress the unused-vars warning on the kind we don't model here —
// VocabKind is used in the type signature but TypeScript can't track
// JSX usage through the discriminated union.
export type { VocabKind };
