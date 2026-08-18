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

/**
 * Both cases here read from the rendered field rather than from a call. That is
 * the fifth assertion class ruling A27 added to A20: a form control's `value`
 * binding is not decoration, it is the only wire between the draft the code
 * keeps and the text the user edits. Everything downstream of that wire can be
 * correct while the wire itself is cut, which is exactly what happened — this
 * pair of cases exists because both mutations below survived all 313 tests.
 */
describe("§8/§12 the field renders the draft, not the value handed back to it", () => {
  beforeEach(() => {
    reconcile.mockClear()
  })

  it("keeps showing what was typed after a re-render", async () => {
    const wrapper = mountBar()
    await wrapper.find("input").setValue("https://x/a?q=a%20b")

    // The re-render matters and must not be tidied away. Binding the field to
    // `props.url` only overwrites the text when Vue patches the element, so
    // without a render in between, a cut wire still looks intact.
    await wrapper.setProps({ method: "POST" as const })

    expect((wrapper.find("input").element as HTMLInputElement).value).toBe(
      "https://x/a?q=a%20b",
    )
  })

  it("reads the variable hint off the draft", async () => {
    const wrapper = shallowMount(UrlBar, {
      props: { method: "GET" as const, url: "https://x/a?b=1", tabId: "t", urlRevision: 0 },
    })
    // A whitespace-only key is dropped from the rendered url (§3), so this
    // variable exists in the draft and nowhere else. Reading the hint off the
    // rendered url instead would tell the user there is no variable in a URL
    // they just wrote one into.
    await wrapper.find("input").setValue("https://x/a?  ={{v}}&b=1")
    await wrapper.setProps({ method: "POST" as const })

    expect(wrapper.find('[data-testid="url-variables"]').exists()).toBe(true)
  })
})

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
