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
    prepareRejection: undefined as unknown,
    /** Makes ws_disconnect fail, so cleanup failure paths become testable. */
    disconnectRejection: undefined as unknown,
    /** Parks the unlisten() call until the test releases it. */
    deferUnlisten: undefined as undefined | { entered: Promise<void>; release: () => void },
    /**
     * When set, ws_prepare parks until the test resolves it. That turns "the
     * window while prepare is in flight" from a race into an exact instant the
     * test controls.
     */
    deferPrepare: undefined as undefined | { entered: Promise<void>; release: () => void },
  }

  function makeDeferred() {
    let release!: () => void
    let signalEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    return { entered, release, gate, signalEntered }
  }

  function lastArgs(command: string) {
    const index = state.calls.lastIndexOf(command)
    return index === -1 ? undefined : state.args[index]
  }

  return {
    state,
    lastArgs,
    makeDeferred,
    isTauri: () => state.tauri,
    invoke: async (command: string, args?: Record<string, unknown>) => {
      state.calls.push(command)
      state.args.push(args ?? {})

      if (command === "ws_prepare") {
        state.onPrepare?.()
        if (state.deferPrepare) {
          const pending = state.deferPrepare as unknown as {
            gate: Promise<void>
            signalEntered: () => void
          }
          pending.signalEntered()
          await pending.gate
        }
        if (state.prepareRejection) throw state.prepareRejection
        return state.preparedId
      }

      if (command === "ws_connect") {
        state.onConnect?.(args?.connectionId as string)
        if (state.connectRejection) throw state.connectRejection
        return undefined
      }

      if (command === "ws_disconnect" && state.disconnectRejection) {
        throw state.disconnectRejection
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
      return async () => {
        if (state.deferUnlisten) {
          const pending = state.deferUnlisten as unknown as {
            gate: Promise<void>
            signalEntered: () => void
          }
          pending.signalEntered()
          await pending.gate
        }
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
    backend.state.prepareRejection = undefined
    backend.state.deferPrepare = undefined
    backend.state.disconnectRejection = undefined
    backend.state.deferUnlisten = undefined
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

  // --- the connecting-state machine: cancel must be reachable in every phase ---

  it("does not start a second connection when cancel is clicked before the id exists", async () => {
    const { tabsStore, wsStore, tab } = setup()
    const deferred = backend.makeDeferred()
    backend.state.deferPrepare = deferred as never

    const connecting = wsStore.connect(tab.id, tab.url, [])
    // Parked exactly inside ws_prepare: the tab already says "connecting" and
    // the button already reads "cancel", but no id exists yet.
    await deferred.entered
    expect(tabsStore.tabs.find((item) => item.id === tab.id)?.wsStatus).toBe("connecting")
    expect(tabsStore.tabs.find((item) => item.id === tab.id)?.wsConnectionId).toBeUndefined()

    // What the panel does on a click in that window.
    const second = wsStore.connect(tab.id, tab.url, [])

    deferred.release()
    await Promise.all([connecting, second])

    // One prepare, therefore one connection. Two would leave the first
    // unreachable forever.
    expect(backend.state.calls.filter((call) => call === "ws_prepare")).toHaveLength(1)
  })

  // One consequence per case. Cancelling in this window changes four things at
  // once, and a fixture where four assertions fail together cannot show which
  // of them is doing the work.
  async function cancelBeforeIdExists() {
    const { tabsStore, wsStore, tab } = setup()
    const deferred = backend.makeDeferred()
    backend.state.deferPrepare = deferred as never

    const connecting = wsStore.connect(tab.id, tab.url, [])
    await deferred.entered

    await wsStore.cancelOrDisconnect(tab.id, undefined)

    deferred.release()
    const result = await connecting

    return {
      result,
      calls: backend.state.calls,
      status: tabsStore.tabs.find((item) => item.id === tab.id)?.wsStatus,
    }
  }

  it("reports no connection when cancel arrives before the id exists", async () => {
    const { result } = await cancelBeforeIdExists()

    expect(result).toBeUndefined()
  })

  it("gives the prepared connection back when cancel arrives before the id exists", async () => {
    const { calls } = await cancelBeforeIdExists()

    // The id the backend handed us after the cancel must still be returned.
    expect(calls).toContain("ws_disconnect")
  })

  it("never starts the handshake when cancel arrives before the id exists", async () => {
    const { calls } = await cancelBeforeIdExists()

    expect(calls).not.toContain("ws_connect")
  })

  it("converges the tab when cancel arrives before the id exists", async () => {
    const { status } = await cancelBeforeIdExists()

    expect(status).toBe("disconnected")
  })

  it("converges the tab to disconnected when ws_prepare fails", async () => {
    const { tabsStore, wsStore, tab } = setup()
    backend.state.prepareRejection = new Error("dev bridge unreachable")

    await expect(wsStore.connect(tab.id, tab.url, [])).rejects.toThrow("dev bridge unreachable")

    // Staying on "connecting" would leave a cancel button for a connection that
    // never existed, and the next click would start a fresh connect.
    expect(tabsStore.tabs.find((item) => item.id === tab.id)?.wsStatus).toBe("disconnected")
  })

  it("clears the previous connection state when the same tab reconnects", async () => {
    const { wsStore, tab } = setup()

    const first = (await wsStore.connect(tab.id, tab.url, []))!
    emit(first, { eventType: "connected" })
    emit(first, { eventType: "message", content: "old" })
    await wsStore.disconnect(first)

    backend.state.preparedId = "ws-2"
    const second = (await wsStore.connect(tab.id, tab.url, []))!

    expect(second).not.toBe(first)
    // Reachable only through the old id, which the tab no longer holds.
    expect(wsStore.connections[first]).toBeUndefined()
  })

  it("drops the previous connection's buffered messages when the same tab reconnects", async () => {
    const { wsStore, tab } = setup()

    const first = (await wsStore.connect(tab.id, tab.url, []))!
    emit(first, { eventType: "connected" })
    emit(first, { eventType: "message", content: "old" })
    await wsStore.disconnect(first)

    backend.state.preparedId = "ws-2"
    await wsStore.connect(tab.id, tab.url, [])

    expect(wsStore.getMessages(first)).toHaveLength(0)
  })

  it("does not accumulate hidden state across repeated reconnects", async () => {
    const { wsStore, tab } = setup()

    for (let round = 0; round < 4; round += 1) {
      backend.state.preparedId = `ws-round-${round}`
      const id = (await wsStore.connect(tab.id, tab.url, []))!
      emit(id, { eventType: "connected" })
      emit(id, { eventType: "message", content: `round-${round}` })
      await wsStore.disconnect(id)
    }

    // Only the connection the tab still points at may remain.
    expect(Object.keys(wsStore.connections)).toEqual(["ws-round-3"])
    expect(Object.keys(wsStore.messages)).toEqual(["ws-round-3"])
  })

  // --- cleanup failures must not be swallowed ---

  async function connectedThenDisconnectFails() {
    const { tabsStore, wsStore, tab } = setup()
    const first = (await wsStore.connect(tab.id, tab.url, []))!
    emit(first, { eventType: "connected" })
    emit(first, { eventType: "message", content: "old" })
    // Every later ws_disconnect fails, including the retry inside teardown.
    backend.state.disconnectRejection = new Error("backend refused to close")
    return { tabsStore, wsStore, tab, first }
  }

  it("aborts the reconnect when the previous connection cannot be closed", async () => {
    const { wsStore, tab } = await connectedThenDisconnectFails()
    backend.state.preparedId = "ws-2"

    const before = backend.state.calls.filter((call) => call === "ws_connect").length

    await expect(wsStore.connect(tab.id, tab.url, [])).rejects.toThrow("backend refused to close")

    // Overwriting the id would have stranded a connection the backend still
    // holds, with nothing able to address it — so no new handshake may start.
    const after = backend.state.calls.filter((call) => call === "ws_connect").length
    expect(after).toBe(before)
  })

  it("keeps the tab pointing at a previous connection that would not close", async () => {
    const { tabsStore, wsStore, tab, first } = await connectedThenDisconnectFails()
    backend.state.preparedId = "ws-2"

    await wsStore.connect(tab.id, tab.url, []).catch(() => undefined)

    expect(tabsStore.tabs.find((item) => item.id === tab.id)?.wsConnectionId).toBe(first)
  })

  it("keeps the previous connection state when its teardown fails", async () => {
    const { wsStore, tab, first } = await connectedThenDisconnectFails()
    backend.state.preparedId = "ws-2"

    await wsStore.connect(tab.id, tab.url, []).catch(() => undefined)

    // The state record is the only remaining handle to that backend slot.
    expect(wsStore.connections[first]).toBeDefined()
  })

  it("reports a failure instead of a clean cancel when handing the id back fails", async () => {
    const { wsStore, tab } = setup()
    const deferred = backend.makeDeferred()
    backend.state.deferPrepare = deferred as never

    const connecting = wsStore.connect(tab.id, tab.url, [])
    await deferred.entered
    backend.state.disconnectRejection = new Error("backend refused to close")
    await wsStore.cancelOrDisconnect(tab.id, undefined).catch(() => undefined)
    deferred.release()

    // Returning undefined here would claim the connection was released when it
    // may still be open.
    await expect(connecting).rejects.toThrow("backend refused to close")
  })

  async function cancelWithFailingCleanup() {
    const { tabsStore, wsStore, tab } = setup()
    const deferred = backend.makeDeferred()
    backend.state.deferPrepare = deferred as never

    const connecting = wsStore.connect(tab.id, tab.url, [])
    await deferred.entered
    backend.state.disconnectRejection = new Error("backend refused to close")
    await wsStore.cancelOrDisconnect(tab.id, undefined).catch(() => undefined)
    deferred.release()
    await connecting.catch(() => undefined)

    return { tabsStore, wsStore, tab }
  }

  it("keeps the leaked id on the tab when cancel cleanup fails twice", async () => {
    const { tabsStore, tab } = await cancelWithFailingCleanup()

    // The id was never stored on the tab during a normal cancel, but after a
    // double cleanup failure it is the only route left to a connection the
    // backend may still hold.
    expect(tabsStore.tabs.find((item) => item.id === tab.id)?.wsConnectionId).toBe("ws-1")
  })

  it("retries the failed teardown on the next connect attempt", async () => {
    const { wsStore, tab } = await cancelWithFailingCleanup()

    // The backend recovers; the next connect must deal with the stranded id
    // before starting anything new.
    backend.state.disconnectRejection = undefined
    const callsBefore = backend.state.calls.length
    backend.state.preparedId = "ws-2"
    await wsStore.connect(tab.id, tab.url, [])

    const afterwards = backend.state.calls.slice(callsBefore)
    expect(afterwards[0]).toBe("ws_disconnect")
  })

  it("does not recreate the message map when a parked disconnect resumes after teardown", async () => {
    const { wsStore, tab } = setup()
    const connectionId = (await wsStore.connect(tab.id, tab.url, []))!
    emit(connectionId, { eventType: "connected" })
    emit(connectionId, { eventType: "message", content: "buffered" })

    // A: a disconnect parks inside unlisten().
    const unlistenGate = backend.makeDeferred()
    backend.state.deferUnlisten = unlistenGate as never
    const parked = wsStore.disconnect(connectionId)
    await unlistenGate.entered

    // B: the tab closes and tears the same connection down to completion.
    backend.state.deferUnlisten = undefined
    await wsStore.teardown(connectionId)
    expect(wsStore.getMessages(connectionId)).toHaveLength(0)

    // A resumes against state that no longer exists.
    unlistenGate.release()
    await parked

    // Writing a system line here would rebuild a map nothing can reach.
    expect(wsStore.getMessages(connectionId)).toHaveLength(0)
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
