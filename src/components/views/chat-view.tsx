import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircle,
  AlertTriangle,
  ArrowUp,
  AudioWaveform,
  BookOpenText,
  ChevronDown,
  Check,
  Coins,
  Eye,
  EyeOff,
  FileText,
  GraduationCap,
  ImageIcon,
  Loader2,
  Menu,
  MessagesSquare,
  Mic,
  Paperclip,
  Plus,
  Radio,
  Sparkles,
  Type,
  Wand2,
  Wrench,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { ChatMarkdown } from "@/components/chat-markdown";
import { StreamingText } from "@/components/streaming-text";
import { InlineLiveMode } from "@/components/inline-live-mode";
import { SpeakButton } from "@/components/speak-button";
import { VocabImportDialog } from "@/components/vocab-import-dialog";
import { CloudSignInDialog } from "@/components/cloud-signin-dialog";
import { StoreDialog } from "@/components/store-dialog";
import { useCloud } from "@/lib/cloud-context";
import {
  findWhisperProvider,
  isBrowserSTTAvailable,
  startRecording,
  transcribeWhisper,
} from "@/lib/stt";
import {
  ChatActionsProvider,
  useChatActions,
  type ChatActions,
} from "@/lib/chat-actions-context";
import {
  splitThinking,
  ThinkingDetails,
  ThinkingPulse,
} from "@/components/thinking-block";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { useBackgroundChat, useStreamPartial } from "@/lib/background-chat-context";
import { useChatList } from "@/lib/chat-list-context";
import { useDisplay } from "@/lib/display-context";
import { useProfile } from "@/lib/profile-context";
import {
  addMessage,
  listDueVocab,
  listMessages,
  listSystemPrompts,
  listVocab,
  renameChat,
  touchChat,
  updateMessageContent,
  type Chat,
  type ProviderConfig,
  type StoredMessage,
  type SystemPrompt,
  type VocabEntry,
} from "@/lib/db";
import { formatHitsForPrompt, searchKnowledge } from "@/lib/knowledge";
import { getWorkspaceFocus } from "@/lib/focus";
import { plainTextOf } from "@/lib/plain-text";
import {
  appendToolResults,
  enforceTranslationBlur,
  executeToolCall,
  parseToolCalls,
  parseToolResults,
  pendingToolLabel,
  sanitizeStreamingReply,
  stripToolBlocks,
  summarizeToolCalls,
  TOOL_SYSTEM_INSTRUCTIONS,
  type ToolCall,
  type ToolResult,
} from "@/lib/tools";
import { useWorkspace } from "@/lib/workspace-context";
import { useProviderConfigs } from "@/lib/provider-context";
import { useSession } from "@/lib/session-context";
import type { TabId } from "@/components/shell/shell";
import { requestSettingsIntent } from "@/lib/settings-intent";
import {
  bcp47,
  languageName,
  type LanguageCode,
} from "@/lib/languages";
import { cn } from "@/lib/utils";

type StarterCard = {
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  prompts?: Record<LanguageCode, string[]>;
  voice?: boolean;
};

type AttachmentKind = "text" | "pdf" | "image";

type Attachment = {
  id: string;
  name: string;
  kind: AttachmentKind;
  /** Plain-text content for text/pdf attachments. */
  body?: string;
  /** Base64 data URL for images (preview only). */
  dataUrl?: string;
};

const FALLBACK_SYSTEM = (target: string, native: string) =>
  `You are a friendly ${target} tutor. The student's native language is ${native}. ` +
  `Mirror the language the student writes in: when they write in ${target}, reply in ${target} (immersion); ` +
  `when they write in ${native} — or ask a question or for help — answer and explain in ${native} so they clearly understand. ` +
  `Give grammar, usage, and meaning explanations in ${native}, but keep example sentences and the ${target} words or phrases you're teaching in ${target}. ` +
  `Keep replies concise and use vocabulary appropriate for a learner.`;

const STARTER_CARDS: StarterCard[] = [
  {
    id: "grammar",
    icon: GraduationCap,
    title: "Explain a grammar point",
    description: "tricky construction or particle",
    prompts: {
      zh: ["解释'了'的用法", "解释'把'字句", "什么时候用'是…的'结构？"],
      ja: ["「は」と「が」の違いを説明してください", "敬語の基本を教えてください"],
      ko: ["'은/는'과 '이/가'의 차이를 설명해 주세요", "존댓말의 기본을 알려 주세요"],
      es: ["Explícame la diferencia entre 'ser' y 'estar'", "¿Cuándo uso el subjuntivo?"],
      fr: ["Explique-moi la différence entre 'tu' et 'vous'", "Quand utiliser le subjonctif ?"],
      de: ["Erkläre den Unterschied zwischen 'der', 'die', 'das'", "Wann benutze ich den Konjunktiv?"],
      it: ["Spiegami la differenza tra 'essere' e 'stare'", "Quando si usa il congiuntivo?"],
      pt: ["Explique a diferença entre 'ser' e 'estar'", "Quando usar o subjuntivo?"],
      en: ["Explain a tricky grammar point", "When do I use the subjunctive?"],
    },
  },
  {
    id: "reading",
    icon: BookOpenText,
    title: "Generate a passage at my level",
    description: "short story or dialogue with my vocabulary",
    prompts: {
      zh: ["写一个简单的中文小故事", "用我的词汇写一个一段对话"],
      ja: ["簡単な日本語で短い物語を書いてください", "私の語彙で短い対話を書いてください"],
      ko: ["쉬운 한국어로 짧은 이야기를 써 주세요", "제 어휘로 짧은 대화를 써 주세요"],
      es: ["Escríbeme una historia corta en español sencillo", "Un diálogo de café con mi vocabulario"],
      fr: ["Écris-moi une courte histoire en français simple", "Un dialogue au café avec mon vocabulaire"],
      de: ["Schreib eine kurze Geschichte auf einfachem Deutsch", "Ein Café-Dialog mit meinem Wortschatz"],
      it: ["Scrivi una storia breve in italiano semplice", "Un dialogo al bar con il mio vocabolario"],
      pt: ["Escreva uma história curta em português simples", "Um diálogo no café com meu vocabulário"],
      en: ["Write me a short reading at my level", "A coffee-shop dialogue with my vocabulary"],
    },
  },
  {
    id: "voice",
    icon: Mic,
    title: "Practice speaking out loud",
    description: "live voice mode",
    voice: true,
  },
  {
    id: "drill",
    icon: MessagesSquare,
    title: "Drill — five practice sentences",
    description: "quick reps right now",
    prompts: {
      zh: ["给我五个练习句子", "给我五个常用表达"],
      ja: ["5つの練習文をください", "5つの使えるフレーズをください"],
      ko: ["연습용 문장 5개 주세요", "자주 쓰는 표현 5개 알려 주세요"],
      es: ["Dame 5 frases para practicar", "5 expresiones útiles del día a día"],
      fr: ["Donne-moi 5 phrases pour pratiquer", "5 expressions utiles du quotidien"],
      de: ["Gib mir 5 Sätze zum Üben", "5 nützliche Alltagsausdrücke"],
      it: ["Dammi 5 frasi per esercitarmi", "5 espressioni utili di tutti i giorni"],
      pt: ["Me dê 5 frases para praticar", "5 expressões úteis do dia a dia"],
      en: ["Give me 5 practice sentences", "5 useful everyday expressions"],
    },
  },
];

function pickPrompt(card: StarterCard, lang: LanguageCode): string {
  const list = card.prompts?.[lang] ?? card.prompts?.en ?? [];
  if (list.length === 0) return "";
  return list[Math.floor(Math.random() * list.length)];
}

function modelDisplayName(p: ProviderConfig | null): string {
  if (!p) return "no model";
  if (p.kind === "tokori-cloud") {
    return p.model === "advanced" ? "Cloud: Smart" : "Cloud: Fast";
  }
  return p.model || p.label || p.kind;
}

// Accept-list for the file picker. Linux/GTK's WebKitGTK file dialog
// parses mixed extensions + MIME types badly — combining `.pdf` with
// `image/*` made the picker default to a folders-only view on some
// distros. Sticking to extensions is what every platform handles
// reliably.
const ACCEPT_TYPES =
  ".txt,.md,.markdown,.csv,.pdf,.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg";
const IMAGE_RX = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const TEXT_RX = /\.(txt|md|markdown|csv)$/i;

const ATT_MARKER_PREFIX = "{{POLYGLOT_ATT:";
const ATT_MARKER_RX = /\n*\{\{POLYGLOT_ATT:(\[.*?\])\}\}\s*$/;

type AttachmentMeta = { name: string; kind: AttachmentKind };

function parseUserContent(content: string): {
  text: string;
  attachments: AttachmentMeta[];
} {
  const m = content.match(ATT_MARKER_RX);
  if (!m) return { text: content, attachments: [] };
  try {
    const meta = JSON.parse(m[1]) as AttachmentMeta[];
    return { text: content.replace(ATT_MARKER_RX, ""), attachments: meta };
  } catch {
    return { text: content, attachments: [] };
  }
}

export function ChatView({
  onToggleSidebar,
  onNavigate,
}: {
  onToggleSidebar?: () => void;
  /** Tab-switch callback wired from the shell. Used by the no-provider /
   *  no-model indicators to jump straight into Settings → Providers. */
  onNavigate?: (tab: TabId) => void;
}) {
  const { active: workspace } = useWorkspace();
  const { active: provider, providers, setActiveId, saveProvider, sendChat } =
    useProviderConfigs();
  const cloud = useCloud();
  // CTA dialogs surfaced from the no-provider indicators ("Sign in & buy
  // tokens"). We keep their state here so all three indicators (header
  // popover, welcome heading, composer) share one source of truth and one
  // copy of each dialog. The CTA picks the right dialog based on auth
  // state — already signed in jumps straight to the store.
  const [showSignIn, setShowSignIn] = useState(false);
  const [showStore, setShowStore] = useState(false);
  const cloudCTA = () => {
    if (cloud.account) setShowStore(true);
    else setShowSignIn(true);
  };
  // True when the active provider is the synthesised Tokori Cloud
  // row (kind === "tokori-cloud"). The composer and the
  // no-provider indicators flip into "buy tokens" mode when this is
  // true and the balance has dried up. The previous gate compared
  // against the old "Cloud (Tokori)" label, which no longer exists
  // now that the cloud is exposed through the synthesised provider
  // instead of a regular openai-kind DB row.
  const isCloud = provider?.kind === "tokori-cloud";
  // Refresh the token balance whenever Tokori becomes active so the
  // gate below decides on a fresh number, not whatever was cached the
  // last time the StoreDialog opened.
  useEffect(() => {
    if (isCloud && cloud.account) void cloud.refreshBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCloud, cloud.account?.token]);
  // Block send when Tokori is active AND we know the balance is 0. We
  // *don't* block when balance is null (haven't fetched yet) — the
  // server's 402 will surface as an error and the next refresh fixes
  // the cached value. Optimistic on first send, strict afterwards.
  const outOfTokens =
    isCloud && cloud.balance != null && cloud.balance.tokenBalance <= 0;
  // Raw-mode toggle — when on, the next send strips the vocab list,
  // RAG hits, due-vocab, and study-focus blocks from the system
  // prompt. Sticky across messages until the user flips it off (so a
  // back-and-forth about an attached PDF stays raw). Persisted to
  // localStorage for the same reason.
  const [rawMode, setRawMode] = useState<boolean>(() =>
    typeof window !== "undefined"
      ? window.localStorage.getItem("chat.rawMode") === "1"
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("chat.rawMode", rawMode ? "1" : "0");
  }, [rawMode]);
  const {
    chats,
    activeChatId,
    setActiveChatId,
    refresh: refreshChats,
    newChat: createNewChat,
  } = useChatList();
  // Chat only *bumps* the active session's word count when one is
  // already running (e.g. the user manually started a Writing session
  // via the sidebar chip). It never auto-starts a session — typing in
  // chat shouldn't silently start a study timer (`bump` no-ops without
  // a session; see session-context).
  const { bump } = useSession();
  const { showPinyin, togglePinyin, showTranslations, toggleTranslations } =
    useDisplay();
  const { profile } = useProfile();
  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  // Input lives inside <Composer> now (see the comment on Composer below).
  // Keeping it here would re-render the message list on every keystroke.
  // Streaming text is owned by `BackgroundChatProvider` so a generation
  // continues when the user navigates away mid-token. We read it back per
  // chat below.
  const bgChat = useBackgroundChat();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const [csvImportText, setCsvImportText] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Resolve which chat to load: explicit activeChatId → first existing → create new.
  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    (async () => {
      let target: Chat | null = null;
      if (activeChatId != null) {
        target = chats.find((c) => c.id === activeChatId) ?? null;
      }
      if (!target) {
        target = chats[0] ?? null;
        if (target && target.id !== activeChatId) setActiveChatId(target.id);
      }
      if (!target) {
        target = await createNewChat();
      }
      if (cancelled) return;
      setChat(target);
      const msgs = await listMessages(target.id);
      if (!cancelled) {
        setMessages(msgs);
        setError(null);
      }
    })().catch((err) => {
      console.error("load chat", err);
      if (!cancelled) setError(String(err));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id, activeChatId, chats.length]);

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    const next: Attachment[] = [];
    for (const f of Array.from(files)) {
      if (TEXT_RX.test(f.name)) {
        const body = await f.text();
        next.push({
          id: crypto.randomUUID(),
          name: f.name,
          kind: "text",
          body: body.length > 64_000 ? body.slice(0, 64_000) + "\n…(truncated)" : body,
        });
      } else if (/\.pdf$/i.test(f.name)) {
        try {
          // pdfjs is ~400 kB minified — load it on first PDF attach
          // instead of shipping it with the chat view.
          const { extractPdfText } = await import("@/lib/pdf-extract");
          const body = await extractPdfText(f);
          next.push({
            id: crypto.randomUUID(),
            name: f.name,
            kind: "pdf",
            body: body.length > 64_000 ? body.slice(0, 64_000) + "\n…(truncated)" : body,
          });
        } catch (err) {
          // Surface the failure as a toast so the user actually
          // notices — pdfjs errors in WebKitGTK aren't cosmetic.
          // The inline `error` slot below the composer is easy to
          // miss when the user is mid-attach.
          const msg = err instanceof Error ? err.message : String(err);
          toast.error(`Couldn't read ${f.name}`, {
            description: msg.slice(0, 240),
          });
          setError(`Couldn't read ${f.name}: ${msg}`);
        }
      } else if (IMAGE_RX.test(f.name) || f.type.startsWith("image/")) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as string);
          r.onerror = () => reject(r.error);
          r.readAsDataURL(f);
        });
        next.push({ id: crypto.randomUUID(), name: f.name, kind: "image", dataUrl });
      }
    }
    if (next.length) setAttachments((prev) => [...prev, ...next]);
  }

  async function send(textOverride?: string) {
    const text = (textOverride ?? "").trim();
    if (!text || !chat || !workspace) return;

    setError(null);
    setBusy(true);

    // Attachment bodies go into a hidden system message so the AI can see them
    // without polluting the user bubble. The user message itself stays clean —
    // we append a metadata marker so we can render small chips above the text.
    const attMeta = attachments.map((a) => ({ name: a.name, kind: a.kind }));
    const sysParts = attachments.map((a) => {
      if (a.kind === "image") {
        return `[Image attached: ${a.name} — preview only, vision pipeline TBD]`;
      }
      const label = a.kind === "pdf" ? "PDF" : "file";
      const body = a.body ?? "";
      // Empty body usually means a scanned PDF (no text layer) or a
      // pdfjs failure that didn't throw. Surface it inline so the
      // model can answer "I can't read this file" rather than silently
      // pretending nothing was attached.
      if (a.kind === "pdf" && body.trim().length === 0) {
        toast.warning(`No text extracted from ${a.name}`, {
          description:
            "PDF appears to be scanned or has no text layer. Try a text PDF or paste the contents.",
        });
        return `Attached ${label} (${a.name}): (no text could be extracted from this PDF — likely scanned. Tell the user the file is unreadable rather than inventing content.)`;
      }
      return `Attached ${label} (${a.name}):\n\n${body}`;
    });
    let attachmentSysMsg: StoredMessage | null = null;
    if (sysParts.length > 0) {
      try {
        attachmentSysMsg = await addMessage({
          chatId: chat.id,
          role: "system",
          content: sysParts.join("\n\n---\n\n"),
        });
        setMessages((prev) => [...prev, attachmentSysMsg!]);
      } catch (err) {
        setError(String(err));
        setBusy(false);
        return;
      }
    }

    const markerSuffix =
      attMeta.length > 0 ? `\n\n${ATT_MARKER_PREFIX}${JSON.stringify(attMeta)}}}` : "";
    const userContent = text + markerSuffix;

    let userMsg: StoredMessage;
    try {
      userMsg = await addMessage({ chatId: chat.id, role: "user", content: userContent });
    } catch (err) {
      setError(String(err));
      setBusy(false);
      return;
    }
    setMessages((prev) => [...prev, userMsg]);
    setAttachments([]);
    void bump("words_seen");
    void touchChat(chat.id).then(() => void refreshChats());

    // Auto-title from the first user message so the chat is recognisable in Recents.
    const isFirstMessage = messages.filter((m) => m.role === "user").length === 0;
    const isPlaceholderTitle =
      !chat.title || chat.title === "New chat" || chat.title === "Conversation";
    if (isFirstMessage && isPlaceholderTitle) {
      // Two-stage title: instant first-words fallback so the sidebar
      // never shows a hole, then a background AI titler (further
      // below) replaces it. The skeleton-blur in the sidebar lifts
      // when the AI titler clears titlePending.
      const derived = text.trim().split(/\s+/).slice(0, 8).join(" ").slice(0, 60);
      if (derived) {
        void renameChat(chat.id, derived).then(() => void refreshChats());
      }
      bgChat.markTitlePending(chat.id);
    }

    if (!provider) {
      setError(
        "No provider configured. Open Settings → Providers to add Ollama, OpenAI, Anthropic, Gemini, or Minimax.",
      );
      setBusy(false);
      return;
    }

    // The chatId we're streaming into is captured here so navigation
    // away doesn't redirect the partial. The BG context keeps the
    // partial keyed on this id; if the user comes back later we'll
    // read it back via getStream(thisChatId).
    const streamingChatId = chat.id;
    bgChat.start(streamingChatId);
    try {
      const systemPrompt = await buildSystemPrompt(
        workspace.id,
        languageName(workspace.targetLang),
        languageName(workspace.nativeLang),
        text,
        { raw: rawMode },
      );
      // Include the attachment-bearing system message we just created.
      // React state (`messages`) won't have it yet because setState is
      // async — without this splice, attached PDFs/files wouldn't reach
      // the model on the very turn they were attached, only on later turns.
      const historySource = attachmentSysMsg
        ? [...messages, attachmentSysMsg, userMsg]
        : [...messages, userMsg];
      const history = historySource.map((m) => ({
        role: m.role,
        content: m.role === "user" ? parseUserContent(m.content).text : m.content,
      }));
      const messagesForApi = [
        { role: "system" as const, content: systemPrompt },
        ...history,
      ];
      const reply = await sendChat({
        messages: messagesForApi,
        onToken: (delta) => bgChat.appendToken(streamingChatId, delta),
      });
      // Post-process the stream: rescue translation spans that the model
      // emitted with single parens. The renderer's blur effect requires
      // ((double parens)); local Ollama models often regress to single
      // parens despite the system prompt's instructions. Conservative —
      // CJK target languages only, never inside code fences. Latin-script
      // workspaces fall through unchanged.
      const finalText = enforceTranslationBlur(reply.trim(), workspace?.targetLang ?? "");
      if (finalText) {
        // Save the message as-is, with any tool blocks intact. The
        // assistant bubble renders an inline Add/Dismiss card for pending
        // tool calls parsed from those blocks (see MessageBubble →
        // PendingActionCard). Confirming runs the calls and appends result
        // blocks; dismissing strips them. Persisting the raw blocks means a
        // reload mid-decision shows the same card — nothing runs until the
        // user taps Add, so an unprompted tool call from a confused small
        // model just sits there inert.
        const assistantMsg = await addMessage({
          chatId: chat.id,
          role: "assistant",
          content: finalText,
        });
        setMessages((prev) => [...prev, assistantMsg]);

        // Background AI-titler — runs once per new chat after the first reply.
        if (isFirstMessage && isPlaceholderTitle && chat) {
          const chatIdForTitle = chat.id;
          void (async () => {
            try {
              // Reasoning models (DeepSeek-R1, MiniMax M2) wrap their
              // chain-of-thought in <think>…</think>. Strip it from the
              // assistant text we hand to the titler, otherwise the
              // titler ends up "naming" the model's internal monologue.
              const cleanAssistant = splitThinking(finalText).reply.trim();
              const titleReply = await sendChat({
                messages: [
                  {
                    role: "system" as const,
                    content:
                      "You generate short chat titles. Reply with ONLY the title — " +
                      "3 to 5 words, Title Case, English, no quotes, no punctuation, " +
                      "no period at the end, no XML/HTML tags, no <think> or " +
                      "<reasoning> blocks, no explanation. Just the bare title text.",
                  },
                  {
                    role: "user" as const,
                    content: `User: ${text.slice(0, 500)}\n\nAssistant: ${cleanAssistant.slice(0, 500)}\n\nTitle:`,
                  },
                ],
                onToken: () => {},
              });
              // Belt-and-suspenders: strip <think> from the titler's
              // own reply too (tighter prompt isn't a hard guarantee
              // when local models are in the mix), then take the first
              // non-empty line so a chatty model that adds an
              // explanation still gives us a usable title.
              const stripped = splitThinking(titleReply).reply;
              const firstLine = stripped
                .split(/\r?\n/)
                .map((l) => l.trim())
                .find((l) => l.length > 0) ?? "";
              const cleaned = firstLine
                .replace(/^["'\s]+|["'\s.!?]+$/g, "")
                .slice(0, 60);
              // Reject obviously-bad titles: empty, way too long, or
              // suspiciously sentence-shaped (>8 words). Falls back to
              // the first-words title we set instantly above.
              const words = cleaned.split(/\s+/).filter(Boolean);
              const looksLikeTitle =
                cleaned.length > 0 &&
                cleaned.length <= 60 &&
                words.length <= 8;
              if (looksLikeTitle) {
                await renameChat(chatIdForTitle, cleaned);
                await refreshChats();
              }
            } catch {
              /* keep the first-words fallback */
            } finally {
              bgChat.clearTitlePending(chatIdForTitle);
            }
          })();
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      bgChat.fail(streamingChatId, message);
      // The titler never gets a chance to run if the main stream
      // failed before we hit the success branch. Lift the skeleton
      // blur in the sidebar so a permanently-failing first send
      // doesn't leave the chat looking "still generating" forever.
      if (isFirstMessage && isPlaceholderTitle) {
        bgChat.clearTitlePending(streamingChatId);
      }
    } finally {
      bgChat.finish(streamingChatId, "");
      setBusy(false);
      // After every Tokori-backed exchange, re-pull the cached balance
      // so the composer's gate decides on the post-debit number rather
      // than the pre-send one. Cheap — a single GET against the cloud.
      if (isCloud && cloud.account) void cloud.refreshBalance();
    }
  }

  async function newChat() {
    if (!workspace) return;
    const c = await createNewChat();
    setChat(c);
    setMessages([]);
    setError(null);
    setAttachments([]);
    // Composer is keyed on chat.id and remounts with a clean state +
    // autofocus, so we don't manage its input value or focus here.
  }

  async function setDefault(p: ProviderConfig) {
    await saveProvider({
      id: p.id,
      kind: p.kind,
      label: p.label,
      model: p.model,
      host: p.host ?? null,
      apiKey: p.apiKey ?? null,
      baseUrl: p.baseUrl ?? null,
      isDefault: true,
    });
  }

  // Is THIS chat mid-stream? We read only the boolean here — NOT the partial
  // text — so a token arriving doesn't re-render this (large) component. The
  // growing text is consumed by the StreamingBubble leaf via useStreamPartial.
  const streamActive = chat ? bgChat.activeStreamIds.has(chat.id) : false;

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Auto-scroll when a message lands or a stream starts/ends. Per-token
  // scrolling while streaming is driven from the StreamingBubble (which is
  // the only thing that re-renders on each token).
  useEffect(() => {
    scrollToBottom();
  }, [messages.length, streamActive, scrollToBottom]);

  const visibleMessages = useMemo(
    () => messages.filter((m) => m.role !== "system"),
    [messages],
  );
  const isEmpty = visibleMessages.length === 0 && !streamActive;
  const hasGemini = providers.some((p) => p.kind === "gemini");
  const initial = (modelDisplayName(provider) || "?").trim()[0]?.toUpperCase() ?? "?";

  // Tell the background context which chat the user is currently viewing.
  // Drives the "mark as unread" decision when a stream finishes — if the
  // active chat at finish time was different, we set an unread flag.
  // Also clears the unread badge for the chat being opened.
  useEffect(() => {
    bgChat.reportActiveChat(chat?.id ?? null);
    return () => {
      bgChat.reportActiveChat(null);
    };
  }, [chat?.id, bgChat]);

  // Stable provider value: keeps the three handlers' identity across renders
  // so a send (which flips `busy` twice) doesn't re-render every CodeBlock /
  // vocab table / PendingActionCard through the memoized MessageBubble
  // boundary — context updates bypass React.memo. Defined above the
  // `workspace` guard so it stays an unconditional hook; the handlers carry
  // their own null-guards.
  const chatActions = useMemo<ChatActions>(
    () => ({
      importCsv: (csv) => setCsvImportText(csv),
      // Run the pending tool calls in a saved assistant message, append
      // their result blocks (so they survive reload), and refresh the
      // message in place — the bubble re-renders from PendingActionCard
      // into ToolResultCard.
      confirmToolCalls: async (messageId, content, calls) => {
        if (!workspace) return;
        const results = await Promise.all(
          calls.map((c) => executeToolCall(c, workspace.id)),
        );
        for (const r of results) {
          if (r.ok) toast.success(r.summary);
          else toast.error(r.summary);
        }
        const updated = appendToolResults(content, results);
        try {
          await updateMessageContent(messageId, updated);
        } catch (err) {
          console.warn("update assistant message failed", err);
        }
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, content: updated } : m)),
        );
      },
      // Strip the tool blocks without running them — the card disappears
      // and the prose reply stays.
      dismissToolCalls: async (messageId, content) => {
        const stripped = stripToolBlocks(content);
        try {
          await updateMessageContent(messageId, stripped);
        } catch (err) {
          console.warn("strip assistant tool blocks failed", err);
        }
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, content: stripped } : m)),
        );
      },
    }),
    [workspace],
  );

  // Guard moved down from the top of the component so every hook above
  // runs unconditionally. Nothing between the old position and here
  // dereferences `workspace` (the helper fns carry their own guards), and
  // tsc's null-narrowing confirms it.
  if (!workspace) return null;

  // Composer owns its own input state — see comment on Composer below for
  // the rationale. We `key` it on chat.id so switching chats remounts with
  // a clean textarea + auto-focus, which used to require imperative
  // setInput("") + inputRef.focus() up here.
  const composer = (
    <Composer
      key={chat?.id ?? 0}
      onSend={(text) => void send(text)}
      busy={busy}
      streaming={streamActive}
      provider={provider}
      attachments={attachments}
      onRemoveAttachment={(id) =>
        setAttachments((prev) => prev.filter((a) => a.id !== id))
      }
      onAttachClick={() => fileInputRef.current?.click()}
      onVoiceClick={() => setLiveMode(true)}
      sttLang={workspace.nativeLang}
      onNavigate={onNavigate}
      onCloudCTA={cloudCTA}
      outOfTokens={outOfTokens}
      placeholder={
        !provider
          ? "Configure a provider in Settings to start chatting…"
          : outOfTokens
            ? "Out of Tokori credits — buy more to continue."
            : streamActive
              ? `${modelDisplayName(provider)} is generating a reply…`
              : `Message ${languageName(workspace.targetLang)} tutor — drop .txt, .md, .pdf, or images`
      }
      dragOver={dragOver}
    />
  );

  return (
    <ChatActionsProvider value={chatActions}>
    <div
      className={cn("relative flex h-full flex-col")}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        void handleFiles(e.dataTransfer.files);
      }}
    >
      <ChatTopBar
        provider={provider}
        providers={providers}
        onPickProvider={(id) => void setActiveId(id)}
        onPickModel={async (p, model) => {
          // Special case: the synthesized cloud provider isn't a DB
          // row, so we route the "model" pick into the cloud tier
          // setter instead of `saveProvider`. Anything else hits the
          // normal DB upsert path.
          if (p.kind === "tokori-cloud") {
            cloud.setTier(model === "advanced" ? "advanced" : "fast");
            await setActiveId(p.id);
            return;
          }
          // Persist the new model on the provider config (so it sticks
          // after a reload), then make sure that provider is active.
          await saveProvider({
            id: p.id,
            kind: p.kind,
            label: p.label,
            apiKey: p.apiKey ?? null,
            host: p.host ?? null,
            baseUrl: p.baseUrl ?? null,
            model,
            isDefault: p.isDefault,
          });
          await setActiveId(p.id);
        }}
        onSetDefault={(p) => void setDefault(p)}
        onNewChat={() => void newChat()}
        onToggleSidebar={onToggleSidebar}
        onNavigate={onNavigate}
        onCloudCTA={cloudCTA}
        signedIn={!!cloud.account}
        cloudBalance={isCloud ? cloud.balance?.tokenBalance ?? null : null}
        onToggleLive={() => setLiveMode((m) => !m)}
        liveActive={liveMode}
        liveAvailable={hasGemini}
        showPinyinToggle={workspace.targetLang === "zh"}
        pinyinOn={showPinyin}
        onTogglePinyin={togglePinyin}
        translationsOn={showTranslations}
        onToggleTranslations={toggleTranslations}
        rawMode={rawMode}
        onToggleRawMode={() => setRawMode((v) => !v)}
      />

      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-foreground/30 bg-card/80 px-8 py-6 text-center shadow-lg">
            <p className="font-serif text-xl tracking-tight">Drop to attach</p>
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              .txt · .md · .pdf · images — auto-uploads
            </p>
          </div>
        </div>
      )}

      {liveMode ? (
        <div className="flex-1 overflow-hidden animate-in fade-in duration-300">
          <InlineLiveMode modelInitial={initial} onLeave={() => setLiveMode(false)} />
        </div>
      ) : (
        <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            {isEmpty ? (
              <EmptyChat
                target={workspace.targetLang}
                name={profile.name}
                provider={provider}
                onPickPrompt={(t) => void send(t)}
                onOpenVoice={() => setLiveMode(true)}
                composer={composer}
                onNavigate={onNavigate}
                onCloudCTA={cloudCTA}
                signedIn={!!cloud.account}
              />
            ) : (
              <div
                key={chat?.id ?? 0}
                className="mx-auto flex max-w-3xl xl:max-w-4xl 2xl:max-w-5xl flex-col gap-4 px-6 py-8 animate-in fade-in duration-300"
              >
                {visibleMessages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    targetLang={workspace.targetLang}
                    initial={initial}
                  />
                ))}
                {streamActive && chat && (
                  <StreamingBubble
                    key={chat.id}
                    chatId={chat.id}
                    initial={initial}
                    scrollToBottom={scrollToBottom}
                  />
                )}
                {error && (
                  <div className="flex items-start gap-2 self-stretch rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" />
                    <span className="whitespace-pre-wrap">{error}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {!isEmpty && (
            <div className="border-t border-border bg-background/85 px-6 py-4 backdrop-blur">
              <div className="mx-auto max-w-3xl xl:max-w-4xl 2xl:max-w-5xl">{composer}</div>
            </div>
          )}
        </>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_TYPES}
        multiple
        className="hidden"
        onChange={(e) => {
          void handleFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <VocabImportDialog
        open={csvImportText != null}
        onClose={() => setCsvImportText(null)}
        onDone={() => setCsvImportText(null)}
        initialText={csvImportText ?? ""}
      />

      {/* Cloud CTA dialogs — opened from the no-provider indicators
          ("Sign in & buy tokens"). Mounted once at the chat-view level
          so all three indicator surfaces share state. */}
      <CloudSignInDialog
        open={showSignIn}
        onClose={() => {
          setShowSignIn(false);
          // After a successful sign-in `cloud.account` becomes
          // truthy; chain into the store so the user lands where they
          // were trying to go in the first place.
          if (cloud.account) setShowStore(true);
        }}
      />
      <StoreDialog open={showStore} onClose={() => setShowStore(false)} />
    </div>
    </ChatActionsProvider>
  );
}

function ChatTopBar({
  provider,
  providers,
  onPickProvider,
  onPickModel,
  onSetDefault,
  onNewChat,
  onToggleSidebar,
  onToggleLive,
  liveActive,
  liveAvailable,
  onNavigate,
  onCloudCTA,
  signedIn,
  cloudBalance,
  showPinyinToggle,
  pinyinOn,
  onTogglePinyin,
  translationsOn,
  onToggleTranslations,
  rawMode,
  onToggleRawMode,
}: {
  provider: ProviderConfig | null;
  providers: ProviderConfig[];
  onPickProvider: (id: number) => void;
  /** Switch to a *different* model for an existing provider config. The
   *  parent persists this on the config so it sticks across reloads. */
  onPickModel: (p: ProviderConfig, model: string) => Promise<void> | void;
  onSetDefault: (p: ProviderConfig) => void;
  onNewChat: () => void;
  onToggleSidebar?: () => void;
  onToggleLive: () => void;
  liveActive: boolean;
  liveAvailable: boolean;
  /** When supplied, the no-provider trigger and the in-popover empty
   *  state route to Settings → Providers. */
  onNavigate?: (tab: TabId) => void;
  /** Opens the cloud sign-in (or store, if already signed in) dialog
   *  so a user without an API key can pay-as-you-go via Tokori credits. */
  onCloudCTA?: () => void;
  /** Reflects cloud auth state — used to relabel the CTA from
   *  "Sign in & buy tokens" to "Buy more tokens" once the user is in. */
  signedIn?: boolean;
  /** Live token balance to render as a pill next to the model picker.
   *  Null when Tokori isn't the active provider (or while balance is
   *  still loading). */
  cloudBalance?: number | null;
  /** Display preferences — moved out of the composer so they stay
   *  visible while scrolling messages. PN is Chinese-only;
   *  EN translation-blur is global. */
  showPinyinToggle?: boolean;
  pinyinOn?: boolean;
  onTogglePinyin?: () => void;
  translationsOn?: boolean;
  onToggleTranslations?: () => void;
  /** "Raw" mode — next send goes out without the vocab list / RAG /
   *  due-today / focus context blocks. Sticky until toggled off. */
  rawMode?: boolean;
  onToggleRawMode?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Which provider's model list is currently expanded inline. Cleared when
  // the popover closes so each open starts collapsed.
  const [expandedFor, setExpandedFor] = useState<number | null>(null);
  // Cached model lists per fetch-key so re-opening the same expander is
  // instant. The Rust `provider_list_models` invoke is cheap but Ollama
  // first hits localhost which can stall while the daemon spins up.
  const [modelCache, setModelCache] = useState<Record<string, string[] | "loading" | "error">>({});
  const isAlreadyDefault = provider?.isDefault === true;

  return (
    <div className="border-b border-border/60">
      <div className="flex items-center gap-1 px-3 pt-3 pb-2">
        {onToggleSidebar && (
          <button
            type="button"
            onClick={onToggleSidebar}
            aria-label="Toggle sidebar"
            className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            <Menu className="size-[18px]" />
          </button>
        )}

        <Popover
          open={open}
          onOpenChange={(v) => {
            setOpen(v);
            if (!v) setExpandedFor(null);
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex flex-col items-start rounded-md px-2 py-1 text-left transition-colors hover:bg-accent/60"
            >
              <span className="flex items-center gap-1 text-[15px] font-semibold tracking-tight">
                {modelDisplayName(provider)}
                <ChevronDown className="size-3.5 text-muted-foreground" />
              </span>
              {provider && !isAlreadyDefault && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSetDefault(provider);
                  }}
                  className="-mt-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  Set as default
                </button>
              )}
              {provider && isAlreadyDefault && (
                <span className="-mt-0.5 text-[11px] text-muted-foreground">
                  {provider.label}
                </span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" sideOffset={4} className="w-[280px] p-1">
            <div className="px-2 pb-1 pt-0.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
              Configured providers
            </div>
            {providers.length === 0 ? (
              onNavigate ? (
                <div className="flex flex-col gap-1 px-1 py-1">
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      requestSettingsIntent("addProvider");
                      onNavigate("settings");
                    }}
                    className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/60"
                  >
                    <span className="text-[12.5px] font-medium text-foreground">
                      Add a provider
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      Bring your own key — Ollama, OpenAI, Anthropic, …
                    </span>
                  </button>
                  {onCloudCTA && (
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        onCloudCTA();
                      }}
                      className="flex w-full flex-col items-start gap-0.5 rounded-md border border-foreground/20 bg-foreground/5 px-2 py-2 text-left transition-colors hover:bg-foreground/10"
                    >
                      <span className="text-[12.5px] font-medium text-foreground">
                        {signedIn ? "Buy more tokens" : "No key? Sign in & buy tokens"}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        Pay-as-you-go via the Tokori cloud — no setup.
                      </span>
                    </button>
                  )}
                </div>
              ) : (
                <p className="px-2 py-2 text-[12.5px] text-muted-foreground">
                  No providers yet. Open Settings → Providers.
                </p>
              )
            ) : (
              <div className="flex flex-col">
                {providers.map((p) => {
                  const isExpanded = expandedFor === p.id;
                  const fetchKey = providerFetchKey(p);
                  const cached = modelCache[fetchKey];
                  return (
                    <div key={p.id} className="flex flex-col">
                      <div
                        className={cn(
                          "flex items-stretch rounded-md transition-colors",
                          provider?.id === p.id
                            ? "bg-accent text-accent-foreground"
                            : "hover:bg-accent/60",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            onPickProvider(p.id);
                            setOpen(false);
                          }}
                          className="flex flex-1 min-w-0 items-start gap-2 px-2 py-1.5 text-left"
                        >
                          <Check
                            className={cn(
                              "mt-0.5 size-3.5 shrink-0",
                              provider?.id === p.id ? "opacity-100" : "opacity-0",
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-medium">
                              {p.kind === "tokori-cloud"
                                ? p.model === "advanced"
                                  ? "Cloud: Smart"
                                  : "Cloud: Fast"
                                : p.model || p.label}
                            </div>
                            <div className="truncate text-[11px] text-muted-foreground">
                              {p.label} · {p.kind}
                              {p.isDefault && " · default"}
                            </div>
                          </div>
                        </button>
                        {/* Expander: shows the other models you have
                            for this provider. Tokori Cloud now
                            exposes two tiers (fast / advanced) —
                            `fetchModelsFor` returns those instead of
                            calling the rust `provider_list_models`
                            command, which doesn't speak the
                            `tokori-cloud` kind. */}
                        {(
                          <button
                            type="button"
                            aria-label="Switch model"
                            onClick={(e) => {
                              e.stopPropagation();
                              const next = isExpanded ? null : p.id;
                              setExpandedFor(next);
                              // Lazy-fetch on first expand. Subsequent
                              // expansions hit the cache.
                              if (next !== null && cached === undefined) {
                                setModelCache((prev) => ({ ...prev, [fetchKey]: "loading" }));
                                void fetchModelsFor(p)
                                  .then((ids) =>
                                    setModelCache((prev) => ({ ...prev, [fetchKey]: ids })),
                                  )
                                  .catch(() =>
                                    setModelCache((prev) => ({ ...prev, [fetchKey]: "error" })),
                                  );
                              }
                            }}
                            className="flex items-center px-2 text-muted-foreground hover:text-foreground"
                            title={isExpanded ? "Hide models" : "Show other models"}
                          >
                            <ChevronDown
                              className={cn(
                                "size-3.5 transition-transform",
                                isExpanded && "rotate-180",
                              )}
                            />
                          </button>
                        )}
                      </div>
                      {isExpanded && (
                        <ProviderModelList
                          provider={p}
                          activeModel={p.model}
                          state={cached}
                          onPick={async (model) => {
                            await onPickModel(p, model);
                            setOpen(false);
                            setExpandedFor(null);
                          }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <Separator className="my-1" />
            {provider && !isAlreadyDefault && (
              <button
                onClick={() => {
                  onSetDefault(provider);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              >
                Set "{modelDisplayName(provider)}" as default
              </button>
            )}
          </PopoverContent>
        </Popover>

        {/* Live token balance — only when Tokori is the active provider.
            Click jumps to the store. Goes amber under 50, red at 0 so
            the user has a chance to top up before the gate slams shut. */}
        {cloudBalance != null && onCloudCTA && (
          <button
            type="button"
            onClick={onCloudCTA}
            className={cn(
              "ml-2 inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium tabular-nums transition-colors",
              cloudBalance <= 0
                ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15"
                : cloudBalance < 50
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
                  : "border-border bg-card text-muted-foreground hover:bg-accent/60",
            )}
            title="Tokori credit balance — click to top up"
          >
            <Coins className="size-3" />
            {cloudBalance.toLocaleString()}
            {cloudBalance <= 0 && <span className="ml-1">— top up</span>}
          </button>
        )}

        <div className="flex-1" />

        {/* PN + EN — display toggles. Sticky at the top of the chat
            so they're always reachable while scrolling messages, the
            same way the model picker on the left is. */}
        {showPinyinToggle && onTogglePinyin && (
          <button
            type="button"
            onClick={onTogglePinyin}
            className={cn(
              "ml-1 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors",
              pinyinOn
                ? "bg-foreground text-background"
                : "border border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
            title={pinyinOn ? "Hide pinyin" : "Show pinyin"}
          >
            <Type className="size-3.5" />
            PN
          </button>
        )}
        {onToggleTranslations && (
          <button
            type="button"
            onClick={onToggleTranslations}
            className={cn(
              "ml-1 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors",
              translationsOn
                ? "bg-foreground text-background"
                : "border border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
            title={
              translationsOn
                ? "Translations shown — click to blur"
                : "Translations blurred — click to reveal all"
            }
          >
            <Eye className="size-3.5" />
            EN
          </button>
        )}
        {/* Raw mode — strip the vocab list / RAG / due / focus blocks
            from the system prompt so the tutor responds purely to the
            user's message + attachments. Sticky across messages. */}
        {onToggleRawMode && (
          <button
            type="button"
            onClick={onToggleRawMode}
            className={cn(
              "ml-1 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors",
              rawMode
                ? "bg-amber-500 text-background"
                : "border border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
            title={
              rawMode
                ? "Raw mode — vocab + RAG context disabled. Click to restore."
                : "Send without the vocab list, RAG hits, or study-focus context."
            }
          >
            <EyeOff className="size-3.5" />
            Raw
          </button>
        )}

        {liveAvailable && (
          <button
            type="button"
            onClick={onToggleLive}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors",
              liveActive
                ? "bg-emerald-500/15 text-emerald-700 ring-1 ring-emerald-500/40 dark:text-emerald-400"
                : "border border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Radio
              className={cn(
                "size-3.5",
                liveActive && "animate-pulse",
              )}
            />
            {liveActive ? "Live · on" : "Live"}
          </button>
        )}

        <button
          type="button"
          onClick={onNewChat}
          aria-label="New conversation"
          className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <Plus className="size-[18px]" />
        </button>
      </div>

    </div>
  );
}

function AttachmentChip({
  attachment: a,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}) {
  const Icon =
    a.kind === "pdf" ? FileText : a.kind === "image" ? ImageIcon : FileText;
  const colorClass =
    a.kind === "pdf"
      ? "border-rose-500/30 bg-rose-500/5 text-rose-700 dark:text-rose-300"
      : a.kind === "image"
        ? "border-sky-500/30 bg-sky-500/5 text-sky-700 dark:text-sky-300"
        : "border-border bg-card text-foreground/80";
  return (
    <span
      className={cn(
        "inline-flex max-w-[220px] items-center gap-1.5 rounded-full border px-2 py-0.5 text-[12px]",
        colorClass,
      )}
      title={a.name}
    >
      {a.kind === "image" && a.dataUrl ? (
        <img
          src={a.dataUrl}
          alt=""
          className="size-4 shrink-0 rounded-sm object-cover"
        />
      ) : (
        <Icon className="size-3 shrink-0" />
      )}
      <span className="truncate">{a.name}</span>
      <button
        onClick={onRemove}
        className="text-current/70 hover:text-current"
        aria-label={`Remove ${a.name}`}
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

function EmptyChat({
  target,
  name,
  provider,
  onPickPrompt,
  onOpenVoice,
  composer,
  onNavigate,
  onCloudCTA,
  signedIn,
}: {
  target: LanguageCode;
  name: string;
  provider: ProviderConfig | null;
  onPickPrompt: (text: string) => void;
  onOpenVoice: () => void;
  composer: React.ReactNode;
  onNavigate?: (tab: TabId) => void;
  onCloudCTA?: () => void;
  signedIn?: boolean;
}) {
  const initial = (modelDisplayName(provider) || "?").trim()[0]?.toUpperCase() ?? "?";
  void name;
  void target;
  const noProvider = !provider;

  return (
    <div className="mx-auto flex h-full max-w-3xl xl:max-w-4xl 2xl:max-w-5xl flex-col items-stretch justify-center gap-6 px-6 py-12 animate-in fade-in duration-300">
      <div className="flex flex-col items-center gap-3 animate-in fade-in slide-in-from-bottom-3 duration-500">
        <div className="flex size-[88px] items-center justify-center rounded-full bg-foreground text-background shadow-lg">
          <span className="font-serif text-3xl">{initial}</span>
        </div>
        {noProvider && onNavigate ? (
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={() => {
                requestSettingsIntent("addProvider");
                onNavigate("settings");
              }}
              className="group flex flex-col items-center gap-0.5 rounded-md px-3 py-1 transition-colors hover:bg-accent/40"
              title="Open Settings → Providers"
            >
              <span className="text-2xl font-semibold tracking-tight">
                {modelDisplayName(provider)}
              </span>
              <span className="text-[12px] text-amber-600 group-hover:underline dark:text-amber-400">
                Click to add a provider
              </span>
            </button>
            {onCloudCTA && (
              <button
                type="button"
                onClick={onCloudCTA}
                className="rounded-full border border-foreground/30 bg-foreground/5 px-3 py-1 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/10"
              >
                {signedIn ? "Buy more tokens" : "No key? Sign in & buy tokens"}
              </button>
            )}
          </div>
        ) : (
          <h1 className="text-2xl font-semibold tracking-tight">
            {modelDisplayName(provider)}
          </h1>
        )}
      </div>

      <div
        className="animate-in fade-in slide-in-from-bottom-2 duration-500"
        style={{ animationDelay: "120ms", animationFillMode: "backwards" }}
      >
        {composer}
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-1.5 px-2 text-[12px] font-medium text-muted-foreground">
          <Sparkles className="size-3.5" />
          Suggested
        </div>
        <ul>
          {STARTER_CARDS.map((card, i) => {
            const Icon = card.icon;
            return (
              <li
                key={card.id}
                className="animate-in fade-in slide-in-from-bottom-2 duration-500"
                style={{
                  animationDelay: `${220 + i * 70}ms`,
                  animationFillMode: "backwards",
                }}
              >
                <button
                  onClick={() => {
                    if (card.voice) onOpenVoice();
                    else onPickPrompt(pickPrompt(card, target));
                  }}
                  className="group flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-accent/40"
                >
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground transition-colors group-hover:bg-foreground/10 group-hover:text-foreground">
                    <Icon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium">{card.title}</div>
                    <div className="truncate text-[12.5px] text-muted-foreground">
                      {card.description}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/**
 * Composer.
 *
 * Owns its own textarea state. This is deliberate: a parent-owned `input`
 * meant every keystroke re-rendered ChatView, which re-rendered the message
 * list, which re-rendered every <Tokenized> bubble (jieba segments + dict
 * lookups galore). On a long Chinese chat that turned typing visibly laggy
 * and made the dotted-underline highlights flicker between intl and jieba
 * segmentations.
 *
 * By scoping the input state to this component, ChatView only re-renders
 * when something actually changed for the message list (new message,
 * streaming token, attachment list update). Keystrokes stay local.
 *
 * `key={chat.id}` on the parent's mount remounts us cleanly when switching
 * chats — no imperative clear / focus needed up there.
 */
function Composer({
  onSend,
  busy,
  streaming,
  provider,
  attachments,
  onRemoveAttachment,
  onAttachClick,
  onVoiceClick,
  placeholder,
  dragOver,
  onNavigate,
  onCloudCTA,
  outOfTokens,
  sttLang,
}: {
  onSend: (text: string) => void;
  busy: boolean;
  streaming: boolean;
  provider: ProviderConfig | null;
  attachments: Attachment[];
  onRemoveAttachment: (id: string) => void;
  onAttachClick: () => void;
  /** Opens live voice mode (bidirectional speech). Wired to the new
   *  AudioWaveform button next to Send — the Mic button below now
   *  does plain speech-to-text dictation. */
  onVoiceClick: () => void;
  placeholder: string;
  dragOver: boolean;
  /** Wired by the parent so the no-provider notice is a one-click jump
   *  to Settings → Providers. */
  onNavigate?: (tab: TabId) => void;
  /** Opens the cloud sign-in / store dialog so the user can pay-as-
   *  you-go through Tokori credits without bringing an API key. */
  onCloudCTA?: () => void;
  /** True when Tokori is the active provider AND the cached balance is
   *  zero. Disables send and surfaces an inline buy-more CTA. */
  outOfTokens?: boolean;
  /** Language to feed to SpeechRecognition. We use the workspace's
   *  *native* language by default (line: "Explain to me in") because
   *  users dictating to the tutor almost always type their question
   *  in their own language. To practise speaking the target language,
   *  the wave button (live voice mode) is the right tool — it's
   *  bidirectional and handles back-and-forth properly. */
  sttLang?: LanguageCode;
}) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea up to 240px so a long question doesn't get
  // clipped, but the chat history stays visible.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [input]);

  // Autofocus on mount — also fires on chat switch via the parent's key= prop.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // ── Mic button = speech-to-text dictation ──────────────────────────
  //
  // Two engines, picked via Settings → Voice → Dictation:
  //   - Browser (Web Speech API) — instant, but missing on Linux's
  //     WebKitGTK webview. Streams interim + final results.
  //   - Whisper — record with MediaRecorder, POST the blob to the
  //     active openai-kind provider's /v1/audio/transcriptions
  //     endpoint when the user stops the mic. Slower (no interim
  //     results) but works anywhere a key works, including Linux.
  //
  // "auto" prefers browser when available, falls back to whisper.
  const { profile: sttProfile } = useProfile();
  const { providers: allProviders } = useProviderConfigs();
  type RecognitionLike = {
    lang: string;
    interimResults: boolean;
    continuous: boolean;
    onresult: ((e: { results: { 0: { transcript: string } }[] & { [k: number]: { isFinal: boolean } } }) => void) | null;
    onend: (() => void) | null;
    onerror: ((e: { error?: string }) => void) | null;
    start: () => void;
    stop: () => void;
  };
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const recorderRef = useRef<Awaited<ReturnType<typeof startRecording>> | null>(null);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const browserAvailable = isBrowserSTTAvailable();
  const whisperProvider = findWhisperProvider(allProviders);

  /** Resolve the engine the user would actually use given their setting
   *  + what's available right now. */
  function resolveEngine(): "browser" | "whisper" | "none" {
    const choice = sttProfile.sttKind;
    if (choice === "browser") return browserAvailable ? "browser" : "none";
    if (choice === "whisper") return whisperProvider ? "whisper" : "none";
    // auto
    if (browserAvailable) return "browser";
    if (whisperProvider) return "whisper";
    return "none";
  }
  const engine = resolveEngine();
  // The mic button is hidden entirely when no engine is available — that
  // also means the existing "live voice" button is the only voice path
  // on truly bare setups, which matches our previous behaviour.
  const sttAvailable = engine !== "none";

  async function toggleSTT() {
    if (!sttAvailable) {
      toast.error(
        "No speech-to-text engine available. Open Settings → Voice and pick Whisper, or set up an OpenAI/Groq provider.",
      );
      return;
    }
    if (listening) {
      // Stop whichever engine is currently capturing.
      recognitionRef.current?.stop();
      const rec = recorderRef.current;
      if (rec && whisperProvider) {
        recorderRef.current = null;
        setListening(false);
        setTranscribing(true);
        try {
          const blob = await rec.stop();
          // A microscopic blob (sub-1KB) is almost always silence —
          // skip the upload, the provider will charge anyway.
          if (blob.size < 1024) {
            toast("Nothing recorded.");
            return;
          }
          const result = await transcribeWhisper(blob, whisperProvider, {
            lang: sttLang ? bcp47(sttLang) : undefined,
          });
          if (result.text) {
            setInput((prev) =>
              prev ? `${prev.trim()} ${result.text}`.trim() : result.text,
            );
          }
        } catch (err) {
          toast.error(
            err instanceof Error ? err.message : `Transcription failed: ${String(err)}`,
          );
        } finally {
          setTranscribing(false);
        }
      }
      return;
    }
    if (engine === "browser") {
      const Ctor = (window as unknown as {
        SpeechRecognition?: new () => RecognitionLike;
        webkitSpeechRecognition?: new () => RecognitionLike;
      });
      const Impl = Ctor.SpeechRecognition ?? Ctor.webkitSpeechRecognition;
      if (!Impl) return;
      const rec = new Impl();
      rec.lang = sttLang ? bcp47(sttLang) : "en-US";
      rec.interimResults = true;
      rec.continuous = true;
      let committed = "";
      rec.onresult = (event) => {
        const results = event.results as unknown as {
          length: number;
          [k: number]: { isFinal: boolean; 0: { transcript: string } };
        };
        let interim = "";
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const t = r[0].transcript;
          if (r.isFinal) committed += t;
          else interim += t;
        }
        setInput((prev) => {
          const base = prev.replace(/\s*​\[…\][^\n]*$/, "");
          const tail = interim ? ` ​[…]${interim}` : "";
          return `${base}${committed ? ` ${committed.trim()}` : ""}${tail}`.trim();
        });
      };
      rec.onerror = (e) => {
        if (e.error && e.error !== "no-speech" && e.error !== "aborted") {
          toast.error(`Mic error: ${e.error}`);
        }
      };
      rec.onend = () => {
        setInput((prev) => prev.replace(/\s*​\[…\][^\n]*$/, "").trim());
        setListening(false);
        recognitionRef.current = null;
      };
      recognitionRef.current = rec;
      setListening(true);
      rec.start();
      return;
    }
    // engine === "whisper"
    try {
      const handle = await startRecording();
      recorderRef.current = handle;
      setListening(true);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? `Couldn't start mic: ${err.message}`
          : `Couldn't start mic: ${String(err)}`,
      );
    }
  }

  // Stop both engines cleanly if Composer unmounts mid-dictation (e.g.
  // user switches chat). Avoids a dangling mic permission indicator
  // and a stale state tick.
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      recorderRef.current?.cancel();
    };
  }, []);

  function commit() {
    const t = input.trim();
    if (!t || busy || outOfTokens) return;
    onSend(t);
    setInput("");
  }

  return (
    <div className="flex flex-col gap-1.5">
      {attachments.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-1 animate-in slide-in-from-bottom-1 fade-in duration-200">
          <span className="px-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            Attached
          </span>
          {attachments.map((a) => (
            <AttachmentChip
              key={a.id}
              attachment={a}
              onRemove={() => onRemoveAttachment(a.id)}
            />
          ))}
        </div>
      )}
      <div
        className={cn(
          "flex flex-col rounded-2xl border border-border bg-card shadow-sm transition-shadow",
          "focus-within:border-foreground/20 focus-within:shadow-md",
        dragOver && "border-foreground/40 ring-2 ring-foreground/10",
        // Active/streaming state — animated ring while AI is generating.
        streaming &&
          "ring-2 ring-foreground/15 animate-pulse [animation-duration:1.6s]",
      )}
    >
      <textarea
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            commit();
          }
        }}
        placeholder={placeholder}
        rows={1}
        className="resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14.5px] leading-relaxed outline-none placeholder:text-muted-foreground"
        // Intentionally NOT disabled while busy — typing while the AI generates is expected.
        // The send button below stays disabled until streaming finishes.
      />
      <div className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-1.5">
        <div className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onAttachClick}
            title="Attach .txt, .md, .pdf, or image"
          >
            <Paperclip className="size-4" />
          </Button>
          {sttAvailable && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void toggleSTT()}
              title={
                transcribing
                  ? "Transcribing audio…"
                  : listening
                    ? engine === "whisper"
                      ? "Stop & transcribe"
                      : "Stop dictation"
                    : engine === "whisper"
                      ? "Record + transcribe (Whisper)"
                      : "Dictate (browser speech recognition)"
              }
              className={cn(
                listening &&
                  "text-destructive animate-pulse [animation-duration:1.4s]",
                transcribing && "text-muted-foreground",
              )}
              aria-pressed={listening}
              disabled={transcribing}
            >
              {transcribing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Mic className="size-4" />
              )}
            </Button>
          )}
          {/* PN + EN now live in the ChatTopBar so they're sticky to
              the top of the chat window even while you scroll
              messages — the composer toolbar got crowded and these
              are persistent display preferences, not per-message
              composer affordances. */}
          {!provider && (
            <div className="ml-1 flex items-center gap-1">
              {onNavigate ? (
                <button
                  type="button"
                  onClick={() => {
                    requestSettingsIntent("addProvider");
                    onNavigate("settings");
                  }}
                  className="rounded-full px-2 py-0.5 text-amber-600 transition-colors hover:bg-amber-500/10 hover:underline dark:text-amber-400"
                  title="Open Settings → Providers"
                >
                  No provider — open Settings
                </button>
              ) : (
                <span className="px-1.5 text-amber-600 dark:text-amber-400">
                  No provider — Settings → Providers
                </span>
              )}
              {onCloudCTA && (
                <button
                  type="button"
                  onClick={onCloudCTA}
                  className="rounded-full border border-foreground/30 bg-foreground/5 px-2 py-0.5 font-medium text-foreground transition-colors hover:bg-foreground/10"
                >
                  or buy tokens
                </button>
              )}
            </div>
          )}
          {provider && outOfTokens && onCloudCTA && (
            <div className="ml-1 flex items-center gap-1">
              <span className="rounded-full px-2 py-0.5 text-amber-600 dark:text-amber-400">
                Out of Tokori credits
              </span>
              <button
                type="button"
                onClick={onCloudCTA}
                className="rounded-full border border-foreground/30 bg-foreground/5 px-2 py-0.5 font-medium text-foreground transition-colors hover:bg-foreground/10"
              >
                Buy more
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {/* Live voice mode — sits to the LEFT of Send so the
              cluster reads "speak / send". Visually distinct from
              the dictation Mic in the toolbar: this one launches a
              full bidirectional voice session, the Mic just
              transcribes. */}
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            onClick={onVoiceClick}
            className="rounded-full"
            title="Live voice mode"
            aria-label="Live voice mode"
          >
            <AudioWaveform className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            onClick={commit}
            disabled={busy || !input.trim() || !!outOfTokens}
            className="rounded-full"
            aria-label="Send"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArrowUp className="size-4" />
            )}
          </Button>
        </div>
      </div>
      </div>
    </div>
  );
}

function AssistantAvatar({
  initial,
  streaming = false,
}: {
  initial: string;
  streaming?: boolean;
}) {
  return (
    <div
      className={cn(
        "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border transition-all duration-500",
        streaming
          ? "border-emerald-500/40 bg-emerald-500/10 shadow-[0_0_15px_rgba(16,185,129,0.15)] scale-[1.04] animate-pulse"
          : "border-border bg-muted/40",
      )}
    >
      <span className="text-[12px] font-semibold tracking-tight">{initial}</span>
    </div>
  );
}

function UserAttachmentChip({ name, kind }: { name: string; kind: AttachmentKind }) {
  const Icon = kind === "image" ? ImageIcon : FileText;
  const tint =
    kind === "pdf"
      ? "border-rose-500/30 bg-rose-500/5 text-rose-700 dark:text-rose-300"
      : kind === "image"
        ? "border-sky-500/30 bg-sky-500/5 text-sky-700 dark:text-sky-300"
        : "border-border bg-card text-foreground/80";
  return (
    <span
      className={cn(
        "inline-flex max-w-[200px] items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px]",
        tint,
      )}
      title={name}
    >
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
//  Provider-model expander (chat dropdown)
// ─────────────────────────────────────────────────────────────────────────────

/** Cache key — stable across renders for the same provider configuration. */
function providerFetchKey(p: ProviderConfig): string {
  return `${p.kind}|${p.host ?? ""}|${p.apiKey ? "K" : ""}|${p.baseUrl ?? ""}`;
}

/** Fetch the list of available models for a provider via the existing
 *  `provider_list_models` Tauri command. Returns model IDs only. Errors
 *  are propagated as rejections so the caller can show an error state. */
async function fetchModelsFor(p: ProviderConfig): Promise<string[]> {
  // Tokori Cloud picker exposes two tiers — `fast` (cheap text model,
  // shown as "Fast", default) and `advanced` (flagship reasoning
  // model, shown as "Smart", bills ~4× per token). The cloud route
  // maps these opaque tier codes to the actual MiniMax model id and
  // applies tier-aware pricing — the real model name never reaches
  // the client. Returning them statically here means we don't need a
  // network call to populate the dropdown — the chevron expands
  // instantly.
  if (p.kind === "tokori-cloud") {
    return ["fast", "advanced"];
  }
  const cfg = (() => {
    switch (p.kind) {
      case "ollama":
        return { kind: "ollama", host: p.host || "http://localhost:11434", model: p.model || "x" };
      case "openai":
        return {
          kind: "openai",
          api_key: p.apiKey ?? "",
          model: p.model || "x",
          base_url: p.baseUrl || null,
        };
      case "anthropic":
        return { kind: "anthropic", api_key: p.apiKey ?? "", model: p.model || "x" };
      case "gemini":
        return { kind: "gemini", api_key: p.apiKey ?? "", model: p.model || "x" };
      case "minimax":
        return {
          kind: "minimax",
          api_key: p.apiKey ?? "",
          model: p.model || "x",
          base_url: p.baseUrl || null,
        };
    }
  })();
  const list = await invoke<{ id: string }[]>("provider_list_models", { config: cfg });
  return list.map((m: { id: string }) => m.id);
}

function ProviderModelList({
  provider,
  activeModel,
  state,
  onPick,
}: {
  provider: ProviderConfig;
  activeModel: string;
  state: string[] | "loading" | "error" | undefined;
  onPick: (model: string) => Promise<void> | void;
}) {
  if (state === "loading" || state === undefined) {
    return (
      <div className="ml-6 flex items-center gap-2 px-2 py-1.5 text-[12px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Loading models…
      </div>
    );
  }
  if (state === "error") {
    return (
      <p className="ml-6 px-2 py-1.5 text-[12px] text-amber-600 dark:text-amber-400">
        Couldn't list models for {provider.label}. Check your key / Ollama host.
      </p>
    );
  }
  if (state.length === 0) {
    return (
      <p className="ml-6 px-2 py-1.5 text-[12px] text-muted-foreground">
        No additional models available.
      </p>
    );
  }
  // For the cloud row the "models" returned by fetchModelsFor are
  // tier codes ("fast" / "advanced") rather than real model ids.
  // Render them with friendly labels + a one-line hint about what
  // they cost so the user picks deliberately.
  const isCloud = provider.kind === "tokori-cloud";
  const tierMeta: Record<string, { label: string; hint: string }> = {
    fast: {
      label: "Fast",
      hint: "Quick & affordable · default",
    },
    advanced: {
      label: "Smart",
      hint: "Deeper reasoning · ~4× credits",
    },
  };
  return (
    <ul className="ml-6 mt-0.5 space-y-0.5 border-l border-border/60 pl-2">
      {state.map((m) => {
        const active = m === activeModel;
        const meta = isCloud ? tierMeta[m] : null;
        return (
          <li key={m}>
            <button
              type="button"
              onClick={() => void onPick(m)}
              className={cn(
                "flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] transition-colors",
                active ? "bg-accent/60 text-foreground" : "hover:bg-accent/40",
              )}
            >
              <Check
                className={cn(
                  "mt-0.5 size-3 shrink-0",
                  active ? "opacity-100" : "opacity-0",
                )}
              />
              {meta ? (
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {meta.label}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {meta.hint}
                  </span>
                </span>
              ) : (
                <span className="truncate">{m}</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Memoised so typing in the composer (now self-contained) and any other
 * unrelated parent re-render doesn't re-run the per-message tokenisation.
 * Same `message` object → no work. The ChatList only mutates the message
 * array on real events (new turn, streaming token landed) so identity is
 * a fine equality key.
 */
const MessageBubble = memo(MessageBubbleInner, (prev, next) => {
  return (
    prev.message === next.message &&
    prev.targetLang === next.targetLang &&
    prev.initial === next.initial
  );
});

function MessageBubbleInner({
  message,
  targetLang,
  initial,
}: {
  message: StoredMessage;
  targetLang: LanguageCode;
  initial: string;
}) {
  // Stabilise the parsed/cleaned text so downstream <Tokenized> components
  // don't see a fresh string reference on every render — that would re-run
  // their async segmenter and flicker the dotted underlines.
  const split = useMemo(() => splitThinking(message.content), [message.content]);
  const toolResults = useMemo(
    () => (split.reply ? parseToolResults(split.reply) : []),
    [split.reply],
  );
  // Pending tool calls = blocks the model emitted that haven't been run
  // yet. Once results are appended (Add) or blocks stripped (Dismiss) this
  // goes empty and the card gives way to the result card / plain reply.
  const pendingCalls = useMemo(
    () =>
      split.reply && toolResults.length === 0
        ? parseToolCalls(split.reply)
        : [],
    [split.reply, toolResults.length],
  );
  const cleanReply = useMemo(
    () => (split.reply ? stripToolBlocks(split.reply) : ""),
    [split.reply],
  );
  const userContent = useMemo(
    () => (message.role === "user" ? parseUserContent(message.content) : null),
    [message.role, message.content],
  );

  if (message.role === "user" && userContent) {
    const { text, attachments } = userContent;
    return (
      <div className="flex flex-col items-end gap-1.5 animate-in slide-in-from-bottom-2 fade-in duration-300">
        {attachments.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5 max-w-[85%]">
            {attachments.map((a, i) => (
              <UserAttachmentChip key={i} name={a.name} kind={a.kind} />
            ))}
          </div>
        )}
        {text && (
          <div
            className={cn(
              "max-w-[85%] rounded-[20px] rounded-tr-sm px-5 py-3 text-[15px] leading-relaxed whitespace-pre-wrap",
              "bg-foreground/[0.04] text-foreground border border-foreground/10 shadow-sm",
              "dark:bg-white/[0.06] dark:border-white/10",
            )}
          >
            {text}
          </div>
        )}
      </div>
    );
  }
  if (message.role === "system") return null;
  return (
    <div className="group/msg flex gap-3 animate-in slide-in-from-bottom-2 fade-in duration-300">
      <AssistantAvatar initial={initial} />
      <div className="min-w-0 max-w-[85%] flex-1 space-y-2">
        {split.thinking && <ThinkingDetails thinking={split.thinking} />}
        {cleanReply && (
          <div className="text-[15px] leading-relaxed text-foreground/95">
            <ChatMarkdown text={cleanReply} lang={targetLang} />
            <div className="mt-1 -ml-1 opacity-0 transition-opacity group-hover/msg:opacity-100">
              <SpeakButton
                text={plainTextOf(cleanReply)}
                lang={targetLang}
                size="xs"
              />
            </div>
          </div>
        )}
        {pendingCalls.length > 0 && (
          <PendingActionCard
            messageId={message.id}
            content={message.content}
            calls={pendingCalls}
          />
        )}
        {toolResults.length > 0 && (
          <div className="space-y-1.5">
            {toolResults.map((r, i) => (
              <ToolResultCard key={i} result={r} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Inline confirmation for tool calls the tutor proposed but hasn't run.
 * Replaces the old approval toast: it lives in the message bubble, so it
 * survives a reload (the raw blocks persist in message content) and reads
 * as part of the conversation. "Add" runs the calls via the chat-actions
 * context; "Dismiss" strips the blocks. The `busy` tri-state disables both
 * buttons mid-action so a double-tap can't double-save.
 */
function PendingActionCard({
  messageId,
  content,
  calls,
}: {
  messageId: number;
  content: string;
  calls: ToolCall[];
}) {
  const actions = useChatActions();
  const [busy, setBusy] = useState<null | "add" | "dismiss">(null);
  const summary = summarizeToolCalls(calls);
  return (
    <div className="rounded-xl border border-border/70 bg-muted/40 px-3.5 py-3">
      <div className="flex items-start gap-2 text-[13px] text-foreground/90">
        <Sparkles className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
        <span>
          The tutor can <span className="font-medium">{summary}</span>. Add to
          your workspace?
        </span>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <Button
          size="sm"
          className="h-8 gap-1.5 px-3"
          disabled={busy !== null || !actions}
          onClick={async () => {
            if (!actions) return;
            setBusy("add");
            try {
              await actions.confirmToolCalls(messageId, content, calls);
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === "add" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Plus className="size-3.5" />
          )}
          Add
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 px-3 text-muted-foreground"
          disabled={busy !== null}
          onClick={async () => {
            if (!actions) return;
            setBusy("dismiss");
            try {
              await actions.dismissToolCalls(messageId, content);
            } finally {
              setBusy(null);
            }
          }}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function ToolResultCard({ result }: { result: ToolResult }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px]",
        result.ok
          ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
          : "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300",
      )}
    >
      {result.ok ? (
        <Wrench className="mt-0.5 size-3.5 shrink-0" />
      ) : (
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      )}
      <span className="font-medium">{result.summary}</span>
    </div>
  );
}

/**
 * The in-progress assistant reply. This is the ONLY component that re-renders
 * on each token — it subscribes to the partial via useStreamPartial, while
 * ChatView reads only the `streamActive` boolean and so stays still. The reply
 * body streams as cheap plain text (StreamingText); markdown + pinyin +
 * click-to-define land when the message finishes and the saved MessageBubble
 * takes over.
 */
function StreamingBubble({
  chatId,
  initial,
  scrollToBottom,
}: {
  chatId: number;
  initial: string;
  scrollToBottom: () => void;
}) {
  const text = useStreamPartial(chatId) ?? "";
  const split = splitThinking(text);
  // While streaming, hide tool blocks — including the *unterminated*
  // one currently being emitted (plain stripToolBlocks only removes
  // complete fences, so the JSON used to leak char-by-char until the
  // closing fence arrived). The pulse below stands in for it; once the
  // response ends, tool calls run and result cards replace them.
  const {
    text: cleanReply,
    toolPending,
    pendingToolName,
  } = sanitizeStreamingReply(split.reply ?? "");
  // Follow the stream to the bottom as text arrives.
  useEffect(() => {
    scrollToBottom();
  }, [text, scrollToBottom]);
  return (
    <div className="flex gap-3 animate-in slide-in-from-bottom-2 fade-in duration-300">
      <AssistantAvatar initial={initial} streaming />
      <div className="min-w-0 max-w-[85%] flex-1 space-y-2">
        {split.thinkOpen && <ThinkingPulse />}
        {!split.thinkOpen && split.thinking && (
          <ThinkingDetails thinking={split.thinking} />
        )}
        {(cleanReply || !split.thinkOpen) && (
          <div className="text-[15px] leading-relaxed text-foreground/95">
            {cleanReply && <StreamingText text={cleanReply} />}
          </div>
        )}
        {toolPending && (
          // Same chip language as ThinkingPulse — the tool JSON streams
          // invisibly behind this while the model writes it out.
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-3 py-1 text-[12px] text-muted-foreground">
            <Wand2 className="size-3 animate-pulse text-foreground/60" />
            <span className="animate-pulse">
              {pendingToolLabel(pendingToolName)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

async function buildSystemPrompt(
  workspaceId: number,
  target: string,
  native: string,
  userQuery: string,
  options: { raw?: boolean } = {},
): Promise<string> {
  // Raw mode strips every contextual block (vocab list, RAG hits,
  // due-today nudge, study focus) and ships only the persona text +
  // formatting rules. Gives the user a clean "respond to my message
  // and only my message" path — useful when the vocab list was
  // hijacking the model's answer to a "convert this PDF to CSV"
  // question, or for any one-off task where the tutor context is
  // noise rather than signal.
  if (options.raw) {
    const prompts = await listSystemPrompts().catch(() => [] as SystemPrompt[]);
    const persona = prompts.find((p) => p.isDefault) ?? prompts[0];
    const base = (persona?.body ?? FALLBACK_SYSTEM(target, native))
      .replaceAll("{target}", target)
      .replaceAll("{native}", native);
    // Keep the translation-blur rule and the tool-call instructions —
    // those are formatting/protocol, not "context", so the UI still
    // works correctly. Drop everything else.
    return [
      base,
      "",
      "[Raw mode — the user has temporarily disabled vocabulary, retrieval, and study-focus context. Treat their message and any attached files as the only ground truth; do NOT reference 'their vocabulary list' or invent context that wasn't provided. If they ask you to convert / format / summarise an attachment, do exactly that — don't substitute it with anything from memory.]",
      "",
      `Translation-blur rule (still applies): wrap any ${native} translation of a ${target} sentence in double parentheses, like ((this is the translation)).`,
      "",
      TOOL_SYSTEM_INSTRUCTIONS,
    ].join("\n");
  }
  // Cap vocab pull at 1500 — the prompt only ever uses ~120 entries
  // (80 mastered + 40 learning) and shipping 15k rows across IPC every
  // chat send was wasteful enough to back up the Win32 message queue
  // on big workspaces.
  const [vocab, prompts, ragHits, dueVocab, focus] = await Promise.all([
    listVocab(workspaceId, 1500).catch(() => [] as VocabEntry[]),
    listSystemPrompts().catch(() => [] as SystemPrompt[]),
    searchKnowledge(workspaceId, userQuery, 5).catch(() => []),
    // Cards the student should be reviewing right now. Capped at 30
    // — more than that and the prompt grows without giving the model
    // anything actionable. Surfaces due vocab to the tutor so it can
    // nudge the student into using those words in conversation.
    listDueVocab(workspaceId, 30).catch(() => [] as VocabEntry[]),
    // What the student is currently working through (textbook, podcast,
    // chapter). Drives the "want to talk about X?" opener.
    getWorkspaceFocus(workspaceId).catch(() => null),
  ]);

  const persona = prompts.find((p) => p.isDefault) ?? prompts[0];
  const base = (persona?.body ?? FALLBACK_SYSTEM(target, native))
    .replaceAll("{target}", target)
    .replaceAll("{native}", native);

  // Vocab caps tuned for token cost vs signal. 100 mastered + 50
  // learning gives the model a representative sample without bloating
  // the system block (each word is ~3-5 tokens — ~600 tokens total
  // versus ~1500 at the old caps). The model only ever uses a handful
  // per turn anyway.
  const mastered = vocab
    .filter((v) => v.status === "mastered")
    .slice(0, 100)
    .map((v) => v.word);
  const learning = vocab
    .filter((v) => v.status === "learning" || v.status === "review")
    .slice(0, 50)
    .map((v) => v.word);

  const lines: string[] = [base];
  if (mastered.length || learning.length) {
    lines.push("", "Student vocab (authoritative — these are the user's saved words):");
    if (mastered.length) lines.push(`Mastered (${mastered.length}): ${mastered.join(", ")}`);
    if (learning.length) lines.push(`Learning (${learning.length}): ${learning.join(", ")}`);
    lines.push(
      "Lean on these words; gloss any new ones briefly. If the user asks for their vocab list, output the lists above verbatim.",
    );
  } else {
    lines.push(
      "",
      "Student vocab: empty. If asked, say so honestly and point to click-to-define in the reader/chat.",
    );
  }

  // Due-today block — the SRS scheduler thinks these cards are ripe
  // for review. Mention them in the prompt so the tutor can weave the
  // words into conversation ("you saved 餐馆 yesterday, want to use it
  // in a sentence?"). We cap the rendered list to keep the prompt
  // tight; the model sees the words, not the FSRS metadata.
  if (dueVocab.length) {
    const dueWords = dueVocab.slice(0, 20).map((v) => v.word);
    lines.push(
      "",
      `Due for review today (${dueVocab.length} cards${dueVocab.length > dueWords.length ? `, showing ${dueWords.length}` : ""}): ${dueWords.join(", ")}.`,
      "When the conversation allows, gently work one or two of these into your reply so the student practises them in context. Don't list them or quiz them mechanically — just use them.",
    );
  }

  // Current focus — what the student opened most recently in the
  // library or reader. Lets the tutor proactively suggest topics
  // ("want to talk about restaurants?") instead of always waiting for
  // the student to set the direction.
  if (focus?.libraryItemTitle || focus?.chapterTitle) {
    const itemKindLabel = focus?.libraryItemKind ?? "material";
    const parts: string[] = [];
    if (focus?.libraryItemTitle) {
      parts.push(`${itemKindLabel} "${focus.libraryItemTitle}"`);
    }
    if (focus?.chapterTitle) {
      parts.push(
        focus.chapterPosition
          ? `chapter ${focus.chapterPosition}: "${focus.chapterTitle}"`
          : `chapter "${focus.chapterTitle}"`,
      );
    }
    lines.push(
      "",
      `Current study focus: the student is currently working through ${parts.join(", ")}.`,
      "If they open the chat without a clear question, you may proactively suggest practising the topic, vocabulary, or grammar from this material — phrase it as an invitation, not a demand.",
    );
  }

  // RAG: pull the top-K most relevant chunks from reader docs, notes,
  // textbook chapters, and past assistant replies.
  const ragBlock = formatHitsForPrompt(ragHits);
  if (ragBlock) lines.push(ragBlock);

  // Output + translation-blur rules. Kept tight — weaker models still
  // need the example pair to disambiguate translation (blur) from
  // grammar commentary (visible).
  lines.push(
    "",
    `Output: mirror the student — reply in ${target} when they write in ${target}; when they write in ${native} (or ask for an explanation), reply and explain in ${native}, keeping any example ${target} sentences in ${target}. No inline romanisation/pinyin (the click-to-define popover handles it).`,
    `Blur rule: wrap each ${native} sentence that translates/paraphrases a ${target} sentence in ((double parens)). One block per sentence. Always wrap, even when asked to translate.`,
    `Visible (do NOT wrap): grammar explanations, hints, single-word glosses (e.g. "蘋果 (apple)"), readings/pinyin, vocab-block tables, headings.`,
    `Right: ${target} sentence. ((English translation.))`,
    `Wrong: ${target} sentence. English translation.   ← unblurred`,
    `Vocab lists: when you give the student a set of words to learn, output a fenced \`\`\`vocab block (not prose, not a markdown table) — one word per line as "word | reading | meaning". reading = the ${target} pronunciation (pinyin/furigana; leave empty for languages without one); meaning = a short, direct ${native} translation — no example, no explanation. The app renders it as a table with one-tap save / add-to-list buttons. Always show these meanings and readings plainly; never wrap them in (( )).`,
  );

  lines.push("", TOOL_SYSTEM_INSTRUCTIONS);
  return lines.join("\n");
}
