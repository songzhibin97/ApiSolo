// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { shallowMount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"

// Partial: the store chain pulls in src/i18n/index.ts, which needs the real
// createI18n. Only the composable is replaced, so `t` is observable.
vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: (key: string) => key }),
}))

import RequestPanel from "../panels/RequestPanel.vue"
import UrlBar from "../request/UrlBar.vue"
import { useTabsStore } from "../../stores/tabs"

let pinia: ReturnType<typeof createPinia>

function mountPanel() {
  // The same instance the test writes into — a second createPinia() here would
  // give the component a different store and quietly assert nothing.
  return shallowMount(RequestPanel, { global: { plugins: [pinia] } })
}

describe("the request panel hands the url bar what it needs", () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  it("§4 never puts the query api key in the url the field renders", () => {
    const tabs = useTabsStore()
    tabs.updateTab(tabs.activeTab.id, {
      url: "https://api.test/probe",
      params: [{ id: "p1", enabled: true, key: "page", value: "1", description: "" }],
      auth: {
        type: "api-key",
        apiKey: { key: "X-Api-Key", value: "SECRET123", addTo: "query" },
      },
    })

    const url = mountPanel().findComponent(UrlBar).props("url")

    // The backend appends this pair after the params. Rendering it here would
    // put a live credential into a string people copy and screenshot.
    expect(url).not.toContain("SECRET123")
    expect(url).not.toContain("X-Api-Key")
    expect(url).toBe("https://api.test/probe?page=1")
  })

  it("§12(b) passes the url revision through", () => {
    const tabs = useTabsStore()
    tabs.updateTab(tabs.activeTab.id, { url: "https://api.test/probe" })
    const expected = tabs.activeTab.urlRevision

    const urlBar = mountPanel().findComponent(UrlBar)

    // Without this prop the field cannot see an outside write that renders to
    // the identical string, and the stale-draft defect comes straight back.
    expect(urlBar.props("urlRevision")).toBe(expected)
    expect(urlBar.props("tabId")).toBe(tabs.activeTab.id)
  })
})
