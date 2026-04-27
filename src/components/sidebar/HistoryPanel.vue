<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import { storeToRefs } from "pinia"
import { ChevronDown, ChevronRight, Search, Trash2 } from "lucide-vue-next"
import { useI18n } from "vue-i18n"

import ConfirmDialog from "../ui/ConfirmDialog.vue"
import { useHistoryStore } from "../../stores/history"
import { useTabsStore } from "../../stores/tabs"
import type { HistoryEntry, HistoryGroupMode } from "../../types"

const historyStore = useHistoryStore()
const tabsStore = useTabsStore()
const { t, locale } = useI18n()

const { entries, groupedEntries, groupMode, prefixDepth, searchQuery } = storeToRefs(historyStore)
const collapsedGroups = ref<Record<string, boolean>>({})
const clearDialogVisible = ref(false)
const isClearing = ref(false)
const errorMessage = ref("")

const groupModes: HistoryGroupMode[] = ["prefix", "time", "method"]

const depthOptions = computed(() => [1, 2, 3, 4])

onMounted(async () => {
  if (historyStore.entries.length === 0) {
    try {
      errorMessage.value = ""
      await historyStore.loadHistory()
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error)
    }
  }
})

watch(
  groupedEntries,
  (groups) => {
    const nextState = { ...collapsedGroups.value }

    for (const group of groups) {
      if (!(group.label in nextState)) {
        nextState[group.label] = false
      }
    }

    collapsedGroups.value = nextState
  },
  { immediate: true },
)

function toggleGroup(label: string) {
  collapsedGroups.value[label] = !collapsedGroups.value[label]
}

function openEntry(entry: HistoryEntry) {
  tabsStore.openHistoryEntry(entry)
}

function formatEntryUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl)
    return `${url.pathname}${url.search}` || "/"
  } catch {
    return rawUrl
  }
}

function formatTime(value: number) {
  return `${value}ms`
}

function formatTimestamp(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale.value)
}

function summarizeResponseBody(value?: string) {
  if (!value) {
    return ""
  }

  return value.replace(/\s+/g, " ").trim().slice(0, 80)
}

function methodClass(method: string) {
  return (
    {
      GET: "text-emerald-400",
      POST: "text-amber-400",
      PUT: "text-sky-400",
      PATCH: "text-violet-400",
      DELETE: "text-rose-400",
      HEAD: "text-cyan-400",
      OPTIONS: "text-fuchsia-400",
    }[method.toUpperCase()] ?? "text-[var(--text-secondary)]"
  )
}

function statusClass(status: number) {
  if (status >= 500) {
    return "text-rose-400"
  }

  if (status >= 400) {
    return "text-amber-400"
  }

  if (status >= 300) {
    return "text-sky-400"
  }

  return "text-emerald-400"
}

function groupModeLabel(mode: HistoryGroupMode) {
  return t(`history.${mode}`)
}

function translateGroupLabel(label: string) {
  const keyMap: Record<string, string> = {
    Today: "history.today",
    Yesterday: "history.yesterday",
    "This Week": "history.thisWeek",
    "This Month": "history.thisMonth",
    Older: "history.older",
  }

  return keyMap[label] ? t(keyMap[label]) : label
}

function confirmClearHistory() {
  const total = entries.value.length
  if (total === 0) {
    return
  }

  errorMessage.value = ""
  clearDialogVisible.value = true
}

async function clearHistory() {
  isClearing.value = true
  errorMessage.value = ""

  try {
    await historyStore.clearHistory()
    clearDialogVisible.value = false
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    isClearing.value = false
  }
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-[var(--bg-secondary)]">
    <div class="space-y-2 border-b border-[var(--border)] px-3 py-3">
      <label
        class="flex h-9 items-center gap-2 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-secondary)]"
      >
        <Search :size="14" />
        <input
          :value="searchQuery"
          class="min-w-0 flex-1 bg-transparent text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)]"
          type="text"
          :placeholder="t('history.searchUrl')"
          @input="historyStore.setSearchQuery(($event.target as HTMLInputElement).value)"
        />
      </label>

      <div class="flex flex-wrap items-center gap-2">
        <div class="inline-flex rounded border border-[var(--border)] bg-[var(--bg-primary)] p-1">
          <button
            v-for="mode in groupModes"
            :key="mode"
            class="rounded px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition"
            :class="
              groupMode === mode
                ? 'bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            "
            type="button"
            @click="historyStore.setGroupMode(mode)"
          >
            {{ groupModeLabel(mode) }}
          </button>
        </div>

        <label
          v-if="groupMode === 'prefix'"
          class="flex h-9 items-center gap-2 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]"
        >
          <span>{{ t("history.depth") }}</span>
          <select
            :value="prefixDepth"
            class="bg-transparent text-[var(--text-primary)] outline-none"
            @change="historyStore.setPrefixDepth(Number(($event.target as HTMLSelectElement).value))"
          >
            <option v-for="depth in depthOptions" :key="depth" :value="depth">
              {{ depth }}
            </option>
          </select>
        </label>
      </div>

      <div class="rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-primary)_76%,black)] px-3 py-2 text-xs leading-5 text-[var(--text-secondary)]">
        {{ t("history.securityNotice") }}
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-auto px-2 py-2">
      <div
        v-if="groupedEntries.length === 0"
        class="flex h-full min-h-40 items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--bg-primary)_92%,white),color-mix(in_srgb,var(--bg-secondary)_72%,transparent))] px-4 text-center"
      >
        <div class="max-w-xs">
          <div class="text-sm font-semibold text-[var(--text-primary)]">{{ t("history.empty") }}</div>
          <div class="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
            {{ t("history.emptyDescription") }}
          </div>
        </div>
      </div>

      <div v-else class="space-y-2">
        <div
          v-for="group in groupedEntries"
          :key="group.label"
          class="overflow-hidden rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-primary)_72%,transparent)]"
        >
          <button
            class="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-[var(--text-primary)] transition hover:bg-[color-mix(in_srgb,var(--bg-surface)_30%,transparent)]"
            type="button"
            @click="toggleGroup(group.label)"
          >
            <component :is="collapsedGroups[group.label] ? ChevronRight : ChevronDown" :size="14" />
            <span class="truncate font-medium">{{ translateGroupLabel(group.label) }}</span>
            <span class="ml-auto rounded bg-[color-mix(in_srgb,var(--bg-secondary)_80%,white)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]">
              {{ group.count }}
            </span>
          </button>

          <div v-if="!collapsedGroups[group.label]" class="border-t border-[var(--border)] px-2 py-2">
            <button
              v-for="entry in group.entries"
              :key="entry.id"
              class="flex w-full items-center gap-2 rounded px-2 py-2 text-left transition hover:bg-[color-mix(in_srgb,var(--bg-surface)_35%,transparent)]"
              type="button"
              :title="`${entry.method} ${entry.url} • ${formatTimestamp(entry.timestamp)}`"
              @click="openEntry(entry)"
            >
              <span class="w-12 shrink-0 text-[11px] font-semibold tracking-wide" :class="methodClass(entry.method)">
                {{ entry.method }}
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm text-[var(--text-primary)]">
                  {{ formatEntryUrl(entry.url) }}
                </span>
                <span
                  v-if="entry.responseBody"
                  class="block truncate text-xs text-[var(--text-secondary)]"
                >
                  {{ summarizeResponseBody(entry.responseBody) }}
                </span>
              </span>
              <span class="shrink-0 text-xs font-semibold" :class="statusClass(entry.status)">
                {{ entry.status }}
              </span>
              <span class="shrink-0 text-xs text-[var(--text-secondary)]">
                {{ formatTime(entry.time) }}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="border-t border-[var(--border)] p-3">
      <div v-if="errorMessage" class="mb-2 text-sm text-rose-300">
        {{ errorMessage }}
      </div>
      <button
        class="flex h-8 w-full items-center justify-center gap-2 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm font-semibold text-[var(--text-primary)] transition hover:border-[color-mix(in_srgb,var(--accent)_60%,white)] disabled:cursor-not-allowed disabled:opacity-50"
        type="button"
        :disabled="historyStore.entries.length === 0"
        @click="confirmClearHistory"
      >
        <Trash2 :size="16" />
        <span>{{ t("history.clearHistory") }}</span>
      </button>
    </div>

    <ConfirmDialog
      :visible="clearDialogVisible"
      :title="t('history.clearHistory')"
      :message="t('history.clearConfirm', { count: entries.length })"
      :confirm-label="isClearing ? t('common.loading') : t('history.clearHistory')"
      :cancel-label="t('common.cancel')"
      danger
      @cancel="!isClearing && (clearDialogVisible = false)"
      @confirm="clearHistory"
    />
  </section>
</template>
