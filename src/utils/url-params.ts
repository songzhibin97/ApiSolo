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
     * The marker travels per key, not per row: if a key still has a value that
     * history blanked and nobody has typed back in, every blank row of that key
     * in the rebuilt list is marked.
     *
     * This is not an approximation of a per-row rule, it is the absence of one,
     * and that is the point. Two rows with the same key and the same value are
     * indistinguishable -- there is no fact in a url that says which blank
     * `apikey` is "the" blanked one. Every rule that tried to answer that
     * question failed in one of two directions, and fixing one direction opened
     * the other:
     *
     *   - Rebuild the rows blindly and the marker is lost, so a still-blank
     *     credential stops being reported: the save goes through and the
     *     request 401s in silence once someone uses it.
     *   - Hand the marker to a row chosen by position, by ordinal among
     *     same-named keys, or by order-preserving match, and it can land on a
     *     row the user just added. Then filling in the value that really was
     *     blanked leaves the notice up on a request that is already complete.
     *
     * Asking "is any `apikey` still empty" has an answer; asking "which one"
     * does not. And the first question is the one that matters to the person
     * reading the notice: an empty `apikey` goes out empty whichever row it
     * came from.
     *
     * The cost, stated rather than hidden: deliberately sending one sensitive
     * parameter empty alongside a filled one keeps the notice up, and the user
     * has to tick the acknowledgement to save. That is the direction to err in,
     * and it is a confirmation rather than a refusal.
     */
    const entries = [...parsed.searchParams.entries()]
    const blanked = new Set<string>()

    for (const item of currentParams) {
      if (item.enabled && item.redacted === true && item.value === "") {
        blanked.add(item.key)
      }
    }

    /**
     * Identity is only reused where it is unambiguous: a row whose key and
     * non-empty value both still appear is the same row wherever it moved to.
     * Blank rows are deliberately not matched -- that is the question with no
     * answer -- so they get a fresh handle, which is what they got before any
     * of this.
     */
    const enabled = currentParams.filter((item) => item.enabled)
    const claimed = new Set<number>()

    function claimSameValue(key: string, value: string): KeyValuePair | undefined {
      if (value === "") {
        return undefined
      }

      const index = enabled.findIndex(
        (item, at) => !claimed.has(at) && item.key === key && item.value === value,
      )

      if (index === -1) {
        return undefined
      }

      claimed.add(index)
      return enabled[index]
    }

    const params = entries.map(([key, value]) => {
      const previous = claimSameValue(key, value)

      return {
        id: previous?.id ?? crypto.randomUUID(),
        enabled: true,
        key,
        value,
        description: previous?.description ?? "",
        ...(value === "" && blanked.has(key) ? { redacted: true } : {}),
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
