/**
 * Vocab Import — pluggable importers + dictionary preview + translation.
 *
 * Flow:
 *   1. Pick an importer (generic CSV by default; HackChinese only shows
 *      for Chinese workspaces; more added via `lib/vocab-import/registry`).
 *   2. Drop a file or paste text. The importer's `parse(text)` returns
 *      `ImportRow[]` — pure, no side effects.
 *   3. Preview table joins each row against `lookupDict(targetLang, word)`
 *      so the user sees which entries already have a definition. Rows
 *      missing a gloss get a "no dict match" chip and a per-row Translate
 *      button. There's also a bulk "Translate all missing" action.
 *   4. Translation routes through the user's default `TranslateConfig`
 *      (or the seeded google-free fallback). Translated rows are tagged
 *      so on import they're also written into the workspace's Personal
 *      dictionary — that way the next import / lookup picks them up.
 *   5. Import calls `saveVocab` per row. Rows carrying `srsHint` (e.g.
 *      from HackChinese) seed the FSRS state so existing review schedules
 *      survive the migration.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileUp,
  Loader2,
  Sparkles,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  addDictEntry,
  getOrCreatePersonalDict,
  listTranslateConfigs,
  lookupDict,
  saveVocab,
  type TranslateConfig,
} from "@/lib/db";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { useWorkspace } from "@/lib/workspace-context";
import { useProviderConfigs } from "@/lib/provider-context";
import {
  importerById,
  importersForLanguage,
  IMPORTERS,
} from "@/lib/vocab-import/registry";
import type { ImportRow } from "@/lib/vocab-import/api";
import { engineByKind, FALLBACK_ENGINE } from "@/lib/translate/registry";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

const LAST_IMPORTER_KEY = "vocabImport.lastImporterId";

type PreviewRow = ImportRow & {
  /** Filled in by the dictionary join — null when the workspace dict has nothing. */
  dictGloss: string | null;
  dictReading: string | null;
  /** True after a successful AI / Google / DeepL / Baidu translation. */
  translated: boolean;
};

type ChatEvent =
  | { type: "token"; delta: string }
  | { type: "done"; content: string }
  | { type: "error"; message: string };

export function VocabImportDialog({
  open,
  onClose,
  onDone,
  initialText = "",
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void | Promise<void>;
  /** Optional text pre-filled into the textarea (used by chat "Import" button on csv blocks). */
  initialText?: string;
}) {
  const { active: workspace } = useWorkspace();
  const { providers, sendChat } = useProviderConfigs();
  const importers = useMemo(
    () => (workspace ? importersForLanguage(workspace.targetLang) : IMPORTERS),
    [workspace],
  );

  const [importerId, setImporterId] = useState<string>(importers[0]?.meta.id ?? "generic-csv");
  const [text, setText] = useState(initialText);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [translateConfigs, setTranslateConfigs] = useState<TranslateConfig[]>([]);
  const [translateConfigId, setTranslateConfigId] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Bootstrap the importer choice from last-used and the configured
  // translation engines. We re-fetch translate configs each open in case
  // the user just added one in Settings.
  useEffect(() => {
    if (!open) return;
    setText(initialText);
    setStage("");
    setBusy(false);
    void (async () => {
      const cfgs = await listTranslateConfigs();
      setTranslateConfigs(cfgs);
      const fallback = cfgs.find((c) => c.isDefault) ?? cfgs[0] ?? null;
      setTranslateConfigId(fallback?.id ?? null);
      const last = localStorage.getItem(LAST_IMPORTER_KEY);
      if (last && importers.some((i) => i.meta.id === last)) {
        setImporterId(last);
      } else if (importers[0]) {
        setImporterId(importers[0].meta.id);
      }
    })();
  }, [open, initialText, importers]);

  // Re-parse + dict-match whenever text or importer choice changes.
  useEffect(() => {
    if (!workspace) {
      setRows([]);
      return;
    }
    const importer = importerById(importerId);
    if (!importer) {
      setRows([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      // Addon importers parse inside a sandbox worker, so `parse` may be
      // async — `await` covers both (a sync built-in array awaits to itself).
      let parsed: ImportRow[];
      try {
        parsed = await importer.parse(text);
      } catch (err) {
        console.warn("importer parse failed", err);
        if (!cancelled) setRows([]);
        return;
      }
      if (cancelled) return;
      if (parsed.length === 0) {
        setRows([]);
        return;
      }
      // Run dictionary lookups in parallel — `lookupDict` is one IPC per
      // call but they're independent so Promise.all is fine for the
      // typical "few hundred rows" import. If users start importing
      // 10k-row files we'll batch via a single SELECT.
      const looked = await Promise.all(
        parsed.map((r) => lookupDict(workspace.targetLang, r.word).catch(() => null)),
      );
      if (cancelled) return;
      const out: PreviewRow[] = parsed.map((r, i) => {
        const hit = looked[i];
        return {
          ...r,
          dictGloss: hit?.gloss ?? null,
          dictReading: hit?.reading ?? null,
          translated: false,
        };
      });
      setRows(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [text, importerId, workspace]);

  const totals = useMemo(() => {
    const matched = rows.filter((r) => (r.gloss?.trim() || r.dictGloss)).length;
    const missing = rows.length - matched;
    return { total: rows.length, matched, missing };
  }, [rows]);

  async function handleFile(file: File | null | undefined) {
    if (!file) return;
    const body = await file.text();
    setText(body);
  }

  function effectiveGloss(r: PreviewRow): string | null {
    return r.gloss?.trim() || r.dictGloss || null;
  }

  function effectiveReading(r: PreviewRow): string | null {
    return r.reading?.trim() || r.dictReading || null;
  }

  /** Resolve which engine actually runs. The default config wins; if
   *  nothing is configured (shouldn't happen — google-free is seeded —
   *  but be defensive) we fall back to the in-process google-free. */
  function pickEngine(): { config: TranslateConfig; engine: ReturnType<typeof engineByKind> } | null {
    const cfg = translateConfigs.find((c) => c.id === translateConfigId)
      ?? translateConfigs.find((c) => c.isDefault)
      ?? translateConfigs[0]
      ?? null;
    if (!cfg) {
      // Synthesise a transient google-free config so the button still works.
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
    return { config: cfg, engine: engineByKind(cfg.kind) };
  }

  /** Non-streaming wrapper around `sendChat` so the AI translate engine
   *  can collect the full reply with one promise. The engine doesn't care
   *  about streaming — it just wants the whole JSON array back. */
  async function callAi({
    provider,
    model,
    messages,
  }: {
    provider: import("@/lib/db").ProviderConfig;
    model: string;
    messages: { role: "user" | "assistant" | "system"; content: string }[];
  }): Promise<string> {
    if (!isTauri()) {
      // Browser-only fallback: use the mock-AI lane that ProviderContext
      // already wires up. We don't get a real translation, but the UI
      // path stays exercised in dev.
      let out = "";
      await sendChat({
        messages,
        onToken: (d) => {
          out += d;
        },
      });
      return out;
    }
    // Override the provider's model for this single call without touching
    // the user's saved provider config.
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
  }

  async function translateIndices(indices: number[]) {
    if (!workspace || indices.length === 0) return;
    const picked = pickEngine();
    if (!picked || !picked.engine) {
      toast.error("No translation engine available");
      return;
    }
    setBusy(true);
    setStage(`Translating ${indices.length} word${indices.length === 1 ? "" : "s"}…`);
    try {
      const texts = indices.map((i) => rows[i].word);
      const out = await picked.engine.translate({
        source: workspace.targetLang,
        target: workspace.nativeLang,
        texts,
        config: picked.config,
        callAi,
        getProvider: (id) => providers.find((p) => p.id === id) ?? null,
      });
      setRows((prev) => {
        const next = [...prev];
        for (let k = 0; k < indices.length; k++) {
          const i = indices[k];
          const t = (out[k] ?? "").trim();
          if (!t) continue;
          next[i] = { ...next[i], gloss: t, translated: true };
        }
        return next;
      });
      toast.success(`Translated ${out.filter((s) => s?.trim()).length} / ${indices.length}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Translation failed", { description: msg.slice(0, 200) });
    } finally {
      setBusy(false);
      setStage("");
    }
  }

  async function importNow() {
    if (!workspace) return;
    if (rows.length === 0) return;
    setBusy(true);
    localStorage.setItem(LAST_IMPORTER_KEY, importerId);

    let imported = 0;
    let failed = 0;
    let dictSeeded = 0;

    // Resolve the personal dict once — it's per-language so this is safe
    // outside the row loop.
    let personalDictId: number | null = null;
    try {
      const personal = await getOrCreatePersonalDict(workspace.targetLang);
      personalDictId = personal.id;
    } catch (err) {
      console.warn("personal dict bootstrap failed", err);
    }

    try {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        try {
          const gloss = effectiveGloss(r);
          const reading = effectiveReading(r);
          const srsState = r.srsHint
            ? {
                status: r.srsHint.status,
                stability: r.srsHint.intervalDays,
              }
            : undefined;
          await saveVocab({
            workspaceId: workspace.id,
            word: r.word,
            reading,
            gloss,
            source: r.source ?? "import",
            srsState,
          });
          imported++;
          // If we translated this row, also seed the workspace's
          // Personal dictionary so future click-to-define / search
          // hits something instead of falling back to translation again.
          if (r.translated && personalDictId != null && gloss) {
            try {
              await addDictEntry({
                dictId: personalDictId,
                word: r.word,
                altWord: r.altWord ?? null,
                reading,
                gloss: `${gloss} (auto-translated)`,
              });
              dictSeeded++;
            } catch (err) {
              console.warn("dict seed failed", r.word, err);
            }
          }
        } catch (err) {
          console.error("import row failed", r, err);
          failed++;
        }
        if (i % 25 === 0) {
          setStage(`Imported ${imported} / ${rows.length}…`);
          await new Promise((res) => setTimeout(res, 0));
        }
      }
      setStage("done");
      toast.success(
        `Imported ${imported.toLocaleString()} word${imported === 1 ? "" : "s"}` +
          (dictSeeded ? ` · ${dictSeeded} added to Personal dict` : "") +
          (failed ? ` · ${failed} failed` : ""),
      );
      await onDone();
    } finally {
      setBusy(false);
    }
  }

  if (!workspace) return null;

  const importer = importerById(importerId);
  const missingIndices = rows
    .map((r, i) => (effectiveGloss(r) ? -1 : i))
    .filter((i) => i >= 0);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import vocabulary</DialogTitle>
          <DialogDescription>
            Pick the source format, then preview against your{" "}
            <span className="font-mono">{workspace.targetLang}</span> dictionary
            before importing. Missing definitions can be auto-translated and
            added to your Personal dictionary.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          {/* Importer picker */}
          <div className="grid gap-1.5">
            <Label htmlFor="importer">Source format</Label>
            <Select value={importerId} onValueChange={setImporterId} disabled={busy}>
              <SelectTrigger id="importer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {importers.map((imp) => (
                  <SelectItem key={imp.meta.id} value={imp.meta.id}>
                    {imp.meta.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {importer && (
              <p className="text-[11.5px] text-muted-foreground">
                {importer.meta.description}
              </p>
            )}
          </div>

          {/* File / paste */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
            >
              <FileUp className="size-3.5" />
              Choose file
            </Button>
            <span className="text-[12px] text-muted-foreground">or paste below</span>
            <input
              ref={fileRef}
              type="file"
              accept={importer?.meta.fileExt.map((x) => `.${x}`).join(",") ?? ".csv,.tsv,.txt"}
              className="hidden"
              onChange={(e) => {
                void handleFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="csv-body">Rows</Label>
            <textarea
              id="csv-body"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              placeholder={
                importerId === "hackchinese"
                  ? "Simplified\tTraditional\tStatus\tInterval\n你好\t你好\tlearning\t3"
                  : "word,pinyin,english\n你好,nǐ hǎo,hello\n谢谢,xiè xie,thank you"
              }
              className="resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-[12px] leading-relaxed shadow-xs focus:outline-none focus:ring-2 focus:ring-ring"
              disabled={busy}
            />
          </div>

          {/* Preview header + bulk translate */}
          {rows.length > 0 && (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-[12px]">
                  <span className="font-medium">{totals.total} rows</span>
                  <span className="ml-2 text-muted-foreground">
                    {totals.matched} matched · {totals.missing} missing definition
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {translateConfigs.length > 0 && (
                    <Select
                      value={translateConfigId == null ? "" : String(translateConfigId)}
                      onValueChange={(v) => setTranslateConfigId(Number(v))}
                      disabled={busy}
                    >
                      <SelectTrigger className="h-8 text-[12px]">
                        <SelectValue placeholder="Engine" />
                      </SelectTrigger>
                      <SelectContent>
                        {translateConfigs.map((c) => (
                          <SelectItem key={c.id} value={String(c.id)}>
                            {c.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || missingIndices.length === 0}
                    onClick={() => translateIndices(missingIndices)}
                  >
                    <Sparkles className="size-3.5" />
                    Translate {missingIndices.length || ""} missing
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Preview table */}
          {rows.length > 0 && (
            <ScrollArea className="h-[260px] rounded-md border border-border">
              <table className="w-full text-[12.5px]">
                <thead className="sticky top-0 bg-muted/50 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5">Word</th>
                    <th className="px-2 py-1.5">Reading</th>
                    <th className="px-2 py-1.5">Definition</th>
                    <th className="px-2 py-1.5">Source</th>
                    <th className="px-2 py-1.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const gloss = effectiveGloss(r);
                    const reading = effectiveReading(r);
                    const isMissing = !gloss;
                    return (
                      <tr key={`${r.word}-${i}`} className="border-t border-border/60">
                        <td className="px-2 py-1.5 font-medium">
                          {r.word}
                          {r.altWord && (
                            <span className="ml-1.5 text-muted-foreground">/ {r.altWord}</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {reading ?? "—"}
                        </td>
                        <td className="px-2 py-1.5">
                          {gloss ? (
                            <span className="line-clamp-1">{gloss}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          {r.translated ? (
                            <Badge variant="secondary" className="text-[10px]">
                              <Sparkles className="size-3" /> translated
                            </Badge>
                          ) : r.gloss ? (
                            <Badge variant="outline" className="text-[10px]">
                              file
                            </Badge>
                          ) : r.dictGloss ? (
                            <Badge variant="outline" className="text-[10px]">
                              <CheckCircle2 className="size-3" /> dict
                            </Badge>
                          ) : (
                            <Badge variant="destructive" className="text-[10px]">
                              <AlertCircle className="size-3" /> none
                            </Badge>
                          )}
                          {r.srsHint?.status && r.srsHint.status !== "new" && (
                            <Badge variant="outline" className="ml-1 text-[10px]">
                              {r.srsHint.status}
                            </Badge>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          {isMissing && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => translateIndices([i])}
                            >
                              <Sparkles className="size-3.5" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollArea>
          )}

          {busy && stage && (
            <p className="text-[12px] text-muted-foreground">{stage}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={importNow} disabled={busy || rows.length === 0}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
            Import {rows.length > 0 ? rows.length : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Mirror of the Rust-config marshalling done in `provider-context.tsx`.
// Inlined here so we can call `chat_send` with a per-call model override
// (the AI translation engine wants the user's chosen model, not whatever
// the provider's default model happens to be).
function toRustConfig(p: import("@/lib/db").ProviderConfig): unknown {
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
}
