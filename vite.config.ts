import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { createRequire } from "node:module";

const host = process.env.TAURI_DEV_HOST;

// Read the package version once at config time so it can be inlined as
// a constant. The About screen uses it as a non-flashing fallback while
// the live Tauri `getVersion()` resolves, and as the only version source
// in the hosted/browser build where that API doesn't exist.
const pkgVersion = createRequire(import.meta.url)("./package.json").version as string;

export default defineConfig(async () => ({
  // Relative asset paths so the same build works whether it's loaded from
  // tauri://localhost (desktop) or /demo/ on the marketing site (web).
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  build: {
    // Split heavyweight deps into their own chunks so the main entry
    // bundle stays small and these libs can be cached independently
    // across releases. This uses rolldown's native `codeSplitting`
    // groups rather than the legacy `manualChunks` function: with
    // manualChunks, rolldown parks unmatched shared modules (e.g.
    // Vite's dynamic-import preload helper) inside whichever manual
    // chunk it likes, which made the 400 kB pdfjs chunk an eager
    // dependency of the entry. Groups only capture what their test
    // matches; shared glue stays in common chunks.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // Highest priority: shared glue that must never be dragged
            // into a heavyweight vendor chunk. Groups capture their
            // matches' dependencies recursively, and a lower-priority
            // group that swallows e.g. clsx or the preload helper makes
            // every eager module depend on that whole vendor chunk.
            {
              name: "glue",
              test: /vite[\\/](preload-helper|modulepreload-polyfill)/,
              priority: 100,
            },
            {
              // react + the tiny ecosystem shims shared by both the app
              // and the big vendor libs (recharts pulls react-redux →
              // use-sync-external-store; react-markdown pulls
              // jsx-runtime). All of this is eager anyway.
              name: "vendor-react",
              test: /node_modules[\\/](react|react-dom|scheduler|use-sync-external-store|react-is|clsx)[\\/]/,
              priority: 90,
            },
            { name: "vendor-pdfjs", test: /node_modules[\\/]pdfjs-dist[\\/]/ },
            { name: "vendor-hanzi", test: /node_modules[\\/]hanzi-writer/ },
            {
              name: "vendor-charts",
              test: /node_modules[\\/](recharts|victory-vendor|d3-[^\\/]+)[\\/]/,
            },
            {
              name: "vendor-markdown",
              test: /node_modules[\\/](react-markdown|remark-[^\\/]+|micromark[^\\/]*|mdast-[^\\/]+|hast-[^\\/]+|unified|vfile[^\\/]*)[\\/]/,
            },
            { name: "vendor-radix", test: /node_modules[\\/](@radix-ui|radix-ui)[\\/]/ },
            { name: "vendor-icons", test: /node_modules[\\/]lucide-react[\\/]/ },
            { name: "vendor-dnd", test: /node_modules[\\/]@dnd-kit[\\/]/ },
          ],
        },
      },
    },
    // Views are route-level code-split in the shell (React.lazy +
    // idle prefetch), so the entry chunk is app plumbing + contexts
    // only. Anything creeping past this limit again means a heavy
    // dep landed in the eager graph and deserves a look.
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 5174 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
