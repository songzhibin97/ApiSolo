import { describe, expect, it } from "vitest"

import {
  buildSavedRequestFromHistory,
  defaultRequestName,
  historyEntryToRequest,
} from "../history-to-request"
import { REDACTION_SENTINEL } from "../redaction"
import { pendingRefillFields } from "../pending-refill"
import type { HistoryEntry, KeyValuePair } from "../../types"

function pair(key: string, value: string, overrides: Partial<KeyValuePair> = {}): KeyValuePair {
  return { id: `${key}-1`, enabled: true, key, value, description: "", ...overrides }
}

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "h-1",
    method: "POST",
    url: "https://api.example.com/users",
    status: 201,
    time: 42,
    size: 12,
    timestamp: "2026-03-27T10:00:00Z",
    contentType: "application/json",
    requestParams: [pair("page", "2")],
    requestHeaders: [pair("Accept", "*/*")],
    requestBodyType: "json",
    requestBodyContent: "{\"name\":\"alice\"}",
    requestBodyFormData: [],
    requestBodyBinaryPath: "",
    preRequestScript: "pre()",
    testScript: "post()",
    ...overrides,
  } as HistoryEntry
}

describe("§3 the save dialog starts from a name that came off the entry", () => {
  it("names it after the method and the last path segment", () => {
    expect(defaultRequestName(entry())).toBe("POST users")
  })

  it("falls back to the host when there is no path", () => {
    expect(defaultRequestName(entry({ url: "https://api.example.com" }))).toBe(
      "POST api.example.com",
    )
  })

  it("keeps something usable for a url that will not parse", () => {
    expect(defaultRequestName(entry({ url: "not a url", method: "get" }))).toBe("GET not a url")
  })
})

describe("§13 no placeholder text ever reaches a collection", () => {
  const redacted = entry({
    url: `https://api.example.com/users?access_token=${REDACTION_SENTINEL}`,
    requestHeaders: [pair("Authorization", REDACTION_SENTINEL), pair("Accept", "*/*")],
    requestParams: [pair("api_key", REDACTION_SENTINEL)],
    requestBodyContent: `{"user":"bob","password":"${REDACTION_SENTINEL}"}`,
  })

  it("writes no placeholder into the saved request", () => {
    const saved = buildSavedRequestFromHistory(redacted, "Saved")

    expect(JSON.stringify(saved)).not.toContain(REDACTION_SENTINEL)
  })

  it("saves each redacted field as an empty value", () => {
    const saved = buildSavedRequestFromHistory(redacted, "Saved")

    expect(saved.headers.find((item) => item.key === "Authorization")?.value).toBe("")
    expect(saved.params.find((item) => item.key === "api_key")?.value).toBe("")
    expect(saved.body.content).toBe("{\"user\":\"bob\",\"password\":\"\"}")
    expect(saved.url).toBe("https://api.example.com/users?access_token=")
  })
})

describe("§14 everything history did not rewrite is carried over unchanged", () => {
  it("matches the entry field for field", () => {
    const source = entry({
      requestHeaders: [pair("Accept", "*/*"), pair("X-Off", "nope", { enabled: false })],
      requestParams: [pair("page", "2")],
    })

    const saved = buildSavedRequestFromHistory(source, "Saved")

    expect({
      method: saved.method,
      url: saved.url,
      headers: saved.headers.map(({ enabled, key, value }) => ({ enabled, key, value })),
      params: saved.params.map(({ enabled, key, value }) => ({ enabled, key, value })),
      bodyType: saved.body.type,
      bodyContent: saved.body.content,
      preRequestScript: saved.preRequestScript,
      testScript: saved.testScript,
    }).toEqual({
      method: "POST",
      url: "https://api.example.com/users",
      headers: [
        { enabled: true, key: "Accept", value: "*/*" },
        { enabled: false, key: "X-Off", value: "nope" },
      ],
      params: [{ enabled: true, key: "page", value: "2" }],
      bodyType: "json",
      bodyContent: "{\"name\":\"alice\"}",
      preRequestScript: "pre()",
      testScript: "post()",
    })
  })

  it("hands the same request shape to the refill check that the panel would see", () => {
    const request = historyEntryToRequest(entry())

    expect(request.method).toBe("POST")
    expect(request.url).toBe("https://api.example.com/users")
    expect(request.headers.map((item) => item.key)).toEqual(["Accept"])
    expect(request.body.type).toBe("json")
  })
})

describe("D17 §3 legacy URL-only history uses the same normalized request shape", () => {
  const legacy = entry({
    url: `https://api.example.com/users?apikey=${REDACTION_SENTINEL}&page=1`,
    requestParams: undefined,
  })

  it("adapts every URL row into params and keeps the redacted row identity", () => {
    const request = historyEntryToRequest(legacy)

    expect(request.params.map(({ key, value, redacted }) => [key, value, redacted === true])).toEqual([
      ["apikey", "", true],
      ["page", "1", false],
    ])
    expect(pendingRefillFields(request).map(({ source, name }) => [source, name])).toEqual([
      ["query", "apikey"],
    ])
  })

  it("writes URL-only params into the saved request without persisting the marker", () => {
    const saved = buildSavedRequestFromHistory(legacy, "Legacy")

    expect(saved.params.map(({ key, value }) => [key, value])).toEqual([
      ["apikey", ""],
      ["page", "1"],
    ])
    expect(JSON.stringify(saved.params)).not.toContain("redacted")
  })
})
