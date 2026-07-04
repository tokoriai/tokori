import { useEffect, useMemo, useState } from "react";
import { consumeSettingsIntent } from "@/lib/settings-intent";
import { HOSTED } from "@/lib/build-flags";
import type { LanguageCode } from "@/lib/languages";
import { useWorkspace } from "@/lib/workspace-context";
import {
  BookOpen,
  Cloud,
  Cpu,
  Database,
  Globe,
  Info,
  KeyRound,
  Languages,
  Layers,
  MessageSquare,
  Monitor,
  Plug,
  Puzzle,
  Smartphone,
  User,
  Volume2,
} from "lucide-react";
import { ProfileSection } from "@/components/settings/profile-section";
import { ProvidersSection } from "@/components/settings/providers-section";
import { PromptsSection } from "@/components/settings/prompts-section";
import { DictionariesSection } from "@/components/settings/dictionaries-section";
import { AnkiSection } from "@/components/settings/anki-section";
import { LocalApiSection } from "@/components/settings/local-api-section";
import { RemoteAccessSection } from "@/components/settings/remote-access-section";
import { CloudSection } from "@/components/settings/cloud-section";
import { StorageSection } from "@/components/settings/storage-section";
import { AboutSection } from "@/components/settings/about-section";
import { TTSSection } from "@/components/settings/tts-section";
import { TranslationSection } from "@/components/settings/translation-section";
import { StudySection } from "@/components/settings/study-section";
import { ChineseSection } from "@/components/settings/chinese-section";
import { DesktopSection } from "@/components/settings/desktop-section";
import { AddonsSection } from "@/components/settings/addons-section";
import { cn } from "@/lib/utils";
import {
  SidebarCollapser,
  useSidebarCollapse,
} from "@/components/sidebar-collapser";

type SettingsSection =
  | "profile"
  | "cloud"
  | "providers"
  | "prompts"
  | "dictionaries"
  | "translation"
  | "tts"
  | "study"
  | "chinese"
  | "anki"
  | "addons"
  | "local-api"
  | "remote-access"
  | "desktop"
  | "storage"
  | "about";

const SECTIONS: {
  id: SettingsSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
}[] = [
  { id: "profile", label: "Profile", icon: User, description: "Name, theme, language defaults" },
  { id: "cloud", label: "Cloud account", icon: Cloud, description: "Optional — sign in for credits" },
  { id: "providers", label: "Providers", icon: KeyRound, description: "Ollama, OpenAI, Anthropic, Gemini, Minimax" },
  { id: "prompts", label: "Tutor prompts", icon: MessageSquare, description: "Personas and system prompts" },
  { id: "dictionaries", label: "Dictionaries", icon: BookOpen, description: "CC-CEDICT and friends" },
  { id: "translation", label: "Translation", icon: Languages, description: "Engines used by Vocab Import" },
  { id: "tts", label: "Voice", icon: Volume2, description: "TTS provider and voice" },
  { id: "study", label: "Study", icon: Layers, description: "Per-workspace SRS settings + default study mode" },
  { id: "chinese", label: "Chinese", icon: Globe, description: "Script + pinyin tone colours (per workspace)" },
  { id: "anki", label: "Anki", icon: Layers, description: "Push vocab to Anki via AnkiConnect" },
  { id: "addons", label: "Addons", icon: Puzzle, description: "Community study modes, engines, importers (preview)" },
  { id: "local-api", label: "Local API", icon: Plug, description: "Expose to MCP clients" },
  { id: "remote-access", label: "Remote access", icon: Smartphone, description: "Chat from your phone using this PC's model" },
  { id: "desktop", label: "Desktop", icon: Monitor, description: "System tray + global search shortcut" },
  { id: "storage", label: "Storage", icon: Database, description: "Where your data lives" },
  { id: "about", label: "About", icon: Info, description: "Version & credits" },
];

// Sections that have no meaning on the hosted (cloud) build.
// `providers` is replaced by the synthesised cloud row (no UI needed),
// `dictionaries` / `knowledge` rely on filesystem access, `local-api`
// + `desktop` are Tauri-only, `anki` needs a local AnkiConnect server.
const HOSTED_HIDDEN_SECTIONS: ReadonlySet<SettingsSection> = new Set([
  "providers",
  "dictionaries",
  "anki",
  "addons",
  "local-api",
  "remote-access",
  "desktop",
  "storage",
]);

const BASE_VISIBLE_SECTIONS = HOSTED
  ? SECTIONS.filter((s) => !HOSTED_HIDDEN_SECTIONS.has(s.id))
  : SECTIONS;

// Sections that only apply to specific workspace languages. The
// section row hides itself from the sidebar when the active
// workspace isn't on the list. If a deep-link drops the user onto a
// hidden section anyway, the section component renders a soft
// "this doesn't apply here" notice rather than blowing up.
const LANG_SCOPED_SECTIONS: Partial<Record<SettingsSection, LanguageCode[]>> = {
  chinese: ["zh"],
};

export function SettingsView() {
  const { active: workspace } = useWorkspace();
  const [section, setSection] = useState<SettingsSection>("profile");

  // Filter the sidebar list based on the active workspace's
  // language. Chinese-specific settings only show on a Mandarin
  // workspace; future per-language sections plug into
  // LANG_SCOPED_SECTIONS the same way. Recomputes whenever the user
  // switches workspaces so the sidebar stays honest mid-session.
  const visibleSections = useMemo(() => {
    const lang = workspace?.targetLang ?? null;
    return BASE_VISIBLE_SECTIONS.filter((s) => {
      const required = LANG_SCOPED_SECTIONS[s.id];
      if (!required) return true;
      return lang != null && required.includes(lang as LanguageCode);
    });
  }, [workspace?.targetLang]);

  // If the user was viewing a now-hidden section (workspace switch
  // landed them somewhere irrelevant), bounce back to profile so
  // they don't see an empty pane.
  useEffect(() => {
    if (!visibleSections.some((s) => s.id === section)) {
      setSection("profile");
    }
  }, [visibleSections, section]);
  // Pending one-shot intent from a deep-link (e.g. the chat view's
  // "no provider" buttons asking us to pop the Add Provider dialog).
  // We consume it on mount so a later tab-switch back to settings
  // doesn't reopen the dialog.
  const [openAddProvider, setOpenAddProvider] = useState(false);
  const { open: sidebarOpen, toggle: toggleSidebar } = useSidebarCollapse(
    "settings.sidebarOpen",
  );

  useEffect(() => {
    const intent = consumeSettingsIntent();
    if (intent === "addProvider") {
      setSection("providers");
      setOpenAddProvider(true);
    } else if (intent === "openDictionaries") {
      setSection("dictionaries");
    } else if (intent === "openTTS") {
      setSection("tts");
    } else if (intent === "openCloud") {
      setSection("cloud");
    }
  }, []);

  return (
    <div className="relative flex h-full">
      {sidebarOpen && (
      <aside className="flex w-[220px] shrink-0 flex-col gap-0.5 border-r border-border px-3 py-6">
        <h2 className="px-2.5 pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Settings
        </h2>
        {visibleSections.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setSection(id)}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13.5px] transition-colors",
              section === id
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
        <div className="mt-auto px-2.5 pt-4 text-[10.5px] text-muted-foreground">
          <Cpu className="mb-1 size-3" />
          Local-first · everything stays on this machine
        </div>
      </aside>
      )}

      <SidebarCollapser
        open={sidebarOpen}
        onToggle={toggleSidebar}
        width={220}
        visibleLabel="Hide settings nav"
        hiddenLabel="Show settings nav"
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl xl:max-w-4xl 2xl:max-w-5xl px-8 py-8">
          {section === "profile" && <ProfileSection />}
          {section === "cloud" && <CloudSection />}
          {section === "providers" && (
            <ProvidersSection
              openAddOnMount={openAddProvider}
              onAddOpened={() => setOpenAddProvider(false)}
            />
          )}
          {section === "prompts" && <PromptsSection />}
          {section === "dictionaries" && <DictionariesSection />}
          {section === "translation" && <TranslationSection />}
          {section === "tts" && <TTSSection />}
          {section === "study" && <StudySection />}
          {section === "chinese" && <ChineseSection />}
          {section === "anki" && <AnkiSection />}
          {section === "addons" && <AddonsSection />}
          {section === "local-api" && <LocalApiSection />}
          {section === "remote-access" && <RemoteAccessSection />}
          {section === "desktop" && <DesktopSection />}
          {section === "storage" && <StorageSection />}
          {section === "about" && <AboutSection />}
        </div>
      </div>
    </div>
  );
}
