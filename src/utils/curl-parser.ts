import type { AuthConfig, FormDataItem, HttpMethod, KeyValuePair, RequestBody } from "../types"

interface ParsedCurlRequest {
  method: HttpMethod
  url: string
  headers: KeyValuePair[]
  body: RequestBody
  auth: AuthConfig
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

export function parseCurl(curlString: string): ParsedCurlRequest {
  const tokens = tokenizeCurlCommand(curlString)
  if (tokens.length === 0 || tokens[0] !== "curl") {
    throw new Error("Invalid cURL command.")
  }

  let method: HttpMethod = "GET"
  let url = ""
  const headers: KeyValuePair[] = []
  const bodySegments: string[] = []
  const formData: FormDataItem[] = []
  let binaryPath = ""
  let auth: AuthConfig = { type: "none" }
  let bodyType: RequestBody["type"] = "none"

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]

    if (token === "-X" || token === "--request") {
      const nextValue = tokens[index + 1]?.toUpperCase()
      if (nextValue && isHttpMethod(nextValue)) {
        method = nextValue
        index += 1
      }
      continue
    }

    if (token === "-H" || token === "--header") {
      const headerValue = tokens[index + 1]
      if (headerValue) {
        const header = createHeaderPair(headerValue)
        const authHeader = parseAuthorizationHeader(header.key, header.value)
        if (authHeader) {
          auth = authHeader
        } else {
          headers.push(header)
        }
        index += 1
      }
      continue
    }

    if (
      token === "-d" ||
      token === "--data" ||
      token === "--data-raw" ||
      token === "--data-binary" ||
      token === "--data-urlencode"
    ) {
      const nextValue = tokens[index + 1]
      if (typeof nextValue === "string") {
        if (token === "--data-binary" && nextValue.startsWith("@")) {
          bodyType = "binary"
          binaryPath = nextValue.slice(1)
        } else {
          bodySegments.push(nextValue)
          if (bodyType === "none") {
            bodyType = "raw"
          }
        }

        if (method === "GET") {
          method = "POST"
        }
        index += 1
      }
      continue
    }

    if (token === "-F" || token === "--form") {
      const formValue = tokens[index + 1]
      if (formValue) {
        formData.push(parseFormFlag(formValue))
        bodyType = "form-data"
        if (method === "GET") {
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
        if (method === "GET") {
          method = "PUT"
        }
        index += 1
      }
      continue
    }

    if (token === "-b" || token === "--cookie") {
      const cookieValue = tokens[index + 1]
      if (cookieValue) {
        headers.push(createHeaderPair(`Cookie: ${normalizeCookieValue(cookieValue)}`))
        index += 1
      }
      continue
    }

    if (token === "-A" || token === "--user-agent") {
      const uaValue = tokens[index + 1]
      if (uaValue) {
        headers.push(createHeaderPair(`User-Agent: ${uaValue}`))
        index += 1
      }
      continue
    }

    if (token === "-e" || token === "--referer") {
      const refValue = tokens[index + 1]
      if (refValue) {
        headers.push(createHeaderPair(`Referer: ${refValue}`))
        index += 1
      }
      continue
    }

    if (token === "-u" || token === "--user") {
      const credentials = tokens[index + 1]
      if (credentials) {
        const [username = "", password = ""] = credentials.split(":")
        auth = {
          type: "basic",
          basic: { username, password },
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

    if (!token.startsWith("-") && !url) {
      url = token
    }
  }

  if (!url) {
    throw new Error("Unable to find a request URL in the cURL command.")
  }

  return {
    method,
    url,
    headers,
    body: buildRequestBody(bodyType, bodySegments, formData, binaryPath, headers),
    auth,
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

function parseAuthorizationHeader(key: string, value: string): AuthConfig | null {
  if (key.toLowerCase() !== "authorization") {
    return null
  }

  if (value.startsWith("Bearer ")) {
    return {
      type: "bearer",
      bearer: {
        token: value.slice("Bearer ".length),
      },
    }
  }

  const match = value.match(/^Basic\s+(.+)$/i)
  if (!match) {
    return null
  }

  try {
    const decoded = atob(match[1])
    const [username = "", password = ""] = decoded.split(":")
    return {
      type: "basic",
      basic: { username, password },
    }
  } catch {
    return null
  }
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
