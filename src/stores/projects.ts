import { defineStore } from "pinia"
import { ref, watch } from "vue"

import i18n from "../i18n"
import { recordConsoleEntry } from "./console"
import { invoke } from "../utils/invoke"
import { useTabsStore } from "./tabs"
import type { CollectionNode, ProjectMeta, SavedRequest, Tab } from "../types"

const ACTIVE_PROJECT_KEY = "apisolo:active-project"

export const useProjectsStore = defineStore("projects", () => {
  const projects = ref<ProjectMeta[]>([])
  const activeProject = ref<string | null>(null)
  const collectionTree = ref<CollectionNode[]>([])

  // Every write to the selection goes to disk, including the ones this store
  // makes to itself (the fallback below, `createProject`) and the ones a caller
  // makes by assigning the ref. A `persist()` call next to each assignment
  // would be a list to keep in sync, and the next writer is the one that
  // forgets; watching the ref means there is nothing to remember.
  //
  // Deriving the write from the ref also splices its failures into whatever
  // performed the assignment — with `flush: "sync"` this callback runs *inside*
  // `activeProject.value = x`. That is why `persistActiveProject` may not
  // throw: see the note on it.
  watch(activeProject, persistActiveProject, { flush: "sync" })

  async function loadProjects() {
    projects.value = await invoke<ProjectMeta[]>("list_projects")

    // The stored name is a *proxy* for "the project you were last in", and the
    // project it names may have been deleted since. It is seeded here, ahead of
    // the two checks below, precisely so it has to survive the same "is this
    // still a real project" check any other selection does — a restore path
    // with its own validation would be a second copy of that rule, free to
    // drift from this one.
    if (!activeProject.value) {
      activeProject.value = readPersistedActiveProject()
    }

    if (!activeProject.value && projects.value.length > 0) {
      activeProject.value = projects.value[0].name
    }

    if (
      activeProject.value &&
      !projects.value.some((project) => project.name === activeProject.value)
    ) {
      activeProject.value = projects.value[0]?.name ?? null
    }
  }

  async function createProject(name: string, description: string) {
    try {
      const project = await invoke<ProjectMeta>("create_project", { name, description })
      await loadProjects()
      activeProject.value = project.name
      await loadCollectionTree()
      recordConsoleEntry("info", `[app] Project created: ${project.name}`, "app")
      return project
    } catch (error) {
      recordConsoleEntry(
        "error",
        `[app] Failed to create project ${name}: ${error instanceof Error ? error.message : String(error)}`,
        "app",
      )
      throw error
    }
  }

  async function setActiveProject(projectName: string | null) {
    activeProject.value = projectName
    await loadCollectionTree()
  }

  async function loadCollectionTree() {
    if (!activeProject.value) {
      collectionTree.value = []
      return
    }

    collectionTree.value = await invoke<CollectionNode[]>("get_collection_tree", {
      project: activeProject.value,
    })
  }

  async function saveRequest(
    collection: string,
    request: SavedRequest,
    tab?: Tab,
    shouldReload = true,
  ) {
    if (!activeProject.value) {
      throw new Error(i18n.global.t("errors.noActiveProject"))
    }

    try {
      const normalizedRequest = normalizeSavedRequest(request)
      await invoke("save_request", {
        project: activeProject.value,
        collection,
        request: normalizedRequest,
        existingPath: tab?.savedRequestPath ?? undefined,
      })

      if (shouldReload) {
        await loadCollectionTree()
      }

      if (tab) {
        const tabsStore = useTabsStore()
        const savedRequestPath = [collection, `${slugify(normalizedRequest.name)}.request.json`]
          .filter(Boolean)
          .join("/")

        tabsStore.updateTab(tab.id, {
          label: normalizedRequest.name,
          isDirty: false,
          projectName: activeProject.value,
          savedRequestPath,
        })
      }

      recordConsoleEntry(
        "info",
        `[app] Request saved: ${activeProject.value}/${collection || "."}/${normalizedRequest.name}`,
        "app",
      )
    } catch (error) {
      recordConsoleEntry(
        "error",
        `[app] Failed to save request ${request.name}: ${error instanceof Error ? error.message : String(error)}`,
        "app",
      )
      throw error
    }
  }

  async function deleteRequest(path: string) {
    if (!activeProject.value) {
      return
    }

    const tabsStore = useTabsStore()
    await invoke("delete_request", {
      project: activeProject.value,
      path,
    })
    await tabsStore.closeSavedRequest(activeProject.value, path)
    await loadCollectionTree()
  }

  async function renameRequest(path: string, newName: string) {
    if (!activeProject.value) {
      throw new Error(i18n.global.t("errors.noActiveProject"))
    }

    const nextPath = buildRenamedRequestPath(path, newName)
    const tabsStore = useTabsStore()
    await invoke("rename_request", {
      project: activeProject.value,
      path,
      newName,
    })
    tabsStore.remapSavedRequestPath(activeProject.value, path, nextPath, { label: newName })
    await loadCollectionTree()
  }

  async function moveRequest(fromPath: string, toCollection: string) {
    if (!activeProject.value) {
      throw new Error(i18n.global.t("errors.noActiveProject"))
    }

    await invoke("move_request", {
      project: activeProject.value,
      fromPath,
      toCollection,
    })

    const fileName = fromPath.split("/").pop() ?? ""
    const nextPath = [toCollection, fileName].filter(Boolean).join("/")
    const tabsStore = useTabsStore()

    tabsStore.remapSavedRequestPath(activeProject.value, fromPath, nextPath)

    await loadCollectionTree()
  }

  async function createCollection(name: string, parent: string, shouldReload = true) {
    if (!activeProject.value) {
      throw new Error(i18n.global.t("errors.noActiveProject"))
    }

    await invoke("create_collection", {
      project: activeProject.value,
      name,
      parent,
    })
    if (shouldReload) {
      await loadCollectionTree()
    }
  }

  async function deleteCollection(path: string) {
    if (!activeProject.value) {
      return
    }

    const tabsStore = useTabsStore()
    await invoke("delete_collection", {
      project: activeProject.value,
      path,
    })
    await tabsStore.closeSavedRequestsInPath(activeProject.value, path)
    await loadCollectionTree()
  }

  async function renameCollection(path: string, newName: string) {
    if (!activeProject.value) {
      throw new Error(i18n.global.t("errors.noActiveProject"))
    }

    const nextPath = buildRenamedCollectionPath(path, newName)
    const tabsStore = useTabsStore()
    await invoke("rename_collection", {
      project: activeProject.value,
      path,
      newName,
    })
    tabsStore.remapSavedRequestPathPrefix(activeProject.value, path, nextPath)
    await loadCollectionTree()
  }

  async function loadRequest(path: string) {
    if (!activeProject.value) {
      throw new Error(i18n.global.t("errors.noActiveProject"))
    }

    const request = await invoke<SavedRequest>("load_request", {
      project: activeProject.value,
      path,
    })

    return normalizeSavedRequest(request)
  }

  async function openRequest(path: string) {
    if (!activeProject.value) {
      return
    }

    const request = await loadRequest(path)
    useTabsStore().openSavedRequest(activeProject.value, path, request)
  }

  return {
    projects,
    activeProject,
    collectionTree,
    loadProjects,
    createProject,
    setActiveProject,
    loadCollectionTree,
    saveRequest,
    deleteRequest,
    renameRequest,
    moveRequest,
    createCollection,
    deleteCollection,
    renameCollection,
    loadRequest,
    openRequest,
  }
})

// Same shape settings.ts uses: one localStorage key, guarded so the store can
// still be built where there is no window (tests, and any non-browser host).
// The `localStorage` check is not belt-and-braces — a stubbed window without it
// is a real thing in this repo's test suite.
function activeProjectStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null
  }

  return window.localStorage ?? null
}

// Both sides are best-effort, and the `try` covers the accessor too: reaching
// for `window.localStorage` is itself a throwing operation under a restrictive
// storage policy, as are `getItem`, `setItem` and `removeItem` once a quota or
// a policy says no. All four are inside it.
//
// Neither one may throw, because neither one runs on its own behalf. The write
// runs inside `activeProject.value = x` (sync watcher), so an escaping error
// aborts the assigning caller — in `setActiveProject` that is the statement
// before `await loadCollectionTree()`, so the tree reload would simply never
// run. The read runs inside `loadProjects`, which is the app's startup path.
//
// What this buys, stated no wider than it is: a failing `localStorage` does not
// stop a project switch or the tree load that follows it, and does not stop
// startup. It is not swallowed either — the console panel is where this app
// reports its own failures, and this is one.
//
// What it does *not* buy: `setActiveProject` commits the name and only then
// awaits the tree, so a tree load that fails or arrives out of order still
// leaves the two disagreeing. That ordering predates this file's changes and is
// untouched by them; it is filed as D38. Nothing here claims the selected
// project and the collection tree are consistent — only that storage is not one
// of the ways they come apart.
function readPersistedActiveProject(): string | null {
  try {
    return activeProjectStorage()?.getItem(ACTIVE_PROJECT_KEY) || null
  } catch (error) {
    reportActiveProjectStorageFailure("read the last selected project", error)
    return null
  }
}

function persistActiveProject(projectName: string | null) {
  try {
    const storage = activeProjectStorage()
    if (!storage) {
      return
    }

    if (projectName) {
      storage.setItem(ACTIVE_PROJECT_KEY, projectName)
      return
    }

    storage.removeItem(ACTIVE_PROJECT_KEY)
  } catch (error) {
    reportActiveProjectStorageFailure("remember the selected project", error)
  }
}

function reportActiveProjectStorageFailure(action: string, error: unknown) {
  recordConsoleEntry(
    "error",
    `[app] Could not ${action}: ${error instanceof Error ? error.message : String(error)}`,
    "app",
  )
}

function normalizeSavedRequest(request: SavedRequest): SavedRequest {
  return {
    ...request,
    preRequestScript: request.preRequestScript || "",
    testScript: request.testScript || "",
    params: request.params.map(normalizeKeyValuePair),
    headers: request.headers.map(normalizeKeyValuePair),
    body: {
      ...request.body,
      formData: request.body.formData.map((item) => {
        const normalized = normalizeKeyValuePair(item)
        if (normalized.valueType !== "file") {
          return normalized
        }

        return {
          ...normalized,
          fileName: sanitizeFileLabel(normalized.fileName || normalized.filePath || normalized.key),
          filePath: "",
        }
      }),
      binaryPath: sanitizeFileLabel(request.body.binaryPath),
      binaryContent: request.body.binaryContent,
    },
  }
}

function normalizeKeyValuePair<T extends SavedRequest["params"][number]>(item: T): T {
  return {
    ...item,
    id: item.id || crypto.randomUUID(),
    enabled: item.enabled ?? true,
    key: item.key ?? "",
    value: item.value ?? "",
    description: item.description ?? "",
  } as T
}

function sanitizeFileLabel(value: string) {
  if (!value) {
    return ""
  }

  return value.split(/[\\/]/).pop() ?? value
}

function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")

  return slug || "untitled"
}

function buildRenamedRequestPath(path: string, newName: string) {
  const segments = path.split("/")
  segments[segments.length - 1] = `${slugify(newName)}.request.json`
  return segments.join("/")
}

function buildRenamedCollectionPath(path: string, newName: string) {
  const segments = path.split("/")
  segments[segments.length - 1] = slugify(newName)
  return segments.join("/")
}
