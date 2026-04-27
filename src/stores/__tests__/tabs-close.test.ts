import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const { disconnectMock, clearMessagesMock } = vi.hoisted(() => ({
  disconnectMock: vi.fn(async () => {}),
  clearMessagesMock: vi.fn(),
}))

vi.mock("../websocket", () => ({
  useWebSocketStore: () => ({
    disconnect: disconnectMock,
    clearMessages: clearMessagesMock,
  }),
}))

import { useTabsStore } from "../tabs"

describe("useTabsStore websocket cleanup", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      dispatchEvent: vi.fn(),
    })
    vi.stubGlobal(
      "CustomEvent",
      class CustomEventMock {
        constructor(public type: string) {}
      },
    )

    setActivePinia(createPinia())
    disconnectMock.mockClear()
    clearMessagesMock.mockClear()
  })

  it("disconnects and clears websocket state when closing a tab", async () => {
    const store = useTabsStore()
    const wsTab = store.addWsTab()

    store.updateTab(wsTab.id, {
      wsStatus: "connected",
      wsConnectionId: "ws-1",
    })

    await store.removeTab(wsTab.id)

    expect(disconnectMock).toHaveBeenCalledWith("ws-1")
    expect(clearMessagesMock).toHaveBeenCalledWith("ws-1")
    expect(store.tabs.some((tab) => tab.id === wsTab.id)).toBe(false)
  })

  it("disconnects websocket tabs when closing other tabs", async () => {
    const store = useTabsStore()
    const keepTab = store.tabs[0]
    const leftWsTab = store.addWsTab()
    const rightWsTab = store.addWsTab()

    store.updateTab(leftWsTab.id, {
      wsStatus: "connected",
      wsConnectionId: "ws-left",
    })
    store.updateTab(rightWsTab.id, {
      wsStatus: "disconnected",
      wsConnectionId: "ws-right",
    })

    await store.closeOtherTabs(keepTab.id)

    expect(disconnectMock).toHaveBeenCalledTimes(2)
    expect(disconnectMock).toHaveBeenCalledWith("ws-left")
    expect(disconnectMock).toHaveBeenCalledWith("ws-right")
    expect(clearMessagesMock).toHaveBeenCalledWith("ws-left")
    expect(clearMessagesMock).toHaveBeenCalledWith("ws-right")
    expect(store.tabs).toHaveLength(1)
    expect(store.activeTabId).toBe(keepTab.id)
  })

  it("disconnects websocket tabs to the right and resets the last tab with a new id", async () => {
    const store = useTabsStore()
    const firstTab = store.tabs[0]
    const wsTab = store.addWsTab()

    store.updateTab(wsTab.id, {
      wsStatus: "connected",
      wsConnectionId: "ws-right",
    })

    await store.closeTabsToRight(firstTab.id)

    expect(disconnectMock).toHaveBeenCalledWith("ws-right")
    expect(clearMessagesMock).toHaveBeenCalledWith("ws-right")
    expect(store.tabs).toHaveLength(1)

    store.updateTab(firstTab.id, {
      protocol: "websocket",
      wsStatus: "connected",
      wsConnectionId: "ws-last",
      url: "ws://localhost:9000/socket",
    })

    await store.removeTab(firstTab.id)

    expect(disconnectMock).toHaveBeenCalledWith("ws-last")
    expect(clearMessagesMock).toHaveBeenCalledWith("ws-last")
    expect(store.tabs).toHaveLength(1)
    expect(store.tabs[0].id).not.toBe(firstTab.id)
    expect(store.tabs[0].protocol).toBe("http")
    expect(store.tabs[0].url).toBe("")
    expect(store.tabs[0].response).toBeNull()
  })

  it("disconnects websocket tabs removed by saved-request path cleanup", async () => {
    const store = useTabsStore()
    const matchingTab = store.addWsTab()
    const nestedMatchingTab = store.addWsTab()
    const untouchedTab = store.addWsTab()

    store.updateTab(matchingTab.id, {
      projectName: "demo",
      savedRequestPath: "users/list.request.json",
      wsStatus: "connected",
      wsConnectionId: "ws-path-1",
    })
    store.updateTab(nestedMatchingTab.id, {
      projectName: "demo",
      savedRequestPath: "users/admins/detail.request.json",
      wsStatus: "connected",
      wsConnectionId: "ws-path-2",
    })
    store.updateTab(untouchedTab.id, {
      projectName: "demo",
      savedRequestPath: "metrics/list.request.json",
      wsStatus: "connected",
      wsConnectionId: "ws-keep",
    })

    await store.closeSavedRequestsInPath("demo", "users")

    expect(disconnectMock).toHaveBeenCalledWith("ws-path-1")
    expect(disconnectMock).toHaveBeenCalledWith("ws-path-2")
    expect(disconnectMock).not.toHaveBeenCalledWith("ws-keep")
    expect(clearMessagesMock).toHaveBeenCalledWith("ws-path-1")
    expect(clearMessagesMock).toHaveBeenCalledWith("ws-path-2")
    expect(store.tabs.some((tab) => tab.id === matchingTab.id)).toBe(false)
    expect(store.tabs.some((tab) => tab.id === nestedMatchingTab.id)).toBe(false)
    expect(store.tabs.some((tab) => tab.id === untouchedTab.id)).toBe(true)
  })
})
