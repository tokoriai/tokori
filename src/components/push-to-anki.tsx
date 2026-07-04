import { useEffect, useState } from "react";
import { Layers, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  ankiAddNote,
  ankiVersion,
  loadAnkiSettings,
  type AnkiSettings,
} from "@/lib/anki";
import { cn } from "@/lib/utils";

// Module-level cache so every PushToAnkiButton instance on a page
// (the chat is dense with them) shares one liveness probe instead of
// hammering AnkiConnect once per token. Re-probed on a 30s TTL — long
// enough to avoid network spam, short enough that toggling Anki on
// during a session shows the buttons within half a minute.
let ankiLivePromise: Promise<boolean> | null = null;
let ankiLiveAt = 0;

async function isAnkiLive(endpoint: string): Promise<boolean> {
  const now = Date.now();
  if (ankiLivePromise && now - ankiLiveAt < 30_000) {
    return ankiLivePromise;
  }
  ankiLiveAt = now;
  ankiLivePromise = ankiVersion(endpoint)
    .then((v) => typeof v === "number" && v > 0)
    .catch(() => false);
  return ankiLivePromise;
}

export function PushToAnkiButton({
  word,
  reading,
  gloss,
  size = "sm",
  variant = "outline",
  className,
}: {
  word: string;
  reading?: string | null;
  gloss?: string | null;
  size?: "sm" | "icon-sm";
  variant?: "outline" | "ghost" | "secondary";
  className?: string;
}) {
  const [settings, setSettings] = useState<AnkiSettings | null>(null);
  const [live, setLive] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [pushed, setPushed] = useState(false);

  useEffect(() => {
    void loadAnkiSettings().then(setSettings);
  }, []);

  // Probe AnkiConnect once we know the endpoint. Hides the button
  // when AnkiConnect isn't reachable so users without Anki running
  // don't see a button that always fails.
  useEffect(() => {
    if (!settings?.enabled || !settings.endpoint) {
      setLive(false);
      return;
    }
    let cancelled = false;
    void isAnkiLive(settings.endpoint).then((ok) => {
      if (!cancelled) setLive(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [settings?.enabled, settings?.endpoint]);

  if (!settings?.enabled) return null;
  // Hide while we don't know yet — flicker is worse than the brief
  // delay before the button appears.
  if (live !== true) return null;

  async function push() {
    if (!settings) return;
    setBusy(true);
    try {
      await ankiAddNote(settings, { word, reading, gloss });
      setPushed(true);
      toast.success(`Pushed ${word} to Anki`, {
        description: `Deck: ${settings.deckName}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Duplicates are fine — surface as info, not error.
      if (/duplicate/i.test(msg)) {
        setPushed(true);
        toast(`${word} is already in your Anki deck`);
      } else {
        toast.error("Anki push failed", { description: msg.slice(0, 200) });
      }
    } finally {
      setBusy(false);
    }
  }

  if (size === "icon-sm") {
    return (
      <Button
        size="icon-sm"
        variant={variant}
        onClick={push}
        disabled={busy || pushed}
        title={pushed ? "Already in Anki" : "Push to Anki"}
        className={className}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Layers className="size-3.5" />}
      </Button>
    );
  }

  return (
    <Button
      size="sm"
      variant={variant}
      onClick={push}
      disabled={busy || pushed}
      className={cn("gap-1.5", className)}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Layers className="size-3.5" />}
      {pushed ? "In Anki" : "Push to Anki"}
    </Button>
  );
}
