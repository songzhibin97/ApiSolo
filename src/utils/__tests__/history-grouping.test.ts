import { describe, expect, it } from "vitest"
import type { HistoryEntry } from "../../types"
import {
  filterEntries,
  groupByMethod,
  groupByPrefix,
} from "../history-grouping"

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: crypto.randomUUID(),
    method: "GET",
    url: "https://api.example.com/api/v1/users",
    status: 200,
    time: 100,
    size: 1024,
    timestamp: new Date().toISOString(),
    contentType: "application/json",
    ...overrides,
  }
}

describe("groupByPrefix", () => {
  it("groups entries by URL prefix", () => {
    const entries: HistoryEntry[] = [
      makeEntry({ url: "https://api.example.com/api/v1/users/1" }),
      makeEntry({ url: "https://api.example.com/api/v1/users/2" }),
      makeEntry({ url: "https://api.example.com/api/v1/users" }),
      makeEntry({ url: "https://api.example.com/api/v1/posts/1" }),
      makeEntry({ url: "https://api.example.com/api/v1/posts" }),
      makeEntry({ url: "https://api.example.com/auth/login" }),
      makeEntry({ url: "https://api.example.com/auth/register" }),
    ]

    const groups = groupByPrefix(entries, 2)

    // /api/v1/users, /api/v1/posts → group "/api/v1"
    // /auth/login → group "/auth/login"
    // /auth/register → group "/auth/register"
    expect(groups).toHaveLength(3)
    const labels = groups.map((g) => g.label)
    expect(labels).toContain("api.example.com /api/v1")
    expect(labels).toContain("api.example.com /auth/login")
    expect(labels).toContain("api.example.com /auth/register")
  })

  it("produces different groups at different depths", () => {
    const entries: HistoryEntry[] = [
      makeEntry({ url: "https://api.example.com/api/v1/users" }),
      makeEntry({ url: "https://api.example.com/api/v1/posts" }),
      makeEntry({ url: "https://api.example.com/api/v2/users" }),
    ]

    const depth1 = groupByPrefix(entries, 1)
    const depth3 = groupByPrefix(entries, 3)

    expect(depth1).toHaveLength(1)
    expect(depth3).toHaveLength(3)
  })

  it("returns empty array for empty entries", () => {
    expect(groupByPrefix([], 2)).toHaveLength(0)
  })
})

describe("groupByMethod", () => {
  it("groups entries by HTTP method", () => {
    const entries: HistoryEntry[] = [
      makeEntry({ method: "GET" }),
      makeEntry({ method: "GET" }),
      makeEntry({ method: "POST" }),
      makeEntry({ method: "DELETE" }),
    ]

    const groups = groupByMethod(entries)
    const labels = groups.map((g) => g.label)

    expect(groups).toHaveLength(3)
    expect(labels).toContain("GET")
    expect(labels).toContain("POST")
    expect(labels).toContain("DELETE")
    expect(groups.find((g) => g.label === "GET")!.count).toBe(2)
  })
})

describe("filterEntries", () => {
  it("filters entries by URL keyword", () => {
    const entries: HistoryEntry[] = [
      makeEntry({ url: "https://api.example.com/users" }),
      makeEntry({ url: "https://api.example.com/posts" }),
      makeEntry({ url: "https://api.example.com/users/123" }),
    ]

    const filtered = filterEntries(entries, "users")
    expect(filtered).toHaveLength(2)
  })

  it("returns all entries when query is empty", () => {
    const entries = [makeEntry(), makeEntry()]
    expect(filterEntries(entries, "")).toHaveLength(2)
    expect(filterEntries(entries, "  ")).toHaveLength(2)
  })
})

describe("§37/§42 notes are searchable and stars are filterable", () => {
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

  const noted = entry({ id: "noted", url: "https://api.example.com/a", note: "the flaky one" })
  const plain = entry({ id: "plain", url: "https://api.example.com/b" })
  const starred = entry({ id: "starred", url: "https://api.example.com/c", starred: true })

  it("§37 finds an entry by a word that only appears in its note", () => {
    expect(filterEntries([noted, plain], "flaky").map((item) => item.id)).toEqual(["noted"])
  })

  it("§37 returns nothing when the word is in neither the url nor the note", () => {
    expect(filterEntries([noted, plain], "nowhere")).toEqual([])
  })

  it("§38 stops matching once the note is cleared", () => {
    const cleared = { ...noted, note: undefined }

    expect(filterEntries([cleared, plain], "flaky")).toEqual([])
  })

  it("§42 lists only starred entries while the filter is on", () => {
    expect(filterEntries([noted, plain, starred], "", true).map((item) => item.id)).toEqual([
      "starred",
    ])
  })

  it("§42 restores the full list when the filter goes off", () => {
    expect(filterEntries([noted, plain, starred], "", false)).toHaveLength(3)
  })

  it("§42 intersects the filter with the search instead of overriding it", () => {
    const starredElsewhere = entry({ id: "other", url: "https://api.example.com/z", starred: true })

    expect(
      filterEntries([noted, plain, starred, starredElsewhere], "/c", true).map((item) => item.id),
    ).toEqual(["starred"])
  })

  // Two groups, each holding one starred and one plain row. Filtering must
  // thin every group without dissolving any of them: a fixture where a whole
  // group disappears cannot tell "still grouped" apart from "flattened".
  it("§42 keeps the grouping shape, only thinner", () => {
    const rows = [
      entry({ id: "s1", url: "https://api.example.com/users/1", starred: true }),
      entry({ id: "p1", url: "https://api.example.com/users/2" }),
      entry({ id: "s2", url: "https://api.example.com/orders/1", starred: true }),
      entry({ id: "p2", url: "https://api.example.com/orders/2" }),
    ]

    const all = groupByPrefix(filterEntries(rows, "", false), 1)
    const onlyStarred = groupByPrefix(filterEntries(rows, "", true), 1)

    expect(onlyStarred.map((group) => group.label)).toEqual(all.map((group) => group.label))
    expect(all.map((group) => group.count)).toEqual([2, 2])
    expect(onlyStarred.map((group) => group.count)).toEqual([1, 1])
  })
})
