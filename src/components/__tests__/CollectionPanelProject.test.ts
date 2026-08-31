// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"

const { t } = vi.hoisted(() => ({
  t: vi.fn((key: string, _params?: Record<string, unknown>) => key),
}))

// Partial: the store chain pulls in src/i18n/index.ts, which needs the real
// createI18n. Only the composable is replaced, so `t` is observable.
vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t }),
}))

const { invokeMock, state } = vi.hoisted(() => {
  const state = {
    projects: [] as { name: string; description: string }[],
  }

  return {
    state,
    invokeMock: vi.fn(async (command: string, args?: Record<string, unknown>) => {
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

      if (command === "update_project_description") {
        // The backend rewrites the file and the next list_projects reflects it.
        // Modelling that is the point: a UI that invokes the command and never
        // re-reads the list would show the old text until the app restarts.
        const target = state.projects.find((project) => project.name === args?.project)
        if (target) {
          target.description = String(args?.description ?? "").trim()
        }
        return {
          ...target,
          createdAt: "2026-08-31T00:00:00Z",
          updatedAt: "2026-08-31T00:01:00Z",
        }
      }

      return null
    }),
  }
})

vi.mock("../../utils/invoke", () => ({ invoke: invokeMock }))

import CollectionPanel from "../sidebar/CollectionPanel.vue"
import { useProjectsStore } from "../../stores/projects"

let pinia: ReturnType<typeof createPinia>

async function settle() {
  for (let tick = 0; tick < 12; tick += 1) {
    await Promise.resolve()
  }
}

async function mountPanel() {
  const wrapper = mount(CollectionPanel, { global: { plugins: [pinia] } })
  await settle()
  return wrapper
}

describe("the project description is on screen and can be changed", () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    invokeMock.mockClear()
    window.localStorage.clear()
    state.projects = [
      { name: "Alpha", description: "The staging gateway" },
      { name: "Beta", description: "" },
    ]
  })

  it("renders the active project's description", async () => {
    const wrapper = await mountPanel()

    expect(wrapper.get('[data-testid="active-project-description"]').text()).toBe(
      "The staging gateway",
    )
  })

  it("says the description is empty rather than showing a blank line", async () => {
    const wrapper = await mountPanel()
    await useProjectsStore().setActiveProject("Beta")
    await settle()

    // A project with no description must still show the row: it is the only
    // thing that tells the user the field exists and can be filled in.
    expect(wrapper.get('[data-testid="active-project-description"]').text()).toBe(
      "sidebar.noProjectDescription",
    )
  })

  it("follows the selected project", async () => {
    const wrapper = await mountPanel()

    await useProjectsStore().setActiveProject("Beta")
    await settle()
    state.projects[1].description = "The production gateway"
    await useProjectsStore().loadProjects()
    await settle()

    expect(wrapper.get('[data-testid="active-project-description"]').text()).toBe(
      "The production gateway",
    )
  })

  it("opens the edit dialog primed with the current text", async () => {
    const wrapper = await mountPanel()

    await wrapper.get('[data-testid="edit-project"]').trigger("click")

    const field = wrapper.get('[data-testid="edit-project-description"]')
      .element as HTMLTextAreaElement
    expect(field.value).toBe("The staging gateway")
  })

  it("sends the edited text to the backend and shows the result", async () => {
    const wrapper = await mountPanel()
    await wrapper.get('[data-testid="edit-project"]').trigger("click")

    await wrapper
      .get('[data-testid="edit-project-description"]')
      .setValue("Rewritten by the user")
    await wrapper.get('[data-testid="edit-project-submit"]').trigger("click")
    await settle()

    expect(invokeMock).toHaveBeenCalledWith("update_project_description", {
      project: "Alpha",
      description: "Rewritten by the user",
    })
    expect(wrapper.find('[data-testid="edit-project-modal"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="active-project-description"]').text()).toBe(
      "Rewritten by the user",
    )
  })

  it("keeps the dialog open and shows why when the backend refuses", async () => {
    const wrapper = await mountPanel()
    await wrapper.get('[data-testid="edit-project"]').trigger("click")
    invokeMock.mockRejectedValueOnce(new Error("Project not found: Alpha"))

    await wrapper.get('[data-testid="edit-project-submit"]').trigger("click")
    await settle()

    expect(wrapper.find('[data-testid="edit-project-modal"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="edit-project-modal"]').text()).toContain(
      "Project not found: Alpha",
    )
  })

  it("shows no description row at all until a project is selected", async () => {
    state.projects = []
    const wrapper = await mountPanel()

    expect(wrapper.find('[data-testid="active-project-description"]').exists()).toBe(false)
  })
})
