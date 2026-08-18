import type { AuthConfig, FormDataItem, HttpMethod, KeyValuePair, RequestBody } from "../types"

export type CurlImportWarningCode =
  | "file-reference-not-inlined"
  | "data-segments-discarded"
  | "cookie-file-not-supported"
  | "authorization-not-byte-preserved"

export interface CurlImportWarning {
  code: CurlImportWarningCode
  /**
   * For i18n interpolation: a file name, the number of discarded data
   * segments, a cookie file name, or "line breaks" / "separator whitespace".
   */
  detail: string
}

export interface ParsedCurlRequest {
  method: HttpMethod
  url: string
  headers: KeyValuePair[]
  body: RequestBody
  auth: AuthConfig
  warnings: CurlImportWarning[]
}

const HTTP_METHODS = new Set<HttpMethod>([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
])

const DATA_FLAGS = new Set([
  "-d",
  "--data",
  "--data-raw",
  "--data-ascii",
  "--data-binary",
  "--data-urlencode",
])

export function parseCurl(curlString: string): ParsedCurlRequest {
  const tokens = tokenizeCurlCommand(curlString)
  if (tokens.length === 0 || tokens[0] !== "curl") {
    throw new Error("Invalid cURL command.")
  }

  let method: HttpMethod = "GET"
  let methodExplicit = false
  let url = ""
  const bodySegments: string[] = []
  const formData: FormDataItem[] = []
  let binaryPath = ""
  let auth: AuthConfig = { type: "none" }
  let bodyType: RequestBody["type"] = "none"

  // Headers the user wrote with -H: ordered, duplicates allowed.
  const explicitHeaders: KeyValuePair[] = []
  // Every header name seen on a -H, including delete/empty directives. curl
  // suppresses its own generated header whenever the user named it.
  const explicitNames = new Set<string>()
  const authSetIndices: number[] = []
  // Headers curl would generate itself. Map preserves insertion order and
  // set() on an existing key overwrites in place.
  const generatedHeaders = new Map<string, KeyValuePair>()
  const cookieSegments: string[] = []
  const warnings: CurlImportWarning[] = []
  let pendingBasicAuth: { username: string; password: string } | null = null
  let fileRefSeen = false
  // Set when this Authorization value cannot be reproduced byte-for-byte.
  // Sole guard behind "fidelity damaged => never lift".
  let authNotPreserved = false

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]

    if (token === "-X" || token === "--request") {
      const rawMethod = tokens[index + 1]
      index += 1
      if (rawMethod === undefined) {
        continue
      }

      const candidate = rawMethod.toUpperCase()
      if (!isHttpMethod(candidate)) {
        throw new Error(`Unsupported request method: ${rawMethod}`)
      }

      method = candidate
      methodExplicit = true
      continue
    }

    if (token === "-H" || token === "--header") {
      const headerValue = tokens[index + 1]
      if (headerValue) {
        const directive = parseHeaderDirective(headerValue)
        if (directive) {
          const name = directive.kind === "delete" ? directive.name : directive.pair.key
          explicitNames.add(name.toLowerCase())

          if (directive.kind === "set" && name.toLowerCase() === "authorization") {
            const stored = storeAuthorizationValue(directive.rawValue, warnings)
            authNotPreserved = authNotPreserved || stored.notPreserved
            authSetIndices.push(explicitHeaders.length)
            explicitHeaders.push({ ...directive.pair, value: stored.value })
          } else if (directive.kind !== "delete") {
            explicitHeaders.push(directive.pair)
          }
        }
        index += 1
      }
      continue
    }

    if (DATA_FLAGS.has(token)) {
      const nextValue = tokens[index + 1]
      if (typeof nextValue === "string") {
        if (token === "--data-urlencode") {
          const parsed = parseDataUrlEncode(nextValue)
          if (parsed.kind === "file") {
            bodyType = "binary"
            binaryPath = parsed.fileName
            fileRefSeen = true
            warnings.push({
              code: "file-reference-not-inlined",
              detail: basename(parsed.fileName),
            })
          } else {
            bodySegments.push(parsed.value)
            if (bodyType === "none") {
              bodyType = "raw"
            }
          }
        } else if (nextValue.startsWith("@") && token !== "--data-raw") {
          // curl reads the file for -d/--data/--data-ascii/--data-binary.
          // ApiSolo never reads a local path, so this degrades to the same
          // visible placeholder --data-binary already produced.
          bodyType = "binary"
          binaryPath = nextValue.slice(1)
          fileRefSeen = true
          warnings.push({
            code: "file-reference-not-inlined",
            detail: basename(nextValue.slice(1)),
          })
        } else {
          bodySegments.push(nextValue)
          if (bodyType === "none") {
            bodyType = "raw"
          }
        }

        if (!methodExplicit && method === "GET") {
          method = "POST"
        }
        index += 1
      }
      continue
    }

    if (token === "-F" || token === "--form") {
      const formValue = tokens[index + 1]
      if (formValue) {
        const item = parseFormFlag(formValue)
        formData.push(item)
        if (item.valueType === "file") {
          warnings.push({
            code: "file-reference-not-inlined",
            detail: item.fileName ?? "",
          })
        }
        bodyType = "form-data"
        if (!methodExplicit && method === "GET") {
          method = "POST"
        }
        index += 1
      }
      continue
    }

    if (token === "-T" || token === "--upload-file") {
      const uploadValue = tokens[index + 1]
      if (uploadValue) {
        bodyType = "binary"
        binaryPath = normalizeUploadFileValue(uploadValue)
        warnings.push({
          code: "file-reference-not-inlined",
          detail: basename(binaryPath),
        })
        if (!methodExplicit && method === "GET") {
          method = "PUT"
        }
        index += 1
      }
      continue
    }

    if (token === "-b" || token === "--cookie") {
      const cookieValue = tokens[index + 1]
      if (cookieValue) {
        if (cookieValue.includes("=")) {
          cookieSegments.push(normalizeCookieValue(cookieValue))
        } else {
          // No `=` means curl would read a cookie jar file. We do not read
          // local files, and inventing `Cookie: cookies.txt` would be a lie.
          warnings.push({ code: "cookie-file-not-supported", detail: cookieValue })
        }
        index += 1
      }
      continue
    }

    if (token === "-A" || token === "--user-agent") {
      const uaValue = tokens[index + 1]
      if (uaValue) {
        generatedHeaders.set("user-agent", createHeaderPair(`User-Agent: ${uaValue}`))
        index += 1
      }
      continue
    }

    if (token === "-e" || token === "--referer") {
      const refValue = tokens[index + 1]
      if (refValue) {
        generatedHeaders.set("referer", createHeaderPair(`Referer: ${refValue}`))
        index += 1
      }
      continue
    }

    if (token === "-u" || token === "--user") {
      const credentials = tokens[index + 1]
      if (credentials) {
        const separatorIndex = credentials.indexOf(":")
        pendingBasicAuth = {
          username:
            separatorIndex === -1 ? credentials : credentials.slice(0, separatorIndex),
          password: separatorIndex === -1 ? "" : credentials.slice(separatorIndex + 1),
        }
        index += 1
      }
      continue
    }

    if (token === "-I" || token === "--head") {
      method = "HEAD"
      continue
    }

    if (
      token === "-s" ||
      token === "--silent" ||
      token === "-S" ||
      token === "--show-error" ||
      token === "-L" ||
      token === "--location" ||
      token === "-k" ||
      token === "--insecure" ||
      token === "-v" ||
      token === "--verbose" ||
      token === "-i" ||
      token === "--include" ||
      token === "-N" ||
      token === "--no-buffer" ||
      token === "--compressed" ||
      token === "--http1.1" ||
      token === "--http2"
    ) {
      continue
    }

    if (
      token === "-o" ||
      token === "--output" ||
      token === "-w" ||
      token === "--write-out" ||
      token === "--connect-timeout" ||
      token === "--max-time" ||
      token === "-m" ||
      token === "--retry" ||
      token === "--cacert" ||
      token === "--cert" ||
      token === "--key"
    ) {
      index += 1
      continue
    }

    if (!token.startsWith("-") && !url && token.trim()) {
      url = token
    }
  }

  if (!url) {
    throw new Error("Unable to find a request URL in the cURL command.")
  }

  // Lift before the header list is built: a lifted Authorization is removed
  // from explicitHeaders. Exactly one, and only when nothing already damaged
  // the bytes -- real curl sends every -H the user wrote.
  if (authSetIndices.length === 1 && !authNotPreserved) {
    const lifted = liftAuthorizationHeader(explicitHeaders[authSetIndices[0]].value)
    if (lifted) {
      auth = lifted
      explicitHeaders.splice(authSetIndices[0], 1)
    }
  }

  // -u only applies when the user never named Authorization, whatever the
  // value was and whichever order the flags came in.
  if (!explicitNames.has("authorization") && pendingBasicAuth) {
    auth = { type: "basic", basic: pendingBasicAuth }
  }

  if (cookieSegments.length) {
    generatedHeaders.set("cookie", createHeaderPair(`Cookie: ${cookieSegments.join(";")}`))
  }

  const headers = [
    ...explicitHeaders,
    ...[...generatedHeaders.values()].filter(
      (header) => !explicitNames.has(header.key.toLowerCase()),
    ),
  ]

  if (fileRefSeen && bodySegments.length) {
    warnings.push({ code: "data-segments-discarded", detail: String(bodySegments.length) })
    bodySegments.length = 0
  }

  return {
    method,
    url,
    headers,
    body: buildRequestBody(bodyType, bodySegments, formData, binaryPath, headers),
    auth,
    warnings,
  }
}

function buildRequestBody(
  bodyType: RequestBody["type"],
  bodySegments: string[],
  formData: FormDataItem[],
  binaryPath: string,
  headers: KeyValuePair[],
): RequestBody {
  const content = bodySegments.join("&")

  if (bodyType === "form-data") {
    return {
      type: "form-data",
      content: "",
      formData,
      binaryPath: "",
    }
  }

  if (bodyType === "binary") {
    return {
      type: "binary",
      content: "",
      formData: [],
      binaryPath: basename(binaryPath),
    }
  }

  const inferredType = inferTextBodyType(content, headers)
  return {
    type: inferredType,
    content: inferredType === "none" ? "" : content,
    formData: [],
    binaryPath: "",
  }
}

function inferTextBodyType(content: string, headers: KeyValuePair[]): RequestBody["type"] {
  const contentType =
    headers.find((item) => item.key.toLowerCase() === "content-type")?.value.toLowerCase() ?? ""

  if (!content.trim()) {
    return "none"
  }

  if (contentType.includes("application/json") || isLikelyJson(content)) {
    return "json"
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return "form-urlencoded"
  }

  return "raw"
}

function parseFormFlag(value: string): FormDataItem {
  const separatorIndex = value.indexOf("=")
  const key = (separatorIndex === -1 ? value : value.slice(0, separatorIndex)).trim()
  const rawRest = separatorIndex === -1 ? "" : value.slice(separatorIndex + 1)

  if (rawRest.startsWith("@")) {
    const [fileToken, ...options] = rawRest.slice(1).split(";")
    const contentTypeOption = options.find((item) => item.startsWith("type="))

    return {
      id: crypto.randomUUID(),
      enabled: true,
      key,
      value: "",
      description: "",
      valueType: "file",
      fileName: basename(fileToken.trim()),
      filePath: "",
      fileContent: undefined,
      contentType: contentTypeOption?.slice("type=".length) ?? "",
    }
  }

  return {
    id: crypto.randomUUID(),
    enabled: true,
    key,
    value: rawRest,
    description: "",
    valueType: "text",
    fileName: "",
    filePath: "",
    fileContent: undefined,
    contentType: "",
  }
}

function tokenizeCurlCommand(command: string) {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  let escapeNext = false
  // `$` immediately before an opening quote turns it into an ANSI-C quoted word.
  // Only an unquoted, unescaped `$` counts, so `\$'x'` stays the literal `$x`.
  let pendingDollar = false
  let ansiC = false
  let ansiBuffer = ""
  const normalized = command.replace(/\\\r?\n/g, " ").trim()

  for (const char of normalized) {
    if (ansiC) {
      // Escapes are not evaluated here — the raw two-character sequence is kept
      // so decodeAnsiCEscapes sees it. We only need `\'` to not close the quote.
      if (escapeNext) {
        ansiBuffer += char
        escapeNext = false
        continue
      }

      if (char === "\\") {
        ansiBuffer += char
        escapeNext = true
        continue
      }

      if (char === "'") {
        current += decodeAnsiCEscapes(ansiBuffer)
        ansiBuffer = ""
        ansiC = false
        quote = null
        continue
      }

      ansiBuffer += char
      continue
    }

    if (escapeNext) {
      current += char
      escapeNext = false
      pendingDollar = false
      continue
    }

    if (char === "\\" && quote !== "'") {
      escapeNext = true
      pendingDollar = false
      continue
    }

    if (char === "'" && !quote && pendingDollar) {
      current = current.slice(0, -1)
      quote = "'"
      ansiC = true
      ansiBuffer = ""
      pendingDollar = false
      continue
    }

    if ((char === "'" || char === '"') && !quote) {
      quote = char
      pendingDollar = false
      continue
    }

    if (char === quote) {
      quote = null
      pendingDollar = false
      continue
    }

    if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      pendingDollar = false
      continue
    }

    current += char
    pendingDollar = !quote && char === "$"
  }

  if (ansiC) {
    // Unterminated $'… — keep what we decoded rather than dropping the word.
    current += decodeAnsiCEscapes(ansiBuffer)
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}

const ANSI_C_SIMPLE_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
}

const MAX_CODE_POINT = 0x10ffff

function decodeAnsiCEscapes(raw: string) {
  let result = ""
  let index = 0

  while (index < raw.length) {
    const char = raw[index]

    if (char !== "\\") {
      result += char
      index += 1
      continue
    }

    const next = raw[index + 1]
    if (next === undefined) {
      result += "\\"
      index += 1
      continue
    }

    const simple = ANSI_C_SIMPLE_ESCAPES[next]
    if (simple !== undefined) {
      result += simple
      index += 2
      continue
    }

    if (next === "x" || next === "u" || next === "U") {
      const maxDigits = next === "x" ? 2 : next === "u" ? 4 : 8
      const digits = readDigits(raw, index + 2, maxDigits, isHexDigit)
      const codePoint = digits ? Number.parseInt(digits, 16) : -1
      if (codePoint >= 0 && codePoint <= MAX_CODE_POINT) {
        result += String.fromCodePoint(codePoint)
        index += 2 + digits.length
        continue
      }

      // Unusable escape (no digits, or out of range): keep it literal.
      result += `\\${next}`
      index += 2
      continue
    }

    if (isOctalDigit(next)) {
      const digits = readDigits(raw, index + 1, 3, isOctalDigit)
      result += String.fromCharCode(Number.parseInt(digits, 8))
      index += 1 + digits.length
      continue
    }

    result += `\\${next}`
    index += 2
  }

  return result
}

function readDigits(
  raw: string,
  start: number,
  maxDigits: number,
  accept: (char: string) => boolean,
) {
  let digits = ""
  while (digits.length < maxDigits) {
    const char = raw[start + digits.length]
    if (char === undefined || !accept(char)) {
      break
    }
    digits += char
  }

  return digits
}

function isHexDigit(char: string) {
  return /[0-9a-fA-F]/.test(char)
}

function isOctalDigit(char: string) {
  return char >= "0" && char <= "7"
}

function createHeaderPair(rawHeader: string): KeyValuePair {
  const separatorIndex = rawHeader.indexOf(":")
  const key = separatorIndex === -1 ? rawHeader.trim() : rawHeader.slice(0, separatorIndex).trim()
  const value =
    separatorIndex === -1
      ? ""
      : normalizeHeaderValueByKey(key, rawHeader.slice(separatorIndex + 1))

  return makeHeaderPair(key, value)
}

function makeHeaderPair(key: string, value: string): KeyValuePair {
  return {
    id: crypto.randomUUID(),
    enabled: true,
    key,
    value,
    description: "",
  }
}

function normalizeHeaderValueByKey(key: string, value: string) {
  if (key.toLowerCase() === "cookie") {
    return normalizeCookieValue(value)
  }

  return normalizeHeaderValue(value)
}

/**
 * Fold the line breaks a browser-copied curl leaves inside a header value.
 * reqwest's HeaderValue::from_str rejects CR and LF, so this is the one
 * transformation an imported header value is forced to undergo. The regex is
 * built per call — no shared lastIndex state.
 */
function foldHeaderLineBreaks(value: string, replacement: string) {
  return value.replace(/(?:\r\n|\r|\n)[ \t]*/g, replacement)
}

function normalizeHeaderValue(value: string) {
  return foldHeaderLineBreaks(value, " ").trim()
}

function normalizeCookieValue(value: string) {
  return foldHeaderLineBreaks(value, "").trim()
}

type ExplicitHeaderDirective =
  | { kind: "set"; pair: KeyValuePair; rawValue: string }
  | { kind: "empty"; pair: KeyValuePair }
  | { kind: "delete"; name: string }

/**
 * curl's three -H forms, verified against curl 8.7.1:
 *   `Name: value` sends the header, `Name:` deletes it (and suppresses the
 *   one curl would generate), `Name;` sends it with an empty value.
 *
 * `rawValue` is everything after the first colon with no folding and no
 * trimming. Only Authorization consumes it; every other header keeps using
 * the normalized `pair.value`, because RFC 9110 5.5 puts surrounding
 * whitespace outside the field value.
 */
function parseHeaderDirective(rawHeader: string): ExplicitHeaderDirective | null {
  const separatorIndex = rawHeader.indexOf(":")

  if (separatorIndex !== -1) {
    const name = rawHeader.slice(0, separatorIndex).trim()
    const rawValue = rawHeader.slice(separatorIndex + 1)
    const value = normalizeHeaderValueByKey(name, rawValue)

    if (!value) {
      return { kind: "delete", name }
    }

    return { kind: "set", pair: makeHeaderPair(name, value), rawValue }
  }

  const trimmed = rawHeader.trim()
  if (trimmed.endsWith(";")) {
    const name = trimmed.slice(0, -1).trim()
    if (!name) {
      return null
    }

    return { kind: "empty", pair: makeHeaderPair(name, "") }
  }

  return null
}

/**
 * Authorization is the one header whose bytes we refuse to rewrite, so it is
 * stored from the raw field-value. The single space after the colon is the
 * name/value separator ApiSolo re-adds on output; everything else is kept.
 *
 * Sets `notPreserved` when the value cannot survive the round trip:
 *   1. line folding changed it (reqwest rejects CR/LF, so we have no choice);
 *   2. the folded value does not start with exactly one separator space, so
 *      `name + ": " + value` cannot reproduce the original line.
 */
function storeAuthorizationValue(rawValue: string, warnings: CurlImportWarning[]) {
  const folded = foldHeaderLineBreaks(rawValue, " ")
  let notPreserved = false

  if (folded !== rawValue) {
    warnings.push({ code: "authorization-not-byte-preserved", detail: "line breaks" })
    notPreserved = true
  }

  const reproducible = folded.startsWith(" ")
  if (!reproducible) {
    warnings.push({
      code: "authorization-not-byte-preserved",
      detail: "separator whitespace",
    })
    notPreserved = true
  }

  return {
    value: reproducible ? folded.slice(1) : folded.replace(/^[ \t]+/, ""),
    notPreserved,
  }
}

/**
 * Returns an AuthConfig only when the auth tab can rebuild this exact string,
 * otherwise null so the caller leaves the header alone. Anything else would
 * change credential bytes: `Basic /zph` would go out as `Basic w786YQ==` and
 * `Basic bG9uZWx5` would gain a colon it never had.
 */
function liftAuthorizationHeader(value: string): AuthConfig | null {
  const bearerMatch = value.match(/^Bearer (\S+)$/)
  if (bearerMatch) {
    return { type: "bearer", bearer: { token: bearerMatch[1] } }
  }

  const basicMatch = value.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/)
  if (!basicMatch) {
    return null
  }

  const token = basicMatch[1]
  let decoded: string
  try {
    const binary = atob(token)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }

  const separatorIndex = decoded.indexOf(":")
  if (separatorIndex === -1) {
    return null
  }

  if (encodeBase64Utf8(decoded) !== token) {
    return null
  }

  return {
    type: "basic",
    basic: {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    },
  }
}

function encodeBase64Utf8(value: string) {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

/**
 * curl's --data-urlencode dispatch (tool_getparam.c): the first `=` wins, and
 * only when there is none does the first `@` mark a file. The name part is
 * passed through unencoded.
 */
function parseDataUrlEncode(
  arg: string,
): { kind: "value"; value: string } | { kind: "file"; fileName: string } {
  const equalsIndex = arg.indexOf("=")
  const separatorIndex = equalsIndex === -1 ? arg.indexOf("@") : equalsIndex

  if (separatorIndex === -1) {
    return { kind: "value", value: urlEncodeCurlStyle(arg) }
  }

  const name = arg.slice(0, separatorIndex)
  const rest = arg.slice(separatorIndex + 1)

  if (arg[separatorIndex] === "@") {
    return { kind: "file", fileName: rest }
  }

  const encoded = urlEncodeCurlStyle(rest)
  return { kind: "value", value: name ? `${name}=${encoded}` : encoded }
}

/**
 * curl escapes everything outside its unreserved set (A-Za-z0-9-._~) and then
 * turns %20 into `+`. Verified against curl 8.7.1: `q=a b&c` goes out as
 * `q=a+b%26c`, and a literal `+` in the content becomes %2B.
 *
 * The three steps do not commute: encodeURIComponent has already turned `+`
 * into %2B, so the final substitution cannot collide with it.
 */
function urlEncodeCurlStyle(value: string) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+")
}

function isHttpMethod(value: string): value is HttpMethod {
  return HTTP_METHODS.has(value as HttpMethod)
}

function isLikelyJson(value: string) {
  const trimmed = value.trim()
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  )
}

function basename(path: string) {
  return path.split(/[\\/]/).pop() ?? path
}

function normalizeUploadFileValue(value: string) {
  return value.startsWith("@") ? value.slice(1) : value
}
