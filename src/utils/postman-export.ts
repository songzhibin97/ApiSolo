import type {
  CollectionNode,
  FormDataItem,
  KeyValuePair,
  RequestBody,
  SavedRequest,
} from "../types"
import { splitUrlParts } from "./url-query"

export interface PostmanExportWarning {
  code: "file-content-not-exportable"
  requestName: string
  fileName: string
}

/**
 * An upload whose bytes live inside ApiSolo has no path Postman could
 * resolve. `filePath` is empty everywhere in this app (uploads are inlined as
 * base64 by design), so whether we hold the bytes is decided by the content
 * field being a string -- not by its truthiness, and not by an `!== undefined`
 * check.
 *
 * Three distinct states reach here, and only the first means "we hold bytes":
 *
 *   ""         a zero-byte file the user picked; readFileAsBase64 returns an
 *              empty string, so truthiness would wrongly say "no content"
 *   null       Rust blanked it. sanitize_saved_request_for_persistence sets
 *              file_content/binary_content to None on every read
 *              (lib.rs:1439 and :1453), and neither Option<String> carries
 *              skip_serializing_if -- the only field in that file that does is
 *              EnvVariable.vault_key -- so it serializes as JSON null, not as
 *              an absent key. `!== undefined` is therefore always true for
 *              anything loaded from disk.
 *   undefined  an import placeholder that never had content
 */
function hasInlinedFileContent(item: FormDataItem) {
  return item.valueType === "file" && typeof item.fileContent === "string"
}

function hasInlinedBinaryContent(body: RequestBody) {
  return body.type === "binary" && typeof body.binaryContent === "string"
}

function unexportableFileNote(fileName: string) {
  return `[ApiSolo] The content of "${fileName}" is stored inside ApiSolo and cannot be exported; select the file again in Postman.`
}

/**
 * Lists the uploads that cannot be written into the collection, so the UI can
 * tell the user before they hand the file to someone else.
 */
export function collectPostmanExportWarnings(
  requests: SavedRequest[],
): PostmanExportWarning[] {
  const warnings: PostmanExportWarning[] = []

  for (const request of requests) {
    if (hasInlinedBinaryContent(request.body)) {
      warnings.push({
        code: "file-content-not-exportable",
        requestName: request.name,
        fileName: request.body.binaryPath,
      })
    }

    for (const item of request.body.formData) {
      if (hasInlinedFileContent(item)) {
        warnings.push({
          code: "file-content-not-exportable",
          requestName: request.name,
          fileName: item.fileName ?? "",
        })
      }
    }
  }

  return warnings
}

interface PostmanCollection {
  info: {
    name: string
    schema: string
  }
  item: PostmanItem[]
}

interface PostmanItem {
  name: string
  item?: PostmanItem[]
  request?: {
    method: string
    header: Array<{ key: string; value: string; disabled?: boolean; description?: string }>
    url: {
      raw: string
      query?: Array<{ key: string; value: string; disabled?: boolean; description?: string }>
    }
    description?: string
    body?: {
      mode: string
      raw?: string
      urlencoded?: Array<{ key: string; value: string; disabled?: boolean; description?: string }>
      formdata?: Array<{
        key: string
        value?: string
        type?: "text" | "file"
        src?: string
        disabled?: boolean
        description?: string
        contentType?: string
      }>
      file?: {
        src?: string
      }
      options?: {
        raw?: {
          language?: string
        }
      }
    }
    auth?: Record<string, unknown>
  }
  event?: Array<{
    listen: string
    script: {
      type: "text/javascript"
      exec: string[]
    }
  }>
}

export function exportPostmanCollection(
  projectName: string,
  requests: SavedRequest[],
  tree: CollectionNode[],
) {
  const requestQueue = [...requests]
  const collection: PostmanCollection = {
    info: {
      name: projectName,
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: buildItems(tree, requestQueue),
  }

  return JSON.stringify(collection, null, 2)
}

function buildItems(nodes: CollectionNode[], requestQueue: SavedRequest[]): PostmanItem[] {
  return nodes.map((node) => {
    if (node.nodeType === "folder") {
      return {
        name: node.name,
        item: buildItems(node.children, requestQueue),
      }
    }

    const request = requestQueue.shift()
    if (!request) {
      throw new Error("Request tree and payload are out of sync")
    }

    return buildRequestItem(request)
  })
}

function buildRequestItem(request: SavedRequest): PostmanItem {
  const headers = toPostmanPairs(request.headers)
  const query = toPostmanPairs(request.params)
  const rawUrl = buildRawUrl(request.url, request.params, request.auth)
  const item: PostmanItem = {
    name: request.name,
    request: {
      method: request.method,
      header: headers,
      url: {
        raw: rawUrl,
        query: query.length ? query : undefined,
      },
      auth: buildAuth(request),
      body: buildBody(request),
      description: hasInlinedBinaryContent(request.body)
        ? unexportableFileNote(request.body.binaryPath)
        : undefined,
    },
    event: buildEvents(request),
  }

  if (!item.request?.description) {
    delete item.request?.description
  }

  if (!item.request?.auth) {
    delete item.request?.auth
  }

  if (!item.request?.body) {
    delete item.request?.body
  }

  if (!item.event?.length) {
    delete item.event
  }

  return item
}

function buildBody(request: SavedRequest) {
  if (request.body.type === "none") {
    return undefined
  }

  if (request.body.type === "binary") {
    return {
      mode: "file",
      file: {
        // Never fabricate a path Postman cannot resolve. mode:"file" still
        // carries the semantics; the missing src is explained on the request.
        src: hasInlinedBinaryContent(request.body)
          ? undefined
          : request.body.binaryPath || undefined,
      },
    }
  }

  if (request.body.type === "json" || request.body.type === "raw") {
    return {
      mode: "raw",
      raw: request.body.content,
      options: request.body.type === "json" ? { raw: { language: "json" } } : undefined,
    }
  }

  if (request.body.type === "form-urlencoded") {
    return {
      mode: "urlencoded",
      urlencoded: parseFormContent(request.body.content),
    }
  }

  if (request.body.type === "form-data") {
    return {
      mode: "formdata",
      formdata: toPostmanFormData(request.body.formData),
    }
  }

  return {
    mode: "raw",
    raw: request.body.content,
  }
}

function buildAuth(request: SavedRequest) {
  if (request.auth.type === "bearer") {
    return {
      type: "bearer",
      bearer: [{ key: "token", value: request.auth.bearer?.token ?? "" }],
    }
  }

  if (request.auth.type === "basic") {
    return {
      type: "basic",
      basic: [
        { key: "username", value: request.auth.basic?.username ?? "" },
        { key: "password", value: request.auth.basic?.password ?? "" },
      ],
    }
  }

  if (request.auth.type === "api-key") {
    return {
      type: "apikey",
      apikey: [
        { key: "key", value: request.auth.apiKey?.key ?? "" },
        { key: "value", value: request.auth.apiKey?.value ?? "" },
        { key: "in", value: request.auth.apiKey?.addTo ?? "header" },
      ],
    }
  }

  return undefined
}

function buildEvents(request: SavedRequest) {
  const events: PostmanItem["event"] = []

  if (request.preRequestScript.trim()) {
    events.push({
      listen: "prerequest",
      script: {
        type: "text/javascript",
        exec: request.preRequestScript.split("\n"),
      },
    })
  }

  if (request.testScript.trim()) {
    events.push({
      listen: "test",
      script: {
        type: "text/javascript",
        exec: request.testScript.split("\n"),
      },
    })
  }

  return events
}

function toPostmanPairs(items: KeyValuePair[]) {
  return items
    .filter((item) => item.key || item.value)
    .map((item) => ({
      key: item.key,
      value: item.value,
      disabled: item.enabled ? undefined : true,
      description: item.description || undefined,
    }))
}

function toPostmanFormData(items: FormDataItem[]) {
  return items
    .filter((item) => item.key || item.value || item.fileName)
    .map((item) => {
      const inlined = hasInlinedFileContent(item)
      const note = inlined ? unexportableFileNote(item.fileName ?? "") : ""

      return {
        key: item.key,
        value: item.valueType === "file" ? undefined : item.value,
        type: item.valueType === "file" ? ("file" as const) : ("text" as const),
        src:
          item.valueType === "file" && !inlined
            ? item.filePath || item.fileName || undefined
            : undefined,
        disabled: item.enabled ? undefined : true,
        description: [note, item.description].filter(Boolean).join(" ") || undefined,
        contentType: item.valueType === "file" ? item.contentType || undefined : undefined,
      }
    })
}

function parseFormContent(content: string) {
  if (!content.trim()) {
    return []
  }

  return content.split("&").map((pair) => {
    const [key = "", value = ""] = pair.split("=", 2)
    return { key, value }
  })
}

/**
 * Params are the only source of the query string, so a query left over in a
 * saved request's url (what a cURL import stores) is not appended twice. The
 * fragment stays last: the previous `url.includes("?")` concatenation
 * produced `…/a#frag?k=v`, which is not a valid URL. Values stay unencoded so
 * Postman's own {{variables}} survive.
 */
function buildRawUrl(url: string, params: KeyValuePair[], auth: SavedRequest["auth"]) {
  const { baseUrl, hash } = splitUrlParts(url)
  const queryItems = params
    .filter((item) => item.enabled && item.key)
    .map((item) => `${item.key}=${item.value}`)

  if (auth.type === "api-key" && auth.apiKey?.addTo === "query" && auth.apiKey.key) {
    queryItems.push(`${auth.apiKey.key}=${auth.apiKey.value ?? ""}`)
  }

  if (!queryItems.length) {
    return `${baseUrl}${hash}`
  }

  return `${baseUrl}?${queryItems.join("&")}${hash}`
}
