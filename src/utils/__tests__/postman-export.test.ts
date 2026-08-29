import { describe, expect, it } from "vitest"
import { exportCurl } from "../curl-export"
import { collectPostmanExportWarnings, exportPostmanCollection } from "../postman-export"
import type { CollectionNode, FormDataItem, SavedRequest, Tab } from "../../types"

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
  it("D17 §16 exports no transient marker in Postman or cURL output", () => {
    const marked = makeRequest({
      params: [
        {
          id: "query",
          enabled: true,
          key: "apikey",
          value: "REAL",
          description: "",
          redacted: true,
        },
      ],
      headers: [
        {
          id: "header",
          enabled: true,
          key: "Authorization",
          value: "Bearer REAL",
          description: "",
          redacted: true,
        },
      ],
    })
    const postman = exportPostmanCollection("My API", [marked], [])
    const curl = exportCurl({
      ...marked,
      id: "tab",
      label: marked.name,
      protocol: "http",
      isDirty: false,
      projectName: null,
      savedRequestPath: null,
      urlRevision: 0,
    } as Tab)

    expect(postman).not.toContain('"redacted"')
    expect(curl).not.toContain("redacted")
    expect(curl).toContain("apikey=REAL")
  })

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

  // Rewritten: the previous version of this test asserted
  // `body.file.src === "payload.bin"` and `formdata[0].src === "hello.txt"`
  // for two fixtures that both carry in-memory content, so it was asserting
  // the fabricated path this slice exists to remove. The binary fixture had
  // `binaryContent: ""`, which is exactly the zero-byte case.
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
    expect(parsed.item[0].item[0].request.body.file.src).toBeUndefined()
    expect(parsed.item[0].item[1].request.body.mode).toBe("formdata")
    expect(parsed.item[0].item[1].request.body.formdata[0].type).toBe("file")
    expect(parsed.item[0].item[1].request.body.formdata[0].src).toBeUndefined()
  })

  function exportSingle(request: SavedRequest) {
    const tree: CollectionNode[] = [
      {
        name: request.name,
        path: request.name,
        nodeType: "request",
        children: [],
        method: request.method,
      },
    ]

    return JSON.parse(exportPostmanCollection("My API", [request], tree)).item[0]
  }

  function fileField(overrides: Partial<FormDataItem> = {}): FormDataItem {
    return {
      id: "file-1",
      enabled: true,
      key: "file",
      value: "",
      description: "",
      valueType: "file",
      fileName: "报告.pdf",
      contentType: "application/pdf",
      ...overrides,
    }
  }

  // Behavior 36
  it("does not fabricate a src for an in-memory multipart file", () => {
    const item = exportSingle(
      makeRequest({
        name: "Upload",
        method: "POST",
        body: {
          type: "form-data",
          content: "",
          formData: [fileField({ fileContent: "aGVsbG8=" })],
          binaryPath: "",
        },
      })
    )

    expect(item.request.body.formdata[0].src).toBeUndefined()
    expect(item.request.body.formdata[0].type).toBe("file")
    expect(item.request.body.formdata[0].description).toContain("报告.pdf")
    expect(item.request.body.formdata[0].description).toContain("ApiSolo")
  })

  // Behavior 37
  it("does not fabricate a src for an in-memory binary body", () => {
    const item = exportSingle(
      makeRequest({
        name: "Upload Binary",
        method: "POST",
        body: {
          type: "binary",
          content: "",
          formData: [],
          binaryPath: "报告.pdf",
          binaryContent: "aGVsbG8=",
        },
      })
    )

    expect(item.request.body.mode).toBe("file")
    expect(item.request.body.file.src).toBeUndefined()
    expect(item.request.description).toContain("报告.pdf")
  })

  // Behavior 38 — a zero-byte upload has an empty base64 string, so a
  // truthiness check would send it back down the fabricated-path route.
  it("treats a zero-byte upload exactly like a non-empty one", () => {
    const multipart = exportSingle(
      makeRequest({
        name: "Empty Multipart",
        method: "POST",
        body: {
          type: "form-data",
          content: "",
          formData: [fileField({ fileContent: "" })],
          binaryPath: "",
        },
      })
    )
    expect(multipart.request.body.formdata[0].src).toBeUndefined()
    expect(multipart.request.body.formdata[0].description).toContain("报告.pdf")

    const binary = exportSingle(
      makeRequest({
        name: "Empty Binary",
        method: "POST",
        body: {
          type: "binary",
          content: "",
          formData: [],
          binaryPath: "报告.pdf",
          binaryContent: "",
        },
      })
    )
    expect(binary.request.body.file.src).toBeUndefined()
    expect(binary.request.description).toContain("报告.pdf")

    expect(
      collectPostmanExportWarnings([
        makeRequest({
          name: "Empty Multipart",
          body: {
            type: "form-data",
            content: "",
            formData: [fileField({ fileContent: "" })],
            binaryPath: "",
          },
        }),
        makeRequest({
          name: "Empty Binary",
          body: {
            type: "binary",
            content: "",
            formData: [],
            binaryPath: "报告.pdf",
            binaryContent: "",
          },
        }),
      ])
    ).toHaveLength(2)
  })

  // Behavior 39 — a name we received from an import is not a path we invented.
  it("keeps the src of a file field that never had in-memory content", () => {
    const multipart = exportSingle(
      makeRequest({
        name: "Imported Multipart",
        method: "POST",
        body: {
          type: "form-data",
          content: "",
          formData: [fileField({ fileName: "hello.txt", fileContent: undefined })],
          binaryPath: "",
        },
      })
    )
    expect(multipart.request.body.formdata[0].src).toBe("hello.txt")
    expect(multipart.request.body.formdata[0].description).toBeUndefined()

    const binary = exportSingle(
      makeRequest({
        name: "Imported Binary",
        method: "POST",
        body: {
          type: "binary",
          content: "",
          formData: [],
          binaryPath: "payload.bin",
          binaryContent: undefined,
        },
      })
    )
    expect(binary.request.body.file.src).toBe("payload.bin")
  })

  // The shape a saved request actually has when it comes back from Rust.
  //
  // read_saved_request runs sanitize_saved_request_for_persistence, which
  // assigns file_content = None (lib.rs:1453) and binary_content = None
  // (lib.rs:1439). Neither Option<String> declares skip_serializing_if -- the
  // single field in lib.rs that does is EnvVariable.vault_key -- so serde
  // writes the key with a JSON null rather than omitting it. Verified by
  // serializing the same struct shape: {"fileContent":null}.
  //
  // The TypeScript declaration says `fileContent?: string`, which is why every
  // fixture in this file had been written with `undefined`. The cast is the
  // point of the test: it models the wire, not the declaration.
  const IPC_NULL = null as unknown as undefined

  it("treats a Rust-blanked file field as having no in-memory content", () => {
    const multipart = exportSingle(
      makeRequest({
        name: "Loaded Multipart",
        method: "POST",
        body: {
          type: "form-data",
          content: "",
          formData: [fileField({ fileName: "报告.pdf", fileContent: IPC_NULL })],
          binaryPath: "",
        },
      })
    )

    // Fixture self-check (PROCESS P6): this must be a real null, not undefined.
    expect(multipart.request.body.formdata[0]).toBeDefined()
    expect(IPC_NULL).toBeNull()

    expect(multipart.request.body.formdata[0].src).toBe("报告.pdf")
    expect(multipart.request.body.formdata[0].description).toBeUndefined()

    const binary = exportSingle(
      makeRequest({
        name: "Loaded Binary",
        method: "POST",
        body: {
          type: "binary",
          content: "",
          formData: [],
          binaryPath: "报告.pdf",
          binaryContent: IPC_NULL,
        },
      })
    )

    expect(binary.request.body.file.src).toBe("报告.pdf")
    expect(binary.request.description).toBeUndefined()

    expect(
      collectPostmanExportWarnings([
        makeRequest({
          name: "Loaded Multipart",
          body: {
            type: "form-data",
            content: "",
            formData: [fileField({ fileName: "报告.pdf", fileContent: IPC_NULL })],
            binaryPath: "",
          },
        }),
        makeRequest({
          name: "Loaded Binary",
          body: {
            type: "binary",
            content: "",
            formData: [],
            binaryPath: "报告.pdf",
            binaryContent: IPC_NULL,
          },
        }),
      ])
    ).toEqual([])
  })

  // Behavior 40
  it("does not duplicate a query string left in the saved url", () => {
    const item = exportSingle(
      makeRequest({
        name: "Dup",
        url: "https://api.example.com/s?q=cat",
        params: [{ id: "1", enabled: true, key: "q", value: "cat", description: "" }],
      })
    )

    expect(item.request.url.raw).toBe("https://api.example.com/s?q=cat")
  })

  // Behavior 41
  it("keeps the fragment after the query string in url.raw", () => {
    const item = exportSingle(
      makeRequest({
        name: "Hash",
        url: "https://api.example.com/a#frag",
        params: [{ id: "1", enabled: true, key: "k", value: "v", description: "" }],
      })
    )

    expect(item.request.url.raw).toBe("https://api.example.com/a?k=v#frag")
  })

  // Behavior 42
  it("collectPostmanExportWarnings lists every unexportable upload", () => {
    const warnings = collectPostmanExportWarnings([
      makeRequest({
        name: "Upload",
        body: {
          type: "form-data",
          content: "",
          formData: [fileField({ fileContent: "aGVsbG8=" })],
          binaryPath: "",
        },
      }),
      makeRequest({
        name: "Upload Binary",
        body: {
          type: "binary",
          content: "",
          formData: [],
          binaryPath: "报告.pdf",
          binaryContent: "aGVsbG8=",
        },
      }),
      makeRequest({
        name: "Imported Placeholder",
        body: {
          type: "form-data",
          content: "",
          formData: [fileField({ fileName: "hello.txt", fileContent: undefined })],
          binaryPath: "",
        },
      }),
    ])

    expect(warnings).toEqual([
      {
        code: "file-content-not-exportable",
        requestName: "Upload",
        fileName: "报告.pdf",
      },
      {
        code: "file-content-not-exportable",
        requestName: "Upload Binary",
        fileName: "报告.pdf",
      },
    ])

    expect(collectPostmanExportWarnings([makeRequest({ name: "Plain" })])).toEqual([])
  })
})
