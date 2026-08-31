// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const { invokeMock, projectList } = vi.hoisted(() => {
  const projectList: { name: string; description: string }[] = []

  return {
    projectList,
    invokeMock: vi.fn(async (command: string) => {
      if (command === "list_projects") {
        return projectList.map((project) => ({
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

vi.mock("../../utils/invoke", () => ({
  invoke: invokeMock,
}))

import { useProjectsStore } from "../projects"

const KEY = "apisolo:active-project"

function setProjects(...names: string[]) {
  projectList.length = 0
  projectList.push(...names.map((name) => ({ name, description: "" })))
}

describe("the selected project survives a restart", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMock.mockClear()
    window.localStorage.clear()
    setProjects("Alpha", "Beta")
  })

  it("writes the selection to storage when the user picks one", async () => {
    const store = useProjectsStore()

    await store.setActiveProject("Beta")

    expect(window.localStorage.getItem(KEY)).toBe("Beta")
  })

  it("writes the selection when the store picks one for the user", async () => {
    // `createProject` and the empty-list fallback both assign the ref directly.
    // Persisting from the ref rather than from each call site is what makes
    // "which writers remembered to persist" a question with no answer needed.
    const store = useProjectsStore()

    await store.loadProjects()

    expect(store.activeProject).toBe("Alpha")
    expect(window.localStorage.getItem(KEY)).toBe("Alpha")
  })

  it("restores the stored project instead of falling back to the first", async () => {
    window.localStorage.setItem(KEY, "Beta")
    const store = useProjectsStore()

    await store.loadProjects()

    // "Alpha" here would mean the stored name was never read: it is what the
    // pre-existing first-in-the-list fallback produces.
    expect(store.activeProject).toBe("Beta")
  })

  it("drops a stored project that is no longer on disk", async () => {
    // The stored name stands in for "the project you were last in", and that
    // project can be deleted between runs. Restoring it unchecked leaves every
    // later command addressed to a project the backend will reject.
    window.localStorage.setItem(KEY, "Deleted Last Week")
    const store = useProjectsStore()

    await store.loadProjects()

    expect(store.activeProject).toBe("Alpha")
    expect(window.localStorage.getItem(KEY)).toBe("Alpha")
  })

  it("leaves the selection empty when nothing is on disk at all", async () => {
    window.localStorage.setItem(KEY, "Deleted Last Week")
    setProjects()
    const store = useProjectsStore()

    await store.loadProjects()

    expect(store.activeProject).toBeNull()
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })

  it("does not overwrite a selection the session already made", async () => {
    window.localStorage.setItem(KEY, "Beta")
    const store = useProjectsStore()
    await store.setActiveProject("Alpha")

    await store.loadProjects()

    expect(store.activeProject).toBe("Alpha")
  })

  it("clears storage when the selection is cleared", async () => {
    const store = useProjectsStore()
    await store.setActiveProject("Beta")

    await store.setActiveProject(null)

    expect(window.localStorage.getItem(KEY)).toBeNull()
  })
})
