// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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

import pinia from ".."
import { useConsoleStore } from "../console"
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

/**
 * Persisting is derived from the ref, and a sync watcher runs inside the
 * assignment that triggered it. So a throwing `localStorage` does not fail the
 * *write* — it fails whoever assigned, and in `setActiveProject` that is the
 * statement before the collection tree is reloaded.
 *
 * What the user then has is worse than a lost preference: the header names the
 * project they just switched to, the tree under it still lists the previous
 * project's collections, and the next command combines the two. Deleting a
 * collection picked out of that stale tree sends the *new* project's name with
 * the *old* project's path, and the backend deletes exactly what it was asked
 * to. Nothing about it looks like a failure.
 *
 * Storage may cost the app its memory of the last project. It may not cost the
 * app the thing the user was doing.
 */
describe("storage that refuses to cooperate costs the selection and nothing else", () => {
  // Restored by hand rather than by `vi.restoreAllMocks()`: a spy that outlives
  // its case makes the *next* case fail for the previous case's reason, which
  // is exactly the kind of red that gets read as flakiness.
  let installed: { mockRestore: () => void }[] = []

  function breakStorage(method: "setItem" | "getItem", message: string) {
    const spy = vi.spyOn(window.localStorage, method).mockImplementation(() => {
      throw new Error(message)
    })
    installed.push(spy)
    return spy
  }

  beforeEach(() => {
    // Before `setActivePinia`, not after: `useConsoleStore(pinia)` makes that
    // pinia the active one, and the store under test would then be shared
    // across cases instead of rebuilt per case.
    useConsoleStore(pinia).clear()
    setActivePinia(createPinia())
    invokeMock.mockClear()
    window.localStorage.clear()
    setProjects("Alpha", "Beta")
  })

  afterEach(() => {
    installed.forEach((spy) => spy.mockRestore())
    installed = []
  })

  it("lets the switch complete when the write fails", async () => {
    const store = useProjectsStore()
    breakStorage("setItem", "QuotaExceededError")

    await expect(store.setActiveProject("Beta")).resolves.toBeUndefined()
  })

  it("still reloads the tree for the project it switched to", async () => {
    // The assertion that names the actual damage: `setActiveProject` assigns
    // and *then* reloads, so an error thrown by the assignment leaves the tree
    // describing a different project than the one now selected.
    const store = useProjectsStore()
    await store.setActiveProject("Alpha")
    breakStorage("setItem", "QuotaExceededError")
    invokeMock.mockClear()

    await store.setActiveProject("Beta").catch(() => undefined)

    expect(store.activeProject).toBe("Beta")
    expect(invokeMock).toHaveBeenCalledWith("get_collection_tree", { project: "Beta" })
  })

  it("reports the failed write instead of hiding it", async () => {
    // Best-effort is not the same as unnoticed. This app already reports its
    // own failures to the console panel, and a selection that will not survive
    // a restart is one of them.
    const store = useProjectsStore()
    breakStorage("setItem", "QuotaExceededError")

    await store.setActiveProject("Beta").catch(() => undefined)

    const errors = useConsoleStore(pinia)
      .entries.filter((entry) => entry.level === "error")
      .map((entry) => entry.message)
    expect(errors.join("\n")).toContain("QuotaExceededError")
  })

  it("still starts up when the read fails", async () => {
    // `readPersistedActiveProject` runs inside `loadProjects`, which is the
    // startup path: throwing there is a store with no projects at all.
    const store = useProjectsStore()
    breakStorage("getItem", "SecurityError")

    await expect(store.loadProjects()).resolves.toBeUndefined()

    expect(store.projects.map((project) => project.name)).toEqual(["Alpha", "Beta"])
    expect(store.activeProject).toBe("Alpha")
  })

  it("reports the failed read instead of hiding it", async () => {
    const store = useProjectsStore()
    breakStorage("getItem", "SecurityError")

    await store.loadProjects().catch(() => undefined)

    const errors = useConsoleStore(pinia)
      .entries.filter((entry) => entry.level === "error")
      .map((entry) => entry.message)
    expect(errors.join("\n")).toContain("SecurityError")
  })
})
