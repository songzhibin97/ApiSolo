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
     * Each rebuilt row is reconciled back to the row it came from, and only
     * then does it inherit anything. The redaction marker is what makes this
     * matter: it records that history took a value away, so an edit that is not
     * about that value must not drop it -- changing the path of `?apikey=` used
     * to be enough to let an empty API key be saved with no warning.
     *
     * Two failure directions have to be held shut at once, and every cheaper
     * rule so far has closed one by opening the other:
     *
     *   - Rebuilding rows blindly loses the marker, so a still-blank credential
     *     stops being reported. That is a gate that should have held and did
     *     not, and the request 401s in silence once it is used.
     *   - Handing the marker out by position, or by a count of how many blanks
     *     a key still has, gives it to whichever blank row happens to be there
     *     -- including one the user just added. Then filling in the value that
     *     was actually blanked does not clear the notice, and a correct request
     *     stays blocked.
     *
     * So identity comes first and the marker follows it, rather than the marker
     * being allocated to a slot. A row keeps its identity if its value is
     * unchanged, wherever it moved to; the rest pair up in order; anything left
     * over is a row the user created and inherits nothing.
     */
    const entries = [...parsed.searchParams.entries()]
    const enabled = currentParams.filter((item) => item.enabled)
    const claimed = new Set<number>()

    function claim(predicate: (item: KeyValuePair) => boolean): KeyValuePair | undefined {
      const index = enabled.findIndex((item, at) => !claimed.has(at) && predicate(item))

      if (index === -1) {
        return undefined
      }

      claimed.add(index)
      return enabled[index]
    }

    const matched: Array<KeyValuePair | undefined> = entries.map(() => undefined)

    // An unchanged value is the strongest evidence that this is the same row,
    // and it is order-independent -- which is what makes reordering harmless.
    entries.forEach(([key, value], index) => {
      if (value !== "") {
        matched[index] = claim((item) => item.key === key && item.value === value)
      }
    })

    // Whatever is left pairs up left to right, keeping rows as close to where
    // they were as an order-preserving match can.
    entries.forEach(([key], index) => {
      matched[index] ??= claim((item) => item.key === key)
    })

    const params = entries.map(([key, value], index) => {
      const previous = matched[index]

      return {
        id: previous?.id ?? crypto.randomUUID(),
        enabled: true,
        key,
        value,
        description: previous?.description ?? "",
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
