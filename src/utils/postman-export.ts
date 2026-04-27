import type { CollectionNode, FormDataItem, KeyValuePair, SavedRequest } from "../types"

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
    },
    event: buildEvents(request),
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
        src: request.body.binaryPath || undefined,
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
    .map((item) => ({
      key: item.key,
      value: item.valueType === "file" ? undefined : item.value,
      type: item.valueType === "file" ? ("file" as const) : ("text" as const),
      src:
        item.valueType === "file"
          ? item.filePath || item.fileName || undefined
          : undefined,
      disabled: item.enabled ? undefined : true,
      description: item.description || undefined,
      contentType: item.valueType === "file" ? item.contentType || undefined : undefined,
    }))
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

function buildRawUrl(url: string, params: KeyValuePair[], auth: SavedRequest["auth"]) {
  const queryItems = params
    .filter((item) => item.enabled && item.key)
    .map((item) => `${item.key}=${item.value}`)

  if (auth.type === "api-key" && auth.apiKey?.addTo === "query" && auth.apiKey.key) {
    queryItems.push(`${auth.apiKey.key}=${auth.apiKey.value ?? ""}`)
  }

  if (!queryItems.length) {
    return url
  }

  const separator = url.includes("?") ? "&" : "?"
  return `${url}${separator}${queryItems.join("&")}`
}
