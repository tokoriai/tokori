import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@/App";
import { SpotlightApp } from "@/spotlight-app";
import { VoiceAskApp } from "@/voice-ask-app";
import "@/index.css";
import { isDemoRequested, seedDemoData } from "@/lib/demo-seed";

function windowParam(name: string): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get(name) === "1";
}

async function bootstrap() {
  // The spotlight + voice-ask popups load the same bundle but with
  // `?spotlight=1` / `?voiceask=1` so they can render a tiny single-
  // purpose UI without paying for the full provider tree / shell.
  // Branch as early as possible. Both reuse the `is-spotlight` class:
  // it just makes the html/body/#root transparent for the frameless
  // rounded card.
  if (windowParam("spotlight")) {
    document.documentElement.classList.add("is-spotlight");
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <SpotlightApp />
      </StrictMode>,
    );
    return;
  }
  if (windowParam("voiceask")) {
    document.documentElement.classList.add("is-spotlight");
    // The voice pill is a deliberately always-dark overlay (Wispr-Flow
    // style): it floats over arbitrary desktop content, so it commits
    // to one look instead of following the app theme. Adding .dark
    // makes every theme token in this standalone webview resolve to
    // the dark palette.
    document.documentElement.classList.add("dark");
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <VoiceAskApp />
      </StrictMode>,
    );
    return;
  }

  // Pre-fill the in-memory store before the React tree mounts so providers
  // see the seeded workspace + vocab on first read. No-op outside ?demo=1.
  if (isDemoRequested()) {
    try {
      await seedDemoData();
    } catch (err) {
      // Don't block the page if seeding fails — the demo just shows empty state.
      console.warn("[demo-seed] failed", err);
    }
    // Live theme bridge: the marketing parent sends `tokori:theme`
    // postMessages when the user toggles the page theme. We flip
    // <html class="dark"> directly (mirrors what ProfileProvider
    // does) so the demo follows the parent without a reload.
    window.addEventListener("message", (event) => {
      const data = event.data as { kind?: string; theme?: string } | null;
      if (!data || data.kind !== "tokori:theme") return;
      if (data.theme !== "dark" && data.theme !== "light") return;
      const root = document.documentElement;
      root.classList.toggle("dark", data.theme === "dark");
      root.style.colorScheme = data.theme;
    });
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
