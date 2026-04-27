import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (command: string) => {
    if (command === "get_collection_tree") {
      return []
    }

    return null
  }),
}))

vi.mock("../../utils/invoke", () => ({
  invoke: invokeMock,
}))

import { useProjectsStore } from "../projects"
import { useTabsStore } from "../tabs"
import type { SavedRequest } from "../../types"

function makeSavedRequest(name: string): SavedRequest {
  return {
    name,
    method: "GET",
    url: `https://api.example.com/${name.toLowerCase()}`,
    params: [],
    headers: [],
    body: {
      type: "none",
      content: "",
      formData: [],
      binaryPath: "",
    },
    auth: { type: "none" },
    preRequestScript: "",
    testScript: "",
  }
}

describe("projects/tabs path sync", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMock.mockClear()
  })

  it("renames request tabs in place", async () => {
    const projectsStore = useProjectsStore()
    const tabsStore = useTabsStore()
    projectsStore.activeProject = "demo"

    tabsStore.openSavedRequest(
      "demo",
      "users/list-users.request.json",
      makeSavedRequest("List Users"),
    )

    await projectsStore.renameRequest("users/list-users.request.json", "Fetch Users")

    const tab = tabsStore.tabs.find((item) => item.savedRequestPath)?.savedRequestPath
    expect(tab).toBe("users/fetch-users.request.json")
    expect(tabsStore.tabs.find((item) => item.savedRequestPath)?.label).toBe("Fetch Users")
  })

  it("closes request tabs after deleting a request", async () => {
    const projectsStore = useProjectsStore()
    const tabsStore = useTabsStore()
    projectsStore.activeProject = "demo"

    tabsStore.openSavedRequest(
      "demo",
      "users/list-users.request.json",
      makeSavedRequest("List Users"),
    )

    await projectsStore.deleteRequest("users/list-users.request.json")

    expect(
      tabsStore.tabs.some((item) => item.savedRequestPath === "users/list-users.request.json"),
    ).toBe(false)
  })

  it("remaps nested request tabs when a collection is renamed", async () => {
    const projectsStore = useProjectsStore()
    const tabsStore = useTabsStore()
    projectsStore.activeProject = "demo"

    tabsStore.openSavedRequest(
      "demo",
      "users/admins/list.request.json",
      makeSavedRequest("List Admins"),
    )
    tabsStore.openSavedRequest(
      "demo",
      "users/admins/detail.request.json",
      makeSavedRequest("Admin Detail"),
    )

    await projectsStore.renameCollection("users/admins", "Staff")

    const savedPaths = tabsStore.tabs
      .map((item) => item.savedRequestPath)
      .filter((item): item is string => Boolean(item))

    expect(savedPaths).toContain("users/staff/list.request.json")
    expect(savedPaths).toContain("users/staff/detail.request.json")
  })

  it("closes nested request tabs when a collection is deleted", async () => {
    const projectsStore = useProjectsStore()
    const tabsStore = useTabsStore()
    projectsStore.activeProject = "demo"

    tabsStore.openSavedRequest(
      "demo",
      "users/admins/list.request.json",
      makeSavedRequest("List Admins"),
    )

    await projectsStore.deleteCollection("users/admins")

    expect(
      tabsStore.tabs.some((item) => item.savedRequestPath?.startsWith("users/admins")),
    ).toBe(false)
  })
})
