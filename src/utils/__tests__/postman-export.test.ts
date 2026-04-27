import { describe, expect, it } from "vitest"
import { exportPostmanCollection } from "../postman-export"
import type { CollectionNode, SavedRequest } from "../../types"

function makeRequest(overrides: Partial<SavedRequest> = {}): SavedRequest {
  return {
    name: "Get Users",
    method: "GET",
    url: "https://api.example.com/users",
    params: [],
    headers: [],
    body: { type: "none", content: "", formData: [], binaryPath: "" },
    auth: { type: "none" },
    preRequestScript: "",
    testScript: "",
    ...overrides,
  }
}

describe("exportPostmanCollection", () => {
  it("generates valid Postman collection JSON", () => {
    const requests = [
      makeRequest({
        method: "POST",
        name: "Create User",
        url: "https://api.example.com/users",
        headers: [
          {
            id: "header-1",
            enabled: true,
            key: "Content-Type",
            value: "application/json",
            description: "",
          },
        ],
        body: {
          type: "json",
          content: '{"name":"Ada"}',
          formData: [],
          binaryPath: "",
        },
        preRequestScript: 'console.log("prep")',
        testScript: 'pm.test("ok", () => {})',
      }),
    ]
    const tree: CollectionNode[] = [
      {
        name: "Users",
        path: "Users",
        nodeType: "folder",
        children: [
          {
            name: "Create User",
            path: "Users/Create User",
            nodeType: "request",
            children: [],
            method: "POST",
          },
        ],
      },
    ]

    const exported = exportPostmanCollection("My API", requests, tree)
    const parsed = JSON.parse(exported)

    expect(parsed.info.name).toBe("My API")
    expect(parsed.info.schema).toContain("postman.com")
    expect(parsed.item).toHaveLength(1)
    expect(parsed.item[0].name).toBe("Users")
    expect(parsed.item[0].item).toHaveLength(1)
    expect(parsed.item[0].item[0].request.method).toBe("POST")
    expect(parsed.item[0].item[0].request.url.raw).toBe("https://api.example.com/users")
    expect(parsed.item[0].item[0].request.body.mode).toBe("raw")
    expect(parsed.item[0].item[0].event).toHaveLength(2)
  })

  it("preserves binary and multipart file body semantics", () => {
    const requests = [
      makeRequest({
        name: "Upload Binary",
        method: "POST",
        body: {
          type: "binary",
          content: "",
          formData: [],
          binaryPath: "payload.bin",
          binaryContent: "",
        },
      }),
      makeRequest({
        name: "Upload Multipart",
        method: "POST",
        body: {
          type: "form-data",
          content: "",
          formData: [
            {
              id: "file-1",
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
          binaryPath: "",
        },
      }),
    ]
    const tree: CollectionNode[] = [
      {
        name: "Uploads",
        path: "Uploads",
        nodeType: "folder",
        children: [
          {
            name: "Upload Binary",
            path: "Uploads/Upload Binary",
            nodeType: "request",
            children: [],
            method: "POST",
          },
          {
            name: "Upload Multipart",
            path: "Uploads/Upload Multipart",
            nodeType: "request",
            children: [],
            method: "POST",
          },
        ],
      },
    ]

    const exported = exportPostmanCollection("My API", requests, tree)
    const parsed = JSON.parse(exported)

    expect(parsed.item[0].item[0].request.body.mode).toBe("file")
    expect(parsed.item[0].item[0].request.body.file.src).toBe("payload.bin")
    expect(parsed.item[0].item[1].request.body.mode).toBe("formdata")
    expect(parsed.item[0].item[1].request.body.formdata[0].type).toBe("file")
    expect(parsed.item[0].item[1].request.body.formdata[0].src).toBe("hello.txt")
  })
})
