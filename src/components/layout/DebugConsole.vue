<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import { storeToRefs } from "pinia"
import { Bug, Trash2, X } from "lucide-vue-next"
import { useI18n } from "vue-i18n"

import { useConsoleStore, type ConsoleLevel } from "../../stores/console"

const MIN_HEIGHT = 140
const MAX_HEIGHT = 360

const { t } = useI18n()
const consoleStore = useConsoleStore()
const { entries } = storeToRefs(consoleStore)

const activeFilter = ref<"all" | ConsoleLevel>("all")
const panelHeight = ref(200)
const listRef = ref<HTMLElement | null>(null)

const filterOptions = computed(() => [
  { value: "all" as const, label: t("console.all") },
  { value: "log" as const, label: "Log" },
  { value: "warn" as const, label: "Warn" },
  { value: "error" as const, label: "Error" },
])

const filteredEntries = computed(() =>
  activeFilter.value === "all"
    ? entries.value
    : entries.value.filter((entry) => entry.level === activeFilter.value),
)

function formatTime(timestamp: string) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour12: false,
  })
}

function scrollToBottom() {
  if (!listRef.value) {
    return
  }

  listRef.value.scrollTop = listRef.value.scrollHeight
}

watch(
  () => filteredEntries.value.length,
  async () => {
    await nextTick()
    scrollToBottom()
  },
)

watch(activeFilter, async () => {
  await nextTick()
  scrollToBottom()
})

function closeConsole() {
  consoleStore.toggle(false)
}

function onResizeStart(event: MouseEvent) {
  event.preventDefault()

  const startY = event.clientY
  const startHeight = panelHeight.value

  const onPointerMove = (moveEvent: MouseEvent) => {
    const nextHeight = startHeight - (moveEvent.clientY - startY)
    panelHeight.value = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, nextHeight))
  }

  const onPointerUp = () => {
    window.removeEventListener("mousemove", onPointerMove)
    window.removeEventListener("mouseup", onPointerUp)
  }

  window.addEventListener("mousemove", onPointerMove)
  window.addEventListener("mouseup", onPointerUp)
}

</script>

<template>
  <section class="border-t border-[var(--border)] bg-[var(--bg-secondary)]" :style="{ height: `${panelHeight}px` }">
    <div
      class="h-1 cursor-row-resize bg-[var(--border)] transition-colors hover:bg-[var(--accent)]"
      @mousedown="onResizeStart"
    />

    <div class="flex h-[calc(100%-4px)] flex-col">
      <header
        class="flex items-center justify-between gap-3 border-b border-[var(--border)] px-3 py-2 text-xs"
      >
        <div class="flex min-w-0 items-center gap-3">
          <div class="flex items-center gap-2 font-medium text-[var(--text-primary)]">
            <Bug class="h-3.5 w-3.5 text-[var(--accent)]" />
            <span>{{ t("console.title") }} ({{ entries.length }})</span>
          </div>

          <div class="flex items-center gap-1">
            <button
              v-for="option in filterOptions"
              :key="option.value"
              type="button"
              class="rounded-sm border px-2 py-0.5 transition-colors"
              :class="
                activeFilter === option.value
                  ? 'border-[var(--accent)] bg-[var(--bg-primary)] text-[var(--text-primary)]'
                  : 'border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              "
              @click="activeFilter = option.value"
            >
              {{ option.label }}
            </button>
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-1">
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)]"
            @click="consoleStore.clear()"
          >
            <Trash2 class="h-3.5 w-3.5" />
            <span>{{ t("console.clear") }}</span>
          </button>
          <button
            type="button"
            class="rounded-sm p-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)]"
            @click="closeConsole"
          >
            <X class="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div
        ref="listRef"
        class="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-5 text-[var(--text-primary)]"
      >
        <div v-if="filteredEntries.length === 0" class="py-6 text-center text-[var(--text-secondary)]">
          {{ t("console.noLogs") }}
        </div>

        <div v-for="entry in filteredEntries" :key="entry.id" class="grid grid-cols-[72px_70px_1fr] gap-3">
          <span class="text-[var(--text-secondary)]">{{ formatTime(entry.timestamp) }}</span>
          <span
            class="inline-flex w-fit items-center rounded-sm border px-1.5 uppercase"
            :class="{
              'border-slate-500/40 text-[var(--text-primary)]': entry.level === 'log',
              'border-sky-500/30 bg-sky-500/10 text-sky-300': entry.level === 'info',
              'border-amber-500/30 bg-amber-500/10 text-amber-300': entry.level === 'warn',
              'border-rose-500/30 bg-rose-500/10 text-rose-300': entry.level === 'error',
            }"
          >
            {{ entry.level }}
          </span>
          <span class="break-all whitespace-pre-wrap">{{ entry.message }}</span>
        </div>
      </div>
    </div>
  </section>
</template>
