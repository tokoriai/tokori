// Custom theme — extends VitePress's default and swaps in our
// Layout.vue, which injects:
//   • a Guide / API pill toggle in the navbar
//   • a working theme toggle (the default one fought with our CSS)
//   • a GitHub icon button
//   • a Search trigger at the top of the sidebar
//
// VitePress's own search / theme / github navbar widgets are
// hidden via custom.css so the two sets don't double up.

import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import Layout from "./Layout.vue";

// Self-hosted fonts — bundled via @fontsource so the docs work fully
// offline (no Google Fonts / rsms.me CDN at runtime). Charter is loaded
// by custom.css from /fonts/charter/* since there's no fontsource pkg.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";

import "./custom.css";

const theme: Theme = {
  extends: DefaultTheme,
  Layout,
};

export default theme;
