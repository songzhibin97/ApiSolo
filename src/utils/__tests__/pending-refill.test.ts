import { describe, expect, it } from "vitest"
import { createI18n } from "vue-i18n"

import {
  bannerFields,
  formatPendingField,
  identityTuple,
  pendingGroupTitleKey,
  pendingRefillFields,
  reselectFileFields,
} from "../pending-refill"
import type { PendingField, PendingRefillSource, PendingSource, TranslateFn } from "../pending-refill"
import { REDACTION_SENTINEL } from "../redaction"
import en from "../../i18n/en"
import zhCN from "../../i18n/zh-CN"
import type { AuthConfig, KeyValuePair, RequestBody } from "../../types"

/**
 * A real i18n instance, not a `t: (key) => key` stub. Under a passthrough stub
 * the rendered output is the key spelled out, so an assertion that the text is
 * localized holds no matter what the message files say -- it would pass on an
 * empty catalogue.
 */
const i18n = createI18n({
  legacy: false,
  locale: "en",
  fallbackLocale: "en",
  messages: { "zh-CN": zhCN, en },
})

function translator(locale: "en" | "zh-CN"): TranslateFn {
  i18n.global.locale.value = locale
  return (key, named) =>
    (named ? i18n.global.t(key, named) : i18n.global.t(key)) as unknown as string
}

function pair(key: string, value: string, overrides: Partial<KeyValuePair> = {}): KeyValuePair {
  return { id: `${key}-1`, enabled: true, key, value, description: "", ...overrides }
}

function body(overrides: Partial<RequestBody> = {}): RequestBody {
  return {
    type: "none",
    content: "",
    formData: [],
    binaryPath: "",
    binaryContent: undefined,
    ...overrides,
  } as RequestBody
}

function request(overrides: Partial<PendingRefillSource> = {}): PendingRefillSource {
  return {
    url: "https://api.example.com/things",
    headers: [],
    params: [],
    body: body(),
    auth: { type: "none" } as AuthConfig,
    ...overrides,
  }
}

function labels(source: PendingRefillSource): string[] {
  const t = translator("en")
  return pendingRefillFields(source).map((field) => formatPendingField(field, t))
}

describe("§7 every value history replaced is listed for re-entry", () => {
  // The auth slots are the reason this slice exists. History blanks them rather
  // than writing a placeholder, so a check that hunts for placeholders reports
  // a clean request and the save goes through silently -- then 401s.
  it("lists a blanked Basic password", () => {
    const fields = pendingRefillFields(
      request({ auth: { type: "basic", basic: { username: "bob", password: "" } } as AuthConfig }),
    )

    expect(fields.map(identityTuple)).toEqual([["refill", "auth", "basic-password", ""]])
    expect(fields.map((f) => formatPendingField(f, translator("en")))).toEqual(["Auth · Basic password"])
  })

  it("lists a blanked Bearer token", () => {
    const fields = pendingRefillFields(
      request({ auth: { type: "bearer", bearer: { token: "" } } as AuthConfig }),
    )

    expect(fields.map(identityTuple)).toEqual([["refill", "auth", "bearer-token", ""]])
    expect(fields.map((f) => formatPendingField(f, translator("en")))).toEqual(["Auth · Bearer token"])
  })

  it("lists a blanked API key value", () => {
    const fields = pendingRefillFields(
      request({
        auth: {
          type: "api-key",
          apiKey: { key: "X-Api-Key", value: "", addTo: "header" },
        } as AuthConfig,
      }),
    )

    // The key name is the user's own, so it stays out of the display text and
    // in the identity: `name` is what the acknowledgement is keyed on.
    expect(fields.map(identityTuple)).toEqual([["refill", "auth", "api-key", "X-Api-Key"]])
    expect(fields.map((f) => formatPendingField(f, translator("en")))).toEqual(["Auth · API key X-Api-Key"])
  })

  it("lists a placeholder in a header, a param, the url query, the body and a form row", () => {
    expect(
      labels(
        request({
          url: `https://api.example.com/s?access_token=${REDACTION_SENTINEL}&page=2`,
          headers: [pair("Authorization", REDACTION_SENTINEL), pair("Accept", "*/*")],
          params: [pair("api_key", REDACTION_SENTINEL), pair("page", "2")],
          body: body({
            type: "json",
            content: `{"user":"bob","password":"${REDACTION_SENTINEL}"}`,
          }),
        }),
      ),
    ).toEqual([
      "Header · Authorization",
      "Query · api_key",
      "Query · access_token",
      "Body · password",
    ])
  })

  it("lists a placeholder in a non-file form row", () => {
    expect(
      labels(
        request({
          body: body({
            type: "form-data",
            formData: [pair("token", REDACTION_SENTINEL), pair("name", "alice")],
          }),
        }),
      ),
    ).toEqual(["Form · token"])
  })

  // A row that has been through the replay path holds an empty value and a
  // marker instead of the placeholder, because the placeholder must never be
  // replayable. Both spellings have to count.
  it("lists a row already cleared to a marker", () => {
    expect(
      labels(request({ headers: [pair("Authorization", "", { redacted: true })] })),
    ).toEqual(["Header · Authorization"])
  })

  it("says nothing about a request with nothing missing", () => {
    expect(
      pendingRefillFields(
        request({
          headers: [pair("Accept", "*/*")],
          params: [pair("page", "2")],
          auth: { type: "bearer", bearer: { token: "live-token" } } as AuthConfig,
        }),
      ),
    ).toEqual([])
  })
})

describe("§8 files are a separate class: nothing to refill, a file to re-pick", () => {
  // Deliberately free of placeholders and blank auth slots. With either of
  // those present the dialog would open anyway and this class could be entirely
  // unwired without the test noticing.
  const fileOnly = request({
    body: body({
      type: "form-data",
      formData: [pair("avatar", "", { valueType: "file", fileName: "me.png" } as never)],
    }),
  })

  it("the fixture carries no placeholder and no blank auth slot", () => {
    expect(JSON.stringify(fileOnly)).not.toContain(REDACTION_SENTINEL)
    expect(fileOnly.auth.type).toBe("none")
  })

  it("lists a form file row as needing re-selection", () => {
    expect(pendingRefillFields(fileOnly).map(identityTuple)).toEqual([
      ["reselect-file", "file", null, "avatar"],
    ])
    expect(pendingRefillFields(fileOnly).map((f) => formatPendingField(f, translator("en")))).toEqual(["Form · avatar"])
  })

  it("lists a binary body as needing re-selection", () => {
    const fields = pendingRefillFields(
      request({ body: body({ type: "binary", binaryPath: "photo.png" }) }),
    )

    expect(fields.map(identityTuple)).toEqual([["reselect-file", "binary", null, "photo.png"]])
    expect(fields.map((f) => formatPendingField(f, translator("en")))).toEqual(["Body · photo.png"])
    expect(reselectFileFields(fields)).toHaveLength(1)
  })
})

describe("§9 each entry says where it lives, not just what it is called", () => {
  it("tells three fields of the same name apart", () => {
    const fields = labels(
      request({
        headers: [pair("password", REDACTION_SENTINEL)],
        body: body({ type: "json", content: `{"password":"${REDACTION_SENTINEL}"}` }),
        params: [pair("password", REDACTION_SENTINEL)],
      }),
    )

    expect(fields).toEqual(["Header · password", "Query · password", "Body · password"])
    expect(new Set(fields).size).toBe(3)
  })

  it("gives the auth slots a structural position rather than a bare name", () => {
    expect(
      labels(request({ auth: { type: "basic", basic: { username: "u", password: "" } } as AuthConfig })),
    ).toEqual(["Auth · Basic password"])
  })
})

/**
 * The query string arrives from two directions and the two have to be told
 * apart from a genuine repeat. Params are a request's source of truth; a tab
 * opened from history keeps the query in its url as well. Collapsing the
 * overlap is right; collapsing a repeat inside one source is a lie in the other
 * direction — the dialog would promise fewer fields to refill than there are.
 */
describe("the query overlap collapses, a same-source repeat does not", () => {
  it("reports one entry when params and the url name the same parameter", () => {
    expect(
      labels(
        request({
          url: `https://api.example.com/s?api_key=${REDACTION_SENTINEL}`,
          params: [pair("api_key", REDACTION_SENTINEL)],
        }),
      ),
    ).toEqual(["Query · api_key"])
  })

  it("reports both entries for a repeated parameter name in the url", () => {
    expect(
      labels(
        request({
          url: `https://api.example.com/s?tag=${REDACTION_SENTINEL}&tag=${REDACTION_SENTINEL}`,
        }),
      ),
    ).toEqual(["Query · tag", "Query · tag"])
  })

  it("reports both entries for a repeated parameter name in the params", () => {
    expect(
      labels(
        request({
          params: [pair("tag", REDACTION_SENTINEL), { ...pair("tag", REDACTION_SENTINEL), id: "tag-2" }],
        }),
      ),
    ).toEqual(["Query · tag", "Query · tag"])
  })

  // Both sources carry the same repeated name: still two, not four and not one.
  it("keeps the count at the real number when both sources repeat it", () => {
    expect(
      labels(
        request({
          url: `https://api.example.com/s?tag=${REDACTION_SENTINEL}&tag=${REDACTION_SENTINEL}`,
          params: [pair("tag", REDACTION_SENTINEL), { ...pair("tag", REDACTION_SENTINEL), id: "tag-2" }],
        }),
      ),
    ).toEqual(["Query · tag", "Query · tag"])
  })
})

/**
 * §15 — the six classes that already worked, one case each, so that removing
 * any single wire in `pendingRefillFields` shows up as exactly one red case
 * rather than a vague "several things broke". Testing the helpers alone would
 * not do it: a helper can be written, tested and never called.
 */
describe("§15 every source class survives the panel entry point on its own", () => {
  const cases: Array<[string, PendingRefillSource, ReturnType<typeof identityTuple>]> = [
    [
      "a redacted header",
      request({ headers: [pair("Authorization", REDACTION_SENTINEL)] }),
      ["refill", "header", null, "Authorization"],
    ],
    [
      "a redacted query parameter row",
      request({ params: [pair("apikey", REDACTION_SENTINEL)] }),
      ["refill", "query", null, "apikey"],
    ],
    [
      "a redacted parameter that exists only in the url",
      request({ url: `https://api.example.com/s?apikey=${REDACTION_SENTINEL}` }),
      ["refill", "query", null, "apikey"],
    ],
    [
      "a redacted form text row",
      request({
        body: body({ type: "form-data", formData: [pair("token", REDACTION_SENTINEL)] }),
      }),
      ["refill", "form", null, "token"],
    ],
    [
      "a blanked auth slot",
      request({ auth: { type: "bearer", bearer: { token: "" } } as AuthConfig }),
      ["refill", "auth", "bearer-token", ""],
    ],
    [
      "a form file row",
      request({
        body: body({
          type: "form-data",
          formData: [pair("avatar", "", { valueType: "file" } as never)],
        }),
      }),
      ["reselect-file", "file", null, "avatar"],
    ],
    [
      "a binary body",
      request({ body: body({ type: "binary", binaryPath: "photo.png" }) }),
      ["reselect-file", "binary", null, "photo.png"],
    ],
  ]

  it.each(cases)("still reports %s", (_label, source, expected) => {
    expect(pendingRefillFields(source).map(identityTuple)).toEqual([expected])
  })
})

/**
 * §5-§8 — what still needs re-entering is read off the body as it stands now.
 * The panel side reaches these through `bodyRedactedFields`, the names replay
 * wrote down when it emptied them.
 */
describe("§5-§8 the body list follows the body's current contents", () => {
  const recorded = (content: string, fields: string[], type = "json") =>
    request({ body: body({ type: type as never, content }), bodyRedactedFields: fields })

  it("§4 keeps the entry when the body is only reformatted", () => {
    const compact = recorded(`{"token":"","keep":"v"}`, ["token"])
    const pretty = recorded(`{\n  "token": "",\n  "keep": "v"\n}`, ["token"])

    expect(pendingRefillFields(compact).map(identityTuple)).toEqual([
      ["refill", "body", null, "token"],
    ])
    expect(pendingRefillFields(pretty).map(identityTuple)).toEqual(
      pendingRefillFields(compact).map(identityTuple),
    )
  })

  it("§5 keeps the entry when a different key is edited", () => {
    expect(
      pendingRefillFields(recorded(`{"token":"","keep":"CHANGED"}`, ["token"])).map(identityTuple),
    ).toEqual([["refill", "body", null, "token"]])
  })

  it("§6 drops the entry once the value is typed back in", () => {
    expect(pendingRefillFields(recorded(`{"token":"REAL","keep":"v"}`, ["token"]))).toEqual([])
  })

  it("§6 keeps the other entries that are still empty", () => {
    expect(
      pendingRefillFields(recorded(`{"token":"REAL","secret":""}`, ["token", "secret"])).map(
        identityTuple,
      ),
    ).toEqual([["refill", "body", null, "secret"]])
  })

  it("§7 drops the entry when the key is deleted outright", () => {
    expect(pendingRefillFields(recorded(`{"keep":"v"}`, ["token"]))).toEqual([])
  })

  it("§3 reports a key emptied twice twice, not once", () => {
    expect(
      pendingRefillFields(recorded(`{"a":{"token":""},"b":{"token":""}}`, ["token", "token"])).map(
        identityTuple,
      ),
    ).toEqual([
      ["refill", "body", null, "token"],
      ["refill", "body", null, "token"],
    ])
  })

  it("§8 holds every recorded key while the body will not parse", () => {
    const fields = pendingRefillFields(recorded(`{"token": "",`, ["token", "secret"]))

    expect(fields.map(identityTuple)).toEqual([
      ["refill-unverifiable", "body", null, "token"],
      ["refill-unverifiable", "body", null, "secret"],
    ])
  })

  it("§8 does not apply the unverifiable class to a plain-text body", () => {
    expect(
      pendingRefillFields(recorded("token:", ["token"], "text")).map(identityTuple),
    ).toEqual([["refill", "body", null, "token"]])
  })
})

/**
 * §10-§11 — the always-on notice and the save gate read one list. `bannerFields`
 * is that single derivation: changing it moves both whether the notice appears
 * and what it says, which is exactly what stopped the two from drifting apart.
 */
describe("§10-§11 the notice is the gate's list minus the files", () => {
  const mixed: PendingField[] = [
    { kind: "refill", source: "header", name: "Authorization" },
    { kind: "refill-unverifiable", source: "body", name: "token" },
    { kind: "refill", source: "auth", slot: "bearer-token", name: "" },
    { kind: "reselect-file", source: "file", name: "avatar" },
    { kind: "reselect-file", source: "binary", name: "" },
  ]

  it("keeps both refill classes and drops the files, entry by entry", () => {
    expect(bannerFields(mixed).map(identityTuple)).toEqual([
      ["refill", "header", null, "Authorization"],
      ["refill-unverifiable", "body", null, "token"],
      ["refill", "auth", "bearer-token", ""],
    ])
    expect(bannerFields(mixed)).toHaveLength(3)
  })

  it("§11 names a blanked auth slot, which the old notice never mentioned", () => {
    const authOnly = pendingRefillFields(
      request({ auth: { type: "bearer", bearer: { token: "" } } as AuthConfig }),
    )

    expect(bannerFields(authOnly).map(identityTuple)).toEqual([
      ["refill", "auth", "bearer-token", ""],
    ])
  })

  it("§12 gives nothing to show for a request with nothing pending", () => {
    expect(bannerFields([])).toEqual([])
  })

  it("§10 shows nothing when only files are pending", () => {
    expect(bannerFields(mixed.filter((f) => f.kind === "reselect-file"))).toEqual([])
  })
})

describe("§8 each pending class has its own heading", () => {
  it("maps the three classes to three distinct keys", () => {
    expect(pendingGroupTitleKey("refill")).toBe("history.refillTitle")
    expect(pendingGroupTitleKey("refill-unverifiable")).toBe("history.refillUnparseableBody")
    expect(pendingGroupTitleKey("reselect-file")).toBe("history.reselectFileTitle")
  })

  it.each(["en", "zh-CN"] as const)("renders a whole sentence in %s", (locale) => {
    const t = translator(locale)
    const key = pendingGroupTitleKey("refill-unverifiable")
    const rendered = t(key, { count: 2 })

    expect(rendered).not.toBe(key)
    expect(rendered).not.toBe(t(pendingGroupTitleKey("refill"), { count: 2 }))
    expect(rendered.length).toBeGreaterThan(20)
  })
})

/**
 * §17, §19, §20 — every part of an entry that reaches the screen follows the
 * interface language, and none of it reaches the identity.
 */
describe("§17 entries read in the interface language", () => {
  const sample: PendingField[] = [
    { kind: "refill", source: "header", name: "Authorization" },
    { kind: "refill", source: "query", name: "apikey" },
    { kind: "refill", source: "form", name: "token" },
    { kind: "refill", source: "body", name: "password" },
    { kind: "refill", source: "auth", slot: "bearer-token", name: "" },
    { kind: "refill", source: "auth", slot: "basic-password", name: "" },
    { kind: "refill", source: "auth", slot: "api-key", name: "X-Api-Key" },
  ]

  it("renders the English wording", () => {
    const t = translator("en")

    expect(sample.map((f) => formatPendingField(f, t))).toEqual([
      "Header · Authorization",
      "Query · apikey",
      "Form · token",
      "Body · password",
      "Auth · Bearer token",
      "Auth · Basic password",
      "Auth · API key X-Api-Key",
    ])
  })

  it("renders the Chinese wording, keeping the user's own names as written", () => {
    const t = translator("zh-CN")

    expect(sample.map((f) => formatPendingField(f, t))).toEqual([
      "请求头 · Authorization",
      "查询参数 · apikey",
      "表单 · token",
      "请求体 · password",
      "认证 · Bearer 令牌",
      "认证 · Basic 密码",
      "认证 · API Key X-Api-Key",
    ])
  })

  it.each(["en", "zh-CN"] as const)("leaks no message key into %s output", (locale) => {
    const t = translator(locale)

    for (const rendered of sample.map((f) => formatPendingField(f, t))) {
      expect(rendered).not.toContain("pendingField.")
    }
  })

  it("does not translate a field name that happens to look like a key", () => {
    const t = translator("zh-CN")
    const f: PendingField = { kind: "refill", source: "header", name: "pendingField.sourceHeader" }

    expect(formatPendingField(f, t)).toBe("请求头 · pendingField.sourceHeader")
  })
})

describe("§19 every source value has wording in both locales", () => {
  const sources: PendingSource[] = ["header", "query", "form", "body", "auth", "file", "binary"]

  it.each(sources)("%s renders as text rather than a key", (source) => {
    const f: PendingField =
      source === "auth"
        ? { kind: "refill", source: "auth", slot: "bearer-token", name: "x" }
        : { kind: "refill", source, name: "x" }

    for (const locale of ["en", "zh-CN"] as const) {
      const rendered = formatPendingField(f, translator(locale))

      expect(rendered).not.toContain("pendingField.")
      expect(rendered.split(" · ")[0]).not.toBe("")
    }
  })

  it("gives the two locales the same set of keys", () => {
    const keys = (node: unknown, prefix = ""): string[] =>
      typeof node === "object" && node !== null
        ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
            keys(v, prefix ? `${prefix}.${k}` : k),
          )
        : [prefix]

    expect(keys(zhCN.pendingField).sort()).toEqual(keys(en.pendingField).sort())
    expect(keys(zhCN.pendingField)).toHaveLength(10)
  })
})

describe("§20 the two nameless fallbacks read as sentences, not placeholders", () => {
  const unnamedBinary: PendingField = { kind: "reselect-file", source: "binary", name: "" }
  const unnamedApiKey: PendingField = {
    kind: "refill",
    source: "auth",
    slot: "api-key",
    name: "",
  }

  it("names a binary body with no file name", () => {
    expect(formatPendingField(unnamedBinary, translator("en"))).toBe("Body · no file selected")
    expect(formatPendingField(unnamedBinary, translator("zh-CN"))).toBe("请求体 · 未选择文件")
  })

  it("names an API key with no key name", () => {
    expect(formatPendingField(unnamedApiKey, translator("en"))).toBe("Auth · API key (no key name)")
    expect(formatPendingField(unnamedApiKey, translator("zh-CN"))).toBe(
      "认证 · API Key（未填键名）",
    )
  })

  // The words the code used to hard-code. If either fallback regressed to them
  // the English assertions above would still read naturally, so they are ruled
  // out explicitly.
  it.each(["en", "zh-CN"] as const)("uses none of the old hard-coded words in %s", (locale) => {
    const t = translator(locale)

    expect(formatPendingField(unnamedBinary, t)).not.toContain("binary body")
    expect(formatPendingField(unnamedApiKey, t)).not.toContain("API key value")
  })
})

/**
 * §18 — the two halves of an entry move independently. Display text follows the
 * interface language; identity does not follow anything. If the localized
 * string ever found its way back into the identity, an acknowledgement given in
 * one language would stop counting in the other, at the one gate that exists to
 * stop a credential being saved blank.
 */
describe("§18 language changes the text and nothing else", () => {
  const fields: PendingField[] = [
    { kind: "refill", source: "auth", slot: "bearer-token", name: "" },
    { kind: "refill", source: "body", name: "token" },
  ]

  it("renders differently in the two locales", () => {
    // Establishes that the locales differ at all. Without it the identity
    // assertion below would hold on a catalogue where both languages happen to
    // read the same, and prove nothing.
    expect(fields.map((f) => formatPendingField(f, translator("en")))).not.toEqual(
      fields.map((f) => formatPendingField(f, translator("zh-CN"))),
    )
  })

  it("produces the same identity in both locales", () => {
    translator("en")
    const inEnglish = fields.map(identityTuple)

    translator("zh-CN")
    const inChinese = fields.map(identityTuple)

    expect(inEnglish).toEqual(inChinese)
  })

  it("keeps every localized word out of the identity", () => {
    for (const locale of ["en", "zh-CN"] as const) {
      const t = translator(locale)

      for (const field of fields) {
        const identity = JSON.stringify(identityTuple(field))

        for (const word of formatPendingField(field, t).split(" · ")) {
          if (word && field.name !== word) {
            expect(identity).not.toContain(word)
          }
        }
      }
    }
  })
})
