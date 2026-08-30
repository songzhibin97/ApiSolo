// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { shallowMount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"

vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: (key: string) => key }),
}))

import ResponsePanel from "../panels/ResponsePanel.vue"
import ResponseBody from "../response/ResponseBody.vue"
import { useTabsStore } from "../../stores/tabs"
import type { HistoryEntry, TabResponse } from "../../types"

let pinia: ReturnType<typeof createPinia>

function buildResponse(overrides: Partial<TabResponse> = {}): TabResponse {
  return {
    status: 200,
    statusText: "OK",
    headers: [["content-type", "application/json"]],
    body: "{\"ok\":true}",
    size: 11,
    time: 45,
    timings: { dnsLookup: 0, tcpConnect: 0, tlsHandshake: 0, ttfb: 0, download: 1, total: 45 },
    contentType: "application/json",
    bodyKind: "text",
    bodyTruncated: false,
    bodySource: "network",
    ...overrides,
  }
}

function mountPanel() {
  return shallowMount(ResponsePanel, { global: { plugins: [pinia] } })
}

describe("the response panel hands the body view what it needs", () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  // PROCESS.md P12: prove the harness can say both words before trusting its
  // silence. Phase 1 is a correct assertion that must pass, phase 2 is the
  // same assertion made wrong, which must fail as a mismatch rather than
  // because the mount blew up.
  describe("harness self-check", () => {
    it("phase 1 — a correct prop assertion passes", () => {
      const tabs = useTabsStore()
      tabs.updateTab(tabs.activeTab.id, { response: buildResponse() })

      expect(mountPanel().findComponent(ResponseBody).props("body")).toBe("{\"ok\":true}")
    })

    it("phase 2 — the same assertion made wrong fails on the value", () => {
      const tabs = useTabsStore()
      tabs.updateTab(tabs.activeTab.id, { response: buildResponse() })

      const body = mountPanel().findComponent(ResponseBody).props("body")
      expect(() => expect(body).toBe("a body nothing produces")).toThrow(/a body nothing produces/)
    })
  })

  it("§57 passes the response body kind down to the body view", () => {
    const tabs = useTabsStore()
    tabs.updateTab(tabs.activeTab.id, { response: buildResponse({ bodyKind: "binary" }) })

    expect(mountPanel().findComponent(ResponseBody).props("bodyKind")).toBe("binary")
  })

  // The whole point of the field is the replay case: this is the path that used
  // to render a placeholder string as though the server had sent it.
  it("§57 passes it down for a response restored from history too", () => {
    const tabs = useTabsStore()
    tabs.openHistoryEntry({
      id: "h-1",
      method: "GET",
      url: "https://api.example.com/image.png",
      status: 200,
      time: 12,
      size: 900,
      timestamp: "2026-03-27T10:00:00Z",
      contentType: "image/png",
      responseBody: "[binary 900 bytes]",
      responseBodyKind: "binary",
    } as HistoryEntry)

    expect(tabs.activeTab.response?.bodyKind).toBe("binary")
    expect(mountPanel().findComponent(ResponseBody).props("bodyKind")).toBe("binary")
  })

  // The panel may only call a body complete when it knows the body came
  // straight off the wire. That fact exists nowhere in the response itself --
  // history's own storage cut leaves no flag -- so it has to be read off the
  // boundary and carried down, or the claim is made on a body nobody vouched
  // for.
  it("tells the body view a live response came off the network", () => {
    const tabs = useTabsStore()
    tabs.updateTab(tabs.activeTab.id, { response: buildResponse() })

    expect(mountPanel().findComponent(ResponseBody).props("bodySource")).toBe("network")
  })

  it("tells the body view a replayed response came out of history", () => {
    const tabs = useTabsStore()
    tabs.openHistoryEntry({
      id: "h-2",
      method: "GET",
      url: "https://api.example.com/users",
      status: 200,
      time: 12,
      size: 30,
      timestamp: "2026-03-27T10:00:00Z",
      contentType: "application/json",
      responseBody: "{\"ok\":true}",
    } as HistoryEntry)

    expect(tabs.activeTab.response?.bodySource).toBe("history")
    expect(mountPanel().findComponent(ResponseBody).props("bodySource")).toBe("history")
  })
})
