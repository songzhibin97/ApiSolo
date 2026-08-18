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
    params: [
      { id: "p-1", enabled: true, key: "page", value: "1", description: "", redacted: false },
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
    ...overrides,
  }
}

describe("§40 the redacted marker never reaches a saved request", () => {
  it("never persists the redacted marker to a saved request", () => {
    const saved = buildSavedRequest(makeTab(), "  Get token  ")
    const serialized = JSON.stringify(saved)

    expect(saved.name).toBe("Get token")
    expect(serialized).not.toContain("redacted")
    expect(saved.headers).toEqual([
      { id: "", enabled: true, key: "Cookie", value: "", description: "" },
    ])
    expect(saved.params).toEqual([
      { id: "", enabled: true, key: "page", value: "1", description: "" },
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
