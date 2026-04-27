import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

import i18n from "../../i18n"

const { executeScriptMock, invokeMock } = vi.hoisted(() => ({
  executeScriptMock: vi.fn(async () => ({
    success: true,
    logs: [] as string[],
    errors: [] as string[],
    assertions: [] as Array<{ name: string; passed: boolean; message?: string }>,
  })),
  invokeMock: vi.fn(),
}))

vi.mock("../../utils/script-executor", () => ({
  executeScript: executeScriptMock,
}))

vi.mock("../../utils/invoke", () => ({
  invoke: invokeMock,
}))

import { useRequestStore } from "../request"
import { useTabsStore } from "../tabs"
import type { HttpResponse } from "../../types"

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

    expect(historyPayload.entry.responseBody).not.toContain("response-secret-token")
    expect(historyPayload.entry.responseBody).not.toContain("another-secret")
    expect(historyPayload.entry.responseBody).toContain("[redacted]")
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
