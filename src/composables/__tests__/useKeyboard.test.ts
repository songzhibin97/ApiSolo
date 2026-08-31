import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

import { shouldIgnoreEvent, useKeyboard } from "../useKeyboard"
import { useProjectsStore } from "../../stores/projects"
import { useRequestStore } from "../../stores/request"
import { useTabsStore } from "../../stores/tabs"

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

  it("still ignores Cmd+S typed into a field", async () => {
    const { handleKeydown } = useKeyboard()
    await handleKeydown(saveEvent(makeTarget({ tagName: "INPUT" })))

    expect(dispatched).not.toContain("apisolo:save-request")
  })
})
