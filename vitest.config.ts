import { defineConfig } from "vitest/config"
import vue from "@vitejs/plugin-vue"

import pkg from "./package.json"

export default defineConfig({
  plugins: [vue()],
  // Mirrors the define in vite.config.ts: both read package.json, so the
  // value the tests see is the value the build ships (D19).
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
  },
})
