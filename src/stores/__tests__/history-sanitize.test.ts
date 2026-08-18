import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock("../../utils/invoke", () => ({ invoke: invokeMock }))

import { useHistoryStore } from "../history"
import { REDACTION_SENTINEL } from "../../utils/redaction"
import type { HistoryEntry } from "../../types"

// A row written before field-name redaction shipped on 2026-04-27.
function legacyEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "legacy-1",
    method: "GET",
    url: "https://api.example.com/me",
    status: 200,
    time: 42,
    size: 12,
    timestamp: "2026-04-09T08:15:00.000Z",
    contentType: "application/json",
    requestHeaders: [
      { id: "", enabled: true, key: "Cookie", value: "sessionid=abc123", description: "" },
    ],
    ...overrides,
  }
}

function cleanEntry(): HistoryEntry {
  return {
    id: "clean-1",
    method: "GET",
    url: "https://api.example.com/health",
    status: 200,
    time: 5,
    size: 2,
    timestamp: "2026-04-28T08:15:00.000Z",
    contentType: "application/json",
    requestHeaders: [{ id: "", enabled: true, key: "Accept", value: "*/*", description: "" }],
  }
}

describe("useHistoryStore.loadHistory", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMock.mockReset()
  })

  it("sanitizes legacy plaintext entries before exposing them", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "load_history") {
        return [legacyEntry(), cleanEntry()]
      }

      if (command === "update_history_entries") {
        return null
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const store = useHistoryStore()
    await store.loadHistory()

    const sanitized = store.entries.find((entry) => entry.id === "legacy-1")
    expect(sanitized?.requestHeaders?.[0].value).toBe(REDACTION_SENTINEL)
    expect(JSON.stringify(store.entries)).not.toContain("sessionid=abc123")
    expect(store.entries.find((entry) => entry.id === "clean-1")?.requestHeaders?.[0].value).toBe("*/*")
  })

  it("writes back exactly once and then converges", async () => {
    let disk: HistoryEntry[] = [legacyEntry(), cleanEntry()]

    invokeMock.mockImplementation(async (command: string, payload?: Record<string, unknown>) => {
      if (command === "load_history") {
        return disk.map((entry) => JSON.parse(JSON.stringify(entry)) as HistoryEntry)
      }

      if (command === "update_history_entries") {
        const updates = (payload as { entries: HistoryEntry[] }).entries
        disk = disk.map((row) => updates.find((update) => update.id === row.id) ?? row)
        return null
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const store = useHistoryStore()
    await store.loadHistory()

    const writeBacks = invokeMock.mock.calls.filter(([command]) => command === "update_history_entries")
    expect(writeBacks).toHaveLength(1)
    expect((writeBacks[0][1] as { entries: HistoryEntry[] }).entries.map((entry) => entry.id)).toEqual([
      "legacy-1",
    ])

    await store.loadHistory()

    expect(
      invokeMock.mock.calls.filter(([command]) => command === "update_history_entries"),
    ).toHaveLength(1)
  })

  it("does not write back and rethrows when history cannot be read", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "load_history") {
        throw new Error("Failed to parse history entry: expected value at line 1 column 1")
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const store = useHistoryStore()

    await expect(store.loadHistory()).rejects.toThrow("Failed to parse history entry")
    expect(invokeMock.mock.calls.some(([command]) => command === "update_history_entries")).toBe(false)
    expect(store.entries).toEqual([])
  })

  it("keeps the panel clean when the write-back itself fails", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "load_history") {
        return [legacyEntry()]
      }

      if (command === "update_history_entries") {
        throw new Error("disk full")
      }

      throw new Error(`Unexpected invoke: ${command}`)
    })

    const store = useHistoryStore()
    await store.loadHistory()

    expect(store.entries[0].requestHeaders?.[0].value).toBe(REDACTION_SENTINEL)
  })
})
