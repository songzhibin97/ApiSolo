import { describe, expect, it } from "vitest"

import { REDACTION_SENTINEL } from "../redaction"
import { buildSavedRequest } from "../saved-request"
import type { Tab } from "../../types"

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "tab-1",
    label: "tab",
    method: "POST",
    url: "https://api.example.com/token",
    protocol: "http",
    isDirty: false,
    // A marked row that holds a value: the marker records that history blanked
    // this row and is not cleared when the value is typed back in, so this is
    // the shape a tab is in between the refill and the save. It is also the one
    // that matters most here -- the marker means "was blanked", and a marker on
    // a row holding a credential is a claim about that credential following the
    // file wherever it is copied or exported to.
    params: [
      { id: "p-1", enabled: true, key: "apikey", value: "REAL", description: "", redacted: true },
    ],
    headers: [
      { id: "h-1", enabled: true, key: "Cookie", value: "", description: "", redacted: true },
    ],
    body: {
      type: "form-data",
      content: "",
      formData: [
        { id: "f-1", enabled: true, key: "password", value: "", description: "", redacted: true },
      ],
      binaryPath: "",
      binaryContent: "",
    },
    auth: { type: "none" },
    preRequestScript: "",
    testScript: "",
    projectName: "demo",
    savedRequestPath: "auth/token.json",
    urlRevision: 0,
    ...overrides,
  }
}

describe("§40 the redacted marker never reaches a saved request", () => {
  it.each([
    ["params", (saved: ReturnType<typeof buildSavedRequest>) => saved.params],
    ["headers", (saved: ReturnType<typeof buildSavedRequest>) => saved.headers],
    ["body.formData", (saved: ReturnType<typeof buildSavedRequest>) => saved.body.formData],
  ])("strips the marker from %s independently", (_name, select) => {
    const rows = select(buildSavedRequest(makeTab(), "Token"))

    expect(rows).toHaveLength(1)
    expect(Object.prototype.hasOwnProperty.call(rows[0], "redacted")).toBe(false)
  })

  it("never persists the redacted marker to a saved request", () => {
    const saved = buildSavedRequest(makeTab(), "  Get token  ")
    const serialized = JSON.stringify(saved)

    expect(saved.name).toBe("Get token")
    expect(serialized).not.toContain("redacted")
    expect(saved.headers).toEqual([
      { id: "", enabled: true, key: "Cookie", value: "", description: "" },
    ])
    expect(saved.params).toEqual([
      { id: "", enabled: true, key: "apikey", value: "REAL", description: "" },
    ])
    expect(saved.body.formData).toEqual([
      { id: "", enabled: true, key: "password", value: "", description: "" },
    ])
  })

  it("keeps the sentinel out of a saved body without inventing redaction", () => {
    const saved = buildSavedRequest(
      makeTab({
        body: {
          type: "json",
          content: `{"password":"${REDACTION_SENTINEL}"}`,
          formData: [],
          binaryPath: "",
          binaryContent: "",
        },
      }),
      "Token",
    )

    // Saving is a verbatim copy of the editor; Rust owns collection redaction.
    expect(saved.body.content).toBe(`{"password":"${REDACTION_SENTINEL}"}`)
    expect(saved.body.formData).toEqual([])
  })
})
