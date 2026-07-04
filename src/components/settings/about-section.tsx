import { useEffect, useState } from "react";
import { Languages, Loader2, RefreshCw } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { checkForUpdate, getAppVersion } from "@/lib/updater";
import { promptInstall } from "@/components/updater-nudge";

export function AboutSection() {
  // null = not yet known. Falls back to the build-time version inlined
  // by Vite, so there's never a flash of a wrong number.
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // The updater only exists in the packaged desktop app — hide the
  // control everywhere else (hosted, browser demo).
  const canUpdate = isTauri();

  useEffect(() => {
    void getAppVersion().then(setVersion);
  }, []);

  async function onCheck() {
    setChecking(true);
    try {
      const result = await checkForUpdate();
      if (result.kind === "available") {
        toast("Update available", {
          description: `Tokori ${result.version} is ready to install.`,
          action: {
            label: "Restart & update",
            onClick: () => promptInstall(result.update, result.version),
          },
          duration: Infinity,
        });
      } else if (result.kind === "up-to-date") {
        toast.success("You're up to date", {
          description: `Running the latest Tokori (v${result.currentVersion}).`,
        });
      } else if (result.kind === "error") {
        toast.error("Couldn't check for updates", {
          description: result.message,
        });
      }
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">About</h2>
        <p className="text-[13px] text-muted-foreground">
          A local-first AI workspace for language learners.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-foreground text-background">
          <Languages className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium">Tokori</div>
          <div className="text-[12px] text-muted-foreground">
            v{version ?? __APP_VERSION__} · pre-alpha
          </div>
        </div>
        {canUpdate && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onCheck()}
            disabled={checking}
          >
            {checking ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Check for updates
          </Button>
        )}
      </div>

      <div className="space-y-3 text-[13px] leading-relaxed text-muted-foreground">
        <p>
          Bring your own model — local via Ollama, or cloud via OpenAI / Anthropic
          / OpenRouter. Vocabulary, decks, ingested books, and chat history live
          in a local SQLite database. Nothing leaves the machine unless you opt
          into a cloud provider.
        </p>
        <p>
          Inspired by Refold's progression model and the click-to-define
          reader pattern. Built with Tauri 2, React 19, Tailwind 4, and shadcn/ui.
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
          Open data
        </h3>
        <ul className="space-y-1 text-[13px] text-muted-foreground">
          <li>· CC-CEDICT — Chinese-English dictionary (CC BY-SA 4.0)</li>
          <li>· Intl.Segmenter — built-in word segmentation</li>
        </ul>
      </div>
    </div>
  );
}
