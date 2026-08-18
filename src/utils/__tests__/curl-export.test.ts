import { describe, expect, it } from "vitest"
import { exportCurl } from "../curl-export"
import { parseCurl } from "../curl-parser"
import type { Tab } from "../../types"

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "test-tab",
    label: "Test",
    method: "GET",
    url: "https://api.example.com/users",
    protocol: "http",
    isDirty: false,
    params: [],
    headers: [],
    body: { type: "none", content: "", formData: [], binaryPath: "" },
    auth: { type: "none" },
    preRequestScript: "",
    testScript: "",
    projectName: null,
    savedRequestPath: null,
    urlRevision: 0,
    ...overrides,
  }
}

describe("exportCurl", () => {
  it("exports a simple GET without -X flag", () => {
    const curl = exportCurl(makeTab())
    expect(curl).not.toContain("-X")
    expect(curl).toContain("https://api.example.com/users")
  })

  it("exports POST with body", () => {
    const curl = exportCurl(
      makeTab({
        method: "POST",
        body: { type: "json", content: '{"name":"test"}', formData: [], binaryPath: "" },
      })
    )
    expect(curl).toContain("-X 'POST'")
    expect(curl).toContain("--data-raw")
    expect(curl).toContain('{"name":"test"}')
  })

  it("exports headers", () => {
    const curl = exportCurl(
      makeTab({
        headers: [
          { id: "1", enabled: true, key: "Content-Type", value: "application/json", description: "" },
          { id: "2", enabled: true, key: "Accept", value: "text/html", description: "" },
          { id: "3", enabled: false, key: "X-Disabled", value: "skip", description: "" },
        ],
      })
    )
    expect(curl).toContain("-H 'Content-Type: application/json'")
    expect(curl).toContain("-H 'Accept: text/html'")
    expect(curl).not.toContain("X-Disabled")
  })

  it("roundtrips: export then parse preserves key fields", () => {
    const tab = makeTab({
      method: "POST",
      url: "https://api.example.com/data",
      headers: [
        { id: "1", enabled: true, key: "X-Custom", value: "hello", description: "" },
      ],
      body: { type: "raw", content: "test body", formData: [], binaryPath: "" },
    })

    const curl = exportCurl(tab)
    const parsed = parseCurl(curl)

    expect(parsed.method).toBe("POST")
    expect(parsed.url).toBe("https://api.example.com/data")
    expect(parsed.headers.find((h) => h.key === "X-Custom")?.value).toBe("hello")
    expect(parsed.body.type).toBe("raw")
    expect(parsed.body.content).toBe("test body")
  })

  it("exports multipart file fields with -F semantics", () => {
    const curl = exportCurl(
      makeTab({
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
      })
    )

    expect(curl).toContain("-F")
    expect(curl).toContain("file=@hello.txt;type=text/plain")
  })

  // Behavior 32
  it("exports templated and protocol-less URLs verbatim", () => {
    const leading = exportCurl(makeTab({ url: "{{baseUrl}}/users" }))
    expect(leading).toBe("curl '{{baseUrl}}/users'")
    expect(leading).not.toContain("%7B")

    const midPath = exportCurl(makeTab({ url: "https://api.example.com/{{id}}/x" }))
    expect(midPath).toBe("curl 'https://api.example.com/{{id}}/x'")

    const protocolLess = exportCurl(makeTab({ url: "api.example.com/users" }))
    expect(protocolLess).toBe("curl 'api.example.com/users'")
    expect(protocolLess).not.toContain("'/api.example.com")
  })

  // Behavior 33
  it("percent-encodes params but keeps {{templates}} intact", () => {
    const curl = exportCurl(
      makeTab({
        url: "https://api.example.com/x",
        params: [
          { id: "1", enabled: true, key: "token", value: "{{apiToken}}", description: "" },
          { id: "2", enabled: true, key: "q", value: "a b", description: "" },
        ],
      })
    )

    expect(curl).toContain("token={{apiToken}}")
    expect(curl).toContain("q=a%20b")
    expect(curl).not.toContain("%7B%7BapiToken")
  })

  // Behavior 34 — the state a cURL import leaves behind: the query string
  // lives in tab.url and in params at the same time.
  it("does not duplicate a query string left in tab.url", () => {
    const curl = exportCurl(
      makeTab({
        url: "https://api.example.com/s?q=cat",
        params: [{ id: "1", enabled: true, key: "q", value: "cat", description: "" }],
      })
    )

    expect(curl.match(/q=cat/g)).toHaveLength(1)
    expect(curl).toBe("curl 'https://api.example.com/s?q=cat'")
  })

  // Behavior 35
  it("keeps the fragment after the query string", () => {
    const curl = exportCurl(
      makeTab({
        url: "https://api.example.com/a#frag",
        params: [{ id: "1", enabled: true, key: "k", value: "v", description: "" }],
      })
    )

    expect(curl).toBe("curl 'https://api.example.com/a?k=v#frag'")
  })

  it("exports binary bodies without dropping the payload semantics", () => {
    const curl = exportCurl(
      makeTab({
        method: "POST",
        body: {
          type: "binary",
          content: "",
          formData: [],
          binaryPath: "payload.bin",
          binaryContent: "",
        },
      })
    )

    expect(curl).toContain("--data-binary")
    expect(curl).toContain("@payload.bin")
  })
})
