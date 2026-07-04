import { useCallback, useRef, useEffect, useState } from "react";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { ChevronDown, Download, FileText, Loader2, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  deleteDictionary,
  installDictionary,
  listDictionaries,
  type DictEntry,
  type Dictionary,
} from "@/lib/db";
import { useWorkspace } from "@/lib/workspace-context";
import {
  languageName,
  PICKABLE_LANGUAGES,
  type LanguageCode,
} from "@/lib/languages";
import { invalidateDictionaryAvailabilityCache } from "@/lib/dict-availability";
import { invalidateDictLookupCache } from "@/lib/word-lookup";
import { HOSTED } from "@/lib/build-flags";
import { cn } from "@/lib/utils";
import {
  DICTIONARY_PACKS,
  formatForUrl,
  type DictionaryPack,
} from "@/lib/dictionaries/registry";
import { parseCustomDict } from "@/lib/dictionaries/custom-import";
import { LANGUAGE_PROFILES } from "@/lib/language-profiles";

type DownloadEvent =
  | { type: "progress"; stage: string; downloaded: number; total: number | null }
  | { type: "parsed"; entries: number };

/**
 * `scope` controls how much of the dictionary catalog to show:
 *   - "workspace": only the pack(s) for the active workspace's target
 *     language. The Dictionaries tab inside the workspace uses this so a
 *     Chinese learner doesn't have to scroll past JMdict / Ding / Kengdic
 *     to find CC-CEDICT.
 *   - "all" (default): every pack across every language. Used by the
 *     Settings → Dictionaries section so power users can pre-install the
 *     packs for languages they're about to set up workspaces for.
 */
type Scope = "workspace" | "all";

export function DictionariesSection({
  scope = "all",
  onBusyChange,
}: {
  scope?: Scope;
  /** Fires `true` while any pack in this section is downloading or
   *  installing, `false` once everything settles. The onboarding
   *  dictionary step uses it to grey out "Skip for now" mid-install. */
  onBusyChange?: (busy: boolean) => void;
} = {}) {
  // HOSTED: dictionaries live on the server and are pre-installed for
  // every user; there's nothing to manage from the client. Render a
  // tiny informational card instead of the full install UI so the
  // settings page isn't a dead-end. Split into an inner component so the
  // desktop body's hooks always run (this wrapper has none).
  if (HOSTED) return <HostedDictionariesNotice />;
  return <DictionariesSectionInner scope={scope} onBusyChange={onBusyChange} />;
}

function DictionariesSectionInner({
  scope,
  onBusyChange,
}: {
  scope: Scope;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { active: workspace } = useWorkspace();
  const [dicts, setDicts] = useState<Dictionary[]>([]);
  // In Settings → Dictionaries we collapse other-language packs behind
  // a "Load more" toggle by default. Most users only ever care about
  // the language they're learning right now; the catalog can grow.
  const [showAll, setShowAll] = useState(false);

  const activeLang = workspace?.targetLang ?? null;

  // Aggregate per-pack install activity into one signal for the parent.
  // A Set (keyed by pack id) handles languages with more than one pack
  // (e.g. Korean) without races between cards.
  const [busyPacks, setBusyPacks] = useState<Set<string>>(() => new Set());
  const reportBusy = useCallback((packId: string, busy: boolean) => {
    setBusyPacks((prev) => {
      if (busy === prev.has(packId)) return prev;
      const next = new Set(prev);
      if (busy) next.add(packId);
      else next.delete(packId);
      return next;
    });
  }, []);
  const anyBusy = busyPacks.size > 0;
  useEffect(() => {
    onBusyChange?.(anyBusy);
  }, [anyBusy, onBusyChange]);

  async function refresh() {
    setDicts(await listDictionaries());
    // Drop the popover-side caches so a fresh install / removal is
    // reflected in click-to-define hints without a reload — both the
    // "is there a dict?" availability flag and the per-word entry cache
    // (whose cached misses are now stale).
    invalidateDictionaryAvailabilityCache();
    invalidateDictLookupCache();
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Three slices:
  //   - activePacks: matches the active workspace's language.
  //   - otherPacks:  everything else.
  // Workspace scope: only the active slice ever renders.
  // Settings scope: active first, then "Load more" reveals others.
  const activePacks = activeLang
    ? DICTIONARY_PACKS.filter((p) => p.lang === activeLang)
    : [];
  const otherPacks = activeLang
    ? DICTIONARY_PACKS.filter((p) => p.lang !== activeLang)
    : [...DICTIONARY_PACKS];
  const visiblePacks =
    scope === "workspace"
      ? activePacks
      : showAll
        ? [...activePacks, ...otherPacks]
        : activePacks.length > 0
          ? activePacks
          : otherPacks; // No workspace yet — show everything (nothing to collapse).

  // Same filtering for the "Installed" tail — in workspace scope the
  // user only cares about the currently-relevant pack.
  const visibleInstalled =
    scope === "workspace" && activeLang
      ? dicts.filter((d) => d.lang === activeLang)
      : dicts;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">
          {scope === "workspace" ? `${activeLang ? languageName(activeLang) + " " : ""}dictionary` : "Dictionaries"}
        </h2>
        <p className="text-[13px] text-muted-foreground">
          Click-to-define popovers and the dictionary search both read from
          installed packs.{" "}
          {scope === "workspace" ? (
            <>
              Showing the pack relevant to this workspace
              {workspace && (
                <>
                  {" "}
                  (
                  <span className="font-medium text-foreground">
                    {languageName(workspace.targetLang)}
                  </span>
                  )
                </>
              )}
              . Other languages live in{" "}
              <span className="font-medium text-foreground">
                Settings → Dictionaries
              </span>
              .
            </>
          ) : workspace ? (
            <>
              Your active workspace is{" "}
              <span className="font-medium text-foreground">
                {languageName(workspace.targetLang)}
              </span>{" "}
              — its pack is highlighted below.
            </>
          ) : (
            <> Add a workspace first to see which pack you need.</>
          )}
        </p>
      </div>

      {visiblePacks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card/40 px-4 py-6 text-center text-[13px] text-muted-foreground">
          No packaged dictionary ships for{" "}
          {activeLang ? (
            <span className="font-medium text-foreground">{languageName(activeLang)}</span>
          ) : (
            "this language"
          )}{" "}
          yet — use the Personal section below to add entries by hand.
        </div>
      ) : (
        <div className="space-y-3">
          {visiblePacks.map((pack) => (
            <PackCard
              key={pack.id}
              pack={pack}
              installed={
                dicts.find((d) => d.lang === pack.lang && d.name === pack.name) ?? null
              }
              isActiveLang={activeLang === pack.lang}
              onChange={refresh}
              onBusyChange={reportBusy}
            />
          ))}
          {/* "Load more" toggle. Only renders when:
              - we're in Settings scope (workspace scope never shows
                cross-language packs anyway),
              - there's an active workspace to collapse against, and
              - there are other-language packs we'd otherwise hide.
              The collapse state is local — re-opening Settings starts
              collapsed again, which is what most users actually want
              after they've installed the pack they came for. */}
          {scope === "all" &&
            activeLang &&
            otherPacks.length > 0 &&
            (showAll ? (
              <button
                type="button"
                onClick={() => setShowAll(false)}
                className="w-full rounded-lg border border-dashed border-border bg-card/40 px-4 py-2.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
              >
                Show fewer — collapse other-language packs
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="w-full rounded-lg border border-dashed border-border bg-card/40 px-4 py-2.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
              >
                Load more — {otherPacks.length} pack{otherPacks.length === 1 ? "" : "s"} for other languages
              </button>
            ))}
        </div>
      )}

      {visibleInstalled.length > 0 && (
        <div className="space-y-2">
          <p className="px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Installed
          </p>
          <ul className="space-y-1">
            {visibleInstalled.map((d) => (
              <li
                key={d.id}
                className={cn(
                  "flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm",
                  scope === "all" && activeLang && d.lang !== activeLang && "opacity-70",
                )}
              >
                <span className="font-medium">{d.name}</span>
                <Badge variant="outline" className="text-[10px]">
                  {d.lang}
                </Badge>
                {activeLang === d.lang && (
                  <Badge variant="secondary" className="text-[10px]">
                    active
                  </Badge>
                )}
                <span className="ml-auto text-[12px] text-muted-foreground">
                  {d.entryCount.toLocaleString()} entries
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={async () => {
                    await deleteDictionary(d.id);
                    await refresh();
                    toast(`Removed ${d.name}`);
                  }}
                  title="Remove"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Custom dictionary import — Settings-only. Lets the user
          bring their own JSON / CSV / TSV file when none of the
          packaged dictionaries cover their language (or when they
          have a custom one already). The card sits at the bottom so
          it's always reachable but doesn't crowd the predefined
          choices above. */}
      {scope === "all" && (
        <CustomDictCard defaultLang={activeLang} onChange={refresh} />
      )}
    </div>
  );
}

/** Slim indeterminate progress bar for phases we can't measure (the
 *  download + parse stream no byte counts). Mirrors the height / rounding
 *  of the determinate <Progress> used while inserting, so the install
 *  card reads as one continuous progress affordance. Under
 *  prefers-reduced-motion it falls back to a static full bar (see
 *  `.progress-indeterminate` in index.css). */
function IndeterminateBar() {
  return (
    <div
      role="progressbar"
      aria-label="Working…"
      className="relative h-2 w-full overflow-hidden rounded-full bg-primary/20"
    >
      <div className="progress-indeterminate absolute inset-y-0 rounded-full bg-primary/80" />
    </div>
  );
}

function PackCard({
  pack,
  installed,
  isActiveLang,
  onChange,
  onBusyChange,
}: {
  pack: DictionaryPack;
  installed: Dictionary | null;
  isActiveLang: boolean;
  onChange: () => Promise<void> | void;
  /** Reports this card's download/install activity to the section so a
   *  parent (the onboarding step) can react — e.g. lock "Skip for now". */
  onBusyChange?: (packId: string, busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string>("");
  const [insertedRatio, setInsertedRatio] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [customUrl, setCustomUrl] = useState("");

  // Surface activity upward; the cleanup clears the flag if the card
  // unmounts mid-install so a parent lock can't get stuck.
  useEffect(() => {
    onBusyChange?.(pack.id, busy);
    return () => onBusyChange?.(pack.id, false);
  }, [busy, pack.id, onBusyChange]);

  async function install(urlOverride?: string | null) {
    if (!isTauri()) {
      setError("Run `npm run tauri dev` to download a dictionary.");
      return;
    }
    setBusy(true);
    setError(null);
    setInsertedRatio(null);
    // Show the download phase immediately — before the first Rust
    // progress event lands — so pressing Install gives instant feedback
    // (the Rust side then refines this with the source host, etc.).
    setStage("downloading…");
    try {
      const channel = new Channel<DownloadEvent>();
      channel.onmessage = (event) => {
        if (event.type === "progress") setStage(event.stage);
        else if (event.type === "parsed")
          setStage(`parsed ${event.entries.toLocaleString()} entries`);
      };

      const url = urlOverride ?? pack.defaultUrl;
      // The JMdict pack lists both XML (EDRDG canonical) and JSON
      // (jmdict-simplified) presets — pick the right parser by extension
      // so users don't have to think about it.
      const effectiveFormat = formatForUrl(pack, url);
      // CC-CEDICT keeps using the original command for back-compat with the
      // multi-mirror fallback chain. New formats route through dict_fetch_lang.
      const command = effectiveFormat === "cedict" ? "dict_fetch_cedict" : "dict_fetch_lang";
      const args =
        effectiveFormat === "cedict"
          ? { url: urlOverride ?? null, onEvent: channel }
          : { url, format: effectiveFormat, onEvent: channel };

      const entries = await invoke<DictEntry[]>(command, args);
      setStage("inserting…");
      await installDictionary({
        lang: pack.lang,
        name: pack.name,
        sourceUrl: url,
        entries,
        onProgress: (i, total) => setInsertedRatio(i / total),
      });
      setStage("done");
      await onChange();
      toast.success(`Installed ${entries.length.toLocaleString()} ${pack.name} entries`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error("Dictionary install failed", { description: msg.slice(0, 240) });
    } finally {
      setBusy(false);
      setInsertedRatio(null);
    }
  }

  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-4 transition-colors",
        isActiveLang ? "border-foreground/30" : "border-border opacity-90",
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium">{pack.name}</span>
            <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
              {languageName(pack.lang)}
            </Badge>
            {/* "Recommended" surfaces the language profile's curated
             *  default pack so users picking from a multi-pack language
             *  (e.g. Spanish, Korean) know which to install first.
             *  Read off LANGUAGE_PROFILES so the registry stays the
             *  single source of truth — no per-pack `recommended` flag
             *  to keep in sync. */}
            {LANGUAGE_PROFILES[pack.lang]?.recommendedDict === pack.id && (
              <Badge
                variant="default"
                className="text-[10px] uppercase tracking-wider"
              >
                Recommended
              </Badge>
            )}
            {isActiveLang && (
              <Badge variant="secondary" className="text-[10px]">
                active workspace
              </Badge>
            )}
            {installed && (
              <Badge variant="secondary" className="text-[10px]">
                installed · {installed.entryCount.toLocaleString()}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">{pack.description}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground/80">{pack.size}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          {installed && (
            <Button
              variant="ghost"
              size="icon-sm"
              title="Remove"
              onClick={async () => {
                await deleteDictionary(installed.id);
                await onChange();
                toast(`Removed ${pack.name}`);
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
          <Button onClick={() => install()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            {installed ? "Reinstall" : "Install"}
          </Button>
        </div>
      </div>

      {busy && (
        <div className="mt-3 space-y-1.5">
          <p className="text-[12px] text-muted-foreground">{stage || "working…"}</p>
          {/* Inserting reports a real ratio → determinate bar. The
              download + parse phases stream no byte counts, so show an
              indeterminate bar there instead of nothing — the card now
              has a continuous progress affordance from download → insert. */}
          {insertedRatio != null ? (
            <Progress value={insertedRatio * 100} />
          ) : (
            <IndeterminateBar />
          )}
        </div>
      )}
      {error && <p className="mt-3 text-[12px] text-destructive whitespace-pre-line">{error}</p>}

      {pack.presets && pack.presets.length > 1 && (
        <button
          type="button"
          onClick={() => setShowAdvanced((s) => !s)}
          className="mt-3 inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
        >
          <ChevronDown
            className={`size-3 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
          />
          {showAdvanced ? "Hide alternative sources" : "Use a different source"}
        </button>
      )}

      {showAdvanced && pack.presets && (
        <div className="mt-3 space-y-3 rounded-lg border border-border bg-background/40 p-3">
          <div className="grid gap-2">
            <Label htmlFor={`url-${pack.id}`} className="text-[12px]">
              Source URL
            </Label>
            <Input
              id={`url-${pack.id}`}
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              placeholder={pack.defaultUrl}
              className="font-mono text-[12px]"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {pack.presets.map((p) => (
              <button
                key={p.url}
                type="button"
                onClick={() => setCustomUrl(p.url)}
                className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {p.label}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => install(customUrl.trim() || null)}
            disabled={busy || !customUrl.trim()}
          >
            <Download className="size-3.5" />
            Install from custom URL
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Custom-dictionary import (file-based) ────────────────────────────
// The parser lives in `@/lib/dictionaries/custom-import` so it can be
// unit-tested without spinning up React. This card is just the UI shell.

function CustomDictCard({
  defaultLang,
  onChange,
}: {
  defaultLang: LanguageCode | null;
  onChange: () => Promise<void> | void;
}) {
  const [lang, setLang] = useState<LanguageCode>(defaultLang ?? "en");
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSpec, setShowSpec] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // If the user picks a workspace before opening this card, we
  // pre-fill the lang. Re-syncing on workspace change covers the
  // common "I switched workspaces and want to install for the new
  // one" flow.
  useEffect(() => {
    if (defaultLang) setLang(defaultLang);
  }, [defaultLang]);

  async function pickFile(picked: File | null) {
    setError(null);
    setPreviewCount(null);
    if (!picked) {
      setFile(null);
      return;
    }
    setFile(picked);
    if (!name) {
      // Default name to the filename (sans extension) so the user
      // doesn't have to type one for the common case.
      setName(picked.name.replace(/\.[^.]+$/, ""));
    }
    try {
      const text = await picked.text();
      const entries = parseCustomDict(picked.name, text);
      if (entries.length === 0) {
        setError("File parsed cleanly but no entries were found.");
      } else {
        setPreviewCount(entries.length);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function install() {
    if (!file) return;
    const finalName = name.trim() || file.name.replace(/\.[^.]+$/, "");
    setBusy(true);
    setError(null);
    try {
      const text = await file.text();
      const entries = parseCustomDict(file.name, text);
      if (entries.length === 0) {
        throw new Error("No entries to install.");
      }
      await installDictionary({
        lang,
        name: finalName,
        sourceUrl: null,
        entries,
      });
      toast.success(
        `Installed ${entries.length.toLocaleString()} entries as "${finalName}".`,
      );
      // Reset for the next import.
      setFile(null);
      setName("");
      setPreviewCount(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">Custom dictionary</h3>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Bring your own JSON or CSV/TSV. Click-to-define popovers and
            the dictionary search read it the same as a packaged dict.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowSpec((v) => !v)}
          className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
        >
          {showSpec ? "Hide format" : "What format?"}
        </button>
      </div>

      {showSpec && (
        <div className="mt-3 space-y-2 rounded-md border border-border/60 bg-muted/30 p-3 text-[12px] text-muted-foreground">
          <p className="font-medium text-foreground">Standard formats</p>
          <p>
            <span className="font-mono text-[11px]">.json</span> — array of{" "}
            <span className="font-mono text-[11px]">{`{word, reading?, gloss}`}</span>{" "}
            objects, or a flat{" "}
            <span className="font-mono text-[11px]">{`{ "word": "gloss" }`}</span> map.
          </p>
          <p>
            <span className="font-mono text-[11px]">.csv</span> /{" "}
            <span className="font-mono text-[11px]">.tsv</span> — 2 columns
            (<span className="font-mono text-[11px]">word, gloss</span>) or 3 columns
            (<span className="font-mono text-[11px]">word, reading, gloss</span>).
            Lines starting with <span className="font-mono text-[11px]">#</span> are
            comments.
          </p>
          <pre className="overflow-x-auto rounded bg-background p-2 text-[11px] leading-snug">
{`# JSON example
[
  { "word": "你好", "reading": "nǐ hǎo", "gloss": "hello" },
  { "word": "再见", "gloss": "goodbye" }
]

# CSV example
你好,nǐ hǎo,hello
再见,,goodbye`}
          </pre>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-[140px_1fr]">
        <div className="grid gap-1.5">
          <Label className="text-[11.5px]">Language</Label>
          <Select value={lang} onValueChange={(v) => setLang(v as LanguageCode)}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PICKABLE_LANGUAGES.map((l) => (
                <SelectItem key={l.code} value={l.code}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-[11.5px]">Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. My German glossary"
            className="h-9"
          />
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.csv,.tsv,application/json,text/csv,text/tab-separated-values"
          className="hidden"
          onChange={(e) => void pickFile(e.target.files?.[0] ?? null)}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
        >
          <Upload className="size-3.5" />
          Choose file
        </Button>
        {file && (
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <FileText className="size-3.5" />
            {file.name}
            {previewCount != null && (
              <span className="rounded-full border border-border bg-background px-1.5 py-0.5 text-[10.5px] tabular-nums">
                {previewCount.toLocaleString()} entries
              </span>
            )}
          </span>
        )}
        <Button
          size="sm"
          className="ml-auto"
          onClick={install}
          disabled={busy || !file || previewCount == null || previewCount === 0}
        >
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          Install
        </Button>
      </div>

      {error && (
        <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[12px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Hosted-mode placeholder. Dictionaries are managed by the operator
 *  server-side via `npm run dicts:seed` in the cloud repo, so there's
 *  nothing for the end user to do here. We still render *something*
 *  (rather than a missing section) so the settings page doesn't feel
 *  hollowed out — and so a future "use a different dictionary" toggle
 *  has a place to land. */
function HostedDictionariesNotice() {
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Dictionaries</h2>
        <p className="text-[13px] text-muted-foreground">
          Tokori Cloud comes with dictionaries pre-installed for every
          supported language. Click-to-define popovers, search, and the
          vocabulary extractor all read from them automatically — there's
          nothing to install on your end.
        </p>
      </div>
      <div className="rounded-md border border-border bg-card/60 px-3 py-2.5 text-[12.5px] text-muted-foreground">
        Need a custom or specialised dictionary for your workspace?{" "}
        <a
          href="mailto:hello@tokori.ai?subject=Custom%20dictionary%20request"
          className="font-medium text-foreground underline-offset-2 hover:underline"
        >
          Let us know
        </a>{" "}
        and we'll add it.
      </div>
    </div>
  );
}
