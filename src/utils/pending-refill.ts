import type { AuthConfig, KeyValuePair, RequestBody } from "../types"
import { REDACTION_SENTINEL, bodyKindFromBodyType, sentinelBodyFields } from "./redaction"

export type PendingKind = "refill" | "reselect-file"
export type PendingSource = "header" | "query" | "form" | "body" | "auth" | "file" | "binary"

export interface PendingField {
  kind: PendingKind
  source: PendingSource
  path: string
}

/**
 * Everything the check needs, and nothing that says where the request came
 * from. A `Tab` satisfies this shape as-is, and a history entry is adapted into
 * it by `historyEntryToRequest`, so both save entry points run the same check
 * against the same criteria. Keying off the caller instead would mean each new
 * entry point has to be remembered separately -- which is how the old save
 * button ended up with no gate at all.
 */
export interface PendingRefillSource {
  url: string
  headers: KeyValuePair[]
  params: KeyValuePair[]
  body: RequestBody
  auth: AuthConfig
  bodyRedacted?: boolean
}

const SOURCE_LABEL: Record<PendingSource, string> = {
  header: "Header",
  query: "Query",
  form: "Form",
  body: "Body",
  auth: "Auth",
  file: "Form",
  binary: "Body",
}

function field(kind: PendingKind, source: PendingSource, name: string): PendingField {
  // A bare field name cannot be located: `password` can be a header, a form
  // row, and a JSON key on the same request.
  return { kind, source, path: `${SOURCE_LABEL[source]} · ${name}` }
}

/**
 * Two spellings of the same fact. A row read straight off disk still holds the
 * placeholder; a row that has been through the replay path holds an empty value
 * and a marker instead, because the placeholder must never be replayable. Both
 * mean "the user has to type this back in".
 */
function needsRefill(item: KeyValuePair): boolean {
  return item.value.trim() === REDACTION_SENTINEL || (item.redacted === true && item.value === "")
}

function pairFields(items: KeyValuePair[], source: PendingSource): PendingField[] {
  return items.filter(needsRefill).map((item) => field("refill", source, item.key))
}

function urlQueryFields(rawUrl: string): PendingField[] {
  const hashIndex = rawUrl.indexOf("#")
  const before = hashIndex === -1 ? rawUrl : rawUrl.slice(0, hashIndex)
  const queryIndex = before.indexOf("?")

  if (queryIndex === -1) {
    return []
  }

  const fields: PendingField[] = []

  for (const part of before.slice(queryIndex + 1).split("&")) {
    const separator = part.indexOf("=")
    if (separator === -1) {
      continue
    }

    const decode = (value: string) => {
      try {
        return decodeURIComponent(value.replace(/\+/g, " "))
      } catch {
        return value
      }
    }

    if (decode(part.slice(separator + 1)).trim() === REDACTION_SENTINEL) {
      fields.push(field("refill", "query", decode(part.slice(0, separator))))
    }
  }

  return fields
}

/**
 * The auth slots never carry a placeholder -- history blanks them outright --
 * so a check that only looks for placeholders returns an empty list for a
 * request with a Bearer token and the save goes through unannounced.
 */
function authFields(auth: AuthConfig): PendingField[] {
  if (auth.type === "basic" && !auth.basic?.password) {
    return [field("refill", "auth", "Basic password")]
  }

  if (auth.type === "bearer" && !auth.bearer?.token) {
    return [field("refill", "auth", "Bearer token")]
  }

  if (auth.type === "api-key" && !auth.apiKey?.value) {
    return [field("refill", "auth", `API key ${auth.apiKey?.key || "value"}`)]
  }

  return []
}

function bodyFields(source: PendingRefillSource): PendingField[] {
  const { body } = source

  if (body.type === "form-data") {
    return pairFields(
      body.formData.filter((item) => item.valueType !== "file"),
      "form",
    )
  }

  if (body.type === "binary" || body.type === "none") {
    return []
  }

  const named = sentinelBodyFields(bodyKindFromBodyType(body.type), body.content)
  if (named.length > 0) {
    return named.map((name) => field("refill", "body", name))
  }

  // Replaying already stripped the placeholders out of the body text, so the
  // individual key names are gone and only the marker survives.
  return source.bodyRedacted ? [field("refill", "body", "request body")] : []
}

/**
 * File content is not redacted, it is absent: history keeps neither the bytes
 * nor the path, only a bare file name. Nothing about these rows looks rewritten,
 * so any check phrased as "which values look like they were replaced" misses
 * them entirely and hands back a request that can never be sent.
 */
function fileFields(body: RequestBody): PendingField[] {
  if (body.type === "form-data") {
    return body.formData
      .filter((item) => item.valueType === "file")
      .map((item) => field("reselect-file", "file", item.key))
  }

  if (body.type === "binary" && !body.binaryContent) {
    return [field("reselect-file", "binary", body.binaryPath || "binary body")]
  }

  return []
}

export function pendingRefillFields(source: PendingRefillSource): PendingField[] {
  const fields = [
    ...pairFields(source.headers, "header"),
    ...pairFields(source.params, "query"),
    ...urlQueryFields(source.url),
    ...bodyFields(source),
    ...authFields(source.auth),
    ...fileFields(source.body),
  ]

  // A query parameter can be reached twice: params are the source of truth for
  // a request, but a tab opened from history also keeps the query in its url.
  // Listing "Query · api_key" twice tells the user nothing and inflates the
  // count the dialog reports.
  const seen = new Set<string>()

  return fields.filter((field) => {
    const identity = `${field.kind}|${field.source}|${field.path}`
    if (seen.has(identity)) {
      return false
    }

    seen.add(identity)
    return true
  })
}

export function refillFields(fields: PendingField[]): PendingField[] {
  return fields.filter((item) => item.kind === "refill")
}

export function reselectFileFields(fields: PendingField[]): PendingField[] {
  return fields.filter((item) => item.kind === "reselect-file")
}
