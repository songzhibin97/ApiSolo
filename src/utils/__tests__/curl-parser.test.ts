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

  // Behavior 1
  it("decodes $'...' ANSI-C quoted headers copied from DevTools", () => {
    const result = parseCurl(
      `curl 'https://example.com/a' -H $'cookie: sid=abc!def' -H $'authorization: Bearer xyz'`
    )

    expect(result.headers).toHaveLength(1)
    expect(result.headers[0].key).toBe("cookie")
    expect(result.headers[0].key).not.toMatch(/^\$/)
    expect(result.headers[0].value).toBe("sid=abc!def")
    expect(result.auth.type).toBe("bearer")
    expect(result.auth.bearer?.token).toBe("xyz")
    expect(
      result.headers.some((header) => header.key.toLowerCase() === "authorization")
    ).toBe(false)
  })

  // Behavior 2 — asserted on the body so header normalization cannot mask a
  // decoded control character. BACKSLASH is built at runtime: a literal
  // backslash in a nested template is exactly the thing that silently
  // degrades when a fixture is copied around (PROCESS P6).
  const BACKSLASH = String.fromCharCode(92)

  it("decodes every documented ANSI-C escape class", () => {
    // Every payload is prefixed with a sentinel `Z`: a body that decodes to
    // whitespace only (\t \n \v \f \r) would otherwise be collapsed to
    // type "none" with an empty content by inferTextBodyType, and the
    // assertion would pass for the wrong reason.
    const cases: Array<[string, string]> = [
      [`${BACKSLASH}${BACKSLASH}`, BACKSLASH],
      [`${BACKSLASH}'`, "'"],
      [`${BACKSLASH}"`, '"'],
      [`${BACKSLASH}a`, "\x07"],
      [`${BACKSLASH}b`, "\b"],
      [`${BACKSLASH}e`, "\x1b"],
      [`${BACKSLASH}E`, "\x1b"],
      [`${BACKSLASH}f`, "\f"],
      [`${BACKSLASH}v`, "\v"],
      [`${BACKSLASH}t`, "\t"],
      [`${BACKSLASH}n`, "\n"],
      [`${BACKSLASH}r`, "\r"],
      [`${BACKSLASH}x7`, "\x07"],
      [`${BACKSLASH}x21`, "!"],
      [`${BACKSLASH}u4e2d`, "中"],
      [`${BACKSLASH}u41`, "A"],
      [`${BACKSLASH}U0001F600`, "\u{1F600}"],
      [`${BACKSLASH}101`, "A"],
      [`${BACKSLASH}7`, "\x07"],
      [`${BACKSLASH}z`, `${BACKSLASH}z`],
      [`${BACKSLASH}xZZ`, `${BACKSLASH}xZZ`],
    ]

    // Fixture self-check (PROCESS P6): every input must still start with a
    // real backslash by the time it reaches the parser.
    for (const [input] of cases) {
      expect(input.charCodeAt(0)).toBe(92)
    }

    for (const [input, expected] of cases) {
      const result = parseCurl(`curl https://example.com/a -d $'Z${input}'`)
      expect(result.body.content).toBe(`Z${expected}`)
    }

    // A trailing lone backslash cannot appear before a closing quote (it would
    // escape the quote), so the only way to reach that decoder branch is an
    // unterminated $'… at the end of the command.
    const unterminated = parseCurl(`curl https://example.com/a -d $'Z${BACKSLASH}`)
    expect(unterminated.body.content).toBe(`Z${BACKSLASH}`)
  })

  // Behavior 3
  it("folds decoded CR and LF inside header values", () => {
    const crlf = parseCurl(
      `curl https://example.com/a -H $'x-note: line1${BACKSLASH}r${BACKSLASH}nline2'`
    )
    expect(crlf.headers[0].value).toBe("line1 line2")
    expect(crlf.headers[0].value).not.toContain("\r")
    expect(crlf.headers[0].value).not.toContain("\n")
    expect(crlf.headers[0].value).not.toContain(`${BACKSLASH}r`)

    const loneCr = parseCurl(`curl https://example.com/a -H $'x-note: a${BACKSLASH}rb'`)
    expect(loneCr.headers[0].value).toBe("a b")

    const cookie = parseCurl(
      `curl https://example.com/a -H $'cookie: a=1${BACKSLASH}r${BACKSLASH}n  b=2'`
    )
    expect(cookie.headers[0].value).toBe("a=1b=2")
  })

  // Behavior 4 — shares its killer with Behavior 1 (same pendingDollar branch);
  // kept because -b is what modern Chrome actually emits for cookies.
  it("decodes $'...' on the -b cookie flag", () => {
    const result = parseCurl(`curl 'https://example.com/a' -b $'sid=abc!def'`)

    expect(result.headers).toHaveLength(1)
    expect(result.headers[0].key).toBe("Cookie")
    expect(result.headers[0].value).toBe("sid=abc!def")
  })

  // Behavior 5
  it("treats an escaped dollar as a literal dollar", () => {
    const escaped = parseCurl(`curl https://example.com/a -d ${BACKSLASH}$'x'`)
    expect(escaped.body.content).toBe("$x")

    const quoted = parseCurl(`curl https://example.com/a -d '$x'`)
    expect(quoted.body.content).toBe("$x")
  })
})
