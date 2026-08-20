import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

/**
 * Both stores are real here on purpose.
 *
 * The other tab-close suite replaces the whole websocket store, so it can only
 * show that a tab closes and that a line is logged — it cannot show that the
 * connection is still owned by anything afterwards. Closing a tab destroys the
 * only field naming that connection, so "who owns it now" is exactly the
 * question a mocked store cannot answer.
 */
vi.mock("../console", () => ({ recordConsoleEntry: vi.fn() }))

const backend = vi.hoisted(() => {
  const state = { calls: [] as string[], disconnectRejection: undefined as unknown }
  return {
    state,
    isTauri: () => true,
    invoke: async (command: string, _args?: Record<string, unknown>) => {
      state.calls.push(command)
      if (command === "ws_prepare") return "ws-1"
      if (command === "ws_disconnect" && state.disconnectRejection) {
        throw state.disconnectRejection
      }
      if (command === "ws_drain_events") return []
      return undefined
    },
    listen: async () => async () => {},
  }
})

vi.mock("../../utils/invoke", () => ({
  isTauri: () => backend.isTauri(),
  invoke: (command: string, args?: Record<string, unknown>) => backend.invoke(command, args),
  listen: () => backend.listen(),
}))

import { useTabsStore } from "../tabs"
import { useWebSocketStore } from "../websocket"

async function closeTabWithFailingTeardown() {
  const tabsStore = useTabsStore()
  const wsStore = useWebSocketStore()

  const tab = tabsStore.addWsTab()
  const connectionId = (await wsStore.connect(tab.id, "wss://example.test/socket", []))!
  backend.state.disconnectRejection = new Error("backend refused to close")

  await tabsStore.removeTab(tab.id)

  return { tabsStore, wsStore, tab, connectionId }
}

describe("closing a tab whose connection will not close", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal("crypto", { randomUUID: () => Math.random().toString(36).slice(2) })
    vi.stubGlobal("window", { dispatchEvent: vi.fn() })
    vi.stubGlobal(
      "CustomEvent",
      class CustomEventMock {
        constructor(public type: string) {}
      },
    )
    backend.state.calls = []
    backend.state.disconnectRejection = undefined
  })

  it("removes the tab", async () => {
    const { tabsStore, tab } = await closeTabWithFailingTeardown()

    expect(tabsStore.tabs.some((item) => item.id === tab.id)).toBe(false)
  })

  it("keeps the connection owned after the tab that named it is gone", async () => {
    const { wsStore, connectionId } = await closeTabWithFailingTeardown()

    // The tab is gone, so this list is the only thing left that knows the
    // backend may still hold this connection.
    expect(wsStore.orphanConnections).toContain(connectionId)
  })

  it("retries the connection on the next connect from another tab", async () => {
    const { tabsStore, wsStore } = await closeTabWithFailingTeardown()
    backend.state.disconnectRejection = undefined

    const other = tabsStore.addWsTab()
    const callsBefore = backend.state.calls.length
    await wsStore.connect(other.id, "wss://example.test/socket", [])

    expect(backend.state.calls.slice(callsBefore)[0]).toBe("ws_disconnect")
  })

  it("forgets the connection once the retry succeeds", async () => {
    const { tabsStore, wsStore } = await closeTabWithFailingTeardown()
    backend.state.disconnectRejection = undefined

    const other = tabsStore.addWsTab()
    await wsStore.connect(other.id, "wss://example.test/socket", [])

    expect(wsStore.orphanConnections).toHaveLength(0)
  })
})
