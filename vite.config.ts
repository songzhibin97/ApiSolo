import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

import pkg from "./package.json";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [vue(), tailwindcss()],

  // The one version string the interface is allowed to show. Injected at build
  // time from package.json so a version bump cannot leave the UI claiming the
  // old number (D19). vitest.config.ts carries the same define — the two
  // configs do not share this file's plugin set, but both read package.json,
  // so the value cannot drift between them.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }

          if (id.includes("@lezer")) {
            return "editor-parser";
          }

          if (id.includes("@codemirror/lang-")) {
            return "editor-languages";
          }

          if (id.includes("@codemirror") || id.includes("codemirror")) {
            return "editor-core";
          }

          if (id.includes("quickjs") || id.includes("@jitl")) {
            return "quickjs";
          }

          if (
            id.includes("/vue/") ||
            id.includes("vue-router") ||
            id.includes("vue-i18n") ||
            id.includes("pinia")
          ) {
            return "vue";
          }

          if (id.includes("lucide-vue-next")) {
            return "icons";
          }

          return "vendor";
        },
      },
    },
  },
}));
