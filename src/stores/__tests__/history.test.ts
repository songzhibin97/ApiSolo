import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock("../../utils/invoke", () => ({ invoke: invokeMock }))

import { useHistoryStore } from "../history"
import type { HistoryEntry } from "../../types"

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "e-1",
    method: "GET",
    url: "https://api.example.com/things",
    status: 200,
    time: 5,
    size: 2,
    timestamp: "2026-03-27T10:00:00Z",
    contentType: "application/json",
    ...overrides,
  } as HistoryEntry
}

/**
 * Newest first, which is the order `sortEntries` produces and therefore the
 * order the panel and the in-memory cap both see.
 */
function series(count: number, starredIds: string[] = []): HistoryEntry[] {
  return Array.from({ length: count }, (_unused, index) => {
    const id = `e${String(count - 1 - index).padStart(4, "0")}`
    return entry({
      id,
      url: `https://api.example.com/things/${id}`,
      timestamp: `2026-03-27T10:00:00.${String(count - 1 - index).padStart(4, "0")}Z`,
      starred: starredIds.includes(id),
    })
  })
}

function ids(entries: HistoryEntry[]) {
  return entries.map((item) => item.id)
}

beforeEach(() => {
  setActivePinia(createPinia())
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
})

describe("§20/§21 deleting one entry costs only that entry", () => {
  it("§20 leaves the remaining entries in the same order", async () => {
    const store = useHistoryStore()
    store.entries = [entry({ id: "a" }), entry({ id: "b" }), entry({ id: "c" })]

    await store.deleteEntry("b")

    expect(ids(store.entries)).toEqual(["a", "c"])
  })

  // The deleted row shares a group with another row, so the group survives it.
  // Deleting an only child legitimately takes its group with it, which would
  // make this fixture unable to tell a reshuffle from an expected removal.
  it("§20 leaves the grouping structure alone", async () => {
    const store = useHistoryStore()
    store.entries = [
      entry({ id: "a", url: "https://api.example.com/users/1" }),
      entry({ id: "b", url: "https://api.example.com/users/2" }),
      entry({ id: "c", url: "https://api.example.com/orders/1" }),
    ]
    store.setPrefixDepth(1)
    const before = store.groupedEntries.map((group) => group.label)
    expect(before).toHaveLength(2)
    expect(store.groupMode).toBe("prefix")

    await store.deleteEntry("b")

    expect(store.groupMode).toBe("prefix")
    expect(store.prefixDepth).toBe(1)
    expect(store.groupedEntries.map((group) => group.label)).toEqual(before)
  })

  it("§20 leaves the search query alone", async () => {
    const store = useHistoryStore()
    store.entries = [entry({ id: "a" }), entry({ id: "b" })]
    store.setSearchQuery("things")

    await store.deleteEntry("b")

    expect(store.searchQuery).toBe("things")
  })

  it("§21 drops the entry from the store and asks the backend to drop it too", async () => {
    const store = useHistoryStore()
    store.entries = [entry({ id: "a" }), entry({ id: "b" })]

    await store.deleteEntry("b")

    expect(ids(store.entries)).not.toContain("b")
    expect(invokeMock).toHaveBeenCalledWith("delete_history_entry", { id: "b" })
  })
})

describe("§39 starring is a toggle and every flip is written down", () => {
  it("stars an unstarred entry", async () => {
    const store = useHistoryStore()
    store.entries = [entry({ id: "a" })]

    await store.toggleStar("a")

    expect(store.entries[0].starred).toBe(true)
  })

  it("unstars it on the next call", async () => {
    const store = useHistoryStore()
    store.entries = [entry({ id: "a", starred: true })]

    await store.toggleStar("a")

    expect(store.entries[0].starred).toBe(false)
  })

  it("writes each flip through the narrow command", async () => {
    const store = useHistoryStore()
    store.entries = [entry({ id: "a" })]

    await store.toggleStar("a")
    await store.toggleStar("a")

    const calls = invokeMock.mock.calls.filter(([command]) => command === "set_history_annotation")
    expect(calls).toEqual([
      ["set_history_annotation", { id: "a", starred: true }],
      ["set_history_annotation", { id: "a", starred: false }],
    ])
  })

  // §51 on the frontend side: the payload names the row and the field, so a
  // field this build does not model cannot be blanked by a round trip.
  it("never sends a whole entry back", async () => {
    const store = useHistoryStore()
    store.entries = [entry({ id: "a" })]

    await store.setNote("a", "why this one")

    expect(invokeMock).toHaveBeenCalledWith("set_history_annotation", {
      id: "a",
      note: "why this one",
    })
  })
})

describe("§45 the in-memory cap follows the same rule as the disk", () => {
  it("keeps a starred entry that the cap would otherwise push off the list", () => {
    const store = useHistoryStore()
    // 1000 rows already, the oldest of them starred, and one more arriving.
    store.entries = series(1000, ["e0000"])

    store.appendEntry(entry({ id: "newest", timestamp: "2026-03-27T11:00:00Z" }))

    expect(store.entries).toHaveLength(1000)
    expect(ids(store.entries)).toContain("e0000")
  })

  it("still evicts the oldest unstarred entry, so the cap is not simply gone", () => {
    const store = useHistoryStore()
    store.entries = series(1000, ["e0000"])

    store.appendEntry(entry({ id: "newest", timestamp: "2026-03-27T11:00:00Z" }))

    expect(ids(store.entries)).not.toContain("e0001")
    expect(ids(store.entries)).toContain("newest")
  })

  it("lets the list grow past the cap once nothing unstarred is left to drop", () => {
    const store = useHistoryStore()
    store.entries = series(1000, ids(series(1000)))

    store.appendEntry(entry({ id: "newest", timestamp: "2026-03-27T11:00:00Z", starred: true }))

    expect(store.entries).toHaveLength(1001)
  })
})

describe("§23/§26/§48 the health counts are read, re-read, and reported", () => {
  it("§23 reads the health counts off the backend", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_history_health") {
        return { skippedLines: 3, quarantinedLines: 7 }
      }
      return undefined
    })
    const store = useHistoryStore()

    await store.loadHealth()

    expect(store.badRows).toBe(3)
  })

  it("§48 counts the unparsable lines as things clearing will delete", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_history_health") {
        return { skippedLines: 3, quarantinedLines: 0 }
      }
      return undefined
    })
    const store = useHistoryStore()
    await store.loadHealth()

    // A file with nothing readable in it still has three lines to delete.
    expect(store.entries).toHaveLength(0)
    expect(store.clearableCount).toBe(3)

    store.entries = [entry({ id: "a" }), entry({ id: "b" })]
    expect(store.clearableCount).toBe(5)
  })

  it("§26 re-reads the health counts after a successful clear", async () => {
    let skipped = 3
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_history_health") {
        return { skippedLines: skipped, quarantinedLines: 0 }
      }
      if (command === "clear_history") {
        skipped = 0
        return undefined
      }
      return undefined
    })
    const store = useHistoryStore()
    await store.loadHealth()
    expect(store.badRows).toBe(3)

    await store.clearHistory()

    expect(store.badRows).toBe(0)
    expect(store.clearableCount).toBe(0)
  })

  it("§26 leaves the stale counts up if the clear itself failed", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_history_health") {
        return { skippedLines: 3, quarantinedLines: 0 }
      }
      if (command === "clear_history") {
        throw new Error("disk is read-only")
      }
      return undefined
    })
    const store = useHistoryStore()
    await store.loadHealth()

    await expect(store.clearHistory()).rejects.toThrow("disk is read-only")

    expect(store.badRows).toBe(3)
  })
})

describe("§42 the starred filter narrows the same list", () => {
  it("lists only starred entries while it is on", () => {
    const store = useHistoryStore()
    store.entries = [entry({ id: "a" }), entry({ id: "b", starred: true })]

    store.setStarredOnly(true)

    expect(store.groupedEntries.flatMap((group) => ids(group.entries))).toEqual(["b"])
  })

  it("intersects with the search rather than replacing it", () => {
    const store = useHistoryStore()
    store.entries = [
      entry({ id: "a", url: "https://api.example.com/users", starred: true }),
      entry({ id: "b", url: "https://api.example.com/orders", starred: true }),
    ]

    store.setStarredOnly(true)
    store.setSearchQuery("orders")

    expect(store.groupedEntries.flatMap((group) => ids(group.entries))).toEqual(["b"])
  })
})
