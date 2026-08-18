import type { FormDataItem, KeyValuePair, Tab } from "../types"
import { encodeQueryComponentPreservingTemplates, splitUrlParts } from "./url-query"

export function exportCurl(tab: Tab) {
  const parts = ["curl"]

  if (tab.method !== "GET") {
    parts.push("-X", shellEscape(tab.method))
  }

  for (const header of enabledPairs(tab.headers)) {
    parts.push("-H", shellEscape(`${header.key}: ${header.value}`))
  }

  if (tab.auth.type === "basic" && tab.auth.basic) {
    parts.push("-u", shellEscape(`${tab.auth.basic.username}:${tab.auth.basic.password}`))
  }

  if (tab.auth.type === "bearer" && tab.auth.bearer?.token) {
    parts.push("-H", shellEscape(`Authorization: Bearer ${tab.auth.bearer.token}`))
  }

  if (tab.auth.type === "api-key" && tab.auth.apiKey?.key) {
    const apiKey = `${tab.auth.apiKey.key}: ${tab.auth.apiKey.value ?? ""}`
    if (tab.auth.apiKey.addTo === "header") {
      parts.push("-H", shellEscape(apiKey))
    }
  }

  for (const [flag, value] of buildBodyArgs(tab)) {
    parts.push(flag, shellEscape(value))
  }

  parts.push(shellEscape(buildUrl(tab)))

  return parts.join(" ")
}

function enabledPairs(items: KeyValuePair[]) {
  return items.filter((item) => item.enabled && item.key.trim())
}

/**
 * The params table is the single source of the query string, exactly as the
 * URL bar renders it, so a query string left over in `tab.url` (which a cURL
 * import leaves behind) is not emitted a second time. The base is passed
 * through untouched: no `new URL` round trip, so templates, protocol-less
 * hosts and the user's own casing all survive.
 */
function buildUrl(tab: Tab) {
  const { baseUrl, hash } = splitUrlParts(tab.url)
  const pairs = enabledPairs(tab.params).map(({ key, value }) => ({ key, value }))

  if (tab.auth.type === "api-key" && tab.auth.apiKey?.addTo === "query" && tab.auth.apiKey.key) {
    // Replace rather than append, matching the previous searchParams.set().
    const key = tab.auth.apiKey.key
    const entry = { key, value: tab.auth.apiKey.value ?? "" }
    const existing = pairs.findIndex((pair) => pair.key === key)
    if (existing === -1) {
      pairs.push(entry)
    } else {
      pairs[existing] = entry
    }
  }

  const query = pairs
    .map(
      (pair) =>
        `${encodeQueryComponentPreservingTemplates(pair.key)}=${encodeQueryComponentPreservingTemplates(pair.value)}`,
    )
    .join("&")

  return `${baseUrl}${query ? `?${query}` : ""}${hash}`
}

function buildBodyArgs(tab: Tab): Array<[string, string]> {
  if (tab.body.type === "none") {
    return []
  }

  if (tab.body.type === "form-data") {
    return enabledPairs(tab.body.formData)
      .map((item) => ["-F", formatFormDataValue(item)] as [string, string])
  }

  if (tab.body.type === "binary") {
    return [["--data-binary", `@${tab.body.binaryPath || "binary.bin"}`]]
  }

  return tab.body.content ? [["--data-raw", tab.body.content]] : []
}

function formatFormDataValue(item: FormDataItem) {
  if (item.valueType === "file") {
    const fileName = item.filePath || item.fileName || item.key || "file"
    const typeSuffix = item.contentType ? `;type=${item.contentType}` : ""
    return `${item.key}=@${fileName}${typeSuffix}`
  }

  return `${item.key}=${item.value}`
}

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}
