// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { createI18n } from "vue-i18n"
import { nextTick } from "vue"

const { invokeMock, state } = vi.hoisted(() => {
  const state = {
    projects: [] as { name: string; description: string }[],
  }

  return {
    state,
    invokeMock: vi.fn(async (command: string) => {
      if (command === "list_projects") {
        return state.projects.map((project) => ({
          ...project,
          createdAt: "2026-08-31T00:00:00Z",
          updatedAt: "2026-08-31T00:00:00Z",
        }))
      }

      if (command === "get_collection_tree") {
        return []
      }

      return null
    }),
  }
})

vi.mock("../../utils/invoke", () => ({ invoke: invokeMock }))

import DefaultLayout from "../layout/DefaultLayout.vue"
import en from "../../i18n/en"
import zhCN from "../../i18n/zh-CN"

/**
 * The two things D25c promises are things a user *sees*, and every other test in
 * this slice stops short of the screen:
 *
 * - useKeyboardListener.test.ts drives a real keystroke and watches for the
 *   `apisolo:save-request` event. It ends where the event is dispatched.
 * - RequestPanelSaveGuidance.test.ts dispatches that event by hand at a panel it
 *   mounted itself. It starts where the event arrives.
 * - CollectionPanelProject.test.ts mounts `CollectionPanel` on its own.
 *
 * None of them can see whether the panels are *in the app*. Three reviews found
 * the same shape three times — helper not called, listener not installed,
 * component not composed — because each fix moved the seam one layer up and left
 * a new one above it. Deleting `<RequestPanel>` from the layout left thirteen
 * cases green; deleting `<CollectionPanel>` left a hundred and thirty green.
 *
 * So this file mounts the layout with those panels real and asserts on rendered
 * text, which is the one place the chain cannot be extended: both ends are what
 * the user does and what the user reads, and every layer between them —
 * `DefaultLayout` → `useKeyboard` → listener → event → `RequestPanel` → notice,
 * and `DefaultLayout` → `SidebarContainer` → `CollectionPanel` → description —
 * is inside the assertion.
 *
 * Real messages rather than `t: key => key`, for the reason
 * PendingRefillWording.test.ts gives: under the stub the rendered output is the
 * key spelled out, which is the same string whether the component picked the
 * right key or not.
 *
 * **What this does not cover, stated so it is not read as more than it is.**
 *
 * 1. The children not on either chain are stubbed: `AppHeader`, `AppSidebar`,
 *    `TabBar`, `ResponsePanel`, `WSConnectionPanel`, `WSMessagePanel`,
 *    `StatusBar`, `DebugConsole`, `SettingsModal`. `RequestPanel`,
 *    `SidebarContainer` and `CollectionPanel` are real, and so is everything
 *    they render.
 * 2. One locale (zh-CN). That both locales carry the right words is
 *    locale-matrix.test.ts's job, and each source string has its own killer
 *    there; what is proved here is that the notice reaches the screen at all.
 * 3. Geometry. This is happy-dom, so it says the text is in the DOM, not that
 *    it is visible, on top, or unclipped in the packaged WebKit app.
 * 4. `DefaultLayout` is where the composition is checked. Nothing here proves
 *    `App.vue` renders `DefaultLayout`, and no test in the repository does.
 *
 * One coupling worth naming, because it shows up in the mutation ledger: the
 * project list arrives through `CollectionPanel`'s own `onMounted`, which is how
 * the running app gets it. So removing `CollectionPanel` from the composition
 * takes the save-dialog case down with the two description cases. That is the
 * app's real shape, not an artifact of this file, but it does mean the
 * save-dialog case is not a single-collapse witness for the keystroke chain —
 * the two cases above it are.
 */
const NOTICE = '[data-testid="request-save-needs-project"]'
const DIALOG = '[data-testid="request-save-modal"]'
const DESCRIPTION = '[data-testid="active-project-description"]'

// Everything the two chains do not pass through. Listed by name rather than by
// using `shallowMount`, because the point of the file is that the panels under
// test are composed for real.
const OFF_CHAIN_STUBS = {
  AppHeader: true,
  AppSidebar: true,
  TabBar: true,
  ResponsePanel: true,
  WSConnectionPanel: true,
  WSMessagePanel: true,
  StatusBar: true,
  DebugConsole: true,
  SettingsModal: true,
}

let pinia: ReturnType<typeof createPinia>
let wrapper: ReturnType<typeof mount> | null

async function settle() {
  for (let tick = 0; tick < 12; tick += 1) {
    await Promise.resolve()
  }
  await nextTick()
}

async function mountApp() {
  wrapper = mount(DefaultLayout, {
    attachTo: document.body,
    global: {
      plugins: [
        pinia,
        createI18n({
          legacy: false,
          locale: "zh-CN",
          fallbackLocale: "en",
          messages: { "zh-CN": zhCN, en },
        }),
      ],
      stubs: OFF_CHAIN_STUBS,
    },
  })
  await settle()
  return wrapper
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

describe("the whole app, from a keystroke to the words on screen", () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    invokeMock.mockClear()
    window.localStorage.clear()
    wrapper = null
    state.projects = []
  })

  afterEach(() => {
    wrapper?.unmount()
    document.body.innerHTML = ""
  })

  it("answers a real Cmd+S with no project by explaining why on screen", async () => {
    const app = await mountApp()
    expect(app.find(NOTICE).exists()).toBe(false)

    press({ key: "s", metaKey: true })
    await settle()

    expect(app.get(NOTICE).text()).toContain(zhCN.request.saveNeedsProject)
    expect(app.find(DIALOG).exists()).toBe(false)
  })

  it("answers a real Cmd+S typed into a field the same way", async () => {
    // The paste-a-curl path leaves the caret in the URL field, and the guard
    // exemption for Cmd+S is what carries it. Dispatched on a real element, so
    // the event has a real target.
    const app = await mountApp()
    const field = document.createElement("input")
    document.body.appendChild(field)

    press({ key: "s", metaKey: true }, field)
    await settle()

    expect(app.get(NOTICE).text()).toContain(zhCN.request.saveNeedsProject)
  })

  it("answers a real Cmd+S with a project by opening the save dialog", async () => {
    // The other half of the same decision, and what makes the negative
    // assertion above mean something: the keystroke arrives either way, and the
    // panel is what decides which answer the user gets.
    state.projects = [{ name: "Alpha", description: "The staging gateway" }]
    const app = await mountApp()

    press({ key: "s", metaKey: true })
    await settle()

    expect(app.find(DIALOG).exists()).toBe(true)
    expect(app.find(NOTICE).exists()).toBe(false)
  })

  it("leaves a plain s alone", async () => {
    const app = await mountApp()

    press({ key: "s" })
    await settle()

    expect(app.find(NOTICE).exists()).toBe(false)
  })

  it("puts the active project's description on screen through the sidebar", async () => {
    state.projects = [
      { name: "Alpha", description: "The staging gateway" },
      { name: "Beta", description: "" },
    ]

    const app = await mountApp()

    expect(app.get(DESCRIPTION).text()).toBe("The staging gateway")
  })

  it("says a project has no description rather than showing a blank line", async () => {
    state.projects = [{ name: "Beta", description: "" }]

    const app = await mountApp()

    expect(app.get(DESCRIPTION).text()).toBe(zhCN.sidebar.noProjectDescription)
  })
})
