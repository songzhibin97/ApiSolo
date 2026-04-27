import type { FormDataItem, KeyValuePair, Tab } from "../types"

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

function buildUrl(tab: Tab) {
  const fallbackBase = "http://localhost"
  const url = new URL(tab.url || fallbackBase, fallbackBase)

  for (const pair of enabledPairs(tab.params)) {
    url.searchParams.append(pair.key, pair.value)
  }

  if (tab.auth.type === "api-key" && tab.auth.apiKey?.addTo === "query" && tab.auth.apiKey.key) {
    url.searchParams.set(tab.auth.apiKey.key, tab.auth.apiKey.value ?? "")
  }

  if (!tab.url) {
    return url.pathname + url.search
  }

  if (!hasProtocol(tab.url)) {
    return `${url.pathname}${url.search}${url.hash}`
  }

  return url.toString()
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

function hasProtocol(value: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
}
