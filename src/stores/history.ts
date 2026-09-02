import { computed, ref } from "vue"
import { defineStore } from "pinia"

import i18n from "../i18n"
import type { HistoryEntry, HistoryGroupMode } from "../types"
import { recordConsoleEntry } from "./console"
import { invoke } from "../utils/invoke"
import { sanitizeHistoryEntry } from "../utils/redaction"
import { applyAnnotation, type HistoryAnnotationPatch } from "../utils/history-annotations"
import {
  filterEntries,
  groupByMethod,
  groupByPrefix,
  groupByTime,
  sortEntries,
} from "../utils/history-grouping"

const DEFAULT_GROUP_MODE: HistoryGroupMode = "prefix"
const DEFAULT_PREFIX_DEPTH = 2
const MAX_VISIBLE_ENTRIES = 1000

/**
 * The shape `get_history_health` actually serialises, read off the Rust struct
 * rather than inferred from what this panel happens to need.
 *
 * `quarantinedLines` is modelled but deliberately unused by the panel. It counts
 * lines an earlier write already moved out of `history.jsonl` and into the
 * quarantine file. The panel's notice says a number of lines "cannot be parsed
 * and are not shown in the list", and the list is `history.jsonl` — a line
 * sitting in quarantine is not an unreadable line of that file, it is a
 * preserved copy of one that used to be. Adding the two together would count
 * the same original line twice: once while it was still in the file, and again
 * every session after it was moved out.
 */
export interface HistoryHealth {
  skippedLines: number
  quarantinedLines: number
}

/**
 * The in-memory twin of the eviction rule on disk. It has to follow the same
 * rule for the same reason: a starred row that survives on disk but falls off
 * the list has, as far as the user is concerned, not been kept.
 *
 * Entries arrive newest first, so the oldest end -- and the eviction quota --
 * is at the back.
 */
function capEntries(entries: HistoryEntry[], limit: number): HistoryEntry[] {
  if (entries.length <= limit) {
    return entries
  }

  let overflow = entries.length - limit
  const kept: HistoryEntry[] = []

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]

    if (overflow > 0 && !entry.starred) {
      overflow -= 1
      continue
    }

    kept.push(entry)
  }

  return kept.reverse()
}

export const useHistoryStore = defineStore("history", () => {
  const entries = ref<HistoryEntry[]>([])
  const groupMode = ref<HistoryGroupMode>(DEFAULT_GROUP_MODE)
  const searchQuery = ref("")
  const prefixDepth = ref(DEFAULT_PREFIX_DEPTH)
  const starredOnly = ref(false)
  const health = ref<HistoryHealth>({ skippedLines: 0, quarantinedLines: 0 })

  const filteredEntries = computed(() =>
    filterEntries(entries.value, searchQuery.value, starredOnly.value),
  )

  /** Lines in `history.jsonl` the last read could not parse. */
  const badRows = computed(() => health.value.skippedLines)

  /**
   * What clearing is about to delete. Clearing removes the whole file, and the
   * unparsable lines are in it too -- reporting only the rows the list managed
   * to show would tell a user with a damaged file that there is nothing to
   * delete, and then delete plenty.
   */
  const clearableCount = computed(() => entries.value.length + badRows.value)

  const starredCount = computed(() => entries.value.filter((entry) => entry.starred).length)

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
        i18n.global.t("history.legacySanitized", changed.length),
        "app",
      )
    } catch (error) {
      recordConsoleEntry("error", `[app] History sanitize write-back failed: ${error}`, "app")
    }
  }

  function appendEntry(entry: HistoryEntry) {
    entries.value = capEntries(sortEntries([entry, ...entries.value]), MAX_VISIBLE_ENTRIES)
    recordConsoleEntry(
      "info",
      `[app] History appended: ${entry.method} ${entry.url} → ${entry.status}`,
      "app",
    )
  }

  async function loadHealth() {
    health.value = await invoke<HistoryHealth>("get_history_health")
  }

  async function clearHistory() {
    await invoke("clear_history")
    entries.value = []
    // The file is empty now. Leaving the old counts up would keep the panel
    // insisting there are unreadable lines in a file that no longer has any.
    await loadHealth()
  }

  /**
   * Sends the id and the fields being changed, never the whole row. A round
   * trip through the frontend's idea of an entry drops anything this build does
   * not model, and an omitted field must not read as an instruction to clear it.
   *
   * The disk write goes first: mirroring it into memory before it lands would
   * show the user an annotation that is not saved.
   */
  async function setAnnotation(id: string, patch: HistoryAnnotationPatch) {
    await invoke("set_history_annotation", { id, ...patch })

    entries.value = applyAnnotation(entries.value, id, patch)
  }

  async function setNote(id: string, note: string) {
    await setAnnotation(id, { note })
  }

  async function toggleStar(id: string) {
    const entry = entries.value.find((candidate) => candidate.id === id)
    await setAnnotation(id, { starred: !entry?.starred })
  }

  function setStarredOnly(value: boolean) {
    starredOnly.value = value
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
    starredOnly,
    health,
    badRows,
    clearableCount,
    starredCount,
    groupedEntries,
    loadHistory,
    loadHealth,
    appendEntry,
    clearHistory,
    deleteEntry,
    setAnnotation,
    setNote,
    toggleStar,
    setGroupMode,
    setSearchQuery,
    setStarredOnly,
    setPrefixDepth,
  }
})
