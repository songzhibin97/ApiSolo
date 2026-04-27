import { beforeEach, describe, expect, it } from "vitest"
import { createPinia, setActivePinia } from "pinia"

import { useTabsStore } from "../tabs"
import type { HistoryEntry } from "../../types"

function makeHistoryEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: crypto.randomUUID(),
    method: "POST",
    url: "https://api.example.com/users?active=true",
    status: 200,
    time: 120,
    size: 256,
    timestamp: new Date().toISOString(),
    contentType: "application/json",
    ...overrides,
  }
}

describe("useTabsStore.openHistoryEntry", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it("restores request snapshots from history", () => {
    const store = useTabsStore()

    store.openHistoryEntry(
      makeHistoryEntry({
        requestParams: [
          {
            id: "param-1",
            enabled: true,
            key: "page",
            value: "1",
            description: "",
          },
        ],
        requestHeaders: [
          {
            id: "header-1",
            enabled: true,
            key: "X-Test",
            value: "enabled",
            description: "",
          },
        ],
        requestBodyType: "json",
        requestBodyContent: "{\"name\":\"alice\"}",
        requestAuthType: "bearer",
        requestAuth: {
          type: "bearer",
          bearer: { token: "secret-token" },
        },
      }),
    )

    expect(store.tabs).toHaveLength(2)
    const openedTab = store.activeTab
    expect(openedTab.method).toBe("POST")
    expect(openedTab.url).toBe("https://api.example.com/users?active=true")
    expect(openedTab.label).toBe("/users?active=true")
    expect(openedTab.params).toHaveLength(1)
    expect(openedTab.params[0].key).toBe("page")
    expect(openedTab.headers).toHaveLength(1)
    expect(openedTab.headers[0].key).toBe("X-Test")
    expect(openedTab.body.type).toBe("json")
    expect(openedTab.body.content).toBe("{\"name\":\"alice\"}")
    expect(openedTab.auth.type).toBe("bearer")
    expect(openedTab.auth.bearer?.token).toBe("secret-token")
  })

  it("restores response snapshots from history", () => {
    const store = useTabsStore()

    store.openHistoryEntry(
      makeHistoryEntry({
        status: 201,
        time: 236,
        size: 17,
        contentType: "application/json",
        timings: {
          dnsLookup: 3,
          tcpConnect: 4,
          tlsHandshake: 5,
          ttfb: 200,
          download: 9,
          total: 236,
        },
        responseBody: "{\"ok\":true}",
        responseHeaders: [["content-type", "application/json"]],
      }),
    )

    expect(store.activeTab.response).toEqual({
      status: 201,
      statusText: "OK",
      headers: [["content-type", "application/json"]],
      body: "{\"ok\":true}",
      size: 17,
      time: 236,
      contentType: "application/json",
      timings: {
        dnsLookup: 3,
        tcpConnect: 4,
        tlsHandshake: 5,
        ttfb: 200,
        download: 9,
        total: 236,
      },
    })
  })

  it("hydrates an existing matching empty tab from history", () => {
    const store = useTabsStore()
    const existingTabId = store.activeTab.id

    store.updateTab(existingTabId, {
      method: "POST",
      url: "https://api.example.com/users",
      params: [
        {
          id: "current-param",
          enabled: true,
          key: "active",
          value: "true",
          description: "",
        },
      ],
      body: {
        ...store.activeTab.body,
        type: "json",
        content: "{\"name\":\"alice\"}",
      },
    })

    store.openHistoryEntry(
      makeHistoryEntry({
        method: "POST",
        url: "https://api.example.com/users",
        requestParams: [
          {
            id: "history-param",
            enabled: true,
            key: "active",
            value: "true",
            description: "",
          },
        ],
        requestBodyType: "json",
        requestBodyContent: "{\"name\":\"alice\"}",
        responseBody: "{\"ok\":true}",
        responseHeaders: [["content-type", "application/json"]],
      }),
    )

    expect(store.tabs).toHaveLength(1)
    expect(store.activeTab.id).toBe(existingTabId)
    expect(store.activeTab.response?.body).toBe("{\"ok\":true}")
  })

  it("restores structured form-data and binary history payloads", () => {
    const store = useTabsStore()

    store.openHistoryEntry(
      makeHistoryEntry({
        requestBodyType: "form-data",
        requestBodyFormData: [
          {
            id: "fd-1",
            enabled: true,
            key: "file",
            value: "",
            description: "",
            valueType: "file",
            fileName: "hello.txt",
            fileContent: "aGVsbG8=",
            contentType: "text/plain",
          },
        ],
        requestBodyBinaryPath: "payload.bin",
        requestBodyBinaryContent: "AQID",
      }),
    )

    expect(store.activeTab.body.formData).toHaveLength(1)
    expect(store.activeTab.body.formData[0].valueType).toBe("file")
    expect(store.activeTab.body.formData[0].fileName).toBe("hello.txt")
    expect(store.activeTab.body.binaryPath).toBe("payload.bin")
    expect(store.activeTab.body.binaryContent).toBe("AQID")
  })

  it("sanitizes legacy raw file paths from history snapshots", () => {
    const store = useTabsStore()

    store.openHistoryEntry(
      makeHistoryEntry({
        requestBodyType: "form-data",
        requestBodyFormData: [
          {
            id: "fd-legacy",
            enabled: true,
            key: "file",
            value: "",
            description: "",
            valueType: "file",
            fileName: "",
            filePath: "/tmp/secrets/hello.txt",
            fileContent: undefined,
            contentType: "text/plain",
          },
        ],
        requestBodyBinaryPath: "/tmp/secrets/payload.bin",
      }),
    )

    expect(store.activeTab.body.formData[0].fileName).toBe("hello.txt")
    expect(store.activeTab.body.formData[0].filePath).toBe("")
    expect(store.activeTab.body.binaryPath).toBe("payload.bin")
  })

  it("keeps default tab state for legacy history entries", () => {
    const store = useTabsStore()

    store.openHistoryEntry(makeHistoryEntry({ method: "get" }))

    const openedTab = store.activeTab
    expect(openedTab.method).toBe("GET")
    expect(openedTab.params).toHaveLength(1)
    expect(openedTab.params[0].key).toBe("active")
    expect(openedTab.params[0].value).toBe("true")
    expect(openedTab.headers).toHaveLength(0)
    expect(openedTab.body.type).toBe("none")
    expect(openedTab.auth.type).toBe("none")
  })

  it("opens a new tab when method and url match but history snapshots differ", () => {
    const store = useTabsStore()
    const sharedUrl = "https://api.example.com/users/1"

    store.openHistoryEntry(
      makeHistoryEntry({
        method: "POST",
        url: sharedUrl,
        requestBodyType: "json",
        requestBodyContent: "{\"name\":\"alice\"}",
      }),
    )

    store.openHistoryEntry(
      makeHistoryEntry({
        method: "POST",
        url: sharedUrl,
        requestBodyType: "json",
        requestBodyContent: "{\"name\":\"bob\"}",
      }),
    )

    expect(store.tabs).toHaveLength(3)
    expect(store.activeTab.body.content).toBe("{\"name\":\"bob\"}")
  })
})
