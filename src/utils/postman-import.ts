import type { AuthConfig, HttpMethod, KeyValuePair, RequestBody, SavedRequest } from "../types"

export interface PostmanImportResult {
  name: string
  requests: Array<{
    name: string
    folderPath: string
    request: SavedRequest
  }>
}

interface PostmanCollection {
  info?: {
    name?: string
    schema?: string
  }
  item?: PostmanItem[]
}

interface PostmanItem {
  name?: string
  item?: PostmanItem[]
  request?: PostmanRequest
  event?: PostmanEvent[]
}

interface PostmanRequest {
  method?: string
  url?: string | PostmanUrl
  header?: PostmanHeader[]
  body?: PostmanBody
  auth?: PostmanAuth
}

interface PostmanUrl {
  raw?: string
  protocol?: string
  host?: string[]
  port?: string
  path?: string[]
  query?: Array<{ key?: string; value?: string; disabled?: boolean; description?: string }>
}

interface PostmanHeader {
  key?: string
  value?: string
  disabled?: boolean
  description?: string
}

interface PostmanBody {
  mode?: string
  raw?: string
  urlencoded?: Array<{ key?: string; value?: string; disabled?: boolean; description?: string }>
  formdata?: Array<{
    key?: string
    value?: string
    type?: string
    src?: string | string[]
    disabled?: boolean
    description?: string
    contentType?: string
  }>
  file?: {
    src?: string | string[]
  }
  options?: {
    raw?: {
      language?: string
    }
  }
}

interface PostmanAuth {
  type?: string
  bearer?: Array<{ key?: string; value?: string }>
  basic?: Array<{ key?: string; value?: string }>
  apikey?: Array<{ key?: string; value?: string }>
}

interface PostmanEvent {
  listen?: string
  script?: {
    exec?: string[]
  }
}

export function parsePostmanCollection(json: string): PostmanImportResult {
  const collection = JSON.parse(json) as PostmanCollection

  if (!collection.info?.schema?.includes("collection")) {
    throw new Error("Invalid Postman Collection")
  }

  const requests: PostmanImportResult["requests"] = []
  walkItems(collection.item ?? [], [], requests)

  return {
    name: collection.info?.name?.trim() || "Imported Collection",
    requests,
  }
}

function walkItems(
  items: PostmanItem[],
  folderParts: string[],
  requests: PostmanImportResult["requests"],
) {
  for (const item of items) {
    const name = item.name?.trim() || "Untitled Request"

    if (item.item?.length) {
      walkItems(item.item, [...folderParts, name], requests)
      continue
    }

    if (!item.request) {
      continue
    }

    requests.push({
      name,
      folderPath: folderParts.join("/"),
      request: buildSavedRequest(name, item.request, item.event ?? []),
    })
  }
}

function buildSavedRequest(name: string, request: PostmanRequest, events: PostmanEvent[]): SavedRequest {
  const { url, params } = parseUrl(request.url)
  const headers = buildKeyValuePairs(request.header ?? [])
  const scripts = parseScripts(events)

  return {
    name,
    method: normalizeMethod(request.method),
    url,
    params,
    headers,
    body: parseBody(request.body),
    auth: parseAuth(request.auth),
    preRequestScript: scripts.preRequestScript,
    testScript: scripts.testScript,
  }
}

function parseUrl(input?: string | PostmanUrl) {
  if (!input) {
    return { url: "", params: [] as KeyValuePair[] }
  }

  if (typeof input === "string") {
    return splitUrlAndParams(input)
  }

  const params = buildKeyValuePairs(input.query ?? [])
  if (input.raw?.trim()) {
    const parsed = splitUrlAndParams(input.raw)
    return {
      url: parsed.url,
      params: params.length ? params : parsed.params,
    }
  }

  const host = (input.host ?? []).join(".")
  const path = (input.path ?? []).join("/")
  const protocol = input.protocol ? `${input.protocol}://` : ""
  const port = input.port ? `:${input.port}` : ""
  const base = `${protocol}${host}${port}`
  const pathname = path ? `/${path}` : ""

  return {
    url: `${base}${pathname}`,
    params,
  }
}

function splitUrlAndParams(raw: string) {
  const [beforeHash, hash = ""] = raw.split("#", 2)
  const queryIndex = beforeHash.indexOf("?")

  if (queryIndex === -1) {
    return {
      url: raw,
      params: [] as KeyValuePair[],
    }
  }

  const url = `${beforeHash.slice(0, queryIndex)}${hash ? `#${hash}` : ""}`
  const queryString = beforeHash.slice(queryIndex + 1)

  return {
    url,
    params: parseQueryString(queryString),
  }
}

function parseQueryString(queryString: string) {
  if (!queryString) {
    return []
  }

  return queryString
    .split("&")
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const [key = "", value = ""] = pair.split("=", 2)
      return createPair({
        key: safeDecode(key),
        value: safeDecode(value),
      })
    })
}

function parseBody(body?: PostmanBody): RequestBody {
  const base: RequestBody = {
    type: "none",
    content: "",
    formData: [],
    binaryPath: "",
    binaryContent: undefined,
  }

  if (!body?.mode) {
    return base
  }

  if (body.mode === "raw") {
    const language = body.options?.raw?.language?.toLowerCase()
    return {
      ...base,
      type: language === "json" ? "json" : "raw",
      content: body.raw ?? "",
    }
  }

  if (body.mode === "urlencoded") {
    const formPairs = buildKeyValuePairs(body.urlencoded ?? [])
    return {
      ...base,
      type: "form-urlencoded",
      content: toQueryString(formPairs),
    }
  }

  if (body.mode === "formdata") {
    return {
      ...base,
      type: "form-data",
      formData: buildFormDataItems(body.formdata ?? []),
    }
  }

  if (body.mode === "file") {
    return {
      ...base,
      type: "binary",
      binaryPath: basename(normalizePostmanFileSrc(body.file?.src)),
    }
  }

  return base
}

function buildFormDataItems(
  items: NonNullable<PostmanBody["formdata"]>,
) {
  return items.map((item) => {
    const pair = createPair({
      key: item.key ?? "",
      value: item.value ?? "",
      enabled: item.disabled !== true,
      description: item.description,
    })

    if (item.type === "file") {
      return {
        ...pair,
        value: "",
        valueType: "file" as const,
        fileName: basename(normalizePostmanFileSrc(item.src)),
        filePath: "",
        fileContent: undefined,
        contentType: item.contentType ?? "",
      }
    }

    return {
      ...pair,
      valueType: "text" as const,
      fileName: "",
      filePath: "",
      fileContent: undefined,
      contentType: "",
    }
  })
}

function normalizePostmanFileSrc(src?: string | string[]) {
  if (Array.isArray(src)) {
    return src[0] ?? ""
  }

  return src ?? ""
}

function basename(path: string) {
  if (!path) {
    return ""
  }

  return path.split(/[\\/]/).pop() ?? path
}

function parseAuth(auth?: PostmanAuth): AuthConfig {
  if (!auth?.type) {
    return { type: "none" }
  }

  if (auth.type === "bearer") {
    return {
      type: "bearer",
      bearer: {
        token: findAuthValue(auth.bearer, "token"),
      },
    }
  }

  if (auth.type === "basic") {
    return {
      type: "basic",
      basic: {
        username: findAuthValue(auth.basic, "username"),
        password: findAuthValue(auth.basic, "password"),
      },
    }
  }

  if (auth.type === "apikey") {
    const addTo = findAuthValue(auth.apikey, "in") === "query" ? "query" : "header"
    return {
      type: "api-key",
      apiKey: {
        key: findAuthValue(auth.apikey, "key"),
        value: findAuthValue(auth.apikey, "value"),
        addTo,
      },
    }
  }

  return { type: "none" }
}

function parseScripts(events: PostmanEvent[]) {
  return {
    preRequestScript: formatImportedScript(
      events.find((event) => event.listen === "prerequest")?.script?.exec,
    ),
    testScript: formatImportedScript(events.find((event) => event.listen === "test")?.script?.exec),
  }
}

function formatImportedScript(lines?: string[]) {
  const script = (lines ?? []).join("\n").trim()
  if (!script) {
    return ""
  }

  const commentedScript = script
    .split(/\r?\n/)
    .map((line) => `// ${line}`)
    .join("\n")

  return [
    "// Imported from Postman for reference only.",
    "// This script is preserved as text and is not executed automatically.",
    commentedScript,
  ].join("\n")
}

function buildKeyValuePairs(
  items: Array<{
    key?: string
    value?: string
    disabled?: boolean
    description?: string
  }>,
) {
  return items
    .filter((item) => item.key || item.value)
    .map((item) =>
      createPair({
        key: item.key ?? "",
        value: item.value ?? "",
        enabled: item.disabled !== true,
        description: item.description ?? "",
      }),
    )
}

function createPair({
  key,
  value,
  enabled = true,
  description = "",
}: {
  key: string
  value: string
  enabled?: boolean
  description?: string
}): KeyValuePair {
  return {
    id: crypto.randomUUID(),
    enabled,
    key,
    value,
    description,
  }
}

function normalizeMethod(method?: string): HttpMethod {
  const normalized = method?.toUpperCase()
  const allowedMethods = new Set<HttpMethod>([
    "GET",
    "POST",
    "PUT",
    "DELETE",
    "PATCH",
    "HEAD",
    "OPTIONS",
  ])

  return allowedMethods.has(normalized as HttpMethod) ? (normalized as HttpMethod) : "GET"
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function toQueryString(items: KeyValuePair[]) {
  return items
    .filter((item) => item.enabled && item.key)
    .map((item) => `${item.key}=${item.value}`)
    .join("&")
}

function findAuthValue(
  items: Array<{ key?: string; value?: string }> | undefined,
  targetKey: string,
) {
  return items?.find((item) => item.key === targetKey)?.value ?? ""
}
