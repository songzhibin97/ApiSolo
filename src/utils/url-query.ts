/**
 * URL string surgery, plus the encoder for anything we hand to an *external*
 * tool (a `curl` command line, a Postman collection). Its correctness target is
 * **reproducing what the user typed**: `%20` stays `%20`, nothing is normalized
 * through `new URL`, and `{{…}}` template spans survive verbatim.
 *
 * Its sibling `url-params.ts` owns the URL bar ↔ params ↔ wire loop, whose
 * correctness target is a different one: matching the bytes *this app itself*
 * puts on the wire (form-urlencoded, space as `+`). The two encoders are not
 * duplicates — they serve two different consumers. What is genuinely shared is
 * the template-span split below, not the encoding.
 */
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
 * Split a string into alternating plain and `{{…}}` template segments. The
 * regex is built per call rather than hoisted: a shared literal with a `g` flag
 * carries `lastIndex` between callers, which has already produced one
 * position-dependent test in this repo.
 *
 * This is the one primitive both encoders share.
 */
export function splitTemplateSpans(value: string): string[] {
  return value.split(/(\{\{[^{}]*\}\})/)
}

export function isTemplateSpan(segment: string): boolean {
  return segment.startsWith("{{") && segment.endsWith("}}")
}

/**
 * Percent-encode a query component while leaving `{{…}}` template spans
 * alone. `encodeURIComponent` would turn `{{apiToken}}` into
 * `%7B%7BapiToken%7D%7D`, which is a literal path segment rather than a
 * variable reference.
 *
 * Encodes a space as `%20`, which is what a `curl` command line and a Postman
 * `url.raw` need. The URL bar needs `+` instead — that is
 * `encodeFormComponentPreservingTemplates` in `url-params.ts`.
 */
export function encodeQueryComponentPreservingTemplates(value: string): string {
  return splitTemplateSpans(value)
    .map((segment) => (isTemplateSpan(segment) ? segment : encodeURIComponent(segment)))
    .join("")
}
