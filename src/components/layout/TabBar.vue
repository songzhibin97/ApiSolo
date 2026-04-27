<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, type ComponentPublicInstance } from "vue";
import { Copy, Pencil, Plus, X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";

import { useTabsStore } from "../../stores/tabs";
import { formatUntitledTabLabel, isUntitledTabLabel } from "../../stores/tabs";
import ContextMenu from "../ui/ContextMenu.vue";

const tabsStore = useTabsStore();
const { t } = useI18n();

const methodColors: Record<string, string> = {
  GET: "text-emerald-400",
  POST: "text-amber-400",
  PUT: "text-sky-400",
  DELETE: "text-rose-400",
  PATCH: "text-violet-400",
  WS: "text-fuchsia-400",
};

const tabList = computed(() => tabsStore.tabs);
const createMenuVisible = ref(false)
const createMenuRef = ref<HTMLElement | null>(null)
const editingTabId = ref<string | null>(null)
const editingLabel = ref("")
const editingInput = ref<HTMLInputElement | null>(null)
const contextMenuVisible = ref(false)
const contextMenuTabId = ref<string | null>(null)
const contextMenuPosition = ref({ x: 0, y: 0 })

function formatLabel(url: string, label: string) {
  if (isUntitledTabLabel(label) && url.trim()) {
    try {
      const parsed = new URL(url)
      return parsed.pathname === "/" ? parsed.hostname : `${parsed.hostname}${parsed.pathname}`
    } catch {
      return url.length > 30 ? `${url.slice(0, 30)}...` : url
    }
  }

  if (isUntitledTabLabel(label)) {
    const index = Number(label.match(/\d+$/)?.[0] ?? "1")
    return formatUntitledTabLabel(index)
  }

  return label
}

const dragTabId = ref<string | null>(null)
const dropTargetId = ref<string | null>(null)

async function closeTab(event: MouseEvent, id: string) {
  event.stopPropagation();
  await tabsStore.removeTab(id);
  if (editingTabId.value === id) {
    editingTabId.value = null
  }
}

function onTabDragStart(event: DragEvent, tabId: string) {
  dragTabId.value = tabId
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move"
    event.dataTransfer.setData("text/plain", tabId)
  }
}

function onTabDragOver(event: DragEvent, tabId: string) {
  if (!dragTabId.value || dragTabId.value === tabId) return
  event.preventDefault()
  dropTargetId.value = tabId
}

function onTabDragLeave() {
  dropTargetId.value = null
}

function onTabDrop(event: DragEvent, targetId: string) {
  event.preventDefault()
  dropTargetId.value = null
  if (!dragTabId.value || dragTabId.value === targetId) return
  tabsStore.reorderTab(dragTabId.value, targetId)
  dragTabId.value = null
}

function onTabDragEnd() {
  dragTabId.value = null
  dropTargetId.value = null
}

function toggleCreateMenu() {
  createMenuVisible.value = !createMenuVisible.value
}

function createHttpTab() {
  createMenuVisible.value = false
  tabsStore.addTab()
}

function createWebSocketTab() {
  createMenuVisible.value = false
  tabsStore.addWsTab()
}

function startRename(tabId: string) {
  const tab = tabsStore.tabs.find((item) => item.id === tabId)
  if (!tab) {
    return
  }

  contextMenuVisible.value = false
  editingTabId.value = tabId
  editingLabel.value = tab.label
  nextTick(() => editingInput.value?.focus())
}

function submitRename(tabId: string) {
  const value = editingLabel.value.trim()
  if (value) {
    tabsStore.updateTab(tabId, { label: value })
  }

  editingTabId.value = null
}

function cancelRename() {
  editingTabId.value = null
}

function onRenameKeydown(event: KeyboardEvent, tabId: string) {
  if (event.key === "Enter") {
    submitRename(tabId)
    return
  }

  if (event.key === "Escape") {
    cancelRename()
  }
}

function setEditingInput(element: Element | ComponentPublicInstance | null) {
  editingInput.value = element instanceof HTMLInputElement ? element : null
}

function openContextMenu(event: MouseEvent, tabId: string) {
  event.preventDefault()
  tabsStore.setActiveTab(tabId)
  contextMenuTabId.value = tabId
  contextMenuPosition.value = {
    x: event.clientX,
    y: event.clientY,
  }
  contextMenuVisible.value = true
}

const contextMenuItems = computed(() => [
  { label: t("tabs.rename"), action: "rename", icon: Pencil },
  { label: t("tabs.duplicate"), action: "duplicate", icon: Copy },
  { label: t("tabs.close"), action: "close", icon: X },
  { label: t("tabs.closeOthers"), action: "close-others" },
  { label: t("tabs.closeToRight"), action: "close-right" },
])

async function handleContextMenuAction(action: string) {
  const tabId = contextMenuTabId.value
  contextMenuVisible.value = false
  if (!tabId) {
    return
  }

  if (action === "rename") {
    startRename(tabId)
    return
  }

  if (action === "duplicate") {
    tabsStore.duplicateTab(tabId)
    return
  }

  if (action === "close") {
    await tabsStore.removeTab(tabId)
    return
  }

  if (action === "close-others") {
    await tabsStore.closeOtherTabs(tabId)
    return
  }

  if (action === "close-right") {
    await tabsStore.closeTabsToRight(tabId)
  }
}

function handleOutsideClick(event: MouseEvent) {
  if (!createMenuVisible.value) {
    return
  }

  if (createMenuRef.value?.contains(event.target as Node)) {
    return
  }

  createMenuVisible.value = false
}

onMounted(() => {
  document.addEventListener("click", handleOutsideClick)
})

onUnmounted(() => {
  document.removeEventListener("click", handleOutsideClick)
})
</script>

<template>
  <div
    class="flex h-10 items-center border-b border-[var(--border)] bg-[var(--bg-primary)] pl-2"
  >
    <div class="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden">
      <div
        v-for="tab in tabList"
        :key="tab.id"
        class="group relative flex h-full min-w-[10rem] max-w-80 shrink-0 items-center gap-2 border-r border-[var(--border)] px-3.5 text-sm text-[var(--text-secondary)] transition hover:bg-[color-mix(in_srgb,var(--bg-secondary)_65%,transparent)]"
        :class="[
          tabsStore.activeTabId === tab.id
            ? 'bg-[color-mix(in_srgb,var(--bg-secondary)_78%,transparent)] text-[var(--text-primary)]'
            : '',
          dragTabId === tab.id ? 'opacity-40' : '',
          dropTargetId === tab.id ? 'border-l-2 border-l-[var(--accent)]' : '',
        ]"
        draggable="true"
        @click="tabsStore.setActiveTab(tab.id)"
        @dblclick="startRename(tab.id)"
        @contextmenu="openContextMenu($event, tab.id)"
        @dragstart="onTabDragStart($event, tab.id)"
        @dragover="onTabDragOver($event, tab.id)"
        @dragleave="onTabDragLeave"
        @drop="onTabDrop($event, tab.id)"
        @dragend="onTabDragEnd"
      >
        <span
          class="text-[11px] font-semibold tracking-wide"
          :class="
            tab.protocol === 'websocket'
              ? 'text-fuchsia-400'
              : methodColors[tab.method] ?? 'text-[var(--text-secondary)]'
          "
        >
          {{ tab.protocol === "websocket" ? "WS" : tab.method }}
        </span>
        <span
          v-if="tab.protocol === 'websocket'"
          class="h-1.5 w-1.5 rounded-full"
          :class="
            tab.wsStatus === 'connected'
              ? 'bg-emerald-400'
              : tab.wsStatus === 'connecting'
                ? 'bg-amber-400'
                : 'bg-slate-500'
          "
        />
        <input
          v-if="editingTabId === tab.id"
          :ref="setEditingInput"
          v-model="editingLabel"
          class="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-sm text-[var(--text-primary)] outline-none"
          type="text"
          :aria-label="t('tabs.rename')"
          @blur="submitRename(tab.id)"
          @click.stop
          @keydown.stop="onRenameKeydown($event, tab.id)"
        />
        <span v-else class="truncate">{{ formatLabel(tab.url, tab.label) }}</span>
        <span
          v-if="tab.isDirty"
          class="h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
          aria-hidden="true"
        />
        <span class="ml-auto flex items-center">
          <X
            :size="14"
            class="opacity-0 transition group-hover:opacity-100"
            @click="closeTab($event, tab.id)"
          />
        </span>
        <span
          v-if="tabsStore.activeTabId === tab.id"
          class="absolute inset-x-0 bottom-0 h-0.5 bg-[var(--accent)]"
        />
      </div>
    </div>

    <div ref="createMenuRef" class="relative flex h-full items-center gap-1 border-l border-[var(--border)] px-1.5">
      <button
        class="flex h-8 min-w-8 items-center justify-center gap-1 rounded-md px-2.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[color-mix(in_srgb,var(--bg-surface)_35%,transparent)] hover:text-[var(--text-primary)]"
        type="button"
        :aria-label="t('tabs.addTab')"
        @click="createHttpTab"
      >
        <Plus :size="15" />
      </button>
      <button
        class="flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-secondary)] transition hover:bg-[color-mix(in_srgb,var(--bg-surface)_35%,transparent)] hover:text-[var(--text-primary)]"
        type="button"
        aria-label="More"
        @click.stop="toggleCreateMenu"
      >
        <span class="text-[10px]">▼</span>
      </button>

      <div
        v-if="createMenuVisible"
        class="absolute right-1 top-[calc(100%+6px)] z-20 min-w-40 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-1 shadow-lg"
      >
        <button
          class="flex w-full items-center rounded px-3 py-2 text-left text-sm text-[var(--text-primary)] transition hover:bg-[color-mix(in_srgb,var(--bg-secondary)_70%,transparent)]"
          type="button"
          @click="createHttpTab"
        >
          {{ t("ws.newHttp") }}
        </button>
        <button
          class="flex w-full items-center rounded px-3 py-2 text-left text-sm text-[var(--text-primary)] transition hover:bg-[color-mix(in_srgb,var(--bg-secondary)_70%,transparent)]"
          type="button"
          @click="createWebSocketTab"
        >
          {{ t("ws.newWebSocket") }}
        </button>
      </div>
    </div>

    <ContextMenu
      :items="contextMenuItems"
      :position="contextMenuPosition"
      :visible="contextMenuVisible"
      @close="contextMenuVisible = false"
      @select="handleContextMenuAction"
    />
  </div>
</template>
