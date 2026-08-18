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

  // Behavior 6
  it.each(["PURGE", "pos", "LOCK"])(
    "throws on a request method outside the supported set (%s)",
    (verb) => {
      expect(() => parseCurl(`curl -X ${verb} https://example.com/a`)).toThrow(
        new RegExp(verb)
      )
    }
  )

  it("never lets an unsupported -X verb become the URL", () => {
    let captured: unknown = null
    try {
      captured = parseCurl("curl -X PURGE https://example.com/a")
    } catch {
      captured = null
    }
    expect(captured).toBeNull()
  })

  // Behavior 7
  it("honors an explicit -X GET regardless of data flag order", () => {
    const before = parseCurl(`curl -X GET -d 'q=1' https://example.com/s`)
    expect(before.method).toBe("GET")
    expect(before.body.content).toBe("q=1")

    const after = parseCurl(`curl -d 'q=1' -X GET https://example.com/s`)
    expect(after.method).toBe("GET")
    expect(after.body.content).toBe("q=1")

    expect(parseCurl(`curl -X GET -T ./f.bin https://example.com/s`).method).toBe("GET")
    expect(parseCurl(`curl -X GET -F 'a=b' https://example.com/s`).method).toBe("GET")
  })

  // Behavior 8
  it("still infers POST and PUT when no method is given", () => {
    expect(parseCurl(`curl -d 'q=1' https://example.com/s`).method).toBe("POST")
    expect(parseCurl(`curl -F 'a=b' https://example.com/s`).method).toBe("POST")
    expect(parseCurl(`curl -T f.bin https://example.com/s`).method).toBe("PUT")
  })

  // Behavior 9
  it("ignores whitespace-only tokens when picking the URL", () => {
    const result = parseCurl(
      `curl -X POST ${BACKSLASH} \n 'https://api.example.com/a'`
    )
    expect(result.url).toBe("https://api.example.com/a")
  })

  // Behavior 10
  it.each(["-d", "--data", "--data-ascii", "--data-binary"])(
    "routes %s @file to the same binary placeholder",
    (flag) => {
      const result = parseCurl(`curl ${flag} @payload.json https://api.example.com/a`)

      expect(result.body).toEqual({
        type: "binary",
        content: "",
        formData: [],
        binaryPath: "payload.json",
      })
      expect(result.warnings).toEqual([
        { code: "file-reference-not-inlined", detail: "payload.json" },
      ])
      expect(result.url).toBe("https://api.example.com/a")
    }
  )

  // Behavior 11
  it("keeps --data-raw @file literal", () => {
    const result = parseCurl(`curl --data-raw @payload.json https://api.example.com/a`)

    expect(result.body.type).toBe("raw")
    expect(result.body.content).toBe("@payload.json")
    expect(result.warnings).toEqual([])
  })

  // Behavior 12 — every expected value taken from curl 8.7.1 via --libcurl.
  it.each([
    ["q=a b&c", "q=a+b%26c"],
    ["q=a!b", "q=a%21b"],
    ["q=a(b)c*d", "q=a%28b%29c%2Ad"],
    ["q=a+b", "q=a%2Bb"],
    ["q=a~b-c_d.e", "q=a~b-c_d.e"],
    ["q=中文", "q=%E4%B8%AD%E6%96%87"],
  ])("url-encodes --data-urlencode %s like curl", (input, expected) => {
    const result = parseCurl(`curl --data-urlencode '${input}' https://api.example.com/a`)
    expect(result.body.content).toBe(expected)
  })

  it("url-encodes a single quote in --data-urlencode like curl", () => {
    const result = parseCurl(
      `curl --data-urlencode "q=a'b" https://api.example.com/a`
    )
    expect(result.body.content).toBe("q=a%27b")
  })

  // Behavior 13
  it("splits --data-urlencode forms on the first = then the first @", () => {
    expect(
      parseCurl(`curl --data-urlencode '=a b' https://api.example.com/a`).body.content
    ).toBe("a+b")
    expect(
      parseCurl(`curl --data-urlencode 'a b' https://api.example.com/a`).body.content
    ).toBe("a+b")
    expect(
      parseCurl(`curl --data-urlencode 'name=a@b' https://api.example.com/a`).body.content
    ).toBe("name=a%40b")
    expect(
      parseCurl(`curl --data-urlencode 'na me=x y' https://api.example.com/a`).body.content
    ).toBe("na me=x+y")

    const fileForm = parseCurl(
      `curl --data-urlencode 'body@payload.json' https://api.example.com/a`
    )
    expect(fileForm.body.type).toBe("binary")
    expect(fileForm.body.binaryPath).toBe("payload.json")
    expect(fileForm.warnings).toEqual([
      { code: "file-reference-not-inlined", detail: "payload.json" },
    ])
  })

  // Behavior 14
  it.each([
    [`curl -d 'a=1' -d @payload.json https://api.example.com/a`, "1"],
    [`curl -d 'a=1' -d 'b=2' -d @payload.json https://api.example.com/a`, "2"],
  ])("warns with the exact count of dropped inline data segments", (command, detail) => {
    const result = parseCurl(command)

    expect(result.body.type).toBe("binary")
    expect(
      result.warnings.filter((warning) => warning.code === "data-segments-discarded")
    ).toEqual([{ code: "data-segments-discarded", detail }])
  })

  // Behavior 15
  it("warns for every file reference and only for file parts", () => {
    const result = parseCurl(
      `curl -F 'note=hi' -F 'file=@报告.pdf' -T upload.bin https://api.example.com/a`
    )

    expect(
      result.warnings.filter((warning) => warning.code === "file-reference-not-inlined")
    ).toEqual([
      { code: "file-reference-not-inlined", detail: "报告.pdf" },
      { code: "file-reference-not-inlined", detail: "upload.bin" },
    ])
  })

  // Behavior 16 — curl drops its own generated header whenever the user named
  // it with -H, whichever order the flags appear in.
  it.each([
    ["-b 'a=1'", "Cookie: b=2", "Cookie", "b=2"],
    ["-A 'ua-from-A'", "User-Agent: ua-from-H", "User-Agent", "ua-from-H"],
    ["-e 'ref-from-e'", "Referer: ref-from-H", "Referer", "ref-from-H"],
  ])(
    "lets an explicit -H suppress the header curl would generate (%s)",
    (generatedFlag, explicitHeader, name, expected) => {
      for (const command of [
        `curl ${generatedFlag} -H '${explicitHeader}' https://api.example.com/a`,
        `curl -H '${explicitHeader}' ${generatedFlag} https://api.example.com/a`,
      ]) {
        const matching = parseCurl(command).headers.filter(
          (header) => header.key.toLowerCase() === name.toLowerCase()
        )
        expect(matching).toHaveLength(1)
        expect(matching[0].value).toBe(expected)
      }
    }
  )

  // Behavior 17 — the fix is precedence, not blanket de-duplication.
  it("keeps two explicit -H Cookie headers as two headers", () => {
    const result = parseCurl(
      `curl -H 'Cookie: a=1' -H 'Cookie: b=2' https://api.example.com/a`
    )
    const cookies = result.headers.filter((header) => header.key === "Cookie")

    expect(cookies).toHaveLength(2)
    expect(cookies[0].value).toBe("a=1")
    expect(cookies[1].value).toBe("b=2")
  })

  // Behavior 18 — curl 8.7.1 joins with a bare `;`.
  it("merges multiple -b flags with a bare semicolon", () => {
    const merged = parseCurl(`curl -b 'a=1' -b 'b=2' https://api.example.com/a`)
    const cookies = merged.headers.filter((header) => header.key === "Cookie")
    expect(cookies).toHaveLength(1)
    expect(cookies[0].value).toBe("a=1;b=2")
    expect(cookies[0].value).not.toContain("; ")

    const single = parseCurl(`curl -b 'a=1; b=2' https://api.example.com/a`)
    expect(single.headers[0].value).toBe("a=1; b=2")
  })

  // Behavior 19
  it("collapses repeated -A and -e to a single last-wins header", () => {
    const agents = parseCurl(`curl -A 'x' -A 'y' https://api.example.com/a`).headers.filter(
      (header) => header.key === "User-Agent"
    )
    expect(agents).toHaveLength(1)
    expect(agents[0].value).toBe("y")

    const referers = parseCurl(`curl -e 'r' -e 's' https://api.example.com/a`).headers.filter(
      (header) => header.key === "Referer"
    )
    expect(referers).toHaveLength(1)
    expect(referers[0].value).toBe("s")
  })

  // Behavior 20 — verified against curl 8.7.1: any Authorization header, of
  // any value, suppresses the Basic credentials -u would generate.
  it.each([
    "Authorization: Bearer t",
    "Authorization: Custom abc",
    "Authorization: basic dXNlcjpwYXNz",
  ])("suppresses -u whenever an Authorization header is present (%s)", (header) => {
    for (const command of [
      `curl -H '${header}' -u sneaky:pass https://api.example.com/a`,
      `curl -u sneaky:pass -H '${header}' https://api.example.com/a`,
    ]) {
      const result = parseCurl(command)
      expect(result.auth.basic?.username).not.toBe("sneaky")
    }
  })

  it("suppresses -u when two Authorization headers are present", () => {
    for (const command of [
      `curl -H 'Authorization: Bearer aaa' -H 'Authorization: Bearer bbb' -u sneaky:pass https://api.example.com/a`,
      `curl -u sneaky:pass -H 'Authorization: Bearer aaa' -H 'Authorization: Bearer bbb' https://api.example.com/a`,
    ]) {
      const result = parseCurl(command)
      expect(result.auth.type).toBe("none")
    }
  })

  // Behavior 21
  it("treats -H 'Name:' as curl's delete directive", () => {
    const custom = parseCurl(`curl -H 'X-Custom:' https://api.example.com/a`)
    expect(custom.headers.some((header) => header.key === "X-Custom")).toBe(false)

    const authorization = parseCurl(
      `curl -H 'Authorization:' -u a:b https://api.example.com/a`
    )
    expect(authorization.auth.type).toBe("none")
    expect(
      authorization.headers.some((header) => header.key.toLowerCase() === "authorization")
    ).toBe(false)

    const cookie = parseCurl(`curl -H 'Cookie:' -b 'a=1' https://api.example.com/a`)
    expect(cookie.headers.some((header) => header.key.toLowerCase() === "cookie")).toBe(
      false
    )
  })

  // Behavior 22
  it("treats -H 'Name;' as an empty-valued header", () => {
    const custom = parseCurl(`curl -H 'X-Custom;' https://api.example.com/a`)
    expect(custom.headers).toHaveLength(1)
    expect(custom.headers[0].key).toBe("X-Custom")
    expect(custom.headers[0].key).not.toContain(";")
    expect(custom.headers[0].value).toBe("")

    const cookie = parseCurl(`curl -H 'Cookie;' -b 'a=1' https://api.example.com/a`)
    const cookies = cookie.headers.filter((header) => header.key === "Cookie")
    expect(cookies).toHaveLength(1)
    expect(cookies[0].value).toBe("")
  })

  // Behavior 24
  it("treats a -b argument without = as an unreadable cookie file", () => {
    const result = parseCurl(`curl -b cookies.txt https://api.example.com/a`)

    expect(result.headers.some((header) => header.key.toLowerCase() === "cookie")).toBe(
      false
    )
    expect(result.warnings).toEqual([
      { code: "cookie-file-not-supported", detail: "cookies.txt" },
    ])
  })

  // Behavior 25
  it("keeps colons inside a -u password", () => {
    const withColons = parseCurl(`curl -u 用户:pa:ss:word https://api.example.com/a`)
    expect(withColons.auth.type).toBe("basic")
    expect(withColons.auth.basic?.username).toBe("用户")
    expect(withColons.auth.basic?.password).toBe("pa:ss:word")

    const lonely = parseCurl(`curl -u lonely https://api.example.com/a`)
    expect(lonely.auth.basic?.username).toBe("lonely")
    expect(lonely.auth.basic?.password).toBe("")
  })

  // Behavior 26 — curl 8.7.1 sends both lines; folding them loses one.
  it.each([
    ["Bearer aaa", "Bearer bbb"],
    ["Basic dXNlcjpwYXNz", "Bearer bbb"],
    ["Custom ccc", "Bearer bbb"],
  ])("never folds multiple explicit Authorization headers into one", (first, second) => {
    const result = parseCurl(
      `curl -H 'Authorization: ${first}' -H 'Authorization: ${second}' https://api.example.com/a`
    )
    const authorization = result.headers.filter(
      (header) => header.key.toLowerCase() === "authorization"
    )

    expect(authorization).toHaveLength(2)
    expect(authorization[0].value).toBe(first)
    expect(authorization[1].value).toBe(second)
    expect(result.auth.type).toBe("none")
  })

  // Behavior 27
  it("keeps colons inside a lifted Basic password", () => {
    const encoded = btoa("api-user:pa:ss")
    const result = parseCurl(
      `curl -H 'Authorization: Basic ${encoded}' https://api.example.com/a`
    )

    expect(result.auth.type).toBe("basic")
    expect(result.auth.basic?.username).toBe("api-user")
    expect(result.auth.basic?.password).toBe("pa:ss")
    expect(
      result.headers.some((header) => header.key.toLowerCase() === "authorization")
    ).toBe(false)
  })

  // Behavior 28
  it("decodes UTF-8 credentials in a lifted Basic header", () => {
    const result = parseCurl(
      `curl -H 'Authorization: Basic 55So5oi3OuWvhueggQ==' https://api.example.com/a`
    )

    expect(result.auth.type).toBe("basic")
    expect(result.auth.basic?.username).toBe("用户")
    expect(result.auth.basic?.password).toBe("密码")
  })

  // Behavior 29 — the value must survive byte-for-byte. The trailing-space
  // cases use ${" "} so no formatter can silently trim the fixture (P6).
  it.each([
    ["invalid utf-8", "Basic /zph"],
    ["no colon", "Basic bG9uZWx5"],
    ["custom scheme", "Custom abc"],
    ["lowercase scheme", "basic dXNlcjpwYXNz"],
    ["padded scheme", "Basic   dXNlcjpwYXNz"],
    ["non-canonical base64", "Basic dXNlcjpwYXNz="],
    ["trailing space on bearer", `Bearer good${" "}`],
    ["trailing space on basic", `Basic dXNlcjpwYXNz${" "}`],
    ["double space before token", "Bearer  good"],
  ])(
    "leaves an Authorization header byte-identical when it cannot be lifted (%s)",
    (label, value) => {
      // Fixture self-check (PROCESS P6): the whole point of the two
      // trailing-space rows is the trailing space.
      if (label.startsWith("trailing space")) {
        expect(value.endsWith(" ")).toBe(true)
      }

      const result = parseCurl(
        `curl -H 'Authorization: ${value}' https://api.example.com/a`
      )
      const authorization = result.headers.filter(
        (header) => header.key.toLowerCase() === "authorization"
      )

      expect(authorization).toHaveLength(1)
      expect(authorization[0].value).toBe(value)
      expect(result.auth.type).toBe("none")

      const withUser = parseCurl(
        `curl -H 'Authorization: ${value}' -u sneaky:pass https://api.example.com/a`
      )
      expect(withUser.auth.type).toBe("none")
    }
  )

  it("does not warn about fidelity for a reproducible but unliftable Authorization", () => {
    const result = parseCurl(
      `curl -H 'Authorization: Bearer  good' https://api.example.com/a`
    )
    expect(
      result.warnings.filter(
        (warning) => warning.code === "authorization-not-byte-preserved"
      )
    ).toEqual([])
  })

  // Behavior 30 — the guard behind "fidelity damaged => never lift". Case 3
  // folds to exactly `Bearer eyJhb`, which the lift predicate accepts, so the
  // guard is the only thing stopping it.
  it.each([
    [`curl -H 'Authorization:Bearer good' https://api.example.com/a`, "separator whitespace"],
    [
      `curl -H $'Authorization:${BACKSLASH}tBearer good' https://api.example.com/a`,
      "separator whitespace",
    ],
    [
      `curl -H $'Authorization: Bearer${BACKSLASH}r${BACKSLASH}n  eyJhb' https://api.example.com/a`,
      "line breaks",
    ],
  ])(
    "warns instead of silently normalizing an Authorization layout it cannot reproduce",
    (command, detail) => {
      const result = parseCurl(command)

      expect(
        result.warnings.filter(
          (warning) => warning.code === "authorization-not-byte-preserved"
        )
      ).toEqual([{ code: "authorization-not-byte-preserved", detail }])
      expect(result.auth.type).toBe("none")
      expect(
        result.headers.filter((header) => header.key.toLowerCase() === "authorization")
      ).toHaveLength(1)
    }
  )

  it("does not warn about Authorization layouts it can reproduce", () => {
    const canonical = parseCurl(
      `curl -H 'Authorization: Bearer good' https://api.example.com/a`
    )
    expect(canonical.warnings).toEqual([])
    expect(canonical.auth.type).toBe("bearer")

    const twoSpaces = parseCurl(
      `curl -H 'Authorization:  Bearer good' https://api.example.com/a`
    )
    expect(twoSpaces.warnings).toEqual([])
    expect(twoSpaces.auth.type).toBe("none")
    expect(twoSpaces.headers[0].value).toBe(" Bearer good")
  })

  // Behavior 31
  it("reports no warnings for a fully representable command", () => {
    const result = parseCurl(
      `curl 'https://api.example.com/a' -H 'Accept: application/json' -b 'sid=1' -d 'k=v'`
    )
    expect(result.warnings).toEqual([])
  })
})
