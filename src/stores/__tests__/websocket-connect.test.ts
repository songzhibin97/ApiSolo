import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const { consoleMock } = vi.hoisted(() => ({ consoleMock: vi.fn() }))

// recordConsoleEntry reaches for the console store through the module-level
// pinia singleton, so it is replaced rather than driven.
vi.mock("../console", () => ({ recordConsoleEntry: consoleMock }))

const backend = vi.hoisted(() => {
  type Handler = (event: { payload: Record<string, unknown> }) => void

  const state = {
    calls: [] as string[],
    args: [] as Record<string, unknown>[],
    handlers: new Map<string, Handler>(),
    tauri: true,
    preparedId: "ws-1",
    /** Runs inside the ws_prepare invoke, before it resolves. */
    onPrepare: undefined as undefined | (() => void),
    /** Runs inside the ws_connect invoke, before it resolves. */
    onConnect: undefined as undefined | ((connectionId: string) => void),
    connectRejection: undefined as unknown,
  }

  function lastArgs(command: string) {
    const index = state.calls.lastIndexOf(command)
    return index === -1 ? undefined : state.args[index]
  }

  return {
    state,
    lastArgs,
    isTauri: () => state.tauri,
    invoke: async (command: string, args?: Record<string, unknown>) => {
      state.calls.push(command)
      state.args.push(args ?? {})

      if (command === "ws_prepare") {
        state.onPrepare?.()
        return state.preparedId
      }

      if (command === "ws_connect") {
        state.onConnect?.(args?.connectionId as string)
        if (state.connectRejection) throw state.connectRejection
        return undefined
      }

      if (command === "ws_drain_events") return []
      return undefined
    },
    listen: async (event: string, handler: Handler) => {
      // The real listen dynamically imports the Tauri event module and makes
      // another IPC hop before the subscription exists, so registration is
      // genuinely deferred. Modelling that is what makes "listener before
      // handshake" observable at all.
      await Promise.resolve()
      state.calls.push("listen")
      state.args.push({}) // keep calls/args index-aligned
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

import i18n from "../../i18n"
import { useWebSocketStore } from "../websocket"
import { useTabsStore } from "../tabs"
import { useEnvironmentsStore } from "../environments"
import type { WsEventPayload } from "../../types"

const T = (key: string) => i18n.global.t(key)

function payloadFor(connectionId: string, payload: Partial<WsEventPayload>) {
  return {
    payload: {
      connectionId,
      eventType: "message",
      content: "",
      timestamp: "2026-08-20T00:00:00.000Z",
      ...payload,
    },
  }
}

function emit(connectionId: string, payload: Partial<WsEventPayload>) {
  const handler = backend.state.handlers.get(`ws-event-${connectionId}`)
  if (!handler) {
    throw new Error(`no listener registered for ${connectionId}`)
  }
  handler(payloadFor(connectionId, payload))
}

/**
 * Delivers an event without requiring a listener, dropping it when none is
 * registered — which is what the real runtime does, since Tauri has no event
 * replay.
 *
 * Using the strict `emit` for the in-flight-frame case would make that test go
 * red because the *harness* threw, not because the frame was lost, and the
 * assertion about the message would never be what decides the result.
 */
function emitLossy(connectionId: string, payload: Partial<WsEventPayload>) {
  backend.state.handlers
    .get(`ws-event-${connectionId}`)
    ?.(payloadFor(connectionId, payload))
}

async function connectAndCaptureConsole() {
  const { wsStore, tab } = setup()
  const environments = useEnvironmentsStore()
  environments.variables = [{ key: "token", value: "s3cr3t", secret: true }]

  await wsStore.connect(tab.id, "wss://example.test/?t={{token}}", [])

  return consoleMock.mock.calls.map((call) => String(call[1])).join("\n")
}

function setup() {
  const tabsStore = useTabsStore()
  const wsStore = useWebSocketStore()
  const tab = tabsStore.addWsTab()
  tabsStore.updateTab(tab.id, { url: "wss://example.test/socket" })
  return { tabsStore, wsStore, tab }
}

describe("websocket connect lifecycle", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal("crypto", { randomUUID: () => Math.random().toString(36).slice(2) })
    consoleMock.mockClear()
    backend.state.calls = []
    backend.state.args = []
    backend.state.handlers = new Map()
    backend.state.tauri = true
    backend.state.preparedId = "ws-1"
    backend.state.onPrepare = undefined
    backend.state.onConnect = undefined
    backend.state.connectRejection = undefined
  })

  it("marks the tab connecting before the first backend call", async () => {
    const { tabsStore, wsStore, tab } = setup()
    let statusAtPrepare: string | undefined

    // Observed exactly when ws_prepare is serviced — the first backend call.
    backend.state.onPrepare = () => {
      statusAtPrepare = tabsStore.tabs.find((item) => item.id === tab.id)?.wsStatus
    }

    await wsStore.connect(tab.id, tab.url, [])

    expect(statusAtPrepare).toBe("connecting")
  })

  it("registers the event listener before ws_connect is invoked", async () => {
    const { wsStore, tab } = setup()

    await wsStore.connect(tab.id, tab.url, [])

    expect(backend.state.calls).toEqual(["ws_prepare", "listen", "ws_connect"])
  })

  it("keeps frames that arrive while ws_connect is still pending", async () => {
    const { wsStore, tab } = setup()
    backend.state.onConnect = (connectionId) => {
      // Lossy on purpose: if the listener is not up yet the frame is simply
      // gone, exactly as it would be in the app.
      emitLossy(connectionId, { eventType: "message", content: "hello" })
    }

    const connectionId = await wsStore.connect(tab.id, tab.url, [])

    expect(wsStore.getMessages(connectionId!).map((item) => item.content)).toContain("hello")
  })

  it("adds the connected system line", async () => {
    const { wsStore, tab } = setup()

    const connectionId = await wsStore.connect(tab.id, tab.url, [])
    emit(connectionId!, { eventType: "connected" })

    const system = wsStore.getMessages(connectionId!).filter((item) => item.direction === "system")
    expect(system.map((item) => item.content)).toEqual([T("ws.connected")])
  })

  it("stays connecting until the connected event arrives", async () => {
    const { tabsStore, wsStore, tab } = setup()

    await wsStore.connect(tab.id, tab.url, [])

    expect(tabsStore.tabs.find((item) => item.id === tab.id)?.wsStatus).toBe("connecting")
  })

  it("ends disconnected when the server closes right after the handshake", async () => {
    const { tabsStore, wsStore, tab } = setup()

    const connectionId = await wsStore.connect(tab.id, tab.url, [])
    emit(connectionId!, { eventType: "connected" })
    emit(connectionId!, { eventType: "disconnected" })

    expect(tabsStore.tabs.find((item) => item.id === tab.id)?.wsStatus).toBe("disconnected")
  })

  it("reports a handshake failure and leaves no connected line", async () => {
    const { tabsStore, wsStore, tab } = setup()
    backend.state.connectRejection = new Error("handshake exploded")

    await expect(wsStore.connect(tab.id, tab.url, [])).rejects.toThrow("handshake exploded")

    expect(tabsStore.tabs.find((item) => item.id === tab.id)?.wsStatus).toBe("disconnected")
    expect(wsStore.getMessages("ws-1").some((item) => item.content === T("ws.connected"))).toBe(
      false,
    )
  })

  it("does not surface a user cancel as an error", async () => {
    const { wsStore, tab } = setup()
    backend.state.connectRejection = new Error("WebSocket connection was cancelled")
    backend.state.onConnect = (connectionId) => {
      // The user hit cancel while the handshake was in flight.
      wsStore.connections[connectionId].cancelled = true
    }

    await expect(wsStore.connect(tab.id, tab.url, [])).resolves.toBeUndefined()
  })

  it("releases a prepared connection when the tab is gone before the id is stored", async () => {
    const { tabsStore, wsStore, tab } = setup()
    backend.state.onPrepare = () => {
      // The tab is closed while ws_prepare is in flight, so the id never makes
      // it back to a tab and tab cleanup cannot find this connection.
      tabsStore.tabs = tabsStore.tabs.filter((item) => item.id !== tab.id)
    }

    const result = await wsStore.connect(tab.id, tab.url, [])

    expect(result).toBeUndefined()
    expect(backend.state.calls).toContain("ws_disconnect")
    expect(backend.state.calls).not.toContain("ws_connect")
  })

  it.each([
    ["url", "wss://example.test/{{path}}", "wss://example.test/live"],
    ["header key", "{{headerName}}", "X-Token"],
    ["header value", "{{token}}", "s3cr3t"],
  ])("resolves templates in the websocket %s", async (field, template, expected) => {
    const { tabsStore, wsStore, tab } = setup()
    const environments = useEnvironmentsStore()
    environments.variables = [
      { key: "path", value: "live", secret: false },
      { key: "headerName", value: "X-Token", secret: false },
      { key: "token", value: "s3cr3t", secret: true },
    ]

    const url = field === "url" ? template : "wss://example.test/socket"
    const headers =
      field === "url"
        ? []
        : [
            {
              id: "h1",
              enabled: true,
              key: field === "header key" ? template : "X-Token",
              value: field === "header value" ? template : "static",
              description: "",
            },
          ]

    tabsStore.updateTab(tab.id, { url })
    await wsStore.connect(tab.id, url, headers)

    const sent = backend.lastArgs("ws_connect")
    const actual =
      field === "url"
        ? sent?.url
        : field === "header key"
          ? (sent?.headers as { key: string }[])[0].key
          : (sent?.headers as { value: string }[])[0].value

    expect(actual).toBe(expected)
  })

  it("leaves an unknown variable untouched", async () => {
    const { wsStore, tab } = setup()

    await wsStore.connect(tab.id, "wss://example.test/{{missing}}", [])

    expect(backend.lastArgs("ws_connect")?.url).toBe("wss://example.test/{{missing}}")
  })

  it("does not write the resolved url back to the tab", async () => {
    const { tabsStore, wsStore, tab } = setup()
    const environments = useEnvironmentsStore()
    environments.variables = [{ key: "path", value: "live", secret: false }]
    const template = "wss://example.test/{{path}}"
    tabsStore.updateTab(tab.id, { url: template })

    await wsStore.connect(tab.id, template, [])

    expect(tabsStore.tabs.find((item) => item.id === tab.id)?.url).toBe(template)
  })

  // Split into two single-assertion cases on purpose. Held together, both
  // assertions flip on the same mutation, and a fixture where two assertions
  // fail at once cannot show that either one of them is carrying weight.
  it("logs the template url", async () => {
    const logged = await connectAndCaptureConsole()

    expect(logged).toContain("{{token}}")
  })

  it("never logs the resolved secret", async () => {
    const logged = await connectAndCaptureConsole()

    expect(logged).not.toContain("s3cr3t")
  })

  it("emits a single disconnected system line", async () => {
    const { wsStore, tab } = setup()

    const connectionId = (await wsStore.connect(tab.id, tab.url, []))!
    // Captured up front: the first disconnected unregisters the listener, and a
    // duplicate event can still be in flight at that moment.
    const handler = backend.state.handlers.get(`ws-event-${connectionId}`)!
    const disconnected = {
      payload: {
        connectionId,
        eventType: "disconnected",
        content: "",
        timestamp: "2026-08-20T00:00:00.000Z",
      },
    }

    emit(connectionId, { eventType: "connected" })
    handler(disconnected)
    handler(disconnected)

    const lines = wsStore
      .getMessages(connectionId)
      .filter((item) => item.content === T("ws.disconnected"))
    expect(lines).toHaveLength(1)
  })

  it.each([
    ["state deleted by teardown", "teardown"],
    ["cancelled", "cancelled"],
    ["closed", "closed"],
  ])(
    "drops a connected event that arrives after the connection reached a terminal state (%s)",
    async (_label, terminal) => {
      const { tabsStore, wsStore, tab } = setup()
      const connectionId = (await wsStore.connect(tab.id, tab.url, []))!
      // Captured before the connection reaches its terminal state: a listener
      // callback already dispatched by the runtime keeps running even after the
      // subscription is dropped, which is exactly the race being guarded.
      const handler = backend.state.handlers.get(`ws-event-${connectionId}`)!

      if (terminal === "teardown") {
        await wsStore.teardown(connectionId)
        expect(wsStore.connections[connectionId]).toBeUndefined()
      } else if (terminal === "cancelled") {
        wsStore.connections[connectionId].cancelled = true
      } else {
        wsStore.connections[connectionId].closed = true
      }

      handler({
        payload: {
          connectionId,
          eventType: "connected",
          content: "",
          timestamp: "2026-08-20T00:00:00.000Z",
        },
      })

      const tabNow = tabsStore.tabs.find((item) => item.id === tab.id)
      expect(tabNow?.wsStatus).not.toBe("connected")
      expect(
        wsStore.getMessages(connectionId).some((item) => item.content === T("ws.connected")),
      ).toBe(false)
    },
  )
})
