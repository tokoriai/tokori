import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { getSetting, setSetting } from "./db";
import type { LanguageCode } from "./languages";
import type { LevelInfo, ScaleKind } from "./level";

/** "auto" defers to scaleFor(workspace.targetLang). "custom" requires
 *  `customScale` to be populated. */
export type LevelScaleChoice = "auto" | ScaleKind | "custom";

export type Theme = "light" | "dark" | "system";

export type Profile = {
  name: string;
  theme: Theme;
  defaultNativeLang: LanguageCode;
  /** Optional user-set goal level id (e.g. "HSK 4", "B2"). null = auto. */
  goalLevel: string | null;
  /** Manual override for the estimated current level. Useful for users
   *  who already know the language somewhat — the auto-computed level
   *  starts at zero and would otherwise lie about their ability. null
   *  means "let the score-based formula decide". */
  manualLevelId: string | null;
  /** Manual override for the level/progress score. When set, the
   *  dashboard's level computation uses this number instead of
   *  `vocabKnown + 1.5 × hours`. null means auto. */
  manualScore: number | null;
  /** Which level scale to use. "auto" follows the workspace's
   *  language (Chinese → HSK, Japanese → JLPT, Korean → TOPIK,
   *  everything else → CEFR). User can override to any scale. */
  levelScale: LevelScaleChoice;
  /** User-defined level rungs, used when `levelScale === "custom"`.
   *  Stored verbatim — the dashboard renders these instead of HSK /
   *  CEFR. */
  customScale: LevelInfo[] | null;
  /** Dictation engine for the composer's mic button.
   *  "auto"    — prefer the browser's Web Speech API, then a
   *              downloaded local Whisper model, then Whisper via the
   *              first openai-kind provider with a key. This is what
   *              most users want; specifically important on Linux
   *              where the WebKitGTK webview doesn't support Web
   *              Speech at all.
   *  "browser" — force Web Speech; fail if unavailable.
   *  "whisper" — always go via the configured openai-kind provider's
   *              /v1/audio/transcriptions endpoint. Slightly slower
   *              than browser STT but works anywhere a key works.
   *  "local"   — on-device whisper.cpp (desktop only). Needs a model
   *              downloaded under Settings → Voice → Dictation. */
  sttKind: "auto" | "browser" | "whisper" | "local";
};

const DEFAULT_PROFILE: Profile = {
  name: "",
  theme: "system",
  defaultNativeLang: "en",
  goalLevel: null,
  manualLevelId: null,
  manualScore: null,
  levelScale: "auto",
  customScale: null,
  sttKind: "auto",
};

type ProfileContextValue = {
  profile: Profile;
  loading: boolean;
  update: (patch: Partial<Profile>) => Promise<void>;
};

const ProfileContext = createContext<ProfileContextValue | null>(null);

const KEY_PREFIX = "profile.";

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getSetting(`${KEY_PREFIX}name`),
      getSetting(`${KEY_PREFIX}theme`),
      getSetting(`${KEY_PREFIX}defaultNativeLang`),
      getSetting(`${KEY_PREFIX}goalLevel`),
      getSetting(`${KEY_PREFIX}manualLevelId`),
      getSetting(`${KEY_PREFIX}manualScore`),
      getSetting(`${KEY_PREFIX}levelScale`),
      getSetting(`${KEY_PREFIX}customScale`),
      getSetting(`${KEY_PREFIX}sttKind`),
    ])
      .then(
        ([
          name,
          theme,
          defaultNativeLang,
          goalLevel,
          manualLevelId,
          manualScore,
          levelScale,
          customScale,
          sttKind,
        ]) => {
          if (cancelled) return;
          // manualScore is stored as a string in the settings table; parse
          // back to number, accepting empty string as "auto" (null).
          const parsedScore = manualScore && manualScore.length > 0
            ? Number(manualScore)
            : NaN;
          // customScale is JSON-encoded LevelInfo[]. Be defensive — a
          // bad row shouldn't crash the dashboard.
          let parsedCustom: LevelInfo[] | null = null;
          if (customScale) {
            try {
              const raw = JSON.parse(customScale);
              if (Array.isArray(raw)) parsedCustom = raw as LevelInfo[];
            } catch {
              /* ignore — fall back to null */
            }
          }
          setProfile({
            name: name ?? "",
            theme: (theme as Theme) ?? "system",
            defaultNativeLang: (defaultNativeLang as LanguageCode) ?? "en",
            goalLevel: goalLevel || null,
            manualLevelId: manualLevelId || null,
            manualScore: Number.isFinite(parsedScore) ? parsedScore : null,
            levelScale: ((levelScale as LevelScaleChoice) || "auto"),
            customScale: parsedCustom,
            sttKind:
              sttKind === "browser" ||
              sttKind === "whisper" ||
              sttKind === "local"
                ? sttKind
                : "auto",
          });
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const apply = (mode: "light" | "dark") => {
      root.classList.toggle("dark", mode === "dark");
      root.style.colorScheme = mode;
    };
    if (profile.theme === "system") {
      const m = window.matchMedia("(prefers-color-scheme: dark)");
      apply(m.matches ? "dark" : "light");
      const handler = (ev: MediaQueryListEvent) =>
        apply(ev.matches ? "dark" : "light");
      m.addEventListener("change", handler);
      return () => m.removeEventListener("change", handler);
    }
    apply(profile.theme);
  }, [profile.theme]);

  async function update(patch: Partial<Profile>) {
    const next = { ...profile, ...patch };
    setProfile(next);
    await Promise.all(
      Object.entries(patch).map(([k, v]) => {
        // Objects / arrays (customScale) need JSON; everything else
        // gets the plain string coercion that's been used since the
        // settings table was added.
        const serialised =
          v === null || v === undefined
            ? ""
            : typeof v === "object"
              ? JSON.stringify(v)
              : String(v);
        return setSetting(`${KEY_PREFIX}${k}`, serialised);
      }),
    );
  }

  return (
    <ProfileContext.Provider value={{ profile, loading, update }}>
      {children}
    </ProfileContext.Provider>
  );
}

export function useProfile() {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error("useProfile outside ProfileProvider");
  return ctx;
}

