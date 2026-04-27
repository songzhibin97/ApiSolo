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
