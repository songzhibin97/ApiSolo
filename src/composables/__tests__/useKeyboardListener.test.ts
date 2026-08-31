// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { shallowMount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"

import DefaultLayout from "../../components/layout/DefaultLayout.vue"

/**
 * A separate file from useKeyboard.test.ts, and the environment is why: the
 * cases there replace `window` with a stub object, which this file cannot live
 * with — it needs a real window, a real `KeyboardEvent` and a real element to
 * type into.
 *
 * It needs them because every case over there hands `handleKeydown` an object
 * built by hand. That proves the branch and says nothing about the branch being
 * reached: delete `window.addEventListener("keydown", ...)` from the
 * composable, or stop `DefaultLayout` from calling `useKeyboard` at all, and
 * all of them stay green while the shortcut does nothing whatsoever in the
 * running app. Nothing below reaches for `handleKeydown`.
 *
 * Where this stops: the app answers a keystroke by dispatching
 * `apisolo:save-request`, and `RequestPanel` is what listens for it. Driving
 * both halves in one mount means rendering the whole layout for real; the panel
 * end is covered by RequestPanelSaveGuidance, which fires that same event and
 * asserts the notice appears. The seam between them is not driven by any test.
 */
describe("Cmd/Ctrl+S arrives through the listener the app installs", () => {
  let pinia: ReturnType<typeof createPinia>
  let dispatched: string[]
  let wrapper: ReturnType<typeof shallowMount> | null

  function record(event: Event) {
    dispatched.push(event.type)
  }

  beforeEach(() => {
    vi.unstubAllGlobals()
    pinia = createPinia()
    setActivePinia(pinia)
    dispatched = []
    wrapper = null
    window.addEventListener("apisolo:save-request", record)
    window.addEventListener("apisolo:focus-url", record)
  })

  afterEach(() => {
    window.removeEventListener("apisolo:save-request", record)
    window.removeEventListener("apisolo:focus-url", record)
    wrapper?.unmount()
    document.body.innerHTML = ""
  })

  // The production wiring itself: `DefaultLayout` is the only caller of
  // `useKeyboard`, and mounting it is what installs the listener. Shallow, so
  // the layout's children stay stubs — the listener goes on in setup and does
  // not depend on any of them.
  function mountApp() {
    wrapper = shallowMount(DefaultLayout, { global: { plugins: [pinia] } })
  }

  function press(init: KeyboardEventInit, on: EventTarget = window) {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    })
    on.dispatchEvent(event)
    return event
  }

  function typeInto(init: KeyboardEventInit) {
    const field = document.createElement("input")
    document.body.appendChild(field)
    return press(init, field)
  }

  it("hands a real Cmd+S keystroke to the panel", () => {
    mountApp()

    const event = press({ key: "s", metaKey: true })

    expect(dispatched).toContain("apisolo:save-request")
    // The browser's own save dialog answers otherwise. Letting the event
    // through and preventing its default are two different facts.
    expect(event.defaultPrevented).toBe(true)
  })

  it("hands a real Ctrl+S keystroke to the panel", () => {
    mountApp()

    press({ key: "s", ctrlKey: true })

    expect(dispatched).toContain("apisolo:save-request")
  })

  it("leaves a plain s alone", () => {
    // The modifier gate, which no case that presets `metaKey: true` can see.
    // Without it every letter s typed into the URL field opens the save dialog.
    mountApp()

    const event = typeInto({ key: "s" })

    expect(dispatched).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })

  it("hands over a Cmd+S typed into a real input", () => {
    // The repository's stated primary path is "paste a curl command and send
    // it", which leaves the caret in the URL field — the exact position a user
    // is in when they reach for Cmd+S. Dispatched on the element, so the event
    // has a real target and travels the real capture path.
    mountApp()

    const event = typeInto({ key: "s", metaKey: true })

    expect(dispatched).toContain("apisolo:save-request")
    expect(event.defaultPrevented).toBe(true)
  })

  it("still lets a field keep the shortcuts that are not Cmd+S", () => {
    // The boundary. Cmd+S is exempt from the editable guard because it has no
    // native meaning inside a text field; the guard itself has to survive, or
    // this composable starts competing with text editing.
    mountApp()

    typeInto({ key: "k", metaKey: true })

    expect(dispatched).toEqual([])
  })

  it("stops answering once the app is unmounted", () => {
    // Pairs with the first case: if something other than this listener were
    // producing the event, unmounting would not stop it.
    mountApp()
    press({ key: "s", metaKey: true })
    expect(dispatched).toEqual(["apisolo:save-request"])

    wrapper?.unmount()
    wrapper = null
    press({ key: "s", metaKey: true })

    expect(dispatched).toEqual(["apisolo:save-request"])
  })
})
