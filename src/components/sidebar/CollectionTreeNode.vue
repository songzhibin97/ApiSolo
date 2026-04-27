<script setup lang="ts">
import { computed, ref } from "vue"
import {
  ChevronRight,
  Copy,
  FileJson,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Plus,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-vue-next"
import { useI18n } from "vue-i18n"

import ConfirmDialog from "../ui/ConfirmDialog.vue"
import ContextMenu, { type ContextMenuItem } from "../ui/ContextMenu.vue"
import PromptDialog from "../ui/PromptDialog.vue"
import { useProjectsStore } from "../../stores/projects"
import type { CollectionNode } from "../../types"

const props = defineProps<{
  node: CollectionNode
}>()

const emit = defineEmits<{
  openRequest: [path: string]
  newRequest: [collectionPath: string]
  newCollection: [parentPath: string]
  renameCollection: [path: string, name: string]
  renameRequest: [path: string, name: string]
  deleteCollection: [path: string]
  deleteRequest: [path: string]
  copyRequestAsCurl: [path: string]
}>()

const { t } = useI18n()
const projectsStore = useProjectsStore()
const isExpanded = ref(true)
const menuVisible = ref(false)
const menuPosition = ref({ x: 0, y: 0 })
const isDragging = ref(false)
const isDropTarget = ref(false)
const isMovingRequest = ref(false)
const dragDepth = ref(0)
const renameDialogVisible = ref(false)
const pendingName = ref("")
const deleteDialogVisible = ref(false)
const renameError = ref("")
const deleteError = ref("")
const renameBusy = ref(false)
const deleteBusy = ref(false)

const methodColor = computed(() => {
  switch (props.node.method?.toUpperCase()) {
    case "GET":
      return "text-emerald-400"
    case "POST":
      return "text-amber-400"
    case "PUT":
      return "text-sky-400"
    case "DELETE":
      return "text-rose-400"
    case "PATCH":
      return "text-violet-400"
    default:
      return "text-[var(--text-secondary)]"
  }
})

const menuItems = computed<ContextMenuItem[]>(() => {
  if (props.node.nodeType === "folder") {
    return [
      {
        label: t("collection.contextMenu.newRequest"),
        action: "newRequest",
        icon: Plus,
      },
      {
        label: t("collection.contextMenu.newSubCollection"),
        action: "newSubCollection",
        icon: FolderPlus,
      },
      {
        label: t("collection.contextMenu.rename"),
        action: "rename",
        icon: Pencil,
      },
      {
        label: t("collection.contextMenu.delete"),
        action: "delete",
        icon: Trash2,
        danger: true,
      },
    ]
  }

  return [
    {
      label: t("collection.contextMenu.open"),
      action: "open",
      icon: SquareArrowOutUpRight,
    },
    {
      label: t("collection.contextMenu.rename"),
      action: "rename",
      icon: Pencil,
    },
    {
      label: t("collection.contextMenu.copyAsCurl"),
      action: "copyAsCurl",
      icon: Copy,
    },
    {
      label: t("collection.contextMenu.delete"),
      action: "delete",
      icon: Trash2,
      danger: true,
    },
  ]
})

function toggleFolder() {
  if (props.node.nodeType === "folder") {
    isExpanded.value = !isExpanded.value
  }
}

function openContextMenu(event: MouseEvent) {
  menuPosition.value = {
    x: event.clientX,
    y: event.clientY,
  }
  menuVisible.value = true
}

function closeContextMenu() {
  menuVisible.value = false
}

function handleMenuSelect(action: string) {
  closeContextMenu()

  if (props.node.nodeType === "folder") {
    if (action === "newRequest") {
      emit("newRequest", props.node.path)
      return
    }

    if (action === "newSubCollection") {
      emit("newCollection", props.node.path)
      return
    }

    if (action === "rename") {
      pendingName.value = props.node.name
      renameError.value = ""
      renameDialogVisible.value = true
      return
    }

    if (action === "delete") {
      deleteError.value = ""
      deleteDialogVisible.value = true
    }
    return
  }

  if (action === "open") {
    emit("openRequest", props.node.path)
    return
  }

  if (action === "copyAsCurl") {
    emit("copyRequestAsCurl", props.node.path)
    return
  }

  if (action === "rename") {
    pendingName.value = props.node.name
    renameError.value = ""
    renameDialogVisible.value = true
    return
  }

  if (action === "delete") {
    deleteError.value = ""
    deleteDialogVisible.value = true
  }
}

async function submitRename(name: string) {
  renameBusy.value = true
  renameError.value = ""

  try {
    if (props.node.nodeType === "folder") {
      await projectsStore.renameCollection(props.node.path, name)
    } else {
      await projectsStore.renameRequest(props.node.path, name)
    }

    renameDialogVisible.value = false
  } catch (error) {
    renameError.value = error instanceof Error ? error.message : String(error)
  } finally {
    renameBusy.value = false
  }
}

async function confirmDelete() {
  deleteBusy.value = true
  deleteError.value = ""

  try {
    if (props.node.nodeType === "folder") {
      await projectsStore.deleteCollection(props.node.path)
    } else {
      await projectsStore.deleteRequest(props.node.path)
    }

    deleteDialogVisible.value = false
  } catch (error) {
    deleteError.value = error instanceof Error ? error.message : String(error)
  } finally {
    deleteBusy.value = false
  }
}

function getDraggedRequestPath(event: DragEvent) {
  return event.dataTransfer?.getData("text/plain").trim() ?? ""
}

function getRequestCollectionPath(requestPath: string) {
  return requestPath.split("/").slice(0, -1).join("/")
}

function canDropRequest(requestPath: string) {
  return Boolean(
    props.node.nodeType === "folder" &&
      requestPath &&
      getRequestCollectionPath(requestPath) !== props.node.path,
  )
}

function handleRequestDragStart(event: DragEvent) {
  if (props.node.nodeType !== "request") {
    return
  }

  event.dataTransfer?.setData("text/plain", props.node.path)
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move"
  }
  isDragging.value = true
}

function handleRequestDragEnd() {
  isDragging.value = false
  isDropTarget.value = false
  dragDepth.value = 0
}

function handleFolderDragEnter(event: DragEvent) {
  if (props.node.nodeType !== "folder") {
    return
  }

  const requestPath = getDraggedRequestPath(event)
  if (!canDropRequest(requestPath)) {
    isDropTarget.value = false
    dragDepth.value = 0
    return
  }

  dragDepth.value += 1
  isDropTarget.value = true
}

function handleFolderDragOver(event: DragEvent) {
  if (props.node.nodeType !== "folder") {
    return
  }

  const requestPath = getDraggedRequestPath(event)
  if (!canDropRequest(requestPath)) {
    isDropTarget.value = false
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "none"
    }
    return
  }

  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move"
  }
  isDropTarget.value = true
}

function handleFolderDragLeave() {
  if (props.node.nodeType !== "folder") {
    return
  }

  dragDepth.value = Math.max(0, dragDepth.value - 1)
  if (dragDepth.value === 0) {
    isDropTarget.value = false
  }
}

async function handleFolderDrop(event: DragEvent) {
  if (props.node.nodeType !== "folder") {
    return
  }

  dragDepth.value = 0
  isDropTarget.value = false

  const requestPath = getDraggedRequestPath(event)
  if (!canDropRequest(requestPath) || isMovingRequest.value) {
    return
  }

  event.preventDefault()
  isMovingRequest.value = true

  try {
    await projectsStore.moveRequest(requestPath, props.node.path)
  } catch (error) {
    console.error("Failed to move request", error)
  } finally {
    isMovingRequest.value = false
  }
}
</script>

<template>
  <div class="text-sm">
    <button
      class="flex w-full items-center gap-2 rounded border border-transparent px-2 py-1.5 text-left text-[var(--text-secondary)] transition hover:bg-[color-mix(in_srgb,var(--bg-surface)_18%,transparent)] hover:text-[var(--text-primary)]"
      :class="[
        node.nodeType === 'request' && isDragging ? 'opacity-45' : '',
        node.nodeType === 'folder' && isDropTarget
          ? 'border-[color-mix(in_srgb,var(--accent)_78%,white)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--text-primary)]'
          : '',
      ]"
      type="button"
      :draggable="node.nodeType === 'request'"
      @click="node.nodeType === 'folder' ? toggleFolder() : emit('openRequest', node.path)"
      @contextmenu.prevent.stop="openContextMenu"
      @dragstart="handleRequestDragStart"
      @dragend="handleRequestDragEnd"
      @dragenter.prevent="handleFolderDragEnter"
      @dragover="handleFolderDragOver"
      @dragleave="handleFolderDragLeave"
      @drop="handleFolderDrop"
    >
      <template v-if="node.nodeType === 'folder'">
        <ChevronRight
          :size="14"
          class="shrink-0 transition"
          :class="isExpanded ? 'rotate-90' : ''"
        />
        <component :is="isExpanded ? FolderOpen : Folder" :size="14" class="shrink-0" />
        <span class="truncate">{{ node.name }}</span>
      </template>

      <template v-else>
        <span class="w-3.5 shrink-0" />
        <FileJson :size="14" class="shrink-0 text-[var(--text-secondary)]" />
        <span class="min-w-10 shrink-0 text-[11px] font-semibold uppercase tracking-wide" :class="methodColor">
          {{ node.method }}
        </span>
        <span class="truncate text-[var(--text-primary)]">{{ node.name }}</span>
      </template>
    </button>

    <ContextMenu
      :items="menuItems"
      :position="menuPosition"
      :visible="menuVisible"
      @close="closeContextMenu"
      @select="handleMenuSelect"
    />

    <PromptDialog
      :visible="renameDialogVisible"
      :title="t('collection.contextMenu.rename')"
      :placeholder="props.node.nodeType === 'folder' ? t('sidebar.collectionName') : t('request.requestName')"
      :confirm-label="t('common.save')"
      :cancel-label="t('common.cancel')"
      :initial-value="pendingName"
      :error-message="renameError"
      :busy="renameBusy"
      @cancel="!renameBusy && (renameDialogVisible = false)"
      @confirm="submitRename"
    />

    <ConfirmDialog
      :visible="deleteDialogVisible"
      :title="t('common.delete')"
      :message="t('collection.contextMenu.confirmDelete')"
      :confirm-label="t('common.delete')"
      :cancel-label="t('common.cancel')"
      :error-message="deleteError"
      :busy="deleteBusy"
      danger
      @cancel="!deleteBusy && (deleteDialogVisible = false)"
      @confirm="confirmDelete"
    />

    <div
      v-if="node.nodeType === 'folder' && isExpanded && node.children.length > 0"
      class="ml-3 border-l border-[color-mix(in_srgb,var(--border)_72%,transparent)] pl-2"
    >
      <CollectionTreeNode
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        @copy-request-as-curl="(path) => emit('copyRequestAsCurl', path)"
        @delete-collection="(path) => emit('deleteCollection', path)"
        @delete-request="(path) => emit('deleteRequest', path)"
        @new-collection="(path) => emit('newCollection', path)"
        @new-request="(path) => emit('newRequest', path)"
        @open-request="(path) => emit('openRequest', path)"
        @rename-collection="(path, name) => emit('renameCollection', path, name)"
        @rename-request="(path, name) => emit('renameRequest', path, name)"
      />
    </div>
  </div>
</template>
