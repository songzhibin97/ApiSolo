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

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export const useWebSocketStore = defineStore("websocket", () => {
  const messages = ref<Record<string, WsMessage[]>>({})
  const connections = ref<Record<string, WsConnectionState>>({})

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

    if (state?.closed) {
      return
    }

    if (state) {
      state.closed = true
    }

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

    tabsStore.updateTab(tabId, { wsStatus: "connecting" })
    // The template, never the resolved value: secret variables must not reach
    // the console.
    recordConsoleEntry("info", `[network] WebSocket connecting: ${url}`, "network")

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

    // The tab can be closed while ws_prepare is in flight. The id was never
    // written back, so tab cleanup could not find this connection — release it
    // here instead of leaving a slot behind.
    if (!tabsStore.tabs.some((tab) => tab.id === tabId)) {
      await invoke("ws_disconnect", { connectionId })
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

    try {
      // Listener first, handshake second. This ordering is enforced by the
      // await chain, not by winning a race.
      await startListening(connectionId)
      await invoke("ws_connect", { connectionId, url: resolvedUrl, headers: resolvedHeaders })
    } catch (error) {
      // State already gone ⇒ teardown ran ⇒ the user closed the tab, which is
      // also a cancel.
      const wasCancelled = connections.value[connectionId]?.cancelled ?? true
      await teardown(connectionId)
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
    }

    if (!isTauri()) {
      void pollBrowserEvents(connectionId)
    }

    // Note there is no `wsStatus: "connected"` anywhere in this function. The
    // status is written only by the connected event branch, which is therefore
    // the single gate deciding whether the UI can claim a connection exists.
    return connectionId
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

  /** Closing a tab: disconnect, then drop this connection's state entirely. */
  async function teardown(connectionId: string) {
    try {
      await disconnect(connectionId)
    } catch {
      // Tab cleanup stays best-effort even if the socket is already gone.
    }

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
    connect,
    send,
    disconnect,
    teardown,
    clearMessages,
    getMessages,
    getDroppedCount,
  }
})
