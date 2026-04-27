<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import { storeToRefs } from "pinia"
import { useI18n } from "vue-i18n"

import { useTabsStore } from "../../stores/tabs"
import { useWebSocketStore } from "../../stores/websocket"
import type { WsMessage } from "../../types"

type MessageFilter = "all" | "sent" | "received"

const tabsStore = useTabsStore()
const websocketStore = useWebSocketStore()
const { activeTab } = storeToRefs(tabsStore)
const { t } = useI18n()

const listRef = ref<HTMLDivElement | null>(null)
const activeFilter = ref<MessageFilter>("all")
const expandedIds = ref<string[]>([])

const connectionId = computed(() => activeTab.value.wsConnectionId ?? "")
const allMessages = computed(() =>
  connectionId.value ? websocketStore.getMessages(connectionId.value) : [],
)

const filteredMessages = computed(() => {
  if (activeFilter.value === "all") {
    return allMessages.value
  }

  return allMessages.value.filter((message) => message.direction === activeFilter.value)
})

watch(
  filteredMessages,
  async () => {
    await nextTick()
    if (listRef.value) {
      listRef.value.scrollTop = listRef.value.scrollHeight
    }
  },
  { deep: true },
)

watch(connectionId, () => {
  activeFilter.value = "all"
  expandedIds.value = []
})

function clearMessages() {
  if (!connectionId.value) {
    return
  }

  websocketStore.clearMessages(connectionId.value)
}

function toggleExpanded(id: string) {
  expandedIds.value = expandedIds.value.includes(id)
    ? expandedIds.value.filter((item) => item !== id)
    : [...expandedIds.value, id]
}

function isExpanded(id: string) {
  return expandedIds.value.includes(id)
}

function directionGlyph(direction: WsMessage["direction"]) {
  if (direction === "received") {
    return "←"
  }

  if (direction === "sent") {
    return "→"
  }

  return "⚡"
}

function directionClass(direction: WsMessage["direction"]) {
  if (direction === "received") {
    return "text-emerald-300"
  }

  if (direction === "sent") {
    return "text-sky-300"
  }

  return "text-slate-400"
}

function formatTimestamp(timestamp: string) {
  const date = new Date(timestamp)

  return Number.isNaN(date.getTime())
    ? timestamp
    : date.toLocaleTimeString([], {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
}

function formatContent(content: string) {
  try {
    return JSON.stringify(JSON.parse(content), null, 2)
  } catch {
    return content
  }
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-[color-mix(in_srgb,var(--bg-primary)_88%,black)]">
    <div class="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
      <div class="text-sm font-medium text-[var(--text-primary)]">
        {{ t("ws.messages") }} ({{ allMessages.length }})
      </div>

      <div class="flex items-center gap-2">
        <button
          class="rounded-lg border px-3 py-1.5 text-sm transition"
          :class="
            activeFilter === 'all'
              ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--text-primary)]'
              : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          "
          type="button"
          @click="activeFilter = 'all'"
        >
          {{ t("ws.all") }}
        </button>
        <button
          class="rounded-lg border px-3 py-1.5 text-sm transition"
          :class="
            activeFilter === 'sent'
              ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--text-primary)]'
              : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          "
          type="button"
          @click="activeFilter = 'sent'"
        >
          {{ t("ws.sent") }}
        </button>
        <button
          class="rounded-lg border px-3 py-1.5 text-sm transition"
          :class="
            activeFilter === 'received'
              ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--text-primary)]'
              : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          "
          type="button"
          @click="activeFilter = 'received'"
        >
          {{ t("ws.received") }}
        </button>
        <button
          class="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-1.5 text-sm text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
          type="button"
          @click="clearMessages"
        >
          {{ t("ws.clear") }}
        </button>
      </div>
    </div>

    <div v-if="filteredMessages.length === 0" class="flex flex-1 items-center justify-center p-6">
      <div class="rounded-lg border border-dashed border-[var(--border)] px-4 py-6 text-sm text-[var(--text-secondary)]">
        {{ activeTab.wsStatus === "connected" ? t("ws.waitingMessages") : t("ws.emptyMessages") }}
      </div>
    </div>

    <div v-else ref="listRef" class="min-h-0 flex-1 overflow-auto p-3 font-mono text-sm">
      <button
        v-for="message in filteredMessages"
        :key="message.id"
        class="mb-2 flex w-full flex-col rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-left transition hover:border-[color-mix(in_srgb,var(--accent)_45%,var(--border))]"
        type="button"
        @click="toggleExpanded(message.id)"
      >
        <div class="flex items-start gap-3">
          <span class="w-4 shrink-0 font-semibold" :class="directionClass(message.direction)">
            {{ directionGlyph(message.direction) }}
          </span>
          <span class="shrink-0 text-[var(--text-secondary)]">{{ formatTimestamp(message.timestamp) }}</span>
          <span
            class="min-w-0 flex-1 whitespace-pre-wrap break-words text-[var(--text-primary)]"
            :class="isExpanded(message.id) ? '' : 'line-clamp-1'"
          >
            {{ isExpanded(message.id) ? formatContent(message.content) : message.content }}
          </span>
        </div>
      </button>
    </div>
  </section>
</template>
