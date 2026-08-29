<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import { storeToRefs } from "pinia"
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Search,
  Star,
  StickyNote,
  Trash2,
} from "lucide-vue-next"
import { useI18n } from "vue-i18n"

import ConfirmDialog from "../ui/ConfirmDialog.vue"
import InlineError from "../ui/InlineError.vue"
import SaveFromHistory from "./SaveFromHistory.vue"
import { useHistoryStore } from "../../stores/history"
import { useProjectsStore } from "../../stores/projects"
import { useTabsStore } from "../../stores/tabs"
import type { HistoryEntry, HistoryGroupMode } from "../../types"

const historyStore = useHistoryStore()
const projectsStore = useProjectsStore()
const tabsStore = useTabsStore()
const { t, locale } = useI18n()

const {
  entries,
  groupedEntries,
  groupMode,
  prefixDepth,
  searchQuery,
  starredOnly,
  badRows,
  clearableCount,
  starredCount,
} = storeToRefs(historyStore)
const { activeProject } = storeToRefs(projectsStore)
const collapsedGroups = ref<Record<string, boolean>>({})
const clearDialogVisible = ref(false)
const isClearing = ref(false)
const errorMessage = ref("")
const saveEntry = ref<HistoryEntry | null>(null)
const pendingDelete = ref<HistoryEntry | null>(null)
const isDeleting = ref(false)
const noteEntry = ref<HistoryEntry | null>(null)
const noteDraft = ref("")
const isSavingNote = ref(false)

const groupModes: HistoryGroupMode[] = ["prefix", "time", "method"]

const depthOptions = computed(() => [1, 2, 3, 4])

/**
 * Both gates that stood in front of Clear History have to open together. Leaving
 * the early return in place gives a button that is enabled and does nothing,
 * which is worse than a disabled one -- a disabled button at least tells the
 * truth. And a user whose file is all bad lines has no other way out: the read
 * fails, the list is empty, and clearing is the only thing left.
 */
const clearBlocked = computed(() => entries.value.length === 0 && badRows.value === 0)

const clearMessage = computed(() => {
  const total = t("history.clearConfirm", { count: clearableCount.value })

  // No "including 0 starred" filler: a clause that is always there stops being
  // read.
  return starredCount.value > 0
    ? `${total} ${t("history.clearWithStarred", { starred: starredCount.value })}`
    : total
})

const deleteMessage = computed(() =>
  pendingDelete.value
    ? t("history.deleteConfirm", { method: pendingDelete.value.method, url: pendingDelete.value.url })
    : "",
)

onMounted(async () => {
  try {
    errorMessage.value = ""
    if (historyStore.entries.length === 0) {
      await historyStore.loadHistory()
    }
    await historyStore.loadHealth()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
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

function openSaveDialog(entry: HistoryEntry) {
  errorMessage.value = ""
  saveEntry.value = entry
}

function openDeleteDialog(entry: HistoryEntry) {
  errorMessage.value = ""
  pendingDelete.value = entry
}

function openNoteDialog(entry: HistoryEntry) {
  errorMessage.value = ""
  noteEntry.value = entry
  noteDraft.value = entry.note ?? ""
}

async function submitNote() {
  const entry = noteEntry.value
  if (!entry) {
    return
  }

  isSavingNote.value = true
  errorMessage.value = ""

  try {
    await historyStore.setNote(entry.id, noteDraft.value)
    noteEntry.value = null
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    isSavingNote.value = false
  }
}

async function toggleStar(entry: HistoryEntry) {
  errorMessage.value = ""

  try {
    await historyStore.toggleStar(entry.id)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}

async function confirmDelete() {
  const entry = pendingDelete.value
  if (!entry) {
    return
  }

  isDeleting.value = true
  errorMessage.value = ""

  try {
    await historyStore.deleteEntry(entry.id)
    pendingDelete.value = null
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    isDeleting.value = false
  }
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

function summarizeResponseBody(value: string | undefined, kind?: HistoryEntry["responseBodyKind"]) {
  if (kind === "binary") {
    return t("response.binaryBody")
  }

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
  if (clearBlocked.value) {
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

        <label
          class="flex h-9 items-center gap-2 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]"
        >
          <input
            type="checkbox"
            data-testid="starred-only"
            :checked="starredOnly"
            @change="historyStore.setStarredOnly(($event.target as HTMLInputElement).checked)"
          />
          <span>{{ t("history.starredOnly") }}</span>
        </label>
      </div>

      <div
        v-if="badRows > 0"
        data-testid="history-health-notice"
        class="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-200"
      >
        <AlertTriangle :size="14" class="mt-0.5 shrink-0" />
        <span>{{ t("history.healthBadRows", { count: badRows }) }}</span>
      </div>

      <div
        v-if="!activeProject && entries.length > 0"
        data-testid="history-save-needs-project"
        class="rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-primary)_76%,black)] px-3 py-2 text-xs leading-5 text-[var(--text-secondary)]"
      >
        {{ t("history.saveNeedsProject") }}
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
            data-testid="history-group-header"
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
            <!--
              A row is a container with one primary action and several siblings,
              not one big button: nesting the secondary buttons inside the row
              button would be invalid HTML, and clicking any of them would open
              the entry as well.
            -->
            <div
              v-for="entry in group.entries"
              :key="entry.id"
              data-testid="history-row"
              class="flex w-full flex-col gap-0.5 rounded px-1 py-1 transition hover:bg-[color-mix(in_srgb,var(--bg-surface)_35%,transparent)]"
            >
              <button
                class="flex w-full min-w-0 items-center gap-2 overflow-hidden rounded text-left"
                data-testid="history-open"
                type="button"
                :title="`${entry.method} ${entry.url} • ${formatTimestamp(entry.timestamp)}`"
                @click="openEntry(entry)"
              >
                <!-- w-12 (48px) is 6px narrower than OPTIONS needs (54px), the
                     longest method this app can write. The overflowing glyphs land
                     inside the 8px gap-2 that follows, a measured 2px short of the
                     URL. That margin is calculated and deliberately accepted
                     (owner ruling, D12): clipping here would cut characters out of
                     OPTIONS, and widening the box would spend row width this
                     layout cannot spare. -->
                <span class="w-12 shrink-0 text-[11px] font-semibold tracking-wide" :class="methodClass(entry.method)">
                  {{ entry.method }}
                </span>
                <span class="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">
                  {{ formatEntryUrl(entry.url) }}
                </span>
                <span class="shrink-0 text-xs font-semibold" :class="statusClass(entry.status)">
                  {{ entry.status }}
                </span>
              </button>

              <!--
                D20: the two badges are siblings of the facts group, not members
                of it. Inside it they were subject to its clipping: the group is
                flex-1 min-w-0, so a narrow window shrinks it below its own
                content, and shrink-0 only stops flex from compressing a child,
                not the parent from clipping it (measured at window 700 / pane
                143: group 24px against 36px of content, so the note badge kept
                4 of its 12px). Out here their width is reserved by the flex
                algorithm itself, at every width.

                The separators are elements rather than a gap on this row for
                the same reason: a gap is rigid, so it would spend 12px that the
                narrowest rows need for the badges. These give way to 0 first,
                and only then does the row clip from the right, where the known
                out-of-range boundary already puts the action bar.
              -->
              <div
                data-testid="history-line2"
                class="flex w-full min-w-0 items-center overflow-hidden"
              >
                <div
                  data-testid="history-facts"
                  class="flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
                >
                  <span class="min-w-0 truncate text-xs text-[var(--text-secondary)]">
                    {{ formatTime(entry.time) }}
                  </span>
                  <span
                    v-if="entry.responseBody"
                    data-testid="history-response-summary"
                    class="min-w-0 flex-1 truncate text-xs text-[var(--text-secondary)]"
                  >
                    {{ summarizeResponseBody(entry.responseBody, entry.responseBodyKind) }}
                  </span>
                </div>

                <!-- Network truncation: this row's stored body is the prefix of
                     a body that was never fully received. Same key as the
                     response panel's badge — they state the same fact. The icon
                     sits in a span with role="img" because aria-label on a
                     generic span is naming-prohibited: the attribute would be
                     present and the accessible name absent. -->
                <template v-if="entry.responseBodyTruncated">
                  <div data-testid="history-line2-gap" class="w-1 shrink"></div>
                  <span
                    data-testid="history-truncated-badge"
                    role="img"
                    :title="t('response.networkTruncatedBadge')"
                    :aria-label="t('response.networkTruncatedBadge')"
                    class="shrink-0 text-amber-500"
                  >
                    <AlertTriangle :size="12" aria-hidden="true" />
                  </span>
                </template>

                <template v-if="entry.note">
                  <div data-testid="history-line2-gap" class="w-1 shrink"></div>
                  <StickyNote
                    data-testid="history-note-badge"
                    :size="12"
                    class="shrink-0 text-[var(--accent)]"
                  />
                </template>

                <div data-testid="history-line2-gap" class="w-1 shrink"></div>

                <div data-testid="history-actions" class="flex shrink-0 items-center gap-0">
                  <button
                    class="shrink-0 rounded p-0.5 text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
                    data-testid="history-star"
                    type="button"
                    :title="entry.starred ? t('history.unstar') : t('history.star')"
                    :aria-label="entry.starred ? t('history.unstar') : t('history.star')"
                    @click.stop="toggleStar(entry)"
                  >
                    <Star :size="14" :class="entry.starred ? 'text-amber-300' : ''" />
                  </button>

                  <button
                    class="shrink-0 rounded p-0.5 text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
                    data-testid="history-note"
                    type="button"
                    :title="t('history.note')"
                    :aria-label="t('history.note')"
                    @click.stop="openNoteDialog(entry)"
                  >
                    <StickyNote :size="14" />
                  </button>

                  <button
                    class="shrink-0 rounded p-0.5 text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                    data-testid="history-save"
                    type="button"
                    :title="t('history.saveToCollection')"
                    :aria-label="t('history.saveToCollection')"
                    :disabled="!activeProject"
                    @click.stop="openSaveDialog(entry)"
                  >
                    <FolderPlus :size="14" />
                  </button>

                  <button
                    class="shrink-0 rounded p-0.5 text-[var(--text-secondary)] transition hover:text-rose-300"
                    data-testid="history-delete"
                    type="button"
                    :title="t('history.deleteEntry')"
                    :aria-label="t('history.deleteEntry')"
                    @click.stop="openDeleteDialog(entry)"
                  >
                    <Trash2 :size="14" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="border-t border-[var(--border)] p-3">
      <div class="mb-2">
        <InlineError :message="errorMessage" />
      </div>
      <button
        class="flex h-8 w-full items-center justify-center gap-2 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm font-semibold text-[var(--text-primary)] transition hover:border-[color-mix(in_srgb,var(--accent)_60%,white)] disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="history-clear"
        type="button"
        :disabled="clearBlocked"
        @click="confirmClearHistory"
      >
        <Trash2 :size="16" />
        <span>{{ t("history.clearHistory") }}</span>
      </button>
    </div>

    <div
      v-if="noteEntry"
      data-testid="history-note-dialog"
      class="fixed inset-0 z-30 flex items-center justify-center bg-black/45 p-4"
    >
      <div class="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4 shadow-lg">
        <div class="text-lg font-semibold text-[var(--text-primary)]">{{ t("history.note") }}</div>
        <!--
          Submitting an empty note is how a note is removed, so this control
          cannot borrow the "no blank submissions" rule the rename prompt uses.
        -->
        <textarea
          v-model="noteDraft"
          data-testid="history-note-input"
          class="mt-4 min-h-32 w-full rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-3 text-sm text-[var(--text-primary)] outline-none transition focus:border-[color-mix(in_srgb,var(--accent)_70%,white)]"
          :placeholder="t('history.notePlaceholder')"
        />
        <div class="mt-5 flex justify-end gap-2">
          <button
            class="h-8 rounded border border-[var(--border)] px-3 text-sm text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
            type="button"
            :disabled="isSavingNote"
            @click="noteEntry = null"
          >
            {{ t("common.cancel") }}
          </button>
          <button
            class="h-8 rounded bg-[var(--accent)] px-3 text-sm font-semibold text-white transition hover:brightness-110"
            data-testid="history-note-submit"
            type="button"
            :disabled="isSavingNote"
            @click="submitNote"
          >
            {{ t("common.save") }}
          </button>
        </div>
      </div>
    </div>

    <SaveFromHistory :visible="saveEntry !== null" :entry="saveEntry" @close="saveEntry = null" />

    <ConfirmDialog
      :visible="pendingDelete !== null"
      :title="t('history.deleteEntry')"
      :message="deleteMessage"
      :confirm-label="isDeleting ? t('common.loading') : t('history.deleteEntry')"
      :cancel-label="t('common.cancel')"
      :busy="isDeleting"
      danger
      @cancel="!isDeleting && (pendingDelete = null)"
      @confirm="confirmDelete"
    />

    <ConfirmDialog
      :visible="clearDialogVisible"
      :title="t('history.clearHistory')"
      :message="clearMessage"
      :confirm-label="isClearing ? t('common.loading') : t('history.clearHistory')"
      :cancel-label="t('common.cancel')"
      danger
      @cancel="!isClearing && (clearDialogVisible = false)"
      @confirm="clearHistory"
    />
  </section>
</template>
