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
import KeyValueEditor from "../request/KeyValueEditor.vue"
import UrlBar from "../request/UrlBar.vue"
import { useTabsStore } from "../../stores/tabs"
import type { KeyValuePair } from "../../types"

let pinia: ReturnType<typeof createPinia>

function pair(key: string, value: string): KeyValuePair {
  return { id: `${key}-1`, enabled: true, key, value, description: "" }
}

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

  it("writes a keystroke back through the one path that does not bump the revision", async () => {
    // Supports §8/§10. The store has both paths and the reconciler reads the
    // signal correctly; neither fact says which path this panel reaches for.
    // Picking the bumping one makes every keystroke replace the text being
    // typed — the defect this slice exists to remove, reintroduced one call
    // site away from code that is entirely correct.
    const tabs = useTabsStore()
    const fromUrlBar = vi.spyOn(tabs, "updateTabFromUrlBar")
    const bumping = vi.spyOn(tabs, "updateTab")
    const wrapper = mountPanel()

    await wrapper.findComponent(UrlBar).vm.$emit("update:url", "https://x/a?q=a%20b")

    expect(fromUrlBar).toHaveBeenCalledTimes(1)
    expect(bumping).not.toHaveBeenCalled()
  })
})

/**
 * §10 names two of the writes that come from outside the field — the params
 * table and a cURL import — and both reach it through this panel. The
 * reconciler and the store were already covered; what was not covered is
 * whether these two call sites hand anything over at all. Both could be cut
 * with the whole suite staying green, so these assert the resulting state
 * rather than spying on a call: a spy proves a function ran, not that the
 * request changed.
 */
describe("§10 the panel forwards the writes that come from outside the field", () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  it("carries a params-table edit into the request, the rendered url and the revision", async () => {
    const tabs = useTabsStore()
    tabs.updateTab(tabs.activeTab.id, {
      url: "https://api.test/items",
      params: [pair("seed-param", "1")],
      headers: [pair("Seed-Header", "2")],
    })
    const before = tabs.activeTab.urlRevision
    const wrapper = mountPanel()

    const paramsEditor = wrapper.findAllComponents(KeyValueEditor)[0]
    // Self-check the pick: the params and headers editors are the same
    // component and differ only by template order, so a wrong index would
    // quietly assert against the headers editor instead.
    expect((paramsEditor.props("modelValue") as KeyValuePair[]).map((row) => row.key)).toEqual([
      "seed-param",
    ])

    await paramsEditor.vm.$emit("update:modelValue", [pair("q", "a b")])

    expect(tabs.activeTab.params.map((row) => [row.key, row.value])).toEqual([["q", "a b"]])
    expect(wrapper.findComponent(UrlBar).props("url")).toBe("https://api.test/items?q=a+b")
    expect(tabs.activeTab.urlRevision).toBe(before + 1)
  })

  it("carries a pasted curl into the request and marks the write as external", async () => {
    const tabs = useTabsStore()
    tabs.updateTab(tabs.activeTab.id, { url: "https://old.test/a", params: [] })
    const before = tabs.activeTab.urlRevision
    const wrapper = mountPanel()

    await wrapper
      .findComponent(UrlBar)
      .vm.$emit("pasteCurl", "curl 'https://api.test/items?q=a+b'")

    expect(tabs.activeTab.params.map((row) => [row.key, row.value])).toEqual([["q", "a b"]])
    // The revision is the half that decides whether the field adopts the new
    // string. Writing this through the URL bar's own exempt path would leave
    // the user's old draft sitting on top of an imported request.
    expect(tabs.activeTab.urlRevision).toBe(before + 1)
    expect(wrapper.findComponent(UrlBar).props("url")).toBe("https://api.test/items?q=a+b")
  })
})
