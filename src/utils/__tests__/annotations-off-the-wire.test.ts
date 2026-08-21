import { describe, expect, it } from "vitest"

import { exportCurl } from "../curl-export"
import { exportPostmanCollection } from "../postman-export"
import { buildSavedRequest } from "../saved-request"
import type { CollectionNode, SavedRequest, Tab } from "../../types"

/**
 * §35 — a note is a note about a call, and it must not become part of one or of
 * anything the user hands to another tool. A note is the single field here the
 * user types free text into, which makes it the one that would quietly turn
 * into a header, a body field or a shared collection entry if any of these
 * builders ever spread a whole entry instead of naming what it wants.
 */
const NOTE = "remember-me-not-on-the-wire"

function tab(): Tab {
  return {
    id: "t-1",
    label: "GET users",
    method: "GET",
    url: "https://api.example.com/users",
    params: [],
    headers: [],
    body: { type: "none", content: "", formData: [], binaryPath: "" },
    auth: { type: "none" },
    preRequestScript: "",
    testScript: "",
    isDirty: false,
    projectName: null,
    savedRequestPath: null,
    // Annotations do not live on a tab; a request replayed from an annotated
    // history row is how they would arrive if anything copied the row wholesale.
    note: NOTE,
    starred: true,
  } as never as Tab
}

describe("§35 annotations do not follow a request out of the app", () => {
  it("stays out of a request saved to a collection", () => {
    const saved = buildSavedRequest(tab(), "Users")

    expect(JSON.stringify(saved)).not.toContain(NOTE)
    expect(Object.keys(saved)).not.toContain("note")
    expect(Object.keys(saved)).not.toContain("starred")
  })

  it("stays out of an exported Postman collection", () => {
    const saved = buildSavedRequest(tab(), "Users")
    const withNote = { ...saved, note: NOTE, starred: true } as never as SavedRequest
    const tree: CollectionNode[] = [
      { name: "Users", path: "users.request.json", nodeType: "request", children: [] },
    ]

    const exported = exportPostmanCollection("My API", [withNote], tree)

    expect(exported).not.toContain(NOTE)
    expect(exported).not.toContain("\"starred\"")
  })

  it("stays out of a copied cURL command", () => {
    expect(exportCurl(tab())).not.toContain(NOTE)
  })
})
