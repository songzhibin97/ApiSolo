// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"

const { t } = vi.hoisted(() => ({ t: vi.fn((key: string) => key) }))

// Partial: the store chain pulls in src/i18n/index.ts, which needs the real
// createI18n. Only the composable is replaced, so `t` is observable.
vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t }),
}))

const { disconnectMock, cancelOrDisconnectMock, sendMock, connectMock } = vi.hoisted(() => ({
  disconnectMock: vi.fn(async (_connectionId: string) => {}),
  cancelOrDisconnectMock: vi.fn(async (_tabId: string, _connectionId?: string) => {}),
  sendMock: vi.fn(async () => {}),
  connectMock: vi.fn(async () => "ws-1"),
}))

vi.mock("../../stores/websocket", () => ({
  useWebSocketStore: () => ({
    disconnect: disconnectMock,
    cancelOrDisconnect: cancelOrDisconnectMock,
    send: sendMock,
    connect: connectMock,
    getMessages: () => [],
    getDroppedCount: () => 0,
  }),
}))

import WSConnectionPanel from "../panels/WSConnectionPanel.vue"
import { useTabsStore } from "../../stores/tabs"

let pinia: ReturnType<typeof createPinia>

function mountPanel() {
  // The same instance the test writes into — a second createPinia() here would
  // give the component a different store and quietly assert nothing.
  return mount(WSConnectionPanel, {
    global: {
      plugins: [pinia],
      stubs: { KeyValueEditor: true, LoaderCircle: true, AlertCircle: true },
    },
  })
}

function wsTab(overrides: Record<string, unknown>) {
  const tabsStore = useTabsStore()
  const tab = tabsStore.addWsTab()
  tabsStore.setActiveTab(tab.id)
  tabsStore.updateTab(tab.id, { url: "wss://example.test/socket", ...overrides })
  return tab
}

describe("WSConnectionPanel", () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    t.mockClear()
    disconnectMock.mockClear()
    cancelOrDisconnectMock.mockClear()
    sendMock.mockClear()
    connectMock.mockClear()
  })

  it("routes the connecting-state toggle to the store cancel path", async () => {
    const tab = wsTab({ wsStatus: "connecting", wsConnectionId: "ws-inflight" })
    const wrapper = mountPanel()

    await wrapper.find("button").trigger("click")

    // A20 category (d): a store call. This proves the cancel path is wired up.
    // It does NOT prove the button is enabled — only the packaged-app check
    // covers the `disabled` attribute.
    expect(cancelOrDisconnectMock).toHaveBeenCalledWith(tab.id, "ws-inflight")
    expect(connectMock).not.toHaveBeenCalled()
  })

  // The window the critical finding was about: the button reads "cancel"
  // before any id exists. Two separate consequences, two separate cases.
  it("still routes the toggle to cancel while connecting without an id yet", async () => {
    const tab = wsTab({ wsStatus: "connecting", wsConnectionId: undefined })
    const wrapper = mountPanel()

    await wrapper.find("button").trigger("click")

    expect(cancelOrDisconnectMock).toHaveBeenCalledWith(tab.id, undefined)
  })

  it("does not start a connection when the toggle is clicked while connecting without an id", async () => {
    wsTab({ wsStatus: "connecting", wsConnectionId: undefined })
    const wrapper = mountPanel()

    await wrapper.find("button").trigger("click")

    expect(connectMock).not.toHaveBeenCalled()
  })

  it("asks for the cancel label while connecting", async () => {
    wsTab({ wsStatus: "connecting", wsConnectionId: "ws-inflight" })
    mountPanel()

    expect(t.mock.calls.map((call) => call[0])).toContain("ws.cancel")
  })

  it("asks for the blocked-send reason and does not send when not connected", async () => {
    wsTab({ wsStatus: "disconnected", wsConnectionId: undefined })
    mountPanel()

    window.dispatchEvent(new CustomEvent("apisolo:ws-send"))

    expect(t.mock.calls.map((call) => call[0])).toContain("ws.notConnected")
    expect(sendMock).not.toHaveBeenCalled()
  })

  it("asks for the empty-draft reason and does not send when the draft is blank", async () => {
    wsTab({ wsStatus: "connected", wsConnectionId: "ws-open" })
    mountPanel()

    window.dispatchEvent(new CustomEvent("apisolo:ws-send"))

    expect(t.mock.calls.map((call) => call[0])).toContain("ws.emptyDraft")
    expect(sendMock).not.toHaveBeenCalled()
  })

  it("sends the draft when the shortcut fires on a connected tab", async () => {
    wsTab({ wsStatus: "connected", wsConnectionId: "ws-open" })
    const wrapper = mountPanel()

    await wrapper.find("textarea").setValue("ping")
    window.dispatchEvent(new CustomEvent("apisolo:ws-send"))
    await wrapper.vm.$nextTick()

    expect(sendMock).toHaveBeenCalledWith("ws-open", "ping")
  })
})
