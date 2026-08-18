import { describe, expect, it } from "vitest"

import {
  buildUrlWithParams,
  detectTemplateVariables,
  encodeFormComponentPreservingTemplates,
  reconcileUrlBarValue,
  stripQueryFromUrl,
  syncParamsFromUrl,
} from "../url-params"
import { splitUrlParts } from "../url-query"
import type { KeyValuePair } from "../../types"

const BASE = "https://api.example.com/items"

function pair(key: string, value: string, enabled = true): KeyValuePair {
  return { id: `${key}-${value}`, enabled, key, value, description: "" }
}

/**
 * Characters that a literal in this file cannot be trusted to carry: the write
 * path has been observed eating a backslash, and an editor can normalize a bare
 * tab or newline. Build them from code points and assert the shape below before
 * any behaviour is asserted.
 */
const BACKSLASH = String.fromCharCode(92)
const NEWLINE = String.fromCharCode(10)
const TAB = String.fromCharCode(9)

describe("§26 the url bar query matches the wire query", () => {
  // `expectedWireQuery` is written out by hand from what Rust puts on the wire:
  // `execute_request` appends every param with `item.enabled && !item.key.trim().is_empty()`
  // (src-tauri/src/lib.rs, `url.query_pairs_mut()`).
  it.each([
    [
      "a history entry carrying requestParams",
      [pair("a", "1"), pair("b", "2")],
      "a=1&b=2",
    ],
    [
      "params derived from the url",
      syncParamsFromUrl(`${BASE}?a=1&b=2`, []).params,
      "a=1&b=2",
    ],
    ["a repeated key", [pair("q", "1"), pair("q", "2")], "q=1&q=2"],
    ["a disabled param", [pair("a", "1"), pair("b", "2", false)], "a=1"],
  ])("url bar query matches the wire query for %s", (_name, params, expectedWireQuery) => {
    expect(buildUrlWithParams(BASE, params)).toBe(`${BASE}?${expectedWireQuery}`)
  })

  it("drops the query when nothing is enabled", () => {
    expect(buildUrlWithParams(BASE, [pair("a", "1", false)])).toBe(BASE)
  })
})

describe("url part helpers", () => {
  it("splits base url, query and fragment", () => {
    expect(splitUrlParts("https://api.example.com/items?a=1#frag")).toEqual({
      baseUrl: "https://api.example.com/items",
      query: "a=1",
      hash: "#frag",
    })
    expect(splitUrlParts("/items")).toEqual({ baseUrl: "/items", query: "", hash: "" })
  })

  it("keeps the fragment out of the wire url", () => {
    expect(buildUrlWithParams(`${BASE}#frag`, [pair("a", "1")])).toBe(`${BASE}?a=1#frag`)
    expect(stripQueryFromUrl(`${BASE}?a=1`)).toBe(BASE)
  })

  it("moves the query into params and keeps disabled rows", () => {
    const synced = syncParamsFromUrl(`${BASE}?a=1`, [pair("b", "2", false)])

    expect(synced.url).toBe(BASE)
    expect(synced.params.map(({ key, value, enabled }) => ({ key, value, enabled }))).toEqual([
      { key: "a", value: "1", enabled: true },
      { key: "b", value: "2", enabled: false },
    ])
  })
})

describe("§1 template spans survive the url bar verbatim", () => {
  it("keeps a template in the value", () => {
    expect(buildUrlWithParams(BASE, [pair("k", "{{apiKey}}")])).toBe(`${BASE}?k={{apiKey}}`)
  })

  it("keeps a template in the key", () => {
    expect(buildUrlWithParams(BASE, [pair("{{keyName}}", "1")])).toBe(`${BASE}?{{keyName}}=1`)
  })

  it("keeps several templates mixed with ordinary text", () => {
    expect(buildUrlWithParams(BASE, [pair("k", "x{{a}}y{{b}}z")])).toBe(`${BASE}?k=x{{a}}y{{b}}z`)
  })

  it("keeps the inner spacing of a template", () => {
    expect(buildUrlWithParams(BASE, [pair("k", "{{ a }}")])).toBe(`${BASE}?k={{ a }}`)
  })

  it("encodes the non-template bytes around a template", () => {
    expect(buildUrlWithParams(BASE, [pair("k", "a b{{v}}c&d")])).toBe(`${BASE}?k=a+b{{v}}c%26d`)
  })
})

describe("§2 every non-template byte matches what the backend sends", () => {
  // `wire` is the query string a real `url::Url::query_pairs_mut().append_pair("k", value)`
  // produced on url 2.5.8, the version in src-tauri/Cargo.lock. Captured by
  // running the crate itself rather than reasoning about it: `execute_request`
  // builds the query with `query_pairs_mut()` (src-tauri/src/lib.rs), which is a
  // `form_urlencoded::Serializer` — a space is `+`, not `%20`.
  const WIRE: [string, string][] = [
    ["a b", "a+b"],
    ["!", "%21"],
    ["~", "%7E"],
    ["(", "%28"],
    [")", "%29"],
    ["'", "%27"],
    ["*", "*"],
    ["-", "-"],
    ["_", "_"],
    [".", "."],
    ["+", "%2B"],
    ["%", "%25"],
    ["&", "%26"],
    ["=", "%3D"],
    ["?", "%3F"],
    ["#", "%23"],
    ["/", "%2F"],
    [":", "%3A"],
    ["@", "%40"],
    ["$", "%24"],
    [",", "%2C"],
    [";", "%3B"],
    ["[", "%5B"],
    ["]", "%5D"],
    ["{", "%7B"],
    ["}", "%7D"],
    ["|", "%7C"],
    [BACKSLASH, "%5C"],
    ["^", "%5E"],
    ["`", "%60"],
    ['"', "%22"],
    ["<", "%3C"],
    [">", "%3E"],
    ["中", "%E4%B8%AD"],
    ["é", "%C3%A9"],
    ["😀", "%F0%9F%98%80"],
    ["", ""],
    ["a+b", "a%2Bb"],
    ["a%20b", "a%2520b"],
    ["a b c", "a+b+c"],
    [NEWLINE, "%0A"],
    [TAB, "%09"],
  ]

  it("the fixture still holds the characters it claims to hold", () => {
    expect(BACKSLASH).toHaveLength(1)
    expect(BACKSLASH.charCodeAt(0)).toBe(92)
    expect(NEWLINE.charCodeAt(0)).toBe(10)
    expect(TAB.charCodeAt(0)).toBe(9)
    expect(WIRE.map(([value]) => value)).toContain(BACKSLASH)
  })

  it("encodes every sample value exactly as the wire does", () => {
    expect(WIRE.map(([value]) => encodeFormComponentPreservingTemplates(value))).toEqual(
      WIRE.map(([, wire]) => wire),
    )
  })

  it("encodes keys the same way it encodes values", () => {
    // Rust: append_pair("a b", "c d") → "a+b=c+d".
    expect(buildUrlWithParams(BASE, [pair("a b", "c d")])).toBe(`${BASE}?a+b=c+d`)
  })
})

describe("§3 a whitespace-only key is ignored on both sides", () => {
  it("leaves a whitespace-only key out of the url bar", () => {
    // The backend filters with `item.enabled && !item.key.trim().is_empty()`
    // (src-tauri/src/lib.rs), so this row is not sent either.
    expect(buildUrlWithParams(BASE, [pair("   ", "v"), pair("a", "1")])).toBe(`${BASE}?a=1`)
  })
})

describe("§7 the variable hint covers the path and the query alike", () => {
  it("reports a variable in the path", () => {
    expect(detectTemplateVariables("{{baseUrl}}/users")).toEqual(["baseUrl"])
  })

  it("reports a variable in the query", () => {
    expect(detectTemplateVariables("https://api.test/a?k={{apiKey}}")).toEqual(["apiKey"])
  })

  it("de-duplicates and keeps order of appearance", () => {
    expect(
      detectTemplateVariables("{{baseUrl}}/a?x={{apiKey}}&y={{baseUrl}}&z={{ apiKey }}"),
    ).toEqual(["baseUrl", "apiKey"])
  })

  it("does not count variables inside a disabled param", () => {
    const displayed = buildUrlWithParams(BASE, [
      pair("a", "{{used}}"),
      pair("b", "{{unused}}", false),
    ])

    expect(detectTemplateVariables(displayed)).toEqual(["used"])
  })
})

const TAB_ID = "tab-1"

/**
 * One keystroke, all the way round: the field appends a character to whatever
 * it currently shows, the panel writes the parsed state back without bumping
 * the revision (it is the URL bar's own echo), and the field reconciles against
 * the value it gets handed back. Appending to the *displayed* string rather
 * than to the intended target is what makes this reproduce the original defect
 * — a swallowed `?` sends the next character to the wrong place.
 */
function typeOutUrl(target: string): string {
  let draft = ""
  let stored: { url: string; params: KeyValuePair[] } = { url: "", params: [] }
  const revision = 0

  for (const character of target) {
    draft += character
    stored = syncParamsFromUrl(draft, stored.params)
    draft = reconcileUrlBarValue(
      { tabId: TAB_ID, revision, draft },
      { tabId: TAB_ID, revision, url: buildUrlWithParams(stored.url, stored.params) },
    )
  }

  return draft
}

describe("§8 typing shows exactly what was typed", () => {
  const TARGETS = [
    "https://api.test/a?x=1",
    "https://api.test/a?x=1&y=2",
    "https://api.test/a?q=hello world",
    "https://api.test/a#frag",
    "https://api.test/a?q=%E4%B8%AD",
    "https://api.test/a?q=a%20b",
    "https://api.test/a?q=1&q=2",
    "https://api.test/users/{{id}}?k={{apiKey}}",
    "https://api.test/a?x",
    "{{baseUrl}}/users?q=a b",
  ]

  it("every target survives character-by-character entry", () => {
    expect(TARGETS.map(typeOutUrl)).toEqual(TARGETS)
  })
})

describe("§9 pasting a plain url keeps it byte for byte", () => {
  // Redundant with §8 by construction: a paste is a single input event, which
  // is the last iteration of the loop above. Shares §8's killer; it is not
  // claimed to be independently killable.
  it("keeps a pasted url unchanged", () => {
    const pasted = "https://api.test/a?q=a%20b&empty=&x=1"
    const stored = syncParamsFromUrl(pasted, [])

    expect(
      reconcileUrlBarValue(
        { tabId: TAB_ID, revision: 0, draft: pasted },
        { tabId: TAB_ID, revision: 0, url: buildUrlWithParams(stored.url, stored.params) },
      ),
    ).toBe(pasted)
  })
})

describe("§10 a change from outside the field is adopted", () => {
  it("shows the new value after the params table is edited", () => {
    expect(
      reconcileUrlBarValue(
        { tabId: TAB_ID, revision: 0, draft: "https://x/a?q=1" },
        { tabId: TAB_ID, revision: 1, url: "https://x/a?q=2" },
      ),
    ).toBe("https://x/a?q=2")
  })
})

describe("§11 an outside change is adopted even when it parses the same", () => {
  it("replaces a %20 draft with the imported + form", () => {
    // A cURL import normalizes `%20` to `+`. The two parse identically, so any
    // criterion based on "are these the same request" reads it as a self-echo
    // and leaves the field showing a draft that no state corresponds to.
    expect(
      reconcileUrlBarValue(
        { tabId: TAB_ID, revision: 0, draft: "https://x/a?q=a%20b" },
        { tabId: TAB_ID, revision: 1, url: "https://x/a?q=a+b" },
      ),
    ).toBe("https://x/a?q=a+b")
  })
})

describe("§13 a draft never leaks across tabs", () => {
  it("shows the other tab's url even when both parse the same", () => {
    expect(
      reconcileUrlBarValue(
        { tabId: "tab-a", revision: 0, draft: "https://x/a?q=a%20b" },
        { tabId: "tab-b", revision: 0, url: "https://x/a?q=a+b" },
      ),
    ).toBe("https://x/a?q=a+b")
  })

  it("adopts the incoming url when there is no previous state", () => {
    expect(reconcileUrlBarValue(null, { tabId: "tab-a", revision: 0, url: BASE })).toBe(BASE)
  })
})
