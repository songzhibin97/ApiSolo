// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { mount, shallowMount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { nextTick } from "vue"

// Partial: the store chain pulls in src/i18n/index.ts, which needs the real
// createI18n. Only the composable is replaced, so `t` is observable.
vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: (key: string) => key }),
}))

import RequestPanel from "../panels/RequestPanel.vue"
import KeyValueEditor from "../request/KeyValueEditor.vue"
import PendingRefillNotice from "../request/PendingRefillNotice.vue"
import UrlBar from "../request/UrlBar.vue"
import { useProjectsStore } from "../../stores/projects"
import { useSaveGateStore } from "../../stores/save-gate"
import { useTabsStore } from "../../stores/tabs"
import { historyEntryToRequest } from "../../utils/history-to-request"
import { identityTuple, pendingRefillFields, type PendingField } from "../../utils/pending-refill"
import { REDACTION_SENTINEL } from "../../utils/redaction"
import type { AuthConfig, HistoryEntry, KeyValuePair } from "../../types"

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

/**
 * §6 — the gate is on the state of the request, not on which button was
 * pressed. This is the button that had no gate at all, and it is step 2 of the
 * lying path: open from history, save with this button, reopen from the
 * collection, and every warning is gone.
 */
describe("§6 the existing save button is gated by the same check as the new one", () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
    return {
      id: "h-1",
      method: "POST",
      url: `https://api.example.com/users?api_key=${REDACTION_SENTINEL}`,
      status: 201,
      time: 42,
      size: 12,
      timestamp: "2026-03-27T10:00:00Z",
      contentType: "application/json",
      requestHeaders: [pair("Authorization", REDACTION_SENTINEL)],
      requestParams: [],
      requestAuth: { type: "bearer", bearer: { token: "" } } as AuthConfig,
      requestBodyType: "none",
      requestBodyFormData: [],
      ...overrides,
    } as HistoryEntry
  }

  async function openSaveDialog(wrapper: ReturnType<typeof mountPanel>) {
    const buttons = wrapper.findAll("button")
    const save = buttons.find((button) => button.text().includes("request.save"))
    expect(save, "the save button is not rendered").toBeDefined()
    await save!.trigger("click")
  }

  it("does not save while the request has unacknowledged pending fields", async () => {
    const projects = useProjectsStore()
    projects.activeProject = "My API"
    const saveRequest = vi.spyOn(projects, "saveRequest").mockResolvedValue(undefined)
    const tabs = useTabsStore()
    tabs.openHistoryEntry(entry())

    const wrapper = mountPanel()
    await openSaveDialog(wrapper)
    const submit = wrapper.find("[data-testid=\"request-save-submit\"]")

    // Both halves of the gate, because they fail differently: the binding is
    // what the user sees, the guard is what stops a submit that reaches the
    // handler anyway.
    expect((submit.element as HTMLButtonElement).disabled).toBe(true)
    await submit.trigger("click")
    expect(saveRequest).not.toHaveBeenCalled()
  })

  it("saves once the same fields have been acknowledged elsewhere", async () => {
    const projects = useProjectsStore()
    projects.activeProject = "My API"
    const saveRequest = vi.spyOn(projects, "saveRequest").mockResolvedValue(undefined)
    const tabs = useTabsStore()
    tabs.openHistoryEntry(entry())
    const gate = useSaveGateStore()

    const wrapper = mountPanel()
    await openSaveDialog(wrapper)

    // The acknowledgement belongs to the request, so it does not matter which
    // entry point collected it.
    gate.acknowledge(wrapper.findComponent(PendingRefillNotice).props("fields") as PendingField[])
    await wrapper.vm.$nextTick()

    const submit = wrapper.find("[data-testid=\"request-save-submit\"]")
    expect((submit.element as HTMLButtonElement).disabled).toBe(false)
    await submit.trigger("click")
    expect(saveRequest).toHaveBeenCalledTimes(1)
  })

  it("shows the same list the history entry point would show", async () => {
    const projects = useProjectsStore()
    projects.activeProject = "My API"
    const source = entry()
    const tabs = useTabsStore()
    tabs.openHistoryEntry(source)

    const wrapper = mountPanel()
    await openSaveDialog(wrapper)

    const fromPanel = wrapper.findComponent(PendingRefillNotice).props("fields") as PendingField[]
    const fromHistory = pendingRefillFields(historyEntryToRequest(source))

    // Compared on identity, not on display text: the two lists have to agree on
    // what is pending, and that answer must not move with the interface language.
    const identity = (fields: PendingField[]) =>
      fields.map((field) => JSON.stringify(identityTuple(field))).sort()

    expect(fromPanel).toHaveLength(3)
    expect(identity(fromPanel)).toEqual(identity(fromHistory))
  })

  /**
   * This used to be the one documented class where the two lists disagreed:
   * replay emptied the body text, the key names went with it, and the panel
   * could only report a catch-all "request body" entry — so the same request
   * had two signatures and had to be confirmed twice.
   *
   * D11 removes the exception rather than restating it. The fix is not to make
   * the panel guess: the key names are written down at the moment they are
   * emptied, so both sides can name the same key.
   */
  it("names the same body key from either entry point", async () => {
    const projects = useProjectsStore()
    projects.activeProject = "My API"
    const source = entry({
      requestHeaders: [],
      url: "https://api.example.com/users",
      requestAuth: undefined,
      requestBodyType: "json",
      requestBodyContent: `{"password":"${REDACTION_SENTINEL}"}`,
    })
    const tabs = useTabsStore()
    tabs.openHistoryEntry(source)

    const wrapper = mountPanel()
    await openSaveDialog(wrapper)

    const fromPanel = wrapper.findComponent(PendingRefillNotice).props("fields") as PendingField[]

    expect(fromPanel.map(identityTuple)).toEqual([["refill", "body", null, "password"]])
    expect(pendingRefillFields(historyEntryToRequest(source)).map(identityTuple)).toEqual(
      fromPanel.map(identityTuple),
    )
  })

  it("carries one acknowledgement across both entry points for a body field", async () => {
    const projects = useProjectsStore()
    projects.activeProject = "My API"
    const source = entry({
      requestHeaders: [],
      url: "https://api.example.com/users",
      requestAuth: undefined,
      requestBodyType: "json",
      requestBodyContent: `{"password":"${REDACTION_SENTINEL}"}`,
    })
    const tabs = useTabsStore()
    tabs.openHistoryEntry(source)
    const gate = useSaveGateStore()

    // Acknowledged on the history side, where the row still holds the
    // placeholder. The panel must accept it without asking again.
    gate.acknowledge(pendingRefillFields(historyEntryToRequest(source)))

    const wrapper = mountPanel()
    await openSaveDialog(wrapper)

    expect(
      (wrapper.find("[data-testid=\"request-save-submit\"]").element as HTMLButtonElement).disabled,
    ).toBe(false)
  })
})

/**
 * These mount for real rather than stubbing the children, and that is the whole
 * point of them. The defect this slice fixes lived in the body editor's own
 * startup behaviour — it reformats a compact JSON payload for display — and
 * under `shallowMount` that component is never instantiated, so the existing
 * suite stayed green through an entire release while the gate was gone in the
 * browser.
 *
 * Assertions stay inside the component whitelist: props handed to children,
 * whether a `v-if` block exists, how many `v-for` rows it has, and the disabled
 * binding. No DOM text is asserted here; the wording is a pure function's
 * return value and is checked as one.
 */
describe("§4 §9 §12 §13 §16 §18 the gate survives the body editor doing its job", () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  function historyWithCompactJson(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
    return {
      id: "h-2",
      method: "POST",
      url: "https://api.example.com/users",
      status: 200,
      time: 10,
      size: 10,
      timestamp: "2026-03-27T10:00:00Z",
      contentType: "application/json",
      requestHeaders: [],
      requestParams: [],
      requestBodyType: "json",
      // Compact on purpose: the editor reformats it on mount, which is the
      // write that used to wipe the record of what had been blanked.
      requestBodyContent: `{"token":"${REDACTION_SENTINEL}","keep":"v"}`,
      requestBodyFormData: [],
      ...overrides,
    } as HistoryEntry
  }

  function mountFull() {
    return mount(RequestPanel, { global: { plugins: [pinia] } })
  }

  async function openSaveDialog(wrapper: ReturnType<typeof mountFull>) {
    const save = wrapper.findAll("button").find((b) => b.text().includes("request.save"))
    expect(save, "the save button is not rendered").toBeDefined()
    await save!.trigger("click")
  }

  it("the fixture really is reformatted by the editor, not left alone", async () => {
    // P6/P12: without this the two tests below would also pass on a payload the
    // editor never touches — the safe shape the defect happens to miss.
    const tabs = useTabsStore()
    const source = historyWithCompactJson()
    tabs.openHistoryEntry(source)
    const afterLoad = tabs.activeTab.body.content

    mountFull()
    await nextTick()

    expect(afterLoad).toBe(`{"token":"","keep":"v"}`)
    expect(tabs.activeTab.body.content).not.toBe(afterLoad)
    expect(tabs.activeTab.body.content).toContain("\n")
  })

  it("§4 keeps the body field pending after the editor reformats the body", async () => {
    const projects = useProjectsStore()
    projects.activeProject = "My API"
    const tabs = useTabsStore()
    tabs.openHistoryEntry(historyWithCompactJson())

    const wrapper = mountFull()
    await nextTick()
    await openSaveDialog(wrapper)

    const fields = wrapper.findComponent(PendingRefillNotice).props("fields") as PendingField[]

    expect(fields.map(identityTuple)).toEqual([["refill", "body", null, "token"]])
    expect(
      (wrapper.find("[data-testid=\"request-save-submit\"]").element as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  /**
   * Two directions, not one. The editor's reformat is driven by a watch on the
   * selected body type, so opening a JSON request from a tab that was already
   * JSON does not fire it — before the fix, that path kept its gate and the
   * other lost it. A single case would land on one of the two at random.
   */
  it.each([
    ["none", "none"],
    ["json", `{"a":1}`],
  ])("§9 holds the gate when the previous tab's body was %s", async (type, content) => {
    const projects = useProjectsStore()
    projects.activeProject = "My API"
    const tabs = useTabsStore()
    tabs.updateTab(tabs.activeTab.id, {
      body: { ...tabs.activeTab.body, type: type as never, content },
    })

    const wrapper = mountFull()
    await nextTick()
    tabs.openHistoryEntry(historyWithCompactJson())
    await nextTick()
    await openSaveDialog(wrapper)

    const fields = wrapper.findComponent(PendingRefillNotice).props("fields") as PendingField[]

    expect(fields.map(identityTuple)).toEqual([["refill", "body", null, "token"]])
  })

  it("§10 §11 shows the standing notice for a blanked auth slot", async () => {
    const tabs = useTabsStore()
    tabs.openHistoryEntry(
      historyWithCompactJson({
        requestBodyType: "none",
        requestBodyContent: undefined,
        requestAuth: { type: "bearer", bearer: { token: "" } } as AuthConfig,
      }),
    )

    const wrapper = mountFull()
    await nextTick()

    // The gate alone cannot save this user: it only speaks when they press
    // Save, and their next move is Send.
    expect(wrapper.find("[data-testid=\"history-redacted-banner\"]").exists()).toBe(true)
  })

  it("§12 shows no standing notice for a request with nothing pending", async () => {
    const tabs = useTabsStore()
    tabs.updateTab(tabs.activeTab.id, { url: "https://api.example.com/ok" })

    const wrapper = mountFull()
    await nextTick()

    expect(wrapper.find("[data-testid=\"history-redacted-banner\"]").exists()).toBe(false)
  })

  it("§10 shows no standing notice when only a file needs re-picking", async () => {
    const tabs = useTabsStore()
    tabs.openHistoryEntry(
      historyWithCompactJson({
        requestBodyType: "binary",
        requestBodyContent: undefined,
        requestBodyBinaryPath: "photo.png",
      }),
    )

    const wrapper = mountFull()
    await nextTick()

    // The body editor already says "no file selected"; repeating it here would
    // be the notice restating what the screen is carrying.
    expect(wrapper.find("[data-testid=\"history-redacted-banner\"]").exists()).toBe(false)
  })

  it("§13 §16 saves a url and values with no placeholder left in them", async () => {
    const projects = useProjectsStore()
    projects.activeProject = "My API"
    const saveRequest = vi.spyOn(projects, "saveRequest").mockResolvedValue(undefined)
    const tabs = useTabsStore()
    tabs.openHistoryEntry(
      historyWithCompactJson({
        url: `https://api.example.com/users?apikey=${REDACTION_SENTINEL}&page=1`,
      }),
    )
    const gate = useSaveGateStore()

    const wrapper = mountFull()
    await nextTick()
    await openSaveDialog(wrapper)

    gate.acknowledge(wrapper.findComponent(PendingRefillNotice).props("fields") as PendingField[])
    await nextTick()
    await wrapper.find("[data-testid=\"request-save-submit\"]").trigger("click")

    expect(saveRequest).toHaveBeenCalledTimes(1)
    const saved = JSON.stringify(saveRequest.mock.calls[0])
    expect(saved).not.toContain(REDACTION_SENTINEL)
  })

  /**
   * §18 is not asserted here. This file replaces `useI18n` with a passthrough
   * stub, so rendered text is the message key and does not move when the locale
   * does — a language-switch assertion in this file could not fail and would be
   * a comment wearing an assertion's clothes.
   *
   * It is covered where real messages are available: `pending-refill.test.ts`
   * shows the display text changing with the locale while the identity does
   * not, and `save-gate.test.ts` shows the gate keyed on the identity. The
   * wiring half — this panel passing raw fields to the gate rather than fields
   * with display text glued into them — is what
   * "carries one acknowledgement across both entry points" above catches,
   * because the history side acknowledges the raw identity.
   */
})

/**
 * The same fault as the body one, on the url side, found in implementation
 * review. A tab opened from history keeps its query gate on the parameter row's
 * marker, because the placeholder itself is stripped on load. Rebuilding those
 * rows from the url text threw the marker away, so editing a completely
 * unrelated part of the url — the path — dropped the gate on an empty API key
 * and the save went through.
 *
 * The rule is the same one §5 states for the body: an edit elsewhere must not
 * clear a field that is still blank.
 */
describe("editing an unrelated part of the url keeps the query gate", () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  function openedWithRedactedQuery() {
    const tabs = useTabsStore()
    tabs.openHistoryEntry({
      id: "h-3",
      method: "GET",
      url: `https://api.example.com/users?apikey=${REDACTION_SENTINEL}&page=1`,
      status: 200,
      time: 10,
      size: 10,
      timestamp: "2026-03-27T10:00:00Z",
      contentType: "application/json",
      requestHeaders: [],
      requestParams: [],
      requestBodyType: "none",
      requestBodyFormData: [],
    } as HistoryEntry)
    return tabs
  }

  it("the fixture starts out gated on the parameter row's marker", () => {
    const tabs = openedWithRedactedQuery()
    const row = tabs.activeTab.params.find((item) => item.key === "apikey")

    // Self-check: if the placeholder were still in the url the gate would come
    // from the url scan instead, and this whole test would prove nothing.
    expect(tabs.activeTab.url).not.toContain(REDACTION_SENTINEL)
    expect(row).toEqual(expect.objectContaining({ value: "", redacted: true }))
    expect(pendingRefillFields(tabs.activeTab).map(identityTuple)).toEqual([
      ["refill", "query", null, "apikey"],
    ])
  })

  it("keeps the list, the notice and the disabled save after the path is edited", async () => {
    const projects = useProjectsStore()
    projects.activeProject = "My API"
    const tabs = openedWithRedactedQuery()
    const wrapper = mount(RequestPanel, { global: { plugins: [pinia] } })
    await nextTick()

    await wrapper
      .findComponent(UrlBar)
      .vm.$emit("update:url", "https://api.example.com/admins?apikey=&page=1")
    await nextTick()

    expect(pendingRefillFields(tabs.activeTab).map(identityTuple)).toEqual([
      ["refill", "query", null, "apikey"],
    ])
    expect(wrapper.find("[data-testid=\"history-redacted-banner\"]").exists()).toBe(true)

    const save = wrapper.findAll("button").find((b) => b.text().includes("request.save"))
    await save!.trigger("click")
    expect(
      (wrapper.find("[data-testid=\"request-save-submit\"]").element as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  /**
   * The reorder case, end to end. Two blanked API keys, one typed back in, then
   * the pair pasted back the other way round. Nothing about the second one was
   * touched, so it has to stay pending and the save has to stay held.
   */
  it("keeps the still-blank one pending when same-named parameters are reordered", async () => {
    const projects = useProjectsStore()
    projects.activeProject = "My API"
    const tabs = useTabsStore()
    tabs.openHistoryEntry({
      id: "h-4",
      method: "GET",
      url: `https://api.example.com/users?apikey=${REDACTION_SENTINEL}&apikey=${REDACTION_SENTINEL}`,
      status: 200,
      time: 10,
      size: 10,
      timestamp: "2026-03-27T10:00:00Z",
      contentType: "application/json",
      requestHeaders: [],
      requestParams: [],
      requestBodyType: "none",
      requestBodyFormData: [],
    } as HistoryEntry)

    // Self-check: both rows must start out pending, otherwise the reorder below
    // has nothing to lose and this test proves nothing.
    expect(pendingRefillFields(tabs.activeTab)).toHaveLength(2)

    const wrapper = mount(RequestPanel, { global: { plugins: [pinia] } })
    await nextTick()

    const urlBar = wrapper.findComponent(UrlBar)
    await urlBar.vm.$emit("update:url", "https://api.example.com/users?apikey=FILLED&apikey=")
    await nextTick()
    expect(pendingRefillFields(tabs.activeTab)).toHaveLength(1)

    // The reorder. Only the order changed; no value did.
    await urlBar.vm.$emit("update:url", "https://api.example.com/users?apikey=&apikey=FILLED")
    await nextTick()

    expect(pendingRefillFields(tabs.activeTab).map(identityTuple)).toEqual([
      ["refill", "query", null, "apikey"],
    ])
    expect(wrapper.find("[data-testid=\"history-redacted-banner\"]").exists()).toBe(true)

    const save = wrapper.findAll("button").find((b) => b.text().includes("request.save"))
    await save!.trigger("click")
    expect(
      (wrapper.find("[data-testid=\"request-save-submit\"]").element as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  /**
   * FALSE GATE, end to end. The other direction from everything above: once no
   * `apikey` is blank any more, the notice must go and the save must unlock.
   *
   * The release condition is "the key has no blank rows left", not "the
   * particular row history blanked got filled in". The second phrasing needs to
   * know which of two identical blank parameters is which, and a url does not
   * say — so this walks the whole way to no blanks rather than stopping at one.
   */
  it("clears the gate once no parameter of that key is blank", async () => {
    const projects = useProjectsStore()
    projects.activeProject = "My API"
    const tabs = useTabsStore()
    tabs.openHistoryEntry({
      id: "h-5",
      method: "GET",
      url: `https://api.example.com/users?apikey=${REDACTION_SENTINEL}`,
      status: 200,
      time: 10,
      size: 10,
      timestamp: "2026-03-27T10:00:00Z",
      contentType: "application/json",
      requestHeaders: [],
      requestParams: [],
      requestBodyType: "none",
      requestBodyFormData: [],
    } as HistoryEntry)

    expect(pendingRefillFields(tabs.activeTab)).toHaveLength(1)

    const wrapper = mount(RequestPanel, { global: { plugins: [pinia] } })
    await nextTick()
    const urlBar = wrapper.findComponent(UrlBar)

    // The user adds a second, empty apikey of their own. Both are blank and the
    // key was blanked, so both are reported — the accepted cost of not
    // pretending to know which row is which.
    await urlBar.vm.$emit("update:url", "https://api.example.com/users?apikey=&apikey=")
    await nextTick()
    expect(pendingRefillFields(tabs.activeTab)).toHaveLength(2)

    // Filling one still leaves an empty apikey, which is reported accurately.
    await urlBar.vm.$emit("update:url", "https://api.example.com/users?apikey=SECRET&apikey=")
    await nextTick()
    // Self-check on the step that matters: if the gate had already cleared here,
    // the final assertion would pass without the release path being exercised.
    expect(pendingRefillFields(tabs.activeTab)).toHaveLength(1)
    expect(wrapper.find("[data-testid=\"history-redacted-banner\"]").exists()).toBe(true)

    // Nothing of that key is blank now, so the gate lifts.
    await urlBar.vm.$emit("update:url", "https://api.example.com/users?apikey=SECRET&apikey=TWO")
    await nextTick()

    expect(pendingRefillFields(tabs.activeTab)).toEqual([])
    expect(wrapper.find("[data-testid=\"history-redacted-banner\"]").exists()).toBe(false)

    const save = wrapper.findAll("button").find((b) => b.text().includes("request.save"))
    await save!.trigger("click")
    expect(
      (wrapper.find("[data-testid=\"request-save-submit\"]").element as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  /**
   * A positive control, not an independently load-bearing assertion, and
   * labelled as one rather than counted twice. `needsRefill` already requires an
   * empty value, so carrying the marker forward too eagerly cannot make this go
   * red — the mutation that does is
   * "drops the marker once a value is typed in" in url-params.test.ts. What this
   * rules out is the gate getting permanently stuck, which the two tests above
   * would not notice.
   */
  it("releases the gate once the value is actually typed back in", async () => {
    const tabs = openedWithRedactedQuery()
    const wrapper = mount(RequestPanel, { global: { plugins: [pinia] } })
    await nextTick()

    await wrapper
      .findComponent(UrlBar)
      .vm.$emit("update:url", "https://api.example.com/admins?apikey=REAL&page=1")
    await nextTick()

    expect(pendingRefillFields(tabs.activeTab)).toEqual([])
  })
})
