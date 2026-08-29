import { describe, expect, it } from "vitest"

import { REDACTION_SENTINEL } from "../redaction"
import { mergeHistoryQueryRows } from "../history-query"
import type { KeyValuePair } from "../../types"

function pair(key: string, value: string, overrides: Partial<KeyValuePair> = {}): KeyValuePair {
  return {
    id: overrides.id ?? `${key}-${value || "blank"}`,
    enabled: true,
    key,
    value,
    description: "",
    ...overrides,
  }
}

function shape(rows: KeyValuePair[]) {
  return rows.map(({ key, value, redacted }) => [key, value, redacted === true] as const)
}

describe("D17 §6 history query copies merge without losing or duplicating rows", () => {
  it.each([
    {
      name: "url has two additional repeated rows",
      stored: [pair("tag", "a")],
      url: "https://api.example.com/x?tag=a&tag=b&tag=c",
      expected: [["tag", "a", false], ["tag", "b", false], ["tag", "c", false]],
    },
    {
      name: "url surplus precedes the row shared with params",
      stored: [pair("tag", "a")],
      url: "https://api.example.com/x?tag=b&tag=a",
      expected: [["tag", "a", false], ["tag", "b", false]],
    },
    {
      name: "both copies contain the same two sensitive rows",
      stored: [pair("apikey", REDACTION_SENTINEL), pair("apikey", "")],
      url: `https://api.example.com/x?apikey=${REDACTION_SENTINEL}&apikey=`,
      expected: [["apikey", "", true], ["apikey", "", true]],
    },
    {
      name: "params real value wins over the stale url copy",
      stored: [pair("apikey", "REAL")],
      url: `https://api.example.com/x?apikey=${REDACTION_SENTINEL}`,
      expected: [["apikey", "REAL", false]],
    },
    {
      name: "legacy url-only history contributes every row",
      stored: [],
      url: `https://api.example.com/x?apikey=${REDACTION_SENTINEL}&page=1`,
      expected: [["apikey", "", true], ["page", "1", false]],
    },
    {
      name: "url contributes only its per-key surplus",
      stored: [pair("apikey", "REAL")],
      url: `https://api.example.com/x?apikey=${REDACTION_SENTINEL}&apikey=`,
      expected: [["apikey", "REAL", false], ["apikey", "", true]],
    },
  ])("$name", ({ stored, url, expected }) => {
    expect(shape(mergeHistoryQueryRows(stored, url))).toEqual(expected)
  })

  it("keeps every stored row ahead of url contributions", () => {
    const rows = mergeHistoryQueryRows(
      [pair("page", "2"), pair("tag", "a")],
      "https://api.example.com/x?tag=a&debug=1",
    )

    expect(rows.map(({ key, value }) => [key, value])).toEqual([
      ["page", "2"],
      ["tag", "a"],
      ["debug", "1"],
    ])
  })

  it("cancels identical pairs one for one when the URL repeats them", () => {
    const rows = mergeHistoryQueryRows(
      [pair("tag", "a", { id: "stored" })],
      "https://api.example.com/x?tag=a&tag=a",
    )

    expect(rows.map(({ key, value }) => [key, value])).toEqual([
      ["tag", "a"],
      ["tag", "a"],
    ])
  })

  it("uses an existing row marker during the import-time union", () => {
    const rows = mergeHistoryQueryRows(
      [pair("apikey", "", { id: "marked", redacted: true }), pair("apikey", "", { id: "plain" })],
      "https://api.example.com/x",
    )

    expect(rows.map(({ id, redacted }) => [id, redacted === true])).toEqual([
      ["marked", true],
      ["plain", true],
    ])
  })
})
