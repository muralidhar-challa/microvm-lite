import { defineConfig } from "vite";

// Bundles process-worker.ts into a single ES module the browser can load
// directly as `new Worker(url, { type: "module" })` — browsers can't
// execute .ts, so this replaces the old `deno bundle` step.
export default defineConfig({
  build: {
    outDir: "scripts",
    emptyOutDir: false,
    lib: {
      entry: "scripts/process-worker.ts",
      formats: ["es"],
      fileName: () => "process-worker.bundle.js",
    },
  },
});
