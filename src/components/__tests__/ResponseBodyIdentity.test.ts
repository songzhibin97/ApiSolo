// @vitest-environment happy-dom
/**
 * Which response the body view is speaking about.
 *
 * These sit at the panel because that is where the change happens. The body
 * view's copy state is about one particular response, and every way it can be
 * made to speak for the wrong one goes through the same door: the panel
 * putting a different response on screen. Driving that with `setProps` on a
 * lone body view would test an arrangement production does not have — the
 * panel does not hand a live view different props, it builds a view per
 * response — so the wiring, not a stand-in for it, is what is mounted here.
 *
 * The real catalog is loaded rather than the `t: key => key` stub, for the
 * reason `ResponseBodyActions.test.ts` gives: what is load-bearing is which
 * sentence the component picked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { mount } from "@vue/test-utils"
import { createI18n } from "vue-i18n"
import { createPinia, setActivePinia } from "pinia"

import ResponsePanel from "../panels/ResponsePanel.vue"
import { useTabsStore } from "../../stores/tabs"
import en from "../../i18n/en"
import zhCN from "../../i18n/zh-CN"
import type { TabResponse } from "../../types"

const COPY = "[data-testid=\"response-body-copy\"]"
const TREE_VIEW = "[data-testid=\"response-view-tree\"]"
const RAW_VIEW = "[data-testid=\"response-view-raw\"]"
/** What the stubbed tree renders as; its presence is the mode, visibly. */
const TREE_STUB = "json-tree-view-stub"

let pinia: ReturnType<typeof createPinia>

/**
 * Built fresh on every call and never shared between tabs, exactly as the
 * store produces them: `request.ts` writes a new object per send and
 * `openHistoryEntry` per replay. Two calls with the same arguments therefore
 * give two responses that are equal in every field and are still two
 * responses — the case the whole file is about.
 */
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
  return mount(ResponsePanel, {
    global: {
      plugins: [
        pinia,
        createI18n({ legacy: false, locale: "en", fallbackLocale: "en", messages: { en, "zh-CN": zhCN } }),
      ],
      // The body view itself is under test; what it renders the body into is
      // a CodeMirror instance with nothing to say about response identity.
      stubs: { CodeEditor: true, JsonTreeView: true },
    },
  })
}

function installClipboard(value: unknown) {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value,
    configurable: true,
    writable: true,
  })
}

/** Lets an already-settled clipboard write reach the rendered label. */
async function settle(wrapper: { vm: { $nextTick: () => Promise<unknown> } }) {
  await Promise.resolve()
  await Promise.resolve()
  await wrapper.vm.$nextTick()
}

/**
 * Two tabs holding responses that are equal field for field. Any judgement of
 * "is this a different response" made by comparing contents says no here, and
 * the answer is yes.
 */
function openTwoIdenticalResponses() {
  const tabs = useTabsStore()
  const first = tabs.activeTab.id

  tabs.updateTab(first, { response: buildResponse() })
  tabs.addTab()
  const second = tabs.activeTab.id
  tabs.updateTab(second, { response: buildResponse() })
  tabs.setActiveTab(first)

  return { tabs, first, second }
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  installClipboard({ writeText: vi.fn(() => Promise.resolve()) })
})

describe("D32 the body view speaks only for the response it was built for", () => {
  // PROCESS.md P12: prove the harness can fail on a value before its green is
  // worth anything. Phase 2 must fail as a mismatch, not as a broken mount.
  describe("harness self-check", () => {
    it("phase 1 — a correct label assertion passes", () => {
      const tabs = useTabsStore()
      tabs.updateTab(tabs.activeTab.id, { response: buildResponse() })

      expect(mountPanel().find(COPY).text()).toBe(en.response.copyBody)
    })

    it("phase 2 — the same assertion made wrong fails on the value", () => {
      const tabs = useTabsStore()
      tabs.updateTab(tabs.activeTab.id, { response: buildResponse() })
      const label = mountPanel().find(COPY).text()

      expect(() => expect(label).toBe("a label nothing renders")).toThrow(
        /a label nothing renders/,
      )
    })
  })

  /**
   * The fixture the rest of the file rests on. Without it "the two tabs hold
   * different responses" and "the two tabs hold the same response" would be
   * indistinguishable, and every assertion below could be passing for the
   * wrong reason.
   */
  it("has two tabs whose responses are equal in every field and still two objects", () => {
    const { tabs, first, second } = openTwoIdenticalResponses()

    const a = tabs.tabs.find((tab) => tab.id === first)?.response
    const b = tabs.tabs.find((tab) => tab.id === second)?.response

    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })

  // The reported failure: a copy that failed on one tab wrote "Copy failed"
  // onto the next, over a response nobody had asked to copy. Nothing about the
  // two bodies differs, so no comparison of what they contain can catch it.
  it("does not carry a failed copy across to another tab holding the same body", async () => {
    installClipboard(undefined)
    const { tabs, second } = openTwoIdenticalResponses()
    const wrapper = mountPanel()

    await wrapper.find(COPY).trigger("click")
    await settle(wrapper)
    expect(wrapper.find(COPY).text()).toBe(en.response.copyFailed)

    tabs.setActiveTab(second)
    await wrapper.vm.$nextTick()

    expect(wrapper.find(COPY).text()).toBe(en.response.copyBody)
  })

  // Mirror of the above: "Copied" is a statement about the body that was
  // copied, and the clipboard holds that one, not this one.
  it("does not carry a finished copy across to another tab holding the same body", async () => {
    const { tabs, second } = openTwoIdenticalResponses()
    const wrapper = mountPanel()

    await wrapper.find(COPY).trigger("click")
    await settle(wrapper)
    expect(wrapper.find(COPY).text()).toBe(en.response.copied)

    tabs.setActiveTab(second)
    await wrapper.vm.$nextTick()

    expect(wrapper.find(COPY).text()).toBe(en.response.copyBody)
  })

  // A tab is not a response. Sending again writes a new response into the tab
  // that is already showing one, and that is a different response by every
  // measure except the one an id-based judgement would use.
  it("does not carry a failed copy across to the next response in the same tab", async () => {
    installClipboard(undefined)
    const tabs = useTabsStore()
    const id = tabs.activeTab.id
    tabs.updateTab(id, { response: buildResponse() })
    const wrapper = mountPanel()

    await wrapper.find(COPY).trigger("click")
    await settle(wrapper)
    expect(wrapper.find(COPY).text()).toBe(en.response.copyFailed)

    tabs.updateTab(id, { response: buildResponse() })
    await wrapper.vm.$nextTick()

    expect(wrapper.find(COPY).text()).toBe(en.response.copyBody)
  })

  // The other half of "only the newest attempt may speak", from the outside: a
  // write still in flight when the panel moved on has nothing to report.
  it("does not let a write that lands after the switch say Copied", async () => {
    let release: () => void = () => {}
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    installClipboard({ writeText: vi.fn(() => pending) })

    const { tabs, second } = openTwoIdenticalResponses()
    const wrapper = mountPanel()

    await wrapper.find(COPY).trigger("click")
    tabs.setActiveTab(second)
    await wrapper.vm.$nextTick()

    release()
    await pending
    await settle(wrapper)

    expect(wrapper.find(COPY).text()).toBe(en.response.copyBody)
  })

  it("does not let a rejection that lands after the switch say Copy failed", async () => {
    let reject: () => void = () => {}
    const pending = new Promise<void>((_resolve, rejectFn) => {
      reject = () => rejectFn(new Error("denied"))
    })
    installClipboard({ writeText: vi.fn(() => pending) })

    const { tabs, second } = openTwoIdenticalResponses()
    const wrapper = mountPanel()

    await wrapper.find(COPY).trigger("click")
    tabs.setActiveTab(second)
    await wrapper.vm.$nextTick()

    reject()
    await pending.catch(() => {})
    await settle(wrapper)

    expect(wrapper.find(COPY).text()).toBe(en.response.copyBody)
  })

  /**
   * The body view is not the only view holding something that belongs to one
   * response. The header view keeps a filter keyword, and a keyword typed
   * against one response hides rows of the next. The key is on the container
   * these views share rather than on the body view alone, so this is the same
   * fix rather than a second one — and a view added here later is covered
   * without anybody noticing it needed to be.
   */
  it("does not carry a header filter across to the next response", async () => {
    const tabs = useTabsStore()
    const id = tabs.activeTab.id
    tabs.updateTab(id, { response: buildResponse() })
    const wrapper = mountPanel()

    const headersTab = wrapper.findAll("button").find((button) => button.text() === en.response.headers)
    expect(headersTab).toBeDefined()
    await headersTab?.trigger("click")

    const filter = wrapper.find("input[type=\"text\"]")
    await filter.setValue("nothing matches this")
    expect(wrapper.text()).toContain(en.response.noHeadersMatched)

    tabs.updateTab(id, { response: buildResponse() })
    await wrapper.vm.$nextTick()

    expect(wrapper.find("input[type=\"text\"]").element).toHaveProperty("value", "")
    expect(wrapper.text()).not.toContain(en.response.noHeadersMatched)
  })

  /**
   * The other direction, and the reason the key is the response's identity
   * rather than something that merely differs often enough. A view rebuilt on
   * every render would pass every assertion above while throwing away the
   * user's state constantly — their view choice on each redraw, and the
   * "Copied" they have not finished reading.
   *
   * The redraw is forced by editing a field of the response in place. That is
   * a test device and not a path production has — the store always replaces
   * `tab.response` whole — but it is the honest way to ask the question these
   * two rows exist for: the panel re-rendered, and it is still the same
   * response.
   */
  describe("the same response keeps what the user did to it", () => {
    it("keeps the view choice when the panel redraws for another reason", async () => {
      const tabs = useTabsStore()
      tabs.updateTab(tabs.activeTab.id, { response: buildResponse() })
      const wrapper = mountPanel()

      // JSON parses, so the tree is where this response starts.
      expect(wrapper.find(TREE_VIEW).exists()).toBe(true)
      expect(wrapper.find(TREE_STUB).exists()).toBe(true)

      await wrapper.find(RAW_VIEW).trigger("click")
      expect(wrapper.find(TREE_STUB).exists()).toBe(false)

      const response = tabs.activeTab.response
      if (response) {
        response.status = 201
      }
      await wrapper.vm.$nextTick()

      // Same response, so the same view: the redraw must not put the user back
      // in the tree they chose to leave.
      expect(wrapper.find(TREE_STUB).exists()).toBe(false)
    })

    it("keeps Copied on screen when the panel redraws for another reason", async () => {
      const tabs = useTabsStore()
      tabs.updateTab(tabs.activeTab.id, { response: buildResponse() })
      const wrapper = mountPanel()

      await wrapper.find(COPY).trigger("click")
      await settle(wrapper)
      expect(wrapper.find(COPY).text()).toBe(en.response.copied)

      const response = tabs.activeTab.response
      if (response) {
        response.status = 201
      }
      await wrapper.vm.$nextTick()

      expect(wrapper.find(COPY).text()).toBe(en.response.copied)
    })
  })
})
