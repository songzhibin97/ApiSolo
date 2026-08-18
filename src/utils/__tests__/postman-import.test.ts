import { describe, expect, it } from "vitest"
import { parsePostmanCollection } from "../postman-import"
import { exportPostmanCollection } from "../postman-export"
import type { CollectionNode, SavedRequest } from "../../types"

describe("parsePostmanCollection", () => {
  it("parses a simple Postman collection", () => {
    const json = JSON.stringify({
      info: {
        name: "My API",
        schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      item: [
        {
          name: "Get Users",
          request: {
            method: "GET",
            url: { raw: "https://api.example.com/users" },
            header: [],
          },
        },
      ],
    })

    const result = parsePostmanCollection(json)

    expect(result.name).toBe("My API")
    expect(result.requests).toHaveLength(1)
    expect(result.requests[0].request.method).toBe("GET")
    expect(result.requests[0].request.url).toContain("example.com")
  })

  it("handles nested folders", () => {
    const json = JSON.stringify({
      info: {
        name: "Nested",
        schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      item: [
        {
          name: "Users",
          item: [
            {
              name: "Get User",
              request: {
                method: "GET",
                url: { raw: "https://api.com/users/1" },
                header: [],
              },
            },
          ],
        },
      ],
    })

    const result = parsePostmanCollection(json)

    expect(result.requests[0].folderPath).toBe("Users")
  })

  it("parses request headers", () => {
    const json = JSON.stringify({
      info: {
        name: "Headers",
        schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      item: [
        {
          name: "With Headers",
          request: {
            method: "POST",
            url: { raw: "https://api.com" },
            header: [{ key: "Content-Type", value: "application/json" }],
            body: { mode: "raw", raw: '{"key":"val"}' },
          },
        },
      ],
    })

    const result = parsePostmanCollection(json)

    expect(result.requests[0].request.headers.length).toBeGreaterThan(0)
    expect(result.requests[0].request.headers[0].key).toBe("Content-Type")
  })

  it("preserves template variables", () => {
    const json = JSON.stringify({
      info: {
        name: "Vars",
        schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      item: [
        {
          name: "Var Test",
          request: {
            method: "GET",
            url: { raw: "{{baseUrl}}/api" },
            header: [],
          },
        },
      ],
    })

    const result = parsePostmanCollection(json)

    expect(result.requests[0].request.url).toContain("{{baseUrl}}")
  })

  it("parses file and multipart file bodies", () => {
    const json = JSON.stringify({
      info: {
        name: "Files",
        schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      item: [
        {
          name: "Binary Upload",
          request: {
            method: "POST",
            url: { raw: "https://api.com/upload" },
            header: [],
            body: { mode: "file", file: { src: "/tmp/payload.bin" } },
          },
        },
        {
          name: "Multipart Upload",
          request: {
            method: "POST",
            url: { raw: "https://api.com/form" },
            header: [],
            body: {
              mode: "formdata",
              formdata: [{ key: "file", type: "file", src: "/tmp/hello.txt" }],
            },
          },
        },
      ],
    })

    const result = parsePostmanCollection(json)

    expect(result.requests[0].request.body.type).toBe("binary")
    expect(result.requests[0].request.body.binaryPath).toBe("payload.bin")
    expect(result.requests[1].request.body.type).toBe("form-data")
    expect(result.requests[1].request.body.formData[0].valueType).toBe("file")
    expect(result.requests[1].request.body.formData[0].filePath).toBe("")
    expect(result.requests[1].request.body.formData[0].fileName).toBe("hello.txt")
  })

  it("preserves Postman scripts as disabled text", () => {
    const json = JSON.stringify({
      info: {
        name: "Scripts",
        schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      item: [
        {
          name: "Unsafe Script",
          request: {
            method: "GET",
            url: { raw: "https://api.com" },
            header: [],
          },
          event: [
            {
              listen: "prerequest",
              script: { exec: ["while(true){}"] },
            },
            {
              listen: "test",
              script: { exec: ["pm.test('boom', () => {})"] },
            },
          ],
        },
      ],
    })

    const result = parsePostmanCollection(json)

    expect(result.requests[0].request.preRequestScript).toContain("Imported from Postman for reference only")
    expect(result.requests[0].request.preRequestScript).toContain("while(true){}")
    expect(result.requests[0].request.testScript).toContain("pm.test('boom', () => {})")
    expect(result.requests[0].request.preRequestScript).toContain("// while(true){}")
    expect(result.requests[0].request.testScript).toContain("// pm.test('boom', () => {})")
  })

  // Behavior 43 — an upload whose bytes only exist inside ApiSolo must come
  // back as an empty slot the user has to refill, never as a phantom name
  // pointing at a file Postman could not have resolved either.
  it("round-trips an in-memory upload into an empty file slot", () => {
    const request: SavedRequest = {
      name: "Upload",
      method: "POST",
      url: "https://api.example.com/upload",
      params: [],
      headers: [],
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
            fileName: "报告.pdf",
            fileContent: "aGVsbG8=",
            contentType: "application/pdf",
          },
        ],
        binaryPath: "",
      },
      auth: { type: "none" },
      preRequestScript: "",
      testScript: "",
    }
    const tree: CollectionNode[] = [
      {
        name: "Upload",
        path: "Upload",
        nodeType: "request",
        children: [],
        method: "POST",
      },
    ]

    const reimported = parsePostmanCollection(
      exportPostmanCollection("My API", [request], tree)
    )
    const field = reimported.requests[0].request.body.formData[0]

    expect(field.valueType).toBe("file")
    expect(field.fileName).toBe("")
    expect(field.filePath).toBe("")
    expect(field.fileContent).toBeUndefined()
  })
})
