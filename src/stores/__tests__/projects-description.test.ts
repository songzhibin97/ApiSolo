import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const { invokeMock, state } = vi.hoisted(() => {
  const state = { description: "before" }

  return {
    state,
    invokeMock: vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "list_projects") {
        return [
          {
            name: "Alpha",
            description: state.description,
            createdAt: "2026-08-31T00:00:00Z",
            updatedAt: "2026-08-31T00:00:00Z",
          },
        ]
      }

      if (command === "update_project_description") {
        state.description = String(args?.description ?? "").trim()
        return {
          name: "Alpha",
          description: state.description,
          createdAt: "2026-08-31T00:00:00Z",
          updatedAt: "2026-08-31T00:01:00Z",
        }
      }

      return null
    }),
  }
})

vi.mock("../../utils/invoke", () => ({ invoke: invokeMock }))

import { useProjectsStore } from "../projects"

describe("editing a project description", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMock.mockClear()
    state.description = "before"
  })

  it("sends the text to the backend under the project it belongs to", async () => {
    const store = useProjectsStore()

    await store.updateProjectDescription("Alpha", "after")

    expect(invokeMock).toHaveBeenCalledWith("update_project_description", {
      project: "Alpha",
      description: "after",
    })
  })

  it("re-reads the project list so the new text is what the app holds", async () => {
    // Patching the in-memory entry from the command's return value would give a
    // second copy of the project metadata, maintained by hand, next to the one
    // `list_projects` produces. The stored file is the only authority here.
    const store = useProjectsStore()
    await store.loadProjects()
    expect(store.projects[0].description).toBe("before")

    await store.updateProjectDescription("Alpha", "after")

    expect(store.projects[0].description).toBe("after")
  })

  it("passes the failure on to the caller", async () => {
    const store = useProjectsStore()
    invokeMock.mockRejectedValueOnce(new Error("Project not found: Alpha"))

    await expect(store.updateProjectDescription("Alpha", "after")).rejects.toThrow(
      "Project not found: Alpha",
    )
  })
})
