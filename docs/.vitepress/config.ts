import { defineConfig } from "vitepress";

// VitePress config. Source: docs/**/*.md, output: docs/.vitepress/dist/.
//
// To preview locally:   npm run docs:dev
// To build for deploy:  npm run docs:build  (drops dist/ ready for any
//                       static host — Cloudflare Pages, Vercel, S3).
//
// The custom theme tweaks live in docs/.vitepress/theme/index.ts +
// docs/.vitepress/theme/custom.css. Keep the config focused on
// structure (nav, sidebar, head tags) and let the theme files own
// look-and-feel.

export default defineConfig({
  title: "Tokori",
  description: "Local-first AI tutor for language learners.",
  cleanUrls: true,
  lastUpdated: true,
  // Drops the default `mit` text in the "powered by" footer; we
  // surface our own license link in the page footer below.
  appearance: "dark",

  head: [
    ["link", { rel: "icon", type: "image/png", href: "/logo.png" }],
    ["link", { rel: "alternate icon", href: "/favicon.ico", sizes: "any" }],
    ["link", { rel: "apple-touch-icon", href: "/apple-touch-icon.png" }],
    // Fonts are self-hosted: Inter + JetBrains Mono ship via
    // @fontsource (imported from the theme entrypoint), and Charter
    // is bundled under /fonts/charter/ with @font-face declared in
    // custom.css. No Google Fonts / rsms.me CDN at runtime.
    // Open Graph + Twitter card for nice link previews.
    ["meta", { property: "og:title", content: "Tokori — Documentation" }],
    [
      "meta",
      {
        property: "og:description",
        content: "Local-first AI tutor for language learners.",
      },
    ],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
  ],

  themeConfig: {
    // Logo intentionally omitted — the bare wordmark in the navbar
    // (siteTitle) reads cleaner than the icon at small sizes. Bring
    // it back here if you ever ship a refined mark.
    siteTitle: "Tokori",

    // Top-bar nav. Keep it shallow — the sidebar handles depth.
    // Guide / API are rendered as a segmented pill toggle by our
    // custom Layout.vue (nav-bar-content-after slot), so they're
    // intentionally absent here. The right side also has theme and
    // GitHub icon buttons. We don't expose any other top-level nav
    // links — the docs surface is small enough that one toggle +
    // the sidebar is enough wayfinding.
    nav: [],

    // Per-section sidebar so the left pane changes when you navigate
    // between Guides and Reference. Keeps each section focused.
    sidebar: {
      "/guides/": [
        {
          text: "Get started",
          items: [
            { text: "Quickstart", link: "/guides/quickstart" },
            { text: "Install", link: "/guides/install" },
            { text: "Build from source", link: "/guides/build-from-source" },
          ],
        },
        {
          text: "Using Tokori",
          items: [
            { text: "Study guide", link: "/guides/study-guide" },
            { text: "Workspaces", link: "/guides/workspaces" },
            { text: "Providers", link: "/guides/providers" },
            { text: "Vocabulary & SRS", link: "/guides/vocabulary" },
            { text: "Reader", link: "/guides/reader" },
            { text: "Dictionaries", link: "/guides/dictionaries" },
          ],
        },
        {
          text: "Architecture",
          items: [
            { text: "How Tokori is built", link: "/guides/architecture" },
            { text: "Plugin SDK", link: "/guides/plugins" },
            { text: "Storage & data", link: "/guides/data" },
          ],
        },
        {
          text: "Automate & extend",
          items: [
            { text: "MCP server", link: "/guides/mcp" },
            { text: "Chat from your phone", link: "/guides/remote-pc" },
            { text: "Develop with a coding agent", link: "/guides/develop-with-an-agent" },
          ],
        },
        {
          text: "Project",
          items: [
            { text: "Contributing", link: "/guides/contributing" },
            { text: "FAQ", link: "/guides/faq" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Local HTTP API",
          items: [
            { text: "Overview", link: "/reference/api" },
            { text: "Auth", link: "/reference/auth" },
            { text: "Workspaces", link: "/reference/workspaces" },
            { text: "Vocabulary", link: "/reference/vocab" },
            { text: "Dictionaries", link: "/reference/dict" },
            { text: "Remote chat", link: "/reference/remote" },
            { text: "Errors", link: "/reference/errors" },
          ],
        },
        {
          text: "Schemas",
          items: [{ text: "Pack format", link: "/reference/pack-format" }],
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/tokoriai/tokori" },
    ],

    editLink: {
      pattern:
        "https://github.com/tokoriai/tokori/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    // Footer rendered under every content page. The homepage uses
    // `layout: page` (which skips the default footer), so index.md
    // includes the same strings inline via a hand-rolled <footer>.
    footer: {
      message: "AGPL-3.0 licensed.",
      copyright: "© 2026 Tokori contributors.",
    },

    // Local search — Pagefind-equivalent but built into VitePress.
    // No external service, no Algolia keys to manage.
    search: {
      provider: "local",
    },

    // Show the TOC for every page automatically.
    outline: { level: [2, 3], label: "On this page" },

    docFooter: { prev: "Previous", next: "Next" },
  },

  // Mark dist as static-friendly: no trailing slash redirects, no
  // server-rendered fallback. Cloudflare Pages serves it as-is.
  sitemap: {
    hostname: "https://docs.tokori.ai",
  },
});
