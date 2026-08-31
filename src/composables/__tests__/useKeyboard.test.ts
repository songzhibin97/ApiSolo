import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

import { shouldIgnoreEvent, useKeyboard } from "../useKeyboard"
import { useProjectsStore } from "../../stores/projects"
import { useRequestStore } from "../../stores/request"
import { useTabsStore } from "../../stores/tabs"
import { useUIStore } from "../../stores/ui"

function makeTarget(overrides: Partial<{
  tagName: string
  isContentEditable: boolean
  closest: (selector: string) => unknown
}> = {}) {
  return {
    tagName: "DIV",
    isContentEditable: false,
    closest: () => null,
    ...overrides,
  }
}

function makeEvent(target: ReturnType<typeof makeTarget>) {
  return { target } as unknown as Pick<KeyboardEvent, "target">
}

describe("shouldIgnoreEvent", () => {
  it("ignores native form controls", () => {
    expect(shouldIgnoreEvent(makeEvent(makeTarget({ tagName: "INPUT" })))).toBe(true)
    expect(shouldIgnoreEvent(makeEvent(makeTarget({ tagName: "TEXTAREA" })))).toBe(true)
    expect(shouldIgnoreEvent(makeEvent(makeTarget({ tagName: "SELECT" })))).toBe(true)
  })

  it("ignores contenteditable and CodeMirror targets", () => {
    expect(shouldIgnoreEvent(makeEvent(makeTarget({ isContentEditable: true })))).toBe(true)
    expect(
      shouldIgnoreEvent({
        target: makeTarget({
          closest: (selector) => (selector === ".cm-editor" ? {} : null),
        }),
      } as unknown as Pick<KeyboardEvent, "target">),
    ).toBe(true)
  })

  it("allows shortcuts outside editables", () => {
    expect(shouldIgnoreEvent(makeEvent(makeTarget()))).toBe(false)
  })
})

describe("Cmd/Ctrl+Enter routing", () => {
  let dispatched: string[]

  function keyEvent(target = makeTarget()) {
    return {
      key: "Enter",
      metaKey: true,
      ctrlKey: false,
      target,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    dispatched = []
    vi.stubGlobal("window", {
      dispatchEvent: (event: { type: string }) => {
        dispatched.push(event.type)
        return true
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    vi.stubGlobal(
      "CustomEvent",
      class CustomEventMock {
        constructor(public type: string) {}
      },
    )
  })

  it("sends the ws draft instead of an http request on a websocket tab", async () => {
    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    const sendRequest = vi.spyOn(requestStore, "sendRequest").mockResolvedValue(undefined as never)

    const wsTab = tabsStore.addWsTab()
    tabsStore.setActiveTab(wsTab.id)
    tabsStore.updateTab(wsTab.id, { url: "wss://example.test/socket" })

    const { handleKeydown } = useKeyboard()
    dispatched = []
    await handleKeydown(keyEvent())

    // Membership, not exact equality: addTab schedules an unrelated
    // "apisolo:focus-url" on nextTick, which the await above flushes.
    expect(dispatched).toContain("apisolo:ws-send")
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it("still sends an http request on an http tab", async () => {
    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    const sendRequest = vi.spyOn(requestStore, "sendRequest").mockResolvedValue(undefined as never)

    const httpTab = tabsStore.tabs[0]
    tabsStore.setActiveTab(httpTab.id)
    // No in-flight request: sendRequest bails out early on a loading tab, which
    // would make this pass for the wrong reason.
    tabsStore.updateTab(httpTab.id, { url: "https://example.test/api", isLoading: false })

    const { handleKeydown } = useKeyboard()
    dispatched = []
    await handleKeydown(keyEvent())

    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(dispatched).not.toContain("apisolo:ws-send")
  })

  it("ignores Cmd+Enter fired from a textarea", async () => {
    const tabsStore = useTabsStore()
    const requestStore = useRequestStore()
    const sendRequest = vi.spyOn(requestStore, "sendRequest").mockResolvedValue(undefined as never)

    const httpTab = tabsStore.tabs[0]
    tabsStore.setActiveTab(httpTab.id)
    tabsStore.updateTab(httpTab.id, { url: "https://example.test/api" })

    const { handleKeydown } = useKeyboard()
    dispatched = []
    await handleKeydown(keyEvent(makeTarget({ tagName: "TEXTAREA" })))

    expect(sendRequest).not.toHaveBeenCalled()
    expect(dispatched).not.toContain("apisolo:ws-send")
  })
})

// Branch coverage only: these call `handleKeydown` directly, so not one of them
// can tell whether anything installs it as a listener. That half lives in
// useKeyboardListener.test.ts, which dispatches real keyboard events at the
// mounted app and never touches `handleKeydown`.
describe("Cmd/Ctrl+S routing", () => {
  let dispatched: string[]

  function saveEvent(target = makeTarget()) {
    return {
      key: "s",
      metaKey: true,
      ctrlKey: false,
      target,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    dispatched = []
    vi.stubGlobal("window", {
      dispatchEvent: (event: { type: string }) => {
        dispatched.push(event.type)
        return true
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    vi.stubGlobal(
      "CustomEvent",
      class CustomEventMock {
        constructor(public type: string) {}
      },
    )
  })

  it("hands the shortcut to the panel even with no project selected", async () => {
    // This layer used to check `activeProject` itself and drop the keystroke.
    // Nothing here can render a reason to the user, so a decision taken here is
    // a decision the user cannot be told about; the panel owns it now.
    expect(useProjectsStore().activeProject).toBeNull()

    const { handleKeydown } = useKeyboard()
    await handleKeydown(saveEvent())

    expect(dispatched).toContain("apisolo:save-request")
  })

  it("hands the shortcut to the panel when a project is selected", async () => {
    useProjectsStore().activeProject = "My API"

    const { handleKeydown } = useKeyboard()
    await handleKeydown(saveEvent())

    expect(dispatched).toContain("apisolo:save-request")
  })

  // The editable guard used to run first, so a caret inside any text field
  // swallowed this shortcut. That is not an edge case here: the repository's
  // stated primary path is "paste a curl command and send it", which leaves the
  // caret in the URL field — the exact position a user is in when they reach
  // for Cmd+S. A shortcut that works everywhere except where the user is
  // standing is a shortcut that does not work.
  it.each([
    ["an input", makeTarget({ tagName: "INPUT" })],
    ["a textarea", makeTarget({ tagName: "TEXTAREA" })],
    ["a contenteditable region", makeTarget({ isContentEditable: true })],
    [
      "the CodeMirror body editor",
      makeTarget({ closest: (selector: string) => (selector === ".cm-editor" ? {} : null) }),
    ],
  ])("reaches the panel from %s", async (_label, target) => {
    const { handleKeydown } = useKeyboard()
    await handleKeydown(saveEvent(target))

    expect(dispatched).toContain("apisolo:save-request")
  })

  it("takes the keystroke away from the field it was typed in", async () => {
    // Without this the browser's own save dialog answers instead. It is a
    // separate fact from the dispatch above: letting the event through and
    // preventing its default are two different things.
    const { handleKeydown } = useKeyboard()
    const event = saveEvent(makeTarget({ tagName: "INPUT" }))

    await handleKeydown(event)

    expect(event.preventDefault).toHaveBeenCalled()
  })

  it("does not let the other shortcuts through a field", async () => {
    // The boundary, and the reason the exemption above is written per key
    // rather than as "shortcuts ignore focus". Cmd+S is exempt because it has
    // no native meaning inside a text field; Cmd+A and Cmd+C do, and this
    // layer must not start competing with them. Every key with a branch of its
    // own is driven here, so widening the exemption cannot stay quiet.
    const tabsStore = useTabsStore()
    const uiStore = useUIStore()
    uiStore.setSidebarItem("environments")
    const tabCount = tabsStore.tabs.length

    const { handleKeydown } = useKeyboard()
    for (const key of ["Enter", "n", "t", "w", "k", ",", "1"]) {
      await handleKeydown({
        key,
        metaKey: true,
        ctrlKey: false,
        target: makeTarget({ tagName: "INPUT" }),
        preventDefault: vi.fn(),
      } as unknown as KeyboardEvent)
    }

    expect(dispatched).toEqual([])
    expect(tabsStore.tabs.length).toBe(tabCount)
    expect(uiStore.isSettingsOpen).toBe(false)
    expect(uiStore.sidebarActiveItem).toBe("environments")
  })
})
