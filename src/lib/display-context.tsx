import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

type DisplayContextValue = {
  showPinyin: boolean;
  setShowPinyin: (value: boolean) => void;
  togglePinyin: () => void;
  /** Global override for `((translation))` blurring in chat. When false
   *  (default), each translation span starts blurred and the user has
   *  to click to reveal it — the original "read target first" pedagogy.
   *  When true, every translation in the chat unblurs at once; useful
   *  when the user wants to skim a long reply. */
  showTranslations: boolean;
  setShowTranslations: (value: boolean) => void;
  toggleTranslations: () => void;
  /** True while the user holds Shift — used to "peek" highlights on mastered words. */
  shiftPressed: boolean;
};

const DisplayContext = createContext<DisplayContextValue | null>(null);

const PINYIN_KEY = "display.showPinyin";
const TRANSLATIONS_KEY = "display.showTranslations";

export function DisplayProvider({ children }: { children: ReactNode }) {
  const [showPinyin, setShowPinyinState] = useState<boolean>(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem(PINYIN_KEY) : null;
    return saved == null ? true : saved === "1";
  });
  const [showTranslations, setShowTranslationsState] = useState<boolean>(() => {
    const saved =
      typeof window !== "undefined" ? localStorage.getItem(TRANSLATIONS_KEY) : null;
    // Default OFF — the blurred-translation pedagogy is the whole
    // point. Users who hate it can flip the EN toggle and the choice
    // sticks.
    return saved === "1";
  });
  const [shiftPressed, setShiftPressed] = useState(false);

  useEffect(() => {
    localStorage.setItem(PINYIN_KEY, showPinyin ? "1" : "0");
  }, [showPinyin]);
  useEffect(() => {
    localStorage.setItem(TRANSLATIONS_KEY, showTranslations ? "1" : "0");
  }, [showTranslations]);

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftPressed(true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftPressed(false);
    };
    const onBlur = () => setShiftPressed(false);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const setShowPinyin = useCallback((value: boolean) => setShowPinyinState(value), []);
  const togglePinyin = useCallback(() => setShowPinyinState((p) => !p), []);
  const setShowTranslations = useCallback(
    (value: boolean) => setShowTranslationsState(value),
    [],
  );
  const toggleTranslations = useCallback(
    () => setShowTranslationsState((p) => !p),
    [],
  );

  return (
    <DisplayContext.Provider
      value={{
        showPinyin,
        setShowPinyin,
        togglePinyin,
        showTranslations,
        setShowTranslations,
        toggleTranslations,
        shiftPressed,
      }}
    >
      {children}
    </DisplayContext.Provider>
  );
}

export function useDisplay() {
  const ctx = useContext(DisplayContext);
  if (!ctx) throw new Error("useDisplay outside DisplayProvider");
  return ctx;
}
