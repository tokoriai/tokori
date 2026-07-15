/**
 * Shared "ask AI about this card" side drawer used by every study plugin
 * that wants a tutor-on-tap panel. Lifted out of vocab-recall (where it
 * was first written) so sentence-mining can mount the same surface
 * without copy-pasting ~250 lines of chat scaffolding.
 *
 * Contract:
 *   • One `card: VocabEntry` per session — when the card id changes
 *     the conversation resets so earlier turns don't pollute the
 *     context for the next word.
 *   • `targetLang` / `nativeLang` are the workspace's languages, used
 *     to colour the system prompt and choose tokenizer rules.
 *   • Streaming uses the existing `useProviderConfigs().sendChat`
 *     path so model selection / API keys come straight from Settings.
 *   • Display toggles (pinyin + translation reveal) read/write the
 *     global `useDisplay()` context, so flipping them inside the
 *     drawer also affects the main chat / reader.
 *   • `<think>` tags are stripped from assistant replies via the
 *     same `splitThinking` helper the chat view uses, so reasoning
 *     models don't leak their chain-of-thought into bubbles.
 */

import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Languages,
  Loader2,
  Maximize2,
  Minimize2,
  Plus,
  Send,
  Sparkles,
  Type,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChatMarkdown } from "@/components/chat-markdown";
import { splitThinking } from "@/components/thinking-block";
import { useDisplay } from "@/lib/display-context";
import { profileFor, type LanguageCode } from "@/lib/languages";
import { useProfile } from "@/lib/profile-context";
import {
  useProviderConfigs,
  type ChatMessage,
} from "@/lib/provider-context";
import { cn } from "@/lib/utils";
import type { VocabEntry } from "@/lib/study/api";

/** Target-language greeting for the empty-state header. Falls back to
 *  English "Hello" for languages we haven't mapped yet — better than
 *  showing the user a script they can't read. Native script is
 *  intentional: the whole point of the drawer is target-language
 *  immersion, so even the welcome line nudges the user into the
 *  language. */
// Plain `Record<string, …>` (rather than `Partial<Record<LanguageCode>>`)
// so adding new codes here doesn't require touching the
// LanguageCode union — these are display strings, not type-checked
// keys. Codes not in the map fall back to "Hello".
const HELLO_BY_LANG: Record<string, string> = {
  en: "Hello",
  es: "Hola",
  fr: "Bonjour",
  de: "Hallo",
  it: "Ciao",
  pt: "Olá",
  ja: "こんにちは",
  ko: "안녕하세요",
  zh: "你好",
  ru: "Привет",
  nl: "Hallo",
};
function helloIn(lang: string): string {
  return HELLO_BY_LANG[lang] ?? "Hello";
}

type AiChatTurn = { role: "user" | "assistant"; content: string };

export function StudyAiDrawer({
  open,
  card,
  targetLang,
  nativeLang,
  /** Optional extra context lines mixed into the system prompt — e.g.
   *  the cloze sentence the user just answered, so the tutor can
   *  reason about "the sentence I was just shown". Keeps the drawer
   *  generic across plugins. */
  extraSystemContext,
  onClose,
}: {
  open: boolean;
  card: VocabEntry;
  targetLang: string;
  nativeLang: string;
  extraSystemContext?: string;
  onClose: () => void;
}) {
  const { active: provider, providers, setActiveId, sendChat } = useProviderConfigs();
  const display = useDisplay();
  const { profile } = useProfile();
  const [turns, setTurns] = useState<AiChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Reset on card change — earlier questions become confusing context
  // for a new card. The drawer stays mounted across cards for a
  // smoother feel; only the conversation gets cleared.
  const lastCardIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!open) return;
    if (lastCardIdRef.current !== card.id) {
      lastCardIdRef.current = card.id;
      setTurns([]);
      setStreamingText("");
      setInput("");
    }
  }, [open, card.id]);

  // Focus the composer on open so the "a" shortcut flows straight into
  // typing the question — no click in between. After-paint via rAF:
  // the drawer mounts in the same tick as the keydown that opened it
  // (the plugin preventDefaults that key, but focus before mount
  // settles is unreliable on WebKit). The study surface's shortcut
  // handlers already ignore keys typed into a textarea.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Auto-scroll on new tokens / turns.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [turns, streamingText]);

  function buildSystemPrompt(): string {
    const lines = [
      `You are a language tutor helping a learner study the following card.`,
      `Target language: ${targetLang}.`,
      `Learner's native language: ${nativeLang}.`,
      `Card word: ${card.word}`,
    ];
    if (card.reading) lines.push(`Reading: ${card.reading}`);
    if (card.gloss) lines.push(`Gloss / translation: ${card.gloss}`);
    if (card.cardNotes) lines.push(`User's existing notes: ${card.cardNotes}`);
    if (extraSystemContext) lines.push("", extraSystemContext);
    lines.push(
      "",
      "Reply concisely. Reference the card's word directly. If the user asks for examples, give 2-3 short ones with translations.",
    );
    return lines.join("\n");
  }

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || streaming) return;
    if (!provider) return;
    const nextTurns: AiChatTurn[] = [...turns, { role: "user", content }];
    setTurns(nextTurns);
    setInput("");
    setStreaming(true);
    setStreamingText("");
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt() },
      ...nextTurns.map((t) => ({ role: t.role, content: t.content })),
    ];
    try {
      const reply = await sendChat({
        messages,
        onToken: (delta) => setStreamingText((prev) => prev + delta),
      });
      setTurns((prev) => [...prev, { role: "assistant", content: (reply || "").trim() }]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTurns((prev) => [
        ...prev,
        { role: "assistant", content: `_Error: ${msg.slice(0, 200)}_` },
      ]);
    } finally {
      setStreaming(false);
      setStreamingText("");
    }
  }

  if (!open) return null;
  const widthClass = fullscreen ? "w-full" : "w-full max-w-md xl:max-w-lg";

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-background/40 backdrop-blur-[1px] animate-in fade-in duration-300"
        onClick={onClose}
      />
      <div
        className={cn(
          "fixed right-0 top-0 bottom-0 z-50 flex flex-col border-l border-border bg-card shadow-2xl transition-[max-width] duration-300 ease-out animate-in slide-in-from-right fade-in duration-300",
          widthClass,
        )}
      >
        <div className="flex items-center gap-1.5 border-b border-border px-5 py-3">
          <Sparkles className="size-4 text-foreground/70" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Ask about
            </p>
            <p className="truncate font-serif text-lg leading-tight">
              {card.word}
              {card.reading && (
                <span className="ml-2 text-[12px] text-muted-foreground font-sans">
                  {card.reading}
                </span>
              )}
            </p>
          </div>
          {/* Model / provider picker — same affordance the conversation
              chat exposes in its top bar, so the user doesn't have to
              jump to Settings to switch which model answers the
              tutor. Compact dropdown so it fits between the title and
              the display toggles; the active row is checkmarked. */}
          {providers.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="hidden max-w-[160px] items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11.5px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground sm:inline-flex"
                  title="Switch model / provider"
                >
                  <span className="truncate">
                    {provider ? provider.model || provider.label : "Pick model"}
                  </span>
                  <ChevronDown className="size-3 shrink-0 opacity-60" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[220px]">
                {providers.map((p) => {
                  const active = provider?.id === p.id;
                  return (
                    <DropdownMenuItem
                      key={p.id}
                      onClick={() => void setActiveId(p.id)}
                      className="flex items-start gap-2"
                    >
                      <Check
                        className={cn(
                          "mt-0.5 size-3.5 shrink-0",
                          active ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] font-medium">
                          {p.model || p.label}
                        </div>
                        <div className="truncate text-[10.5px] text-muted-foreground">
                          {p.label} · {p.kind}
                        </div>
                      </div>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {profileFor(targetLang as LanguageCode).hasReadings && (
            <HeaderToggle
              active={display.showPinyin}
              onClick={display.togglePinyin}
              title={display.showPinyin ? "Hide pinyin / readings" : "Show pinyin / readings"}
            >
              <Type className="size-4" />
            </HeaderToggle>
          )}
          <HeaderToggle
            active={display.showTranslations}
            onClick={display.toggleTranslations}
            title={
              display.showTranslations
                ? "Hide ((translations))"
                : "Reveal ((translations))"
            }
          >
            <Languages className="size-4" />
          </HeaderToggle>
          <HeaderButton
            onClick={() => {
              setTurns([]);
              setStreamingText("");
              setInput("");
            }}
            disabled={streaming || (turns.length === 0 && !streamingText)}
            title="New chat"
          >
            <Plus className="size-4" />
          </HeaderButton>
          <HeaderButton
            onClick={() => setFullscreen((f) => !f)}
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </HeaderButton>
          <HeaderButton onClick={onClose} title="Close chat">
            <X className="size-4" />
          </HeaderButton>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-6">
          {!provider ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[13px] text-muted-foreground">
              <Sparkles className="size-5 opacity-40" />
              <p>Configure a provider in Settings → Providers to chat about cards.</p>
            </div>
          ) : turns.length === 0 && !streamingText ? (
            <AiEmptyState
              targetLang={targetLang}
              displayName={profile.name?.trim() ?? ""}
              onPick={(p) => void send(p)}
            />
          ) : (
            <div className="space-y-4">
              {turns.map((t, i) => (
                <ChatBubble key={i} turn={t} targetLang={targetLang as LanguageCode} />
              ))}
              {streaming && (
                <ChatBubble
                  turn={{ role: "assistant", content: streamingText || "…" }}
                  targetLang={targetLang as LanguageCode}
                  streaming
                />
              )}
            </div>
          )}
        </div>

        {provider && (
          // Composer styled to match the main conversation surface
          // (`chat-view.tsx`): a single rounded-2xl card with focus
          // ring, textarea on top, and a rounded-full ArrowUp send
          // button bottom-right. Same affordance the user already
          // knows from the chat tab so the AI drawer doesn't feel
          // like a different app.
          <form
            className="border-t border-border px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <div
              className={cn(
                "flex flex-col rounded-2xl border border-border bg-card shadow-sm transition-shadow",
                "focus-within:border-foreground/20 focus-within:shadow-md",
                streaming &&
                  "ring-2 ring-foreground/15 animate-pulse [animation-duration:1.6s]",
              )}
            >
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={1}
                placeholder="Ask about this card…"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                className="resize-none bg-transparent px-4 pt-3.5 pb-1 text-[13.5px] leading-relaxed outline-none placeholder:text-muted-foreground"
              />
              <div className="flex items-center justify-end gap-1.5 px-2.5 pb-2 pt-1.5">
                <Button
                  type="submit"
                  size="icon-sm"
                  disabled={streaming || !input.trim()}
                  className="rounded-full"
                  aria-label="Send"
                >
                  {streaming ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ArrowUp className="size-4" />
                  )}
                </Button>
              </div>
            </div>
          </form>
        )}
      </div>
    </>
  );
}

// The Mnemonic prompt explicitly asks the model to break the word
// down into parts before suggesting memory aids — for CJK that means
// per-character radicals + components, for European languages it
// means morphemes / roots / etymology. The breakdown anchors the
// mnemonic in something the user can actually map to the form, so
// the suggestions don't read as random word association. The
// "(where relevant)" hedge lets the model skip the etymology step on
// languages where it adds no signal (e.g. opaque borrowings).
const QUICK_PROMPTS: { icon: string; text: string }[] = [
  { icon: "✨", text: "Explain the meaning and any nuance." },
  { icon: "📝", text: "Give 3 short example sentences (with translation)." },
  {
    icon: "🧠",
    text:
      "Suggest 2-3 mnemonics for remembering this. First break the word down into its parts (radicals + components for hanzi/kanji, morphemes / roots / etymology for other languages, where relevant) and explain how each part contributes to the meaning. Then anchor each mnemonic in that breakdown so the memory aid maps onto the actual form.",
  },
  { icon: "🔀", text: "How is this commonly confused with similar words?" },
];

function AiEmptyState({
  targetLang,
  displayName,
  onPick,
}: {
  targetLang: string;
  /** Profile name. Empty string is fine — we drop it from the
   *  greeting in that case so the line still reads naturally. */
  displayName: string;
  onPick: (prompt: string) => void;
}) {
  const isChinese = targetLang === "zh";
  // Greeting is in the TARGET language with the user's display
  // name appended — same intent as a tutor saying hi. If the profile
  // doesn't have a name yet (fresh install) we drop the comma so the
  // line doesn't read "Hello, !". The supportive sub-line stays in
  // English because it's instructional copy, not an immersive cue.
  const hello = helloIn(targetLang);
  const greeting = displayName ? `${hello}, ${displayName}` : `${hello}!`;
  return (
    <div className="flex h-full flex-col items-center justify-center px-2 text-center">
      <div className="animate-in fade-in slide-in-from-bottom-3 duration-500">
        {isChinese ? (
          <img
            src="/panda-mascot.webp"
            alt=""
            aria-hidden
            draggable={false}
            className="mx-auto mb-3 h-24 w-auto select-none"
          />
        ) : (
          <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-foreground/5 text-2xl">
            <Sparkles className="size-6 text-foreground/60" />
          </div>
        )}
        <h2 className="font-serif text-2xl tracking-tight">{greeting}</h2>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          How can I help with your study?
        </p>
      </div>
      <div className="mt-6 flex w-full flex-col gap-2">
        {QUICK_PROMPTS.map((p, i) => (
          <button
            key={p.text}
            type="button"
            onClick={() => onPick(p.text)}
            style={{ animationDelay: `${180 + i * 80}ms`, animationFillMode: "both" }}
            className={cn(
              "group flex items-center gap-2.5 rounded-2xl border border-border bg-card px-4 py-2.5 text-left text-[13px] shadow-xs transition-all",
              "animate-in fade-in slide-in-from-bottom-2 duration-500",
              "hover:scale-[1.01] hover:border-foreground/30 hover:bg-accent/40",
            )}
          >
            <span className="text-base transition-transform group-hover:scale-110">
              {p.icon}
            </span>
            <span className="line-clamp-1">{p.text}</span>
            <Send className="ml-auto size-3 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Memoised chat bubble. The custom equality is what stops every
 * keystroke in the composer from re-rendering every bubble in the
 * scroll area — without it `<Tokenized>` (used by `ChatMarkdown`)
 * re-runs its async word-segmenter on each keystroke, which in
 * practice cancels its own work mid-flight and the click-to-define
 * underlines never settle (the user perceives this as "the highlight
 * is missing"). Keeping the segmentation result stable also kills
 * the layout jitter the user sees while typing — bubbles no longer
 * re-flow because their DOM hasn't actually changed.
 *
 * Same pattern the main conversation surface uses for its
 * `MessageBubble` — see `chat-view.tsx` (search `memo(MessageBubbleInner`).
 */
const ChatBubble = memo(
  ChatBubbleInner,
  (prev, next) =>
    prev.turn.content === next.turn.content &&
    prev.turn.role === next.turn.role &&
    prev.targetLang === next.targetLang &&
    Boolean(prev.streaming) === Boolean(next.streaming),
);

function ChatBubbleInner({
  turn,
  targetLang,
  streaming,
}: {
  turn: AiChatTurn;
  targetLang: LanguageCode;
  streaming?: boolean;
}) {
  const isUser = turn.role === "user";
  // Stabilise `cleaned` so the string passed to `<Tokenized>` keeps
  // the same reference identity across renders — same trick the
  // chat-view's MessageBubble uses to stop dotted underlines from
  // flickering away mid-segmentation.
  const cleaned = useMemo(
    () => (isUser ? turn.content : splitThinking(turn.content).reply ?? turn.content),
    [isUser, turn.content],
  );
  if (isUser) {
    // User bubble: same chip styling as the conversation surface
    // (`chat-view.tsx` MessageBubbleInner) so the two surfaces feel
    // consistent — soft tinted card with a flattened top-right
    // corner, plain whitespace-pre-wrap text inside.
    return (
      <div className="flex justify-end">
        <div
          className={cn(
            "max-w-[85%] whitespace-pre-wrap rounded-[18px] rounded-tr-sm border border-foreground/10 bg-foreground/[0.04] px-4 py-2.5 text-[13.5px] leading-relaxed shadow-sm",
            "dark:border-white/10 dark:bg-white/[0.06]",
          )}
        >
          {cleaned}
        </div>
      </div>
    );
  }
  // Assistant: no enclosing tinted bubble — render the markdown
  // directly so the colored Tokenized underlines (the "highlight")
  // are clearly visible against the panel background, exactly the
  // way conversation-chat assistant turns render.
  return (
    <div className="text-[13.5px] leading-relaxed text-foreground/95">
      <ChatMarkdown text={cleaned} lang={targetLang} streaming={streaming} />
      {streaming && (
        <span className="ml-0.5 inline-block h-3.5 w-1 animate-pulse rounded-full bg-emerald-500/80 align-text-bottom" />
      )}
    </div>
  );
}

function HeaderToggle({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: ComponentProps<"button">["children"];
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={cn(
        "flex size-8 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function HeaderButton({
  onClick,
  title,
  disabled,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: ComponentProps<"button">["children"];
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      title={title}
      className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
