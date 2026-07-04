import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Mic, MicOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Tokenized } from "@/components/tokenized";
import { listSystemPrompts, listVocab, type ProviderConfig } from "@/lib/db";
import { useLiveVoice } from "@/lib/live-voice";
import { useProviderConfigs } from "@/lib/provider-context";
import { useSession } from "@/lib/session-context";
import { useWorkspace } from "@/lib/workspace-context";
import { languageName } from "@/lib/languages";
import { cn } from "@/lib/utils";

// Default Live model when the user hasn't picked one. The previous GA
// option (`gemini-2.0-flash-live-001`) was unreliable in practice; we
// route everyone to the preview model that actually works.
const FALLBACK_LIVE_MODEL = "gemini-3.1-flash-live-preview";

export function LiveVoiceDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { active: workspace } = useWorkspace();
  const { providers } = useProviderConfigs();
  const { ensureStarted } = useSession();
  const { state, error, turns, liveUser, liveAssistant, start, stop } =
    useLiveVoice();
  const [systemPrompt, setSystemPrompt] = useState<string>("");

  // Pick the first configured Gemini provider — Live mode is Gemini-only.
  const geminiProvider: ProviderConfig | undefined = useMemo(
    () => providers.find((p) => p.kind === "gemini"),
    [providers],
  );

  // Build a vocab-aware system prompt when the dialog opens.
  useEffect(() => {
    if (!open || !workspace) return;
    let cancelled = false;
    Promise.all([listSystemPrompts().catch(() => []), listVocab(workspace.id).catch(() => [])])
      .then(([prompts, vocab]) => {
        if (cancelled) return;
        const persona = prompts.find((p) => p.isDefault) ?? prompts[0];
        const target = languageName(workspace.targetLang);
        const native = languageName(workspace.nativeLang);
        const base =
          (persona?.body ??
            `You are a friendly ${target} voice tutor. The student's native language is ${native}. Speak naturally in ${target}; use ${native} only when the student is clearly stuck. Keep replies short and conversational — this is voice.`)
            .replaceAll("{target}", target)
            .replaceAll("{native}", native);
        const known = vocab
          .filter((v) => v.status === "mastered")
          .slice(0, 60)
          .map((v) => v.word);
        const learning = vocab
          .filter((v) => v.status === "learning" || v.status === "review")
          .slice(0, 30)
          .map((v) => v.word);
        const lines = [base];
        if (known.length || learning.length) {
          lines.push("", "Student vocabulary context:");
          if (known.length) lines.push(`- Mastered: ${known.join(", ")}`);
          if (learning.length) lines.push(`- Learning: ${learning.join(", ")}`);
          lines.push(
            "Use mastered words freely; lean on the learning list when relevant; introduce new vocabulary sparingly.",
          );
        }
        setSystemPrompt(lines.join("\n"));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, workspace]);

  // Stop session if dialog closes.
  useEffect(() => {
    if (!open) stop();
  }, [open, stop]);

  if (!workspace) return null;

  function handleClose() {
    stop();
    onClose();
  }

  const canStart = !!geminiProvider?.apiKey && !!systemPrompt;
  const isActive = state === "listening" || state === "speaking" || state === "connecting";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent
        className="overflow-hidden p-0 sm:max-w-2xl"
        showCloseButton={false}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Live voice · {languageName(workspace.targetLang)}
            </p>
            <h2 className="font-serif text-lg tracking-tight">
              {state === "idle" && "Tap to start"}
              {state === "connecting" && "Connecting…"}
              {state === "listening" && "Listening — go ahead"}
              {state === "speaking" && "Tutor is speaking"}
              {state === "error" && "Something went wrong"}
            </h2>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={handleClose}>
            <X className="size-4" />
          </Button>
        </div>

        {!geminiProvider ? (
          <NoGeminiYet onClose={handleClose} />
        ) : (
          <>
            <div className="flex flex-col items-center gap-5 px-6 py-7">
              <Orb state={state} />

              {state === "error" && error && (
                <div className="flex max-w-md items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span className="break-words">{error}</span>
                </div>
              )}

              <div className="flex gap-3">
                {!isActive ? (
                  <Button
                    size="lg"
                    onClick={() => {
                      void ensureStarted("speaking");
                      start({
                        apiKey: geminiProvider.apiKey ?? "",
                        model: pickLiveModel(geminiProvider.model),
                        systemPrompt,
                      });
                    }}
                    disabled={!canStart}
                    className="rounded-full px-6"
                  >
                    <Mic className="size-4" />
                    {state === "error" ? "Try again" : "Start session"}
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    variant="destructive"
                    onClick={() => stop()}
                    className="rounded-full px-6"
                  >
                    <MicOff className="size-4" />
                    End session
                  </Button>
                )}
              </div>

              <p className="text-center text-[11px] text-muted-foreground">
                Live model: <span className="font-mono">{pickLiveModel(geminiProvider.model)}</span>
                {geminiProvider.model !== pickLiveModel(geminiProvider.model) && (
                  <>
                    {" — "}your provider is set to{" "}
                    <span className="font-mono">{geminiProvider.model}</span>; live needs a{" "}
                    <span className="font-mono">*-live-*</span> model
                  </>
                )}
              </p>
            </div>

            <div className="max-h-[40vh] overflow-y-auto border-t border-border bg-muted/30 px-5 py-4">
              <Transcript
                turns={turns}
                liveUser={liveUser}
                liveAssistant={liveAssistant}
                workspaceTargetLang={workspace.targetLang}
              />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Orb({ state }: { state: string }) {
  return (
    <div
      className={cn(
        "flex size-32 items-center justify-center rounded-full transition-all duration-300",
        state === "listening" && "bg-emerald-500/15 ring-4 ring-emerald-500/40 animate-pulse",
        state === "speaking" && "bg-violet-500/15 ring-4 ring-violet-500/40",
        state === "connecting" && "bg-amber-500/15 ring-4 ring-amber-500/40 animate-pulse",
        state === "idle" && "bg-muted ring-2 ring-border",
        state === "error" && "bg-destructive/10 ring-2 ring-destructive/40",
      )}
    >
      <div
        className={cn(
          "size-16 rounded-full transition-all duration-500",
          state === "listening" && "bg-emerald-500/80 scale-90",
          state === "speaking" && "bg-violet-500/80 animate-pulse",
          state === "connecting" && "bg-amber-500/80",
          state === "idle" && "bg-foreground/15",
          state === "error" && "bg-destructive/40",
        )}
      />
    </div>
  );
}

function Transcript({
  turns,
  liveUser,
  liveAssistant,
  workspaceTargetLang,
}: {
  turns: { role: "user" | "assistant"; content: string }[];
  liveUser: string;
  liveAssistant: string;
  workspaceTargetLang: import("@/lib/languages").LanguageCode;
}) {
  if (turns.length === 0 && !liveUser && !liveAssistant) {
    return (
      <p className="text-center text-[12.5px] text-muted-foreground">
        Live transcript will appear here.
      </p>
    );
  }
  return (
    <div className="space-y-2 text-[13.5px]">
      {turns.map((t, i) => (
        <Bubble key={i} role={t.role} content={t.content} lang={workspaceTargetLang} />
      ))}
      {liveUser && (
        <Bubble role="user" content={liveUser} lang={workspaceTargetLang} live />
      )}
      {liveAssistant && (
        <Bubble role="assistant" content={liveAssistant} lang={workspaceTargetLang} live />
      )}
    </div>
  );
}

function Bubble({
  role,
  content,
  lang,
  live = false,
}: {
  role: "user" | "assistant";
  content: string;
  lang: import("@/lib/languages").LanguageCode;
  live?: boolean;
}) {
  if (role === "user") {
    return (
      <div className={cn("self-end", live && "opacity-75")}>
        <div className="ml-auto max-w-[80%] rounded-xl bg-foreground/90 px-3 py-1.5 text-[13.5px] text-background w-fit">
          {content}
        </div>
      </div>
    );
  }
  return (
    <div className={cn(live && "opacity-75")}>
      <div className="max-w-[88%] rounded-xl bg-card px-3 py-1.5 ring-1 ring-border w-fit">
        <Tokenized text={content} lang={lang} showRuby={false} />
      </div>
    </div>
  );
}

function NoGeminiYet({ onClose }: { onClose: () => void }) {
  return (
    <div className="space-y-3 px-6 py-7 text-center">
      <Mic className="mx-auto size-7 text-muted-foreground" />
      <h3 className="font-serif text-xl tracking-tight">Live mode needs Gemini.</h3>
      <p className="mx-auto max-w-md text-[13.5px] text-muted-foreground">
        Live voice is built on Google's Gemini Live API. Add a Gemini provider in
        Settings → Providers (paste your AI Studio key) and pick a{" "}
        <span className="font-mono">gemini-*-live-*</span> model. Then come back here.
      </p>
      <div className="flex justify-center pt-2">
        <Button onClick={onClose}>Got it</Button>
      </div>
    </div>
  );
}

function pickLiveModel(model: string): string {
  if (model.includes("live")) return model;
  // Sensible default if their text model isn't live-capable.
  return FALLBACK_LIVE_MODEL;
}
