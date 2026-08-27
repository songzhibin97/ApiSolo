import { beforeEach, describe, expect, it } from "vitest"
import { createPinia, setActivePinia } from "pinia"

import { useTabsStore } from "../tabs"
import { historyEntryToRequest } from "../../utils/history-to-request"
import { identityTuple, pendingRefillFields } from "../../utils/pending-refill"
import { REDACTION_SENTINEL, sanitizeHistoryEntry } from "../../utils/redaction"
import { buildUrlWithParams } from "../../utils/url-params"
import type { HistoryEntry, KeyValuePair, Tab } from "../../types"

function pair(key: string, value: string): KeyValuePair {
  return { id: "", enabled: true, key, value, description: "" }
}

function makeHistoryEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: crypto.randomUUID(),
    method: "POST",
    url: "https://api.example.com/users?active=true",
    status: 200,
    time: 120,
    size: 256,
    timestamp: new Date().toISOString(),
    contentType: "application/json",
    ...overrides,
  }
}

describe("useTabsStore.openHistoryEntry", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it("restores request snapshots from history", () => {
    const store = useTabsStore()

    store.openHistoryEntry(
      makeHistoryEntry({
        requestParams: [
          {
            id: "param-1",
            enabled: true,
            key: "page",
            value: "1",
            description: "",
          },
        ],
        requestHeaders: [
          {
            id: "header-1",
            enabled: true,
            key: "X-Test",
            value: "enabled",
            description: "",
          },
        ],
        requestBodyType: "json",
        requestBodyContent: "{\"name\":\"alice\"}",
        requestAuthType: "bearer",
        requestAuth: {
          type: "bearer",
          bearer: { token: "secret-token" },
        },
      }),
    )

    expect(store.tabs).toHaveLength(2)
    const openedTab = store.activeTab
    expect(openedTab.method).toBe("POST")
    expect(openedTab.url).toBe("https://api.example.com/users?active=true")
    expect(openedTab.label).toBe("/users?active=true")
    // Both copies of the query, not whichever one happened to be non-empty.
    // This fixture's url carries `active` and its stored params carry `page`;
    // reading only the params dropped `active` from a request that had it, and
    // the rows are what the send path puts on the wire.
    expect(openedTab.params.map((item) => item.key)).toEqual(["page", "active"])
    expect(openedTab.headers).toHaveLength(1)
    expect(openedTab.headers[0].key).toBe("X-Test")
    expect(openedTab.body.type).toBe("json")
    expect(openedTab.body.content).toBe("{\"name\":\"alice\"}")
    expect(openedTab.auth.type).toBe("bearer")
    expect(openedTab.auth.bearer?.token).toBe("secret-token")
  })

  it("restores response snapshots from history", () => {
    const store = useTabsStore()

    store.openHistoryEntry(
      makeHistoryEntry({
        status: 201,
        statusText: "Created",
        time: 236,
        size: 17,
        contentType: "application/json",
        timings: {
          dnsLookup: 3,
          tcpConnect: 4,
          tlsHandshake: 5,
          ttfb: 200,
          download: 9,
          total: 236,
        },
        responseBody: "{\"ok\":true}",
        responseHeaders: [["content-type", "application/json"]],
      }),
    )

    expect(store.activeTab.response).toEqual({
      status: 201,
      statusText: "Created",
      headers: [["content-type", "application/json"]],
      body: "{\"ok\":true}",
      size: 17,
      time: 236,
      contentType: "application/json",
      timings: {
        dnsLookup: 3,
        tcpConnect: 4,
        tlsHandshake: 5,
        ttfb: 200,
        download: 9,
        total: 236,
      },
      bodyKind: "text",
      bodyTruncated: false,
    })
  })

  describe("§56 the response body kind comes back with the response", () => {
    it("restores the kind the entry was written with", () => {
      const store = useTabsStore()

      store.openHistoryEntry(
        makeHistoryEntry({
          status: 200,
          // Built at runtime on purpose. Written as literal bytes this file
          // stops being text: git diffs it as binary and no reviewer can read
          // the change. The bytes matter because they are what makes a body
          // binary upstream, so the fixture keeps them without keeping them in
          // the source.
          responseBody: `${String.fromCharCode(0, 1)}binary`,
          responseBodyKind: "binary",
        }),
      )

      expect(store.activeTab.response?.bodyKind).toBe("binary")
    })

    it("reads an entry written before the field existed as text", () => {
      const store = useTabsStore()
      const legacy = makeHistoryEntry({ status: 200, responseBody: "hello" })
      delete (legacy as { responseBodyKind?: unknown }).responseBodyKind

      store.openHistoryEntry(legacy)

      expect(store.activeTab.response?.bodyKind).toBe("text")
    })
  })

  // The reason phrase used to be fabricated on restore: every 2xx came back
  // as "OK", so a stored `201 Created` reopened as `201 OK`.
  describe("the response statusText comes back with the response", () => {
    it("restores the statusText the entry was written with", () => {
      const store = useTabsStore()

      store.openHistoryEntry(makeHistoryEntry({ status: 201, statusText: "Created" }))

      expect(store.activeTab.response?.statusText).toBe("Created")
    })

    it("reads a 2xx entry written before the field existed without inventing OK", () => {
      const store = useTabsStore()
      const legacy = makeHistoryEntry({ status: 201 })
      delete (legacy as { statusText?: unknown }).statusText

      store.openHistoryEntry(legacy)

      // Empty, not "OK": the phrase was never recorded, and the UI must not
      // claim server text that does not exist.
      expect(store.activeTab.response?.statusText).toBe("")
    })
  })

  describe("D09 §17 the truncation flag comes back with the response", () => {
    it("restores the flag the entry was written with", () => {
      const store = useTabsStore()

      store.openHistoryEntry(
        makeHistoryEntry({ status: 200, responseBody: "prefix", responseBodyTruncated: true }),
      )

      expect(store.activeTab.response?.bodyTruncated).toBe(true)
    })

    it("reads an entry written before the field existed as not truncated", () => {
      const store = useTabsStore()
      const legacy = makeHistoryEntry({ status: 200, responseBody: "hello" })
      delete (legacy as { responseBodyTruncated?: unknown }).responseBodyTruncated

      store.openHistoryEntry(legacy)

      expect(store.activeTab.response?.bodyTruncated).toBe(false)
    })

    it("never infers truncation from the body length", () => {
      const store = useTabsStore()

      // A very long stored body with the flag explicitly false stays false:
      // the flag is carried, not reconstructed from what the text looks like.
      store.openHistoryEntry(
        makeHistoryEntry({
          status: 200,
          responseBody: "a".repeat(60_000),
          responseBodyTruncated: false,
        }),
      )

      expect(store.activeTab.response?.bodyTruncated).toBe(false)
    })
  })

  it("hydrates an existing matching empty tab from history", () => {
    const store = useTabsStore()
    const existingTabId = store.activeTab.id

    store.updateTab(existingTabId, {
      method: "POST",
      url: "https://api.example.com/users",
      params: [
        {
          id: "current-param",
          enabled: true,
          key: "active",
          value: "true",
          description: "",
        },
      ],
      body: {
        ...store.activeTab.body,
        type: "json",
        content: "{\"name\":\"alice\"}",
      },
    })

    store.openHistoryEntry(
      makeHistoryEntry({
        method: "POST",
        url: "https://api.example.com/users",
        requestParams: [
          {
            id: "history-param",
            enabled: true,
            key: "active",
            value: "true",
            description: "",
          },
        ],
        requestBodyType: "json",
        requestBodyContent: "{\"name\":\"alice\"}",
        responseBody: "{\"ok\":true}",
        responseHeaders: [["content-type", "application/json"]],
      }),
    )

    expect(store.tabs).toHaveLength(1)
    expect(store.activeTab.id).toBe(existingTabId)
    expect(store.activeTab.response?.body).toBe("{\"ok\":true}")
  })

  it("restores structured form-data and binary history payloads", () => {
    const store = useTabsStore()

    store.openHistoryEntry(
      makeHistoryEntry({
        requestBodyType: "form-data",
        requestBodyFormData: [
          {
            id: "fd-1",
            enabled: true,
            key: "file",
            value: "",
            description: "",
            valueType: "file",
            fileName: "hello.txt",
            fileContent: "aGVsbG8=",
            contentType: "text/plain",
          },
        ],
        requestBodyBinaryPath: "payload.bin",
        requestBodyBinaryContent: "AQID",
      }),
    )

    expect(store.activeTab.body.formData).toHaveLength(1)
    expect(store.activeTab.body.formData[0].valueType).toBe("file")
    expect(store.activeTab.body.formData[0].fileName).toBe("hello.txt")
    expect(store.activeTab.body.binaryPath).toBe("payload.bin")
    expect(store.activeTab.body.binaryContent).toBe("AQID")
  })

  it("sanitizes legacy raw file paths from history snapshots", () => {
    const store = useTabsStore()

    store.openHistoryEntry(
      makeHistoryEntry({
        requestBodyType: "form-data",
        requestBodyFormData: [
          {
            id: "fd-legacy",
            enabled: true,
            key: "file",
            value: "",
            description: "",
            valueType: "file",
            fileName: "",
            filePath: "/tmp/secrets/hello.txt",
            fileContent: undefined,
            contentType: "text/plain",
          },
        ],
        requestBodyBinaryPath: "/tmp/secrets/payload.bin",
      }),
    )

    expect(store.activeTab.body.formData[0].fileName).toBe("hello.txt")
    expect(store.activeTab.body.formData[0].filePath).toBe("")
    expect(store.activeTab.body.binaryPath).toBe("payload.bin")
  })

  it("keeps default tab state for legacy history entries", () => {
    const store = useTabsStore()

    store.openHistoryEntry(makeHistoryEntry({ method: "get" }))

    const openedTab = store.activeTab
    expect(openedTab.method).toBe("GET")
    expect(openedTab.params).toHaveLength(1)
    expect(openedTab.params[0].key).toBe("active")
    expect(openedTab.params[0].value).toBe("true")
    expect(openedTab.headers).toHaveLength(0)
    expect(openedTab.body.type).toBe("none")
    expect(openedTab.auth.type).toBe("none")
  })

  it("opens a new tab when method and url match but history snapshots differ", () => {
    const store = useTabsStore()
    const sharedUrl = "https://api.example.com/users/1"

    store.openHistoryEntry(
      makeHistoryEntry({
        method: "POST",
        url: sharedUrl,
        requestBodyType: "json",
        requestBodyContent: "{\"name\":\"alice\"}",
      }),
    )

    store.openHistoryEntry(
      makeHistoryEntry({
        method: "POST",
        url: sharedUrl,
        requestBodyType: "json",
        requestBodyContent: "{\"name\":\"bob\"}",
      }),
    )

    expect(store.tabs).toHaveLength(3)
    expect(store.activeTab.body.content).toBe("{\"name\":\"bob\"}")
  })

  describe("§1 sentinel values never come back into a tab", () => {
    it.each([
      ["headers", "requestHeaders"],
      ["params", "requestParams"],
      ["formData", "requestBodyFormData"],
    ] as const)("blanks sentinel values in %s", (collection, entryField) => {
      const store = useTabsStore()

      store.openHistoryEntry(
        makeHistoryEntry({
          url: "https://api.example.com/users",
          requestParams: [pair("page", "1")],
          requestHeaders: [pair("X-Test", "enabled")],
          requestBodyType: "form-data",
          requestBodyFormData: [pair("note", "keep")],
          [entryField]: [pair("Cookie", REDACTION_SENTINEL), pair("page", "1")],
        }),
      )

      const opened = store.activeTab
      const rows = collection === "formData" ? opened.body.formData : opened[collection]

      expect(rows[0]).toEqual(expect.objectContaining({ key: "Cookie", value: "", redacted: true }))
      expect(rows[1]).toEqual(expect.objectContaining({ key: "page", value: "1" }))
      expect(rows[1].redacted).toBeUndefined()
      expect(pendingRefillFields(opened).length).toBeGreaterThan(0)
    })
  })

  describe("§2 sentinel bodies are structurally cleared", () => {
    it.each([
      [
        "json",
        `{"user":"bob","password":"${REDACTION_SENTINEL}"}`,
        '{"user":"bob","password":""}',
        ["password"],
      ],
      [
        "form-urlencoded",
        `user=bob&password=${REDACTION_SENTINEL}`,
        "user=bob&password=",
        ["password"],
      ],
      ["raw", `Cookie: ${REDACTION_SENTINEL}`, "Cookie: ", ["Cookie"]],
    ])("clears sentinel body for %s body", (bodyType, content, expected, names) => {
      const store = useTabsStore()

      store.openHistoryEntry(
        makeHistoryEntry({ requestBodyType: bodyType, requestBodyContent: content }),
      )

      expect(store.activeTab.body.content).toBe(expected)
      // The names are the deliverable, not a flag: the panel save dialog has to
      // be able to say which keys need typing back in, and by this point the
      // body text no longer holds anything to find them by.
      expect(store.activeTab.bodyRedactedFields).toEqual(names)
      expect(pendingRefillFields(store.activeTab).length).toBeGreaterThan(0)
    })

    it("leaves a body whose prose merely mentions the sentinel alone", () => {
      const store = useTabsStore()
      const content = `note: the string ${REDACTION_SENTINEL} appears here`

      store.openHistoryEntry(
        makeHistoryEntry({ requestBodyType: "raw", requestBodyContent: content }),
      )

      expect(store.activeTab.body.content).toBe(content)
      expect(store.activeTab.bodyRedactedFields).toEqual([])
      expect(pendingRefillFields(store.activeTab)).toEqual([])
    })
  })

  describe("§10 the restored response is display-only", () => {
    it("keeps restored response headers out of the request headers", () => {
      const store = useTabsStore()

      store.openHistoryEntry(
        makeHistoryEntry({
          url: "https://api.example.com/users",
          requestParams: [],
          responseHeaders: [
            ["set-cookie", "sid=abcdef123456"],
            ["content-type", "application/json"],
          ],
          responseBody: '{"ok":true}',
        }),
      )

      expect(store.activeTab.headers).toHaveLength(0)
      expect(store.activeTab.response?.headers).toHaveLength(2)
    })
  })

  describe("§41 early entries without headers or params", () => {
    it("opens a legacy entry without headers or params cleanly", () => {
      const store = useTabsStore()

      store.openHistoryEntry(
        makeHistoryEntry({
          url: "https://api.example.com/users",
          requestParams: undefined,
          requestHeaders: undefined,
          requestBodyType: undefined,
          requestBodyContent: undefined,
        }),
      )

      const opened = store.activeTab
      expect(opened.headers).toEqual([])
      expect(opened.params).toEqual([])
      expect(opened.body.type).toBe("none")
      expect(opened.bodyRedactedFields).toEqual([])
      expect(pendingRefillFields(opened)).toEqual([])
    })
  })
})

/**
 * §13-§14 — a placeholder must not survive into a tab, because the panel's save
 * writes the url straight into the collection file and it would leave with the
 * export. Clearing it does not weaken the gate: the parameter rows carry the
 * marker, and they are what the list is built from.
 */
describe("§14 the url loses its placeholders on load, the gate does not", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it("clears the placeholder out of the url and still lists the parameter", () => {
    const store = useTabsStore()

    store.openHistoryEntry(
      makeHistoryEntry({
        url: `https://api.example.com/users?apikey=${REDACTION_SENTINEL}&page=1`,
        requestParams: undefined,
        requestBodyType: "none",
        requestBodyContent: undefined,
      }),
    )

    const opened = store.activeTab

    expect(opened.url).not.toContain(REDACTION_SENTINEL)
    expect(opened.url).toBe("https://api.example.com/users?apikey=&page=1")
    expect(pendingRefillFields(opened).map(identityTuple)).toContainEqual([
      "refill",
      "query",
      null,
      "apikey",
    ])
  })

  /**
   * The order the two steps run in is load-bearing. Rows are derived from the
   * url for history entries written before parameters were stored separately;
   * derive them from an already-cleared url and they arrive empty with nothing
   * to mark, and that whole generation of entries loses its gate silently.
   */
  it("still marks rows derived from the url rather than stored beside it", () => {
    const store = useTabsStore()

    store.openHistoryEntry(
      makeHistoryEntry({
        url: `https://api.example.com/users?apikey=${REDACTION_SENTINEL}`,
        requestParams: undefined,
        requestBodyType: "none",
        requestBodyContent: undefined,
      }),
    )

    const row = store.activeTab.params.find((item) => item.key === "apikey")

    expect(row).toEqual(expect.objectContaining({ value: "", redacted: true }))
  })

  it("leaves a url with nothing redacted in it untouched", () => {
    const store = useTabsStore()
    const url = "https://api.example.com/users?page=1"

    store.openHistoryEntry(
      makeHistoryEntry({ url, requestBodyType: "none", requestBodyContent: undefined }),
    )

    expect(store.activeTab.url).toBe(url)
  })
})

/**
 * A history entry records its query twice — as `requestParams` and inside the
 * url — and the panel used to read whichever one was non-empty. The two entry
 * points then answered the same question differently about the same row, which
 * is the disagreement this slice exists to remove.
 */
describe("the query rows a history entry describes come from both copies of it", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  /**
   * A second-generation entry: a row opened from history and sent again. Built
   * by the code that writes history rather than by hand — `buildHistoryEntry`
   * ends in `sanitizeHistoryEntry`, and the detail these tests turn on is one a
   * hand-written fixture gets wrong. The url redactor stamps a placeholder on
   * any sensitive key, the pair redactor leaves an already-empty value alone, so
   * the same blank parameter comes back as `[redacted]` in the url and as `""`
   * in the params.
   */
  function resent(tab: Tab): HistoryEntry {
    return sanitizeHistoryEntry(makeHistoryEntry({ url: tab.url, requestParams: tab.params }))
  }

  function panelGate(tab: Tab) {
    return pendingRefillFields(tab).map(identityTuple)
  }

  function rowGate(entry: HistoryEntry) {
    return pendingRefillFields(historyEntryToRequest(entry)).map(identityTuple)
  }

  /**
   * MISSED GATE. The reported defect: a parameter only the url has. Reading the
   * stored params alone dropped it from the rows, and the rows are what the send
   * path puts on the wire — so it was not hidden, it was gone — while the very
   * next step cleared the placeholder out of the url, taking the last sign of it
   * off the screen.
   */
  it("keeps a parameter the url has and the stored params do not", () => {
    const store = useTabsStore()

    store.openHistoryEntry(
      makeHistoryEntry({
        url: `https://api.example.com/users?apikey=${REDACTION_SENTINEL}&page=1`,
        requestParams: [pair("page", "1")],
        requestBodyType: "none",
        requestBodyContent: undefined,
      }),
    )

    const opened = store.activeTab

    expect(opened.params.map((item) => item.key)).toEqual(["page", "apikey"])
    expect(opened.params[1]).toEqual(
      expect.objectContaining({ key: "apikey", value: "", redacted: true }),
    )
    // The rendered url bar is the same list, so the parameter is back on screen
    // as well as back in the request.
    expect(buildUrlWithParams(opened.url, opened.params)).toBe(
      "https://api.example.com/users?page=1&apikey=",
    )
    expect(panelGate(opened)).toEqual([["refill", "query", null, "apikey"]])
  })

  /**
   * MISSED GATE, the second shape. Here the key is in both copies, so nothing
   * vanishes — but only the url still says it was blanked, and the panel that
   * ignored the url reported the request as complete while the row beside it
   * reported a credential to type back in.
   */
  it("marks a blank row a key the url blanked", () => {
    const store = useTabsStore()

    store.openHistoryEntry(
      makeHistoryEntry({
        url: `https://api.example.com/users?apikey=${REDACTION_SENTINEL}`,
        requestParams: undefined,
        requestBodyType: "none",
        requestBodyContent: undefined,
      }),
    )

    const entry = resent(store.activeTab)
    // Self-check on the fixture: the two copies really do disagree, which is
    // the only reason this test has anything to catch.
    expect(entry.url).toContain(`apikey=${REDACTION_SENTINEL}`)
    expect(entry.requestParams).toEqual([expect.objectContaining({ key: "apikey", value: "" })])

    store.openHistoryEntry(entry)

    expect(store.activeTab.params).toEqual([
      expect.objectContaining({ key: "apikey", value: "", redacted: true }),
    ])
    expect(panelGate(store.activeTab)).toEqual([["refill", "query", null, "apikey"]])
  })

  /**
   * FALSE GATE. Both copies hold the same key, so merging them naively would
   * report one blanked parameter as two and make the user acknowledge a field
   * that does not exist. One key, one row, one entry in the list.
   */
  it("does not report a parameter twice for being in both copies", () => {
    const store = useTabsStore()

    store.openHistoryEntry(
      makeHistoryEntry({
        url: `https://api.example.com/users?token=${REDACTION_SENTINEL}&page=1`,
        requestParams: [pair("token", REDACTION_SENTINEL), pair("page", "1")],
        requestBodyType: "none",
        requestBodyContent: undefined,
      }),
    )

    const opened = store.activeTab

    expect(opened.params.map((item) => item.key)).toEqual(["token", "page"])
    expect(panelGate(opened)).toEqual([["refill", "query", null, "token"]])
  })

  /**
   * FALSE GATE. The marker travels with the key that was blanked, not with
   * blankness. A parameter the user deliberately sent empty must not inherit a
   * gate from an unrelated credential on the same request.
   */
  it("does not mark a blank parameter of a key nothing blanked", () => {
    const store = useTabsStore()

    store.openHistoryEntry(
      makeHistoryEntry({
        url: `https://api.example.com/users?apikey=${REDACTION_SENTINEL}&note=`,
        requestParams: [pair("note", "")],
        requestBodyType: "none",
        requestBodyContent: undefined,
      }),
    )

    const opened = store.activeTab

    expect(opened.params[0]).toEqual(expect.objectContaining({ key: "note", value: "" }))
    expect(opened.params[0].redacted).toBeUndefined()
    expect(panelGate(opened)).toEqual([["refill", "query", null, "apikey"]])
  })

  /**
   * MISSED GATE. One key, one row sent filled and one sent empty. The two copies
   * describe it differently on purpose -- the params copy stamps the value it
   * found and leaves the empty row alone, the url stamps the whole key -- and
   * reading the url's answer *minus* the keys the params copy reports as blanked
   * dropped it for exactly this shape: the blank row came back unmarked, filling
   * the marked one emptied the list, the notice came down, the save unlocked and
   * `apikey=""` went into the collection to 401 in silence later.
   *
   * Which of the two blanks in the replayed tab is "the" credential is not a
   * question the entry can answer -- an `apikey=` blanked by an earlier
   * generation and never typed back in reaches this reader in the same shape as
   * one the user meant to send empty -- so both are reported, on the standing
   * ruling that over-reporting costs a confirmation and under-reporting costs a
   * credential.
   */
  it("marks every blank row of a key one copy reports as blanked", () => {
    const store = useTabsStore()
    const entry = sanitizeHistoryEntry(
      makeHistoryEntry({
        url: "https://api.example.com/users?apikey=SECRET&apikey=",
        requestParams: [pair("apikey", "SECRET"), pair("apikey", "")],
        requestBodyType: "none",
        requestBodyContent: undefined,
      }),
    )

    // Self-check on the fixture: this is the disagreement, not a hand-written
    // approximation of it.
    expect(entry.requestParams).toEqual([
      expect.objectContaining({ key: "apikey", value: REDACTION_SENTINEL }),
      expect.objectContaining({ key: "apikey", value: "" }),
    ])
    expect(entry.url).toBe(
      `https://api.example.com/users?apikey=${REDACTION_SENTINEL}&apikey=${REDACTION_SENTINEL}`,
    )

    store.openHistoryEntry(entry)

    expect(store.activeTab.params).toEqual([
      expect.objectContaining({ key: "apikey", value: "", redacted: true }),
      expect.objectContaining({ key: "apikey", value: "", redacted: true }),
    ])
    expect(panelGate(store.activeTab)).toEqual([
      ["refill", "query", null, "apikey"],
      ["refill", "query", null, "apikey"],
    ])
    expect(panelGate(store.activeTab)).toEqual(rowGate(entry))
  })

  // The same shape with the rows the other way round. Which row holds the
  // placeholder is not a fact the rule may turn on, and a rule that read the
  // first row of the key would pass the test above and fail this one.
  it("marks every blank row when the blank one was sent first", () => {
    const store = useTabsStore()
    const entry = sanitizeHistoryEntry(
      makeHistoryEntry({
        url: "https://api.example.com/users?apikey=&apikey=SECRET",
        requestParams: [pair("apikey", ""), pair("apikey", "SECRET")],
        requestBodyType: "none",
        requestBodyContent: undefined,
      }),
    )

    store.openHistoryEntry(entry)

    expect(panelGate(store.activeTab)).toEqual([
      ["refill", "query", null, "apikey"],
      ["refill", "query", null, "apikey"],
    ])
    expect(panelGate(store.activeTab)).toEqual(rowGate(entry))
  })

  /**
   * The same pair with the url carrying no query at all, which is what a tab
   * whose URL bar was touched last records: `syncParamsFromUrl` moves the query
   * into the params and stores the bare url, so the params copy is the only one
   * that can say anything about the key. Reading the blanked fact off the url
   * alone answers "nothing was blanked" for an entry in this shape, whatever its
   * params hold.
   */
  it("marks every blank row of a blanked key when the url kept no query", () => {
    const store = useTabsStore()
    const entry = sanitizeHistoryEntry(
      makeHistoryEntry({
        url: "https://api.example.com/users",
        requestParams: [pair("apikey", "SECRET"), pair("apikey", "")],
        requestBodyType: "none",
        requestBodyContent: undefined,
      }),
    )

    expect(entry.url).toBe("https://api.example.com/users")

    store.openHistoryEntry(entry)

    expect(store.activeTab.params).toEqual([
      expect.objectContaining({ key: "apikey", value: "", redacted: true }),
      expect.objectContaining({ key: "apikey", value: "", redacted: true }),
    ])
    expect(panelGate(store.activeTab)).toEqual([
      ["refill", "query", null, "apikey"],
      ["refill", "query", null, "apikey"],
    ])
    expect(panelGate(store.activeTab)).toEqual(rowGate(entry))
  })

  /**
   * Both directions of that row, in the order the user meets them. Typing the
   * credential into one blank used to clear the notice outright; it now leaves
   * the other blank listed, and only filling that one too empties the list.
   * Without the second half this test would pass on a gate that never lifts.
   */
  it("holds the gate until every blank row of the key is filled", () => {
    const store = useTabsStore()

    store.openHistoryEntry(
      sanitizeHistoryEntry(
        makeHistoryEntry({
          url: "https://api.example.com/users?apikey=SECRET&apikey=",
          requestParams: [pair("apikey", "SECRET"), pair("apikey", "")],
          requestBodyType: "none",
          requestBodyContent: undefined,
        }),
      ),
    )

    const opened = store.activeTab
    opened.params[0].value = "SECRET"

    expect(panelGate(opened)).toEqual([["refill", "query", null, "apikey"]])

    opened.params[1].value = "OTHER"

    expect(panelGate(opened)).toEqual([])
  })

  /**
   * FALSE GATE, and the disagreement itself. The two copies of the query say
   * different things about one key: the url still holds the placeholder, the
   * params copy holds the value. Params are what the send path puts on the
   * wire, so nothing is outstanding — and the panel already read it that way
   * while the history row beside it listed the key and made the user confirm.
   *
   * Written by hand rather than through `sanitizeHistoryEntry`, and that is the
   * point of stating it: an entry this version writes has both copies redacted
   * together, so this shape reaches the readers from a `history.jsonl` an older
   * version wrote — the same reason the `?? ""` fallbacks in `openHistoryEntry`
   * exist. It is also the shape the two rules were found to differ on, and two
   * rules for one fact are a defect whether or not today's writer can produce
   * the input that shows it.
   */
  it("reports nothing for a key the url still hides and the params copy holds", () => {
    const store = useTabsStore()
    const entry = makeHistoryEntry({
      url: `https://api.example.com/users?apikey=${REDACTION_SENTINEL}&page=1`,
      requestParams: [pair("apikey", "REAL"), pair("page", "1")],
      requestBodyType: "none",
      requestBodyContent: undefined,
    })

    store.openHistoryEntry(entry)

    // The value survives into the tab, so it is not that both sides agree by
    // losing it.
    expect(store.activeTab.params.find((item) => item.key === "apikey")).toEqual(
      expect.objectContaining({ value: "REAL" }),
    )
    expect(store.activeTab.params.find((item) => item.key === "apikey")?.redacted).toBeUndefined()
    expect(rowGate(entry)).toEqual([])
    expect(panelGate(store.activeTab)).toEqual(rowGate(entry))
  })

  it("keeps a disabled row the entry stored", () => {
    const store = useTabsStore()

    store.openHistoryEntry(
      makeHistoryEntry({
        url: "https://api.example.com/users?page=1",
        requestParams: [pair("page", "1"), { ...pair("debug", "1"), enabled: false }],
        requestBodyType: "none",
        requestBodyContent: undefined,
      }),
    )

    expect(store.activeTab.params.map((item) => [item.key, item.enabled])).toEqual([
      ["page", true],
      ["debug", false],
    ])
  })

  /**
   * The invariant itself, stated directly: the same history row, read through
   * the panel and read through the history row's own save, names the same
   * fields. The two lists used to be built from different halves of the entry,
   * and that is how one of them came to say a request was ready to save while
   * the other held it back.
   */
  describe("both entry points name the same fields for one history row", () => {
    const cases: Array<[string, HistoryEntry]> = [
      [
        "a parameter only the url has",
        makeHistoryEntry({
          url: `https://api.example.com/users?apikey=${REDACTION_SENTINEL}&page=1`,
          requestParams: [pair("page", "1")],
          requestBodyType: "none",
          requestBodyContent: undefined,
        }),
      ],
      [
        "a blank row only the url reports as blanked",
        sanitizeHistoryEntry(
          makeHistoryEntry({
            url: "https://api.example.com/users?apikey=&page=1",
            requestParams: [pair("apikey", ""), pair("page", "1")],
            requestBodyType: "none",
            requestBodyContent: undefined,
          }),
        ),
      ],
      [
        "a key both copies report as blanked",
        makeHistoryEntry({
          url: `https://api.example.com/users?token=${REDACTION_SENTINEL}`,
          requestParams: [pair("token", REDACTION_SENTINEL)],
          requestBodyType: "none",
          requestBodyContent: undefined,
        }),
      ],
      [
        "a row with nothing outstanding",
        makeHistoryEntry({
          url: "https://api.example.com/users?page=1",
          requestParams: [pair("page", "1")],
          requestBodyType: "none",
          requestBodyContent: undefined,
        }),
      ],
      // One key, one blank row and one the params copy names as blanked. The
      // two entry points agreed on the wrong number here before -- both said
      // one where there are two blanks to fill -- so agreement alone is not what
      // this case is for; it is here because the number they agree on has to
      // stay the same one when either side is edited.
      [
        "a key with a blanked row and a blank row",
        sanitizeHistoryEntry(
          makeHistoryEntry({
            url: "https://api.example.com/users?apikey=SECRET&apikey=",
            requestParams: [pair("apikey", "SECRET"), pair("apikey", "")],
            requestBodyType: "none",
            requestBodyContent: undefined,
          }),
        ),
      ],
      // The overlap the two rules answered differently: a placeholder in one
      // copy, the value in the other. Both must call it done, because done is
      // what goes on the wire.
      [
        "a key the url still hides and the params copy holds",
        makeHistoryEntry({
          url: `https://api.example.com/users?apikey=${REDACTION_SENTINEL}&page=1`,
          requestParams: [pair("apikey", "REAL"), pair("page", "1")],
          requestBodyType: "none",
          requestBodyContent: undefined,
        }),
      ],
    ]

    it.each(cases)("agrees on %s", (_name, entry) => {
      const store = useTabsStore()

      store.openHistoryEntry(entry)

      expect(panelGate(store.activeTab)).toEqual(rowGate(entry))
    })
  })
})
