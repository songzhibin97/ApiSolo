/**
 * Frontend mirrors of the Rust byte caps. There is no cross-language constant
 * sharing in this repository, so each value here MUST stay equal to its Rust
 * counterpart in `src-tauri/src/lib.rs`; `src/__tests__/source-gates.test.ts`
 * reads that file and fails the build when either pair drifts apart.
 */

/** Must equal Rust `MAX_UPLOAD_PART_BYTES` (per-part upload cap, checked before the file is read). */
export const MAX_UPLOAD_FILE_BYTES = 16 * 1024 * 1024

/** Must equal Rust `MAX_RESPONSE_WIRE_BYTES` (network read cap shown in the truncation notice). */
export const MAX_RESPONSE_WIRE_BYTES = 16 * 1024 * 1024

/** "16 MiB" for whole values, "16.2 MiB" otherwise — for i18n interpolation. */
export function formatBytesAsMib(bytes: number): string {
  const mib = bytes / (1024 * 1024)
  return `${Number.isInteger(mib) ? String(mib) : mib.toFixed(1)} MiB`
}
