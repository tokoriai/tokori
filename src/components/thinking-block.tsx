import { useState } from "react";
import { Brain, ChevronDown, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

const OPEN_TAGS = ["<think>", "<thinking>", "<reasoning>"];
const CLOSE_TAGS = ["</think>", "</thinking>", "</reasoning>"];

export type SplitMessage = {
  thinking: string | null;
  reply: string;
  thinkOpen: boolean;
};

export function splitThinking(text: string): SplitMessage {
  for (let i = 0; i < OPEN_TAGS.length; i++) {
    const open = OPEN_TAGS[i];
    const close = CLOSE_TAGS[i];
    const openIdx = text.indexOf(open);
    if (openIdx === -1) continue;
    const before = text.slice(0, openIdx);
    const afterOpen = text.slice(openIdx + open.length);
    const closeIdx = afterOpen.indexOf(close);
    if (closeIdx === -1) {
      return { thinking: afterOpen, reply: before, thinkOpen: true };
    }
    const thinking = afterOpen.slice(0, closeIdx);
    const after = afterOpen.slice(closeIdx + close.length);
    return {
      thinking,
      reply: (before + after).replace(/^\s+|\s+$/g, ""),
      thinkOpen: false,
    };
  }
  return { thinking: null, reply: text, thinkOpen: false };
}

export function ThinkingPulse() {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-3 py-1 text-[12px] text-muted-foreground">
      <Sparkles className="size-3 animate-pulse text-foreground/60" />
      <span className="animate-pulse">Thinking…</span>
    </div>
  );
}

export function ThinkingDetails({
  thinking,
  defaultOpen = false,
}: {
  thinking: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (!thinking.trim()) return null;
  return (
    <div className="mb-2 rounded-lg border border-border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-muted-foreground hover:text-foreground"
      >
        <Brain className="size-3.5" />
        <span className="flex-1 font-medium">Reasoning</span>
        <ChevronDown
          className={cn(
            "size-3.5 transition-transform",
            open ? "rotate-180" : "rotate-0",
          )}
        />
      </button>
      {open && (
        <pre className="whitespace-pre-wrap border-t border-border px-3 py-2 font-sans text-[12.5px] leading-relaxed text-muted-foreground">
          {thinking}
        </pre>
      )}
    </div>
  );
}
