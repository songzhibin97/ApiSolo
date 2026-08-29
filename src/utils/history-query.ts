import type { KeyValuePair } from "../types"
import { REDACTION_SENTINEL } from "./redaction"
import { deriveParamsFromUrl } from "./url-params"

/**
 * Merge the two ordered query copies carried by an imported request.
 *
 * Exact (key, value) pairs cancel one-for-one. The URL may then contribute at
 * most its per-key row surplus, so a stale value cannot duplicate a row while
 * genuinely repeated URL rows are not discarded. Marker reconciliation is an
 * import-only step; after this returns, the row is the authoritative carrier.
 * See the marker contract on `KeyValuePair.redacted`.
 */
export function mergeHistoryQueryRows(
  stored: KeyValuePair[],
  rawUrl: string,
): KeyValuePair[] {
  const fromUrl = deriveParamsFromUrl(rawUrl)
  const claimedStored = new Set<number>()
  const unmatchedUrl: KeyValuePair[] = []

  for (const urlRow of fromUrl) {
    const match = stored.findIndex(
      (storedRow, index) =>
        !claimedStored.has(index) &&
        storedRow.key === urlRow.key &&
        storedRow.value === urlRow.value,
    )

    if (match === -1) {
      unmatchedUrl.push(urlRow)
    } else {
      claimedStored.add(match)
    }
  }

  const storedCounts = countByKey(stored)
  const urlCounts = countByKey(fromUrl)
  const contributedCounts = new Map<string, number>()
  const urlContribution = unmatchedUrl.filter((row) => {
    const limit = Math.max(0, (urlCounts.get(row.key) ?? 0) - (storedCounts.get(row.key) ?? 0))
    const used = contributedCounts.get(row.key) ?? 0

    if (used >= limit) {
      return false
    }

    contributedCounts.set(row.key, used + 1)
    return true
  })

  const wasBlanked = (row: KeyValuePair) =>
    row.value.trim() === REDACTION_SENTINEL || row.redacted === true
  const blankedKeys = new Set([...stored, ...fromUrl].filter(wasBlanked).map((row) => row.key))

  return [...stored, ...urlContribution].map((row) => {
    if (row.value.trim() === REDACTION_SENTINEL) {
      return { ...row, value: "", redacted: true }
    }

    return row.value === "" && blankedKeys.has(row.key) ? { ...row, redacted: true } : row
  })
}

function countByKey(rows: KeyValuePair[]): Map<string, number> {
  const counts = new Map<string, number>()

  for (const row of rows) {
    counts.set(row.key, (counts.get(row.key) ?? 0) + 1)
  }

  return counts
}
