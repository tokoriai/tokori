// Desktop / Global Search settings.
//
// Optional power-user feature: when enabled, Tokori stays in the
// system tray after the main window is closed and registers an OS-
// level shortcut (default Ctrl/Cmd+Shift+F) that pops a small
// spotlight popup from anywhere — useful for quick dictionary
// look-ups while you're in a browser, IDE, or any other app.
//
// The toggle + chosen shortcut persist in the settings table; on app
// boot, a top-level effect (DesktopSync) re-applies them so the
// feature survives a relaunch.

import { useEffect, useRef, useState } from "react";
import { Keyboard, Loader2, Power, RotateCcw, Sparkles } from "lucide-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { getSetting, setSetting } from "@/lib/db";
import {
  DEFAULT_GLOBAL_SHORTCUT,
  GLOBAL_SEARCH_ENABLED_KEY,
  GLOBAL_SEARCH_SHORTCUT_KEY,
} from "@/lib/global-search";
import { cn } from "@/lib/utils";

export function DesktopSection() {
  const [enabled, setEnabled] = useState(false);
  const [shortcut, setShortcut] = useState(DEFAULT_GLOBAL_SHORTCUT);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      const [e, s] = await Promise.all([
        getSetting(GLOBAL_SEARCH_ENABLED_KEY),
        getSetting(GLOBAL_SEARCH_SHORTCUT_KEY),
      ]);
      setEnabled(e === "1");
      if (s) setShortcut(s);
      setLoaded(true);
    })();
  }, []);

  async function applyAndPersist(nextEnabled: boolean, nextShortcut: string) {
    if (!isTauri()) {
      toast.error("Desktop feature only works in the bundled app");
      return;
    }
    setBusy(true);
    try {
      await invoke("set_global_search_enabled", {
        enabled: nextEnabled,
        shortcut: nextShortcut,
      });
      await Promise.all([
        setSetting(GLOBAL_SEARCH_ENABLED_KEY, nextEnabled ? "1" : "0"),
        setSetting(GLOBAL_SEARCH_SHORTCUT_KEY, nextShortcut),
      ]);
      setEnabled(nextEnabled);
      setShortcut(nextShortcut);
      if (nextEnabled) {
        toast.success(`Global search active`, {
          description: `Press ${nextShortcut.replace(/CmdOrCtrl/g, "Ctrl/⌘")} from anywhere.`,
        });
      } else {
        toast.success("Global search disabled");
      }
    } catch (err) {
      toast.error("Couldn't apply global search settings", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-serif text-2xl tracking-tight">Desktop</h2>
        <p className="mt-1 text-[13.5px] text-muted-foreground">
          OS-level integrations — keep Tokori in the system tray and
          summon a quick search popup with a global shortcut.
        </p>
      </div>

      <section className="rounded-2xl border border-border bg-card px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold tracking-tight">
              Global search
            </h3>
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              When on, Tokori minimises to the system tray instead of
              quitting, and the chosen shortcut opens a spotlight popup
              from anywhere on your desktop.
            </p>
          </div>
          <Button
            size="sm"
            variant={enabled ? "outline" : "default"}
            onClick={() => void applyAndPersist(!enabled, shortcut)}
            disabled={busy || !loaded}
            className="shrink-0"
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : enabled ? (
              <Power className="size-3.5" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            {enabled ? "Disable" : "Enable"}
          </Button>
        </div>

        <div className="mt-4 grid gap-2 border-t border-border/60 pt-4">
          <Label htmlFor="global-shortcut" className="text-[12px]">
            Shortcut
          </Label>
          <div className="flex items-center gap-2">
            <ShortcutRecorder
              value={shortcut}
              onCapture={(next) => {
                setShortcut(next);
                // Auto-apply if the feature is on so the new key
                // combo takes effect immediately. Otherwise just
                // remember it; next "Enable" click will register it.
                if (enabled) void applyAndPersist(true, next);
                else void setSetting(GLOBAL_SEARCH_SHORTCUT_KEY, next);
              }}
              disabled={busy || !loaded}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setShortcut(DEFAULT_GLOBAL_SHORTCUT);
                if (enabled) void applyAndPersist(true, DEFAULT_GLOBAL_SHORTCUT);
                else void setSetting(GLOBAL_SEARCH_SHORTCUT_KEY, DEFAULT_GLOBAL_SHORTCUT);
              }}
              disabled={busy || !loaded || shortcut === DEFAULT_GLOBAL_SHORTCUT}
              title="Reset to default"
            >
              <RotateCcw className="size-3.5" />
              Reset
            </Button>
          </div>
          <p className="text-[11.5px] text-muted-foreground">
            Click the box, then press the key combination you want — modifier(s) plus a key.
            Use the Reset button to go back to{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
              {DEFAULT_GLOBAL_SHORTCUT}
            </code>
            . Avoid Ctrl+F unless you're OK losing browser
            "find on page" while Tokori is running.
          </p>
        </div>
      </section>
    </div>
  );
}

// ─── Shortcut recorder ───────────────────────────────────────────────────
//
// Click-to-record control. Pressing the box puts it into "listening"
// mode; the next non-modifier keypress is captured and translated
// into a Tauri accelerator string ("CmdOrCtrl+Shift+F", "Alt+Space",
// etc.). Esc cancels without changing the value. Standalone modifier
// keys (Ctrl by itself) aren't accepted — we wait for a real key.
//
// All keydowns while listening are swallowed (preventDefault +
// stopPropagation in the capture phase) so the user's chosen combo
// doesn't accidentally trigger something else in the app.

function ShortcutRecorder({
  value,
  onCapture,
  disabled,
}: {
  value: string;
  onCapture: (accelerator: string) => void;
  disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!recording) return;
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      // Cancel on Escape — common convention.
      if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setRecording(false);
        return;
      }
      // Ignore standalone modifier keypresses; wait for a real key.
      if (
        e.key === "Control" ||
        e.key === "Shift" ||
        e.key === "Alt" ||
        e.key === "Meta" ||
        e.key === "AltGraph" ||
        e.key === "OS"
      ) {
        return;
      }
      const accel = formatShortcut(e);
      if (!accel) return;
      onCapture(accel);
      setRecording(false);
    }
    // Capture phase so this fires before any in-app handler can react.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onCapture]);

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={() => !disabled && setRecording(true)}
      onBlur={() => setRecording(false)}
      disabled={disabled}
      aria-label="Record keyboard shortcut"
      className={cn(
        "flex h-10 flex-1 items-center justify-between gap-2 rounded-md border px-3 font-mono text-[12.5px] transition-colors",
        recording
          ? "border-foreground/60 bg-accent/40 text-foreground ring-2 ring-foreground/30"
          : "border-input bg-background text-foreground hover:border-foreground/40",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span className="flex items-center gap-2 truncate">
        <Keyboard className="size-3.5 text-muted-foreground" />
        {recording ? (
          <span className="text-muted-foreground">
            Press a key combination…
          </span>
        ) : (
          <span>{value || "Click to set a shortcut"}</span>
        )}
      </span>
      {recording && (
        <kbd className="shrink-0 rounded border border-border bg-card px-1 py-0.5 text-[10px] text-muted-foreground">
          Esc to cancel
        </kbd>
      )}
    </button>
  );
}

/** Translate a browser keydown into a Tauri accelerator string. */
function formatShortcut(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  // Treat Ctrl and Meta as the same primary modifier so a Mac user
  // pressing Cmd and a Windows/Linux user pressing Ctrl produce the
  // same accelerator string ("CmdOrCtrl+...").
  if (e.ctrlKey || e.metaKey) parts.push("CmdOrCtrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  const key = normalizeKey(e);
  if (!key) return null;

  // Reject single-key shortcuts that don't include a modifier and
  // aren't function keys — too easy to trigger accidentally
  // (a global "F" key would hijack every text field on the system).
  const isFn = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
  if (parts.length === 0 && !isFn) return null;

  parts.push(key);
  return parts.join("+");
}

/** Normalise a KeyboardEvent into Tauri's accelerator key vocabulary. */
function normalizeKey(e: KeyboardEvent): string | null {
  const { key, code } = e;
  // Pure modifier presses don't form valid accelerators.
  if (
    key === "Control" ||
    key === "Shift" ||
    key === "Alt" ||
    key === "Meta" ||
    key === "AltGraph" ||
    key === "OS"
  ) {
    return null;
  }
  // Function keys.
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  // Letters: derive from the physical key code so "Shift+a" still
  // becomes "A" rather than the shifted-printable.
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  // Digits.
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  // Numpad digits.
  if (/^Numpad[0-9]$/.test(code)) return code;
  // Common named keys (browser KeyboardEvent.key → Tauri accelerator).
  const named: Record<string, string> = {
    " ": "Space",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Escape",
    CapsLock: "CapsLock",
    ",": "Comma",
    ".": "Period",
    "/": "Slash",
    ";": "Semicolon",
    "=": "Equal",
    "-": "Minus",
    "[": "BracketLeft",
    "]": "BracketRight",
    "\\": "Backslash",
    "'": "Quote",
    "`": "Backquote",
  };
  if (named[key]) return named[key];
  // Single-character fallback (uppercased letters / printable symbols).
  if (key.length === 1) return key.toUpperCase();
  // Anything else (e.g. multi-char dead keys) is rejected.
  return null;
}
