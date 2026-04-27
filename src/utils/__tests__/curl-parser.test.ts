import { describe, expect, it } from "vitest"
import { parseCurl } from "../curl-parser"

describe("parseCurl", () => {
  it("parses a simple GET request", () => {
    const result = parseCurl("curl https://api.example.com/users")
    expect(result.method).toBe("GET")
    expect(result.url).toBe("https://api.example.com/users")
    expect(result.headers).toHaveLength(0)
    expect(result.body.type).toBe("none")
  })

  it("parses POST with -X and -d data", () => {
    const result = parseCurl(
      `curl -X POST -d '{"name":"test"}' https://api.example.com/users`
    )
    expect(result.method).toBe("POST")
    expect(result.url).toBe("https://api.example.com/users")
    expect(result.body.type).toBe("json")
    expect(result.body.content).toBe('{"name":"test"}')
  })

  it("parses multiple headers", () => {
    const result = parseCurl(
      `curl -H 'Content-Type: application/json' -H 'Accept: text/html' https://api.example.com`
    )
    expect(result.headers).toHaveLength(2)
    expect(result.headers[0].key).toBe("Content-Type")
    expect(result.headers[0].value).toBe("application/json")
    expect(result.headers[1].key).toBe("Accept")
    expect(result.headers[1].value).toBe("text/html")
  })

  it("extracts Bearer auth from Authorization header", () => {
    const result = parseCurl(
      `curl -H 'Authorization: Bearer token123' https://api.example.com`
    )
    expect(result.auth.type).toBe("bearer")
    expect(result.auth.bearer?.token).toBe("token123")
    expect(result.headers).toHaveLength(0)
  })

  it("parses -u flag as basic auth", () => {
    const result = parseCurl(
      `curl -u user:pass https://api.example.com`
    )
    expect(result.auth.type).toBe("basic")
    expect(result.auth.basic?.username).toBe("user")
    expect(result.auth.basic?.password).toBe("pass")
  })

  it("parses multiline curl with backslash continuation", () => {
    const result = parseCurl(
      `curl \\\n  -X PUT \\\n  -H 'Content-Type: application/json' \\\n  -d '{"id":1}' \\\n  https://api.example.com/items/1`
    )
    expect(result.method).toBe("PUT")
    expect(result.url).toBe("https://api.example.com/items/1")
    expect(result.body.type).toBe("json")
    expect(result.body.content).toBe('{"id":1}')
    expect(result.headers).toHaveLength(1)
  })

  it("parses multipart form flags into structured form-data", () => {
    const result = parseCurl(
      `curl -F 'name=alice' -F 'file=@hello.txt;type=text/plain' https://api.example.com/upload`
    )

    expect(result.method).toBe("POST")
    expect(result.body.type).toBe("form-data")
    expect(result.body.formData).toHaveLength(2)
    expect(result.body.formData[0].valueType).toBe("text")
    expect(result.body.formData[0].value).toBe("alice")
    expect(result.body.formData[1].valueType).toBe("file")
    expect(result.body.formData[1].fileName).toBe("hello.txt")
    expect(result.body.formData[1].filePath).toBe("")
    expect(result.body.formData[1].contentType).toBe("text/plain")
  })

  it("parses --data-binary file payloads as binary bodies", () => {
    const result = parseCurl(
      `curl --data-binary @payload.bin https://api.example.com/upload`
    )

    expect(result.method).toBe("POST")
    expect(result.body.type).toBe("binary")
    expect(result.body.binaryPath).toBe("payload.bin")
  })

  it("parses -T upload-file bodies without treating the file path as the URL", () => {
    const result = parseCurl(
      `curl -T payload.bin https://api.example.com/upload`
    )

    expect(result.method).toBe("PUT")
    expect(result.url).toBe("https://api.example.com/upload")
    expect(result.body.type).toBe("binary")
    expect(result.body.binaryPath).toBe("payload.bin")
  })

  it("normalizes multiline cookie values imported from curl", () => {
    const result = parseCurl(
      `curl https://api.example.com/users \\
  -b 'foo=bar;
  user_auth_name=abc/
  def;
  login_country=SG'`
    )

    expect(result.headers).toHaveLength(1)
    expect(result.headers[0].key).toBe("Cookie")
    expect(result.headers[0].value).toBe("foo=bar;user_auth_name=abc/def;login_country=SG")
  })

  it("normalizes multiline header values imported from curl", () => {
    const result = parseCurl(
      `curl https://api.example.com/users \\
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like
  Gecko) Chrome/146.0.0.0 Safari/537.36'`
    )

    expect(result.headers).toHaveLength(1)
    expect(result.headers[0].key).toBe("User-Agent")
    expect(result.headers[0].value).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
    )
  })

  it("normalizes multiline cookie headers imported via -H", () => {
    const result = parseCurl(
      `curl https://api.example.com/users \\
  -H 'Cookie: foo=bar;
  user_auth_name=abc/
  def;
  login_country=SG'`
    )

    expect(result.headers).toHaveLength(1)
    expect(result.headers[0].key).toBe("Cookie")
    expect(result.headers[0].value).toBe("foo=bar;user_auth_name=abc/def;login_country=SG")
  })
})
