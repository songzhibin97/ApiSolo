export interface UrlParts {
  baseUrl: string
  query: string
  hash: string
}

/**
 * Split a URL by string surgery, never through `new URL`. Parsing and
 * re-serializing a URL rewrites it: `{` and `}` get percent-encoded, a
 * protocol-less URL loses its host into the path, the host is lowercased and
 * a default port disappears. Copy as cURL has to hand back what the user
 * typed, not our normalized version of it.
 *
 * Matches the URL bar's own splitting so the exported command and the
 * displayed URL agree.
 */
export function splitUrlParts(rawUrl: string): UrlParts {
  const hashIndex = rawUrl.indexOf("#")
  const hash = hashIndex === -1 ? "" : rawUrl.slice(hashIndex)
  const beforeHash = hashIndex === -1 ? rawUrl : rawUrl.slice(0, hashIndex)
  const queryIndex = beforeHash.indexOf("?")

  return {
    baseUrl: queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex),
    query: queryIndex === -1 ? "" : beforeHash.slice(queryIndex + 1),
    hash,
  }
}

/**
 * Percent-encode a query component while leaving `{{…}}` template spans
 * alone. `encodeURIComponent` would turn `{{apiToken}}` into
 * `%7B%7BapiToken%7D%7D`, which is a literal path segment rather than a
 * variable reference.
 */
export function encodeQueryComponentPreservingTemplates(value: string): string {
  return value
    .split(/(\{\{[^{}]*\}\})/)
    .map((segment) =>
      segment.startsWith("{{") && segment.endsWith("}}")
        ? segment
        : encodeURIComponent(segment),
    )
    .join("")
}
