import { beforeEach, describe, expect, it } from "vitest"
import { createPinia, setActivePinia } from "pinia"

import { useTabsStore } from "../tabs"
import type { KeyValuePair } from "../../types"

function pair(key: string, value: string): KeyValuePair {
  return { id: `${key}-1`, enabled: true, key, value, description: "" }
}

/**
 * Supports §10–§12: those three assert what the URL bar does with the revision
 * signal, and are all satisfied by a store that never produces one. This file
 * covers the producing side.
 */
describe("urlRevision marks writes the url bar did not make", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it("bumps on a params write", () => {
    const store = useTabsStore()
    const id = store.activeTab.id
    const before = store.activeTab.urlRevision

    store.updateTab(id, { params: [pair("a", "1")] })

    expect(store.activeTab.urlRevision).toBe(before + 1)
  })

  it("bumps on a url write", () => {
    const store = useTabsStore()
    const id = store.activeTab.id
    const before = store.activeTab.urlRevision

    store.updateTab(id, { url: "https://x/a" })

    expect(store.activeTab.urlRevision).toBe(before + 1)
  })

  it("does not bump when the url bar writes back its own keystroke", () => {
    const store = useTabsStore()
    const id = store.activeTab.id
    const before = store.activeTab.urlRevision

    store.updateTabFromUrlBar(id, { url: "https://x/a", params: [pair("a", "1")] })

    expect(store.activeTab.urlRevision).toBe(before)
  })

  it("does not bump on a write that leaves url and params alone", () => {
    const store = useTabsStore()
    const id = store.activeTab.id
    const before = store.activeTab.urlRevision

    // Switching the method must not disturb a draft in progress: it changes no
    // URL, so the text being typed has to stay where it is.
    store.updateTab(id, { method: "POST" })
    store.updateTab(id, { headers: [pair("X-A", "1")] })
    store.updateTab(id, { isLoading: true })

    expect(store.activeTab.urlRevision).toBe(before)
  })

  it("bumps when a history entry takes over a blank tab", () => {
    const store = useTabsStore()
    const id = store.activeTab.id
    const before = store.activeTab.urlRevision

    store.openHistoryEntry({
      id: crypto.randomUUID(),
      method: "GET",
      url: "",
      status: 0,
      time: 0,
      size: 0,
      timestamp: new Date().toISOString(),
      contentType: "",
    })

    // Reuse rather than a new tab — the point of the case.
    expect(store.tabs).toHaveLength(1)
    expect(store.activeTab.id).toBe(id)
    expect(store.activeTab.urlRevision).toBe(before + 1)
  })
})
