import type { KeyValuePair } from "../types"
import { isTemplateSpan, splitTemplateSpans, splitUrlParts } from "./url-query"

/**
 * The URL bar ↔ params ↔ wire loop. Its correctness target is matching the
 * bytes *this app itself* sends: Rust builds the query with
 * `Url::query_pairs_mut()`, i.e. `form_urlencoded`, so a space is `+`, not
 * `%20`. `url-query.ts` owns the other target — reproducing what the user typed
 * for external tools — and encodes a space as `%20`. Do not merge the two.
 */

export function toParsableUrl(rawUrl: string) {
  return rawUrl.includes("://") ? rawUrl : `http://placeholder${rawUrl.startsWith("/") || rawUrl.startsWith("?") ? "" : "/"}${rawUrl}`
}

/**
 * Select the old rows that survive a group shrink.
 * See `KeyValuePair.redacted` for the marker contract this selection preserves.
 */
export function pickSurvivors<T extends KeyValuePair>(rows: T[], count: number): T[] {
  if (count <= 0) {
    return []
  }

  if (count >= rows.length) {
    return [...rows]
  }

  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const markerOrder = Number(right.row.redacted === true) - Number(left.row.redacted === true)
      return markerOrder || left.index - right.index
    })
    .slice(0, count)
    .map(({ row }) => row)
}

function participatesInUrl(item: KeyValuePair): boolean {
  return item.enabled && Boolean(item.key.trim())
}

export function syncParamsFromUrl(rawUrl: string, currentParams: KeyValuePair[]) {
  try {
    const parsed = new URL(toParsableUrl(rawUrl))
    const entries = [...parsed.searchParams.entries()]
    const candidates = currentParams.filter(participatesInUrl)
    const passthrough = currentParams.filter((item) => !participatesInUrl(item))
    const claimedRows = new Set<KeyValuePair>()
    const claimedEntries = new Set<number>()
    const byEntry = new Map<number, KeyValuePair>()

    function matchGroups(
      tupleOfRow: (row: KeyValuePair) => readonly string[],
      tupleOfEntry: (entry: [string, string]) => readonly string[],
      selectRows: (rows: KeyValuePair[], count: number) => KeyValuePair[],
    ) {
      const entryGroups = new Map<string, number[]>()
      const groupKey = (parts: readonly string[]) => JSON.stringify(parts)

      entries.forEach((entry, index) => {
        if (claimedEntries.has(index)) {
          return
        }
        const group = groupKey(tupleOfEntry(entry))
        const indexes = entryGroups.get(group)
        if (indexes) {
          indexes.push(index)
        } else {
          entryGroups.set(group, [index])
        }
      })

      for (const [group, entryIndexes] of entryGroups) {
        const rows = candidates.filter(
          (row) => !claimedRows.has(row) && groupKey(tupleOfRow(row)) === group,
        )
        const survivors = selectRows(rows, Math.min(rows.length, entryIndexes.length))

        survivors.forEach((row, offset) => {
          const entryIndex = entryIndexes[offset]
          const [key, value] = entries[entryIndex]
          claimedRows.add(row)
          claimedEntries.add(entryIndex)
          byEntry.set(entryIndex, { ...row, key, value })
        })
      }
    }

    // Stage 1: exact decoded key and value.
    matchGroups(
      (row) => [row.key, row.value],
      ([key, value]) => [key, value],
      (rows, count) => pickSurvivors(rows, count),
    )
    // Stage 2: the same key with a user-edited value.
    matchGroups(
      (row) => [row.key],
      ([key]) => [key],
      (rows, count) => pickSurvivors(rows, count),
    )

    // Stage 3: remaining rows and entries pair in order, after marked-first
    // survivor selection. Mutating the three call sites independently is how
    // the phase-specific regression tests prove each phase is connected.
    const remainingRows = candidates.filter((row) => !claimedRows.has(row))
    const remainingEntryIndexes = entries.map((_, index) => index).filter((index) => !claimedEntries.has(index))
    const survivors = pickSurvivors(
      remainingRows,
      Math.min(remainingRows.length, remainingEntryIndexes.length),
    )

    survivors.forEach((row, offset) => {
      const entryIndex = remainingEntryIndexes[offset]
      const [key, value] = entries[entryIndex]
      claimedRows.add(row)
      claimedEntries.add(entryIndex)
      byEntry.set(entryIndex, { ...row, key, value })
    })

    const params = entries.map(([key, value], index) =>
      byEntry.get(index) ?? {
        id: crypto.randomUUID(),
        enabled: true,
        key,
        value,
        description: "",
      },
    )
    const { baseUrl, hash } = splitUrlParts(rawUrl)
    return { url: `${baseUrl}${hash}`, params: [...params, ...passthrough] }
  } catch {
    return { url: rawUrl, params: currentParams }
  }
}

/**
 * A url's query read as rows, with no reconciliation against anything: fresh
 * handles, no markers, disabled rows impossible. It is the one place this app
 * reads a query string into rows — `syncParamsFromUrl` above and the history
 * readers all end up here — because a second parser is a second thing to keep
 * in step with `form_urlencoded`.
 *
 * `toParsableUrl` is load-bearing rather than tidy. Bare `new URL` throws on a
 * relative url and on one that starts with a `{{template}}`, and a throw here
 * reads as "this url has no query": the parameters are not reported missing,
 * they are silently not there.
 */
export function deriveParamsFromUrl(rawUrl: string): KeyValuePair[] {
  try {
    return [...new URL(toParsableUrl(rawUrl)).searchParams.entries()].map(([key, value]) => ({
      id: crypto.randomUUID(),
      enabled: true,
      key,
      value,
      description: "",
    }))
  } catch {
    return []
  }
}

/**
 * Percent-encode one query component the way `form_urlencoded` does — space as
 * `+` — while leaving `{{…}}` template spans verbatim. Encoding a template
 * turns `{{apiKey}}` into `%7B%7BapiKey%7D%7D`, which is what made the URL bar
 * display a string the user never typed and never sent.
 */
export function encodeFormComponentPreservingTemplates(value: string): string {
  return splitTemplateSpans(value)
    .map((segment) => {
      if (isTemplateSpan(segment)) {
        return segment
      }

      const encoded = new URLSearchParams()
      encoded.append("k", segment)
      return encoded.toString().slice(2)
    })
    .join("")
}

/**
 * Render the URL bar's display string from the stored base URL and params.
 *
 * **Never give this function `tab.auth`.** The backend appends an
 * `auth.type === "api-key" && addTo === "query"` pair *after* these params, and
 * that pair is deliberately absent here: its value is usually the secret
 * itself, and the URL bar is a string people copy and screenshot. Making this
 * function "more complete" means rendering a credential into an address bar.
 *
 * The filter mirrors the backend's `item.enabled && !item.key.trim().is_empty()`
 * so a whitespace-only key is ignored on both sides.
 */
export function buildUrlWithParams(rawUrl: string, params: KeyValuePair[]) {
  const { baseUrl, hash } = splitUrlParts(rawUrl)
  const query = params
    .filter((item) => item.enabled && item.key.trim())
    .map(
      (item) =>
        `${encodeFormComponentPreservingTemplates(item.key)}=${encodeFormComponentPreservingTemplates(item.value)}`,
    )
    .join("&")

  return `${baseUrl}${query ? `?${query}` : ""}${hash}`
}

/**
 * Variable names referenced anywhere in the displayed URL — path and query
 * alike — de-duplicated, in order of appearance. Runs against the *displayed*
 * string, which is why the query half only works once templates survive
 * encoding.
 */
export function detectTemplateVariables(displayedUrl: string): string[] {
  const matches = displayedUrl.match(/\{\{\s*([^{}]+?)\s*\}\}/g) ?? []
  return [...new Set(matches.map((item) => item.replace(/[{}]/g, "").trim()))]
}

/**
 * Decide what the URL bar shows after the URL it was given changed.
 *
 * The test is "did *I* cause this change", expressed as an explicit revision
 * signal from the writer. It is **not** "are the old and new values
 * semantically the same": a cURL import normalizes `%20` to `+`, which parses
 * identically, and treating that as a self-echo leaves the field showing a
 * draft that no longer corresponds to any state.
 */
export function reconcileUrlBarValue(
  previous: { tabId: string; revision: number; draft: string } | null,
  incoming: { tabId: string; revision: number; url: string },
): string {
  if (!previous) {
    return incoming.url
  }

  if (previous.tabId !== incoming.tabId) {
    return incoming.url
  }

  if (previous.revision !== incoming.revision) {
    return incoming.url
  }

  return previous.draft
}

export function stripQueryFromUrl(url: string) {
  const [baseUrl] = url.split("?")
  return baseUrl
}
