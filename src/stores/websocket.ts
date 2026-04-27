import { computed, ref } from "vue"
import { defineStore } from "pinia"

import i18n from "../i18n"
import { recordConsoleEntry } from "./console"
import { invoke, isTauri, listen, type UnlistenFn } from "../utils/invoke"
import { useTabsStore } from "./tabs"
import type { KeyValuePair, WsConnectionStatus, WsEventPayload, WsMessage } from "../types"

export const useWebSocketStore = defineStore("websocket", () => {
  const messages = ref<Record<string, WsMessage[]>>({})
  const listeners = ref<Record<string, UnlistenFn>>({})

  const getMessages = computed(() => (connectionId: string) => messages.value[connectionId] ?? [])

  function pushMessage(connectionId: string, message: WsMessage) {
    messages.value[connectionId] = [...(messages.value[connectionId] ?? []), message]
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

  async function stopListening(connectionId: string) {
    const unlisten = listeners.value[connectionId]

    if (!unlisten) {
      return
    }

    await unlisten()
    delete listeners.value[connectionId]
  }

  async function connect(tabId: string, url: string, headers: KeyValuePair[]) {
    const tabsStore = useTabsStore()
    tabsStore.updateTab(tabId, {
      wsStatus: "connecting",
    })
    recordConsoleEntry("info", `[network] WebSocket connecting: ${url}`, "network")

    try {
      if (!isTauri()) {
        return await connectInBrowser(tabId, url, headers)
      }

      const connectionId = await invoke<string>("ws_connect", {
        url,
        headers: headers.filter((item) => item.enabled && item.key.trim()),
      })

      tabsStore.updateTab(tabId, {
        wsConnectionId: connectionId,
        wsStatus: "connected",
      })

      const unlisten = await listen<WsEventPayload>(`ws-event-${connectionId}`, (event) => {
        const payload = event.payload

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
          addSystemMessage(connectionId, i18n.global.t("ws.connected"), payload.timestamp)
          recordConsoleEntry("info", `[network] WebSocket connected: ${url}`, "network")
          return
        }

        if (payload.eventType === "disconnected") {
          updateTabByConnectionId(connectionId, "disconnected")
          addSystemMessage(connectionId, i18n.global.t("ws.disconnected"), payload.timestamp)
          recordConsoleEntry("warn", `[network] WebSocket disconnected: ${url}`, "network")
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
      })

      listeners.value[connectionId] = unlisten
      return connectionId
    } catch (error) {
      tabsStore.updateTab(tabId, {
        wsStatus: "disconnected",
        wsConnectionId: undefined,
      })
      recordConsoleEntry(
        "error",
        `[network] WebSocket connect failed: ${error instanceof Error ? error.message : String(error)}`,
        "network",
      )
      throw error
    }
  }

  async function connectInBrowser(tabId: string, url: string, headers: KeyValuePair[]) {
    const tabsStore = useTabsStore()
    const connectionId = await invoke<string>("ws_connect", {
      url,
      headers: headers.filter((item) => item.enabled && item.key.trim()),
    })

    tabsStore.updateTab(tabId, {
      wsConnectionId: connectionId,
      wsStatus: "connected",
    })

    let cancelled = false
    listeners.value[connectionId] = async () => {
      cancelled = true
    }

    void pollBrowserEvents(connectionId, () => cancelled)
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
    let disconnectError: unknown

    try {
      await invoke("ws_disconnect", { connectionId })
      if (!isTauri()) {
        await invoke("ws_drain_events", { connectionId })
      }
    } catch (error) {
      disconnectError = error
    } finally {
      await stopListening(connectionId)
      updateTabByConnectionId(connectionId, "disconnected")
      addSystemMessage(connectionId, i18n.global.t("ws.disconnected"))
      recordConsoleEntry("warn", `[network] WebSocket disconnected: ${connectionId}`, "network")
    }

    if (disconnectError) {
      throw disconnectError
    }
  }

  function clearMessages(connectionId: string) {
    delete messages.value[connectionId]
  }

  async function pollBrowserEvents(connectionId: string, isCancelled: () => boolean) {
    while (!isCancelled()) {
      try {
        const events = await invoke<WsEventPayload[]>("ws_drain_events", {
          connectionId,
        })

        for (const payload of events) {
          if (payload.eventType === "message") {
            pushMessage(connectionId, {
              id: crypto.randomUUID(),
              direction: "received",
              content: payload.content,
              timestamp: payload.timestamp,
            })
            continue
          }

          if (payload.eventType === "connected") {
            addSystemMessage(connectionId, i18n.global.t("ws.connected"), payload.timestamp)
            recordConsoleEntry("info", `[network] WebSocket connected: ${connectionId}`, "network")
            continue
          }

          if (payload.eventType === "disconnected") {
            updateTabByConnectionId(connectionId, "disconnected")
            addSystemMessage(connectionId, i18n.global.t("ws.disconnected"), payload.timestamp)
            recordConsoleEntry("warn", `[network] WebSocket disconnected: ${connectionId}`, "network")
            await stopListening(connectionId)
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
      } catch (error) {
        recordConsoleEntry(
          "error",
          `[network] WebSocket polling failed: ${error instanceof Error ? error.message : String(error)}`,
          "network",
        )
        await stopListening(connectionId)
        updateTabByConnectionId(connectionId, "disconnected")
        return
      }

      await new Promise((resolve) => window.setTimeout(resolve, 250))
    }
  }

  return {
    messages,
    listeners,
    connect,
    send,
    disconnect,
    clearMessages,
    getMessages,
  }
})
