/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Canon's server serves ONE directory of static files and applies a strict
// `default-src 'self'` policy to it. Two consequences shape this config:
//
//   * everything must be same-origin — no CDN, no external font, no analytics.
//     That is the posture an auditable record should have and it is not
//     negotiable to save a build step;
//   * the output lands in `server/public-app/`, served alongside the existing
//     `public/`, so the React client ships BESIDE the current one rather than
//     replacing it. Routes migrate one at a time and anything not yet migrated
//     keeps working.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "../server/public-app"),
    emptyOutDir: true,
    // A budget, not a suggestion. This client is served to people opening a
    // knowledge base on a phone; when a chunk crosses this the build says so
    // rather than letting it drift a kilobyte at a time.
    chunkSizeWarningLimit: 250,
    rollupOptions: {
      output: {
        // Vendor split so the app's own code can change without re-downloading
        // React on every deploy.
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          query: ["@tanstack/react-query"],
        },
      },
    },
  },
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
