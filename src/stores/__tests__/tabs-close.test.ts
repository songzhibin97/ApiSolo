import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const { teardownMock, consoleMock, adoptMock } = vi.hoisted(() => ({
  teardownMock: vi.fn(async (_connectionId: string) => {}),
  consoleMock: vi.fn(),
  adoptMock: vi.fn(),
}))

vi.mock("../websocket", () => ({
  useWebSocketStore: () => ({ teardown: teardownMock, adoptOrphanConnection: adoptMock }),
}))

vi.mock("../console", () => ({ recordConsoleEntry: consoleMock }))

import { useTabsStore } from "../tabs"

describe("useTabsStore websocket cleanup", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { dispatchEvent: vi.fn() })
    vi.stubGlobal(
      "CustomEvent",
      class CustomEventMock {
        constructor(public type: string) {}
      },
    )

    setActivePinia(createPinia())
    teardownMock.mockClear()
    teardownMock.mockImplementation(async () => {})
    consoleMock.mockClear()
    adoptMock.mockClear()
  })

  it("disconnects a websocket tab closed during the handshake", async () => {
    const store = useTabsStore()
    const wsTab = store.addWsTab()

    // Mid-handshake: the id has been written back but no connected event has
    // arrived, so the tab is still "connecting". Cleanup has to find it anyway.
    store.updateTab(wsTab.id, { wsStatus: "connecting", wsConnectionId: "ws-handshaking" })

    await store.removeTab(wsTab.id)

    expect(teardownMock).toHaveBeenCalledWith("ws-handshaking")
    expect(store.tabs.some((tab) => tab.id === wsTab.id)).toBe(false)
  })

  it.each([
    ["the tab close button", "removeTab"],
    ["close others", "closeOtherTabs"],
    ["close to the right", "closeTabsToRight"],
    ["saved-request close", "closeSavedRequest"],
    ["saved-request path close", "closeSavedRequestsInPath"],
  ])("cleans up a handshaking websocket tab from %s", async (_label, entry) => {
    const store = useTabsStore()
    const keepTab = store.tabs[0]
    const wsTab = store.addWsTab()

    store.updateTab(wsTab.id, {
      wsStatus: "connecting",
      wsConnectionId: "ws-entry",
      projectName: "demo",
      savedRequestPath: "users/list.request.json",
    })

    if (entry === "removeTab") {
      await store.removeTab(wsTab.id)
    } else if (entry === "closeOtherTabs") {
      await store.closeOtherTabs(keepTab.id)
    } else if (entry === "closeTabsToRight") {
      await store.closeTabsToRight(keepTab.id)
    } else if (entry === "closeSavedRequest") {
      await store.closeSavedRequest("demo", "users/list.request.json")
    } else {
      await store.closeSavedRequestsInPath("demo", "users")
    }

    expect(teardownMock).toHaveBeenCalledWith("ws-entry")
  })

  it("removes the tab the user closed even when the list changes during disconnect", async () => {
    const store = useTabsStore()
    const first = store.tabs[0]
    const target = store.addWsTab()
    store.updateTab(target.id, { wsStatus: "connected", wsConnectionId: "ws-target" })

    let inserted: string | undefined
    teardownMock.mockImplementation(async () => {
      // Another tab is closed while the socket is shutting down, so every index
      // taken before the await now points one slot to the left.
      store.tabs = store.tabs.filter((tab) => tab.id !== first.id)
      const extra = store.addTab()
      inserted = extra.id
    })

    await store.removeTab(target.id)

    expect(store.tabs.some((tab) => tab.id === target.id)).toBe(false)
    expect(store.tabs.some((tab) => tab.id === inserted)).toBe(true)
  })

  it.each([
    ["close others", "closeOtherTabs"],
    ["close to the right", "closeTabsToRight"],
  ])("keeps tabs created while other tabs are being closed via %s", async (_label, entry) => {
    const store = useTabsStore()
    const keepTab = store.tabs[0]
    const wsTab = store.addWsTab()
    store.updateTab(wsTab.id, { wsStatus: "connected", wsConnectionId: "ws-closing" })

    let inserted: string | undefined
    teardownMock.mockImplementation(async () => {
      const extra = store.addTab()
      inserted = extra.id
    })

    if (entry === "closeOtherTabs") {
      await store.closeOtherTabs(keepTab.id)
    } else {
      await store.closeTabsToRight(keepTab.id)
    }

    expect(store.tabs.some((tab) => tab.id === wsTab.id)).toBe(false)
    expect(store.tabs.some((tab) => tab.id === inserted)).toBe(true)
    expect(store.tabs.some((tab) => tab.id === keepTab.id)).toBe(true)
  })

  it("disconnects websocket tabs to the right and resets the last tab with a new id", async () => {
    const store = useTabsStore()
    const firstTab = store.tabs[0]
    const wsTab = store.addWsTab()

    store.updateTab(wsTab.id, { wsStatus: "connected", wsConnectionId: "ws-right" })

    await store.closeTabsToRight(firstTab.id)

    expect(teardownMock).toHaveBeenCalledWith("ws-right")
    expect(store.tabs).toHaveLength(1)

    store.updateTab(firstTab.id, {
      protocol: "websocket",
      wsStatus: "connected",
      wsConnectionId: "ws-last",
      url: "ws://localhost:9000/socket",
    })

    await store.removeTab(firstTab.id)

    expect(teardownMock).toHaveBeenCalledWith("ws-last")
    expect(store.tabs).toHaveLength(1)
    expect(store.tabs[0].id).not.toBe(firstTab.id)
    expect(store.tabs[0].protocol).toBe("http")
    expect(store.tabs[0].url).toBe("")
    expect(store.tabs[0].response).toBeNull()
  })

  // Deliberately one assertion. The longer close-to-the-right case above also
  // goes red when the reset branch is removed, but it fails on several
  // assertions at once, so it cannot show that any single one of them decides
  // the outcome.
  it("replaces the last tab rather than leaving the list empty", async () => {
    const store = useTabsStore()
    const only = store.tabs[0]

    await store.removeTab(only.id)

    expect(store.tabs).toHaveLength(1)
  })

  it("still closes the tab when the connection cannot be torn down", async () => {
    const store = useTabsStore()
    const wsTab = store.addWsTab()
    store.updateTab(wsTab.id, { wsStatus: "connected", wsConnectionId: "ws-stuck" })
    teardownMock.mockImplementation(async () => {
      throw new Error("backend refused to close")
    })

    await store.removeTab(wsTab.id)

    // Refusing to close the tab would strand the user; the failure is surfaced
    // instead of swallowed.
    expect(store.tabs.some((tab) => tab.id === wsTab.id)).toBe(false)
  })

  it("reports a cleanup failure while closing a tab", async () => {
    const store = useTabsStore()
    const wsTab = store.addWsTab()
    store.updateTab(wsTab.id, { wsStatus: "connected", wsConnectionId: "ws-stuck" })
    teardownMock.mockImplementation(async () => {
      throw new Error("backend refused to close")
    })

    await store.removeTab(wsTab.id)

    const logged = consoleMock.mock.calls.map((call) => String(call[1])).join("\n")
    expect(logged).toContain("connection may still be open")
  })

  it("leaves non-websocket tabs alone", async () => {
    const store = useTabsStore()
    const httpTab = store.addTab()

    await store.removeTab(httpTab.id)

    expect(teardownMock).not.toHaveBeenCalled()
  })
})
