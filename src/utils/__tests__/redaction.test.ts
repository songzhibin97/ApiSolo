import { describe, expect, it } from "vitest"

import sharedKeys from "../__fixtures__/sensitive-keys.json"
import { needsRefill } from "../pending-refill"
import {
  REDACTION_SENTINEL,
  applyPairEdit,
  bodyKindFromBodyType,
  bodyKindFromContentType,
  clearSentinelBody,
  clearSentinelPairs,
  emptyBodyFields,
  isSensitiveKey,
  isUnverifiableBody,
  lenientDecodeKey,
  redactBodyText,
  redactKeyValuePairs,
  redactUrlQuery,
  redactValue,
  remainingRedactedBodyFields,
  sentinelBodyFields,
  tryScanJsonSpans,
} from "../redaction"
import type { KeyValuePair } from "../../types"

// `~` stands for a single backslash everywhere in this file. Escapes written as
// literals have been silently eaten by the writing chain before (repo rule P6),
// so every escaped fixture is built at runtime and self-checked before use.
const B = String.fromCharCode(92)
const esc = (value: string) => value.split("~").join(B)

const COOKIE = "sid=abcdef123456; theme=dark"
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF-_123"
const BASIC = "dXNlcjpwYXNzd29yZA=="
const DIGEST =
  'username="Mufasa", realm="testrealm@host.com", nonce="dcd98b7102dd2f0e", uri="/dir/index.html", response=6629fae49393a05397450978507c4ef1'
const BIG_INT = "9007199254740993123456789"

function pair(key: string, value: string, overrides: Partial<KeyValuePair> = {}): KeyValuePair {
  return { id: `${key}-1`, enabled: true, key, value, description: "", ...overrides }
}

describe("§3 redacted marker lifecycle", () => {
  const marked = [pair("Cookie", "", { redacted: true })]

  it.each([
    ["enabled", { enabled: false } as Partial<KeyValuePair>],
    ["key", { key: "Cookie2" } as Partial<KeyValuePair>],
    ["description", { description: "note" } as Partial<KeyValuePair>],
    // Touching the box is not filling it in. A rule keyed on "was the value
    // part of this edit" rather than on what the row now holds lets a click-in,
    // click-out — or a paste of nothing — drop the gate on a row that still
    // holds no credential.
    ["the value to empty", { value: "" } as Partial<KeyValuePair>],
    // And filling it in does not clear it either: the marker records that
    // history blanked this row, which stays true no matter what is typed over
    // it. What stops the row being reported is the value, asked for separately.
    ["the value to a real one", { value: "sid=1" } as Partial<KeyValuePair>],
  ])("keeps the marker when %s changes", (_field, patch) => {
    expect(applyPairEdit(marked, "Cookie-1", patch)[0].redacted).toBe(true)
  })

  /**
   * The pair the marker exists for, walked in order. Clearing it on the first
   * keystroke made the second step unrecoverable: the row went back to blank
   * with nothing left saying it had ever held a credential, so the notice came
   * down, the save unlocked and the request was written with an empty api key.
   *
   * `needsRefill` is the question every reader actually asks, so it is what is
   * asserted here — the marker on its own answers neither step.
   */
  it("stops reporting a filled row and reports it again once it is emptied", () => {
    const filled = applyPairEdit(marked, "Cookie-1", { value: "sid=1" })
    expect(needsRefill(filled[0])).toBe(false)

    const emptiedAgain = applyPairEdit(filled, "Cookie-1", { value: "" })
    expect(needsRefill(emptiedAgain[0])).toBe(true)
  })

  // The other direction, so that "never clear it" cannot be satisfied by
  // marking everything: a row history never blanked is never reported, however
  // it is edited.
  it("never reports a row that carries no marker", () => {
    const plain = [pair("page", "1")]

    expect(needsRefill(applyPairEdit(plain, "page-1", { value: "" })[0])).toBe(false)
  })
})

describe("§4 clearing a body says which keys it emptied", () => {
  it("names the keys it emptied in a JSON body", () => {
    const cleared = clearSentinelBody("json", `{"token":"${REDACTION_SENTINEL}","keep":"v"}`)

    expect(cleared.fields).toEqual(["token"])
    expect(cleared.content).toBe(`{"token":"","keep":"v"}`)
  })

  it("names the keys it emptied in a urlencoded body", () => {
    const cleared = clearSentinelBody("urlencoded", `token=${REDACTION_SENTINEL}&page=2`)

    expect(cleared.fields).toEqual(["token"])
    expect(cleared.content).toBe("token=&page=2")
  })

  it("names the keys it emptied in a plain-text body", () => {
    const cleared = clearSentinelBody("text", `token: ${REDACTION_SENTINEL}`)

    expect(cleared.fields).toEqual(["token"])
    expect(cleared.content).toBe("token: ")
  })

  // Two values under the same name are two values to type back in. Collapsing
  // them would understate the list at both save entry points.
  it("keeps a repeated key once per occurrence", () => {
    const cleared = clearSentinelBody(
      "json",
      `{"a":{"token":"${REDACTION_SENTINEL}"},"b":{"token":"${REDACTION_SENTINEL}"}}`,
    )

    expect(cleared.fields).toEqual(["token", "token"])
  })

  it("reports no names when there was nothing to clear", () => {
    expect(clearSentinelBody("json", `{"keep":"v"}`).fields).toEqual([])
    expect(clearSentinelBody("json", "").fields).toEqual([])
  })
})

describe("§5-§8 which recorded keys are still empty", () => {
  it("finds the sensitive keys currently holding nothing", () => {
    expect(emptyBodyFields("json", `{"token":"","keep":"v"}`)).toEqual(["token"])
    expect(emptyBodyFields("urlencoded", "token=&page=2")).toEqual(["token"])
    expect(emptyBodyFields("text", "token:")).toEqual(["token"])
  })

  it("finds nothing once the value is back", () => {
    expect(emptyBodyFields("json", `{"token":"REAL"}`)).toEqual([])
  })

  /**
   * The asymmetry that makes the gate fail closed. `sentinelBodyFields` falls
   * back to the text scanner here and is right to -- finding a placeholder in
   * unparseable text is still finding one. This must not, because the text
   * scanner would answer "already filled in" for `  "token": "",` and the gate
   * would vanish at the worst possible moment.
   */
  it("refuses to answer for a JSON body that will not parse", () => {
    expect(emptyBodyFields("json", `{"token": "",`)).toBeNull()
    expect(isUnverifiableBody("json", `{"token": "",`)).toBe(true)
  })

  it("always answers for the two kinds that cannot fail to scan", () => {
    expect(emptyBodyFields("urlencoded", "%%%not=valid")).not.toBeNull()
    expect(emptyBodyFields("text", "}{")).not.toBeNull()
    expect(isUnverifiableBody("text", `{"token": "",`)).toBe(false)
    expect(isUnverifiableBody("urlencoded", `{"token": "",`)).toBe(false)
  })

  it("keeps a recorded key while it is still empty", () => {
    expect(remainingRedactedBodyFields("json", `{"token":"","keep":"CHANGED"}`, ["token"])).toEqual([
      "token",
    ])
  })

  it("drops a recorded key once it is filled in, and once it is deleted", () => {
    expect(remainingRedactedBodyFields("json", `{"token":"REAL"}`, ["token"])).toEqual([])
    expect(remainingRedactedBodyFields("json", `{"keep":"v"}`, ["token"])).toEqual([])
  })

  it("holds every recorded key while the body will not parse", () => {
    expect(remainingRedactedBodyFields("json", `{"token": "",`, ["token", "secret"])).toEqual([
      "token",
      "secret",
    ])
  })

  it("matches repeats one for one rather than by presence", () => {
    expect(
      remainingRedactedBodyFields("json", `{"a":{"token":""},"b":{"token":"REAL"}}`, [
        "token",
        "token",
      ]),
    ).toEqual(["token"])
  })

  it("has nothing to say when replay recorded nothing", () => {
    expect(remainingRedactedBodyFields("json", `{"token":""}`, [])).toEqual([])
  })
})

/**
 * Both save entry points have to agree on whether the body can be read, and
 * they see it at different moments -- the history row before the placeholders
 * are cleared, the tab after. Clearing must therefore not change whether the
 * body parses. The reasoning for why it holds (a replacement swaps one string
 * token for another, and a text cut always lands after `key:`, which is never
 * a complete JSON value on its own) is written down, but the reasoning is not
 * what carries this: the equality below is.
 */
describe("clearing a body does not change whether it parses", () => {
  const parseable = (content: string) => tryScanJsonSpans(content) !== null

  const effective: Array<[string, string]> = [
    ["escape adjacent to the placeholder", `{"a":"b\\\\","token":"${REDACTION_SENTINEL}"}`],
    ["compact JSON", `{"token":"${REDACTION_SENTINEL}","keep":"v"}`],
    ["already formatted JSON", `{\n  "token": "${REDACTION_SENTINEL}",\n  "keep": "v"\n}`],
    ["a bare value the text path degrades to", `{token: ${REDACTION_SENTINEL}`],
  ]

  it.each(effective)("holds for %s", (_label, before) => {
    const after = clearSentinelBody("json", before).content

    // Step one: prove the fixture is not a no-op. An unchanged body satisfies
    // the equality for free and would occupy the slot without covering it.
    expect(after).not.toBe(before)
    // Step two: assert the two sides agree, not that each equals a value
    // written down here -- otherwise a day when both go wrong together is a day
    // when two expectations get updated and the equality stops carrying weight.
    expect(parseable(before)).toBe(parseable(after))
  })

  // Recorded rather than counted as coverage: the production code only replaces
  // a span whose whole value token is the placeholder, so in these shapes
  // nothing is cleared at all and the equality holds vacuously.
  const noOp: Array<[string, string]> = [
    ["the placeholder sitting in a key position", `{"${REDACTION_SENTINEL}":"v"}`],
    ["the placeholder inside a doubly-encoded string", `{"a":"{\\"token\\":\\"${REDACTION_SENTINEL}\\"}"}`],
    ["a quoted placeholder in an unparseable body", `{"token": "${REDACTION_SENTINEL}",`],
  ]

  it.each(noOp)("does not fire for %s, so the equality is vacuous there", (_label, before) => {
    expect(clearSentinelBody("json", before).content).toBe(before)
  })
})

describe("§11 json bytes outside the redacted span", () => {
  it.each([
    [
      "a big integer",
      `{"id":${BIG_INT},"password":"hunter2"}`,
      `{"id":${BIG_INT},"password":"${REDACTION_SENTINEL}"}`,
    ],
    [
      "duplicate non-sensitive keys",
      '{"id":1,"id":2,"password":"hunter2"}',
      `{"id":1,"id":2,"password":"${REDACTION_SENTINEL}"}`,
    ],
    [
      "indentation and newlines",
      '{\n  "id": 1,\n  "password": "hunter2"\n}',
      `{\n  "id": 1,\n  "password": "${REDACTION_SENTINEL}"\n}`,
    ],
    [
      "a float literal",
      '{"ratio":1.5e-3,"password":"hunter2"}',
      `{"ratio":1.5e-3,"password":"${REDACTION_SENTINEL}"}`,
    ],
    [
      "escape sequences in a string",
      esc('{"note":"line~nbreak ~"q~"","password":"hunter2"}'),
      esc(`{"note":"line~nbreak ~"q~"","password":"${REDACTION_SENTINEL}"}`),
    ],
    ["no sensitive key at all", '{\n  "id": 1\n}', '{\n  "id": 1\n}'],
  ])("preserves non-matching json bytes for %s", (_name, input, expected) => {
    expect(redactBodyText("json", input)).toBe(expected)
  })
})

describe("§12 sensitive json values and recursion", () => {
  it.each([
    ["string", '{"password":"hunter2"}'],
    ["number", '{"password":42}'],
    ["bool", '{"password":true}'],
    ["null", '{"password":null}'],
    ["object", '{"password":{"a":1}}'],
    ["array", '{"password":[1,2]}'],
  ])("redacts a sensitive json value of type %s", (_name, input) => {
    expect(redactBodyText("json", input)).toBe(`{"password":"${REDACTION_SENTINEL}"}`)
  })

  it.each([
    [
      "nested objects",
      '{"a":{"b":{"c":{"password":"p"}}}}',
      `{"a":{"b":{"c":{"password":"${REDACTION_SENTINEL}"}}}}`,
    ],
    [
      "an array inside an object",
      '{"a":[{"b":{"clientSecret":"x"}}]}',
      `{"a":[{"b":{"clientSecret":"${REDACTION_SENTINEL}"}}]}`,
    ],
    [
      "an array inside an array",
      '{"a":[[{"token":"t"}]]}',
      `{"a":[[{"token":"${REDACTION_SENTINEL}"}]]}`,
    ],
  ])("descends into non-matching %s", (_name, input, expected) => {
    expect(redactBodyText("json", input)).toBe(expected)
  })
})

describe("§13 escaped json keys", () => {
  const ESCAPED_PASSWORD = esc('{"~u0070assword":"hunter2"}')
  const ESCAPED_AUTHORIZATION = esc('{"~u0041uthorization":"Basic eHh4"}')
  const ESCAPED_SOLIDUS = esc('{"api~/password":"p","n":1}')
  const ILLEGAL_ESCAPE = esc('{"pa~xss":"1","password":"y"}')
  const SURROGATE_PAIR = esc('{"pass~ud83d~ude00word":"x","password":"y"}')
  const ESCAPED_QUOTE = esc('{"pa~"ss":"1","token":"t"}')
  const ESCAPED_BACKSPACE = esc('{"pa~bssword":"x","cookie":"c"}')

  it("uses fixtures that still contain real backslashes", () => {
    expect(ESCAPED_PASSWORD).toContain(`${B}u0070`)
    expect(ESCAPED_AUTHORIZATION).toContain(`${B}u0041`)
    expect(ESCAPED_SOLIDUS).toContain(`${B}/`)
    expect(ILLEGAL_ESCAPE).toContain(`${B}x`)
    expect(SURROGATE_PAIR).toContain(`${B}ud83d${B}ude00`)
    expect(ESCAPED_QUOTE).toContain(`${B}"`)
    expect(ESCAPED_BACKSPACE).toContain(`${B}b`)
  })

  it("treats an escaped json key as its decoded name", () => {
    // redaction — the decoded name decides, the original key bytes survive
    expect(redactBodyText("json", ESCAPED_PASSWORD)).toBe(
      esc(`{"~u0070assword":"${REDACTION_SENTINEL}"}`),
    )
    expect(redactBodyText("json", ESCAPED_AUTHORIZATION)).toBe(
      esc(`{"~u0041uthorization":"${REDACTION_SENTINEL}"}`),
    )
    expect(redactBodyText("json", ESCAPED_SOLIDUS)).toBe(
      esc(`{"api~/password":"${REDACTION_SENTINEL}","n":1}`),
    )
    // an illegal escape fails the scan and falls back to the text path
    expect(redactBodyText("json", ILLEGAL_ESCAPE)).toBe(
      esc(`{"pa~xss":"1","password":${REDACTION_SENTINEL}`),
    )
    expect(redactBodyText("json", SURROGATE_PAIR)).toBe(
      esc(`{"pass~ud83d~ude00word":"x","password":"${REDACTION_SENTINEL}"}`),
    )
    expect(redactBodyText("json", ESCAPED_QUOTE)).toBe(
      esc(`{"pa~"ss":"1","token":"${REDACTION_SENTINEL}"}`),
    )
    expect(redactBodyText("json", ESCAPED_BACKSPACE)).toBe(
      esc(`{"pa~bssword":"x","cookie":"${REDACTION_SENTINEL}"}`),
    )

    // clearing — key bytes survive there too
    expect(clearSentinelBody("json", esc(`{"~u0070assword":"${REDACTION_SENTINEL}"}`))).toEqual({
      content: esc('{"~u0070assword":""}'),
      fields: ["password"],
    })

    // the gate names the decoded key
    expect(sentinelBodyFields("json", esc(`{"~u0070assword":"${REDACTION_SENTINEL}"}`))).toEqual([
      "password",
    ])
    expect(sentinelBodyFields("json", esc(`{"api~/password":"${REDACTION_SENTINEL}","n":1}`))).toEqual([
      "api/password",
    ])
  })
})

describe("§14 urlencoded bodies", () => {
  it("keeps every urlencoded field and non-matching bytes", () => {
    const redacted = redactBodyText("urlencoded", "grant_type=password&password=p&client_secret=xyz")

    expect(redacted).toBe(
      `grant_type=password&password=${REDACTION_SENTINEL}&client_secret=${REDACTION_SENTINEL}`,
    )
    expect(redacted.split("&")).toHaveLength(3)
    // the separator is the first `=`, so a value containing `=` keeps its key
    expect(redactBodyText("urlencoded", "token=abc=def&page=2")).toBe(
      `token=${REDACTION_SENTINEL}&page=2`,
    )
  })
})

describe("§15 text bodies", () => {
  it.each([
    ["basic", `Authorization: Basic ${BASIC}`, `Authorization: ${REDACTION_SENTINEL}`],
    ["digest", `Authorization: Digest ${DIGEST}`, `Authorization: ${REDACTION_SENTINEL}`],
    ["spacey", "password  =  hunter2", `password  =  ${REDACTION_SENTINEL}`],
  ])("redacts %s to end of line", (_name, input, expected) => {
    const redacted = redactBodyText("text", input)

    expect(redacted).toBe(expected)
    expect(redacted.split(REDACTION_SENTINEL)).toHaveLength(2)
    expect(redacted).not.toContain("Mufasa")
    expect(redacted).not.toContain(BASIC)
  })
})

describe("§17 non-sensitive key-value pairs", () => {
  const rows = [
    pair("X-Note", "password: hunter2"),
    pair("X-Sample", `Bearer ${JWT}`),
    pair("X-Challenge", `Digest ${DIGEST}`),
  ]

  it.each([["headers"], ["params"], ["formData"]])(
    "keeps a non-sensitive %s value byte-identical",
    () => {
      expect(redactKeyValuePairs(rows).map((row) => row.value)).toEqual([
        "password: hunter2",
        `Bearer ${JWT}`,
        `Digest ${DIGEST}`,
      ])
    },
  )

  it("still redacts by field name", () => {
    expect(redactValue("Cookie", COOKIE)).toBe(REDACTION_SENTINEL)
    expect(redactValue("Cookie", "")).toBe("")
  })
})

describe("§18 line terminators", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["lone CR", "\r"],
  ])("preserves %s line terminators", (_name, terminator) => {
    const input = `password: hunter2${terminator}X-Note: keep`
    expect(redactBodyText("text", input)).toBe(
      `password: ${REDACTION_SENTINEL}${terminator}X-Note: keep`,
    )
  })
})

describe("§19 idempotence and scan state", () => {
  it("is idempotent across all paths", () => {
    const cases: [Parameters<typeof redactBodyText>[0], string][] = [
      ["json", '{"id":1,"password":"hunter2","nested":{"token":"t"}}'],
      ["urlencoded", "grant_type=password&password=p&client_secret=xyz"],
      ["text", `Cookie: ${COOKIE}\r\nAuthorization: Basic ${BASIC}\rX-Note: keep`],
    ]

    for (const [kind, input] of cases) {
      const once = redactBodyText(kind, input)
      expect(redactBodyText(kind, once)).toBe(once)
    }
  })

  it("produces the same result for a line alone and inside a multi-line body", () => {
    const lines = [`Cookie: ${COOKIE}`, "Authorization: Bearer tok", "password: hunter2"]

    expect(redactBodyText("text", lines.join("\n"))).toBe(
      `Cookie: ${REDACTION_SENTINEL}\nAuthorization: ${REDACTION_SENTINEL}\npassword: ${REDACTION_SENTINEL}`,
    )
  })

  it("is unaffected by a preceding call", () => {
    expect(redactBodyText("text", "Cookie: a=1")).toBe(`Cookie: ${REDACTION_SENTINEL}`)
    expect(redactBodyText("text", `Authorization: Basic ${BASIC}`)).toBe(
      `Authorization: ${REDACTION_SENTINEL}`,
    )
    expect(redactBodyText("text", "password: hunter2")).toBe(`password: ${REDACTION_SENTINEL}`)
  })
})

describe("§20 malformed percent escapes", () => {
  it("never throws on malformed percent escapes", () => {
    expect(redactBodyText("urlencoded", "%E0%A4%A=1&pass%word=2&%70assword%ZZ=3")).toBe(
      `%E0%A4%A=1&pass%word=2&%70assword%ZZ=${REDACTION_SENTINEL}`,
    )
    expect(redactUrlQuery("https://api.example.com/s?%E0%A4%A=1&%70assword%ZZ=3")).toBe(
      `https://api.example.com/s?%E0%A4%A=1&%70assword%ZZ=${REDACTION_SENTINEL}`,
    )
  })

  it("decodes leniently", () => {
    expect(lenientDecodeKey("%70assword%ZZ")).toBe("password%ZZ")
    expect(lenientDecodeKey("%E0%A4%A")).toBe("%E0%A4%A")
    expect(lenientDecodeKey("pass%word")).toBe("pass%word")
  })
})

describe("§21 documented over-redaction", () => {
  it.each([
    [
      "urlencoded text under a raw body",
      "text" as const,
      "grant_type=password&password=p&client_secret=xyz",
      `grant_type=password&password=${REDACTION_SENTINEL}`,
    ],
    [
      "a single-line curl command",
      "text" as const,
      `curl -H 'Authorization: Basic ${BASIC}' https://x`,
      `curl -H 'Authorization: ${REDACTION_SENTINEL}`,
    ],
    [
      "unparsable json",
      "json" as const,
      '{"password":"hunter2"',
      `{"password":${REDACTION_SENTINEL}`,
    ],
  ])("over-redacts %s (documented)", (_name, kind, input, expected) => {
    expect(redactBodyText(kind, input)).toBe(expected)
  })
})

describe("§21 malformed json values degrade to the text path", () => {
  // `skipLiteral` used to read to the next delimiter, which accepted garbage
  // primitives as valid values and kept the body on the structured json path.
  it.each([
    [
      "a truncated keyword",
      '{"note":truX,"password":"hunter2"}',
      `{"note":truX,"password":${REDACTION_SENTINEL}`,
    ],
    ["an incomplete number", '{"a":1e,"password":"p"}', `{"a":1e,"password":${REDACTION_SENTINEL}`],
    ["a doubled sign", '{"a":--1,"password":"p"}', `{"a":--1,"password":${REDACTION_SENTINEL}`],
    ["a hex literal", '{"a":0x1F,"password":"p"}', `{"a":0x1F,"password":${REDACTION_SENTINEL}`],
    [
      "an overlong keyword",
      '{"a":nulll,"password":"p"}',
      `{"a":nulll,"password":${REDACTION_SENTINEL}`,
    ],
  ])("degrades %s to the text path", (_name, input, expected) => {
    expect(redactBodyText("json", input)).toBe(expected)
  })

  it("still accepts every legal json primitive", () => {
    expect(redactBodyText("json", '{"a":[true,false,null,-0,1.5e-3,1E+10,9007199254740993123456789],"password":"p"}')).toBe(
      `{"a":[true,false,null,-0,1.5e-3,1E+10,9007199254740993123456789],"password":"${REDACTION_SENTINEL}"}`,
    )
  })
})

describe("§22–§24 the field-name hard list", () => {
  it("matches camelCase sensitive keys", () => {
    for (const key of [
      "accessToken",
      "refreshToken",
      "idToken",
      "authToken",
      "sessionToken",
      "csrfToken",
      "clientSecret",
    ]) {
      expect(isSensitiveKey(key)).toBe(true)
    }
  })

  it("matches the shared fixture", () => {
    for (const key of sharedKeys.sensitive) {
      expect([key, isSensitiveKey(key)]).toEqual([key, true])
    }

    for (const key of sharedKeys.insensitive) {
      expect([key, isSensitiveKey(key)]).toEqual([key, false])
    }
  })
})

describe("§25 url query redaction", () => {
  it.each([
    ["a percent escape", "https://api.example.com/s?q=a%20b", "https://api.example.com/s?q=a%20b"],
    ["a plus sign", "https://api.example.com/s?q=a+b", "https://api.example.com/s?q=a+b"],
    ["host casing", "https://API.Example.COM/s?q=1", "https://API.Example.COM/s?q=1"],
    ["a default port", "https://api.example.com:443/s?q=1", "https://api.example.com:443/s?q=1"],
    ["a fragment", "https://api.example.com/s?q=1#frag", "https://api.example.com/s?q=1#frag"],
    ["a relative url", "/api/items?q=1", "/api/items?q=1"],
    [
      "a template on a non-matching key",
      "https://api.example.com/s?path={{base}}%2Fusers",
      "https://api.example.com/s?path={{base}}%2Fusers",
    ],
    [
      "a repeated sensitive key",
      "https://api.example.com/s?token=a&token=b",
      `https://api.example.com/s?token=${REDACTION_SENTINEL}&token=${REDACTION_SENTINEL}`,
    ],
  ])("preserves every non-matching byte of the url for %s", (_name, input, expected) => {
    expect(redactUrlQuery(input)).toBe(expected)
  })

  it("leaves a url without a query untouched", () => {
    expect(redactUrlQuery("https://api.example.com/s#frag")).toBe("https://api.example.com/s#frag")
  })
})

describe("body kind dispatch", () => {
  it("maps declared types, never sniffs content", () => {
    expect(bodyKindFromBodyType("json")).toBe("json")
    expect(bodyKindFromBodyType("form-urlencoded")).toBe("urlencoded")
    expect(bodyKindFromBodyType("raw")).toBe("text")
    expect(bodyKindFromBodyType("none")).toBe("text")

    expect(bodyKindFromContentType("application/json; charset=utf-8")).toBe("json")
    expect(bodyKindFromContentType("application/x-www-form-urlencoded")).toBe("urlencoded")
    expect(bodyKindFromContentType("text/plain")).toBe("text")
  })
})

describe("clearing the sentinel out of a body", () => {
  it("clears a sensitive field and leaves prose alone", () => {
    expect(clearSentinelBody("urlencoded", `user=bob&password=${REDACTION_SENTINEL}`)).toEqual({
      content: "user=bob&password=",
      fields: ["password"],
    })
    expect(clearSentinelBody("text", `Cookie: ${REDACTION_SENTINEL}`)).toEqual({
      content: "Cookie: ",
      fields: ["Cookie"],
    })
    expect(clearSentinelBody("text", `note: the string ${REDACTION_SENTINEL} appears here`)).toEqual({
      content: `note: the string ${REDACTION_SENTINEL} appears here`,
      fields: [],
    })
    expect(clearSentinelBody("json", `{"note":"${REDACTION_SENTINEL}"}`)).toEqual({
      content: `{"note":"${REDACTION_SENTINEL}"}`,
      fields: [],
    })
  })

  it("clears sentinel pairs and marks them", () => {
    expect(clearSentinelPairs([pair("Cookie", REDACTION_SENTINEL), pair("page", "1")])).toEqual([
      { id: "Cookie-1", enabled: true, key: "Cookie", value: "", description: "", redacted: true },
      { id: "page-1", enabled: true, key: "page", value: "1", description: "" },
    ])
  })
})
