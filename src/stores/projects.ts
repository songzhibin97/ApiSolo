import { defineStore } from "pinia"
import { ref } from "vue"

import i18n from "../i18n"
import { recordConsoleEntry } from "./console"
import { invoke } from "../utils/invoke"
import { useTabsStore } from "./tabs"
import type { CollectionNode, ProjectMeta, SavedRequest, Tab } from "../types"

export const useProjectsStore = defineStore("projects", () => {
  const projects = ref<ProjectMeta[]>([])
  const activeProject = ref<string | null>(null)
  const collectionTree = ref<CollectionNode[]>([])

  async function loadProjects() {
    projects.value = await invoke<ProjectMeta[]>("list_projects")

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
