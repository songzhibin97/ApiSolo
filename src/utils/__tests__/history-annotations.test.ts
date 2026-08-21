import { describe, expect, it } from "vitest"

import { applyAnnotation, normalizeNote } from "../history-annotations"
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

function noteOf(entries: HistoryEntry[], id: string) {
  return entries.find((item) => item.id === id)?.note
}

describe("§30 a note belongs to one send, not to an endpoint", () => {
  // Same method and same url, two different sends. Anything that identifies the
  // row by its contents rather than its id annotates both.
  const twoSendsOfOneEndpoint = [
    entry({ id: "first", url: "https://api.example.com/login" }),
    entry({ id: "second", url: "https://api.example.com/login" }),
  ]

  it("annotates only the row whose id was given", () => {
    const result = applyAnnotation(twoSendsOfOneEndpoint, "first", { note: "the failing one" })

    expect(noteOf(result, "first")).toBe("the failing one")
    expect(noteOf(result, "second")).toBeUndefined()
  })

  it("leaves an unrelated row's existing note alone", () => {
    const rows = [
      entry({ id: "target", url: "https://api.example.com/a" }),
      entry({ id: "other", url: "https://api.example.com/b", note: "written earlier" }),
    ]

    const result = applyAnnotation(rows, "target", { note: "written now" })

    expect(noteOf(result, "other")).toBe("written earlier")
  })

  it("changes nothing when no row carries that id", () => {
    const result = applyAnnotation(twoSendsOfOneEndpoint, "not-here", { note: "orphan" })

    expect(result.map((item) => item.note)).toEqual([undefined, undefined])
  })
})

describe("§32 a note is trimmed, and a blank one is no note at all", () => {
  it("stores the trimmed text", () => {
    const result = applyAnnotation([entry()], "e-1", { note: "  padded  " })

    expect(noteOf(result, "e-1")).toBe("padded")
  })

  it("folds whitespace-only text to no note", () => {
    const result = applyAnnotation([entry()], "e-1", { note: "   " })

    expect(noteOf(result, "e-1")).toBeUndefined()
  })

  it("normalizes the same way when called directly", () => {
    expect(normalizeNote("  kept  ")).toBe("kept")
    expect(normalizeNote("\n\t ")).toBeUndefined()
  })
})

describe("§38 clearing a note removes it rather than emptying it", () => {
  it("leaves no note behind after an explicit clear", () => {
    const withNote = applyAnnotation([entry()], "e-1", { note: "temporary" })

    const cleared = applyAnnotation(withNote, "e-1", { note: "" })

    expect(noteOf(cleared, "e-1")).toBeUndefined()
  })

  it("keeps the star while the note is cleared", () => {
    const annotated = applyAnnotation([entry()], "e-1", { note: "temporary", starred: true })

    const cleared = applyAnnotation(annotated, "e-1", { note: "" })

    expect(cleared[0].starred).toBe(true)
    expect(cleared[0].note).toBeUndefined()
  })
})

describe("§54 an unmentioned field is not an instruction to clear it", () => {
  it("keeps the note when only the star is written", () => {
    const withNote = applyAnnotation([entry()], "e-1", { note: "keep me" })

    const starred = applyAnnotation(withNote, "e-1", { starred: true })

    expect(noteOf(starred, "e-1")).toBe("keep me")
    expect(starred[0].starred).toBe(true)
  })

  it("keeps the star when only the note is written", () => {
    const starred = applyAnnotation([entry()], "e-1", { starred: true })

    const withNote = applyAnnotation(starred, "e-1", { note: "later" })

    expect(withNote[0].starred).toBe(true)
  })
})
