import pkg from "./package.json"

/**
 * The one __APP_VERSION__ define, shared by vite.config.ts (the production
 * build) and vitest.config.ts (the tests) so that neither config can drift
 * from the other or silently lose the wiring on its own (D19). The value is
 * read from package.json — the same manifest a version bump edits. The two
 * imports of this module are pinned by the source gate in
 * src/__tests__/source-gates.test.ts.
 */
export const versionDefine = {
  __APP_VERSION__: JSON.stringify(pkg.version),
}
