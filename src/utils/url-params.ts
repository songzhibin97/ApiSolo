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

export function syncParamsFromUrl(rawUrl: string, currentParams: KeyValuePair[]) {
  try {
    const parsed = new URL(toParsableUrl(rawUrl))
    /**
     * Rebuilt rows are lined up against the existing ones by key and by which
     * occurrence of that key they are, so that a row can carry forward what it
     * was holding. Only the redaction marker is carried, and only while the
     * value is still blank.
     *
     * Without this, editing any part of the url dropped the marker, and with it
     * the save gate on a credential history had blanked: changing the path of
     * `?apikey=` was enough to let an empty API key be saved unannounced. The
     * marker records that history took the value away — not that the url has
     * not been touched since — so an edit elsewhere must not clear it. Typing a
     * value in does clear it, which is the same rule the params table follows.
     */
    const enabled = currentParams.filter((item) => item.enabled)
    const seen = new Map<string, number>()

    const params = [...parsed.searchParams.entries()].map(([key, value]) => {
      const occurrence = seen.get(key) ?? 0
      seen.set(key, occurrence + 1)
      const previous = enabled.filter((item) => item.key === key)[occurrence]

      return {
        id: crypto.randomUUID(),
        enabled: true,
        key,
        value,
        description: "",
        ...(value === "" && previous?.redacted === true ? { redacted: true } : {}),
      }
    })
    // Store URL without query string — params are the source of truth
    const { baseUrl, hash } = splitUrlParts(rawUrl)
    return {
      url: `${baseUrl}${hash}`,
      params: [...params, ...currentParams.filter((item) => !item.enabled)],
    }
  } catch {
    return {
      url: rawUrl,
      params: currentParams,
    }
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
