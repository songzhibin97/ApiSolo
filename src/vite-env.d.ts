/// <reference types="vite/client" />

/**
 * The app version, injected at build time from package.json by the `define`
 * blocks in vite.config.ts and vitest.config.ts (D19). This is the only
 * version string components may render.
 */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_APISOLO_DEV_BRIDGE_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
