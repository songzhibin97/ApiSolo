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

  function isDigit(ch: string | undefined) {
    return ch !== undefined && ch >= "0" && ch <= "9"
  }

  /**
   * Strict JSON number grammar. Reading to the next delimiter instead would
   * accept garbage like `truX` or `0x1F` as a value, and the body would then be
   * treated as structured JSON rather than degrading to the text path.
   */
  function skipNumber() {
    if (text[i] === "-") {
      i += 1
    }

    if (text[i] === "0") {
      i += 1
    } else if (isDigit(text[i])) {
      while (isDigit(text[i])) {
        i += 1
      }
    } else {
      fail()
    }

    if (text[i] === ".") {
      i += 1
      if (!isDigit(text[i])) {
        fail()
      }
      while (isDigit(text[i])) {
        i += 1
      }
    }

    if (text[i] === "e" || text[i] === "E") {
      i += 1
      if (text[i] === "+" || text[i] === "-") {
        i += 1
      }
      if (!isDigit(text[i])) {
        fail()
      }
      while (isDigit(text[i])) {
        i += 1
      }
    }
  }

  function skipLiteral() {
    if (text.startsWith("true", i)) {
      i += 4
      return
    }

    if (text.startsWith("false", i)) {
      i += 5
      return
    }

    if (text.startsWith("null", i)) {
      i += 4
      return
    }

    skipNumber()
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

/**
 * Exported for tests only: it is the repository's own idea of what parses, and
 * a test that reached for `JSON.parse` instead would be checking a different
 * grammar than the one that ships.
 */
export function tryScanJsonSpans(text: string): JsonSpan[] | null {
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

export function redactFormDataValues(items: FormDataItem[]): FormDataItem[] {
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

/**
 * What replay took out of a body, by name. The names are the whole point: once
 * the placeholder is gone the key it sat under is indistinguishable from a key
 * the user meant to leave blank, and the save dialog has to be able to say
 * which ones need typing back in. They are kept in order and with repeats --
 * the same key redacted twice is two values to re-enter, and reporting one is
 * the same class of lie as reporting three.
 */
export interface ClearedBody {
  content: string
  fields: string[]
}

function clearSentinelJson(content: string): ClearedBody | null {
  const spans = tryScanJsonSpans(content)

  if (spans === null) {
    return null
  }

  const hits = spans.filter((span) => content.slice(span.start, span.end) === SENTINEL_JSON)

  if (hits.length === 0) {
    return { content, fields: [] }
  }

  return {
    content: replaceSpans(content, hits, EMPTY_JSON_STRING),
    fields: hits.map((hit) => hit.name),
  }
}

function clearSentinelUrlencoded(content: string): ClearedBody {
  const fields: string[] = []

  const next = content
    .split("&")
    .map((part) => {
      const separator = part.indexOf("=")

      if (separator === -1 || part.slice(separator + 1) !== REDACTION_SENTINEL) {
        return part
      }

      const rawKey = part.slice(0, separator)
      const key = lenientDecodeKey(rawKey)

      if (!isSensitiveKey(key)) {
        return part
      }

      fields.push(key)
      return `${rawKey}=`
    })
    .join("&")

  return { content: next, fields }
}

function clearSentinelText(content: string): ClearedBody {
  const parts = content.split(/(\r\n|\n|\r)/)
  const fields: string[] = []

  for (let k = 0; k < parts.length; k += 2) {
    const hit = firstSensitiveCut(parts[k])

    if (hit && parts[k].slice(hit.cut) === REDACTION_SENTINEL) {
      parts[k] = parts[k].slice(0, hit.cut)
      fields.push(hit.key)
    }
  }

  return { content: parts.join(""), fields }
}

export function clearSentinelBody(kind: BodyKind, content: string): ClearedBody {
  if (!content) {
    return { content, fields: [] }
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
// "needs re-entering" — decided by what the body holds now, not by what happened
// ---------------------------------------------------------------------------

/**
 * Which sensitive keys currently hold an empty value. Same scanners as
 * `sentinelBodyFields`, comparing against empty instead of the placeholder.
 *
 * One asymmetry is deliberate: when the body is meant to be JSON and will not
 * parse, this returns `null` rather than falling back to the text scanner the
 * way `sentinelBodyFields` does. Hunting for a placeholder in unparseable text
 * is worth doing -- finding one is finding one. Concluding that a value has
 * been typed back in is not: "cannot tell" is not evidence of "already done",
 * and the text scanner would supply a confident wrong answer. On
 * `  "token": "",` the cut lands before `"",` rather than before an empty
 * string, so the field would read as refilled and the gate would disappear at
 * exactly the moment the body is least trustworthy.
 */
export function emptyBodyFields(kind: BodyKind, content: string): string[] | null {
  if (kind === "json") {
    const spans = tryScanJsonSpans(content)

    if (spans === null) {
      return null
    }

    return spans
      .filter((span) => content.slice(span.start, span.end) === EMPTY_JSON_STRING)
      .map((span) => span.name)
  }

  if (kind === "urlencoded") {
    const keys: string[] = []

    for (const part of content.split("&")) {
      const separator = part.indexOf("=")

      if (separator === -1 || part.slice(separator + 1) !== "") {
        continue
      }

      const key = lenientDecodeKey(part.slice(0, separator))

      if (isSensitiveKey(key)) {
        keys.push(key)
      }
    }

    return keys
  }

  const keys: string[] = []

  for (const line of content.split(/\r\n|\n|\r/)) {
    const hit = firstSensitiveCut(line)

    if (hit && line.slice(hit.cut) === "") {
      keys.push(hit.key)
    }
  }

  return keys
}

/**
 * Of the keys replay emptied, which still need typing back in. The answer is
 * recomputed from the body every time rather than tracked as the user edits:
 * a state nobody maintains has no write path left to forget. Reformatting the
 * body changes no value and so changes no answer; editing a different key
 * leaves this one empty and still listed; deleting the key outright drops it,
 * because there is nothing left to fill.
 *
 * The overlap is a multiset, not a set. The same key emptied twice is two
 * values the user has to supply, and it is also what keeps the two save entry
 * points reporting the same list -- the history side produces one entry per
 * span and does not collapse repeats either.
 */
export function remainingRedactedBodyFields(
  kind: BodyKind,
  content: string,
  recorded: string[],
): string[] {
  if (recorded.length === 0) {
    return []
  }

  const empty = emptyBodyFields(kind, content)

  if (empty === null) {
    return [...recorded]
  }

  const budget = new Map<string, number>()

  for (const name of empty) {
    budget.set(name, (budget.get(name) ?? 0) + 1)
  }

  return recorded.filter((name) => {
    const left = budget.get(name) ?? 0

    if (left === 0) {
      return false
    }

    budget.set(name, left - 1)
    return true
  })
}

/**
 * Whether the body is in a state where the question above cannot be answered.
 * Read from the body text alone, so both save entry points get the same answer
 * regardless of which branch produced the field names -- if this depended on
 * the caller, the same request would carry two different signatures and the
 * user would be asked to confirm twice.
 */
export function isUnverifiableBody(kind: BodyKind, content: string): boolean {
  return kind === "json" && tryScanJsonSpans(content) === null
}

/**
 * No edit clears the marker. `redacted` says "history blanked this row", which
 * is a fact about where the row came from and stays true however the value is
 * edited; whether the row still needs typing back in is the *conjunction*
 * `redacted && value === ""`, and every reader asks it that way. Filling the
 * value in therefore answers "no" on its own, with nothing to clear, and
 * deleting what was typed answers "yes" again.
 *
 * This is the single record of what was blanked that outlives the value, so
 * throwing it away on the first keystroke is what made a typed-then-deleted
 * credential go quiet: the notice came down, the save unlocked, and the request
 * was written with an empty api key that 401s the next time anyone uses it.
 * An earlier note here declared that case out of reach for want of exactly this
 * record. The record was never missing — it was being discarded two lines below
 * the sentence that said it did not exist.
 *
 * Keeping it means a marker can outlive its usefulness (a row whose key the
 * user retyped into something else stays marked). That direction costs a
 * confirmation; the other direction costs a credential.
 */
export function applyPairEdit<T extends KeyValuePair>(rows: T[], id: string, patch: Partial<T>): T[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row))
}
