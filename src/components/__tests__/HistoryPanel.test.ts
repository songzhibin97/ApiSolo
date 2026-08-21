// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock("../../utils/invoke", () => ({ invoke: invokeMock }))

const tMock = vi.fn((key: string, _params?: Record<string, unknown>) => key)

// Partial: the store chain pulls in src/i18n/index.ts, which needs the real
// createI18n. Only the composable is replaced, so `t` is observable.
vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: tMock, locale: { value: "en" } }),
}))

import HistoryPanel from "../sidebar/HistoryPanel.vue"
import ConfirmDialog from "../ui/ConfirmDialog.vue"
import { useHistoryStore } from "../../stores/history"
import { useProjectsStore } from "../../stores/projects"
import { useTabsStore } from "../../stores/tabs"
import type { CollectionNode, HistoryEntry } from "../../types"

let pinia: ReturnType<typeof createPinia>

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "h-1",
    method: "GET",
    url: "https://api.example.com/users",
    status: 200,
    time: 12,
    size: 30,
    timestamp: "2026-03-27T10:00:00Z",
    contentType: "application/json",
    requestHeaders: [],
    requestParams: [],
    requestBodyType: "none",
    requestBodyFormData: [],
    ...overrides,
  } as HistoryEntry
}

type Health = { skippedLines: number; quarantinedLines: number }

function stubBackend(options: { health?: Health; tree?: CollectionNode[] } = {}) {
  const health = options.health ?? { skippedLines: 0, quarantinedLines: 0 }

  invokeMock.mockImplementation(async (command: string) => {
    if (command === "get_history_health") {
      return health
    }
    if (command === "load_history") {
      return []
    }
    if (command === "get_collection_tree") {
      return options.tree ?? []
    }
    return undefined
  })
}

async function mountPanel(entries: HistoryEntry[] = []) {
  const history = useHistoryStore()
  history.entries = entries

  const wrapper = mount(HistoryPanel, { global: { plugins: [pinia] } })
  // The mount hook loads history and then the health counts; both are awaited
  // before anything asserts on what the panel decided from them.
  await flushPromises()
  return wrapper
}

function rows(wrapper: Awaited<ReturnType<typeof mountPanel>>, testid: string) {
  return wrapper.findAll(`[data-testid="${testid}"]`)
}

/**
 * Two confirm dialogs live in this template. Picking by index alone would
 * silently assert against the wrong one if the template order changed, so the
 * pick is self-checked against the title it was given.
 */
function clearDialog(wrapper: Awaited<ReturnType<typeof mountPanel>>) {
  const dialogs = wrapper.findAllComponents(ConfirmDialog)
  const found = dialogs.find((dialog) => dialog.props("title") === "history.clearHistory")
  expect(found, "the clear-history dialog is not in the template").toBeDefined()
  return found!
}

function deleteDialog(wrapper: Awaited<ReturnType<typeof mountPanel>>) {
  const dialogs = wrapper.findAllComponents(ConfirmDialog)
  const found = dialogs.find((dialog) => dialog.props("title") === "history.deleteEntry")
  expect(found, "the delete-entry dialog is not in the template").toBeDefined()
  return found!
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  invokeMock.mockReset()
  tMock.mockClear()
  stubBackend()
})

// PROCESS.md P12 / TECH 4.2: the harness has to be shown able to say both words
// before its silence counts for anything.
describe("harness self-check", () => {
  it("phase 1 — a correct existence assertion passes", async () => {
    const wrapper = await mountPanel([entry()])

    expect(rows(wrapper, "history-row")).toHaveLength(1)
  })

  it("phase 2 — the same assertion made wrong fails on the value", async () => {
    const wrapper = await mountPanel([entry()])

    const count = rows(wrapper, "history-row").length
    expect(() => expect(count).toBe(99)).toThrow(/99/)
  })
})

describe("§1/§18 every row offers both new actions", () => {
  const three = [
    entry({ id: "a", url: "https://api.example.com/a" }),
    entry({ id: "b", url: "https://api.example.com/b" }),
    entry({ id: "c", url: "https://api.example.com/c" }),
  ]

  it("§1 renders one save button per entry", async () => {
    const projects = useProjectsStore()
    projects.activeProject = "My API"

    const wrapper = await mountPanel(three)

    expect(rows(wrapper, "history-save")).toHaveLength(3)
  })

  it("§18 renders one delete button per entry", async () => {
    const wrapper = await mountPanel(three)

    expect(rows(wrapper, "history-delete")).toHaveLength(3)
  })

  it("§1 opening the save dialog leaves the tabs alone", async () => {
    const projects = useProjectsStore()
    projects.activeProject = "My API"
    const tabs = useTabsStore()
    const addTab = vi.spyOn(tabs, "addTab")
    const activeBefore = tabs.activeTabId

    const wrapper = await mountPanel(three)
    await rows(wrapper, "history-save")[0].trigger("click")

    expect(addTab).not.toHaveBeenCalled()
    expect(tabs.activeTabId).toBe(activeBefore)
  })
})

describe("§2 without a project there is nowhere to save to, and it says so", () => {
  it("disables the save button", async () => {
    const wrapper = await mountPanel([entry()])

    const save = rows(wrapper, "history-save")[0]
    expect((save.element as HTMLButtonElement).disabled).toBe(true)
  })

  it("explains why", async () => {
    const wrapper = await mountPanel([entry()])

    expect(wrapper.find("[data-testid=\"history-save-needs-project\"]").exists()).toBe(true)
  })

  it("drops the explanation once a project is active", async () => {
    const projects = useProjectsStore()
    projects.activeProject = "My API"

    const wrapper = await mountPanel([entry()])

    expect(wrapper.find("[data-testid=\"history-save-needs-project\"]").exists()).toBe(false)
    expect((rows(wrapper, "history-save")[0].element as HTMLButtonElement).disabled).toBe(false)
  })
})

describe("§5/§15 saving from history changes the collection and nothing else", () => {
  const saved: CollectionNode = {
    name: "GET users",
    path: "get-users.request.json",
    nodeType: "request",
    children: [],
  }

  /**
   * Hands back the stores it used rather than letting the caller look them up
   * again. `useProjectsStore()` called after the mount does not reliably return
   * the instance the component was talking to, and a test asserting against a
   * freshly created store asserts nothing.
   */
  async function saveFirstRow() {
    const projects = useProjectsStore()
    const history = useHistoryStore()
    projects.activeProject = "My API"
    const wrapper = await mountPanel([entry({ id: "a" })])

    await rows(wrapper, "history-save")[0].trigger("click")
    await wrapper.vm.$nextTick()

    const submit = wrapper.find("[data-testid=\"save-from-history-submit\"]")
    expect(submit.exists(), "the save dialog did not open").toBe(true)
    await submit.trigger("click")
    await flushPromises()

    return { wrapper, projects, history }
  }

  it("asks the backend to write the request into the chosen collection", async () => {
    await saveFirstRow()

    const call = invokeMock.mock.calls.find(([command]) => command === "save_request")
    expect(call, "save_request was never called").toBeDefined()
    expect((call![1] as { collection: string }).collection).toBe("")
    expect((call![1] as { request: { name: string } }).request.name).toBe("GET users")
  })

  it("leaves the request visible in the collection tree afterwards", async () => {
    stubBackend({ tree: [saved] })

    const { projects } = await saveFirstRow()

    expect(projects.collectionTree.map((node) => node.path)).toContain("get-users.request.json")
  })

  it("opens no tab and leaves the current one byte for byte the same", async () => {
    const tabs = useTabsStore()
    const addTab = vi.spyOn(tabs, "addTab")
    const before = JSON.stringify(tabs.activeTab)

    await saveFirstRow()

    expect(addTab).not.toHaveBeenCalled()
    expect(JSON.stringify(tabs.activeTab)).toBe(before)
  })

  it("§15 leaves the history entry itself untouched", async () => {
    const expected = JSON.stringify([entry({ id: "a" })])

    const { history } = await saveFirstRow()

    expect(JSON.stringify(history.entries)).toBe(expected)
  })
})

describe("§19/§21 deleting one row asks first and names the row", () => {
  it("§19 puts the method and the url in the confirmation", async () => {
    const wrapper = await mountPanel([entry({ id: "a", method: "DELETE" })])

    await rows(wrapper, "history-delete")[0].trigger("click")
    await wrapper.vm.$nextTick()

    expect(deleteDialog(wrapper).props("visible")).toBe(true)
    expect(tMock).toHaveBeenCalledWith("history.deleteConfirm", {
      method: "DELETE",
      url: "https://api.example.com/users",
    })
  })

  it("§21 removes only that row once confirmed", async () => {
    const wrapper = await mountPanel([
      entry({ id: "a", url: "https://api.example.com/a" }),
      entry({ id: "b", url: "https://api.example.com/b" }),
    ])

    await rows(wrapper, "history-delete")[0].trigger("click")
    await wrapper.vm.$nextTick()
    await deleteDialog(wrapper).vm.$emit("confirm")
    await flushPromises()

    const history = useHistoryStore()
    expect(history.entries.map((item) => item.id)).toEqual(["b"])
    expect(invokeMock).toHaveBeenCalledWith("delete_history_entry", { id: "a" })
  })
})

describe("§20 a collapsed group stays collapsed across a delete", () => {
  it("keeps the collapsed group closed and the other one open", async () => {
    const wrapper = await mountPanel([
      entry({ id: "a", url: "https://api.example.com/users/1" }),
      entry({ id: "b", url: "https://api.example.com/users/2" }),
      entry({ id: "c", url: "https://api.example.com/orders/1" }),
    ])
    const history = useHistoryStore()
    history.setPrefixDepth(1)
    await wrapper.vm.$nextTick()

    // Collapse the first group. Its rows stop rendering, which is how collapse
    // is observable at all.
    const groupHeaders = wrapper.findAll("section > div > div > div > button")
    await groupHeaders[0].trigger("click")
    await wrapper.vm.$nextTick()
    const collapsedBefore = rows(wrapper, "history-row").length

    await rows(wrapper, "history-delete")[0].trigger("click")
    await wrapper.vm.$nextTick()
    await deleteDialog(wrapper).vm.$emit("confirm")
    await flushPromises()

    // One row gone, and the collapsed group did not spring open.
    expect(rows(wrapper, "history-row")).toHaveLength(collapsedBefore - 1)
  })
})

describe("§22 the row actions are not the row", () => {
  async function panelWithSpy() {
    const projects = useProjectsStore()
    projects.activeProject = "My API"
    const tabs = useTabsStore()
    const openHistoryEntry = vi.spyOn(tabs, "openHistoryEntry")
    const wrapper = await mountPanel([entry({ id: "a" })])
    openHistoryEntry.mockClear()
    return { wrapper, openHistoryEntry }
  }

  it("clicking delete does not also open the entry", async () => {
    const { wrapper, openHistoryEntry } = await panelWithSpy()

    await rows(wrapper, "history-delete")[0].trigger("click")

    expect(openHistoryEntry).not.toHaveBeenCalled()
  })

  it("clicking save does not also open the entry", async () => {
    const { wrapper, openHistoryEntry } = await panelWithSpy()

    await rows(wrapper, "history-save")[0].trigger("click")

    expect(openHistoryEntry).not.toHaveBeenCalled()
  })

  it("clicking the note or the star does not also open the entry", async () => {
    const { wrapper, openHistoryEntry } = await panelWithSpy()

    await rows(wrapper, "history-note")[0].trigger("click")
    await rows(wrapper, "history-star")[0].trigger("click")

    expect(openHistoryEntry).not.toHaveBeenCalled()
  })

  it("the row itself still opens the entry", async () => {
    const { wrapper, openHistoryEntry } = await panelWithSpy()

    await rows(wrapper, "history-open")[0].trigger("click")

    expect(openHistoryEntry).toHaveBeenCalledTimes(1)
  })
})

describe("§23/§24/§25/§26 the health of the file is read, shown, and re-read", () => {
  it("§23 reads the health counts when the panel mounts", async () => {
    await mountPanel([entry()])

    const calls = invokeMock.mock.calls.filter(([command]) => command === "get_history_health")
    expect(calls).toHaveLength(1)
  })

  it("§24 shows nothing when every line parsed", async () => {
    const wrapper = await mountPanel([entry()])

    expect(wrapper.find("[data-testid=\"history-health-notice\"]").exists()).toBe(false)
  })

  it("§24 says how many lines could not be read", async () => {
    stubBackend({ health: { skippedLines: 3, quarantinedLines: 0 } })

    const wrapper = await mountPanel([])

    expect(wrapper.find("[data-testid=\"history-health-notice\"]").exists()).toBe(true)
    expect(tMock).toHaveBeenCalledWith("history.healthBadRows", { count: 3 })
  })

  // The escape hatch. With every line unreadable the list is empty, and a clear
  // button disabled on "no entries" leaves the user unable to look or to clean up.
  it("§25 leaves clearing available for a file with nothing readable in it", async () => {
    stubBackend({ health: { skippedLines: 3, quarantinedLines: 0 } })

    const wrapper = await mountPanel([])

    const clear = wrapper.find("[data-testid=\"history-clear\"]")
    expect((clear.element as HTMLButtonElement).disabled).toBe(false)
  })

  it("§25 and actually opens the dialog, rather than looking clickable", async () => {
    stubBackend({ health: { skippedLines: 3, quarantinedLines: 0 } })
    const wrapper = await mountPanel([])
    expect(clearDialog(wrapper).props("visible")).toBe(false)

    await wrapper.find("[data-testid=\"history-clear\"]").trigger("click")
    await wrapper.vm.$nextTick()

    expect(clearDialog(wrapper).props("visible")).toBe(true)
  })

  it("§25 still refuses when there is genuinely nothing to delete", async () => {
    const wrapper = await mountPanel([])

    const clear = wrapper.find("[data-testid=\"history-clear\"]")
    expect((clear.element as HTMLButtonElement).disabled).toBe(true)
  })

  it("§26 stops claiming there are bad lines once the file is empty", async () => {
    let skipped = 3
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_history_health") {
        return { skippedLines: skipped, quarantinedLines: 0 }
      }
      if (command === "clear_history") {
        skipped = 0
        return undefined
      }
      if (command === "load_history") {
        return []
      }
      return undefined
    })

    const wrapper = await mountPanel([])
    expect(wrapper.find("[data-testid=\"history-health-notice\"]").exists()).toBe(true)

    await wrapper.find("[data-testid=\"history-clear\"]").trigger("click")
    await wrapper.vm.$nextTick()
    await clearDialog(wrapper).vm.$emit("confirm")
    await flushPromises()

    expect(
      invokeMock.mock.calls.filter(([command]) => command === "get_history_health"),
    ).toHaveLength(2)
    expect(wrapper.find("[data-testid=\"history-health-notice\"]").exists()).toBe(false)
    expect(
      (wrapper.find("[data-testid=\"history-clear\"]").element as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})

describe("§48/§49 the clear confirmation counts what it is about to delete", () => {
  it("§48 counts the rows on the list plus the lines that would not parse", async () => {
    stubBackend({ health: { skippedLines: 2, quarantinedLines: 0 } })

    await mountPanel([entry({ id: "a" }), entry({ id: "b", url: "https://api.example.com/b" })])

    expect(tMock).toHaveBeenCalledWith("history.clearConfirm", { count: 4 })
  })

  it("§48 says three, not zero, for a file with three bad lines and nothing else", async () => {
    stubBackend({ health: { skippedLines: 3, quarantinedLines: 0 } })

    await mountPanel([])

    // The first render happens before the health counts come back, so what
    // matters is the count standing once they have: that is the number on
    // screen when the confirmation is read.
    const counts = tMock.mock.calls
      .filter(([key]) => key === "history.clearConfirm")
      .map(([, params]) => (params as { count: number }).count)
    expect(counts.length).toBeGreaterThan(0)
    expect(counts[counts.length - 1]).toBe(3)
  })

  it("§48 warns that starred entries go too, and how many", async () => {
    await mountPanel([
      entry({ id: "a", starred: true }),
      entry({ id: "b", url: "https://api.example.com/b", starred: true }),
      entry({ id: "c", url: "https://api.example.com/c" }),
    ])

    expect(tMock).toHaveBeenCalledWith("history.clearWithStarred", { starred: 2 })
  })

  it("§49 says nothing about starred entries when there are none", async () => {
    await mountPanel([entry({ id: "a" })])

    expect(tMock).not.toHaveBeenCalledWith("history.clearWithStarred", expect.anything())
  })
})

describe("§31/§36/§38 notes are offered on every row and shown when present", () => {
  it("§31 offers a note on a row that never got a response", async () => {
    const wrapper = await mountPanel([entry({ id: "a", status: 0 })])

    expect(rows(wrapper, "history-note")).toHaveLength(1)
  })

  it("§31 offers a note on a row that is already starred", async () => {
    const wrapper = await mountPanel([entry({ id: "a", starred: true })])

    expect(rows(wrapper, "history-note")).toHaveLength(1)
  })

  it("§36 marks a row that has a note", async () => {
    const wrapper = await mountPanel([entry({ id: "a", note: "the flaky one" })])

    expect(rows(wrapper, "history-note-badge")).toHaveLength(1)
  })

  it("§36 leaves a row without a note unmarked", async () => {
    const wrapper = await mountPanel([entry({ id: "a" })])

    expect(rows(wrapper, "history-note-badge")).toHaveLength(0)
  })

  it("writes the text from the note editor through the store", async () => {
    const wrapper = await mountPanel([entry({ id: "a" })])

    await rows(wrapper, "history-note")[0].trigger("click")
    await wrapper.vm.$nextTick()
    await wrapper.find("[data-testid=\"history-note-input\"]").setValue("worth keeping")
    await wrapper.find("[data-testid=\"history-note-submit\"]").trigger("click")
    await flushPromises()

    expect(invokeMock).toHaveBeenCalledWith("set_history_annotation", {
      id: "a",
      note: "worth keeping",
    })
    expect(rows(wrapper, "history-note-badge")).toHaveLength(1)
  })

  // An empty note is how a note is removed, so this editor cannot borrow the
  // "no blank submissions" rule the rename prompt uses.
  it("§38 clears the note, and the marker goes with it", async () => {
    const wrapper = await mountPanel([entry({ id: "a", note: "temporary" })])
    expect(rows(wrapper, "history-note-badge")).toHaveLength(1)

    await rows(wrapper, "history-note")[0].trigger("click")
    await wrapper.vm.$nextTick()
    await wrapper.find("[data-testid=\"history-note-input\"]").setValue("")
    await wrapper.find("[data-testid=\"history-note-submit\"]").trigger("click")
    await flushPromises()

    expect(invokeMock).toHaveBeenCalledWith("set_history_annotation", { id: "a", note: "" })
    expect(rows(wrapper, "history-note-badge")).toHaveLength(0)
  })
})

describe("§39/§42 stars can be toggled from the row and filtered on", () => {
  it("writes the star through the store when the row's star is clicked", async () => {
    const wrapper = await mountPanel([entry({ id: "a" })])

    await rows(wrapper, "history-star")[0].trigger("click")
    await flushPromises()

    expect(invokeMock).toHaveBeenCalledWith("set_history_annotation", { id: "a", starred: true })
  })

  it("§42 narrows the list to starred rows when the filter is switched on", async () => {
    const wrapper = await mountPanel([
      entry({ id: "a", url: "https://api.example.com/a" }),
      entry({ id: "b", url: "https://api.example.com/b", starred: true }),
    ])
    expect(rows(wrapper, "history-row")).toHaveLength(2)

    await wrapper.find("[data-testid=\"starred-only\"]").setValue(true)
    await wrapper.vm.$nextTick()

    expect(rows(wrapper, "history-row")).toHaveLength(1)
  })
})
