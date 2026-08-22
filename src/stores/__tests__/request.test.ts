import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

import i18n from "../../i18n"

const { executeScriptMock, invokeMock } = vi.hoisted(() => ({
  executeScriptMock: vi.fn(
    async (): Promise<{
      success: boolean
      logs: string[]
      errors: string[]
      assertions: Array<{ name: string; passed: boolean; message?: string }>
      updatedVariables?: Record<string, string>
    }> => ({
      success: true,
      logs: [],
      errors: [],
      assertions: [],
    }),
  ),
  invokeMock: vi.fn(),
}))

vi.mock("../../utils/script-executor", () => ({
  executeScript: executeScriptMock,
}))

vi.mock("../../utils/invoke", () => ({
  invoke: invokeMock,
}))

import pinia from ".."
import { useConsoleStore } from "../console"
import { useEnvironmentsStore } from "../environments"
import {
  HISTORY_RESPONSE_BODY_LIMIT,
  HISTORY_TRUNCATION_SUFFIX,
  useRequestStore,
} from "../request"
import { useTabsStore } from "../tabs"
import {
  REDACTION_SENTINEL,
  findSentinelFields,
  hasPendingRedactedFields,
  sanitizeHistoryEntry,
} from "../../utils/redaction"
import type { HistoryEntry, HttpResponse, KeyValuePair, SavedRequest, Tab } from "../../types"

function pair(key: string, value: string, overrides: Partial<KeyValuePair> = {}): KeyValuePair {
  return { id: `${key}-1`, enabled: true, key, value, description: "", ...overrides }
}

function okInvoke(commands: Record<string, unknown> = {}) {
  return async (command: string) => {
    if (command in commands) {
      return commands[command]
    }

    if (command === "send_request") {
      return buildResponse()
    }

    if (command === "list_environments") {
      return []
    }

    if (command === "append_history") {
      return null
    }

    throw new Error(`Unexpected invoke: ${command}`)
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void

  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })

  return { promise, resolve, reject }
}

function buildResponse(overrides: Partial<HttpResponse> = {}): HttpResponse {
  return {
    status: 200,
    statusText: "OK",
    headers: [["content-type", "application/json"]],
    body: "{\"ok\":true}",
    size: 11,
    time: 45,
    timings: {
      dnsLookup: 0,
      tcpConnect: 0,
      tlsHandshake: 0,
      ttfb: 0,
      download: 1,
      total: 45,
    },
    contentType: "application/json",
    bodyKind: "text",
    bodyTruncated: false,
    ...overrides,
  }
}

describe("useRequestStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMock.mockReset()
    executeScriptMock.mockClear()
  })

  it("records history from the send-time snapshot and does not attach results to a reset last tab", async () => {
    const deferred = createDeferred<HttpResponse>()

    invokeMock.mockImplementation(async (command: string, payload?: Record<string, unknown>) => {
      if (command === "send_request") {
        return deferred.promise
      }

      if (command === "append_history" || command === "cancel_request" || command === "list_environments") {
        return command === "list_environments" ? [] : null
      }

      throw new Error(`Unexpected invoke: ${command} ${JSON.stringify(payload)}`)
    })

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    const originalTabId = tabsStore.activeTab.id

    tabsStore.updateTab(originalTabId, {
      method: "POST",
      url: "https://api.example.com/users?draft=true",
      headers: [
        {
          id: "header-1",
          enabled: true,
          key: "Content-Type",
          value: "application/json",
          description: "",
        },
      ],
      body: {
        type: "json",
        content: "{\"name\":\"alice\"}",
        formData: [],
        binaryPath: "",
        binaryContent: "",
      },
    })

    const sendPromise = requestStore.sendRequest(tabsStore.activeTab)

    tabsStore.updateTab(originalTabId, {
      url: "https://api.example.com/admins",
      body: {
        type: "json",
        content: "{\"name\":\"bob\"}",
        formData: [],
        binaryPath: "",
        binaryContent: "",
      },
    })

    await tabsStore.removeTab(originalTabId)

    deferred.resolve(buildResponse())
    await sendPromise

    const sendPayload = invokeMock.mock.calls.find(([command]) => command === "send_request")?.[1] as {
      args: {
        url: string
        body: {
          content: string
        }
      }
    }
    const historyPayload = invokeMock.mock.calls.find(([command]) => command === "append_history")?.[1] as {
      entry: {
        url: string
        requestBodyContent: string
      }
    }

    expect(sendPayload.args.url).toBe("https://api.example.com/users")
    expect(sendPayload.args.body.content).toBe("{\"name\":\"alice\"}")
    expect(historyPayload.entry.url).toBe("https://api.example.com/users?draft=true")
    expect(historyPayload.entry.requestBodyContent).toBe("{\"name\":\"alice\"}")
    expect(tabsStore.activeTab.id).not.toBe(originalTabId)
    expect(tabsStore.activeTab.response).toBeNull()
    expect(tabsStore.activeTab.isLoading).toBe(false)
  })

  it("attaches a response when JSON formatting changes while the request is in flight", async () => {
    const deferred = createDeferred<HttpResponse>()

    invokeMock.mockImplementation(async (command: string) => {
      if (command === "send_request") {
        return deferred.promise
      }

      if (command === "append_history" || command === "list_environments") {
        return command === "list_environments" ? [] : null
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    const tabId = tabsStore.activeTab.id

    tabsStore.updateTab(tabId, {
      method: "POST",
      url: "https://api.example.com/users",
      body: {
        type: "json",
        content: "{\"key\":\"value\"}",
        formData: [],
        binaryPath: "",
        binaryContent: "",
      },
    })

    const sendPromise = requestStore.sendRequest(tabsStore.activeTab)

    tabsStore.updateTab(tabId, {
      body: {
        type: "json",
        content: "{\n  \"key\": \"value\"\n}",
        formData: [],
        binaryPath: "",
        binaryContent: "",
      },
    })

    deferred.resolve(buildResponse({ body: "{\"ok\":true,\"source\":\"history\"}" }))
    await sendPromise

    expect(tabsStore.activeTab.response?.body).toBe("{\"ok\":true,\"source\":\"history\"}")
    expect(tabsStore.activeTab.responseError).toBeNull()
    expect(tabsStore.activeTab.isLoading).toBe(false)
  })

  it("shows request errors when JSON formatting changes while the request is in flight", async () => {
    const deferred = createDeferred<HttpResponse>()

    invokeMock.mockImplementation(async (command: string) => {
      if (command === "send_request") {
        return deferred.promise
      }

      if (command === "list_environments") {
        return []
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    const tabId = tabsStore.activeTab.id

    tabsStore.updateTab(tabId, {
      method: "POST",
      url: "https://api.example.com/users",
      body: {
        type: "json",
        content: "{\"key\":\"value\"}",
        formData: [],
        binaryPath: "",
        binaryContent: "",
      },
    })

    const sendPromise = requestStore.sendRequest(tabsStore.activeTab)

    tabsStore.updateTab(tabId, {
      body: {
        type: "json",
        content: "{\n  \"key\": \"value\"\n}",
        formData: [],
        binaryPath: "",
        binaryContent: "",
      },
    })

    deferred.reject(new Error("TCP connect failed: Connection refused"))
    await sendPromise

    expect(tabsStore.activeTab.response).toBeNull()
    expect(tabsStore.activeTab.responseError).toBe("TCP connect failed: Connection refused")
    expect(tabsStore.activeTab.isLoading).toBe(false)
    expect(invokeMock.mock.calls.some(([command]) => command === "append_history")).toBe(false)
  })

  it("shows request errors when history URL query and JSON formatting normalize while the request is in flight", async () => {
    const deferred = createDeferred<HttpResponse>()

    invokeMock.mockImplementation(async (command: string) => {
      if (command === "send_request") {
        return deferred.promise
      }

      if (command === "list_environments") {
        return []
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    const tabId = tabsStore.activeTab.id

    tabsStore.updateTab(tabId, {
      method: "POST",
      url: "http://127.0.0.1:18766/history-post?case=json-body",
      params: [
        {
          id: "param-1",
          enabled: true,
          key: "case",
          value: "json-body",
          description: "history note",
        },
      ],
      body: {
        type: "json",
        content: "{\"key\":\"value\"}",
        formData: [],
        binaryPath: "",
        binaryContent: "",
      },
    })

    const sendPromise = requestStore.sendRequest(tabsStore.activeTab)

    tabsStore.updateTab(tabId, {
      url: "http://127.0.0.1:18766/history-post",
      params: [
        {
          id: "param-1",
          enabled: true,
          key: "case",
          value: "json-body",
          description: "",
        },
      ],
      body: {
        type: "json",
        content: "{\n  \"key\": \"value\"\n}",
        formData: [],
        binaryPath: "",
        binaryContent: "",
      },
    })

    deferred.reject(new Error("TCP connect failed: Connection refused"))
    await sendPromise

    expect(tabsStore.activeTab.response).toBeNull()
    expect(tabsStore.activeTab.responseError).toBe("TCP connect failed: Connection refused")
    expect(tabsStore.activeTab.isLoading).toBe(false)
  })

  it("attaches the active request response to the same tab even if editor fields change in flight", async () => {
    const deferred = createDeferred<HttpResponse>()

    invokeMock.mockImplementation(async (command: string) => {
      if (command === "send_request") {
        return deferred.promise
      }

      if (command === "append_history" || command === "list_environments") {
        return command === "list_environments" ? [] : null
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    const tabId = tabsStore.activeTab.id

    tabsStore.updateTab(tabId, {
      method: "GET",
      url: "https://api.example.com/users",
    })

    const sendPromise = requestStore.sendRequest(tabsStore.activeTab)

    tabsStore.updateTab(tabId, {
      url: "https://api.example.com/admins",
    })

    deferred.resolve(buildResponse())
    await sendPromise

    expect(tabsStore.activeTab.response).toEqual(expect.objectContaining({ status: 200 }))
    expect(tabsStore.activeTab.responseError).toBeNull()
    expect(tabsStore.activeTab.isLoading).toBe(false)
  })

  it("keeps tracking and loading state when cancellation fails", async () => {
    const deferred = createDeferred<HttpResponse>()

    invokeMock.mockImplementation(async (command: string) => {
      if (command === "send_request") {
        return deferred.promise
      }

      if (command === "cancel_request") {
        throw new Error("cancel failed")
      }

      if (command === "append_history") {
        return null
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    const sendPromise = requestStore.sendRequest(tabsStore.activeTab)

    await expect(requestStore.cancelRequest(tabsStore.activeTab.id)).rejects.toThrow("cancel failed")
    expect(tabsStore.activeTab.isLoading).toBe(true)

    deferred.resolve(buildResponse())
    await sendPromise

    expect(tabsStore.activeTab.response).toEqual(expect.objectContaining({ status: 200 }))
    expect(tabsStore.activeTab.isLoading).toBe(false)
  })

  it("drops tracking only after cancellation succeeds", async () => {
    const deferred = createDeferred<HttpResponse>()

    invokeMock.mockImplementation(async (command: string) => {
      if (command === "send_request") {
        return deferred.promise
      }

      if (command === "cancel_request" || command === "append_history") {
        return null
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()

    const sendPromise = requestStore.sendRequest(tabsStore.activeTab)
    await requestStore.cancelRequest(tabsStore.activeTab.id)

    deferred.resolve(buildResponse({ body: "{\"cancelled\":false}" }))
    await sendPromise

    expect(tabsStore.activeTab.response).toBeNull()
    expect(tabsStore.activeTab.isLoading).toBe(false)
    expect(invokeMock.mock.calls.some(([command]) => command === "append_history")).toBe(false)
  })

  it("rejects form-data uploads restored from raw file paths until the user reselects a file", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_environments") {
        return command === "list_environments" ? [] : null
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()

    tabsStore.updateTab(tabsStore.activeTab.id, {
      method: "POST",
      url: "https://api.example.com/upload",
      body: {
        type: "form-data",
        content: "",
        binaryPath: "/Users/test/ignored.bin",
        binaryContent: "",
        formData: [
          {
            id: "file-1",
            enabled: true,
            key: "file",
            value: "",
            description: "",
            valueType: "file",
            fileName: "",
            filePath: "/Users/test/fixtures/hello.txt",
            fileContent: undefined,
            contentType: "text/plain",
          },
        ],
      },
    })

    await requestStore.sendRequest(tabsStore.activeTab)

    expect(tabsStore.activeTab.response).toBeNull()
    expect(tabsStore.activeTab.responseError).toBe(i18n.global.t("errors.fileSelectionRequired"))
    expect(invokeMock.mock.calls.some(([command]) => command === "send_request")).toBe(false)
    expect(invokeMock.mock.calls.some(([command]) => command === "append_history")).toBe(false)
  })

  it("rejects binary uploads restored from raw file paths until the user reselects a file", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_environments") {
        return command === "list_environments" ? [] : null
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()

    tabsStore.updateTab(tabsStore.activeTab.id, {
      method: "POST",
      url: "https://api.example.com/binary",
      body: {
        type: "binary",
        content: "",
        formData: [],
        binaryPath: "/Users/test/fixtures/payload.bin",
        binaryContent: "",
      },
    })

    await requestStore.sendRequest(tabsStore.activeTab)

    expect(tabsStore.activeTab.response).toBeNull()
    expect(tabsStore.activeTab.responseError).toBe(i18n.global.t("errors.fileSelectionRequired"))
    expect(invokeMock.mock.calls.some(([command]) => command === "send_request")).toBe(false)
    expect(invokeMock.mock.calls.some(([command]) => command === "append_history")).toBe(false)
  })

  it("allows uploads once file content is present in the current session", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "send_request") {
        return buildResponse({ body: "uploaded" })
      }

      if (command === "append_history" || command === "list_environments") {
        return command === "list_environments" ? [] : null
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()

    tabsStore.updateTab(tabsStore.activeTab.id, {
      method: "POST",
      url: "https://api.example.com/upload",
      body: {
        type: "form-data",
        content: "",
        formData: [
          {
            id: "file-2",
            enabled: true,
            key: "file",
            value: "",
            description: "",
            valueType: "file",
            fileName: "hello.txt",
            filePath: "",
            fileContent: "aGVsbG8=",
            contentType: "text/plain",
          },
        ],
        binaryPath: "",
        binaryContent: "",
      },
    })

    await requestStore.sendRequest(tabsStore.activeTab)

    const sendPayload = invokeMock.mock.calls.find(([command]) => command === "send_request")?.[1] as {
      args: {
        body: {
          formData: Array<{
            fileName: string
            filePath: string
            fileContent?: string
          }>
        }
      }
    }
    const historyPayload = invokeMock.mock.calls.find(([command]) => command === "append_history")?.[1] as {
      entry: {
        requestBodyFormData: Array<{
          fileName: string
          filePath: string
          fileContent?: string
        }>
      }
    }

    expect(sendPayload.args.body.formData).toEqual([
      expect.objectContaining({
        fileName: "hello.txt",
        filePath: "",
        fileContent: "aGVsbG8=",
      }),
    ])
    expect(historyPayload.entry.requestBodyFormData).toEqual([
      expect.objectContaining({
        fileName: "hello.txt",
        filePath: "",
        fileContent: undefined,
      }),
    ])
    expect(tabsStore.activeTab.response).toEqual(expect.objectContaining({ body: "uploaded" }))
    expect(tabsStore.activeTab.responseError).toBeNull()
  })

  it("redacts bearer secrets inside persisted response bodies", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "send_request") {
        return buildResponse({
          body: "{\"authorization\":\"Bearer response-secret-token\",\"token\":\"another-secret\"}",
          size: 69,
        })
      }

      if (command === "append_history" || command === "list_environments") {
        return command === "list_environments" ? [] : null
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()

    tabsStore.updateTab(tabsStore.activeTab.id, {
      method: "GET",
      url: "https://api.example.com/echo",
    })

    await requestStore.sendRequest(tabsStore.activeTab)

    const historyPayload = invokeMock.mock.calls.find(([command]) => command === "append_history")?.[1] as {
      entry: {
        responseBody: string
      }
    }

    // Tightened from a `toContain` check: the old regex chain produced invalid
    // JSON here and the loose assertion never noticed.
    expect(historyPayload.entry.responseBody).toBe(
      '{"authorization":"[redacted]","token":"[redacted]"}',
    )
    expect(() => JSON.parse(historyPayload.entry.responseBody)).not.toThrow()
  })

  it("D09 §16 stores the truncation flag on the history row", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "send_request") {
        return buildResponse({ bodyTruncated: true })
      }
      if (command === "append_history" || command === "list_environments") {
        return command === "list_environments" ? [] : null
      }
      throw new Error(`Unexpected invoke: ${command}`)
    })

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    tabsStore.updateTab(tabsStore.activeTab.id, { url: "https://api.example.com/big" })

    await requestStore.sendRequest(tabsStore.activeTab)

    const payload = invokeMock.mock.calls.find(([command]) => command === "append_history")?.[1] as {
      entry: HistoryEntry
    }
    expect(payload.entry.responseBodyTruncated).toBe(true)
  })

  it("D09 §18 keeps the existing storage cut on a truncated body, both truncations intact", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "send_request") {
        return buildResponse({
          body: "a".repeat(HISTORY_RESPONSE_BODY_LIMIT + 1000),
          bodyTruncated: true,
        })
      }
      if (command === "append_history" || command === "list_environments") {
        return command === "list_environments" ? [] : null
      }
      throw new Error(`Unexpected invoke: ${command}`)
    })

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    tabsStore.updateTab(tabsStore.activeTab.id, { url: "https://api.example.com/big" })

    await requestStore.sendRequest(tabsStore.activeTab)

    const payload = invokeMock.mock.calls.find(([command]) => command === "append_history")?.[1] as {
      entry: HistoryEntry
    }
    // The relationship (limit + suffix), both read from the production module
    // - not retyped literals that would drift when another slice tunes them.
    expect(payload.entry.responseBody).toHaveLength(
      HISTORY_RESPONSE_BODY_LIMIT + HISTORY_TRUNCATION_SUFFIX.length,
    )
    expect(payload.entry.responseBody!.endsWith(HISTORY_TRUNCATION_SUFFIX)).toBe(true)
    expect(payload.entry.responseBodyTruncated).toBe(true)
  })

  it("D09 §19 a truncated response still goes through sanitizeHistoryEntry", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "send_request") {
        return buildResponse({
          body: '{"authorization":"secret-a","token":"secret-b"}',
          bodyTruncated: true,
        })
      }
      if (command === "append_history" || command === "list_environments") {
        return command === "list_environments" ? [] : null
      }
      throw new Error(`Unexpected invoke: ${command}`)
    })

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    tabsStore.updateTab(tabsStore.activeTab.id, { url: "https://api.example.com/big" })

    await requestStore.sendRequest(tabsStore.activeTab)

    const payload = invokeMock.mock.calls.find(([command]) => command === "append_history")?.[1] as {
      entry: HistoryEntry
    }
    // Truncation must not open a redaction bypass: the entry still leaves
    // through the same sanitizing exit.
    expect(payload.entry.responseBody).toBe(
      '{"authorization":"[redacted]","token":"[redacted]"}',
    )
    expect(payload.entry.responseBodyTruncated).toBe(true)
  })

  it("aborts the request when a pre-request script fails", async () => {
    executeScriptMock.mockResolvedValueOnce({
      success: false,
      logs: [],
      errors: ["bad signature"],
      assertions: [],
    })
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_environments") {
        return []
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()

    tabsStore.updateTab(tabsStore.activeTab.id, {
      method: "POST",
      url: "https://api.example.com/signed",
      preRequestScript: "throw new Error('bad signature')",
    })

    await requestStore.sendRequest(tabsStore.activeTab)

    expect(tabsStore.activeTab.response).toBeNull()
    expect(tabsStore.activeTab.scriptResult?.errors).toContain("bad signature")
    expect(tabsStore.activeTab.responseError).toContain("Pre-request script failed")
    expect(invokeMock.mock.calls.some(([command]) => command === "send_request")).toBe(false)
    expect(invokeMock.mock.calls.some(([command]) => command === "append_history")).toBe(false)
  })
})

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF-_123"
const DIGEST =
  'username="Mufasa", realm="testrealm@host.com", nonce="dcd98b7102dd2f0e", uri="/dir/index.html", response=6629fae49393a05397450978507c4ef1'

function baseHistoryEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "history-1",
    method: "POST",
    url: "https://api.example.com/users",
    status: 200,
    time: 12,
    size: 2,
    timestamp: "2026-04-28T10:00:00.000Z",
    contentType: "application/json",
    requestParams: [],
    requestHeaders: [],
    ...overrides,
  }
}

describe("the outbound redaction gate", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMock.mockReset()
    executeScriptMock.mockClear()
  })

  it.each([
    ["headers", "X-Test"],
    ["params", "access_token"],
    ["formData", "password"],
  ] as const)("refuses to send a sentinel value in %s", async (collection, key) => {
    invokeMock.mockImplementation(okInvoke())

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()

    tabsStore.updateTab(tabsStore.activeTab.id, {
      method: "POST",
      url: "https://api.example.com/users",
      headers: collection === "headers" ? [pair(key, REDACTION_SENTINEL)] : [],
      params: collection === "params" ? [pair(key, REDACTION_SENTINEL)] : [],
      body:
        collection === "formData"
          ? {
              type: "form-data",
              content: "",
              formData: [pair(key, REDACTION_SENTINEL)],
              binaryPath: "",
              binaryContent: "",
            }
          : { type: "none", content: "", formData: [], binaryPath: "", binaryContent: "" },
    })

    await requestStore.sendRequest(tabsStore.activeTab)

    expect(tabsStore.activeTab.responseError).toBe(
      i18n.global.t("errors.redactionSentinelOnWire", { field: key }),
    )
    expect(tabsStore.activeTab.responseError).toContain(key)
    expect(invokeMock.mock.calls.some(([command]) => command === "send_request")).toBe(false)
    expect(invokeMock.mock.calls.some(([command]) => command === "append_history")).toBe(false)
  })

  it("refuses a sentinel body value under a sensitive key", async () => {
    invokeMock.mockImplementation(okInvoke())

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()

    tabsStore.updateTab(tabsStore.activeTab.id, {
      method: "POST",
      url: "https://api.example.com/token",
      body: {
        type: "json",
        content: `{"user":"bob","password":"${REDACTION_SENTINEL}"}`,
        formData: [],
        binaryPath: "",
        binaryContent: "",
      },
    })

    await requestStore.sendRequest(tabsStore.activeTab)

    expect(tabsStore.activeTab.responseError).toBe(
      i18n.global.t("errors.redactionSentinelOnWire", { field: "password" }),
    )
    expect(invokeMock.mock.calls.some(([command]) => command === "send_request")).toBe(false)
  })

  it("sends a body whose prose contains the sentinel", async () => {
    invokeMock.mockImplementation(okInvoke())

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()

    tabsStore.updateTab(tabsStore.activeTab.id, {
      method: "POST",
      url: "https://api.example.com/notes",
      body: {
        type: "json",
        content: `{"note":"the string ${REDACTION_SENTINEL} appears here"}`,
        formData: [],
        binaryPath: "",
        binaryContent: "",
      },
    })

    await requestStore.sendRequest(tabsStore.activeTab)

    expect(tabsStore.activeTab.responseError).toBeNull()
    expect(invokeMock.mock.calls.some(([command]) => command === "send_request")).toBe(true)
  })

  it("refuses a sentinel restored from a saved collection request", async () => {
    invokeMock.mockImplementation(okInvoke())

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()

    // Rust writes `key=[redacted]` into urlencoded bodies of saved requests.
    const saved: SavedRequest = {
      name: "Token",
      method: "POST",
      url: "https://api.example.com/token",
      params: [],
      headers: [],
      body: {
        type: "form-urlencoded",
        content: `username=bob&password=${REDACTION_SENTINEL}`,
        formData: [],
        binaryPath: "",
        binaryContent: "",
      },
      auth: { type: "none" },
      preRequestScript: "",
      testScript: "",
    }

    tabsStore.openSavedRequest("demo", "auth/token.json", saved)
    await requestStore.sendRequest(tabsStore.activeTab)

    expect(tabsStore.activeTab.responseError).toBe(
      i18n.global.t("errors.redactionSentinelOnWire", { field: "password" }),
    )
    expect(invokeMock.mock.calls.some(([command]) => command === "send_request")).toBe(false)
  })

  it("sends a variable that resolves to the literal sentinel", async () => {
    invokeMock.mockImplementation(okInvoke())

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    useEnvironmentsStore().setVariables([
      { key: "lit", value: REDACTION_SENTINEL, secret: false },
    ])

    tabsStore.updateTab(tabsStore.activeTab.id, {
      method: "GET",
      url: "https://api.example.com/echo",
      headers: [pair("X-Test", "{{lit}}")],
    })

    await requestStore.sendRequest(tabsStore.activeTab)

    const sendPayload = invokeMock.mock.calls.find(([command]) => command === "send_request")?.[1] as {
      args: { headers: KeyValuePair[] }
    }

    expect(tabsStore.activeTab.responseError).toBeNull()
    expect(sendPayload.args.headers[0].value).toBe(REDACTION_SENTINEL)
  })

  it("sends a redacted-marked field as empty instead of blocking", async () => {
    invokeMock.mockImplementation(okInvoke())

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()

    tabsStore.updateTab(tabsStore.activeTab.id, {
      method: "GET",
      url: "https://api.example.com/echo",
      headers: [pair("Cookie", "", { redacted: true })],
    })

    await requestStore.sendRequest(tabsStore.activeTab)

    const sendPayload = invokeMock.mock.calls.find(([command]) => command === "send_request")?.[1] as {
      args: { headers: KeyValuePair[] }
    }

    expect(tabsStore.activeTab.responseError).toBeNull()
    expect(sendPayload.args.headers[0]).toEqual(expect.objectContaining({ key: "Cookie", value: "" }))
  })
})

describe("credentials under non-sensitive field names", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMock.mockReset()
    executeScriptMock.mockClear()
  })

  it.each([
    ["a bare Bearer token", "raw", `Bearer ${JWT}`],
    ["a bare Digest challenge", "raw", `Digest ${DIGEST}`],
    ["a json note holding a token", "json", '{"note":"Bearer abc123"}'],
    ["json prose mentioning Digest", "json", '{"note":"Digest authentication is required"}'],
  ])(
    "leaves credentials under non-sensitive keys untouched end to end for %s",
    async (_name, bodyType, content) => {
      invokeMock.mockImplementation(okInvoke())

      const tabsStore = useTabsStore()
      const requestStore = useRequestStore()

      const stored = sanitizeHistoryEntry(
        baseHistoryEntry({
          requestHeaders: [pair("X-Note", "password: hunter2")],
          requestBodyType: bodyType,
          requestBodyContent: content,
        }),
      )

      expect(stored.requestBodyContent).toBe(content)
      expect(stored.requestHeaders?.[0].value).toBe("password: hunter2")

      tabsStore.openHistoryEntry(stored)
      const opened = tabsStore.activeTab

      expect(opened.body.content).toBe(content)
      expect(opened.headers[0].value).toBe("password: hunter2")
      expect(hasPendingRedactedFields(opened)).toBe(false)
      expect(findSentinelFields(opened)).toEqual([])

      await requestStore.sendRequest(opened)

      expect(tabsStore.activeTab.responseError).toBeNull()
      expect(invokeMock.mock.calls.some(([command]) => command === "send_request")).toBe(true)
    },
  )
})

describe("history is built from a copy, never written back to the tab", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMock.mockReset()
    executeScriptMock.mockClear()
  })

  it("never rewrites live tab values while building history", async () => {
    invokeMock.mockImplementation(okInvoke())

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()

    tabsStore.updateTab(tabsStore.activeTab.id, {
      method: "GET",
      url: "https://api.example.com/me",
      headers: [pair("Cookie", "sid=abcdef123456; theme=dark")],
      body: {
        type: "json",
        content: '{"password":"hunter2"}',
        formData: [],
        binaryPath: "",
        binaryContent: "",
      },
    })

    await requestStore.sendRequest(tabsStore.activeTab)

    expect(tabsStore.activeTab.headers[0].value).toBe("sid=abcdef123456; theme=dark")
    expect(tabsStore.activeTab.body.content).toBe('{"password":"hunter2"}')

    const historyPayload = invokeMock.mock.calls.find(([command]) => command === "append_history")?.[1] as {
      entry: HistoryEntry
    }

    expect(historyPayload.entry.requestHeaders?.[0].value).toBe(REDACTION_SENTINEL)
  })

  it("never persists the redacted marker to history", async () => {
    invokeMock.mockImplementation(okInvoke())

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()

    tabsStore.updateTab(tabsStore.activeTab.id, {
      method: "POST",
      url: "https://api.example.com/users",
      headers: [pair("X-Note", "keep", { redacted: true })],
      params: [pair("page", "1", { redacted: true })],
      body: {
        type: "form-data",
        content: "",
        formData: [pair("field", "value", { redacted: true })],
        binaryPath: "",
        binaryContent: "",
      },
    })

    await requestStore.sendRequest(tabsStore.activeTab)

    const historyPayload = invokeMock.mock.calls.find(([command]) => command === "append_history")?.[1] as {
      entry: HistoryEntry
    }

    expect(JSON.stringify(historyPayload.entry)).not.toContain("redacted")
  })
})

describe("script-written environment variables", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMock.mockReset()
    executeScriptMock.mockClear()
  })

  it("marks a script-copied secret value as secret", async () => {
    invokeMock.mockImplementation(okInvoke())
    executeScriptMock.mockResolvedValueOnce({
      success: true,
      logs: [],
      errors: [],
      assertions: [],
      updatedVariables: { copied: "s3cr3t-value" },
    })

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    const environmentsStore = useEnvironmentsStore()
    environmentsStore.setVariables([{ key: "token", value: "s3cr3t-value", secret: true }])

    tabsStore.updateTab(tabsStore.activeTab.id, {
      method: "GET",
      url: "https://api.example.com/echo",
      preRequestScript: "pm.environment.set('copied', pm.environment.get('token'))",
    })

    await requestStore.sendRequest(tabsStore.activeTab)

    expect(environmentsStore.variables).toContainEqual({
      key: "copied",
      value: "s3cr3t-value",
      secret: true,
    })
  })

  it("does not mark an unrelated new variable as secret", async () => {
    invokeMock.mockImplementation(okInvoke())
    executeScriptMock.mockResolvedValueOnce({
      success: true,
      logs: [],
      errors: [],
      assertions: [],
      updatedVariables: { plain: "not-a-secret" },
    })

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    const environmentsStore = useEnvironmentsStore()
    environmentsStore.setVariables([{ key: "token", value: "s3cr3t-value", secret: true }])

    tabsStore.updateTab(tabsStore.activeTab.id, {
      method: "GET",
      url: "https://api.example.com/echo",
      preRequestScript: "pm.environment.set('plain', 'not-a-secret')",
    })

    await requestStore.sendRequest(tabsStore.activeTab)

    expect(environmentsStore.variables).toContainEqual({
      key: "plain",
      value: "not-a-secret",
      secret: false,
    })
  })

  it("keeps an existing secret variable secret when a script overwrites it", async () => {
    invokeMock.mockImplementation(okInvoke())
    executeScriptMock.mockResolvedValueOnce({
      success: true,
      logs: [],
      errors: [],
      assertions: [],
      updatedVariables: { token: "rotated-value" },
    })

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    const environmentsStore = useEnvironmentsStore()
    environmentsStore.setVariables([{ key: "token", value: "s3cr3t-value", secret: true }])

    tabsStore.updateTab(tabsStore.activeTab.id, {
      method: "GET",
      url: "https://api.example.com/echo",
      preRequestScript: "pm.environment.set('token', 'rotated-value')",
    })

    await requestStore.sendRequest(tabsStore.activeTab)

    expect(environmentsStore.variables).toContainEqual({
      key: "token",
      value: "rotated-value",
      secret: true,
    })
  })
})

describe("the console network line", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMock.mockReset()
    executeScriptMock.mockClear()
    useConsoleStore(pinia).clear()
  })

  it("logs the unresolved url to the console", async () => {
    invokeMock.mockImplementation(okInvoke())

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    useEnvironmentsStore().setVariables([
      { key: "base", value: "https://api.example.com", secret: false },
    ])

    tabsStore.updateTab(tabsStore.activeTab.id, {
      method: "GET",
      url: "{{base}}/users",
    })

    await requestStore.sendRequest(tabsStore.activeTab)

    const networkMessages = useConsoleStore(pinia)
      .entries.filter((entry) => entry.source === "network")
      .map((entry) => entry.message)

    expect(networkMessages).toContain("[network] GET {{base}}/users started")
    expect(networkMessages.join("\n")).not.toContain("https://api.example.com/users")
  })
})

// Every field of a history entry is redacted by one line inside
// `sanitizeHistoryEntry`. Testing that helper directly proves the *logic* but
// not the *wiring*: an independent review reverted five of those lines and the
// whole suite stayed green. Each test below drives the real send path and puts
// the credential in exactly one place, so reverting that one line — and only
// that line — turns it red. See specs/PROCESS.md P8.
describe("each sanitizeHistoryEntry call site is reachable from the send path", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMock.mockReset()
    executeScriptMock.mockClear()
  })

  async function sendAndCaptureHistory(
    patch: Partial<Tab>,
    response: Partial<HttpResponse> = {},
  ): Promise<HistoryEntry> {
    invokeMock.mockImplementation(okInvoke({ send_request: buildResponse(response) }))

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    tabsStore.updateTab(tabsStore.activeTab.id, patch)
    await requestStore.sendRequest(tabsStore.activeTab)

    expect(tabsStore.activeTab.responseError).toBeNull()
    const call = invokeMock.mock.calls.find(([command]) => command === "append_history")
    expect(call, "append_history was never called").toBeDefined()
    return (call![1] as { entry: HistoryEntry }).entry
  }

  it("redacts the url query on the way to append_history", async () => {
    const entry = await sendAndCaptureHistory({
      method: "GET",
      url: "https://api.example.com/s?access_token=abcdef123456&page=2",
    })

    expect(entry.url).toBe(`https://api.example.com/s?access_token=${REDACTION_SENTINEL}&page=2`)
  })

  it("redacts request params on the way to append_history", async () => {
    const entry = await sendAndCaptureHistory({
      method: "GET",
      url: "https://api.example.com/s",
      params: [pair("access_token", "abcdef123456"), pair("page", "2")],
    })

    expect(entry.requestParams?.map((item) => item.value)).toEqual([REDACTION_SENTINEL, "2"])
  })

  it("redacts request headers on the way to append_history", async () => {
    const entry = await sendAndCaptureHistory({
      method: "GET",
      url: "https://api.example.com/s",
      headers: [pair("Cookie", "sid=abcdef123456; theme=dark"), pair("Accept", "*/*")],
    })

    expect(entry.requestHeaders?.map((item) => item.value)).toEqual([REDACTION_SENTINEL, "*/*"])
  })

  it("redacts the request body on the way to append_history", async () => {
    const entry = await sendAndCaptureHistory({
      method: "POST",
      url: "https://api.example.com/token",
      body: {
        type: "json",
        content: '{"user":"bob","password":"hunter2","id":9007199254740993123456789}',
        formData: [],
        binaryPath: "",
        binaryContent: "",
      },
    })

    expect(entry.requestBodyContent).toBe(
      `{"user":"bob","password":"${REDACTION_SENTINEL}","id":9007199254740993123456789}`,
    )
  })

  it("redacts form-data values on the way to append_history", async () => {
    const entry = await sendAndCaptureHistory({
      method: "POST",
      url: "https://api.example.com/token",
      body: {
        type: "form-data",
        content: "",
        formData: [pair("password", "hunter2"), pair("grant_type", "password")],
        binaryPath: "",
        binaryContent: "",
      },
    })

    expect(entry.requestBodyFormData?.map((item) => item.value)).toEqual([
      REDACTION_SENTINEL,
      "password",
    ])
  })

  it("redacts the response body on the way to append_history", async () => {
    const entry = await sendAndCaptureHistory(
      { method: "GET", url: "https://api.example.com/me" },
      { body: '{"id":7,"refreshToken":"rt-abcdef123456"}' },
    )

    expect(entry.responseBody).toBe(`{"id":7,"refreshToken":"${REDACTION_SENTINEL}"}`)
  })

  it("redacts response headers on the way to append_history", async () => {
    const entry = await sendAndCaptureHistory(
      { method: "GET", url: "https://api.example.com/me" },
      {
        headers: [
          ["set-cookie", "sid=abcdef123456; theme=dark"],
          ["content-type", "application/json"],
        ],
      },
    )

    expect(entry.responseHeaders).toEqual([
      ["set-cookie", REDACTION_SENTINEL],
      ["content-type", "application/json"],
    ])
  })

  it("keeps a non-sensitive value byte-identical through the whole send path", async () => {
    const entry = await sendAndCaptureHistory({
      method: "POST",
      url: "https://api.example.com/notes",
      headers: [pair("X-Note", "password: hunter2")],
      params: [pair("hint", `Bearer ${JWT}`)],
      body: {
        type: "raw",
        content: `Digest ${DIGEST}`,
        formData: [],
        binaryPath: "",
        binaryContent: "",
      },
    })

    expect(entry.requestHeaders?.[0].value).toBe("password: hunter2")
    expect(entry.requestParams?.[0].value).toBe(`Bearer ${JWT}`)
    expect(entry.requestBodyContent).toBe(`Digest ${DIGEST}`)
  })
})

// The response body kind is machine-readable on the Rust side and was being
// dropped on the floor here, which is why a binary body used to reach the panel
// as a line of placeholder text with nothing marking it as such.
describe("§55 the response body kind reaches append_history", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMock.mockReset()
    executeScriptMock.mockClear()
  })

  async function captureEntry(response: Partial<HttpResponse>): Promise<HistoryEntry> {
    invokeMock.mockImplementation(okInvoke({ send_request: buildResponse(response) }))

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    await requestStore.sendRequest(tabsStore.activeTab)

    const call = invokeMock.mock.calls.find(([command]) => command === "append_history")
    expect(call, "append_history was never called").toBeDefined()
    return (call![1] as { entry: HistoryEntry }).entry
  }

  it("carries a text response through as text", async () => {
    expect((await captureEntry({ bodyKind: "text" })).responseBodyKind).toBe("text")
  })

  it("carries a binary response through as binary", async () => {
    expect((await captureEntry({ bodyKind: "binary" })).responseBodyKind).toBe("binary")
  })
})

// Same shape as the body kind above: HttpResponse has the reason phrase,
// HistoryEntry used to drop it, and the restore path then fabricated "OK" —
// a stored `201 Created` reopened as `201 OK`.
describe("the response statusText reaches append_history", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMock.mockReset()
    executeScriptMock.mockClear()
  })

  it("carries the statusText through to the history entry", async () => {
    invokeMock.mockImplementation(
      okInvoke({ send_request: buildResponse({ status: 201, statusText: "Created" }) }),
    )

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    await requestStore.sendRequest(tabsStore.activeTab)

    const call = invokeMock.mock.calls.find(([command]) => command === "append_history")
    expect(call, "append_history was never called").toBeDefined()
    expect((call![1] as { entry: HistoryEntry }).entry.statusText).toBe("Created")
  })
})

// §34 / §41: annotations are data about a call, never part of one. A note is
// the one field here a user can type free text into, so it is also the one
// that would quietly become a header or a body field if anything ever spread
// a history entry into the outgoing request.
describe("§34/§41 notes and stars never reach the wire", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMock.mockReset()
    executeScriptMock.mockClear()
  })

  /**
   * The annotation is put on the tab itself, which is the shape the defect
   * would actually take: something copies an annotated history row wholesale
   * onto a tab, and the payload builder spreads the tab instead of naming the
   * fields it wants. Replaying through `openHistoryEntry` alone cannot show
   * this — that path never copies a note onto the tab, so a leak in the builder
   * would have nothing to leak and the test would pass either way.
   */
  it("sends nothing named note or starred when the tab is carrying them", async () => {
    invokeMock.mockImplementation(okInvoke())

    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    tabsStore.openHistoryEntry({
      id: "annotated-1",
      method: "GET",
      url: "https://api.example.com/notes",
      status: 200,
      time: 5,
      size: 2,
      timestamp: "2026-03-27T10:00:00Z",
      contentType: "application/json",
      note: "do not send me",
      starred: true,
    } as HistoryEntry)
    tabsStore.updateTab(tabsStore.activeTab.id, {
      note: "do not send me",
      starred: true,
    } as never)
    expect((tabsStore.activeTab as never as { note: string }).note).toBe("do not send me")

    await requestStore.sendRequest(tabsStore.activeTab)

    const call = invokeMock.mock.calls.find(([command]) => command === "send_request")
    expect(call, "send_request was never called").toBeDefined()
    const payload = JSON.stringify(call![1])

    expect(payload).not.toContain("do not send me")
    expect(payload).not.toContain("\"note\"")
    expect(payload).not.toContain("\"starred\"")
  })
})
