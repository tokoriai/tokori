<script setup lang="ts">
// Custom layout that wraps VitePress's default and injects the
// Tokori-flavoured chrome: a Guide / API pill toggle in the navbar
// right-side, a theme toggle that actually works, a GitHub icon,
// and a search button at the top of the sidebar instead of the
// navbar. The default theme's own search / theme / github controls
// are hidden via custom.css so we don't double up.
import { useData, useRouter } from "vitepress";
import { computed, onMounted, onUnmounted, ref } from "vue";
import DefaultTheme from "vitepress/theme";

const { Layout } = DefaultTheme;

const { page, frontmatter, isDark } = useData();
const router = useRouter();

// Which docs section the user is in. Drives the active state on
// the Guide / API pill toggle. We re-check on every route change
// so navigating between sections highlights the right pill.
const section = computed<"guide" | "api" | null>(() => {
  const p = page.value.relativePath;
  if (p.startsWith("guides/")) return "guide";
  if (p.startsWith("reference/")) return "api";
  return null;
});

// Open the local-search modal. VitePress installs a global
// keyboard listener for Cmd/Ctrl-K; dispatching the event is the
// public-API-free way to summon the modal from arbitrary UI.
function openSearch() {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "k",
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
    }),
  );
}

// Theme toggle — flip the .dark class on <html> and write the
// preference to the same localStorage key VitePress reads on boot.
// Doing the toggle ourselves (instead of going through the default
// theme's VPSwitchAppearance) means our CSS can fully restyle the
// button without breaking its click handler.
function toggleTheme() {
  const html = document.documentElement;
  const next = html.classList.contains("dark") ? "light" : "dark";
  html.classList.toggle("dark", next === "dark");
  try {
    localStorage.setItem("vitepress-theme-appearance", next);
  } catch {
    /* localStorage may be denied in private mode */
  }
}

// Detect platform once on mount so the search button's keyboard
// hint shows the right symbol (⌘ on Mac, Ctrl elsewhere).
const isMacLike = ref(false);
onMounted(() => {
  isMacLike.value = /Mac|iPhone|iPad/.test(navigator.platform);
});
</script>

<template>
  <Layout>
    <!-- Navbar right side: Guide / API toggle, theme button, GitHub. -->
    <template #nav-bar-content-after>
      <div class="tk-nav-right">
        <div class="tk-docs-toggle" v-if="section">
          <a
            href="/guides/quickstart"
            :aria-current="section === 'guide' ? 'page' : undefined"
            >Guide</a
          >
          <a
            href="/reference/api"
            :aria-current="section === 'api' ? 'page' : undefined"
            >API</a
          >
        </div>
        <button
          class="tk-icon-btn"
          type="button"
          @click="toggleTheme"
          aria-label="Toggle theme"
          title="Toggle light / dark"
        >
          <svg
            v-show="!isDark"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              d="M10.5 1.5a.75.75 0 0 0-.75.75v.07A8.25 8.25 0 1 0 17.68 10.25h.07a.75.75 0 0 0 0-1.5 6.75 6.75 0 0 1-7.25-7.25Z"
            />
          </svg>
          <svg
            v-show="isDark"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              d="M10 4a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0V5a1 1 0 0 1 1-1Zm0 11a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0v-1a1 1 0 0 1 1-1ZM4.22 4.22a1 1 0 0 1 1.42 0l.7.7a1 1 0 0 1-1.42 1.42l-.7-.7a1 1 0 0 1 0-1.42Zm9.46 9.46a1 1 0 0 1 1.42 0l.7.7a1 1 0 0 1-1.42 1.42l-.7-.7a1 1 0 0 1 0-1.42ZM3 10a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1Zm12 0a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2h-1a1 1 0 0 1-1-1ZM4.22 15.78a1 1 0 0 1 0-1.42l.7-.7a1 1 0 1 1 1.42 1.42l-.7.7a1 1 0 0 1-1.42 0Zm9.46-9.46a1 1 0 0 1 0-1.42l.7-.7a1 1 0 0 1 1.42 1.42l-.7.7a1 1 0 0 1-1.42 0ZM10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"
            />
          </svg>
        </button>
        <a
          class="tk-icon-btn"
          href="https://github.com/tokoriai/tokori"
          aria-label="GitHub"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path
              d="M12 .5C5.7.5.6 5.6.6 11.9c0 5 3.3 9.3 7.8 10.8.6.1.8-.2.8-.6v-2.1c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.7.4-1.3.7-1.6-2.5-.3-5.2-1.3-5.2-5.6 0-1.2.4-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2.9-.3 2-.4 3-.4s2 .1 3 .4c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.7.8 1.2 1.9 1.2 3.1 0 4.4-2.7 5.4-5.2 5.6.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6 4.5-1.5 7.8-5.8 7.8-10.8C23.4 5.6 18.3.5 12 .5z"
            />
          </svg>
        </a>
      </div>
    </template>

    <!-- Sidebar top: shadcn-style search trigger. -->
    <template #sidebar-nav-before>
      <button
        class="tk-sidebar-search"
        type="button"
        @click="openSearch"
        aria-label="Search the docs"
      >
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="9" cy="9" r="6" />
          <path d="m17 17-3.5-3.5" />
        </svg>
        <span class="tk-sidebar-search__label">Search docs</span>
        <kbd class="tk-sidebar-search__key">{{ isMacLike ? "⌘K" : "Ctrl K" }}</kbd>
      </button>
    </template>
  </Layout>
</template>
