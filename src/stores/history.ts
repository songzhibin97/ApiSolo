import { computed, ref } from "vue"
import { defineStore } from "pinia"

import i18n from "../i18n"
import type { HistoryEntry, HistoryGroupMode } from "../types"
import { recordConsoleEntry } from "./console"
import { invoke } from "../utils/invoke"
import { sanitizeHistoryEntry } from "../utils/redaction"
import {
  filterEntries,
  groupByMethod,
  groupByPrefix,
  groupByTime,
  sortEntries,
} from "../utils/history-grouping"

const DEFAULT_GROUP_MODE: HistoryGroupMode = "prefix"
const DEFAULT_PREFIX_DEPTH = 2

export const useHistoryStore = defineStore("history", () => {
  const entries = ref<HistoryEntry[]>([])
  const groupMode = ref<HistoryGroupMode>(DEFAULT_GROUP_MODE)
  const searchQuery = ref("")
  const prefixDepth = ref(DEFAULT_PREFIX_DEPTH)

  const filteredEntries = computed(() => filterEntries(entries.value, searchQuery.value))

  const groupedEntries = computed(() => {
    if (groupMode.value === "time") {
      return groupByTime(filteredEntries.value)
    }

    if (groupMode.value === "method") {
      return groupByMethod(filteredEntries.value)
    }

    return groupByPrefix(filteredEntries.value, prefixDepth.value)
  })

  async function loadHistory() {
    // A read failure propagates: the panel shows it and nothing is written back.
    const raw = await invoke<HistoryEntry[]>("load_history")
    const sanitized = raw.map(sanitizeHistoryEntry)
    const changed = sanitized.filter((entry, index) => JSON.stringify(entry) !== JSON.stringify(raw[index]))

    // Assign first so the panel is showing clean data even if the write-back fails.
    entries.value = sortEntries(sanitized)

    if (changed.length === 0) {
      return
    }

    try {
      await invoke("update_history_entries", { entries: changed })
      recordConsoleEntry(
        "info",
        i18n.global.t("history.legacySanitized", { count: changed.length }),
        "app",
      )
    } catch (error) {
      recordConsoleEntry("error", `[app] History sanitize write-back failed: ${error}`, "app")
    }
  }

  function appendEntry(entry: HistoryEntry) {
    entries.value = sortEntries([entry, ...entries.value]).slice(0, 1000)
    recordConsoleEntry(
      "info",
      `[app] History appended: ${entry.method} ${entry.url} → ${entry.status}`,
      "app",
    )
  }

  async function clearHistory() {
    await invoke("clear_history")
    entries.value = []
  }

  async function deleteEntry(id: string) {
    await invoke("delete_history_entry", { id })
    entries.value = entries.value.filter((entry) => entry.id !== id)
  }

  function setGroupMode(mode: HistoryGroupMode) {
    groupMode.value = mode
  }

  function setSearchQuery(query: string) {
    searchQuery.value = query
  }

  function setPrefixDepth(depth: number) {
    prefixDepth.value = Math.min(4, Math.max(1, depth))
  }

  return {
    entries,
    groupMode,
    searchQuery,
    prefixDepth,
    groupedEntries,
    loadHistory,
    appendEntry,
    clearHistory,
    deleteEntry,
    setGroupMode,
    setSearchQuery,
    setPrefixDepth,
  }
})
