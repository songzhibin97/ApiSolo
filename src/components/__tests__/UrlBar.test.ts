// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { shallowMount } from "@vue/test-utils"

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock("../../utils/url-params", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/url-params")>()
  return { ...actual, reconcileUrlBarValue: vi.fn(actual.reconcileUrlBarValue) }
})

import UrlBar from "../request/UrlBar.vue"
import { reconcileUrlBarValue } from "../../utils/url-params"

const reconcile = vi.mocked(reconcileUrlBarValue)

const CANONICAL = "https://x/a?q=a+b"

function mountBar() {
  return shallowMount(UrlBar, {
    props: { method: "GET" as const, url: CANONICAL, tabId: "tab-a", urlRevision: 0 },
  })
}

describe("§12(a) an outside write is reconciled even when the string is identical", () => {
  beforeEach(() => {
    reconcile.mockClear()
  })

  it("runs the reconciler on a revision-only external write", async () => {
    const wrapper = mountBar()
    // The user's own %20 has already echoed back as the canonical +, so the
    // import that follows changes the origin and nothing else.
    await wrapper.find("input").setValue("https://x/a?q=a%20b")
    reconcile.mockClear()

    await wrapper.setProps({ urlRevision: 1 })

    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  it("carries the draft and the new origin into the reconciler", async () => {
    const wrapper = mountBar()
    await wrapper.find("input").setValue("https://x/a?q=a%20b")
    reconcile.mockClear()

    await wrapper.setProps({ urlRevision: 1 })

    // Only what goes in. What comes back out is §11's subject, and asserting
    // it here would collapse this case on a §11 regression — the two layers
    // this pair of invariants exists to keep apart.
    expect(reconcile).toHaveBeenCalledWith(
      { tabId: "tab-a", revision: 0, draft: "https://x/a?q=a%20b" },
      { tabId: "tab-a", revision: 1, url: CANONICAL },
    )
  })

  it("still runs the reconciler when the url string itself changes", async () => {
    const wrapper = mountBar()
    reconcile.mockClear()

    await wrapper.setProps({ url: "https://x/a?q=c" })

    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  it("still runs the reconciler when the tab changes", async () => {
    const wrapper = mountBar()
    reconcile.mockClear()

    await wrapper.setProps({ tabId: "tab-b" })

    expect(reconcile).toHaveBeenCalledTimes(1)
  })
})
