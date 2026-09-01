// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { shallowMount, type VueWrapper } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { nextTick } from "vue"

// Partial: the store chain pulls in src/i18n/index.ts, which needs the real
// createI18n. Only the composable is replaced, so `t` is observable.
vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: (key: string) => key }),
}))

import DefaultLayout from "../layout/DefaultLayout.vue"
import RequestPanel from "../panels/RequestPanel.vue"
import { useProjectsStore } from "../../stores/projects"
import { useTabsStore } from "../../stores/tabs"
import type { CollectionNode } from "../../types"

const DIALOG = '[data-testid="request-save-modal"]'
const NAME = '[data-testid="request-save-name"]'
const COLLECTION = '[data-testid="request-save-collection"]'

/**
 * D46. The defect this file exists for: with the save dialog open and the caret
 * in its name field, Cmd+S threw the typed name away and reset the chosen
 * collection. Cmd+S reaching a field is deliberate — D25c made it the one
 * shortcut exempt from the editable guard, because the caret sits in the URL
 * field at the moment users reach for it — so the fix cannot live in the
 * keyboard layer without taking that back.
 *
 * The seam is what this file drives, and it is the seam useKeyboardListener
 * names as untested: the real window listener the app installs, and the real
 * panel that answers the event it dispatches, in one document.
 */
let pinia: ReturnType<typeof createPinia>
let layout: VueWrapper | null
let panel: VueWrapper | null
let dispatched: string[]

function record(event: Event) {
  dispatched.push(event.type)
}

beforeEach(() => {
  vi.unstubAllGlobals()
  pinia = createPinia()
  setActivePinia(pinia)
  window.localStorage.clear()
  dispatched = []
  layout = null
  panel = null
  window.addEventListener("apisolo:save-request", record)
})

afterEach(() => {
  window.removeEventListener("apisolo:save-request", record)
  panel?.unmount()
  layout?.unmount()
  document.body.innerHTML = ""
})

/**
 * Mounting `DefaultLayout` is the production wiring: it is the only caller of
 * `useKeyboard`, and its setup is what installs the window listener. Shallow,
 * so its children stay stubs — including its own RequestPanel, which is why the
 * panel below is the only one listening for the event.
 */
function installShortcut() {
  layout = shallowMount(DefaultLayout, { global: { plugins: [pinia] } })
}

function mountPanel() {
  // Attached, so the dialog's fields are elements a real KeyboardEvent can be
  // dispatched on and travel the real capture path from window.
  panel = shallowMount(RequestPanel, { attachTo: document.body, global: { plugins: [pinia] } })
  return panel
}

function pressSaveOn(target: EventTarget) {
  const event = new KeyboardEvent("keydown", {
    key: "s",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  })
  target.dispatchEvent(event)
  return event
}

function folder(name: string, path: string): CollectionNode {
  return { name, path, nodeType: "folder", children: [] } as CollectionNode
}

function withProject() {
  const projects = useProjectsStore()
  projects.activeProject = "My API"
  projects.collectionTree = [folder("Checkout", "Checkout")]
}

/**
 * The state the user is in when the defect bites: dialog open, a name typed,
 * a collection picked, caret still in the name field.
 */
async function openDialogWithDraft() {
  withProject()
  installShortcut()
  const wrapper = mountPanel()
  await nextTick()

  await wrapper.get('[data-testid="request-save"]').trigger("click")
  await wrapper.get(NAME).setValue("Create order")
  await wrapper.get(COLLECTION).setValue("Checkout")

  return wrapper
}

/**
 * P12. Every assertion below reads "the typed name is still there", and that
 * sentence is also what a harness that delivers no keystroke at all would
 * produce. So the device has to be shown saying both words first: silence when
 * nothing installs the listener, and an effect when the app does.
 */
describe("harness self-check", () => {
  it("phase 1 — a Cmd+S with no listener installed reaches nothing", () => {
    withProject()
    const wrapper = mountPanel()
    const field = document.createElement("input")
    document.body.appendChild(field)

    pressSaveOn(field)

    expect(dispatched).toEqual([])
    expect(wrapper.find(DIALOG).exists()).toBe(false)
  })

  it("phase 2 — the same keystroke opens the dialog once the app installs it", async () => {
    withProject()
    installShortcut()
    const wrapper = mountPanel()
    const field = document.createElement("input")
    document.body.appendChild(field)

    const event = pressSaveOn(field)
    await nextTick()

    expect(dispatched).toContain("apisolo:save-request")
    expect(wrapper.find(DIALOG).exists()).toBe(true)
    expect(event.defaultPrevented).toBe(true)
  })
})

/**
 * D25c's contract, driven through the same harness rather than described. The
 * repository's stated primary path is "paste a curl command and send it", which
 * leaves the caret in the URL field — the exact position a user is in when they
 * reach for Cmd+S. Phase 2 above already presses from an `<input>`; this adds
 * the field the panel actually renders, so a guard that spares "the URL bar"
 * by name and not by shape still has to answer here.
 */
describe("D25c — the shortcut still fires from a request-editing field", () => {
  it("opens the dialog from a caret sitting in a request field", async () => {
    withProject()
    installShortcut()
    const wrapper = mountPanel()
    const field = document.createElement("input")
    document.body.appendChild(field)
    field.focus()

    pressSaveOn(field)
    await nextTick()

    expect(dispatched).toContain("apisolo:save-request")
    expect(wrapper.find(DIALOG).exists()).toBe(true)
  })

  it("still says something when there is no project to save into", async () => {
    installShortcut()
    const wrapper = mountPanel()
    const field = document.createElement("input")
    document.body.appendChild(field)

    pressSaveOn(field)
    await nextTick()

    // The other half of D25c: no project is answered with a notice, not with
    // silence. A guard that made the shortcut a no-op would pass the case above
    // by opening nothing and fail here.
    expect(wrapper.find('[data-testid="request-save-needs-project"]').exists()).toBe(true)
    expect(wrapper.find(DIALOG).exists()).toBe(false)
  })
})

describe("D46 — Cmd+S inside the open dialog leaves the draft alone", () => {
  it("keeps the name the user typed", async () => {
    const wrapper = await openDialogWithDraft()
    dispatched = []

    pressSaveOn(wrapper.get(NAME).element)
    await nextTick()

    // The keystroke has to have arrived, or "the name survived" is a sentence
    // about a shortcut that did nothing.
    expect(dispatched).toContain("apisolo:save-request")
    expect((wrapper.get(NAME).element as HTMLInputElement).value).toBe("Create order")
  })

  it("keeps the collection the user picked", async () => {
    const wrapper = await openDialogWithDraft()
    dispatched = []

    pressSaveOn(wrapper.get(NAME).element)
    await nextTick()

    expect(dispatched).toContain("apisolo:save-request")
    expect((wrapper.get(COLLECTION).element as HTMLSelectElement).value).toBe("Checkout")
  })

  it("re-derives the name from the tab on a genuine close and reopen", async () => {
    // The boundary of the guard above. Skipping the initialisation is only
    // right while the dialog is on screen: a dialog opened again from scratch
    // must show this tab's name, not whatever the last draft happened to be.
    const wrapper = await openDialogWithDraft()
    const tabs = useTabsStore()

    await wrapper.get('[data-testid="request-save-modal-footer"] button').trigger("click")
    expect(wrapper.find(DIALOG).exists()).toBe(false)

    tabs.updateTab(tabs.activeTab.id, { label: "Checkout probe" })
    await nextTick()
    pressSaveOn(document.body)
    await nextTick()

    expect(wrapper.find(DIALOG).exists()).toBe(true)
    expect((wrapper.get(NAME).element as HTMLInputElement).value).toBe("Checkout probe")
  })
})
