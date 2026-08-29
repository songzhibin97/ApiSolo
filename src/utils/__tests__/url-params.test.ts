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
    // Deliberately no space: how a space is encoded is §2's subject, and
    // putting it here would make a §2 regression collapse a §1 case too.
    expect(buildUrlWithParams(BASE, [pair("k", "a{{v}}c&d")])).toBe(`${BASE}?k=a{{v}}c%26d`)
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
    // The surviving variable sits in the path, not in a param value: reading it
    // out of a param would make this case depend on §1's encoding as well as on
    // the disabled-row rule it is here to check.
    const displayed = buildUrlWithParams("{{baseUrl}}/items", [
      pair("a", "1"),
      pair("b", "{{unused}}", false),
    ])

    expect(displayed).toBe("{{baseUrl}}/items?a=1")
    expect(detectTemplateVariables(displayed)).toEqual(["baseUrl"])
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

/** URL edits preserve row identity and the row-local marker contract. */
describe("rebuilding params from the url keeps a still-blank row's marker", () => {
  const redacted = (key: string): KeyValuePair => ({
    id: `${key}-r`,
    enabled: true,
    key,
    value: "",
    description: "",
    redacted: true,
  })

  it("keeps the marker when an unrelated part of the url changes", () => {
    const synced = syncParamsFromUrl("https://api.example.com/admins?apikey=&page=1", [
      redacted("apikey"),
      pair("page", "1"),
    ])

    expect(synced.params.find((item) => item.key === "apikey")).toEqual(
      expect.objectContaining({ value: "", redacted: true }),
    )
  })

  /** Same-key matching preserves the row while changing only its value. */
  it("keeps the row marker when its value is edited in the url bar", () => {
    const synced = syncParamsFromUrl(`${BASE}?apikey=REAL`, [redacted("apikey")])

    expect(synced.params.find((item) => item.key === "apikey")).toEqual(
      expect.objectContaining({ id: "apikey-r", value: "REAL", redacted: true }),
    )
  })

  /**
   * MISSED GATE, the url-bar spelling of it. A credential is typed back into
   * the params table -- which keeps the marker, because the marker records
   * where the row came from -- and the url is then edited around it. Losing the
   * marker on the way through here would leave the row looking like an ordinary
   * parameter, and emptying it afterwards would go unreported.
   */
  it("keeps the marker on a filled row it can identify", () => {
    const filled = { ...redacted("apikey"), value: "REAL" }

    const synced = syncParamsFromUrl(`${BASE}?apikey=REAL&page=1`, [filled, pair("page", "1")])

    expect(synced.params.find((item) => item.key === "apikey")).toEqual(
      expect.objectContaining({ value: "REAL", redacted: true }),
    )
  })

  /** The row-local marker survives the filled-then-empty round trip. */
  it("reports the key again when a filled row is emptied from the url bar", () => {
    const filled = { ...redacted("apikey"), value: "REAL" }

    const synced = syncParamsFromUrl(`${BASE}?apikey=&page=1`, [filled, pair("page", "1")])

    expect(synced.params.find((item) => item.key === "apikey")).toEqual(
      expect.objectContaining({ value: "", redacted: true }),
    )
  })

  it("drops the row entirely when the parameter is deleted from the url", () => {
    const synced = syncParamsFromUrl(`${BASE}?page=1`, [redacted("apikey"), pair("page", "1")])

    expect(synced.params.map((item) => item.key)).toEqual(["page"])
  })

  it("never invents a marker for a row that never had one", () => {
    const synced = syncParamsFromUrl(`${BASE}?apikey=`, [pair("apikey", "")])

    expect(synced.params[0].redacted).toBeUndefined()
  })

  /**
   * The case that broke the previous, position-based version of this. Two
   * same-named parameters, one already filled in, then the pair pasted back in
   * the other order: a rule that pinned the marker to an ordinal handed it to
   * the row that no longer needed it and left the blank one unmarked, so the
   * gate disappeared on a still-empty API key.
   */
  it("keeps the blank row marked when same-named parameters are reordered", () => {
    const current = [pair("apikey", "FILLED"), redacted("apikey")]

    const synced = syncParamsFromUrl(`${BASE}?apikey=&apikey=FILLED`, current)

    expect(synced.params.map((item) => [item.value, item.redacted])).toEqual([
      ["", true],
      ["FILLED", undefined],
    ])
  })

  /** New rows never inherit marker state from an existing row's key. */
  it("does not propagate a marker onto newly added blank siblings", () => {
    const synced = syncParamsFromUrl(`${BASE}?tag=&tag=&tag=`, [
      redacted("tag"),
      pair("tag", "b"),
      pair("tag", "c"),
    ])

    expect(synced.params.filter((item) => item.redacted === true)).toHaveLength(1)
  })

  it("marks no blank row of a key that was never blanked", () => {
    const synced = syncParamsFromUrl(`${BASE}?tag=&tag=`, [pair("tag", "b"), pair("tag", "c")])

    expect(synced.params.filter((item) => item.redacted === true)).toHaveLength(0)
  })

  it("carries both markers when both rows are still blank, in either order", () => {
    const current = [redacted("apikey"), redacted("apikey")]

    for (const url of [`${BASE}?apikey=&apikey=`, `${BASE}?apikey=&other=x&apikey=`]) {
      const synced = syncParamsFromUrl(url, current)
      expect(synced.params.filter((item) => item.redacted === true)).toHaveLength(2)
    }
  })

  /** Exact decoded matches keep their own row state. */
  it("marks the blank repeat and not the filled one", () => {
    const synced = syncParamsFromUrl(`${BASE}?tag=kept&tag=`, [
      pair("tag", "kept"),
      redacted("tag"),
    ])

    expect(synced.params.map((item) => [item.value, item.redacted])).toEqual([
      ["kept", undefined],
      ["", true],
    ])
  })

  it("keeps a marker on its row when the key is renamed", () => {
    const synced = syncParamsFromUrl(`${BASE}?other=`, [redacted("apikey")])

    expect(synced.params).toEqual([expect.objectContaining({ key: "other", value: "" })])
    expect(synced.params[0].redacted).toBe(true)
  })

  /** Disabled rows do not participate in URL matching and remain passthrough. */
  it("does not count a disabled row as outstanding", () => {
    const synced = syncParamsFromUrl(`${BASE}?apikey=&apikey=`, [
      { ...redacted("apikey"), enabled: false },
      pair("apikey", ""),
    ])

    // Scoped to the rebuilt rows. The disabled row is carried through verbatim,
    // marker and all -- that is existing behaviour and not what this checks.
    expect(
      synced.params.filter((item) => item.enabled && item.redacted === true),
    ).toHaveLength(0)
  })

  /** A filled marked row is valid and inert until its value is emptied again. */
  it("keeps the marker inert on a filled row so deleting the value can restore the gate", () => {
    const [filled] = syncParamsFromUrl(`${BASE}?apikey=REAL`, [redacted("apikey")]).params

    expect(filled).toEqual(expect.objectContaining({ value: "REAL", redacted: true }))
  })
})

/** Row-local markers survive edits without spreading to newly created rows. */
describe("carrying the marker holds both directions shut", () => {
  const redacted = (key: string, id = `${key}-r`): KeyValuePair => ({
    id,
    enabled: true,
    key,
    value: "",
    description: "",
    redacted: true,
  })

  const marks = (params: KeyValuePair[]) =>
    params.filter((item) => item.redacted === true && item.value === "").length

  it("MISSING GATE: a blank stays marked when a sibling of the same key is filled", () => {
    const after = syncParamsFromUrl(`${BASE}?apikey=SECRET&apikey=`, [
      redacted("apikey", "first"),
      redacted("apikey", "second"),
    ]).params

    expect(marks(after)).toBe(1)
  })

  /** Reordering URL entries changes output order, not the number of marked rows. */
  it("MISSING GATE: any rearrangement of the same rows gives the same answer", () => {
    const start = [redacted("apikey", "a"), pair("apikey", "X"), pair("apikey", "")]

    for (const url of [
      `${BASE}?apikey=&apikey=X&apikey=`,
      `${BASE}?apikey=X&apikey=&apikey=`,
      `${BASE}?apikey=&apikey=&apikey=X`,
    ]) {
      expect(`${url}: ${marks(syncParamsFromUrl(url, start).params)}`).toBe(`${url}: 1`)
    }
  })

  it("MISSING GATE: inserting a blank row in front does not lose the gate", () => {
    const after = syncParamsFromUrl(`${BASE}?apikey=&apikey=FILLED`, [
      redacted("apikey", "blank"),
      pair("apikey", "FILLED"),
    ]).params

    expect(marks(after)).toBe(1)
  })

  it("MISSING GATE: shrinking an exact group keeps the marked survivor", () => {
    const after = syncParamsFromUrl(`${BASE}?apikey=`, [
      redacted("apikey", "was-blanked"),
      pair("apikey", ""),
    ]).params

    expect(marks(after)).toBe(1)
  })

  /** Adding an unmarked sibling does not duplicate the imported marker. */
  it("FALSE GATE: a remaining blank keeps gating, and filling it clears", () => {
    const added = syncParamsFromUrl(`${BASE}?apikey=&apikey=`, [redacted("apikey")]).params
    expect(marks(added)).toBe(1)

    const half = syncParamsFromUrl(`${BASE}?apikey=SECRET&apikey=`, added).params
    expect(marks(half)).toBe(1)

    const whole = syncParamsFromUrl(`${BASE}?apikey=SECRET&apikey=OTHER`, half).params
    expect(marks(whole)).toBe(0)
  })

  it("FALSE GATE: deleting the spare blank row clears it too", () => {
    const added = syncParamsFromUrl(`${BASE}?apikey=&apikey=`, [redacted("apikey")]).params

    const trimmed = syncParamsFromUrl(`${BASE}?apikey=SECRET`, added).params

    expect(marks(trimmed)).toBe(0)
  })

  it("FALSE GATE: filling every blank of the key clears it in one step", () => {
    const rows = [redacted("apikey", "a"), redacted("apikey", "b")]

    const filled = syncParamsFromUrl(`${BASE}?apikey=1&apikey=2`, rows).params

    expect(marks(filled)).toBe(0)
  })

  it("FALSE GATE: deleting the parameter altogether clears it", () => {
    const after = syncParamsFromUrl(`${BASE}?page=1`, [
      redacted("apikey"),
      pair("page", "1"),
    ]).params

    expect(marks(after)).toBe(0)
  })

  it("FALSE GATE: a re-added parameter is the user's own row, not a blanked one", () => {
    const gone = syncParamsFromUrl(`${BASE}?page=1`, [redacted("apikey"), pair("page", "1")]).params

    const back = syncParamsFromUrl(`${BASE}?page=1&apikey=`, gone).params

    expect(marks(back)).toBe(0)
  })

  /** Filling one row does not transfer its marker to an unmarked blank sibling. */
  it("still treats a key as blanked once its blank has been filled", () => {
    const after = syncParamsFromUrl(`${BASE}?apikey=&apikey=ALREADY`, [
      { ...redacted("apikey"), value: "ALREADY" },
    ]).params

    expect(after.map((item) => [item.value, item.redacted])).toEqual([
      ["", undefined],
      ["ALREADY", true],
    ])
  })

  /** Stable blank groups keep their existing handles and descriptions. */
  it("preserves both blank rows' handles and descriptions", () => {
    const after = syncParamsFromUrl(`${BASE}?apikey=&apikey=`, [
      { ...redacted("apikey", "was-blanked"), description: "the one from history" },
      { ...pair("apikey", ""), id: "mine", description: "mine" },
    ]).params

    expect(after.map((item) => item.description)).toEqual(["the one from history", "mine"])
    expect(after.map((item) => item.id)).toEqual(["was-blanked", "mine"])
  })

  it("keeps the identity of a row whose value did not change", () => {
    const after = syncParamsFromUrl(`${BASE}?apikey=&page=1`, [
      redacted("apikey", "blank-row"),
      { ...pair("page", "1"), id: "keep-me", description: "which page" },
    ]).params

    expect(after.find((item) => item.key === "page")).toEqual(
      expect.objectContaining({ id: "keep-me", description: "which page" }),
    )
  })
})

describe("D17 §8-§9 URL edits preserve row identity with marked-first survivors", () => {
  const row = (
    id: string,
    key: string,
    value: string,
    redacted = false,
    description = id,
  ): KeyValuePair => ({
    id,
    enabled: true,
    key,
    value,
    description,
    ...(redacted ? { redacted: true } : {}),
  })

  const markedCount = (rows: KeyValuePair[]) => rows.filter((item) => item.redacted === true).length

  it("keeps ids, descriptions, enabled state and markers for unchanged rows", () => {
    const synced = syncParamsFromUrl(`${BASE}?apikey=&page=2`, [
      row("credential", "apikey", "", true, "history credential"),
      { ...row("page", "page", "2", false, "second page"), enabled: true },
      { ...row("disabled", "debug", "1", false, "off for now"), enabled: false },
    ])

    expect(synced.params).toEqual([
      expect.objectContaining({
        id: "credential",
        description: "history credential",
        redacted: true,
      }),
      expect.objectContaining({ id: "page", description: "second page", value: "2" }),
      expect.objectContaining({ id: "disabled", enabled: false, description: "off for now" }),
    ])
  })

  it.each([
    ["F1 U,M", [row("u", "apikey", ""), row("m", "apikey", "", true)]],
    ["F1-prime M,U", [row("m", "apikey", "", true), row("u", "apikey", "")]],
  ])("%s keeps one marked exact-match survivor", (_name, current) => {
    const synced = syncParamsFromUrl(`${BASE}?apikey=`, current)

    expect(markedCount(synced.params)).toBe(1)
    expect(synced.params[0].id).toBe("m")
  })

  it("F2 keeps the original-order tiebreak among equally marked exact matches", () => {
    const synced = syncParamsFromUrl(`${BASE}?apikey=`, [
      row("ma", "apikey", "", true, "a"),
      row("mb", "apikey", "", true, "b"),
    ])

    expect(synced.params[0]).toEqual(expect.objectContaining({ id: "ma", description: "a" }))
  })

  it("F3 applies marked-first selection in the same-key stage", () => {
    const synced = syncParamsFromUrl(`${BASE}?apikey=changed`, [
      row("u", "apikey", "first"),
      row("m", "apikey", "second", true),
    ])

    expect(synced.params[0]).toEqual(
      expect.objectContaining({ id: "m", value: "changed", redacted: true }),
    )
  })

  it("F4 applies marked-first selection in the ordered fallback stage", () => {
    const synced = syncParamsFromUrl(`${BASE}?renamed=`, [
      row("u", "first", ""),
      row("m", "second", "", true),
    ])

    expect(synced.params[0]).toEqual(
      expect.objectContaining({ id: "m", key: "renamed", redacted: true }),
    )
  })

  it("F5 keeps a marked row when an exact group shrinks by two", () => {
    const synced = syncParamsFromUrl(`${BASE}?apikey=`, [
      row("u", "apikey", ""),
      row("m1", "apikey", "", true),
      row("m2", "apikey", "", true),
    ])

    expect(markedCount(synced.params)).toBe(1)
    expect(synced.params[0].id).toBe("m1")
  })

  it("does not match disabled or blank-key rows and keeps them at the end", () => {
    const synced = syncParamsFromUrl(`${BASE}?page=2`, [
      { ...row("disabled", "page", "1", true), enabled: false },
      row("blank-key", "  ", "kept", true),
      row("page", "page", "1"),
    ])

    expect(synced.params.map(({ id, key, value }) => [id, key, value])).toEqual([
      ["page", "page", "2"],
      ["disabled", "page", "1"],
      ["blank-key", "  ", "kept"],
    ])
  })

  it("keeps row identity when a non-invertible template value falls to the same-key stage", () => {
    const synced = syncParamsFromUrl(`${BASE}?token={{a+b}}`, [
      row("template", "token", "{{a+b}}", true, "template credential"),
    ])

    expect(synced.params[0]).toEqual(
      expect.objectContaining({
        id: "template",
        value: "{{a b}}",
        description: "template credential",
        redacted: true,
      }),
    )
  })
})
