import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

vi.mock("../console", () => ({ recordConsoleEntry: vi.fn() }))

const backend = vi.hoisted(() => {
  type Handler = (event: { payload: Record<string, unknown> }) => void
  const state = { handlers: new Map<string, Handler>() }

  return {
    state,
    isTauri: () => true,
    invoke: async (command: string, _args?: Record<string, unknown>) =>
      command === "ws_prepare" ? "ws-1" : undefined,
    listen: async (event: string, handler: Handler) => {
      state.handlers.set(event, handler)
      return () => {
        state.handlers.delete(event)
      }
    },
  }
})

vi.mock("../../utils/invoke", () => ({
  isTauri: () => backend.isTauri(),
  invoke: (command: string, args?: Record<string, unknown>) => backend.invoke(command, args),
  listen: (event: string, handler: never) => backend.listen(event, handler),
}))

import { useWebSocketStore } from "../websocket"
import { useTabsStore } from "../tabs"

const MAX_WS_MESSAGES = 500
const MAX_WS_MESSAGE_CHARS = 65536

async function connected() {
  const tabsStore = useTabsStore()
  const wsStore = useWebSocketStore()
  const tab = tabsStore.addWsTab()
  const connectionId = (await wsStore.connect(tab.id, "wss://example.test/socket", []))!
  const handler = backend.state.handlers.get(`ws-event-${connectionId}`)!

  function receive(content: string) {
    handler({
      payload: {
        connectionId,
        eventType: "message",
        content,
        timestamp: "2026-08-20T00:00:00.000Z",
      },
    })
  }

  return { wsStore, connectionId, receive }
}

describe("websocket message panel state", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    let counter = 0
    vi.stubGlobal("crypto", { randomUUID: () => `id-${counter++}` })
    backend.state.handlers = new Map()
  })

  it("keeps at most 500 messages per connection", async () => {
    const { wsStore, connectionId, receive } = await connected()

    for (let index = 0; index < MAX_WS_MESSAGES + 40; index += 1) {
      receive(`m${index}`)
    }

    expect(wsStore.getMessages(connectionId)).toHaveLength(MAX_WS_MESSAGES)
  })

  it("counts the messages dropped by the cap", async () => {
    const { wsStore, connectionId, receive } = await connected()

    // Exactly one over the cap, and only the counter is asserted: a fixture
    // that also breaks the length assertion could not prove this one carries
    // any weight of its own.
    for (let index = 0; index < MAX_WS_MESSAGES + 1; index += 1) {
      receive(`m${index}`)
    }

    expect(wsStore.getDroppedCount(connectionId)).toBe(1)
  })

  it("stores at most MAX_WS_MESSAGE_CHARS characters", async () => {
    const { wsStore, connectionId, receive } = await connected()

    receive("x".repeat(MAX_WS_MESSAGE_CHARS + 100))

    expect(wsStore.getMessages(connectionId)[0].content).toHaveLength(MAX_WS_MESSAGE_CHARS)
  })

  it("flags a truncated message", async () => {
    const { wsStore, connectionId, receive } = await connected()

    receive("x".repeat(MAX_WS_MESSAGE_CHARS + 100))

    // Only the flag: the length belongs to the test above.
    expect(wsStore.getMessages(connectionId)[0].truncated).toBe(true)
  })

  it("leaves a message under the cap unflagged", async () => {
    const { wsStore, connectionId, receive } = await connected()

    receive("short")

    expect(wsStore.getMessages(connectionId)[0].truncated).toBeUndefined()
  })

  it("clear resets both the messages and the dropped counter", async () => {
    const { wsStore, connectionId, receive } = await connected()

    for (let index = 0; index < MAX_WS_MESSAGES + 5; index += 1) {
      receive(`m${index}`)
    }
    expect(wsStore.getDroppedCount(connectionId)).toBeGreaterThan(0)

    wsStore.clearMessages(connectionId)

    expect(wsStore.getMessages(connectionId)).toHaveLength(0)
    expect(wsStore.getDroppedCount(connectionId)).toBe(0)
  })
})
