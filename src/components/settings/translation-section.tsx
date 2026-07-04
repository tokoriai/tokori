/**
 * Translation engines settings.
 *
 * One row per (engine, account) the user has wired up. Mirrors the
 * Providers page UI shape so the mental model is the same: list with
 * "Use" / "Edit" / delete, plus an editor dialog. The default flag
 * picks which engine the import dialog reaches for when the user clicks
 * "Translate missing" without specifying one.
 *
 * The google-free engine is seeded by the v14 migration so first use
 * never requires setup; the user can leave it as default forever, or
 * configure DeepL / Google Cloud / Baidu / an LLM and switch.
 */

import { useEffect, useState } from "react";
import { Plus, Trash2, Languages } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  deleteTranslateConfig,
  listTranslateConfigs,
  saveTranslateConfig,
  type TranslateConfig,
  type TranslateKind,
} from "@/lib/db";
import { ENGINES, engineByKind } from "@/lib/translate/registry";
import { useProviderConfigs } from "@/lib/provider-context";
import { cn } from "@/lib/utils";

export function TranslationSection() {
  const [rows, setRows] = useState<TranslateConfig[]>([]);
  const [editing, setEditing] = useState<TranslateConfig | "new" | null>(null);

  async function refresh() {
    setRows(await listTranslateConfigs());
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Translation</h2>
          <p className="text-[13px] text-muted-foreground">
            Engines used by Vocab Import (and, later, click-to-define) when a word
            isn't in your dictionary. Google's free fallback always works without
            configuration — add DeepL, Baidu, an API-key Google Cloud key, or one
            of your LLM providers if you want a different lane.
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus className="size-4" />
          Add engine
        </Button>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-10 text-center">
          <Languages className="mx-auto mb-3 size-6 text-muted-foreground" />
          <p className="text-sm font-medium">No engines yet</p>
          <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted-foreground">
            The free Google fallback should appear automatically — if it doesn't,
            add one manually.
          </p>
        </div>
      ) : (
        <ul className="grid gap-2">
          {rows.map((c) => {
            const engine = engineByKind(c.kind);
            const Icon = engine?.meta.icon ?? Languages;
            return (
              <li
                key={c.id}
                className={cn(
                  "flex items-center gap-3 rounded-xl border bg-card px-4 py-3 transition-colors",
                  c.isDefault
                    ? "border-foreground/30 ring-1 ring-foreground/10"
                    : "border-border",
                )}
              >
                <Icon className="size-5 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 truncate">
                    <span className="font-medium truncate">{c.label}</span>
                    {c.isDefault && (
                      <Badge variant="secondary" className="text-[10px]">
                        default
                      </Badge>
                    )}
                  </div>
                  <div className="truncate text-[12px] text-muted-foreground">
                    {engine?.meta.name ?? c.kind}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={c.isDefault}
                  onClick={async () => {
                    await saveTranslateConfig({ ...c, isDefault: true });
                    await refresh();
                    toast.success(`${c.label} is now the default`);
                  }}
                >
                  Use
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setEditing(c)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={async () => {
                    await deleteTranslateConfig(c.id);
                    await refresh();
                    toast(`Removed ${c.label}`);
                  }}
                  title="Remove"
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <EngineEditor
        open={editing != null}
        config={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
        onSave={async (input) => {
          await saveTranslateConfig(input);
          await refresh();
          setEditing(null);
          toast.success("Saved");
        }}
      />
    </div>
  );
}

type EditorProps = {
  open: boolean;
  config: TranslateConfig | null;
  onClose: () => void;
  onSave: (input: {
    id?: number;
    kind: TranslateKind;
    label: string;
    apiKey?: string | null;
    secondaryKey?: string | null;
    baseUrl?: string | null;
    providerId?: number | null;
    model?: string | null;
    isDefault?: boolean;
  }) => Promise<void>;
};

function EngineEditor({ open, config, onClose, onSave }: EditorProps) {
  const { providers } = useProviderConfigs();
  const [kind, setKind] = useState<TranslateKind>("google-free");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [secondaryKey, setSecondaryKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [providerId, setProviderId] = useState<number | null>(null);
  const [model, setModel] = useState("");
  const [isDefault, setIsDefault] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (config) {
      setKind(config.kind);
      setLabel(config.label);
      setApiKey(config.apiKey ?? "");
      setSecondaryKey(config.secondaryKey ?? "");
      setBaseUrl(config.baseUrl ?? "");
      setProviderId(config.providerId);
      setModel(config.model ?? "");
      setIsDefault(config.isDefault);
    } else {
      setKind("google-free");
      setLabel("");
      setApiKey("");
      setSecondaryKey("");
      setBaseUrl("");
      setProviderId(null);
      setModel("");
      setIsDefault(false);
    }
  }, [open, config]);

  const engine = engineByKind(kind);
  const fields = engine?.meta.fields ?? [];

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{config ? "Edit engine" : "Add translation engine"}</DialogTitle>
          <DialogDescription>{engine?.meta.description}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="kind">Engine</Label>
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as TranslateKind)}
              disabled={!!config}
            >
              <SelectTrigger id="kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENGINES.map((e) => (
                  <SelectItem key={e.meta.kind} value={e.meta.kind}>
                    {e.meta.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="label">Label</Label>
            <Input
              id="label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={engine?.meta.name ?? ""}
            />
          </div>

          {fields.includes("apiKey") && (
            <div className="grid gap-2">
              <Label htmlFor="apiKey">
                {kind === "baidu" ? "App ID" : "API key"}
              </Label>
              <Input
                id="apiKey"
                type={kind === "baidu" ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
          )}

          {fields.includes("secondaryKey") && (
            <div className="grid gap-2">
              <Label htmlFor="secondaryKey">Secret</Label>
              <Input
                id="secondaryKey"
                type="password"
                value={secondaryKey}
                onChange={(e) => setSecondaryKey(e.target.value)}
              />
            </div>
          )}

          {fields.includes("baseUrl") && (
            <div className="grid gap-2">
              <Label htmlFor="baseUrl">Base URL (optional)</Label>
              <Input
                id="baseUrl"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={
                  kind === "deepl"
                    ? "https://api-free.deepl.com/v2/translate"
                    : ""
                }
              />
            </div>
          )}

          {fields.includes("provider") && (
            <div className="grid gap-2">
              <Label htmlFor="providerId">LLM provider</Label>
              <Select
                value={providerId == null ? "" : String(providerId)}
                onValueChange={(v) => setProviderId(v ? Number(v) : null)}
              >
                <SelectTrigger id="providerId">
                  <SelectValue placeholder="Pick a provider…" />
                </SelectTrigger>
                <SelectContent>
                  {providers.length === 0 ? (
                    <SelectItem value="__none" disabled>
                      No providers configured
                    </SelectItem>
                  ) : (
                    providers.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.label} · {p.model}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              <p className="text-[11.5px] text-muted-foreground">
                Reuses one of your chat providers. Add one in Settings → Providers
                first if the list is empty.
              </p>
            </div>
          )}

          {fields.includes("model") && (
            <div className="grid gap-2">
              <Label htmlFor="model">Model override (optional)</Label>
              <Input
                id="model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="leave blank to use the provider's default"
              />
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="size-4"
            />
            Use as default engine
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              onSave({
                id: config?.id,
                kind,
                label: label.trim() || engine?.meta.name || kind,
                apiKey: fields.includes("apiKey") ? apiKey.trim() || null : null,
                secondaryKey: fields.includes("secondaryKey")
                  ? secondaryKey.trim() || null
                  : null,
                baseUrl: fields.includes("baseUrl") ? baseUrl.trim() || null : null,
                providerId: fields.includes("provider") ? providerId : null,
                model: fields.includes("model") ? model.trim() || null : null,
                isDefault,
              })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
