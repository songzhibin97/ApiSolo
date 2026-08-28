import { defineConfig } from "vitest/config"
import vue from "@vitejs/plugin-vue"

import { versionDefine } from "./version-define"

export default defineConfig({
  plugins: [vue()],
  // The same define object vite.config.ts ships, imported from the one shared
  // module so the tests cannot pass against a copy that drifted (D19).
  define: versionDefine,
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
  },
})
