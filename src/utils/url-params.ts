import type { KeyValuePair } from "../types"

export function splitUrlParts(rawUrl: string) {
  const hashIndex = rawUrl.indexOf("#")
  const hash = hashIndex === -1 ? "" : rawUrl.slice(hashIndex)
  const beforeHash = hashIndex === -1 ? rawUrl : rawUrl.slice(0, hashIndex)
  const queryIndex = beforeHash.indexOf("?")
  const baseUrl = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex)

  return {
    baseUrl,
    hash,
  }
}

export function toParsableUrl(rawUrl: string) {
  return rawUrl.includes("://") ? rawUrl : `http://placeholder${rawUrl.startsWith("/") || rawUrl.startsWith("?") ? "" : "/"}${rawUrl}`
}

export function syncParamsFromUrl(rawUrl: string, currentParams: KeyValuePair[]) {
  try {
    const parsed = new URL(toParsableUrl(rawUrl))
    const params = [...parsed.searchParams.entries()].map(([key, value]) => ({
      id: crypto.randomUUID(),
      enabled: true,
      key,
      value,
      description: "",
    }))
    // Store URL without query string — params are the source of truth
    const { baseUrl, hash } = splitUrlParts(rawUrl)
    return {
      url: `${baseUrl}${hash}`,
      params: [...params, ...currentParams.filter((item) => !item.enabled)],
    }
  } catch {
    return {
      url: rawUrl,
      params: currentParams,
    }
  }
}

export function buildUrlWithParams(rawUrl: string, params: KeyValuePair[]) {
  const { baseUrl, hash } = splitUrlParts(rawUrl)
  const searchParams = new URLSearchParams()

  for (const item of params) {
    if (item.enabled && item.key) {
      searchParams.append(item.key, item.value)
    }
  }

  const query = searchParams.toString()
  const urlWithoutHash = query ? `${baseUrl}?${query}` : baseUrl
  return `${urlWithoutHash}${hash}`
}

export function stripQueryFromUrl(url: string) {
  const [baseUrl] = url.split("?")
  return baseUrl
}
