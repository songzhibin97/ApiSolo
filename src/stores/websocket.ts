import { computed, ref } from "vue"
import { defineStore } from "pinia"

import i18n from "../i18n"
import { recordConsoleEntry } from "./console"
import { useEnvironmentsStore } from "./environments"
import { invoke, isTauri, listen, type UnlistenFn } from "../utils/invoke"
import { resolveTemplate } from "../utils/resolve-template"
import { useTabsStore } from "./tabs"
import type { KeyValuePair, WsConnectionStatus, WsEventPayload, WsMessage } from "../types"

/** Same cap as the built-in debug console, so both panels bound alike. */
const MAX_WS_MESSAGES = 500
/** Characters, not bytes — the name must not lie about what it counts. */
const MAX_WS_MESSAGE_CHARS = 65536

interface WsConnectionState {
  unlisten?: UnlistenFn
  pollCancelled: boolean
  /** Whether the "disconnected" system line has already been produced. */
  closed: boolean
  /** The user cancelled or disconnected on purpose. */
  cancelled: boolean
  /** Messages discarded by the cap. */
  dropped: number
  /** The *unresolved* url, for console output only. */
  label: string
}

/**
 * One connect attempt for one tab, created synchronously before the first
 * await.
 *
 * The tab alone cannot represent "connecting": `wsStatus` flips to
 * `"connecting"` at the top of `connect`, but `wsConnectionId` only exists
 * after `ws_prepare` returns. Anything that decides whether cancelling is
 * possible by looking at the id therefore has a window where the button says
 * "cancel" and the cancel path is unreachable — and a click in that window used
 * to fall through and start a *second* connection, orphaning the first.
 *
 * This record closes that window: it exists for the whole attempt, so a cancel
 * always has somewhere to land, and a second connect always has something to
 * refuse.
 */
interface PendingConnect {
  cancelled: boolean
  /** Set as soon as ws_prepare returns; undefined before that. */
  connectionId?: string
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export const useWebSocketStore = defineStore("websocket", () => {
  const messages = ref<Record<string, WsMessage[]>>({})
  const connections = ref<Record<string, WsConnectionState>>({})
  /** Keyed by tab id — see PendingConnect. */
  const pendingConnects = ref<Record<string, PendingConnect>>({})
  /**
   * Connections the backend may still hold that no tab can name.
   *
   * A tab is not a durable owner: it can be closed while a connect is parked
   * in ws_prepare, and if the hand-back then fails there is no tab left to
   * write the id onto and no state record either — the id would simply cease
   * to exist anywhere in the frontend. This list is where such an id lives
   * until a later connect manages to close it.
   */
  const orphanConnections = ref<string[]>([])

  const getMessages = computed(() => (connectionId: string) => messages.value[connectionId] ?? [])
  const getDroppedCount = computed(() => (connectionId: string) =>
    connections.value[connectionId]?.dropped ?? 0,
  )

  function pushMessage(connectionId: string, message: WsMessage) {
    const capped =
      message.content.length > MAX_WS_MESSAGE_CHARS
        ? { ...message, content: message.content.slice(0, MAX_WS_MESSAGE_CHARS), truncated: true }
        : message

    const next = [...(messages.value[connectionId] ?? []), capped]

    if (next.length > MAX_WS_MESSAGES) {
      const state = connections.value[connectionId]
      if (state) {
        state.dropped += next.length - MAX_WS_MESSAGES
      }
      messages.value[connectionId] = next.slice(-MAX_WS_MESSAGES)
      return
    }

    messages.value[connectionId] = next
  }

  function addSystemMessage(connectionId: string, content: string, timestamp = new Date().toISOString()) {
    pushMessage(connectionId, {
      id: crypto.randomUUID(),
      direction: "system",
      content,
      timestamp,
    })
  }

  function updateTabByConnectionId(connectionId: string, status: WsConnectionStatus) {
    const tabsStore = useTabsStore()
    const tab = tabsStore.tabs.find((item) => item.wsConnectionId === connectionId)

    if (!tab) {
      return
    }

    tabsStore.updateTab(tab.id, {
      wsStatus: status,
      wsConnectionId: connectionId,
    })
  }

  /**
   * The single place a "disconnected" system line is produced. Idempotent: a
   * peer-side close and a user-initiated disconnect can both arrive, and the
   * user must see one line, not two.
   */
  function markDisconnected(connectionId: string, timestamp?: string) {
    const state = connections.value[connectionId]

    // A connection we no longer track is a true no-op, not "a connection that
    // has not been closed yet". A disconnect can be parked on an await while a
    // tab close tears the same connection down; when it resumes, writing a
    // system line here would rebuild the message map that teardown just
    // deleted, and nothing would ever be able to reach it again.
    if (!state || state.closed) {
      return
    }

    state.closed = true

    updateTabByConnectionId(connectionId, "disconnected")
    addSystemMessage(connectionId, i18n.global.t("ws.disconnected"), timestamp)
    recordConsoleEntry(
      "warn",
      `[network] WebSocket disconnected: ${state?.label ?? connectionId}`,
      "network",
    )
  }

  function handleWsEvent(connectionId: string, payload: WsEventPayload) {
    const state = connections.value[connectionId]

    // Three terminal states, one guard: the connection state was already torn
    // down (tab closed), the user cancelled/disconnected, or the disconnected
    // line has already been produced. A `connected` event arriving after any of
    // them is a true event about a connection that is already over, and
    // adopting it would flip the tab back to "connected" after the user
    // cancelled. `!state` short-circuits first so the mutant of this line
    // cannot dereference undefined.
    if (!state || (payload.eventType === "connected" && (state.closed || state.cancelled))) {
      return
    }

    if (payload.eventType === "message") {
      pushMessage(connectionId, {
        id: crypto.randomUUID(),
        direction: "received",
        content: payload.content,
        timestamp: payload.timestamp,
      })
      return
    }

    if (payload.eventType === "connected") {
      updateTabByConnectionId(connectionId, "connected")
      addSystemMessage(connectionId, i18n.global.t("ws.connected"), payload.timestamp)
      recordConsoleEntry("info", `[network] WebSocket connected: ${state.label}`, "network")
      return
    }

    if (payload.eventType === "disconnected") {
      markDisconnected(connectionId, payload.timestamp)
      void stopListening(connectionId)
      return
    }

    if (payload.eventType === "error") {
      addSystemMessage(
        connectionId,
        `${i18n.global.t("ws.error")}: ${payload.content || i18n.global.t("ws.disconnected")}`,
        payload.timestamp,
      )
      recordConsoleEntry(
        "error",
        `[network] WebSocket error: ${payload.content || i18n.global.t("ws.disconnected")}`,
        "network",
      )
    }
  }

  async function startListening(connectionId: string) {
    // Browser mode buffers into the Rust-side queue instead, and that queue is
    // built before the handshake, so there is nothing to register here.
    if (!isTauri()) {
      return
    }

    const unlisten = await listen<WsEventPayload>(`ws-event-${connectionId}`, (event) => {
      handleWsEvent(connectionId, event.payload)
    })

    const state = connections.value[connectionId]

    if (!state) {
      // teardown ran while we were registering.
      void unlisten()
      return
    }

    state.unlisten = unlisten
  }

  async function stopListening(connectionId: string) {
    const state = connections.value[connectionId]
    const unlisten = state?.unlisten

    if (!unlisten) {
      return
    }

    state.unlisten = undefined
    await unlisten()
  }

  async function connect(tabId: string, url: string, headers: KeyValuePair[]) {
    const tabsStore = useTabsStore()
    const environmentsStore = useEnvironmentsStore()

    // Established before the first await, so a second click cannot start a
    // second connection for this tab no matter which await the first one is
    // parked on.
    if (pendingConnects.value[tabId]) {
      return undefined
    }
    const attempt: PendingConnect = { cancelled: false }
    pendingConnects.value[tabId] = attempt

    tabsStore.updateTab(tabId, { wsStatus: "connecting" })
    // The template, never the resolved value: secret variables must not reach
    // the console.
    recordConsoleEntry("info", `[network] WebSocket connecting: ${url}`, "network")

    let reconnectAborted = false

    try {
      // Anything previously stranded gets another chance before this tab does
      // anything new — the same "retry the leftover id first" rule the
      // reconnect path below uses, applied to ids no tab can name any more.
      await drainOrphanConnections()

      // Reconnecting on this tab: the previous connection's store state and its
      // buffered messages are reachable only through the old id, and the line
      // below is about to overwrite it. Releasing it here is what stops N
      // reconnects from leaving N-1 hidden message buffers behind.
      const previousId = tabsStore.tabs.find((tab) => tab.id === tabId)?.wsConnectionId
      if (previousId) {
        try {
          await teardown(previousId)
        } catch (error) {
          // Abort instead of overwriting. The tab's id is the user's remaining
          // route to a connection the backend may still hold, so it stays put
          // and the status goes back to disconnected, leaving a retry possible.
          reconnectAborted = true
          tabsStore.updateTab(tabId, { wsStatus: "disconnected" })
          recordConsoleEntry(
            "error",
            `[network] WebSocket reconnect aborted, previous connection is still open: ${describeError(error)}`,
            "network",
          )
          throw error
        }
      }

      const variables = environmentsStore.variables
      const resolvedUrl = resolveTemplate(url, variables)
      const resolvedHeaders = headers
        .filter((item) => item.enabled && item.key.trim())
        .map((item) => ({
          ...item,
          key: resolveTemplate(item.key, variables),
          value: resolveTemplate(item.value, variables),
        }))

      const connectionId = await invoke<string>("ws_prepare")
      attempt.connectionId = connectionId

      // Cancelled while prepare was in flight, or the tab went away. Either way
      // the id was never written back, so nothing else can reach this
      // connection — release it here rather than leave a slot behind.
      if (attempt.cancelled || !tabsStore.tabs.some((tab) => tab.id === tabId)) {
        await invoke("ws_disconnect", { connectionId })
        tabsStore.updateTab(tabId, { wsStatus: "disconnected", wsConnectionId: undefined })
        return undefined
      }

      connections.value[connectionId] = {
        pollCancelled: false,
        closed: false,
        cancelled: false,
        dropped: 0,
        label: url,
      }
      // Written back *before* the handshake, so closing the tab mid-handshake
      // reaches this connection.
      tabsStore.updateTab(tabId, { wsConnectionId: connectionId })

      // Listener first, handshake second. This ordering is enforced by the
      // await chain, not by winning a race.
      await startListening(connectionId)
      await invoke("ws_connect", { connectionId, url: resolvedUrl, headers: resolvedHeaders })

      if (!isTauri()) {
        void pollBrowserEvents(connectionId)
      }

      // Note there is no `wsStatus: "connected"` anywhere in this function. The
      // status is written only by the connected event branch, which is
      // therefore the single gate deciding whether the UI can claim a
      // connection exists.
      return connectionId
    } catch (error) {
      if (reconnectAborted) {
        // Already converged, and the tab must keep pointing at the connection
        // that would not close.
        throw error
      }

      // Every failure converges the tab, including one thrown by ws_prepare
      // itself. Leaving the tab on "connecting" would strand it showing a
      // cancel button for a connection that does not exist.
      const id = attempt.connectionId
      // State already gone ⇒ teardown ran ⇒ the user closed the tab, which is
      // also a cancel. A failure before any id exists is a real error.
      const wasCancelled =
        attempt.cancelled || (id !== undefined && (connections.value[id]?.cancelled ?? true))

      // Paired deliberately: a cleanup failure only exists when there was an id
      // to clean up, and keeping them together is what lets the recovery below
      // work with an id it knows is real.
      let stranded: { id: string; error: unknown } | undefined
      if (id !== undefined) {
        try {
          await teardown(id)
        } catch (failure) {
          stranded = { id, error: failure }
        }
      }
      if (stranded !== undefined) {
        // Handing the id back failed twice. The backend may still hold this
        // connection, so reporting a clean cancel here would be a lie — and a
        // cancel that silently leaves a socket open is exactly what the caller
        // needs to hear about.
        //
        // The id needs an owner that outlives this attempt. A live tab is the
        // natural one — writing the id there even when it was never stored
        // gives the user a visible route and makes the next connect retry it.
        //
        // But updateTab on a closed tab silently does nothing, and in that case
        // no state record exists either, so the id would vanish entirely. The
        // orphan list is the owner that does not depend on the tab surviving.
        if (tabsStore.tabs.some((item) => item.id === tabId)) {
          tabsStore.updateTab(tabId, { wsStatus: "disconnected", wsConnectionId: stranded.id })
        } else if (!orphanConnections.value.includes(stranded.id)) {
          orphanConnections.value = [...orphanConnections.value, stranded.id]
        }
        recordConsoleEntry(
          "error",
          `[network] WebSocket cleanup failed, connection may still be open: ${describeError(stranded.error)}`,
          "network",
        )
        throw stranded.error
      }

      // Cleanup succeeded, so the id points at nothing and clearing it loses
      // no route to anything.
      tabsStore.updateTab(tabId, { wsStatus: "disconnected", wsConnectionId: undefined })

      if (wasCancelled) {
        // A cancel is the user's intent, not a failure to report.
        return undefined
      }

      recordConsoleEntry(
        "error",
        `[network] WebSocket connect failed: ${describeError(error)}`,
        "network",
      )
      throw error
    } finally {
      delete pendingConnects.value[tabId]
    }
  }

  /**
   * Retries every stranded connection, dropping only the ones that actually
   * closed. A retry that fails again stays on the list rather than blocking
   * the connect the user asked for.
   */
  async function drainOrphanConnections() {
    if (orphanConnections.value.length === 0) {
      return
    }

    for (const id of [...orphanConnections.value]) {
      try {
        await teardown(id)
        orphanConnections.value = orphanConnections.value.filter((item) => item !== id)
      } catch (error) {
        recordConsoleEntry(
          "error",
          `[network] WebSocket cleanup retry failed, connection may still be open: ${describeError(error)}`,
          "network",
        )
      }
    }
  }

  /**
   * The single entry point for the connect/cancel toggle.
   *
   * Reachable in every phase: before an id exists it marks the in-flight
   * attempt cancelled (which `connect` observes when prepare returns), and
   * afterwards it disconnects normally. Calling it twice is harmless.
   */
  async function cancelOrDisconnect(tabId: string, connectionId?: string) {
    const attempt = pendingConnects.value[tabId]

    if (attempt) {
      attempt.cancelled = true
      const id = attempt.connectionId ?? connectionId

      if (id === undefined) {
        // No id yet: converge the tab now, and let connect release the
        // connection it is about to be handed.
        useTabsStore().updateTab(tabId, { wsStatus: "disconnected", wsConnectionId: undefined })
        return
      }

      await disconnect(id)
      return
    }

    if (connectionId !== undefined) {
      await disconnect(connectionId)
    }
  }

  async function send(connectionId: string, content: string) {
    await invoke("ws_send", {
      connectionId,
      message: content,
    })

    pushMessage(connectionId, {
      id: crypto.randomUUID(),
      direction: "sent",
      content,
      timestamp: new Date().toISOString(),
    })
  }

  async function disconnect(connectionId: string) {
    const state = connections.value[connectionId]

    if (state) {
      state.cancelled = true
      state.pollCancelled = true
    }

    let disconnectError: unknown

    try {
      await invoke("ws_disconnect", { connectionId })
    } catch (error) {
      disconnectError = error
    } finally {
      await stopListening(connectionId)
      markDisconnected(connectionId)
    }

    if (disconnectError) {
      throw disconnectError
    }
  }

  /**
   * Closing a tab: disconnect, then drop this connection's state entirely.
   *
   * Deliberately not best-effort. If the disconnect fails the backend may still
   * hold the connection, and the state record deleted below is the only handle
   * left that can address it — dropping it anyway would strand the socket with
   * nothing able to reach it. So the failure propagates and the record stays,
   * and every caller decides for itself whether it can still proceed.
   */
  async function teardown(connectionId: string) {
    await disconnect(connectionId)

    clearMessages(connectionId)
    delete connections.value[connectionId]
  }

  function clearMessages(connectionId: string) {
    delete messages.value[connectionId]

    const state = connections.value[connectionId]
    if (state) {
      state.dropped = 0
    }
  }

  async function pollBrowserEvents(connectionId: string) {
    while (!connections.value[connectionId]?.pollCancelled) {
      try {
        const events = await invoke<WsEventPayload[]>("ws_drain_events", {
          connectionId,
        })

        for (const payload of events) {
          handleWsEvent(connectionId, payload)

          if (payload.eventType === "disconnected") {
            return
          }
        }
      } catch (error) {
        recordConsoleEntry(
          "error",
          `[network] WebSocket polling failed: ${describeError(error)}`,
          "network",
        )
        markDisconnected(connectionId)
        return
      }

      await new Promise((resolve) => window.setTimeout(resolve, 250))
    }
  }

  return {
    messages,
    connections,
    pendingConnects,
    orphanConnections,
    connect,
    cancelOrDisconnect,
    send,
    disconnect,
    teardown,
    clearMessages,
    getMessages,
    getDroppedCount,
  }
})
