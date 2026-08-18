import type { FormDataItem, HistoryEntry, KeyValuePair, Tab } from "../types"

export const REDACTION_SENTINEL = "[redacted]"

const SENTINEL_JSON = JSON.stringify(REDACTION_SENTINEL)
const EMPTY_JSON_STRING = JSON.stringify("")

export type BodyKind = "json" | "urlencoded" | "text"

/**
 * Field-name hard list. Kept in lock step with `is_sensitive_key` in
 * `src-tauri/src/lib.rs`; both sides are substring matches over the lowercased
 * key, and both are exercised by `src/utils/__fixtures__/sensitive-keys.json`.
 * Bare `key` is deliberately absent — it would swallow `key` / `keyword` / `monkey`.
 */
const SENSITIVE_KEY_NEEDLES = [
  "authorization",
  "cookie",
  "set-cookie",
  "token",
  "secret",
  "password",
  "passwd",
  "api-key",
  "apikey",
  "x-api-key",
  "subscription-key",
  "signature",
  "credential",
]

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return SENSITIVE_KEY_NEEDLES.some((needle) => normalized.includes(needle))
}

/**
 * Redaction is driven by the field name only, never by the content of the
 * value. Anything written under a non-sensitive field name is stored verbatim.
 */
export function redactValue(key: string, value: string): string {
  return isSensitiveKey(key) && value ? REDACTION_SENTINEL : value
}

export function redactKeyValuePairs<T extends KeyValuePair>(items: T[]): T[] {
  return items.map((item) => ({ ...item, value: redactValue(item.key, item.value) })) as T[]
}

export function bodyKindFromBodyType(bodyType: string): BodyKind {
  if (bodyType === "json") {
    return "json"
  }

  if (bodyType === "form-urlencoded") {
    return "urlencoded"
  }

  return "text"
}

export function bodyKindFromContentType(contentType: string): BodyKind {
  const normalized = contentType.toLowerCase()

  if (normalized.includes("json")) {
    return "json"
  }

  if (normalized.includes("x-www-form-urlencoded")) {
    return "urlencoded"
  }

  return "text"
}

/**
 * Percent decoding that never throws. `decodeURIComponent` rejects malformed
 * escapes, and a throw here would blow up history construction for an otherwise
 * successful request.
 */
export function lenientDecodeKey(rawKey: string): string {
  const spaced = rawKey.replace(/\+/g, " ")

  try {
    return decodeURIComponent(spaced)
  } catch {
    return spaced.replace(/%[0-9A-Fa-f]{2}/g, (escape) => {
      try {
        return decodeURIComponent(escape)
      } catch {
        return escape
      }
    })
  }
}

// ---------------------------------------------------------------------------
// json path — locate-only scanner over the original bytes
// ---------------------------------------------------------------------------

interface JsonSpan {
  start: number
  end: number
  name: string
}

function decodeJsonKey(rawKey: string): string {
  return JSON.parse(`"${rawKey}"`) as string
}

/**
 * Returns the `[start, end)` byte range of every value whose key is sensitive.
 * Throws when the text cannot be scanned (malformed JSON, illegal escape in a
 * key, trailing content) so callers can fall back to the `text` path.
 */
function scanJsonSpans(text: string): JsonSpan[] {
  const spans: JsonSpan[] = []
  let i = 0

  function fail(): never {
    throw new Error("Unscannable JSON body")
  }

  function skipWhitespace() {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) {
      i += 1
    }
  }

  function readStringToken(): string {
    if (text[i] !== "\"") {
      fail()
    }

    i += 1
    const start = i

    while (i < text.length) {
      const ch = text[i]
      if (ch === "\\") {
        i += 2
        continue
      }

      if (ch === "\"") {
        const raw = text.slice(start, i)
        i += 1
        return raw
      }

      i += 1
    }

    fail()
  }

  function skipLiteral() {
    const start = i
    while (i < text.length && ",]} \t\n\r".indexOf(text[i]) === -1) {
      i += 1
    }

    if (i === start) {
      fail()
    }
  }

  function skipValue(sensitiveKey: boolean) {
    const c = text[i]

    if (c === "\"") {
      readStringToken()
    } else if (c === "{") {
      scanObject(Boolean(sensitiveKey))
    } else if (c === "[") {
      scanArray(Boolean(sensitiveKey))
    } else {
      skipLiteral()
    }
  }

  function scanArray(suppressed: boolean) {
    i += 1
    skipWhitespace()

    if (text[i] === "]") {
      i += 1
      return
    }

    for (;;) {
      skipWhitespace()
      skipValue(suppressed)
      skipWhitespace()

      if (text[i] === ",") {
        i += 1
        continue
      }

      if (text[i] === "]") {
        i += 1
        return
      }

      fail()
    }
  }

  function scanObject(suppressed: boolean) {
    i += 1
    skipWhitespace()

    if (text[i] === "}") {
      i += 1
      return
    }

    for (;;) {
      skipWhitespace()
      const raw = readStringToken()
      const key = decodeJsonKey(raw)
      const sensitiveKey = !suppressed && isSensitiveKey(key)
      skipWhitespace()

      if (text[i] !== ":") {
        fail()
      }

      i += 1
      skipWhitespace()
      const start = i
      skipValue(sensitiveKey || suppressed)

      if (sensitiveKey) {
        spans.push({ start, end: i, name: key })
      }

      skipWhitespace()

      if (text[i] === ",") {
        i += 1
        continue
      }

      if (text[i] === "}") {
        i += 1
        return
      }

      fail()
    }
  }

  skipWhitespace()

  if (text[i] === "{") {
    scanObject(false)
  } else if (text[i] === "[") {
    scanArray(false)
  } else {
    fail()
  }

  skipWhitespace()

  if (i !== text.length) {
    fail()
  }

  return spans
}

function replaceSpans(text: string, spans: JsonSpan[], replacement: string): string {
  let out = text

  for (let k = spans.length - 1; k >= 0; k -= 1) {
    out = out.slice(0, spans[k].start) + replacement + out.slice(spans[k].end)
  }

  return out
}

function tryScanJsonSpans(text: string): JsonSpan[] | null {
  try {
    return scanJsonSpans(text)
  } catch {
    return null
  }
}

function redactJson(text: string): string | null {
  const spans = tryScanJsonSpans(text)

  if (spans === null) {
    return null
  }

  if (spans.length === 0) {
    return text
  }

  return replaceSpans(text, spans, SENTINEL_JSON)
}

// ---------------------------------------------------------------------------
// text path — key-anchored, cut to end of line
// ---------------------------------------------------------------------------

interface SensitiveCut {
  key: string
  cut: number
}

/**
 * The scan regex is built per call on purpose: a `g` regex whose `exec` loop
 * returns early keeps a non-zero `lastIndex`, which would leak scan state
 * between lines and between calls.
 */
function firstSensitiveCut(line: string): SensitiveCut | null {
  const scan = /["']?([A-Za-z0-9_.\-]+)["']?[ \t]*[:=][ \t]*/g
  let match: RegExpExecArray | null

  while ((match = scan.exec(line)) !== null) {
    if (isSensitiveKey(match[1])) {
      return { key: match[1], cut: match.index + match[0].length }
    }
  }

  return null
}

function redactTextLine(line: string): string {
  const hit = firstSensitiveCut(line)
  return hit ? line.slice(0, hit.cut) + REDACTION_SENTINEL : line
}

function redactText(content: string): string {
  const parts = content.split(/(\r\n|\n|\r)/)

  for (let k = 0; k < parts.length; k += 2) {
    parts[k] = redactTextLine(parts[k])
  }

  return parts.join("")
}

// ---------------------------------------------------------------------------
// urlencoded path
// ---------------------------------------------------------------------------

function redactUrlencoded(content: string): string {
  return content
    .split("&")
    .map((part) => {
      const separator = part.indexOf("=")

      if (separator === -1) {
        return part
      }

      const rawKey = part.slice(0, separator)

      return isSensitiveKey(lenientDecodeKey(rawKey)) ? `${rawKey}=${REDACTION_SENTINEL}` : part
    })
    .join("&")
}

export function redactBodyText(kind: BodyKind, content: string): string {
  if (!content) {
    return content
  }

  if (kind === "urlencoded") {
    return redactUrlencoded(content)
  }

  if (kind === "json") {
    const redacted = redactJson(content)
    return redacted === null ? redactText(content) : redacted
  }

  return redactText(content)
}

export function redactUrlQuery(rawUrl: string): string {
  const hashIndex = rawUrl.indexOf("#")
  const hash = hashIndex === -1 ? "" : rawUrl.slice(hashIndex)
  const before = hashIndex === -1 ? rawUrl : rawUrl.slice(0, hashIndex)
  const queryIndex = before.indexOf("?")

  if (queryIndex === -1) {
    return rawUrl
  }

  return `${before.slice(0, queryIndex)}?${redactUrlencoded(before.slice(queryIndex + 1))}${hash}`
}

// ---------------------------------------------------------------------------
// history entry sanitation
// ---------------------------------------------------------------------------

function stripPairMarkers<T extends KeyValuePair>(items: T[]): T[] {
  return items.map(({ redacted: _redacted, ...rest }) => rest as T)
}

function stripHistoryMarkers(entry: HistoryEntry): HistoryEntry {
  return {
    ...entry,
    requestParams: entry.requestParams && stripPairMarkers(entry.requestParams),
    requestHeaders: entry.requestHeaders && stripPairMarkers(entry.requestHeaders),
    requestBodyFormData: entry.requestBodyFormData && stripPairMarkers(entry.requestBodyFormData),
  }
}

function redactFormDataValues(items: FormDataItem[]): FormDataItem[] {
  return items.map((item) => ({
    ...item,
    value: item.valueType === "file" ? item.value : redactValue(item.key, item.value),
  }))
}

export function sanitizeHistoryEntry(entry: HistoryEntry): HistoryEntry {
  const sanitized: HistoryEntry = {
    ...entry,
    url: redactUrlQuery(entry.url),
    requestParams: entry.requestParams && redactKeyValuePairs(entry.requestParams),
    requestHeaders: entry.requestHeaders && redactKeyValuePairs(entry.requestHeaders),
    requestBodyContent:
      entry.requestBodyContent === undefined
        ? undefined
        : redactBodyText(bodyKindFromBodyType(entry.requestBodyType ?? ""), entry.requestBodyContent),
    requestBodyFormData: entry.requestBodyFormData && redactFormDataValues(entry.requestBodyFormData),
    responseBody:
      entry.responseBody === undefined
        ? undefined
        : redactBodyText(bodyKindFromContentType(entry.contentType), entry.responseBody),
    responseHeaders:
      entry.responseHeaders &&
      entry.responseHeaders.map(([key, value]) => [key, redactValue(key, value)] as [string, string]),
  }

  return stripHistoryMarkers(sanitized)
}

// ---------------------------------------------------------------------------
// replay — clearing the sentinel out of an editable tab
// ---------------------------------------------------------------------------

export function clearSentinelPairs<T extends KeyValuePair>(items: T[]): T[] {
  return items.map((item) =>
    item.value.trim() === REDACTION_SENTINEL ? { ...item, value: "", redacted: true } : item,
  ) as T[]
}

function clearSentinelJson(content: string): { content: string; cleared: boolean } | null {
  const spans = tryScanJsonSpans(content)

  if (spans === null) {
    return null
  }

  const hits = spans.filter((span) => content.slice(span.start, span.end) === SENTINEL_JSON)

  if (hits.length === 0) {
    return { content, cleared: false }
  }

  return { content: replaceSpans(content, hits, EMPTY_JSON_STRING), cleared: true }
}

function clearSentinelUrlencoded(content: string): { content: string; cleared: boolean } {
  let cleared = false

  const next = content
    .split("&")
    .map((part) => {
      const separator = part.indexOf("=")

      if (separator === -1 || part.slice(separator + 1) !== REDACTION_SENTINEL) {
        return part
      }

      const rawKey = part.slice(0, separator)

      if (!isSensitiveKey(lenientDecodeKey(rawKey))) {
        return part
      }

      cleared = true
      return `${rawKey}=`
    })
    .join("&")

  return { content: next, cleared }
}

function clearSentinelText(content: string): { content: string; cleared: boolean } {
  const parts = content.split(/(\r\n|\n|\r)/)
  let cleared = false

  for (let k = 0; k < parts.length; k += 2) {
    const hit = firstSensitiveCut(parts[k])

    if (hit && parts[k].slice(hit.cut) === REDACTION_SENTINEL) {
      parts[k] = parts[k].slice(0, hit.cut)
      cleared = true
    }
  }

  return { content: parts.join(""), cleared }
}

export function clearSentinelBody(kind: BodyKind, content: string): { content: string; cleared: boolean } {
  if (!content) {
    return { content, cleared: false }
  }

  if (kind === "urlencoded") {
    return clearSentinelUrlencoded(content)
  }

  if (kind === "json") {
    return clearSentinelJson(content) ?? clearSentinelText(content)
  }

  return clearSentinelText(content)
}

// ---------------------------------------------------------------------------
// outbound gate
// ---------------------------------------------------------------------------

function sentinelJsonKeys(content: string): string[] | null {
  const spans = tryScanJsonSpans(content)

  if (spans === null) {
    return null
  }

  return spans.filter((span) => content.slice(span.start, span.end) === SENTINEL_JSON).map((span) => span.name)
}

function sentinelUrlencodedKeys(content: string): string[] {
  const keys: string[] = []

  for (const part of content.split("&")) {
    const separator = part.indexOf("=")

    if (separator === -1 || part.slice(separator + 1) !== REDACTION_SENTINEL) {
      continue
    }

    const key = lenientDecodeKey(part.slice(0, separator))

    if (isSensitiveKey(key)) {
      keys.push(key)
    }
  }

  return keys
}

function sentinelTextKeys(content: string): string[] {
  const keys: string[] = []

  for (const line of content.split(/\r\n|\n|\r/)) {
    const hit = firstSensitiveCut(line)

    if (hit && line.slice(hit.cut) === REDACTION_SENTINEL) {
      keys.push(hit.key)
    }
  }

  return keys
}

export function sentinelBodyFields(kind: BodyKind, content: string): string[] {
  if (!content) {
    return []
  }

  if (kind === "urlencoded") {
    return sentinelUrlencodedKeys(content)
  }

  if (kind === "json") {
    return sentinelJsonKeys(content) ?? sentinelTextKeys(content)
  }

  return sentinelTextKeys(content)
}

function sentinelPairFields<T extends KeyValuePair>(items: T[]): string[] {
  return items
    .filter((item) => item.enabled && item.value.trim() === REDACTION_SENTINEL)
    .map((item) => item.key)
}

export function findSentinelFields(tab: Tab): string[] {
  const fields: string[] = []

  fields.push(...sentinelPairFields(tab.headers))
  fields.push(...sentinelPairFields(tab.params))
  fields.push(...sentinelPairFields(tab.body.formData))
  fields.push(...sentinelBodyFields(bodyKindFromBodyType(tab.body.type), tab.body.content))

  return fields
}

// ---------------------------------------------------------------------------
// "needs re-entering" markers
// ---------------------------------------------------------------------------

export function pendingRedactedFieldNames(tab: Tab): string[] {
  return [...tab.headers, ...tab.params, ...tab.body.formData]
    .filter((item) => item.redacted)
    .map((item) => item.key)
}

export function hasPendingRedactedFields(tab: Tab): boolean {
  return (
    tab.headers.some((item) => item.redacted) ||
    tab.params.some((item) => item.redacted) ||
    tab.body.formData.some((item) => item.redacted) ||
    Boolean(tab.bodyRedacted)
  )
}

/**
 * Clearing the marker is tied to the value alone. Toggling `enabled`, editing
 * the key or the description must keep it — otherwise the row goes back to
 * looking normal while still holding no value.
 */
export function applyPairEdit<T extends KeyValuePair>(rows: T[], id: string, patch: Partial<T>): T[] {
  return rows.map((row) =>
    row.id === id
      ? { ...row, ...patch, ...("value" in patch ? { redacted: false } : {}) }
      : row,
  )
}
