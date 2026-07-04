import { useEffect, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  PlugZap,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  ankiCreateDeck,
  ankiDeckNames,
  ankiModelFieldNames,
  ankiModelNames,
  ankiVersion,
  DEFAULT_ANKI,
  loadAnkiSettings,
  saveAnkiSettings,
  type AnkiSettings,
} from "@/lib/anki";

export function AnkiSection() {
  const [s, setS] = useState<AnkiSettings>(DEFAULT_ANKI);
  const [decks, setDecks] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [fields, setFields] = useState<string[]>([]);
  const [version, setVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadAnkiSettings().then(setS);
  }, []);

  async function probe(target = s) {
    setBusy(true);
    setError(null);
    try {
      const v = await ankiVersion(target.endpoint);
      setVersion(v);
      const [dn, mn] = await Promise.all([
        ankiDeckNames(target.endpoint),
        ankiModelNames(target.endpoint),
      ]);
      setDecks(dn);
      setModels(mn);
      if (target.modelName) {
        const f = await ankiModelFieldNames(target.endpoint, target.modelName).catch(() => []);
        setFields(f);
      }
      toast.success(`Connected to AnkiConnect v${v}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setVersion(null);
      toast.error("Couldn't reach AnkiConnect", { description: msg });
    } finally {
      setBusy(false);
    }
  }

  async function refreshFields(modelName: string) {
    if (!modelName) return;
    try {
      const f = await ankiModelFieldNames(s.endpoint, modelName);
      setFields(f);
    } catch {
      setFields([]);
    }
  }

  async function update(patch: Partial<AnkiSettings>) {
    const next = { ...s, ...patch };
    setS(next);
    await saveAnkiSettings(next);
  }

  async function ensureDeckExists() {
    try {
      await ankiCreateDeck(s.endpoint, s.deckName);
      toast.success(`Deck "${s.deckName}" is ready`);
    } catch (err) {
      toast.error("Couldn't create deck", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Anki</h2>
        <p className="text-[13px] text-muted-foreground">
          Optional integration via{" "}
          <a
            href="https://ankiweb.net/shared/info/2055492159"
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-dotted underline-offset-2"
          >
            AnkiConnect
          </a>
          . Run Anki desktop with the add-on installed; we'll talk to it on{" "}
          <span className="font-mono">localhost:8765</span>. Saved vocab is
          mirrored to a deck of your choice — your in-app FSRS queue keeps working
          regardless.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <PlugZap className="size-4 text-muted-foreground" />
            <Label className="text-sm font-medium">Enable Anki sync</Label>
          </div>
          <Switch
            checked={s.enabled}
            onCheckedChange={(v) => void update({ enabled: !!v })}
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="anki-endpoint">Endpoint</Label>
          <div className="flex gap-2">
            <Input
              id="anki-endpoint"
              value={s.endpoint}
              onChange={(e) => setS({ ...s, endpoint: e.target.value })}
              onBlur={() => void update({})}
              className="font-mono text-[12.5px]"
            />
            <Button onClick={() => probe()} disabled={busy} variant="outline">
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              {version ? "Refresh" : "Connect"}
            </Button>
          </div>
          {version != null && (
            <div className="flex items-center gap-1.5 text-[12px] text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-3.5" />
              Connected · AnkiConnect v{version}
            </div>
          )}
          {error && <p className="text-[12px] text-destructive">{error}</p>}
        </div>
      </div>

      {version != null && (
        <div className="rounded-xl border border-border bg-card p-4 space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="grid gap-2">
              <Label>Deck</Label>
              <div className="flex gap-2">
                <Select value={s.deckName} onValueChange={(v) => void update({ deckName: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {decks.map((d) => (
                      <SelectItem key={d} value={d}>
                        {d}
                      </SelectItem>
                    ))}
                    {!decks.includes(s.deckName) && s.deckName && (
                      <SelectItem value={s.deckName}>{s.deckName} (new)</SelectItem>
                    )}
                  </SelectContent>
                </Select>
                <Button variant="outline" onClick={ensureDeckExists}>
                  Create
                </Button>
              </div>
              <Input
                value={s.deckName}
                onChange={(e) => setS({ ...s, deckName: e.target.value })}
                onBlur={() => void update({})}
                placeholder="or type a custom deck name"
                className="text-[12.5px]"
              />
            </div>

            <div className="grid gap-2">
              <Label>Note type</Label>
              <Select
                value={s.modelName}
                onValueChange={(v) => {
                  void update({ modelName: v });
                  void refreshFields(v);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <FieldSelect
              label="Word field"
              value={s.fieldWord}
              fields={fields}
              onChange={(v) => void update({ fieldWord: v })}
            />
            <FieldSelect
              label="Reading field (optional)"
              value={s.fieldReading}
              fields={fields}
              optional
              onChange={(v) => void update({ fieldReading: v })}
            />
            <FieldSelect
              label="Gloss field"
              value={s.fieldGloss}
              fields={fields}
              onChange={(v) => void update({ fieldGloss: v })}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="anki-tag">Tag</Label>
            <Input
              id="anki-tag"
              value={s.tag}
              onChange={(e) => setS({ ...s, tag: e.target.value })}
              onBlur={() => void update({})}
              className="text-[12.5px]"
            />
          </div>

          <p className="text-[11.5px] text-muted-foreground">
            New cards arrive in Anki as soon as you click "Push to Anki" on a vocab item or a
            dictionary detail. Duplicates within the deck are skipped automatically.
          </p>
        </div>
      )}

      {version == null && !error && (
        <div className="rounded-xl border border-dashed border-border bg-card/50 px-5 py-4 text-[13px] text-muted-foreground">
          <p className="font-medium text-foreground">Setup</p>
          <ol className="mt-2 list-decimal pl-5 space-y-1">
            <li>Install <span className="font-medium">Anki desktop</span> if you don't have it.</li>
            <li>
              Add the AnkiConnect add-on (code <span className="font-mono">2055492159</span>):
              {" "}
              <a
                href="https://ankiweb.net/shared/info/2055492159"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 underline decoration-dotted underline-offset-2"
              >
                ankiweb page <ExternalLink className="size-3" />
              </a>
            </li>
            <li>Restart Anki, leave it running, click Connect above.</li>
          </ol>
        </div>
      )}
    </div>
  );
}

function FieldSelect({
  label,
  value,
  fields,
  optional,
  onChange,
}: {
  label: string;
  value: string;
  fields: string[];
  optional?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <Select
        value={value || (optional ? "__none__" : "")}
        onValueChange={(v) => onChange(v === "__none__" ? "" : v)}
      >
        <SelectTrigger>
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          {optional && <SelectItem value="__none__">— skip —</SelectItem>}
          {fields.map((f) => (
            <SelectItem key={f} value={f}>
              {f}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
