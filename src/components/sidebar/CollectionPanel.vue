<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { storeToRefs } from "pinia"
import { Download, FolderPlus, Plus, Upload } from "lucide-vue-next"
import { useI18n } from "vue-i18n"

import CollectionTreeNode from "./CollectionTreeNode.vue"
import ContextMenu, { type ContextMenuItem } from "../ui/ContextMenu.vue"
import { useProjectsStore } from "../../stores/projects"
import { useTabsStore } from "../../stores/tabs"
import type { CollectionNode } from "../../types"
import { exportCurl } from "../../utils/curl-export"
import { parseOpenApiSpec } from "../../utils/openapi-import"
import { exportPostmanCollection } from "../../utils/postman-export"
import {
  parsePostmanCollection,
  type PostmanImportResult,
} from "../../utils/postman-import"

const projectsStore = useProjectsStore()
const tabsStore = useTabsStore()
const { projects, activeProject, collectionTree } = storeToRefs(projectsStore)
const { t } = useI18n()

const showProjectModal = ref(false)
const showCollectionCreator = ref(false)
const projectName = ref("")
const projectDescription = ref("")
const collectionName = ref("")
const collectionParent = ref("")
const errorMessage = ref("")
const panelMenuVisible = ref(false)
const panelMenuPosition = ref({ x: 0, y: 0 })
const showImportModal = ref(false)
const importError = ref("")
const importFileName = ref("")
const importFormat = ref("")
const importPreview = ref<PostmanImportResult | null>(null)
const importFileInput = ref<HTMLInputElement | null>(null)
const feedbackMessage = ref("")
const feedbackTone = ref<"success" | "error">("success")
const panelError = ref("")

const panelMenuItems = computed<ContextMenuItem[]>(() => [
  {
    label: t("sidebar.newCollection"),
    action: "newCollection",
    icon: FolderPlus,
  },
])

const folderOptions = computed(() => {
  const folders = flattenFolders(collectionTree.value)
  return [{ label: t("common.rootCollection"), value: "" }, ...folders]
})

onMounted(async () => {
  try {
    panelError.value = ""
    await projectsStore.loadProjects()
    await projectsStore.loadCollectionTree()
  } catch (error) {
    panelError.value = error instanceof Error ? error.message : String(error)
  }
})

async function handleProjectChange(event: Event) {
  const nextProject = (event.target as HTMLSelectElement).value || null
  await projectsStore.setActiveProject(nextProject)
}

async function submitProject() {
  errorMessage.value = ""

  try {
    await projectsStore.createProject(projectName.value, projectDescription.value)
    showProjectModal.value = false
    projectName.value = ""
    projectDescription.value = ""
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}

function openCreateCollection() {
  errorMessage.value = ""
  collectionName.value = ""
  collectionParent.value = ""
  showCollectionCreator.value = true
}

function openCreateCollectionAt(parent = "") {
  errorMessage.value = ""
  collectionName.value = ""
  collectionParent.value = parent
  showCollectionCreator.value = true
}

function cancelCreateCollection() {
  showCollectionCreator.value = false
  collectionName.value = ""
  collectionParent.value = ""
  errorMessage.value = ""
}

async function submitCollection() {
  errorMessage.value = ""

  try {
    await projectsStore.createCollection(collectionName.value, collectionParent.value)
    showCollectionCreator.value = false
    collectionName.value = ""
    collectionParent.value = ""
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}

function closeDialog() {
  showProjectModal.value = false
  errorMessage.value = ""
}

function openImportDialog() {
  resetImportState()
  showImportModal.value = true
}

function closeImportDialog() {
  showImportModal.value = false
  resetImportState()
}

function resetImportState() {
  importError.value = ""
  importFileName.value = ""
  importFormat.value = ""
  importPreview.value = null

  if (importFileInput.value) {
    importFileInput.value.value = ""
  }
}

function handlePanelContextMenu(event: MouseEvent) {
  if (!activeProject.value) {
    return
  }

  panelMenuPosition.value = {
    x: event.clientX,
    y: event.clientY,
  }
  panelMenuVisible.value = true
}

function closePanelContextMenu() {
  panelMenuVisible.value = false
}

function handlePanelMenuSelect(action: string) {
  closePanelContextMenu()

  if (action === "newCollection") {
    openCreateCollectionAt("")
  }
}

function createNewRequest(collectionPath: string) {
  tabsStore.addTab({
    projectName: activeProject.value,
    savedRequestPath: [collectionPath, "__draft__.request.json"].filter(Boolean).join("/"),
  })
}

async function copyRequestAsCurl(path: string) {
  const request = await projectsStore.loadRequest(path)
  const command = exportCurl({
    id: crypto.randomUUID(),
    label: request.name,
    method: request.method,
    url: request.url,
    protocol: "http",
    isDirty: false,
    params: request.params,
    headers: request.headers,
    body: request.body,
    auth: request.auth,
    preRequestScript: request.preRequestScript,
    testScript: request.testScript,
    projectName: activeProject.value,
    savedRequestPath: path,
  })

  await navigator.clipboard.writeText(command)
}

async function renameCollection(path: string, name: string) {
  await projectsStore.renameCollection(path, name)
}

async function renameRequest(path: string, name: string) {
  await projectsStore.renameRequest(path, name)
}

async function deleteCollection(path: string) {
  await projectsStore.deleteCollection(path)
}

async function deleteRequest(path: string) {
  await projectsStore.deleteRequest(path)
}

function triggerImportFileSelection() {
  importFileInput.value?.click()
}

async function handleImportFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]

  if (!file) {
    return
  }

  importError.value = ""
  importPreview.value = null
  importFileName.value = file.name

  try {
    const content = await readFileAsText(file)
    const parsed = tryParseJson(content)

    if (parsed?.info?.schema?.includes("collection")) {
      importFormat.value = "Postman"
      importPreview.value = parsePostmanCollection(content)
      return
    }

    if (typeof parsed?.openapi === "string" && parsed.openapi.startsWith("3.")) {
      importFormat.value = "OpenAPI"
      importPreview.value = parseOpenApiSpec(content)
      return
    }

    importPreview.value = parseOpenApiSpec(content)
    importFormat.value = "OpenAPI"
  } catch (error) {
    importFormat.value = ""
    importPreview.value = null
    importError.value = error instanceof Error ? error.message : String(error)
  }
}

async function confirmImport() {
  if (!importPreview.value) {
    return
  }

  importError.value = ""
  feedbackMessage.value = ""

  try {
    const existingFolders = new Set(flattenFolders(collectionTree.value).map((item) => item.value))
    const folderPaths = Array.from(
      new Set(importPreview.value.requests.map((item) => item.folderPath).filter(Boolean)),
    ).sort((left, right) => left.split("/").length - right.split("/").length)

    for (const folderPath of folderPaths) {
      if (existingFolders.has(folderPath)) {
        continue
      }

      const parts = folderPath.split("/")
      const name = parts[parts.length - 1]
      const parent = parts.slice(0, -1).join("/")
      await projectsStore.createCollection(name, parent, false)
      existingFolders.add(folderPath)
    }

    for (const item of importPreview.value.requests) {
      await projectsStore.saveRequest(item.folderPath, item.request, undefined, false)
    }

    await projectsStore.loadCollectionTree()
    closeImportDialog()
    setFeedback("success", t("import.success"))
  } catch (error) {
    importError.value = error instanceof Error ? error.message : String(error)
  }
}

async function exportCurrentProject() {
  if (!activeProject.value) {
    return
  }

  feedbackMessage.value = ""

  try {
    const requestPaths = flattenRequestPaths(collectionTree.value)
    const requests = await Promise.all(requestPaths.map((path) => projectsStore.loadRequest(path)))
    const content = exportPostmanCollection(activeProject.value, requests, collectionTree.value)
    downloadFile(`${slugify(activeProject.value)}.postman_collection.json`, content)
    setFeedback("success", t("export.success"))
  } catch (error) {
    setFeedback("error", error instanceof Error ? error.message : t("import.error"))
  }
}

function flattenFolders(nodes: CollectionNode[]): { label: string; value: string }[] {
  return nodes.flatMap((node) => {
    if (node.nodeType !== "folder") {
      return []
    }

    return [
      { label: node.name, value: node.path },
      ...flattenFolders(node.children).map((child: { label: string; value: string }) => ({
        label: `${node.name} / ${child.label}`,
        value: child.value,
      })),
    ]
  })
}

function flattenRequestPaths(nodes: CollectionNode[]): string[] {
  return nodes.flatMap((node) => {
    if (node.nodeType === "request") {
      return [node.path]
    }

    return flattenRequestPaths(node.children)
  })
}

function setFeedback(tone: "success" | "error", message: string) {
  feedbackTone.value = tone
  feedbackMessage.value = message
}

function readFileAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ""))
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"))
    reader.readAsText(file)
  })
}

function tryParseJson(content: string) {
  try {
    return JSON.parse(content) as {
      info?: { schema?: string }
      openapi?: string
    }
  } catch {
    return null
  }
}

function downloadFile(filename: string, content: string) {
  const blob = new Blob([content], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")

  return slug || "collection"
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-[var(--bg-secondary)]">
    <div class="border-b border-[var(--border)] px-4 py-3">
      <div class="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
        {{ t("sidebar.project") }}
      </div>
      <div class="flex flex-nowrap items-center gap-2">
        <select
          class="h-9 min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none transition focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
          :value="activeProject ?? ''"
          @change="handleProjectChange"
        >
          <option value="" disabled>{{ t("sidebar.selectProject") }}</option>
          <option v-for="project in projects" :key="project.name" :value="project.name">
            {{ project.name }}
          </option>
        </select>
        <button
          class="inline-flex h-9 w-9 items-center justify-center rounded border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] transition hover:border-[color-mix(in_srgb,var(--accent)_60%,white)]"
          type="button"
          :aria-label="t('sidebar.createProject')"
          @click="showProjectModal = true"
        >
          <Plus :size="16" />
        </button>
        <button
          class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] transition hover:border-[color-mix(in_srgb,var(--accent)_60%,white)] disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          :title="activeProject ? t('import.import') : t('import.selectProjectFirst')"
          :aria-label="t('import.import')"
          :disabled="!activeProject"
          @click="openImportDialog"
        >
          <Upload :size="14" />
        </button>
        <button
          class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] transition hover:border-[color-mix(in_srgb,var(--accent)_60%,white)] disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          :title="activeProject ? t('export.asPostman') : t('import.selectProjectFirst')"
          :aria-label="t('export.asPostman')"
          :disabled="!activeProject"
          @click="exportCurrentProject"
        >
          <Download :size="14" />
        </button>
      </div>
      <div
        v-if="feedbackMessage"
        class="mt-3 text-xs"
        :class="feedbackTone === 'success' ? 'text-emerald-300' : 'text-rose-300'"
      >
        {{ feedbackMessage }}
      </div>
      <div v-if="panelError" class="mt-3 text-xs text-rose-300">
        {{ panelError }}
      </div>
    </div>

    <div v-if="projects.length === 0" class="flex flex-1 items-center justify-center p-4">
      <div class="max-w-xs rounded-lg border border-dashed border-[var(--border)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--bg-primary)_92%,white),color-mix(in_srgb,var(--bg-secondary)_82%,transparent))] p-4 text-center shadow-[0_20px_60px_-40px_rgba(0,0,0,0.65)]">
        <div class="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-[var(--accent)]">
          <Plus :size="20" />
        </div>
        <div class="mb-2 text-sm font-semibold text-[var(--text-primary)]">{{ t("sidebar.createFirstProject") }}</div>
        <div class="mb-4 text-sm text-[var(--text-secondary)]">
          {{ t("sidebar.projectsDescription") }}
        </div>
        <button
          class="inline-flex h-8 items-center gap-2 rounded bg-[var(--accent)] px-3 text-sm font-semibold text-white transition hover:brightness-110"
          type="button"
          @click="showProjectModal = true"
        >
          <Plus :size="14" />
          <span>{{ t("sidebar.newProject") }}</span>
        </button>
      </div>
    </div>

    <template v-else>
      <div
        class="flex-1 min-h-0 overflow-auto px-3 py-3"
        @contextmenu.prevent="handlePanelContextMenu"
      >
        <div
          v-if="collectionTree.length === 0"
          class="flex items-center gap-3 rounded-lg border border-dashed border-[var(--border)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--bg-primary)_92%,white),color-mix(in_srgb,var(--bg-secondary)_72%,transparent))] px-4 py-3 text-sm"
        >
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]">
            <FolderPlus :size="16" />
          </div>
          <div class="min-w-0">
            <div class="text-sm font-semibold text-[var(--text-primary)]">{{ t("sidebar.noCollections") }}</div>
            <div class="truncate text-xs text-[var(--text-secondary)]">
              {{ t("sidebar.noCollectionsCompact") }}
            </div>
          </div>
        </div>

        <div v-else class="space-y-1">
          <CollectionTreeNode
            v-for="node in collectionTree"
            :key="node.path"
            :node="node"
            @copy-request-as-curl="copyRequestAsCurl"
            @delete-collection="deleteCollection"
            @delete-request="deleteRequest"
            @new-collection="openCreateCollectionAt"
            @new-request="createNewRequest"
            @open-request="projectsStore.openRequest"
            @rename-collection="renameCollection"
            @rename-request="renameRequest"
          />
        </div>
      </div>

      <div class="border-t border-[var(--border)] p-3">
        <form v-if="showCollectionCreator" class="space-y-2" @submit.prevent="submitCollection">
          <input
            v-model="collectionName"
            class="h-9 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-secondary)] focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
            type="text"
            :placeholder="t('sidebar.collectionName')"
          />
          <select
            v-model="collectionParent"
            class="h-9 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none transition focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
          >
            <option v-for="option in folderOptions" :key="option.value || 'root'" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <div v-if="errorMessage" class="text-sm text-rose-300">
            {{ errorMessage }}
          </div>
          <div class="flex gap-2">
            <button
              class="flex h-9 flex-1 items-center justify-center gap-2 rounded bg-[var(--accent)] px-3 text-sm font-semibold text-white transition hover:brightness-110"
              type="submit"
            >
              <FolderPlus :size="16" />
              <span>{{ t("common.create") }}</span>
            </button>
            <button
              class="flex h-9 items-center justify-center rounded border border-[var(--border)] px-3 text-sm text-[var(--text-primary)] transition hover:border-[color-mix(in_srgb,var(--accent)_60%,white)]"
              type="button"
              @click="cancelCreateCollection"
            >
              {{ t("common.cancel") }}
            </button>
          </div>
        </form>
        <button
          v-else
          class="flex h-8 w-full items-center justify-center gap-2 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm font-semibold text-[var(--text-primary)] transition hover:border-[color-mix(in_srgb,var(--accent)_60%,white)]"
          type="button"
          :disabled="!activeProject"
          @click="openCreateCollection"
        >
          <FolderPlus :size="16" />
          <span>{{ t("sidebar.newCollection") }}</span>
        </button>
      </div>
    </template>

    <ContextMenu
      :items="panelMenuItems"
      :position="panelMenuPosition"
      :visible="panelMenuVisible"
      @close="closePanelContextMenu"
      @select="handlePanelMenuSelect"
    />

    <div
      v-if="showProjectModal"
      class="absolute inset-0 z-20 flex items-center justify-center bg-black/45 p-4"
    >
      <div class="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4 shadow-lg">
        <div class="mb-4 text-lg font-semibold text-[var(--text-primary)]">
          {{ t("sidebar.createProject") }}
        </div>

        <div class="space-y-3">
          <input
            v-model="projectName"
            class="h-9 w-full rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-sm text-[var(--text-primary)] outline-none transition focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
            type="text"
            :placeholder="t('sidebar.projectName')"
          />
          <textarea
            v-model="projectDescription"
            class="min-h-28 w-full rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
            :placeholder="t('sidebar.description')"
          />
        </div>

        <div v-if="errorMessage" class="mt-3 text-sm text-rose-300">
          {{ errorMessage }}
        </div>

        <div class="mt-5 flex justify-end gap-2">
          <button
            class="h-8 rounded border border-[var(--border)] px-3 text-sm text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
            type="button"
            @click="closeDialog"
          >
            {{ t("common.cancel") }}
          </button>
          <button
            class="h-8 rounded bg-[var(--accent)] px-3 text-sm font-semibold text-white transition hover:brightness-110"
            type="button"
            @click="submitProject"
          >
            {{ t("common.create") }}
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="showImportModal"
      class="absolute inset-0 z-20 flex items-center justify-center bg-black/45 p-4"
    >
      <div class="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4 shadow-lg">
        <div class="mb-4 text-lg font-semibold text-[var(--text-primary)]">
          {{ t("import.title") }}
        </div>

        <input
          ref="importFileInput"
          class="hidden"
          type="file"
          accept=".json,.yaml,.yml"
          @change="handleImportFileChange"
        />

        <button
          class="inline-flex h-9 items-center gap-2 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-sm font-medium text-[var(--text-primary)] transition hover:border-[color-mix(in_srgb,var(--accent)_60%,white)]"
          type="button"
          @click="triggerImportFileSelection"
        >
          <Upload :size="14" />
          <span>{{ t("import.selectFile") }}</span>
        </button>
        <div class="mt-2 text-xs text-[var(--text-secondary)]">
          {{ t("import.supportedFormats") }}
        </div>

        <div v-if="importFileName" class="mt-3 text-sm text-[var(--text-secondary)]">
          {{ importFileName }}
        </div>

        <div v-if="importPreview" class="mt-4 space-y-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3 text-sm">
          <div class="text-[var(--text-primary)]">
            {{ t("import.detected", { format: importFormat }) }}
          </div>
          <div class="text-[var(--text-secondary)]">
            {{ importPreview.name }}
          </div>
          <div class="text-[var(--text-secondary)]">
            {{ t("import.requestCount", { count: importPreview.requests.length }) }}
          </div>
        </div>

        <div v-if="importError" class="mt-3 text-sm text-rose-300">
          {{ importError }}
        </div>

        <div class="mt-5 flex justify-end gap-2">
          <button
            class="h-8 rounded border border-[var(--border)] px-3 text-sm text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
            type="button"
            @click="closeImportDialog"
          >
            {{ t("common.cancel") }}
          </button>
          <button
            class="h-8 rounded bg-[var(--accent)] px-3 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            :disabled="!importPreview"
            @click="confirmImport"
          >
            {{ t("import.import") }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
section {
  position: relative;
}
</style>
