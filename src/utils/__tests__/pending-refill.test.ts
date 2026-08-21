import { describe, expect, it } from "vitest"

import { pendingRefillFields, reselectFileFields } from "../pending-refill"
import type { PendingRefillSource } from "../pending-refill"
import { REDACTION_SENTINEL } from "../redaction"
import type { AuthConfig, KeyValuePair, RequestBody } from "../../types"

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

function paths(source: PendingRefillSource): string[] {
  return pendingRefillFields(source).map((item) => item.path)
}

describe("§7 every value history replaced is listed for re-entry", () => {
  // The auth slots are the reason this slice exists. History blanks them rather
  // than writing a placeholder, so a check that hunts for placeholders reports
  // a clean request and the save goes through silently -- then 401s.
  it("lists a blanked Basic password", () => {
    const fields = pendingRefillFields(
      request({ auth: { type: "basic", basic: { username: "bob", password: "" } } as AuthConfig }),
    )

    expect(fields).toEqual([{ kind: "refill", source: "auth", path: "Auth · Basic password" }])
  })

  it("lists a blanked Bearer token", () => {
    const fields = pendingRefillFields(
      request({ auth: { type: "bearer", bearer: { token: "" } } as AuthConfig }),
    )

    expect(fields).toEqual([{ kind: "refill", source: "auth", path: "Auth · Bearer token" }])
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

    expect(fields).toEqual([
      { kind: "refill", source: "auth", path: "Auth · API key X-Api-Key" },
    ])
  })

  it("lists a placeholder in a header, a param, the url query, the body and a form row", () => {
    expect(
      paths(
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
      paths(
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
      paths(request({ headers: [pair("Authorization", "", { redacted: true })] })),
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
    expect(pendingRefillFields(fileOnly)).toEqual([
      { kind: "reselect-file", source: "file", path: "Form · avatar" },
    ])
  })

  it("lists a binary body as needing re-selection", () => {
    const fields = pendingRefillFields(
      request({ body: body({ type: "binary", binaryPath: "photo.png" }) }),
    )

    expect(fields).toEqual([
      { kind: "reselect-file", source: "binary", path: "Body · photo.png" },
    ])
    expect(reselectFileFields(fields)).toHaveLength(1)
  })
})

describe("§9 each entry says where it lives, not just what it is called", () => {
  it("tells three fields of the same name apart", () => {
    const fields = paths(
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
      paths(request({ auth: { type: "basic", basic: { username: "u", password: "" } } as AuthConfig })),
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
      paths(
        request({
          url: `https://api.example.com/s?api_key=${REDACTION_SENTINEL}`,
          params: [pair("api_key", REDACTION_SENTINEL)],
        }),
      ),
    ).toEqual(["Query · api_key"])
  })

  it("reports both entries for a repeated parameter name in the url", () => {
    expect(
      paths(
        request({
          url: `https://api.example.com/s?tag=${REDACTION_SENTINEL}&tag=${REDACTION_SENTINEL}`,
        }),
      ),
    ).toEqual(["Query · tag", "Query · tag"])
  })

  it("reports both entries for a repeated parameter name in the params", () => {
    expect(
      paths(
        request({
          params: [pair("tag", REDACTION_SENTINEL), { ...pair("tag", REDACTION_SENTINEL), id: "tag-2" }],
        }),
      ),
    ).toEqual(["Query · tag", "Query · tag"])
  })

  // Both sources carry the same repeated name: still two, not four and not one.
  it("keeps the count at the real number when both sources repeat it", () => {
    expect(
      paths(
        request({
          url: `https://api.example.com/s?tag=${REDACTION_SENTINEL}&tag=${REDACTION_SENTINEL}`,
          params: [pair("tag", REDACTION_SENTINEL), { ...pair("tag", REDACTION_SENTINEL), id: "tag-2" }],
        }),
      ),
    ).toEqual(["Query · tag", "Query · tag"])
  })
})
