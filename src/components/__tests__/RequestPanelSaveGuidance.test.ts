// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { shallowMount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { nextTick } from "vue"

// Partial: the store chain pulls in src/i18n/index.ts, which needs the real
// createI18n. Only the composable is replaced, so `t` is observable.
vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: (key: string) => key }),
}))

import RequestPanel from "../panels/RequestPanel.vue"
import { useProjectsStore } from "../../stores/projects"
import { useUIStore } from "../../stores/ui"

let pinia: ReturnType<typeof createPinia>

function mountPanel() {
  return shallowMount(RequestPanel, { global: { plugins: [pinia] } })
}

const SAVE = '[data-testid="request-save"]'
const NOTICE = '[data-testid="request-save-needs-project"]'
const NOTICE_ACTION = '[data-testid="request-save-needs-project-action"]'
const DIALOG = '[data-testid="request-save-modal"]'

/**
 * With no project the app used to answer the user with nothing: the save button
 * was removed from the toolbar by `v-if`, and Cmd/Ctrl+S returned in silence.
 * The repository's own stated principle is that a project is a way to organise
 * work after the fact, not a precondition for using the app — so "you cannot
 * save yet" is a thing that has to be said, not a thing to enforce invisibly.
 */
describe("saving with no project says so instead of doing nothing", () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    window.localStorage.clear()
  })

  it("keeps the save button on screen with no project", () => {
    const wrapper = mountPanel()

    expect(useProjectsStore().activeProject).toBeNull()
    expect(wrapper.find(SAVE).exists()).toBe(true)
  })

  it("says nothing until the user actually tries to save", () => {
    // The notice answers an action. Standing there permanently would make it
    // wallpaper, and it would be on screen during the paste-a-curl-and-send
    // path that has nothing to do with saving.
    expect(mountPanel().find(NOTICE).exists()).toBe(false)
  })

  it("explains the missing project when the button is pressed", async () => {
    const wrapper = mountPanel()

    await wrapper.get(SAVE).trigger("click")

    expect(wrapper.find(NOTICE).exists()).toBe(true)
    expect(wrapper.get(NOTICE).text()).toContain("request.saveNeedsProject")
    expect(wrapper.find(DIALOG).exists()).toBe(false)
  })

  it("explains the missing project when the shortcut fires", async () => {
    // The same answer through the other door. This is the path that used to be
    // guarded twice — once in the keyboard layer, once in the panel — and
    // produced no visible effect whatsoever.
    const wrapper = mountPanel()

    window.dispatchEvent(new CustomEvent("apisolo:save-request"))
    await nextTick()

    expect(wrapper.find(NOTICE).exists()).toBe(true)
    expect(wrapper.find(DIALOG).exists()).toBe(false)
  })

  it("opens the save dialog and says nothing once a project exists", async () => {
    const wrapper = mountPanel()
    useProjectsStore().activeProject = "My API"
    await nextTick()

    await wrapper.get(SAVE).trigger("click")

    expect(wrapper.find(DIALOG).exists()).toBe(true)
    expect(wrapper.find(NOTICE).exists()).toBe(false)
  })

  it("takes the notice down as soon as a project exists", async () => {
    const wrapper = mountPanel()
    await wrapper.get(SAVE).trigger("click")
    expect(wrapper.find(NOTICE).exists()).toBe(true)

    useProjectsStore().activeProject = "My API"
    await nextTick()

    // The user creates the project in the other panel; nothing comes back here
    // to lower a flag, so the notice has to be reading the condition itself.
    expect(wrapper.find(NOTICE).exists()).toBe(false)
  })

  it("puts the collections panel on screen when the notice's action is used", async () => {
    const ui = useUIStore()
    ui.setSidebarItem("history")
    ui.sidebarCollapsed = true
    const wrapper = mountPanel()
    await wrapper.get(SAVE).trigger("click")

    await wrapper.get(NOTICE_ACTION).trigger("click")

    // Both halves: selecting the item behind a collapsed sidebar shows the user
    // nothing, and the notice's text names that panel as where to go.
    expect(ui.sidebarActiveItem).toBe("collections")
    expect(ui.sidebarCollapsed).toBe(false)
    expect(wrapper.find(NOTICE).exists()).toBe(false)
  })
})
