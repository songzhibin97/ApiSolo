import type {
  AuthConfig,
  AuthType,
  BodyType,
  HistoryEntry,
  KeyValuePair,
  RequestBody,
  SavedRequest,
} from "../types"
import type { PendingRefillSource } from "./pending-refill"
import { mergeHistoryQueryRows } from "./history-query"
import {
  REDACTION_SENTINEL,
  bodyKindFromBodyType,
  clearSentinelBody,
  clearSentinelPairs,
} from "./redaction"
import { buildSavedRequest } from "./saved-request"

/** The normalized request shape shared by both history save entry points. */
export interface HistoryRequest extends PendingRefillSource {
  method: string
  preRequestScript: string
  testScript: string
}

function editablePairs(items: KeyValuePair[] | undefined): KeyValuePair[] {
  return (items ?? []).map((item, index) => ({
    ...item,
    id: item.id || `history-${index}`,
  }))
}

function historyBody(entry: HistoryEntry): RequestBody {
  const type = (entry.requestBodyType || "none") as BodyType

  return {
    type,
    content: entry.requestBodyContent || "",
    formData: clearSentinelPairs(editablePairs(entry.requestBodyFormData)),
    binaryPath: entry.requestBodyBinaryPath || "",
    binaryContent: entry.requestBodyBinaryContent,
  } as RequestBody
}

function historyAuth(entry: HistoryEntry): AuthConfig {
  if (entry.requestAuth) {
    return {
      type: entry.requestAuth.type,
      basic: entry.requestAuth.basic,
      bearer: entry.requestAuth.bearer,
      apiKey: entry.requestAuth.apiKey,
    }
  }

  return { type: (entry.requestAuthType || "none") as AuthType }
}

export function historyEntryToRequest(entry: HistoryEntry): HistoryRequest {
  return {
    method: (entry.method || "GET").toUpperCase(),
    url: entry.url,
    headers: clearSentinelPairs(editablePairs(entry.requestHeaders)),
    params: mergeHistoryQueryRows(editablePairs(entry.requestParams), entry.url),
    body: historyBody(entry),
    auth: historyAuth(entry),
    preRequestScript: entry.preRequestScript || "",
    testScript: entry.testScript || "",
  }
}

export function defaultRequestName(entry: HistoryEntry): string {
  const method = (entry.method || "GET").toUpperCase()

  try {
    const url = new URL(entry.url)
    const segments = url.pathname.split("/").filter(Boolean)
    return `${method} ${segments.length > 0 ? segments[segments.length - 1] : url.host}`.trim()
  } catch {
    return `${method} ${entry.url}`.trim()
  }
}

function clearPairSentinels(items: KeyValuePair[]): KeyValuePair[] {
  // Import normalization already removed these. Keep this persistence-boundary
  // pass as a second defense against a future unnormalized constructor.
  return items.map((item) =>
    item.value.trim() === REDACTION_SENTINEL ? { ...item, value: "" } : item,
  )
}

/**
 * Saving from history writes the placeholder-free request. A placeholder that
 * reached a collection would be indistinguishable from a real value the next
 * time someone opened it, and would go out on the wire as one.
 */
export function buildSavedRequestFromHistory(entry: HistoryEntry, name: string): SavedRequest {
  const request = historyEntryToRequest(entry)
  const body = request.body
  const cleared =
    body.type === "form-data" || body.type === "binary" || body.type === "none"
      ? body.content
      : clearSentinelBody(bodyKindFromBodyType(body.type), body.content).content

  return buildSavedRequest(
    {
      method: request.method,
      url: clearUrlSentinels(request.url),
      params: clearPairSentinels(request.params),
      headers: clearPairSentinels(request.headers),
      body: { ...body, content: cleared, formData: clearPairSentinels(body.formData) },
      auth: request.auth,
      preRequestScript: request.preRequestScript,
      testScript: request.testScript,
      // buildSavedRequest reads nothing else off the tab; the rest of the shape
      // exists only to satisfy the parameter type.
    } as never,
    name,
  )
}

/**
 * Shared with the tab loader rather than written twice: a placeholder must
 * never reach a collection file, and both entry points have to strip it from
 * the same place or one of them will drift.
 */
export function clearUrlSentinels(rawUrl: string): string {
  const hashIndex = rawUrl.indexOf("#")
  const hash = hashIndex === -1 ? "" : rawUrl.slice(hashIndex)
  const before = hashIndex === -1 ? rawUrl : rawUrl.slice(0, hashIndex)
  const queryIndex = before.indexOf("?")

  if (queryIndex === -1) {
    return rawUrl
  }

  const query = before
    .slice(queryIndex + 1)
    .split("&")
    .map((part) => {
      const separator = part.indexOf("=")
      if (separator === -1) {
        return part
      }

      const value = part.slice(separator + 1)
      let decoded = value
      try {
        decoded = decodeURIComponent(value.replace(/\+/g, " "))
      } catch {
        decoded = value
      }

      return decoded.trim() === REDACTION_SENTINEL ? `${part.slice(0, separator)}=` : part
    })
    .join("&")

  return `${before.slice(0, queryIndex)}?${query}${hash}`
}
