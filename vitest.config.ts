import { defineConfig } from "vitest/config";
import path from "node:path";

// Mirrors the @/* alias from vite.config.ts so tests under /test
// can import from the same paths the app does. Keep these two
// configs in sync — Vitest doesn't auto-extend vite.config.ts when
// the latter uses non-test plugins (Tailwind, React) that the test
// runner doesn't need.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // Keep the runner fast: only collect tests under /test, not
    // sprinkled next to source. Co-located *.test.ts files would
    // mix into the bundler's resolution graph; a separate dir is
    // clearer for a small suite.
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
