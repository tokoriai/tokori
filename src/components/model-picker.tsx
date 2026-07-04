import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  AlertCircle,
  Check,
  ChevronsUpDown,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { ProviderKind } from "@/lib/db";
import { cn } from "@/lib/utils";

type ModelInfo = { id: string; label: string | null; family: string | null };

type Props = {
  kind: ProviderKind;
  host?: string;
  apiKey?: string;
  baseUrl?: string;
  value: string;
  onChange: (id: string) => void;
  /** Last-resort fallback when the API doesn't expose a model list. */
  suggested?: string[];
  disabled?: boolean;
};

function rustConfigFor(p: Props) {
  switch (p.kind) {
    case "ollama":
      return { kind: "ollama", host: p.host || "http://localhost:11434", model: p.value || "x" };
    case "openai":
      return {
        kind: "openai",
        api_key: p.apiKey ?? "",
        model: p.value || "x",
        base_url: p.baseUrl || null,
      };
    case "anthropic":
      return { kind: "anthropic", api_key: p.apiKey ?? "", model: p.value || "x" };
    case "gemini":
      return { kind: "gemini", api_key: p.apiKey ?? "", model: p.value || "x" };
    case "minimax":
      return {
        kind: "minimax",
        api_key: p.apiKey ?? "",
        model: p.value || "x",
        base_url: p.baseUrl || null,
      };
  }
}

function canFetch(p: Props): boolean {
  if (p.kind === "ollama") return !!p.host;
  return !!p.apiKey;
}

export function ModelPicker(props: Props) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const lastFetchKey = useRef<string>("");

  const fetchKey = `${props.kind}|${props.host ?? ""}|${props.apiKey ? "K" : ""}|${props.baseUrl ?? ""}`;

  async function fetchModels(force = false) {
    if (!canFetch(props)) {
      setError(
        props.kind === "ollama"
          ? "Set the host first."
          : "Enter an API key, then refresh.",
      );
      setModels(null);
      return;
    }
    if (!force && fetchKey === lastFetchKey.current && models) return;
    setLoading(true);
    setError(null);
    try {
      if (!isTauri()) {
        setModels([]);
        setError("Run `npm run tauri dev` to fetch live model lists.");
        return;
      }
      const list = await invoke<ModelInfo[]>("provider_list_models", {
        config: rustConfigFor(props),
      });
      setModels(list);
      lastFetchKey.current = fetchKey;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setModels([]);
    } finally {
      setLoading(false);
    }
  }

  // Auto-fetch when the popover opens and we don't yet have a list.
  useEffect(() => {
    if (open && !models && !loading) void fetchModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const filtered = useMemo(() => {
    if (!models) return [];
    const q = search.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.label?.toLowerCase().includes(q),
    );
  }, [models, search]);

  const exactMatch = !!models?.some((m) => m.id === search.trim());
  const showCustom = search.trim().length > 0 && !exactMatch;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          disabled={props.disabled}
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className={cn("truncate", !props.value && "text-muted-foreground")}>
            {props.value || "Select a model"}
          </span>
          <ChevronsUpDown className="ml-2 size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command shouldFilter={false}>
          <div className="flex items-center gap-1 border-b border-border px-2">
            <CommandInput
              value={search}
              onValueChange={setSearch}
              placeholder="Search or type a custom ID…"
              className="h-9 flex-1 border-0"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void fetchModels(true)}
              disabled={loading}
              title="Refresh"
            >
              {loading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
            </Button>
          </div>

          <CommandList className="max-h-[280px]">
            {showCustom && (
              <>
                <CommandGroup heading="Use a custom ID">
                  <CommandItem
                    value={`custom:${search}`}
                    onSelect={() => {
                      props.onChange(search.trim());
                      setOpen(false);
                    }}
                  >
                    <span className="font-mono text-[13px]">{search.trim()}</span>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      use as-is
                    </span>
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </>
            )}

            {loading && !models && (
              <div className="flex items-center gap-2 px-3 py-3 text-[12.5px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Fetching available models…
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 px-3 py-3 text-[12.5px] text-destructive">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                <span className="break-words">{error}</span>
              </div>
            )}

            {!loading && filtered.length > 0 && (
              <CommandGroup heading={`${filtered.length} model${filtered.length === 1 ? "" : "s"}`}>
                {filtered.map((m) => (
                  <CommandItem
                    key={m.id}
                    value={m.id}
                    onSelect={() => {
                      props.onChange(m.id);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-1 size-3.5",
                        m.id === props.value ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-mono text-[13px]">{m.id}</span>
                      {m.label && m.label !== m.id && (
                        <span className="truncate text-[11px] text-muted-foreground">
                          {m.label}
                        </span>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {!loading && filtered.length === 0 && !error && models != null && (
              <CommandEmpty>
                {models.length === 0
                  ? "Provider didn't return a model list. Type a model ID and press Enter."
                  : "No matches."}
              </CommandEmpty>
            )}

            {!loading && (props.suggested?.length ?? 0) > 0 && (filtered.length === 0 || !!error) && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Suggested">
                  {props.suggested!.map((id) => (
                    <CommandItem
                      key={id}
                      value={`suggested:${id}`}
                      onSelect={() => {
                        props.onChange(id);
                        setOpen(false);
                      }}
                    >
                      <span className="font-mono text-[13px]">{id}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
