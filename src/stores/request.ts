import { defineStore } from "pinia"

import i18n from "../i18n"
import { recordConsoleEntry } from "./console"
import { useEnvironmentsStore } from "./environments"
import { useHistoryStore } from "./history"
import { resolveTemplate } from "../utils/resolve-template"
import { executeScript } from "../utils/script-executor"
import { invoke } from "../utils/invoke"
import {
  findSentinelFields,
  redactFormDataValues,
  sanitizeHistoryEntry,
} from "../utils/redaction"
import { stripQueryFromUrl } from "../utils/url-params"
import { useTabsStore } from "./tabs"
import type {
  EnvVariable,
  FormDataItem,
  HistoryEntry,
  HttpResponse,
  KeyValuePair,
  ProxyConfig,
  ScriptResult,
  Tab,
  TlsConfig,
} from "../types"
import { useSettingsStore } from "./settings"

const HISTORY_RESPONSE_BODY_LIMIT = 50_000

interface SendRequestPayload {
  requestId: string
  method: string
  url: string
  params: KeyValuePair[]
  headers: KeyValuePair[]
  body: {
    type: string
    content: string
    formData?: FormDataItem[]
    binaryPath?: string
    binaryContent?: string
  }
  auth: {
    type: string
    basic?: { username: string; password: string }
    bearer?: { token: string }
    apiKey?: { key: string; value: string; addTo: "header" | "query" }
  }
  proxy?: ProxyConfig
  tls?: TlsConfig
}

export const useRequestStore = defineStore("request", () => {
  const activeRequestIds = new Map<string, string>()
  const cancellingRequestIds = new Map<string, string>()
  const settledRequestIds = new Set<string>()

  function isRequestActive(tabId: string, requestId: string) {
    return (
      activeRequestIds.get(tabId) === requestId &&
      cancellingRequestIds.get(tabId) !== requestId
    )
  }

  function clearResponse(tab?: Tab) {
    const tabsStore = useTabsStore()
    const targetTab = tab ?? tabsStore.activeTab
    if (!targetTab) {
      return
    }

    tabsStore.updateTab(targetTab.id, {
      response: null,
      responseError: null,
      scriptResult: null,
      isLoading: false,
    })
  }

  async function sendRequest(tab: Tab) {
    const requestSnapshot = cloneTabSnapshot(tab)
    const tabsStore = useTabsStore()
    const requestId = crypto.randomUUID()
    const startedAt = Date.now()
    activeRequestIds.set(requestSnapshot.id, requestId)

    tabsStore.updateTab(requestSnapshot.id, {
      isLoading: true,
      response: null,
      responseError: null,
      scriptResult: null,
    })

    try {
      const environmentsStore = useEnvironmentsStore()

      // Gate on the unresolved snapshot: a variable that resolves to the
      // literal sentinel is a deliberate escape hatch and must still go out.
      const sentinelFields = findSentinelFields(requestSnapshot)
      if (sentinelFields.length > 0) {
        throw new Error(
          i18n.global.t("errors.redactionSentinelOnWire", { field: sentinelFields.join(", ") }),
        )
      }

      let variables = environmentsStore.variables.map((item) => ({ ...item }))
      let resolvedTab = resolveTabVariables(requestSnapshot, variables)
      const requestLabel = formatRequestLabel(requestSnapshot.method, requestSnapshot.url)

      recordConsoleEntry("info", `[network] ${requestLabel} started`, "network")

      if (requestSnapshot.preRequestScript.trim()) {
        const preResult = await executeScript(requestSnapshot.preRequestScript, {
          request: buildScriptRequest(resolvedTab),
          variables: toVariableMap(variables),
        })

        if (preResult.updatedVariables) {
          variables = mergeVariables(variables, preResult.updatedVariables)
          environmentsStore.setVariables(variables)
          resolvedTab = resolveTabVariables(requestSnapshot, variables)
        }

        if (!preResult.success) {
          tabsStore.updateTab(requestSnapshot.id, {
            scriptResult: preResult,
          })
          throw new Error(`Pre-request script failed: ${preResult.errors.join("; ")}`)
        }
      }

      const settingsStore = useSettingsStore()
      const payload = buildPayload(requestId, resolvedTab, settingsStore.proxy, settingsStore.tls)
      const result = await invoke<HttpResponse>("send_request", {
        args: payload,
      })

      if (!isRequestActive(requestSnapshot.id, requestId)) {
        return
      }

      let testResult: ScriptResult | null = null

      if (requestSnapshot.testScript.trim()) {
        testResult = await executeScript(requestSnapshot.testScript, {
          request: buildScriptRequest(resolvedTab),
          response: {
            status: result.status,
            statusText: result.statusText,
            headers: result.headers,
            body: result.body,
            time: result.time,
          },
          variables: toVariableMap(variables),
        })

        if (testResult.updatedVariables) {
          variables = mergeVariables(variables, testResult.updatedVariables)
          environmentsStore.setVariables(variables)
        }
      }

      tabsStore.updateTab(requestSnapshot.id, {
        response: result,
        responseError: null,
        scriptResult: testResult,
        isLoading: false,
      })

      recordConsoleEntry(
        "info",
        `[network] ${requestLabel} → ${result.status} ${result.statusText} (${result.time || Date.now() - startedAt}ms)`,
        "network",
      )

      const historyEntry = buildHistoryEntry(requestSnapshot, result)
      try {
        await invoke("append_history", { entry: historyEntry })
        useHistoryStore().appendEntry(historyEntry)
      } catch (historyError) {
        console.error("Failed to append request history:", historyError)
      }
    } catch (err) {
      if (!isRequestActive(requestSnapshot.id, requestId)) {
        return
      }

      recordConsoleEntry(
        "error",
        `[network] ${formatRequestLabel(requestSnapshot.method, requestSnapshot.url)} → Error: ${
          err instanceof Error ? err.message : String(err)
        }`,
        "network",
      )

      tabsStore.updateTab(requestSnapshot.id, {
        responseError: err instanceof Error ? err.message : String(err),
        isLoading: false,
      })
    } finally {
      settledRequestIds.add(requestId)
      if (
        cancellingRequestIds.get(requestSnapshot.id) !== requestId &&
        activeRequestIds.get(requestSnapshot.id) === requestId
      ) {
        activeRequestIds.delete(requestSnapshot.id)
      }
    }
  }

  async function cancelRequest(tabId: string) {
    const requestId = activeRequestIds.get(tabId)
    if (!requestId) {
      return
    }

    cancellingRequestIds.set(tabId, requestId)

    try {
      await invoke("cancel_request", { requestId })

      if (activeRequestIds.get(tabId) === requestId) {
        activeRequestIds.delete(tabId)
      }

      useTabsStore().updateTab(tabId, {
        isLoading: false,
      })
    } finally {
      if (cancellingRequestIds.get(tabId) === requestId) {
        cancellingRequestIds.delete(tabId)
      }

      if (settledRequestIds.has(requestId) && activeRequestIds.get(tabId) === requestId) {
        activeRequestIds.delete(tabId)
      }

      settledRequestIds.delete(requestId)
    }
  }

  return {
    sendRequest,
    cancelRequest,
    clearResponse,
  }
})

function formatRequestLabel(method: string, url: string) {
  return `${method} ${url || "(empty url)"}`
}

function buildPayload(
  requestId: string,
  tab: Tab,
  proxyConfig: ProxyConfig,
  tlsConfig: TlsConfig,
): SendRequestPayload {
  return {
    requestId,
    method: tab.method,
    url: stripQueryFromUrl(tab.url),
    params: tab.params,
    headers: tab.headers,
    body: buildBody(tab),
    auth: {
      type: tab.auth.type,
      basic: tab.auth.basic,
      bearer: tab.auth.bearer,
      apiKey: tab.auth.apiKey,
    },
    proxy: proxyConfig.enabled ? sanitizeProxyPayload(proxyConfig) : undefined,
    tls: { verifySsl: tlsConfig.verifySsl },
  }
}

function sanitizeProxyPayload(proxyConfig: ProxyConfig): ProxyConfig {
  return {
    ...proxyConfig,
    auth: proxyConfig.auth
      ? {
          username: proxyConfig.auth.username,
          password: proxyConfig.auth.password,
        }
      : undefined,
  }
}

function buildBody(tab: Tab) {
  const fileSelectionError = new Error(i18n.global.t("errors.fileSelectionRequired"))

  if (tab.body.type === "form-data") {
    return {
      type: tab.body.type,
      content: "",
      formData: tab.body.formData.map((item) => ({
        ...item,
        fileName: item.valueType === "file" ? sanitizeFileLabel(item.fileName || item.filePath || item.key) : "",
        filePath: "",
        fileContent:
          item.valueType === "file"
            ? item.fileContent && item.fileContent.length > 0
              ? item.fileContent
              : (() => { throw fileSelectionError })()
            : undefined,
      })),
    }
  }

  if (tab.body.type === "binary") {
    if (!tab.body.binaryContent || tab.body.binaryContent.length === 0) {
      throw fileSelectionError
    }

    return {
      type: tab.body.type,
      content: "",
      binaryPath: sanitizeFileLabel(tab.body.binaryPath),
      binaryContent: tab.body.binaryContent,
    }
  }

  return {
    type: tab.body.type,
    content: tab.body.content,
  }
}

function resolveTabVariables(tab: Tab, variables: EnvVariable[]): Tab {
  return {
    ...tab,
    url: resolveTemplate(tab.url, variables),
    params: tab.params.map((item) => ({
      ...item,
      key: resolveTemplate(item.key, variables),
      value: resolveTemplate(item.value, variables),
    })),
    headers: tab.headers.map((item) => ({
      ...item,
      key: resolveTemplate(item.key, variables),
      value: resolveTemplate(item.value, variables),
    })),
    body: {
      ...tab.body,
      content: resolveTemplate(tab.body.content, variables),
      binaryPath: resolveTemplate(tab.body.binaryPath, variables),
      formData: tab.body.formData.map((item) => ({
        ...item,
        filePath: item.filePath ? resolveTemplate(item.filePath, variables) : item.filePath,
        key: resolveTemplate(item.key, variables),
        value:
          item.valueType === "file" ? item.value : resolveTemplate(item.value, variables),
      })),
    },
    auth: {
      ...tab.auth,
      basic: tab.auth.basic
        ? {
            username: resolveTemplate(tab.auth.basic.username, variables),
            password: resolveTemplate(tab.auth.basic.password, variables),
          }
        : undefined,
      bearer: tab.auth.bearer
        ? {
            token: resolveTemplate(tab.auth.bearer.token, variables),
          }
        : undefined,
      apiKey: tab.auth.apiKey
        ? {
            ...tab.auth.apiKey,
            key: resolveTemplate(tab.auth.apiKey.key, variables),
            value: resolveTemplate(tab.auth.apiKey.value, variables),
          }
        : undefined,
    },
  }
}

function toVariableMap(variables: EnvVariable[]) {
  return Object.fromEntries(variables.map((item) => [item.key, item.value]))
}

function mergeVariables(variables: EnvVariable[], updates: Record<string, string>) {
  const variableMap = new Map(variables.map((item) => [item.key, { ...item }]))
  const knownSecretValues = new Set(
    variables.filter((item) => item.secret && item.value).map((item) => item.value),
  )

  for (const [key, value] of Object.entries(updates)) {
    const current = variableMap.get(key)
    if (current) {
      current.value = value
      continue
    }

    variableMap.set(key, {
      key,
      value,
      secret: knownSecretValues.has(value),
    })
  }

  return [...variableMap.values()]
}

function cloneTabSnapshot(tab: Tab): Tab {
  return {
    ...tab,
    params: tab.params.map((item) => ({ ...item })),
    headers: tab.headers.map((item) => ({ ...item })),
    body: {
      ...tab.body,
      binaryPath: tab.body.binaryPath,
      formData: tab.body.formData.map((item) => ({
        ...item,
        fileName:
          item.valueType === "file"
            ? sanitizeFileLabel(item.fileName || item.filePath || item.key)
            : item.fileName,
        filePath: item.filePath,
      })),
    },
    auth: {
      ...tab.auth,
      basic: tab.auth.basic ? { ...tab.auth.basic } : undefined,
      bearer: tab.auth.bearer ? { ...tab.auth.bearer } : undefined,
      apiKey: tab.auth.apiKey ? { ...tab.auth.apiKey } : undefined,
    },
    response: tab.response ? { ...tab.response, headers: tab.response.headers.map((item) => [...item] as [string, string]) } : tab.response,
    scriptResult: tab.scriptResult
      ? {
          ...tab.scriptResult,
          logs: [...tab.scriptResult.logs],
          errors: [...tab.scriptResult.errors],
          assertions: tab.scriptResult.assertions.map((item) => ({ ...item })),
          updatedVariables: tab.scriptResult.updatedVariables
            ? { ...tab.scriptResult.updatedVariables }
            : undefined,
        }
      : tab.scriptResult,
  }
}

function sanitizeFileLabel(value: string) {
  if (!value) {
    return ""
  }

  return value.split(/[\\/]/).pop() ?? value
}

function buildScriptRequest(tab: Tab) {
  return {
    method: tab.method,
    url: tab.url,
    headers: tab.headers
      .filter((header) => header.enabled && header.key.trim())
      .map(({ key, value }) => ({ key, value })),
    body:
      tab.body.type === "form-data"
        ? JSON.stringify(redactFormDataValues(sanitizeHistoryFormData(tab.body.formData)))
        : tab.body.type === "binary"
          ? `[binary ${sanitizeFileLabel(tab.body.binaryPath) || "file"}]`
          : buildBody(tab).content,
  }
}

function buildHistoryEntry(tab: Tab, response: HttpResponse): HistoryEntry {
  const raw: HistoryEntry = {
    id: crypto.randomUUID(),
    method: tab.method,
    url: tab.url,
    status: response.status,
    time: response.time,
    size: response.size,
    timings: response.timings,
    timestamp: new Date().toISOString(),
    contentType: response.contentType,
    requestParams: tab.params.filter((param) => param.enabled && param.key),
    requestHeaders: tab.headers.filter((header) => header.enabled && header.key),
    requestBodyType: tab.body.type,
    requestBodyContent: tab.body.content,
    requestAuthType: tab.auth.type,
    requestAuth: redactAuth(tab.auth),
    requestBodyFormData: sanitizeHistoryFormData(tab.body.formData),
    requestBodyBinaryPath: sanitizeFileLabel(tab.body.binaryPath),
    requestBodyBinaryContent: undefined,
    preRequestScript: tab.preRequestScript,
    testScript: tab.testScript,
    responseBody:
      response.body.length > HISTORY_RESPONSE_BODY_LIMIT
        ? `${response.body.slice(0, HISTORY_RESPONSE_BODY_LIMIT)}\n[truncated]`
        : response.body,
    responseHeaders: response.headers,
  }

  return sanitizeHistoryEntry(raw)
}

/**
 * Strips upload bytes and raw paths only. Value redaction is owned by
 * `sanitizeHistoryEntry` alone — redacting here as well made that call site
 * unreachable, so reverting it could not fail any test.
 */
function sanitizeHistoryFormData(formData: FormDataItem[]) {
  return formData.map((item) => ({
    ...item,
    value: item.valueType === "file" ? "" : item.value,
    fileName:
      item.valueType === "file"
        ? sanitizeFileLabel(item.fileName || item.filePath || item.key)
        : item.fileName,
    filePath: item.valueType === "file" ? "" : item.filePath,
    fileContent: undefined,
  }))
}

function redactAuth(auth: Tab["auth"]) {
  if (auth.type === "basic") {
    return {
      type: "basic" as const,
      basic: {
        username: auth.basic?.username ?? "",
        password: "",
      },
    }
  }

  if (auth.type === "bearer") {
    return {
      type: "bearer" as const,
      bearer: {
        token: "",
      },
    }
  }

  if (auth.type === "api-key") {
    return {
      type: "api-key" as const,
      apiKey: {
        key: auth.apiKey?.key ?? "",
        value: "",
        addTo: auth.apiKey?.addTo ?? "header",
      },
    }
  }

  return { type: "none" as const }
}
